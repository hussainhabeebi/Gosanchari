// Admin → property → Tariff: import a B2B rate sheet (PDF, Word or photos of the pages). AI reads it, management
// reviews every figure on one screen — rooms (rack / net / staff / guest, weekday & weekend), rate periods,
// supplements, extra-person and child charges, add-ons, contract basics, cancellation, contacts — and only then is
// anything saved.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, Field, Select } from '../views/components'
import { permissionsFor, requirePerm } from '../lib/auth'
import { all, first, insertId, logActivity, placeholders, run } from '../lib/db'
import { aiJsonFromDocuments, type DocInput } from '../lib/docs'
import { markup, matchRoom, normalizeRateSheet, rateSheetPrompt, regularNet, sheetKey, type RateSheet } from '../lib/ratesheet'
import { SEASON_KINDS } from '../lib/pricing'
import { MEAL_PLANS } from '../lib/search'
import { addons as readAddons, contact as readContact, type Addon } from '../lib/catalog'
import type { PropertyRow, RoomRow } from '../lib/types'
import { int, isDate, str } from '../lib/util'
import { form, redirectMsg } from './helpers'
import { afterPropertySave } from './admin-properties'

export const rateSheetRoutes = new Hono<AppEnv>()

async function perms(c: Context<AppEnv>) {
  return permissionsFor(c.env, c.get('user')!.role)
}

const DAY_OPTS: [number, string][] = [[4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]

rateSheetRoutes.post('/admin/properties/:id/ratesheet', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  if (!(await perms(c)).view_net_rates) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Only management can import B2B rate sheets.' })
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', id)
  if (!p) return c.notFound()
  const body = await c.req.parseBody({ all: true })
  const files = (Array.isArray(body.sheet) ? body.sheet : [body.sheet]).filter((f): f is File => f instanceof File && f.size > 0).slice(0, 10)
  if (!files.length) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: 'Please choose the rate sheet (PDF, Word or photos).' })
  const staffPct = Math.max(0, Math.min(300, parseFloat(String(body.staff_markup ?? '15')) || 0))
  const guestPct = Math.max(0, Math.min(500, parseFloat(String(body.guest_markup ?? '35')) || 0))
  const docs: DocInput[] = await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })))
  const res = await aiJsonFromDocuments<unknown>(c.env, 'rate_sheet', docs, (notes) => rateSheetPrompt(notes), { size: 'large', maxTokens: 6000 })
  if (!res.data) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: res.error ?? 'Could not read the rate sheet.' })
  const sheet = normalizeRateSheet(res.data)
  if (!sheet.rooms.length) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: 'No room rates were found in these files.' })
  await logActivity(c.env, c.get('user')!.id, 'ratesheet.read', 'property', id, { files: files.map((f) => f.name), rooms: sheet.rooms.length, seasons: sheet.seasons.length, supplements: sheet.supplements.length })
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? ORDER BY base_rate', id)
  return reviewPage(c, p, rooms, sheet, files.map((f) => f.name).join(', '), staffPct, guestPct, (await perms(c)).view_property_contacts)
})

const N = ({ name, value }: { name: string; value: number | null | undefined }) => <input type="number" name={name} value={value ?? ''} min="0" />

export function reviewPage(c: Context<AppEnv>, p: PropertyRow, rooms: RoomRow[], sheet: RateSheet, fileName: string, staffPct: number, guestPct: number, showContacts: boolean) {
  const mapOpts: [string, string][] = [['new', '+ Create as new room category'], ['skip', 'Skip'], ...rooms.map((r) => [String(r.id), `Update: ${r.name}`] as [string, string])]
  const idxOf = (name: string) => sheet.rooms.findIndex((r) => sheetKey(r.name) === sheetKey(name))
  const ex = sheet.extras
  return page(c, { title: `Review rate sheet · ${p.name}`, area: 'admin', active: 'properties' }, (
    <form method="post" action={`/admin/properties/${p.id}/ratesheet/apply`} class="stack-lg">
      <a href={`/admin/properties/${p.id}#tariff`} class="small">← {p.name}</a>
      <h1>Review rate sheet</h1>
      <AiNote label={`Read from ${fileName}`}>
        Check every figure before saving — nothing is saved yet. Staff rates are suggested as net + {staffPct}% and guest rates as net + {guestPct}%, rounded to ₹50; change any of them. Untick anything you don't want to save.
      </AiNote>

      <section class="card stack">
        <label class="check"><input type="checkbox" name="basics_on" value="1" checked /> <h2 class="inline-h">Contract basics</h2></label>
        <div class="row wrap-row">
          <Field label="Rates include"><Select name="meal_plan" value={(sheet.meal_plan.match(/\b(EP|CP|MAP|AP)\b/i)?.[1] ?? (/CPAI/i.test(sheet.meal_plan) ? 'CP' : '')).toUpperCase()} options={[['', '—'], ...Object.keys(MEAL_PLANS).map((k) => [k, `${k} – ${MEAL_PLANS[k]}`] as [string, string])]} /></Field>
          <Field label="Contract valid from"><input type="date" name="valid_from" value={sheet.valid_from ?? sheet.seasons[0]?.start_date ?? ''} /></Field>
          <Field label="Contract valid to"><input type="date" name="valid_to" value={sheet.valid_to ?? sheet.seasons.at(-1)?.end_date ?? ''} /></Field>
        </div>
        <Field label="Weekend nights">
          <div class="row wrap-row">{DAY_OPTS.map(([d, l]) => <label class="check"><input type="checkbox" name="weekend" value={d} checked={(sheet.weekend_nights ?? [5, 6]).includes(d)} /> {l}</label>)}</div>
        </Field>
        {sheet.meal_plan && <p class="muted small">Sheet says: “{sheet.meal_plan}”</p>}
        <Field label="Cancellation policy (replaces the property's)"><textarea name="cancellation" rows={3}>{sheet.cancellation_policy}</textarea></Field>
        <Field label="Other terms (saved as contract terms)"><textarea name="terms" rows={3}>{sheet.notes}</textarea></Field>
      </section>

      <section class="card stack">
        <h2>Room categories</h2>
        <input type="hidden" name="rooms_n" value={sheet.rooms.length} />
        <p class="muted small">Regular rates are taken from the first rate period when the sheet has no separate regular rate.</p>
        <div class="table-wrap">
          <table class="table review-table">
            <thead><tr><th>On the sheet</th><th>Save as</th><th>Rooms</th><th>Rack ₹</th><th class="internal">Net ₹ wkday</th><th class="internal">Net ₹ wkend</th><th>Staff ₹ wkday</th><th>Guest ₹ wkday</th><th>Guest ₹ wkend</th><th>Guests incl.</th><th>Max</th></tr></thead>
            <tbody>
              {sheet.rooms.map((r, i) => {
                const match = matchRoom(r.name, rooms)
                const reg = regularNet(sheet, r)
                return (
                  <tr>
                    <td><input name={`r${i}_name`} value={r.name} maxlength={80} />{r.notes && <div class="muted small">{r.notes}</div>}</td>
                    <td><Select name={`r${i}_map`} value={match ? String(match) : 'new'} options={mapOpts} /></td>
                    <td><N name={`r${i}_units`} value={r.units} /></td>
                    <td><N name={`r${i}_rack`} value={r.rack_rate} /></td>
                    <td class="internal"><N name={`r${i}_net`} value={reg?.weekday} /></td>
                    <td class="internal"><N name={`r${i}_wnet`} value={reg?.weekend} /></td>
                    <td><N name={`r${i}_staff`} value={markup(reg?.weekday, staffPct)} /></td>
                    <td><N name={`r${i}_guest`} value={markup(reg?.weekday, guestPct)} /></td>
                    <td><N name={`r${i}_wknd`} value={markup(reg?.weekend, guestPct)} /></td>
                    <td><N name={`r${i}_base`} value={r.base_guests ?? (/double/i.test(r.name + r.notes) ? 2 : null)} /></td>
                    <td><N name={`r${i}_cap`} value={r.capacity} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section class="card stack">
        <label class="check"><input type="checkbox" name="extras_on" value="1" checked={!!(ex.extra_adult || ex.child_with_bed || ex.child_no_bed)} /> <h2 class="inline-h">Extra person & child charges (all room categories)</h2></label>
        <div class="table-wrap">
          <table class="table review-table">
            <thead><tr><th>Charge per night</th><th class="internal">Net ₹</th><th>Guest ₹</th></tr></thead>
            <tbody>
              <tr><td>Extra adult / extra mattress</td><td class="internal"><N name="x_adult_net" value={ex.extra_adult} /></td><td><N name="x_adult" value={markup(ex.extra_adult, guestPct)} /></td></tr>
              <tr><td>Child with mattress</td><td class="internal"><N name="x_child_net" value={ex.child_with_bed} /></td><td><N name="x_child" value={markup(ex.child_with_bed, guestPct)} /></td></tr>
              <tr><td>Child without bed</td><td class="internal"><N name="x_nobed_net" value={ex.child_no_bed} /></td><td><N name="x_nobed" value={markup(ex.child_no_bed, guestPct)} /></td></tr>
            </tbody>
          </table>
        </div>
        <div class="row wrap-row">
          <Field label="Children free below age"><N name="child_free_below" value={ex.child_free_below} /></Field>
          <Field label="Child rate up to age"><N name="child_age_to" value={ex.child_age_to} /></Field>
        </div>
      </section>

      <section class="card stack">
        <h2>Rate periods & seasons</h2>
        <input type="hidden" name="seasons_n" value={sheet.seasons.length} />
        {sheet.seasons.length === 0 && <p class="muted">No dated rate periods found.</p>}
        {sheet.seasons.map((s, j) => (
          <div class="season-edit stack">
            <div class="row wrap-row">
              <label class="check"><input type="checkbox" name={`s${j}_on`} value="1" checked /> Save</label>
              <input name={`s${j}_name`} value={s.name} maxlength={60} aria-label="Name" />
              <Select name={`s${j}_kind`} value={s.kind} options={Object.entries(SEASON_KINDS)} />
              <input type="date" name={`s${j}_start`} value={s.start_date} aria-label="From" />
              <input type="date" name={`s${j}_end`} value={s.end_date} aria-label="To (last night)" />
              <input type="number" name={`s${j}_min`} value={s.min_nights ?? ''} min="1" placeholder="Min nights" class="w-sm" />
            </div>
            <div class="table-wrap">
              <table class="table review-table">
                <thead><tr><th>Room</th><th class="internal">Net wkday</th><th class="internal">Net wkend</th><th>Staff wkday</th><th>Staff wkend</th><th>Guest wkday</th><th>Guest wkend</th></tr></thead>
                <tbody>
                  {Object.entries(s.rates).map(([name, rate]) => {
                    const i = idxOf(name)
                    if (i < 0) return null
                    return (
                      <tr>
                        <td>{name}</td>
                        <td class="internal"><N name={`s${j}_r${i}_net`} value={rate.weekday} /></td>
                        <td class="internal"><N name={`s${j}_r${i}_wnet`} value={rate.weekend} /></td>
                        <td><N name={`s${j}_r${i}_staff`} value={markup(rate.weekday, staffPct)} /></td>
                        <td><N name={`s${j}_r${i}_wstaff`} value={markup(rate.weekend, staffPct)} /></td>
                        <td><N name={`s${j}_r${i}_guest`} value={markup(rate.weekday, guestPct)} /></td>
                        <td><N name={`s${j}_r${i}_wguest`} value={markup(rate.weekend, guestPct)} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section class="card stack">
        <h2>Supplements (added on top of the rate)</h2>
        <input type="hidden" name="sups_n" value={sheet.supplements.length} />
        {sheet.supplements.length === 0 && <p class="muted">No supplements found.</p>}
        {sheet.supplements.map((s, k) => (
          <div class="row wrap-row season-edit">
            <label class="check"><input type="checkbox" name={`p${k}_on`} value="1" checked /> Save</label>
            <input name={`p${k}_name`} value={s.name} maxlength={60} aria-label="Name" />
            <Select name={`p${k}_kind`} value={s.kind} options={Object.entries(SEASON_KINDS)} />
            <input type="date" name={`p${k}_start`} value={s.start_date} aria-label="From" />
            <input type="date" name={`p${k}_end`} value={s.end_date} aria-label="To (last night)" />
            <label class="small internal">Net ₹/room/night <input type="number" name={`p${k}_net`} value={s.amount} min="0" class="w-md" /></label>
            <label class="small">Guest ₹/room/night <input type="number" name={`p${k}_guest`} value={markup(s.amount, guestPct) ?? ''} min="0" class="w-md" /></label>
          </div>
        ))}
      </section>

      <section class="card stack">
        <h2>Add-ons</h2>
        <input type="hidden" name="addons_n" value={sheet.addons.length} />
        {sheet.addons.length === 0 && <p class="muted">No add-ons found.</p>}
        {sheet.addons.length > 0 && (
          <div class="table-wrap">
            <table class="table review-table">
              <thead><tr><th>Save</th><th>Add-on</th><th class="internal">Net ₹</th><th>Guest ₹</th><th>Per</th></tr></thead>
              <tbody>
                {sheet.addons.map((a, k) => (
                  <tr>
                    <td><input type="checkbox" name={`a${k}_on`} value="1" checked /></td>
                    <td><input name={`a${k}_name`} value={a.name} maxlength={80} /></td>
                    <td class="internal"><N name={`a${k}_net`} value={a.net} /></td>
                    <td><N name={`a${k}_guest`} value={markup(a.net, guestPct)} /></td>
                    <td><Select name={`a${k}_per`} value={a.per} options={[['stay', 'per stay'], ['night', 'per night'], ['person', 'per person']]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="muted small">Add-ons with the same name replace the existing ones; others are kept.</p>
      </section>

      {showContacts && sheet.contacts.length > 0 && (
        <section class="card stack internal">
          <label class="check"><input type="checkbox" name="contacts_on" value="1" checked /> <h2 class="inline-h">Resort contacts (private)</h2></label>
          <textarea name="contacts" rows={Math.min(8, sheet.contacts.length + 1)}>{sheet.contacts.map((x) => [x.name, x.role, x.phone, x.email].filter(Boolean).join(' – ')).join('\n')}</textarea>
          <p class="muted small">Added to “More contacts” in the property's contact details.</p>
        </section>
      )}

      <div class="row wrap-row sticky-actions">
        <button class="btn">Save these rates</button>
        <a class="btn btn-outline" href={`/admin/properties/${p.id}#tariff`}>Cancel</a>
      </div>
    </form>
  ))
}

rateSheetRoutes.post('/admin/properties/:id/ratesheet/apply', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  const pm = await perms(c)
  if (!pm.view_net_rates) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Only management can import B2B rate sheets.' })
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', id)
  if (!p) return c.notFound()
  const f = await form(c)
  const u = c.get('user')!
  const pos = (k: string) => (int(f[k]) > 0 ? int(f[k]) : null)
  const zeroOk = (k: string) => (f[k] === '' || f[k] == null ? null : Math.max(0, int(f[k])))
  const done: string[] = []

  // Contract basics, child ages, add-ons, contacts → property
  const prop: Record<string, string | number | null> = {}
  if (f.basics_on) {
    if (f.meal_plan in MEAL_PLANS) prop.rate_meal_plan = f.meal_plan
    if (isDate(f.valid_from)) prop.b2b_valid_from = f.valid_from
    if (isDate(f.valid_to)) prop.b2b_valid_to = f.valid_to
    const wk = [...new Set((f.__all.weekend ?? []).map((x) => parseInt(x, 10)).filter((d) => d >= 0 && d <= 6))]
    if (wk.length) prop.weekend_nights = wk.join(',')
    if (str(f.cancellation)) prop.cancellation_policy = str(f.cancellation, 2000)
    if (str(f.terms)) prop.b2b_terms = str(f.terms, 4000)
    done.push('contract basics')
  }
  if (f.extras_on) {
    const fb = zeroOk('child_free_below'), ct = zeroOk('child_age_to')
    if (fb != null) prop.child_free_below = Math.min(17, fb)
    if (ct != null) prop.child_age_to = Math.min(17, ct)
  }
  const addons: Addon[] = readAddons(p.addons)
  let addonCount = 0
  for (let k = 0; k < Math.min(30, int(f.addons_n)); k++) {
    if (!f[`a${k}_on`]) continue
    const name = str(f[`a${k}_name`], 80)
    const price = pos(`a${k}_guest`)
    if (!name || !price) continue
    const per = (['night', 'person'].includes(f[`a${k}_per`]) ? f[`a${k}_per`] : 'stay') as Addon['per']
    const item: Addon = { name, price, net: pos(`a${k}_net`), per }
    const at = addons.findIndex((a) => a.name.toLowerCase() === name.toLowerCase())
    if (at >= 0) addons[at] = item
    else addons.push(item)
    addonCount++
  }
  if (addonCount) { prop.addons = JSON.stringify(addons.slice(0, 40)); done.push(`${addonCount} add-on${addonCount > 1 ? 's' : ''}`) }
  if (pm.view_property_contacts && f.contacts_on && str(f.contacts)) {
    const con = readContact(p.contact)
    const lines = new Set([...(con.others ?? '').split('\n'), ...str(f.contacts, 2000).split('\n')].map((x) => x.trim()).filter(Boolean))
    prop.contact = JSON.stringify({ ...con, others: [...lines].join('\n').slice(0, 2000) })
    done.push('contacts')
  }
  const cols = Object.keys(prop)
  if (cols.length) await run(c.env, `UPDATE properties SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, ...Object.values(prop), id)

  // Rooms
  const existing = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ?', id)
  const roomIdx = new Map<number, number>()
  let created = 0
  let updated = 0
  const extras: Record<string, number | null> = f.extras_on ? {
    extra_adult_rate: pos('x_adult'), net_extra_adult_rate: pos('x_adult_net'), extra_child_rate: zeroOk('x_child'), net_extra_child_rate: zeroOk('x_child_net'),
    child_no_bed_rate: zeroOk('x_nobed'), net_child_no_bed_rate: zeroOk('x_nobed_net'),
  } : {}
  for (const k of Object.keys(extras)) if (extras[k] == null) delete extras[k]
  for (let i = 0; i < Math.min(30, int(f.rooms_n)); i++) {
    const map = f[`r${i}_map`]
    if (!map || map === 'skip') continue
    const set: Record<string, number | null> = { ...extras }
    const put = (col: string, v: number | null) => { if (v) set[col] = v }
    put('units', pos(`r${i}_units`)); put('rack_rate', pos(`r${i}_rack`)); put('net_rate', pos(`r${i}_net`)); put('staff_rate', pos(`r${i}_staff`))
    put('base_rate', pos(`r${i}_guest`)); put('weekend_rate', pos(`r${i}_wknd`))
    const base = pos(`r${i}_base`), cap = pos(`r${i}_cap`)
    if (base) set.base_guests = base
    if (cap || base) set.capacity = Math.max(cap ?? 0, base ?? 0) || null
    if (set.extra_adult_rate) { set.extra_bed = 1; set.extra_bed_rate = set.extra_adult_rate }
    if (set.capacity == null) delete set.capacity
    if (map === 'new') {
      const name = str(f[`r${i}_name`], 80)
      if (!name || !set.base_rate) continue
      if (!set.capacity) set.capacity = Math.max(2, (base ?? 2) + (set.extra_adult_rate ? 1 : 0))
      const cols2 = Object.keys(set)
      roomIdx.set(i, await insertId(c.env, `INSERT INTO rooms (property_id, name, ${cols2.join(', ')}) VALUES (?, ?, ${placeholders(cols2.length)})`, id, name, ...Object.values(set)))
      created++
    } else {
      const r = existing.find((x) => x.id === int(map))
      if (!r) continue
      const cols2 = Object.keys(set)
      if (cols2.length) {
        await run(c.env, `UPDATE rooms SET ${cols2.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), r.id)
        await logActivity(c.env, u.id, 'price.changed', 'room', r.id, { from: { guest: r.base_rate, weekend: r.weekend_rate, staff: r.staff_rate, net: r.net_rate }, to: set, source: 'rate sheet' })
        updated++
      }
      roomIdx.set(i, r.id)
    }
  }
  if (created || updated) done.push(`${created} new and ${updated} updated room categor${created + updated === 1 ? 'y' : 'ies'}`)

  // Rate periods and supplements → season_rates (replacing same name + dates for these rooms)
  const ins = 'INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, min_nights, created_by, kind, staff_rate, net_rate, weekend_rate, staff_weekend_rate, net_weekend_rate, supplement, net_supplement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  const stmts: D1PreparedStatement[] = []
  const ids = [...roomIdx.values()]
  const clear = (name: string, start: string, end: string) => ids.length && stmts.push(c.env.DB.prepare(`DELETE FROM season_rates WHERE property_id = ? AND name = ? AND start_date = ? AND end_date = ? AND room_id IN (${placeholders(ids.length)})`).bind(id, name, start, end, ...ids))
  let periods = 0
  for (let j = 0; j < Math.min(30, int(f.seasons_n)); j++) {
    if (!f[`s${j}_on`]) continue
    const name = str(f[`s${j}_name`], 60), start = f[`s${j}_start`], end = f[`s${j}_end`]
    if (!name || !isDate(start) || !isDate(end) || end < start) continue
    const kind = f[`s${j}_kind`] in SEASON_KINDS ? f[`s${j}_kind`] : 'season'
    const rows = [...roomIdx].filter(([i]) => pos(`s${j}_r${i}_guest`))
    if (!rows.length) continue
    clear(name, start, end)
    for (const [i, rid] of rows) {
      stmts.push(c.env.DB.prepare(ins).bind(id, rid, name, start, end, pos(`s${j}_r${i}_guest`), pos(`s${j}_min`), u.id, kind, pos(`s${j}_r${i}_staff`), pos(`s${j}_r${i}_net`), pos(`s${j}_r${i}_wguest`), pos(`s${j}_r${i}_wstaff`), pos(`s${j}_r${i}_wnet`), null, null))
    }
    periods++
  }
  let sups = 0
  for (let k = 0; k < Math.min(20, int(f.sups_n)); k++) {
    if (!f[`p${k}_on`]) continue
    const name = str(f[`p${k}_name`], 60), start = f[`p${k}_start`], end = f[`p${k}_end`]
    const guest = pos(`p${k}_guest`)
    if (!name || !guest || !isDate(start) || !isDate(end) || end < start || !ids.length) continue
    const kind = f[`p${k}_kind`] in SEASON_KINDS ? f[`p${k}_kind`] : 'special'
    clear(name, start, end)
    for (const rid of ids) stmts.push(c.env.DB.prepare(ins).bind(id, rid, name, start, end, null, null, u.id, kind, null, null, null, null, null, guest, pos(`p${k}_net`)))
    sups++
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  if (periods) done.push(`${periods} rate period${periods > 1 ? 's' : ''}`)
  if (sups) done.push(`${sups} supplement${sups > 1 ? 's' : ''}`)
  await afterPropertySave(c, id)
  await logActivity(c.env, u.id, 'ratesheet.applied', 'property', id, { created, updated, periods, sups, addons: addonCount })
  return redirectMsg(c, `/admin/properties/${id}#tariff`, { ok: done.length ? `Rate sheet saved: ${done.join(', ')}.` : 'Nothing was selected to save.' })
})
