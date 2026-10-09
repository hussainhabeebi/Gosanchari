// Admin → Add Property: a 7-step wizard for the data-entry team, kept to exactly what the team fills in:
//  1 Property Details · 2 Room Categories · 3 Room Rates · 4 Additional Charges & Kids Policies ·
//  5 Cancellation Policy & Contact Details · 6 Images & Media · 7 Review & Save.
// Each step saves on "Save & Continue". After step 1, AI fills in how to reach and nearby attractions
// in the background (only where empty) for staff to check.

import { Hono, type Context } from 'hono'
import type { Child, FC } from 'hono/jsx'
import { raw } from 'hono/html'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { iconFor } from '../views/components'
import { permissionsFor, requirePerm } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, placeholders, run } from '../lib/db'
import { addons as readAddons, contact as readContact, legacyType, STAY_TYPES, THEMES, videoEmbedUrl, type ActivityItem, type Addon, type Contact } from '../lib/catalog'
import { addItem, allRows, KINDS, listFor, removeItem, restoreItem, type Kind } from '../lib/taxonomy'
import { mediaUrl } from '../lib/integrations'
import type { PhotoRow, PropertyRow, RoomRow } from '../lib/types'
import { int, isDate, parseJson, slugify, str } from '../lib/util'
import { form, redirectMsg } from './helpers'
import { afterPropertySave } from './admin-properties'
import { commonPeakKey, parseWeekdays, type SeasonRate } from '../lib/pricing'
import { peakStatements } from '../lib/wizard-peaks'

export const wizardRoutes = new Hono<AppEnv>()

const STEPS: [string, string][] = [
  ['Property Details', 'Basic information'],
  ['Room Categories', 'Add rooms & details'],
  ['Room Rates', 'Set pricing for seasons'],
  ['Additional Charges & Kids Policies', 'Extra person, kids, activities'],
  ['Cancellation Policy & Contact Details', 'Policy and contact info'],
  ['Images & Media', 'Upload photos & videos'],
  ['Review & Save', 'Confirm and publish'],
]
const PLANS: [string, string][] = [['CP', '(Room + Breakfast)'], ['MAP', '(Room + Breakfast + Lunch / Dinner)'], ['AP', '(Room + Breakfast + Lunch + Dinner)'], ['EP', '(Room Only)']]
const TIERS: [string, string][] = [['b2b', 'B2B Rate (₹)'], ['staff', 'Staff Rate (₹)'], ['direct', 'Direct Rate (₹)']]
const PERIODS: [string, string, string, string][] = [
  // key, title, subtitle, season kind
  ['off', 'Off Season Rates', 'Set your off season date range and rates', 'off_season'],
  ['sea', 'Season Rates', 'Set your season date range and rates', 'season'],
]
const PERIOD_NAME: Record<string, string> = { off: 'Off season', sea: 'Season' }
// Recurring nights a date range can be limited to (JS weekday numbers of the night); '' = every night.
const RANGE_DAYS: [string, string][] = [
  ['', 'Every day'], ['6', 'Every Saturday'], ['0', 'Every Sunday'], ['5', 'Every Friday'], ['1', 'Every Monday'], ['2', 'Every Tuesday'],
  ['3', 'Every Wednesday'], ['4', 'Every Thursday'], ['5,6', 'Fri & Sat'], ['0,6', 'Sat & Sun'], ['0,5,6', 'Fri, Sat & Sun'], ['1,2,3,4', 'Mon – Thu'],
]
const daysValue = (v: string | null | undefined) => parseWeekdays(v).join(',')
const daysLabel = (v: string) => RANGE_DAYS.find(([k]) => k === v)?.[1] ?? `Days ${v}`
export interface DateRange { from: string; to: string; days: string }

/** The date ranges of one room's period, in order; duplicates (one row per meal plan) collapse to one range. */
export function periodRanges(rows: SeasonRate[]): DateRange[] {
  const seen = new Map<string, DateRange>()
  for (const x of [...rows].sort((a, b) => a.start_date.localeCompare(b.start_date) || daysValue(a.applicable_weekdays).localeCompare(daysValue(b.applicable_weekdays)))) {
    const r = { from: x.start_date, to: x.end_date, days: daysValue(x.applicable_weekdays) }
    seen.set(`${r.from}|${r.to}|${r.days}`, r)
  }
  return [...seen.values()]
}

/** Valid date ranges submitted for one room's period (blank and reversed rows are skipped, duplicates removed). */
export function submittedRanges(f: { __all: Record<string, string[]> }, key: string): DateRange[] {
  const froms = f.__all[`${key}_from`] ?? [], tos = f.__all[`${key}_to`] ?? [], days = f.__all[`${key}_days`] ?? []
  const out = new Map<string, DateRange>()
  froms.forEach((from, i) => {
    const to = tos[i]
    if (!isDate(from) || !isDate(to) || to < from) return
    const r = { from, to, days: daysValue(days[i]) }
    out.set(`${r.from}|${r.to}|${r.days}`, r)
  })
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from) || a.days.localeCompare(b.days))
}

const RangeRow: FC<{ name: string; range?: DateRange }> = ({ name, range }) => {
  const days = range?.days ?? ''
  const opts = RANGE_DAYS.some(([k]) => k === days) ? RANGE_DAYS : [...RANGE_DAYS, [days, daysLabel(days)] as [string, string]]
  return (
    <div class="date-range" data-date-range>
      <label class="wf"><span class="wl">Choose Date From <b>*</b></span><input type="date" name={`${name}_from`} value={range?.from ?? ''} /></label>
      <label class="wf"><span class="wl">Choose Date To <b>*</b></span><input type="date" name={`${name}_to`} value={range?.to ?? ''} /></label>
      <label class="wf"><span class="wl">Applies on</span><select name={`${name}_days`}>{opts.map(([k, l]) => <option value={k} selected={k === days}>{l}</option>)}</select></label>
      <button type="button" class="linklike range-del" data-del-range aria-label="Remove this date range">×</button>
    </div>
  )
}

const svg = (d: string, size = 22) => raw(`<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`)
const I = {
  home: svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>', 30),
  bed: svg('<path d="M3 18V8"/><path d="M21 18v-5a3 3 0 0 0-3-3H10v8"/><path d="M3 14h18"/><circle cx="6.5" cy="11" r="1.6"/>', 30),
  coins: svg('<ellipse cx="9" cy="6" rx="6" ry="2.5"/><path d="M3 6v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6"/><path d="M3 10v4c0 1.4 2.7 2.5 6 2.5"/><path d="M15 12.5c3.3 0 6 1.1 6 2.5s-2.7 2.5-6 2.5-6-1.1-6-2.5"/><path d="M9 15v3c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-3"/>', 30),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>', 30),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>', 30),
  check: svg('<path d="m5 12 5 5 9-10"/>', 30),
  kids: svg('<circle cx="8" cy="7" r="3"/><circle cx="16" cy="7" r="3"/><path d="M3 20c0-3 2.2-5 5-5s5 2 5 5"/><path d="M11 20c0-3 2.2-5 5-5s5 2 5 5"/>', 26),
  person: svg('<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>', 26),
  hike: svg('<circle cx="13" cy="4" r="2"/><path d="m9 21 3-7 3 3v4"/><path d="m8 12 3-4 4 2 3 3"/><path d="M6 21l2-6"/>', 26),
  leaf: svg('<path d="M5 19C5 9 11 4 20 4c0 9-5 15-15 15z"/><path d="M5 19 13 11"/>', 26),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 26),
  crown: svg('<path d="m3 8 4 4 5-7 5 7 4-4-2 11H5z"/>', 26),
  pin: svg('<path d="M12 21s7-7.8 7-12a7 7 0 0 0-14 0c0 4.2 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>', 18),
  upload: svg('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v4h16v-4"/>', 20),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 18),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>', 16),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 18),
  docRed: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>', 26),
}

async function canSeeContacts(c: Context<AppEnv>) {
  return (await permissionsFor(c.env, c.get('user')!.role)).view_property_contacts
}

/** Which steps already have data (for the ticks in the step list). */
async function progress(c: Context<AppEnv>, p: PropertyRow | null): Promise<boolean[]> {
  if (!p) return STEPS.map(() => false)
  const [rooms, rates, photos] = await Promise.all([
    first<{ n: number }>(c.env, 'SELECT COUNT(*) AS n FROM rooms WHERE property_id = ? AND active = 1', p.id),
    first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM season_rates WHERE property_id = ? AND source = 'wizard'", p.id),
    first<{ n: number }>(c.env, 'SELECT COUNT(*) AS n FROM property_photos WHERE property_id = ? AND room_id IS NOT NULL', p.id),
  ])
  const room1 = await first<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? ORDER BY id LIMIT 1', p.id)
  const con = readContact(p.contact)
  return [
    !!p.name,
    (rooms?.n ?? 0) > 0,
    (rates?.n ?? 0) > 0,
    !!(room1?.extra_adult_rate || room1?.extra_child_rate || p.child_free_below != null || readAddons(p.addons).length),
    !!(p.cancellation_policy || con.person),
    (photos?.n ?? 0) > 0,
    p.status === 'live',
  ]
}

const Shell: FC<{ p: PropertyRow | null; step: number; done: boolean[]; icon: Child; title: string; sub: string; children?: Child }> = ({ p, step, done, icon, title, sub, children }) => (
  <div class="wiz">
    <div class="wiz-top">
      <div class="wiz-title">
        <h1>▸ {p ? 'Edit Property' : 'Add Property'}</h1>
        <nav class="crumbs small"><a href="/admin">Home</a> › <a href="/admin/properties">Properties</a> › <strong>{p ? p.name : 'Add New Property'}</strong></nav>
      </div>
      <a class="btn btn-outline btn-sm" href="/admin/properties">← Back to Properties</a>
    </div>
    <div class="wiz-grid">
      <ol class="wiz-steps card">
        {STEPS.map(([t, d], i) => {
          const n = i + 1
          const state = n === step ? 'current' : done[i] ? 'done' : 'todo'
          const inner = (
            <>
              <span class="wiz-num">{state === 'done' ? '✓' : n}</span>
              <span><strong>{t}</strong><small>{d}</small></span>
            </>
          )
          return <li class={`wiz-step ${state}`}>{p ? <a href={`/admin/properties/${p.id}/setup/${n}`}>{inner}</a> : <span class="wiz-step-in">{inner}</span>}</li>
        })}
      </ol>
      <section class="wiz-panel card">
        <header class="wiz-head">
          <span class="wiz-icon">{icon}</span>
          <div><h2>{title}</h2><p class="muted">{sub}</p></div>
        </header>
        {children}
      </section>
    </div>
  </div>
)

const Nav: FC<{ p: PropertyRow | null; step: number; next?: string }> = ({ p, step, next = 'Save & Continue' }) => (
  <div class="wiz-nav">
    <span>{step > 1 && p && <a class="btn btn-outline" href={`/admin/properties/${p.id}/setup/${step - 1}`}>← Previous</a>}</span>
    <button class="btn btn-go">{next} →</button>
  </div>
)

/** Checkbox tiles with icons + "+ Add New …" (adds to the shared list). */
const Tiles: FC<{ name: string; kind: Kind; items: [string, string][]; selected: string[]; addLabel: string }> = ({ name, kind, items, selected, addLabel }) => (
  <div class="tiles-wrap">
    <div class="tiles" data-tiles={name}>
      {items.map(([k, l]) => (
        <label class="tile"><input type="checkbox" name={name} value={k} checked={selected.includes(k)} /><span class="tile-ico">{iconFor(k)}</span><span>{l}</span></label>
      ))}
    </div>
    <button type="button" class="linklike add-new" data-add-kind={kind} data-add-target={name}>{I.plus} {addLabel}</button>
  </div>
)

const Counter: FC<{ max: number }> = ({ max }) => <span class="counter small muted" data-counter={max}>0/{max}</span>

async function loadProperty(c: Context<AppEnv>): Promise<PropertyRow | null> {
  return first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', int(c.req.param('id')))
}

// ---------- Step 1: Property details ----------
async function step1(c: Context<AppEnv>, p: PropertyRow | null) {
  const [types, themes, facilities, photos] = await Promise.all([
    listFor(c.env, 'property_type'), listFor(c.env, 'theme'), listFor(c.env, 'facility'),
    p ? all<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE property_id = ? AND room_id IS NULL ORDER BY sort, id', p.id) : Promise.resolve([] as PhotoRow[]),
  ])
  const done = await progress(c, p)
  const sel = parseJson<string[]>(p?.facilities, [])
  const selectedThemes = parseJson<string[]>(p?.themes, [])
  // Keep previously saved options available even if taxonomy later hides them.
  for (const k of selectedThemes) if (!themes.some(([key]) => key === k)) themes.push([k, THEMES[k] ?? k])
  const video = photos.find((x) => x.video_url)
  return page(c, { title: p ? `Edit ${p.name}` : 'Add Property', area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={1} done={done} icon={I.home} title="Property Details" sub="Add the property details here. AI can fetch location info and nearby attractions.">
      <form method="post" action={p ? `/admin/properties/${p.id}/setup/1` : '/admin/properties/new'} enctype="multipart/form-data" class="stack wiz-form">
        <div class="wiz-2">
          <label class="wf"><span class="wl">Property Name <b>*</b></span><input name="name" value={p?.name ?? ''} required maxlength={100} placeholder="e.g. Elixir Woods Resort" /></label>
          <label class="wf"><span class="wl">Destination / Location <b>*</b></span><span class="with-ico">{I.pin}<input name="destination" value={p ? `${p.destination}, Kerala` : ''} required maxlength={80} placeholder="e.g. Munnar, Kerala" /></span></label>
        </div>
        <div class="wiz-2">
          <label class="wf">
            <span class="wl">Property Type / Category <b>*</b> <button type="button" class="linklike add-new" data-add-kind="property_type" data-add-select="type">{I.plus} Add New Category</button></span>
            <select name="type" id="type" required><option value="">Select property type</option>{types.map(([k, l]) => <option value={k} selected={p ? (p.stay_type ?? p.type) === k : false}>{l}</option>)}</select>
          </label>
          <div class="wf">
            <span class="wl" id="best-for-label">Best For (Filters for Guest Search) <b>*</b></span>
            <details class="best-for-select" data-best-for>
              <summary aria-labelledby="best-for-label" aria-describedby="best-for-help"><span data-best-for-tags>{selectedThemes.length ? selectedThemes.map((k) => <span class="best-for-tag">{THEMES[k] ?? k}</span>) : 'Select best suited options'}</span><span aria-hidden="true">▾</span></summary>
              <div class="best-for-options" role="group" aria-labelledby="best-for-label">
                {themes.map(([k, l]) => <label><input type="checkbox" name="best_for" value={k} checked={selectedThemes.includes(k)} /><span>{l}</span></label>)}
              </div>
            </details>
            <small class="muted" id="best-for-help">Select all that apply.</small>
          </div>
        </div>
        <label class="wf"><span class="wl">Short Highlights about Property (3-4 points) <b>*</b></span>
          <textarea name="highlights" rows={3} maxlength={300} required placeholder="Enter key highlights (e.g. scenic location, private pool, family friendly, etc.)">{parseJson<string[]>(p?.highlights, []).join('\n')}</textarea><Counter max={300} />
        </label>
        <div class="wf common-photos" data-common-photos data-upload-url={p ? `/admin/properties/${p.id}/common-photos` : undefined}>
          <span class="wl">Common Photos & Video Link</span>
          <span class="muted small">Add common photos and/or a YouTube/Drive video link. New-property photos are saved with Save & Continue.</span>
          <div class="wiz-2 media-row">
            <label class="drop">
              <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple data-common-photo-input />
              <span class="drop-ico">{I.image}</span>
              <span><strong>Upload Photos</strong><small>Add property images<br />(JPG, PNG - Max 10MB each)</small></span>
            </label>
            <div>
              <span class="with-ico">{I.link}<input name="video" type="url" value={video?.video_url ?? ''} placeholder="Paste YouTube or Google Drive link (optional)" /></span>
              <small class="muted">e.g. https://www.youtube.com/watch?v=xxxx</small>
            </div>
          </div>
          <p class="muted small" role="status" aria-live="polite" data-common-photo-status>{p ? 'Select photos to upload and preview them here.' : 'Selected photos will appear here before saving.'}</p>
          <div class="thumbs" data-common-photo-thumbs>
            {photos.filter((x) => x.r2_key && x.media_type === 'image').map((x) => <span class="common-photo" data-photo-id={x.id}><img src={mediaUrl(x.r2_key, 200)} alt={x.caption || 'Common property photo'} /><button type="button" class="thumb-x" data-remove-common-photo={x.id} aria-label="Remove common property photo">×</button><small>Saved</small></span>)}
          </div>
        </div>
        <div class="wf">
          <span class="wl">Facilities and Activities <b>*</b></span>
          <span class="muted small">Select all available facilities and activities at the property</span>
          <Tiles name="facilities" kind="facility" items={facilities} selected={sel} addLabel="Add New Facilities and Activities" />
        </div>
        <Nav p={p} step={1} />
      </form>
    </Shell>
  ))
}

wizardRoutes.get('/admin/properties/new', requirePerm('manage_properties'), (c) => step1(c, null))

async function saveStep1(c: Context<AppEnv>, existing: PropertyRow | null) {
  const f = await form(c)
  const name = str(f.name, 100)
  const destination = str(f.destination, 80).replace(/,?\s*kerala\.?$/i, '').trim()
  const type = f.type in STAY_TYPES ? f.type : ''
  if (!name || !destination || !type) return { err: 'Property name, destination and type are required.' }
  const facilities = [...new Set(f.__all.facilities ?? [])].filter((x) => x in KINDS.facility.map)
  if (!facilities.length) return { err: 'Select at least one facility or activity.' }
  const themes = [...new Set(f.__all.best_for ?? [])].filter((x) => x in THEMES || parseJson<string[]>(existing?.themes, []).includes(x))
  if (!themes.length) return { err: 'Select at least one Best For option.' }
  const highlights = str(f.highlights, 300).split(/\n|•|;/).map((x) => x.trim().replace(/^[-*]\s*/, '')).filter(Boolean).slice(0, 6)
  const v = { name, destination, stay_type: type, type: legacyType(type), themes: JSON.stringify(themes), highlights: JSON.stringify(highlights), facilities: JSON.stringify(facilities) }
  let id: number
  if (existing) {
    id = existing.id
    await run(c.env, `UPDATE properties SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, ...Object.values(v), id)
  } else {
    let slug = slugify(`${name} ${destination}`)
    if (await first(c.env, 'SELECT 1 FROM properties WHERE slug = ?', slug)) slug += '-' + Date.now().toString(36)
    id = await insertId(c.env, `INSERT INTO properties (slug, status, weekend_nights, ${Object.keys(v).join(', ')}) VALUES (?, 'draft', '5,6,0', ${placeholders(Object.keys(v).length)})`, slug, ...Object.values(v))
    await logActivity(c.env, c.get('user')!.id, 'property.created', 'property', id, { name, via: 'wizard' })
  }
  await run(c.env, 'INSERT OR IGNORE INTO destinations (name, slug) VALUES (?, ?)', destination, slugify(destination))
  // Common photos and video link
  const body = await c.req.parseBody({ all: true })
  const files = (Array.isArray(body.photos) ? body.photos : [body.photos]).filter((x): x is File => x instanceof File && x.size > 0)
  await storePhotos(c, id, files, 'common', null)
  const video = str(f.video, 300)
  if (video && (videoEmbedUrl(video) || /drive\.google\.com/.test(video))) {
    const had = await first(c.env, "SELECT 1 FROM property_photos WHERE property_id = ? AND video_url = ?", id, video)
    if (!had) await run(c.env, "INSERT INTO property_photos (property_id, r2_key, caption, sort, category, media_type, video_url) VALUES (?, '', NULL, 999, 'common', 'video', ?)", id, video)
  }
  // Keep location/nearby enrichment, without generating property descriptions.
  await enqueue(c.env, { type: 'enrich_property', propertyId: id })
  await afterPropertySave(c, id)
  return { id }
}

wizardRoutes.post('/admin/properties/new', requirePerm('manage_properties'), async (c) => {
  const r = await saveStep1(c, null)
  if ('err' in r) return redirectMsg(c, '/admin/properties/new', { err: r.err })
  return c.redirect(`/admin/properties/${r.id}/setup/2`, 303)
})

const IMAGE = /^image\/(jpeg|png|webp)$/
async function storePhotos(c: Context<AppEnv>, propertyId: number, files: File[], category: string, roomId: number | null) {
  let sort = (await first<{ m: number }>(c.env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM property_photos WHERE property_id = ?', propertyId))?.m ?? 0
  let n = 0
  for (const f of files.slice(0, 20)) {
    if (!IMAGE.test(f.type) || f.size > 10 * 1024 * 1024) continue
    const key = `properties/${propertyId}/${category}/${crypto.randomUUID()}.${f.type === 'image/jpeg' ? 'jpg' : f.type.split('/')[1]}`
    await c.env.MEDIA.put(key, f.stream(), { httpMetadata: { contentType: f.type } })
    const pid = await insertId(c.env, "INSERT INTO property_photos (property_id, r2_key, sort, category, room_id, media_type) VALUES (?, ?, ?, ?, ?, 'image')", propertyId, key, ++sort, category, roomId)
    await enqueue(c.env, { type: 'photo_tags', photoId: pid })
    n++
  }
  return n
}

// Scoped common-photo uploads do not save property fields or touch room photos.
wizardRoutes.post('/admin/properties/:id/common-photos', requirePerm('manage_properties'), async (c) => {
  const p = await loadProperty(c)
  if (!p) return c.json({ error: 'Property not found.' }, 404)
  const body = await c.req.parseBody()
  const file = body.photo
  const token = String(body.upload_key ?? '')
  if (!(file instanceof File) || !file.size || !IMAGE.test(file.type) || file.size > 10 * 1024 * 1024) return c.json({ error: 'Choose a JPG, PNG or WebP image up to 10 MB.' }, 400)
  if (!/^[a-f0-9-]{36}$/i.test(token)) return c.json({ error: 'Invalid upload identifier.' }, 400)
  const key = `properties/${p.id}/common/${token}.${file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]}`
  const find = () => first<PhotoRow>(c.env, "SELECT * FROM property_photos WHERE property_id = ? AND r2_key = ? AND room_id IS NULL AND media_type = 'image'", p.id, key)
  try {
    let photo = await find()
    if (!photo) {
      await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } })
      const sort = (await first<{ m: number }>(c.env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM property_photos WHERE property_id = ?', p.id))?.m ?? 0
      // Reusing an upload identifier after a lost response must not insert a second record.
      await run(c.env, "INSERT INTO property_photos (property_id,r2_key,sort,category,room_id,media_type) SELECT ?,?,?,'common',NULL,'image' WHERE NOT EXISTS (SELECT 1 FROM property_photos WHERE property_id = ? AND r2_key = ?)", p.id, key, sort + 1, p.id, key)
      photo = await find()
      if (!photo) throw new Error('Photo record was not saved.')
      await enqueue(c.env, { type: 'photo_tags', photoId: photo.id })
      await afterPropertySave(c, p.id)
    }
    return c.json({ id: photo.id, url: mediaUrl(photo.r2_key, 200) })
  } catch {
    return c.json({ error: 'Photo upload failed. Please retry this photo.' }, 500)
  }
})

wizardRoutes.post('/admin/properties/:id/common-photos/:photoId/remove', requirePerm('manage_properties'), async (c) => {
  const p = await loadProperty(c)
  if (!p) return c.json({ error: 'Property not found.' }, 404)
  const photo = await first<PhotoRow>(c.env, "SELECT * FROM property_photos WHERE id = ? AND property_id = ? AND room_id IS NULL AND media_type = 'image'", int(c.req.param('photoId')), p.id)
  if (!photo) return c.json({ error: 'Common photo not found.' }, 404)
  // Detach only this gallery record; retain its object so any other references remain safe.
  await run(c.env, 'DELETE FROM property_photos WHERE id = ? AND property_id = ? AND room_id IS NULL', photo.id, p.id)
  await afterPropertySave(c, p.id)
  return c.json({ ok: true })
})

// ---------- Step 2: Room categories ----------
const RoomBlock: FC<{ i: string; r?: RoomRow; amenities: [string, string][] }> = ({ i, r, amenities }) => {
  const sel = parseJson<string[]>(r?.facilities, [])
  const pax = Array.from({ length: 20 }, (_, k) => k + 1)
  return (
    <div class="room-block" data-room-block={i}>
      <input type="hidden" name={`rb${i}_id`} value={r?.id ?? ''} />
      <div class="wiz-4">
        <label class="wf wf-wide">
          <span class="wl">Room Category <b>*</b> <button type="button" class="linklike add-new" data-add-kind="room_category" data-add-input={`rb${i}_name`}>{I.plus} Add New Room Category</button></span>
          <input name={`rb${i}_name`} id={`rb${i}_name`} value={r?.name ?? ''} list="room-cats" maxlength={80} placeholder="e.g. Deluxe Room, Premium Villa, Standard Room" />
        </label>
        <label class="wf"><span class="wl">No. of Rooms <b>*</b></span><input type="number" name={`rb${i}_units`} value={r?.units ?? 1} min="1" max="500" /></label>
        <label class="wf"><span class="wl">No. of Pax Allowed <b>*</b></span><select name={`rb${i}_base`}>{pax.map((n) => <option value={n} selected={(r ? Math.min(r.base_guests ?? r.capacity, r.capacity) : 2) === n}>{n} Pax</option>)}</select></label>
        <label class="wf"><span class="wl">Max No. of Pax <small>(with extra charges)</small></span><select name={`rb${i}_max`}>{pax.map((n) => <option value={n} selected={(r?.capacity ?? 4) === n}>{n} Pax</option>)}</select></label>
      </div>
      <label class="wf"><span class="wl">Room Short Description <b>*</b></span>
        <textarea name={`rb${i}_desc`} rows={3} maxlength={300} placeholder="Enter a short description about this room (e.g. spacious room with balcony, mountain view, private pool, etc.)">{r?.description ?? ''}</textarea><Counter max={300} />
      </label>
      <div class="wf">
        <span class="wl">Amenities in Room <b>*</b></span>
        <span class="muted small">Select the amenities available in this room category.</span>
        <Tiles name={`rb${i}_am`} kind="amenity" items={amenities} selected={sel} addLabel="Add New Amenities" />
      </div>
    </div>
  )
}

async function step2(c: Context<AppEnv>, p: PropertyRow) {
  const [rooms, amenities, cats] = await Promise.all([
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY id', p.id),
    listFor(c.env, 'amenity'), listFor(c.env, 'room_category'),
  ])
  const done = await progress(c, p)
  return page(c, { title: `Rooms · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={2} done={done} icon={I.bed} title="Room Categories" sub="Add different room types available at the property. You can add multiple room categories.">
      <form method="post" action={`/admin/properties/${p.id}/setup/2`} class="stack wiz-form">
        <datalist id="room-cats">{cats.map(([, l]) => <option value={l} />)}</datalist>
        <div id="room-blocks" class="stack">
          {(rooms.length ? rooms : [undefined]).map((r, i) => <RoomBlock i={String(i)} r={r} amenities={amenities} />)}
        </div>
        <template id="room-block-tpl"><RoomBlock i="__I__" amenities={amenities} /></template>
        <div class="wiz-nav">
          <button type="button" class="btn btn-soft" data-add-block="room">{I.plus} Add Another Room Category</button>
          <span class="row"><a class="btn btn-outline" href={`/admin/properties/${p.id}/setup/1`}>← Previous</a><button class="btn btn-go">Save & Continue →</button></span>
        </div>
      </form>
    </Shell>
  ))
}

async function saveStep2(c: Context<AppEnv>, p: PropertyRow) {
  const f = await form(c)
  const idx = [...new Set(Object.keys(f).map((k) => k.match(/^rb(\d+)_name$/)?.[1]).filter((x): x is string => !!x))]
  let n = 0
  for (const i of idx.slice(0, 40)) {
    const name = str(f[`rb${i}_name`], 80)
    if (!name) continue
    const base = Math.max(1, Math.min(60, int(f[`rb${i}_base`], 2)))
    const cap = Math.max(base, Math.min(60, int(f[`rb${i}_max`], base)))
    const am = (f.__all[`rb${i}_am`] ?? []).filter((x) => x in KINDS.amenity.map)
    const v = { name, units: Math.max(1, int(f[`rb${i}_units`], 1)), base_guests: base, capacity: cap, description: str(f[`rb${i}_desc`], 300), facilities: JSON.stringify(am) }
    const id = int(f[`rb${i}_id`])
    if (id && (await first(c.env, 'SELECT 1 FROM rooms WHERE id = ? AND property_id = ?', id, p.id))) {
      await run(c.env, `UPDATE rooms SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(v), id)
    } else {
      await run(c.env, `INSERT INTO rooms (property_id, base_rate, ${Object.keys(v).join(', ')}) VALUES (?, 0, ${placeholders(Object.keys(v).length)})`, p.id, ...Object.values(v))
    }
    if (!(KINDS.room_category.map as Record<string, string>)[name]) await addItem(c.env, 'room_category', name).catch(() => {})
    n++
  }
  if (!n) return { err: 'Add at least one room category.' }
  await afterPropertySave(c, p.id)
  return {}
}

// ---------- Step 3: Room rates ----------
type Rates = Record<string, SeasonRate & { id: number; source: string | null }>
const val = (n: number | null | undefined) => (n ? String(n) : '')

const PeakEntry: FC<{ row: (SeasonRate & { id: number }) | null }> = ({ row }) => (
  <div class="wiz-4 peak-row" data-peak-entry>
    <input type="hidden" name="common_managed_id" value={row?.id ?? ''} />
    <input type="hidden" name="common_managed_remove" value="0" />
    <input type="hidden" name="common_managed_key" value={row ? commonPeakKey(row) ?? '' : ''} />
    <label class="wf"><span class="wl">From Date <b>*</b></span><input type="date" name="common_managed_from" value={row?.start_date ?? ''} /></label>
    <label class="wf"><span class="wl">To Date <b>*</b></span><input type="date" name="common_managed_to" value={row?.end_date ?? ''} /></label>
    <label class="wf"><span class="wl">Additional Charge (₹) <b>*</b></span><input type="number" min="0" name="common_managed_amt" value={row?.supplement ?? ''} placeholder="Enter amount" /></label>
    <label class="wf"><span class="wl">Description (Optional)</span><input name="common_managed_desc" maxlength={60} value={row && row.name !== 'Peak time' ? row.name : ''} placeholder="e.g. Christmas, New Year, Diwali etc." /></label>
    <button type="button" class="icon-btn" data-remove-managed-peak aria-label="Delete peak period">{I.trash}</button>
  </div>
)

async function step3(c: Context<AppEnv>, p: PropertyRow) {
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY id', p.id)
  if (!rooms.length) return redirectMsg(c, `/admin/properties/${p.id}/setup/2`, { err: 'Add a room category first.' })
  const rows = await all<SeasonRate & { id: number; source: string | null }>(c.env, "SELECT * FROM season_rates WHERE property_id = ? AND (source = 'wizard' OR source LIKE 'wizard-common:%' OR source LIKE 'wizard-override:%') ORDER BY id", p.id)
  const common = rows.filter(x => commonPeakKey(x))
  const done = await progress(c, p)
  const perms = await permissionsFor(c.env, c.get('user')!.role)
  return page(c, { title: `Rates · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={3} done={done} icon={I.coins} title="Room Rates" sub="Set different rates for off season, season and peak times. Enter rates for weekdays and weekends with CP, MAP, AP and EP plans.">
      <form method="post" action={`/admin/properties/${p.id}/setup/3`} class="stack wiz-form" data-rates data-rates-draft={c.get('user')!.id}>
        <div class="wiz-2 rate-pick">
          <label class="wf">
            <span class="wl">Select Room Category <b>*</b> <a class="linklike add-new" href={`/admin/properties/${p.id}/setup/2`}>{I.plus} Add New Room Category</a></span>
            <select data-room-select>{rooms.map((r) => <option value={r.id}>{r.name}</option>)}</select>
          </label>
          <div class="hint-box">{I.bed}<span><strong>Select a room category to set its rates.</strong><small>You can add rates for each season, off season and peak time separately.</small></span></div>
        </div>
        <section class="card stack" aria-label="Room rate status">
          <h3>Room Rates Added</h3>
          {rooms.map((r) => <div class="row-between">
            <strong>{r.name}</strong>
            <span class="row"><span data-rate-status={r.id} aria-live="polite">Not added</span><button type="button" class="btn btn-outline btn-sm" data-view-rate-room={r.id}>View/Edit</button></span>
          </div>)}
        </section>
        {rooms.map((r, ri) => {
          const mine: Rates = {}
          for (const x of rows.filter((x) => x.room_id === r.id).sort((a, b) => b.start_date.localeCompare(a.start_date))) mine[`${x.kind === 'off_season' ? 'off' : x.kind === 'season' ? 'sea' : 'peak'}_${x.meal_plan ?? ''}`] = x
          return (
            <div class="rate-room" data-rate-room={r.id} hidden={ri > 0}>
              {PERIODS.map(([pk, title, sub]) => {
                const kind = pk === 'off' ? 'off_season' : 'season'
                const ranges = periodRanges(rows.filter((x) => x.room_id === r.id && x.source === 'wizard' && x.kind === kind && x.supplement == null))
                return (
                  <div class={`period period-${pk}`}>
                    <div class="period-head">
                      <span class="period-ico">{pk === 'off' ? I.leaf : I.sun}</span>
                      <div><h3>{title}</h3><small class="muted">{sub}. All date ranges below use the same rates.</small></div>
                    </div>
                    <div class="date-ranges stack" data-ranges={`r${r.id}_${pk}`}>
                      {(ranges.length ? ranges : [undefined]).map((range) => <RangeRow name={`r${r.id}_${pk}`} range={range} />)}
                    </div>
                    <button type="button" class="linklike add-new" data-add-range={`r${r.id}_${pk}`}>{I.plus} Add another date range</button>
                    <div class="wiz-2 rate-tables">
                      {[['wk', 'Weekdays Rates (Mon - Thu)'], ['we', 'Weekends Rates (Fri - Sun)']].map(([dk, dl]) => (
                        <div class={`rate-table rt-${dk}`}>
                          <div class="rt-title">{dl}</div>
                          <table>
                            <thead><tr><th>Meal Plan</th>{TIERS.filter(([t]) => t !== 'b2b' || perms.view_net_rates).map(([, tl]) => <th>{tl}</th>)}</tr></thead>
                            <tbody>
                              {PLANS.map(([plan, desc]) => {
                                const row = mine[`${pk}_${plan}`]
                                const v = (t: string) => (dk === 'wk'
                                  ? (t === 'b2b' ? row?.net_rate : t === 'staff' ? row?.staff_rate : row?.rate)
                                  : (t === 'b2b' ? row?.net_weekend_rate : t === 'staff' ? row?.staff_weekend_rate : row?.weekend_rate))
                                return (
                                  <tr>
                                    <td><strong>{plan}</strong> <small class="muted">{desc}</small></td>
                                    {TIERS.filter(([t]) => t !== 'b2b' || perms.view_net_rates).map(([t, tl]) => <td data-l={tl}><input type="number" min="0" name={`r${r.id}_${pk}_${dk}_${plan}_${t}`} value={val(v(t))} placeholder="Enter rate" /></td>)}
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
              <div data-peak-slot={r.id}></div>
            </div>
          )
        })}
        <div class="period period-peak" data-shared-peak-section>
          <div class="period-head">
            <span class="period-ico">{I.crown}</span>
            <div><h3>Peak Time Charges</h3><small class="muted">Add additional charges for special peak time periods (e.g. Christmas, New Year, Diwali etc.)</small></div>
            <button type="button" class="linklike add-new" data-add-managed-peak>{I.plus} Add New Peak Time</button>
          </div>
          <div class="peak-rows" data-managed-peaks="common"><div data-peak-entries>{(common.length ? common : [null]).map(x => <PeakEntry row={x} />)}</div></div>
          {/* Saved room-specific records remain untouched and visible for their original room. */}
          {rooms.map(r => <div data-legacy-peak-room={r.id} hidden={r.id !== rooms[0].id}>
            {rows.filter(x => x.room_id === r.id && x.supplement != null && !commonPeakKey(x)).map(x => <div class="wiz-4 peak-row">
              <label class="wf"><span class="wl">From Date</span><input type="date" value={x.start_date} readonly /></label>
              <label class="wf"><span class="wl">To Date</span><input type="date" value={x.end_date} readonly /></label>
              <label class="wf"><span class="wl">Additional Charge (₹)</span><input type="number" value={x.supplement ?? ''} readonly /></label>
              <label class="wf"><span class="wl">Description</span><input value={x.name} readonly /></label>
            </div>)}
          </div>)}
        </div>
        <div class="wiz-nav">
          <button type="button" class="btn btn-soft" data-next-room>{I.plus} Add Next Room Category Rates</button>
          <span class="row"><a class="btn btn-outline" href={`/admin/properties/${p.id}/setup/2`}>← Previous</a><button class="btn btn-go">Save & Continue →</button></span>
        </div>
      </form>
    </Shell>
  ))
}

async function saveStep3(c: Context<AppEnv>, p: PropertyRow) {
  const f = await form(c)
  const perms = await permissionsFor(c.env, c.get('user')!.role)
  const uid = c.get('user')!.id
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1', p.id)
  const old = await all<SeasonRate & { id: number }>(c.env, "SELECT * FROM season_rates WHERE property_id = ? AND source = 'wizard'", p.id)
  const n = (k: string, previous?: number | null) => !(k in f) ? previous ?? null : (int(f[k]) > 0 ? int(f[k]) : null)
  const ins = "INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, weekend_rate, staff_rate, staff_weekend_rate, net_rate, net_weekend_rate, supplement, net_supplement, kind, meal_plan, source, created_by, rate_group_key, applicable_weekdays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'wizard', ?, ?, ?)"
  let stmts: D1PreparedStatement[]
  try { stmts = peakStatements(c.env.DB, p.id, uid, rooms.map(r => r.id), await all<SeasonRate & { id: number }>(c.env, 'SELECT * FROM season_rates WHERE property_id = ?', p.id), f) }
  catch (e) { return { err: e instanceof Error ? e.message : 'Invalid peak charges.' } }
  const write = (keep: SeasonRate | undefined, values: unknown[]) => {
    // values: property, room, 13 rate columns, created_by, group key, weekdays
    const columns = ['name', 'start_date', 'end_date', 'rate', 'weekend_rate', 'staff_rate', 'staff_weekend_rate', 'net_rate', 'net_weekend_rate', 'supplement', 'net_supplement', 'kind', 'meal_plan'] as const
    const extra = [values[16] ?? null, values[17] || null]
    if (keep && columns.every((key, i) => (keep[key] ?? null) === (values[i + 2] ?? null)) && (keep.rate_group_key ?? null) === extra[0] && (keep.applicable_weekdays || null) === extra[1]) return false
    if (keep?.id) {
      stmts.push(c.env.DB.prepare('UPDATE season_rates SET name=?, start_date=?, end_date=?, rate=?, weekend_rate=?, staff_rate=?, staff_weekend_rate=?, net_rate=?, net_weekend_rate=?, supplement=?, net_supplement=?, kind=?, meal_plan=?, rate_group_key=?, applicable_weekdays=? WHERE id=? AND property_id=? AND room_id=? AND source=\'wizard\'').bind(...values.slice(2, 15), ...extra, keep.id, p.id, values[1]))
    } else stmts.push(c.env.DB.prepare(ins).bind(...values.slice(0, 16), ...extra))
    return true
  }
  let saved = 0
  let defaultPlan: string | null = null
  const configuredPlans = new Set<string>(old.filter(x => x.meal_plan && x.supplement == null).map(x => x.meal_plan!))
  for (const r of rooms) {
    let roomChanged = false
    let regular: { plan: string; wk: number | null; we: number | null; staff: number | null; net: number | null } | null = null
    for (const [pk, , , kind] of [...PERIODS].reverse()) {
      const key = `r${r.id}_${pk}`
      // Every date range of this period shares the rate table below (one row per range × meal plan).
      const ranges = submittedRanges(f, key)
      if (!ranges.length) continue
      const group = `wizard:${r.id}:${kind}`
      for (const [plan] of PLANS) {
        const olds = old.filter((x) => x.room_id === r.id && x.kind === kind && x.meal_plan === plan && x.supplement == null).sort((a, b) => a.start_date.localeCompare(b.start_date))
        const keep = olds[0]
        const net = perms.view_net_rates ? n(`${key}_wk_${plan}_b2b`, keep?.net_rate) : keep?.net_rate ?? null
        const netWe = perms.view_net_rates ? n(`${key}_we_${plan}_b2b`, keep?.net_weekend_rate) : keep?.net_weekend_rate ?? null
        const wk = n(`${key}_wk_${plan}_direct`, keep?.rate), we = n(`${key}_we_${plan}_direct`, keep?.weekend_rate)
        const staff = n(`${key}_wk_${plan}_staff`, keep?.staff_rate), staffWe = n(`${key}_we_${plan}_staff`, keep?.staff_weekend_rate)
        if ([wk, we, staff, staffWe, net, netWe].every((v) => v == null)) continue
        configuredPlans.add(plan)
        defaultPlan ??= plan
        const same = (x: SeasonRate, g: DateRange) => x.start_date === g.from && x.end_date === g.to && daysValue(x.applicable_weekdays) === g.days
        const spare = olds.filter((x) => !ranges.some((g) => same(x, g)))
        for (const g of ranges) {
          const row = olds.find((x) => same(x, g)) ?? spare.shift()
          roomChanged = write(row, [p.id, r.id, PERIOD_NAME[pk], g.from, g.to, wk, we, staff, staffWe, net, netWe, null, null, kind, plan, uid, group, g.days]) || roomChanged
          saved++
        }
        // Date ranges removed in the form.
        for (const x of spare) { stmts.push(c.env.DB.prepare("DELETE FROM season_rates WHERE id = ? AND property_id = ? AND source = 'wizard'").bind(x.id, p.id)); roomChanged = true }
        // Regular room rates (outside any period) follow the season's CP rate, else the first plan entered.
        // A period limited to certain weekdays (e.g. every Saturday) never becomes the everyday rate.
        if (wk != null && ranges.some((g) => !g.days) && (!regular || (plan === 'CP' && regular.plan !== 'CP' && pk === 'sea'))) regular = { plan, wk, we, staff, net }
      }
    }
    const froms = f.__all[`r${r.id}_peak_from`] ?? [], tos = f.__all[`r${r.id}_peak_to`] ?? [], amts = f.__all[`r${r.id}_peak_amt`] ?? [], descs = f.__all[`r${r.id}_peak_desc`] ?? []
    froms.forEach((from, k) => {
      const to = tos[k], amt = int(amts[k])
      if (!isDate(from) || !isDate(to) || to < from || !(amt > 0)) return
      const keep = old.find(x => x.id === int(f.__all[`r${r.id}_peak_id`]?.[k]) && x.room_id === r.id && x.kind === 'special' && x.supplement != null)
      // Existing peaks are preserved; old clients can still submit new room-specific peaks.
      if (!keep && old.some(x => x.room_id === r.id && x.kind === 'special' && x.name === (str(descs[k], 60) || 'Peak time') && x.start_date === from && x.end_date === to)) return
      if (keep) stmts.push(c.env.DB.prepare('UPDATE season_rates SET name=?,start_date=?,end_date=?,supplement=? WHERE id=? AND property_id=? AND room_id=?').bind(str(descs[k], 60) || 'Peak time', from, to, amt, keep.id, p.id, r.id))
      else write(undefined, [p.id, r.id, str(descs[k], 60) || 'Peak time', from, to, null, null, null, null, null, null, amt, amt, 'special', null, uid])
      saved++
    })
    if (regular && roomChanged) {
      // Private-only rows do not invent a legacy public base rate.
      stmts.push(c.env.DB.prepare(`UPDATE rooms SET base_rate = ?, weekend_rate = ?, staff_rate = COALESCE(?, staff_rate)${perms.view_net_rates ? ', net_rate = COALESCE(?, net_rate)' : ''} WHERE id = ?`).bind(...[regular.wk, regular.we, regular.staff, ...(perms.view_net_rates ? [regular.net] : []), r.id]))
    }
  }
  if (defaultPlan) stmts.push(c.env.DB.prepare("UPDATE properties SET rate_meal_plan = ?, weekend_nights = '5,6,0', meal_plans = ? WHERE id = ?").bind(p.rate_meal_plan && configuredPlans.has(p.rate_meal_plan) ? p.rate_meal_plan : defaultPlan, JSON.stringify([...configuredPlans]), p.id))
  if (stmts.length) await c.env.DB.batch(stmts)
  await logActivity(c.env, uid, 'price.wizard_rates', 'property', p.id, { rows: saved })
  await afterPropertySave(c, p.id)
  return {}
}

// ---------- Step 4: Additional charges & kids policies ----------
async function step4(c: Context<AppEnv>, p: PropertyRow) {
  const [room1, acts] = await Promise.all([first<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? ORDER BY id LIMIT 1', p.id), listFor(c.env, 'activity')])
  const done = await progress(c, p)
  const adds = readAddons(p.addons)
  const rows: (Addon | null)[] = adds.length ? adds : [null, null, null, null]
  const Item: FC<{ keyId: string; item?: ActivityItem }> = ({ keyId, item }) => (
    <div class="activity-item" data-act-item>
      <label class="activity-item-name"><span aria-hidden="true">↳</span><input aria-label="Item / add-on name" name={`act_${keyId}_item_name`} value={item?.name ?? ''} maxlength={80} placeholder="e.g. Music" /></label>
      <label class="check"><input type="checkbox" class="act-item-free" checked={!!item?.complimentary} /> Complimentary</label>
      <input type="hidden" class="act-item-state" name={`act_${keyId}_item_free`} value={item?.complimentary ? '1' : '0'} />
      <input type="number" class="act-item-amount" aria-label="Item charge amount (₹)" min="0" disabled={!!item?.complimentary} value={item && !item.complimentary ? item.price : ''} placeholder="Amount (₹)" />
      <input type="hidden" class="act-item-value" name={`act_${keyId}_item_amt`} value={item && !item.complimentary ? item.price : ''} />
      <button type="button" class="linklike" data-del-act-item aria-label="Remove activity item">×</button>
    </div>
  )
  return page(c, { title: `Charges · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={4} done={done} icon={I.coins} title="Additional Charges & Kids Policies" sub="Set extra person charges, child policies and activity charges for this property.">
      <form method="post" action={`/admin/properties/${p.id}/setup/4`} class="stack wiz-form">
        <datalist id="activities">{acts.map(([, l]) => <option value={l} />)}</datalist>
        <div class="tint tint-blue">
          <div class="tint-head">{I.kids}<div><h3>Kids Policies</h3><small class="muted">Set child age limits and charges.</small></div></div>
          <div class="tint-body wiz-2">
            <label class="wf"><span class="wl">Child with Mattress Amount (₹)</span><input type="number" min="0" name="child_bed" value={val(room1?.extra_child_rate)} placeholder="Enter amount" /></label>
            <label class="wf"><span class="wl">Child without Mattress Amount (₹)</span><input type="number" min="0" name="child_nobed" value={val(room1?.child_no_bed_rate)} placeholder="Enter amount" /></label>
            <label class="wf"><span class="wl">Child Complimentary Age Below (in years)</span><input type="number" min="0" max="17" name="child_free" value={p.child_free_below ?? ''} placeholder="Enter age (e.g. 5)" /></label>
            <div class="hint-box">{I.info}<span>Child above the complimentary age will be charged accordingly as per the above rates.</span></div>
          </div>
        </div>
        <div class="tint tint-green">
          <div class="tint-head">{I.person}<div><h3>Extra Person Charges</h3><small class="muted">Set charge for additional adult guests.</small></div></div>
          <div class="tint-body wiz-2">
            <label class="wf"><span class="wl">Extra Person Charge (Adult) (₹)</span><input type="number" min="0" name="extra_adult" value={val(room1?.extra_adult_rate)} placeholder="Enter amount" /></label>
          </div>
        </div>
        <div class="tint tint-amber">
          <div class="tint-head">{I.hike}<div><h3>Activities Charge</h3><small class="muted">Add activities available at the property and set charges.</small></div>
            <button type="button" class="linklike add-new" data-add-activity>{I.plus} Add New Activity</button></div>
          <div class="tint-body">
            <table class="act-table">
              <thead><tr><th>Activity</th><th>Complimentary</th><th>Charge Amount (₹)</th><th>Action</th></tr></thead>
              <tbody data-acts>
                {rows.map((a, index) => (
                  <tr data-act-row={index}>
                    <td colspan={4}>
                      <div class="activity-main">
                        <div><input type="hidden" name="act_key" value={index} /><input name="act_name" list="activities" value={a?.name ?? ''} placeholder="Select activity" aria-label="Activity" /></div>
                        <div><label class="check"><input type="checkbox" class="act-free" checked={!!a?.complimentary} /> Complimentary</label><input type="hidden" name="act_free" value={a?.complimentary ? '1' : '0'} /></div>
                        <span class="row"><input type="checkbox" class="act-charge" checked={!!a && !a.complimentary && a.price > 0} aria-label="Chargeable" /><input type="number" min="0" name="act_amt" value={a && !a.complimentary ? val(a.price) : ''} placeholder="Enter amount" aria-label="Activity charge amount (₹)" /></span>
                        <button type="button" class="icon-btn" data-del-row aria-label="Remove">{I.trash}</button>
                      </div>
                      <div class="activity-items" data-act-items>{(a?.items ?? []).map((item) => <Item keyId={String(index)} item={item} />)}</div>
                      <button type="button" class="linklike small" data-add-act-item>{I.plus} Add Item</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <template id="activity-item-tpl"><Item keyId="__ACT__" /></template>
          </div>
        </div>
        <Nav p={p} step={4} />
      </form>
    </Shell>
  ))
}

async function saveStep4(c: Context<AppEnv>, p: PropertyRow) {
  const f = await form(c)
  const opt = (k: string) => (f[k] === '' || f[k] == null ? null : Math.max(0, int(f[k])))
  const keys = f.__all.act_key ?? []
  if (keys.some((key) => !/^\d+$/.test(key)) || new Set(keys).size !== keys.length) return { err: 'Invalid activity rows. Reopen this step and try again.' }
  if (keys.some((key, index) => !str(f.__all.act_name?.[index], 80) && (f.__all[`act_${key}_item_name`] ?? []).some((name) => name.trim()))) return { err: 'Select a parent activity for each item.' }
  const adult = opt('extra_adult'), childBed = opt('child_bed'), noBed = opt('child_nobed')
  await run(c.env, 'UPDATE rooms SET extra_adult_rate = ?, extra_child_rate = ?, child_no_bed_rate = ?, extra_bed = ?, extra_bed_rate = ? WHERE property_id = ?', adult, childBed, noBed, adult ? 1 : 0, adult, p.id)
  const names = f.__all.act_name ?? [], free = f.__all.act_free ?? [], amts = f.__all.act_amt ?? []
  const old = readAddons(p.addons)
  const list: Addon[] = []
  for (let i = 0; i < Math.min(40, names.length); i++) {
    const name = str(names[i], 80)
    if (!name) continue
    const complimentary = free[i] === '1'
    const price = complimentary ? 0 : Math.max(0, int(amts[i]))
    const prev = old.find((a) => a.name.toLowerCase() === name.toLowerCase())
    const key = f.__all.act_key?.[i]
    const items = key != null && /^\d+$/.test(key) ? (f.__all[`act_${key}_item_name`] ?? []).slice(0, 40).map((value, itemIndex) => {
      const itemName = str(value, 80)
      const itemFree = f.__all[`act_${key}_item_free`]?.[itemIndex] === '1'
      return { name: itemName, price: itemFree ? 0 : Math.max(0, int(f.__all[`act_${key}_item_amt`]?.[itemIndex])), complimentary: itemFree }
    }).filter((item) => item.name) : prev?.items ?? []
    list.push({ name, price, net: prev?.net ?? null, per: prev?.per ?? 'stay', complimentary, ...(items.length || prev?.items ? { items } : {}) })
    if (!Object.values(KINDS.activity.map as Record<string, string>).some((l) => l.toLowerCase() === name.toLowerCase())) await addItem(c.env, 'activity', name).catch(() => {})
  }
  await run(c.env, 'UPDATE properties SET child_free_below = ?, addons = ? WHERE id = ?', opt('child_free'), JSON.stringify(list), p.id)
  await afterPropertySave(c, p.id)
  return {}
}

// ---------- Step 5: Cancellation policy & contact ----------
async function step5(c: Context<AppEnv>, p: PropertyRow) {
  const done = await progress(c, p)
  const showContact = await canSeeContacts(c)
  const con = readContact(p.contact)
  const others = (con.others ?? '').split('\n').map((l) => l.split(/\s+–\s+/)).filter((x) => x[0])
  const people: [string, string, string][] = [[con.person ?? '', con.phone ?? '', con.email ?? ''], ...others.map((x) => [x[0] ?? '', x[1] ?? '', x[2] ?? ''] as [string, string, string])]
  return page(c, { title: `Policy & contact · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={5} done={done} icon={I.doc} title="Property Cancellation Policy & Contact Details" sub="Set the cancellation policy for this property and add contact details for communication.">
      <form method="post" action={`/admin/properties/${p.id}/setup/5`} class="stack wiz-form">
        <div class="tint tint-red">
          <div class="tint-head">{I.docRed}<div><h3>Property Cancellation Policy</h3><small class="muted">Enter the cancellation policy for this property. You can mention different rules for different time periods if needed.</small></div></div>
          <div class="tint-body"><textarea name="cancellation" rows={6} maxlength={1000} placeholder="Enter cancellation policy here...">{p.cancellation_policy ?? ''}</textarea><Counter max={1000} /></div>
        </div>
        {showContact ? (
          <div class="tint tint-blue">
            <div class="tint-head">{I.person}<div><h3>Contact Details</h3><small class="muted">Add the primary contact person details for this property.</small></div>
              <button type="button" class="linklike add-new" data-add-contact>{I.plus} Add New Contact Person</button></div>
            <div class="tint-body stack" data-contacts>
              {people.map(([n, ph, em], i) => (
                <div class="wiz-3">
                  <label class="wf"><span class="wl">Contact Person Name {i === 0 && <b>*</b>}</span><input name="c_name" value={n} required={i === 0} maxlength={80} placeholder="Enter name" /></label>
                  <label class="wf"><span class="wl">Contact Number {i === 0 && <b>*</b>}</span><input name="c_phone" value={ph} required={i === 0} type="tel" maxlength={20} placeholder="Enter contact number" /></label>
                  <label class="wf"><span class="wl">Email ID {i === 0 && <b>*</b>}</span><input name="c_email" value={em} required={i === 0} type="email" maxlength={120} placeholder="Enter email id" /></label>
                </div>
              ))}
            </div>
          </div>
        ) : <p class="muted small">Contact details are visible to admins only.</p>}
        <Nav p={p} step={5} />
      </form>
    </Shell>
  ))
}

async function saveStep5(c: Context<AppEnv>, p: PropertyRow) {
  const f = await form(c)
  await run(c.env, 'UPDATE properties SET cancellation_policy = ? WHERE id = ?', str(f.cancellation, 1000), p.id)
  if (await canSeeContacts(c)) {
    const names = f.__all.c_name ?? [], phones = f.__all.c_phone ?? [], emails = f.__all.c_email ?? []
    const people = names.map((n, i) => [str(n, 80), str(phones[i], 20), str(emails[i], 120)]).filter((x) => x[0] || x[1])
    const con: Contact = { ...readContact(p.contact) }
    con.person = people[0]?.[0] || undefined
    con.phone = people[0]?.[1] || undefined
    con.email = people[0]?.[2] || undefined
    con.others = people.slice(1).map((x) => x.filter(Boolean).join(' – ')).join('\n') || undefined
    await run(c.env, 'UPDATE properties SET contact = ?, owner_name = ?, owner_phone = ?, owner_email = ? WHERE id = ?', JSON.stringify(con), con.person ?? null, con.phone ?? null, con.email ?? null, p.id)
  }
  return {}
}

// ---------- Step 6: Images & media (per room category) ----------
async function step6(c: Context<AppEnv>, p: PropertyRow) {
  const [rooms, photos] = await Promise.all([
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY id', p.id),
    all<PhotoRow>(c.env, "SELECT * FROM property_photos WHERE property_id = ? AND room_id IS NOT NULL AND media_type = 'image' ORDER BY sort, id", p.id),
  ])
  if (!rooms.length) return redirectMsg(c, `/admin/properties/${p.id}/setup/2`, { err: 'Add a room category first.' })
  const done = await progress(c, p)
  const withPhotos = rooms.filter((r) => photos.some((x) => x.room_id === r.id))
  const blocks = withPhotos.length ? withPhotos : [rooms[0]]
  const Block: FC<{ i: string; room?: RoomRow }> = ({ i, room }) => (
    <div class="img-block">
      <h3>Room Category {i === '__I__' ? '' : Number(i) + 1}</h3>
      <div class="wiz-2 img-pick">
        <label class="wf"><span class="wl">Select Room Category <b>*</b></span><select name={`ib${i}_room`}>{rooms.map((r) => <option value={r.id} selected={room?.id === r.id}>{r.name}</option>)}</select></label>
        <div class="add-photos">
          <label class="btn btn-blue">{I.upload} Add Photos<input type="file" name={`ib${i}_files`} accept="image/jpeg,image/png,image/webp" multiple hidden data-autosubmit /></label>
          <small class="muted">Upload multiple photos (JPG, PNG, WebP)<br />Max 10 MB per image</small>
        </div>
      </div>
      {room && (
        <div class="uploaded">
          <strong class="small">Uploaded Images ({room.name})</strong>
          <div class="thumbs">
            {photos.filter((x) => x.room_id === room.id).map((x) => (
              <span class="thumb"><img src={mediaUrl(x.r2_key, 300)} alt="" /><button class="thumb-x" name="del_photo" value={x.id} formnovalidate aria-label="Remove photo">×</button></span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
  return page(c, { title: `Images · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={6} done={done} icon={I.image} title="Images & Media" sub="Upload photos for each room category. You can add multiple images for each category.">
      <form method="post" action={`/admin/properties/${p.id}/setup/6`} enctype="multipart/form-data" class="stack wiz-form">
        <div id="img-blocks" class="stack">{blocks.map((r, i) => <Block i={String(i)} room={r} />)}</div>
        <template id="img-block-tpl"><Block i="__I__" /></template>
        <div class="wiz-nav">
          <button type="button" class="btn btn-soft" data-add-block="img">{I.plus} Add Next Category</button>
          <span class="row"><a class="btn btn-outline" href={`/admin/properties/${p.id}/setup/5`}>← Previous</a><button class="btn btn-go" name="go" value="1">Save & Continue →</button></span>
        </div>
      </form>
    </Shell>
  ))
}

async function saveStep6(c: Context<AppEnv>, p: PropertyRow): Promise<{ err?: string; stay?: boolean }> {
  const body = await c.req.parseBody({ all: true })
  const del = int(String(body.del_photo ?? ''))
  if (del) {
    const ph = await first<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE id = ? AND property_id = ?', del, p.id)
    if (ph) {
      await run(c.env, 'DELETE FROM property_photos WHERE id = ?', ph.id)
      if (ph.r2_key) await c.env.MEDIA.delete(ph.r2_key).catch(() => {})
    }
    return { stay: true }
  }
  const idx = [...new Set(Object.keys(body).map((k) => k.match(/^ib(\d+)_room$/)?.[1]).filter((x): x is string => !!x))]
  let n = 0
  for (const i of idx) {
    const rid = int(String(body[`ib${i}_room`] ?? ''))
    if (!rid || !(await first(c.env, 'SELECT 1 FROM rooms WHERE id = ? AND property_id = ?', rid, p.id))) continue
    const v = body[`ib${i}_files`]
    const files = (Array.isArray(v) ? v : [v]).filter((x): x is File => x instanceof File && x.size > 0)
    n += await storePhotos(c, p.id, files, 'room', rid)
  }
  if (n) await afterPropertySave(c, p.id)
  return { stay: !body.go }
}

// ---------- Step 7: Review & save ----------
async function step7(c: Context<AppEnv>, p: PropertyRow) {
  const done = await progress(c, p)
  const [rooms, rates, photos] = await Promise.all([
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY id', p.id),
    all<{ room_id: number }>(c.env, "SELECT DISTINCT room_id FROM season_rates WHERE property_id = ? AND source = 'wizard'", p.id),
    first<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM property_photos WHERE property_id = ? AND media_type = 'image'", p.id),
  ])
  const missing = [
    !rooms.length && 'room categories',
    rooms.some((r) => !rates.some((x) => x.room_id === r.id)) && 'rates for every room category',
    !(photos?.n) && 'photos',
  ].filter(Boolean) as string[]
  if (p.status === 'live' && c.req.query('done')) {
    return page(c, { title: 'Property added', area: 'admin', active: 'prop_new' }, (
      <Shell p={p} step={7} done={done} icon={I.check} title="Review & Save" sub="Confirm and publish">
        <div class="wiz-success">
          <div class="success-badge">{raw('<svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>')}</div>
          <h2>Property Added Successfully!</h2>
          <p class="muted">Your property has been added to Go Sanchari successfully.<br />You can now manage it from the Properties section.</p>
          <a class="btn btn-blue btn-lg" href="/admin/properties/new">{I.plus} Add Another New Property</a>
          <p><a href={`/stay/${p.slug}`} target="_blank" class="small">View the guest page →</a></p>
        </div>
      </Shell>
    ))
  }
  return page(c, { title: `Review · ${p.name}`, area: 'admin', active: 'prop_new' }, (
    <Shell p={p} step={7} done={done} icon={I.check} title="Review & Save" sub="Check the summary, then publish the property for guests and staff.">
      <form method="post" action={`/admin/properties/${p.id}/setup/7`} class="stack wiz-form">
        <dl class="review-list">
          <dt>Property</dt><dd>{p.name} · {STAY_TYPES[p.stay_type ?? p.type] ?? p.type} · {p.destination}</dd>
          <dt>Room categories</dt><dd>{rooms.map((r) => `${r.name} (${r.units} rooms, ${Math.min(r.base_guests ?? r.capacity, r.capacity)}–${r.capacity} pax)`).join(', ') || '—'}</dd>
          <dt>Rates</dt><dd>{rates.length} of {rooms.length} room categories have rates</dd>
          <dt>Photos</dt><dd>{photos?.n ?? 0}</dd>
          <dt>Cancellation policy</dt><dd>{p.cancellation_policy ? 'Added' : '—'}</dd>
        </dl>
        {missing.length > 0 && <div class="flash flash-err">Still missing: {missing.join(', ')}. You can publish later.</div>}
        <div class="wiz-nav">
          <a class="btn btn-outline" href={`/admin/properties/${p.id}/setup/6`}>← Previous</a>
          <span class="row">
            <button class="btn btn-outline" name="publish" value="0">Save as draft</button>
            <button class="btn btn-go" name="publish" value="1" disabled={missing.length > 0}>Confirm & Publish →</button>
          </span>
        </div>
      </form>
    </Shell>
  ))
}

const VIEWS = [step1, step2, step3, step4, step5, step6, step7]
const SAVES: ((c: Context<AppEnv>, p: PropertyRow) => Promise<{ err?: string; stay?: boolean } | { id: number }>)[] = [
  (c, p) => saveStep1(c, p), saveStep2, saveStep3, saveStep4, saveStep5, saveStep6,
  async (c, p) => {
    const f = await form(c)
    if (f.publish === '1') {
      await run(c.env, "UPDATE properties SET status = 'live', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", p.id)
      await logActivity(c.env, c.get('user')!.id, 'property.published', 'property', p.id, { via: 'wizard' })
      await afterPropertySave(c, p.id)
    }
    return {}
  },
]

wizardRoutes.get('/admin/properties/:id/setup/:step', requirePerm('manage_properties'), async (c) => {
  const p = await loadProperty(c)
  if (!p) return c.notFound()
  const step = Math.max(1, Math.min(7, int(c.req.param('step'), 1)))
  return VIEWS[step - 1](c, p)
})

wizardRoutes.post('/admin/properties/:id/setup/:step', requirePerm('manage_properties'), async (c) => {
  const p = await loadProperty(c)
  if (!p) return c.notFound()
  const step = Math.max(1, Math.min(7, int(c.req.param('step'), 1)))
  const r = await SAVES[step - 1](c, p)
  if ('err' in r && r.err) return redirectMsg(c, `/admin/properties/${p.id}/setup/${step}`, { err: r.err })
  if ('stay' in r && r.stay) return c.redirect(`/admin/properties/${p.id}/setup/${step}`, 303)
  if (step === 7) {
    const f = await form(c)
    return f.publish === '1' ? c.redirect(`/admin/properties/${p.id}/setup/7?done=1`, 303) : redirectMsg(c, '/admin/properties', { ok: `Saved “${p.name}” as a draft.` })
  }
  return c.redirect(`/admin/properties/${p.id}/setup/${step + 1}`, 303)
})

// "+ Add New …" from the wizard: add to a shared list and return the new item.
wizardRoutes.post('/admin/taxonomy/add', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  if (!(f.kind in KINDS)) return c.json({ error: 'Unknown list.' }, 400)
  const label = str(f.label, 60)
  if (!label) return c.json({ error: 'Enter a name.' }, 400)
  const key = await addItem(c.env, f.kind as Kind, label, str(f.icon, 8) || null)
  await logActivity(c.env, c.get('user')!.id, 'taxonomy.added', 'taxonomy', null, { kind: f.kind, label })
  return c.json({ key, label, icon: iconFor(key) })
})

// ---------- Categories, Facilities & Activities, Amenities, Room categories, Best for ----------
const LIST_TABS: [Kind, string][] = [['property_type', 'Categories'], ['theme', 'Best for'], ['facility', 'Facilities & Activities'], ['activity', 'Chargeable activities'], ['amenity', 'Room amenities'], ['room_category', 'Room category names']]

wizardRoutes.get('/admin/lists/:kind', requirePerm('manage_properties'), async (c) => {
  const kind = c.req.param('kind') as Kind
  if (!(kind in KINDS)) return c.notFound()
  const items = await allRows(c.env, kind)
  return page(c, { title: KINDS[kind].label, area: 'admin', active: kind === 'property_type' ? 'prop_cats' : 'prop_facilities' }, (
    <div class="stack-lg">
      <div class="wiz-top"><div class="wiz-title"><h1>▸ {LIST_TABS.find(([k]) => k === kind)?.[1]}</h1><nav class="crumbs small"><a href="/admin">Home</a> › <a href="/admin/properties">Properties</a> › <strong>Lists</strong></nav></div></div>
      <nav class="tabs">{LIST_TABS.map(([k, l]) => <a href={`/admin/lists/${k}`} class={k === kind ? 'active' : ''}>{l}</a>)}</nav>
      <section class="card stack">
        <form method="post" action={`/admin/lists/${kind}`} class="row wrap-row">
          <input name="label" required maxlength={60} placeholder="New item name" />
          {kind !== 'room_category' && kind !== 'property_type' && kind !== 'theme' && <input name="icon" maxlength={8} placeholder="Icon (emoji, optional)" class="w-md" />}
          <button class="btn">+ Add</button>
        </form>
        <p class="muted small">Items appear in the Add Property screens straight away. Built-in items can be hidden (properties that already use them keep them).</p>
        <div class="tiles">
          {items.map((it) => (
            <form method="post" action={`/admin/lists/${kind}/${encodeURIComponent(it.key)}`} class={`tile tile-admin ${it.hidden ? 'is-hidden' : ''}`}>
              {kind !== 'room_category' && kind !== 'property_type' && kind !== 'theme' && <span class="tile-ico">{iconFor(it.key)}</span>}
              <span class="grow">{it.label}{it.builtIn ? '' : ' ·  added'}</span>
              <button class="linklike small" name="action" value={it.hidden ? 'restore' : 'remove'}>{it.hidden ? 'Show' : it.builtIn ? 'Hide' : 'Delete'}</button>
            </form>
          ))}
        </div>
      </section>
    </div>
  ))
})

wizardRoutes.post('/admin/lists/:kind', requirePerm('manage_properties'), async (c) => {
  const kind = c.req.param('kind') as Kind
  if (!(kind in KINDS)) return c.notFound()
  const f = await form(c)
  if (str(f.label)) await addItem(c.env, kind, str(f.label, 60), str(f.icon, 8) || null)
  await logActivity(c.env, c.get('user')!.id, 'taxonomy.added', 'taxonomy', null, { kind, label: f.label })
  return redirectMsg(c, `/admin/lists/${kind}`, { ok: 'Added.' })
})

wizardRoutes.post('/admin/lists/:kind/:key', requirePerm('manage_properties'), async (c) => {
  const kind = c.req.param('kind') as Kind
  if (!(kind in KINDS)) return c.notFound()
  const key = decodeURIComponent(c.req.param('key'))
  const f = await form(c)
  if (f.action === 'restore') await restoreItem(c.env, kind, key)
  else await removeItem(c.env, kind, key)
  await logActivity(c.env, c.get('user')!.id, `taxonomy.${f.action === 'restore' ? 'restored' : 'removed'}`, 'taxonomy', null, { kind, key })
  return c.redirect(`/admin/lists/${kind}`, 303)
})

// ---------- Top-bar search: properties, bookings, guests, enquiries ----------
wizardRoutes.get('/admin/search', async (c) => {
  const u = c.get('user')
  if (!u || u.role === 'guest') return c.redirect('/login', 303)
  const q = str(c.req.query('q'), 80)
  const like = `%${q}%`
  const perms = await permissionsFor(c.env, u.role)
  const [props, bookings, guests, enquiries] = q ? await Promise.all([
    all<{ id: number; name: string; destination: string; status: string }>(c.env, 'SELECT id, name, destination, status FROM properties WHERE name LIKE ? OR destination LIKE ? ORDER BY name LIMIT 10', like, like),
    perms.manage_bookings ? all<{ id: number; code: string; guest_name: string; check_in: string }>(c.env, 'SELECT id, code, guest_name, check_in FROM bookings WHERE code LIKE ? OR guest_name LIKE ? OR guest_phone LIKE ? ORDER BY id DESC LIMIT 10', like, like, like) : Promise.resolve([]),
    perms.manage_enquiries ? all<{ id: number; name: string; phone: string | null }>(c.env, "SELECT id, name, phone FROM users WHERE role = 'guest' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) ORDER BY id DESC LIMIT 10", like, like, like) : Promise.resolve([]),
    perms.manage_enquiries ? all<{ id: number; code: string; guest_name: string; destination: string | null }>(c.env, 'SELECT id, code, guest_name, destination FROM enquiries WHERE code LIKE ? OR guest_name LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 10', like, like, like) : Promise.resolve([]),
  ]) : [[], [], [], []]
  const Group: FC<{ title: string; children?: Child; n: number }> = ({ title, n, children }) => (n ? <section class="card stack-sm"><h3>{title}</h3><ul class="plain-list">{children}</ul></section> : null)
  return page(c, { title: `Search: ${q}`, area: 'admin' }, (
    <div class="stack-lg">
      <h1>Search results for “{q}”</h1>
      {!props.length && !bookings.length && !guests.length && !enquiries.length && <p class="muted">Nothing found.</p>}
      <Group title="Properties" n={props.length}>{props.map((p) => <li><a href={`/admin/properties/${p.id}/setup/1`}>{p.name}</a> <span class="muted small">{p.destination} · {p.status}</span></li>)}</Group>
      <Group title="Bookings" n={bookings.length}>{bookings.map((b) => <li><a href={`/staff/bookings/${b.id}`}>{b.code}</a> <span class="muted small">{b.guest_name} · {b.check_in}</span></li>)}</Group>
      <Group title="Enquiries" n={enquiries.length}>{enquiries.map((e) => <li><a href={`/staff/enquiries/${e.id}`}>{e.code}</a> <span class="muted small">{e.guest_name}{e.destination ? ` · ${e.destination}` : ''}</span></li>)}</Group>
      <Group title="Customers" n={guests.length}>{guests.map((g) => <li><a href={`/staff/guests/${g.id}`}>{g.name || 'Guest'}</a> <span class="muted small">{g.phone ?? ''}</span></li>)}</Group>
    </div>
  ))
})
