// Staff pages 22–27: property finder, quotation builder, quotations list, bookings, booking detail, availability calendar.

import { Hono, type Context } from 'hono'
import { quotationPdf, quotationPdfFilename, type PdfQuoteOption } from '../lib/quotation-pdf'
import { HTTPException } from 'hono/http-exception'
import { addons as readAddons, ADDON_PER, chosenAddons, contact as readContact, extrasLabel, guestsText, STAY_TYPES, stayTypeLabel, type ChosenAddon } from '../lib/catalog'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, Empty, Field, Pager, Pill, Select, Table, Tabs } from '../views/components'
import { permissionsFor, requirePerm, requireStaff } from '../lib/auth'
import { all, enqueue, first, insertId, loadPricing, logActivity, monthOccupancy, placeholders, roomAvailability, run } from '../lib/db'
import { searchProperties, destinations } from '../lib/properties'
import { filtersFromQuery } from '../lib/search'
import { gstLabel, quotationInclusions, quotationPrice } from '../lib/quotation-pricing'
import { calculatePrice, netRateForStay, occupancy, staffRateForStay, weekendLabel } from '../lib/pricing'
import { quoteFillFromEnquiry, quoteMessageDraft } from '../lib/assist'
import { cancelBooking, confirmBooking, createBooking, PAYMENT_METHODS, priceStay, recordPayment, storeInvoice } from '../lib/bookings'
import { fillTemplate, mediaUrl, sendEmail, sendWhatsApp } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import { MEAL_PLANS, PROPERTY_TYPES } from '../lib/search'
import type { BookingRow, EnquiryRow, PropertyRow, QuotationRow, QuoteOptionRow, RoomRow } from '../lib/types'
import { addDays, eachNight, fmtDate, fmtDateTime, fmtShortDate, int, isDate, money, nightsBetween, normalizePhone, nowIso, parseJson, randomToken, refCode, str, todayIST } from '../lib/util'
import { form, pageNum, redirectMsg } from './helpers'
import { canSeeEnquiry } from './staff'

export const opsRoutes = new Hono<AppEnv>()
opsRoutes.use('/staff/*', requireStaff)

// ---------- 22. Property finder ----------
opsRoutes.get('/staff/finder', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const q = c.req.queries()
  const flat: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(q)) flat[k] = v.length > 1 ? v : v[0]
  // Staff Finder no longer supports a maximum-price filter, including old URLs.
  delete flat.priceMax
  const f = filtersFromQuery(flat)
  f.sort ??= 'price_asc'
  const enquiryId = int(c.req.query('enquiry')) || null
  const quoteId = int(c.req.query('quote')) || null
  const invalidDates = !!(c.req.query('checkIn') && c.req.query('checkOut') && (!f.checkIn || !f.checkOut))
  const results = invalidDates ? [] : await searchProperties(c.env, f, 100, true)
  const ids = results.map((r) => r.id)
  const [internal, rooms, dests] = await Promise.all([
    ids.length ? all<Pick<PropertyRow, 'id' | 'owner_name' | 'owner_phone' | 'commission_pct' | 'internal_notes' | 'last_minute_note' | 'is_partner' | 'contact'>>(c.env, `SELECT id, owner_name, owner_phone, commission_pct, internal_notes, last_minute_note, is_partner, contact FROM properties WHERE id IN (${placeholders(ids.length)})`, ...ids) : Promise.resolve([]),
    ids.length ? all<RoomRow>(c.env, `SELECT * FROM rooms WHERE active = 1 AND property_id IN (${placeholders(ids.length)}) ORDER BY base_rate`, ...ids) : Promise.resolve([]),
    destinations(c.env),
  ])
  const resolved = new Map<number, { staff: number | null; direct: number | null; net: number | null }>()
  for (const room of rooms) {
    const pricing = await loadPricing(c.env, room.id)
    if (pricing && f.checkIn && f.checkOut) {
      const direct = calculatePrice({ room: pricing.room, seasons: pricing.seasons, checkIn: f.checkIn, checkOut: f.checkOut })
      resolved.set(room.id, { staff: staffRateForStay(pricing.room, pricing.seasons, f.checkIn, f.checkOut), direct: direct.errors.length ? null : Math.round(direct.subtotal / direct.nights), net: perms.view_net_rates ? netRateForStay(pricing.room, pricing.seasons, f.checkIn, f.checkOut) : null })
    } else resolved.set(room.id, { staff: room.staff_rate, direct: room.base_rate > 0 ? room.base_rate : null, net: perms.view_net_rates ? room.net_rate : null })
  }
  const avail = f.checkIn && f.checkOut ? await roomAvailability(c.env, ids, f.checkIn, f.checkOut) : null
  const info = new Map(internal.map((i) => [i.id, i]))
  const addHref = (pid: number, rid: number) => {
    const p = new URLSearchParams({ property: String(pid), room: String(rid) })
    if (enquiryId) p.set('enquiry', String(enquiryId))
    if (f.checkIn) p.set('checkIn', f.checkIn)
    if (f.checkOut) p.set('checkOut', f.checkOut)
    if (f.guests) p.set('guests', String(f.guests))
    return quoteId ? `/staff/quotes/${quoteId}/options?${p}` : `/staff/quotes/new?${p}`
  }
  return page(c, { title: 'Property finder', area: 'staff', active: 'finder' }, (
    <div class="stack-lg">
      <h1>Property finder</h1>
      {(enquiryId || quoteId) && <p class="flash">Adding to {quoteId ? `quotation #${quoteId}` : `a new quotation for enquiry #${enquiryId}`}.</p>}
      {invalidDates && <p class="flash flash-err" role="alert">Check-out must be after check-in, with valid dates.</p>}
      <form method="get" action="/staff/finder" class="card staff-finder-filters">
        {enquiryId && <input type="hidden" name="enquiry" value={enquiryId} />}
        {quoteId && <input type="hidden" name="quote" value={quoteId} />}
        <Field label="Destination"><Select name="destination" value={f.destination} options={[['', 'Any destination'], ...dests.map((d) => [d, d] as [string, string])]} /></Field>
        <Field label="Check-in"><input type="date" name="checkIn" value={f.checkIn ?? ''} /></Field>
        <Field label="Check-out"><input type="date" name="checkOut" value={f.checkOut ?? ''} /></Field>
        <Field label="Guests"><input type="number" name="guests" value={f.guests ?? ''} placeholder="Guests" min="1" /></Field>
        <Field label="Property Type"><Select name="type" value={f.types?.[0]} options={[['', 'Any type'], ...PROPERTY_TYPES.map((t) => [t, STAY_TYPES[t]] as [string, string])]} /></Field>
        <Field label="Feel / Preferences"><input name="q" value={f.q ?? ''} placeholder="quiet, lake view, kids…" /></Field>
        <Field label="Sort By"><Select name="sort" value={f.sort} options={[['price_asc', 'Price ↑'], ['price_desc', 'Price ↓'], ['rating', 'Rating'], ['recommended', 'Best match']]} /></Field>
        <button class="btn btn-sm">Search</button>
      </form>
      <form method="get" action="/staff/finder/compare" id="compare-form">
        <div class="row-between"><span class="muted">{results.length} properties{avail ? ' with free rooms' : ''}</span><button class="btn btn-sm btn-outline">Compare selected (max 3)</button></div>
        {results.length === 0 && <Empty>No matches. Loosen the filters or check other dates.</Empty>}
        {results.map((p) => {
          const i = info.get(p.id)
          const prs = rooms.filter((r) => r.property_id === p.id)
          return (
            <div class="card finder-row">
              <label class="check compare-check"><input type="checkbox" name="ids" value={p.id} data-max="3" /> Compare</label>
              <img src={mediaUrl(p.photo, 240)} alt="" />
              <div class="grow">
                <div class="row-between"><a href={`/stay/${p.slug}`} target="_blank"><strong>{p.name}</strong></a><span>★ {p.rating_avg.toFixed(1)} · {p.type} · {p.destination}</span></div>
                {i?.last_minute_note && <div class="small ok">⚡ {i.last_minute_note}</div>}
                {(perms.view_net_rates || perms.view_property_contacts) && i && (
                  <div class="small internal">
                    {perms.view_net_rates && <>{i.is_partner ? `Partner, commission ${i.commission_pct}%` : 'Own property'}</>}
                    {perms.view_property_contacts && (() => {
                      const k = readContact(i.contact)
                      const phones = [k.phone, k.phone2, k.phone3].filter(Boolean) as string[]
                      return <>{k.person && ` · Contact: ${k.person}`}{phones.map((ph) => <> · <a href={`tel:${ph}`}>{ph}</a></>)}{[k.email, k.email2].filter(Boolean).map((em) => <> · <a href={`mailto:${em}`}>{em}</a></>)}</>
                    })()}
                    {perms.view_net_rates && i.internal_notes ? <div>Remarks: {i.internal_notes}</div> : null}
                  </div>
                )}
                <Table head={['Room', 'Guests', 'Staff rate', 'Guest rate', ...(perms.view_net_rates ? ['B2B / Net'] : []), ...(avail ? ['Free'] : []), '']}>
                  {prs.map((r) => (
                    <tr>
                      <td><a href={`/staff/rooms/${p.id}${enquiryId ? `?enquiry=${enquiryId}` : ''}#room-${r.id}`}>{r.name}</a></td><td class="small">{guestsText(r)}</td><td class="internal">{(resolved.get(r.id)?.staff ?? 0) > 0 ? money(resolved.get(r.id)!.staff!) : 'Not supplied'}</td><td>{(resolved.get(r.id)?.direct ?? 0) > 0 ? money(resolved.get(r.id)!.direct!) : 'Personalised offer / enquire'}</td>
                      {perms.view_net_rates && <td>{(resolved.get(r.id)?.net ?? 0) > 0 ? money(resolved.get(r.id)!.net!) : 'Not supplied'}</td>}
                      {avail && <td>{avail.get(r.id)?.free ?? 0} / {r.units}</td>}
                      <td><a class="btn btn-sm" href={addHref(p.id, r.id)}>Add to quotation</a></td>
                    </tr>
                  ))}
                </Table>
              </div>
            </div>
          )
        })}
      </form>
    </div>
  ))
})

opsRoutes.get('/staff/finder/compare', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const ids = c.req.queries('ids')?.map(Number).filter(Boolean).slice(0, 3) ?? []
  if (!ids.length) return redirectMsg(c, '/staff/finder', { err: 'Select up to 3 properties to compare.' })
  const props = await all<PropertyRow>(c.env, `SELECT * FROM properties WHERE id IN (${placeholders(ids.length)})`, ...ids)
  const rooms = await all<RoomRow>(c.env, `SELECT * FROM rooms WHERE active = 1 AND property_id IN (${placeholders(ids.length)}) ORDER BY base_rate`, ...ids)
  const rows: [string, (p: PropertyRow) => unknown][] = [
    ['Type', (p) => stayTypeLabel(p)], ['Destination', (p) => p.destination], ['Rating', (p) => `★ ${p.rating_avg.toFixed(1)} (${p.rating_count})`],
    ['From', (p) => money(Math.min(...rooms.filter((r) => r.property_id === p.id).map((r) => r.base_rate)))],
    ['Rooms', (p) => rooms.filter((r) => r.property_id === p.id).map((r) => `${r.name} (${r.capacity})`).join(', ')],
    ['Facilities', (p) => parseJson<string[]>(p.facilities, []).join(', ')],
    ['Meals', (p) => parseJson<string[]>(p.meal_plans, []).map((m) => MEAL_PLANS[m] ?? m).join(', ')],
    ['Check-in / out', (p) => `${p.checkin_time} / ${p.checkout_time}`],
    ['Family / pets', (p) => `${p.family_friendly ? 'Family ✓' : '—'} · ${p.pet_friendly ? 'Pets ✓' : 'No pets'}`],
    ['Cancellation', (p) => p.cancellation_policy],
    ...(perms.view_net_rates ? ([['Commission', (p: PropertyRow) => (p.is_partner ? `${p.commission_pct}%` : 'Own')], ['Internal notes', (p: PropertyRow) => p.internal_notes]] as [string, (p: PropertyRow) => unknown][]) : []),
  ]
  return page(c, { title: 'Compare properties', area: 'staff', active: 'finder' }, (
    <div class="stack-lg">
      <a href="/staff/finder" class="small">← Property finder</a>
      <h1>Compare</h1>
      <Table head={['', ...props.map((p) => p.name)]} class="compare">
        {rows.map(([label, fn]) => <tr><th>{label}</th>{props.map((p) => <td>{String(fn(p) ?? '')}</td>)}</tr>)}
      </Table>
    </div>
  ))
})

// ---------- 23. Quotation builder ----------
async function loadQuoteFor(c: Context<AppEnv>, id: number) {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const q = await first<QuotationRow>(c.env, 'SELECT * FROM quotations WHERE id = ?', id)
  if (!q) return null
  if (!perms.view_all_enquiries && q.staff_id !== u.id && q.staff_id != null) return null
  return q
}

async function priceOption(c: Context<AppEnv>, o: { room_id: number; check_in: string; check_out: string; rooms_count: number; discount_pct: number; discount?: number; extra_charges: number; guest_rate?: number | null; adults?: number; children?: number; meal_plan?: string | null; apply_gst?: number }) {
  const pr = await loadPricing(c.env, o.room_id)
  if (!pr) return null
  const s = await getSettings(c.env)
  // A staff-entered base tariff replaces seasonal base rates; flat peak supplements still apply.
  // Staff decides the child amount from the property's policy; children still count toward capacity.
  const room = { ...pr.room, ...(o.guest_rate ? { base_rate: o.guest_rate, weekend_rate: o.guest_rate } : {}), extra_child_rate: 0 }
  const seasons = o.guest_rate ? pr.seasons.filter(s => s.supplement != null && !(s.rate && s.rate > 0) && s.pct_adjust == null) : pr.seasons
  const base = calculatePrice({ room, seasons, checkIn: o.check_in, checkOut: o.check_out, roomsCount: o.rooms_count, mealPlan: o.meal_plan })
  return quotationPrice({ room, seasons, staffRoom: pr.room, staffSeasons: pr.seasons, checkIn: o.check_in, checkOut: o.check_out, roomsCount: o.rooms_count, taxSlabs: s.tax_slabs, discountAmount: o.discount ?? Math.round(base.roomCharges * o.discount_pct / 100), applyGst: o.apply_gst !== 0, extraCharges: o.extra_charges, adults: o.adults ?? 2, children: o.children ?? 0, mealPlan: o.meal_plan })
}

/** Staff rate benchmark for an option's room and dates (season staff rates apply). */
async function optionStaffRate(c: Context<AppEnv>, o: Pick<QuoteOptionRow, 'room_id' | 'check_in' | 'check_out' | 'meal_plan'>) {
  const pr = await loadPricing(c.env, o.room_id)
  return pr ? staffRateForStay(pr.room, pr.seasons, o.check_in, o.check_out, o.meal_plan) : null
}

/** Per-night price the guest actually pays for the room (after discount, before extras and GST). */
function effectiveNightly(o: Pick<QuoteOptionRow, 'subtotal' | 'discount' | 'check_in' | 'check_out' | 'rooms_count'>) {
  const n = Math.max(1, nightsBetween(o.check_in, o.check_out)) * Math.max(1, o.rooms_count)
  return Math.round((o.subtotal - o.discount) / n)
}

async function addOption(c: Context<AppEnv>, quoteId: number, propertyId: number, roomId: number | null, checkIn: string | null, checkOut: string | null, adults: number, children: number) {
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', propertyId)
  const room = rooms.find((r) => r.id === roomId) ?? rooms.find((r) => r.capacity >= adults + children) ?? rooms[0]
  if (!room) return
  const ci = checkIn && isDate(checkIn) ? checkIn : addDays(todayIST(), 14)
  const co = checkOut && isDate(checkOut) && checkOut > ci ? checkOut : addDays(ci, 2)
  const roomsCount = Math.max(1, Math.ceil((adults + children) / room.capacity))
  const quote = await first<QuotationRow>(c.env, 'SELECT * FROM quotations WHERE id = ?', quoteId)
  const meals = parseJson<string[]>((await first<{ meal_plans: string }>(c.env, 'SELECT meal_plans FROM properties WHERE id = ?', propertyId))?.meal_plans, [])
  const p = await priceOption(c, { apply_gst: quote?.apply_gst, meal_plan: meals[0] ?? null, room_id: room.id, check_in: ci, check_out: co, rooms_count: roomsCount, discount_pct: 0, extra_charges: 0, adults, children })
  if (!p || p.errors.length) throw new HTTPException(303, { res: redirectMsg(c, `/staff/quotes/${quoteId}`, { err: p?.errors[0] ?? 'Room rate could not be resolved.' }) })
  await run(
    c.env,
    'INSERT INTO quotation_options (quotation_id, property_id, room_id, check_in, check_out, adults, children, rooms_count, meal_plan, subtotal, discount, taxes, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    quoteId, propertyId, room.id, ci, co, adults, children, roomsCount, meals[0] ?? null, p?.subtotal ?? 0, p?.discount ?? 0, p?.taxes ?? 0, p?.total ?? 0,
  )
}

// Create a quote (from the enquiry workspace, finder or directly).
async function createQuote(c: Context<AppEnv>) {
  const u = c.get('user')!
  const s = await getSettings(c.env)
  const enquiryId = int(c.req.query('enquiry')) || null
  const e = enquiryId ? await first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', enquiryId) : null
  if (e && !canSeeEnquiry(u, await permissionsFor(c.env, u.role), e)) return c.notFound()
  const id = await insertId(
    c.env,
    `INSERT INTO quotations (code, token, enquiry_id, user_id, staff_id, guest_name, phone, email, valid_till, inclusions, payment_terms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    refCode('QT'), randomToken(18), e?.id ?? null, e?.user_id ?? null, u.id, e?.guest_name ?? 'Guest', e?.phone ?? null, e?.email ?? null,
    addDays(todayIST(), s.booking.quote_validity_days), 'Accommodation as per room type', 'Payment by UPI or bank transfer to confirm. Our team will share the details.',
  )
  const pid = int(c.req.query('property'))
  if (pid) await addOption(c, id, pid, int(c.req.query('room')) || null, c.req.query('checkIn') ?? e?.check_in ?? null, c.req.query('checkOut') ?? e?.check_out ?? null, e?.adults ?? Math.max(1, int(c.req.query('guests'), 2)), e?.children ?? 0)
  await logActivity(c.env, u.id, 'quote.created', 'quotation', id, { enquiryId })
  return c.redirect(`/staff/quotes/${id}`, 303)
}
opsRoutes.post('/staff/quotes/new', requirePerm('manage_quotes'), createQuote)
opsRoutes.get('/staff/quotes/new', requirePerm('manage_quotes'), createQuote)

opsRoutes.get('/staff/quotes/:id/options', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q || !['draft', 'pending_approval', 'changes_requested'].includes(q.status)) return redirectMsg(c, '/staff/quotes', { err: 'Only draft quotes can be changed.' })
  const e = q.enquiry_id ? await first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', q.enquiry_id) : null
  await addOption(c, q.id, int(c.req.query('property')), int(c.req.query('room')) || null, c.req.query('checkIn') ?? e?.check_in ?? null, c.req.query('checkOut') ?? e?.check_out ?? null, e?.adults ?? Math.max(1, int(c.req.query('guests'), 2)), e?.children ?? 0)
  return c.redirect(`/staff/quotes/${q.id}`, 303)
})

opsRoutes.get('/staff/quotes/:id', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const [options, props, enquiry] = await Promise.all([
    all<QuoteOptionRow & { property_name: string; room_name: string; net_rate: number | null; staff_rate: number | null; base_rate: number; weekend_rate: number | null; meal_plans: string; property_addons: string; child_free_below: number | null; child_age_to: number | null }>(
      c.env,
      'SELECT o.*, p.name AS property_name, p.meal_plans, p.addons AS property_addons, p.child_free_below, p.child_age_to, r.name AS room_name, r.net_rate, r.staff_rate, r.base_rate, r.weekend_rate FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE o.quotation_id = ? ORDER BY o.id',
      q.id,
    ),
    all<{ id: number; name: string; destination: string }>(c.env, "SELECT id, name, destination FROM properties WHERE status = 'live' ORDER BY destination, name"),
    q.enquiry_id ? first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', q.enquiry_id) : Promise.resolve(null),
  ])
  const netStay = new Map<number, number | null>()
  for (const o of options) {
    o.staff_rate = await optionStaffRate(c, o)
    if (perms.view_net_rates) {
      const pr = await loadPricing(c.env, o.room_id)
      netStay.set(o.id, pr ? netRateForStay(pr.room, pr.seasons, o.check_in, o.check_out, o.meal_plan) : null)
    }
  }
  const weekendOf = new Map((await all<{ id: number; weekend_nights: string }>(c.env, `SELECT id, weekend_nights FROM properties WHERE id IN (${placeholders(Math.max(1, options.length))})`, ...(options.length ? options.map((o) => o.property_id) : [0]))).map((x) => [x.id, x.weekend_nights]))
  const allRooms = options.length ? await all<RoomRow>(c.env, `SELECT * FROM rooms WHERE active = 1 AND property_id IN (${placeholders(options.length)})`, ...options.map((o) => o.property_id)) : []
  const editable = ['draft', 'pending_approval', 'changes_requested'].includes(q.status)
  const resolvedPrices = new Map<number, Awaited<ReturnType<typeof priceOption>>>()
  for (const o of options) resolvedPrices.set(o.id, await priceOption(c, { ...o, apply_gst: q.apply_gst }))
  const needsApproval = options.some(o => resolvedPrices.get(o.id)?.errors.length)
  const link = `${c.env.SITE_URL}/q/${q.token}`
  return page(c, { title: `Quotation ${q.code}`, area: 'staff', active: 'quotes' }, (
    <div class="stack-lg">
      <div class="row-between">
        <div><a href="/staff/quotes" class="small">← Quotations</a><h1>Quotation {q.code} <Pill s={q.status} /></h1>{enquiry && <a class="small" href={`/staff/enquiries/${enquiry.id}`}>Enquiry {enquiry.code} · {enquiry.summary ?? ''}</a>}</div>
        <div class="row wrap-row">
          <a class="btn btn-sm btn-outline" href={`/staff/quotes/${q.id}/preview`} target="_blank">Preview</a>
          <a class="btn btn-sm btn-outline" href={`/staff/quotes/${q.id}/pdf`}>PDF</a>
          <form method="post" action={`/staff/quotes/${q.id}/duplicate`} class="inline"><button class="btn btn-sm btn-outline">Duplicate</button></form>
        </div>
      </div>
      {q.guest_feedback && <div class="flash">Guest said: “{q.guest_feedback}”</div>}
      {needsApproval && <div class="flash flash-err">This quotation has an unresolved rate or a price below the Staff Rate. Correct it before saving or sending.</div>}

      <form method="post" action={`/staff/quotes/${q.id}`} class="stack">
        <section class="card stack">
          <div class="row-between"><h2>Guest</h2>{enquiry && editable && <button class="btn btn-sm btn-outline" formaction={`/staff/quotes/${q.id}/fill`} title="AI reads the enquiry and pre-fills dates, guests and a suggested property">✨ Fill from enquiry</button>}</div>
          <div class="row">
            <Field label="Name"><input name="guest_name" value={q.guest_name} required disabled={!editable} /></Field>
            <Field label="Phone"><input name="phone" value={q.phone ?? ''} disabled={!editable} /></Field>
            <Field label="Email"><input type="email" name="email" value={q.email ?? ''} disabled={!editable} /></Field>
          </div>
        </section>

        <label class="check"><input type="hidden" name="gst_control" value="1" disabled={!editable} /><input type="checkbox" name="apply_gst" value="1" checked={q.apply_gst !== 0} disabled={!editable} /> Apply GST</label>
        {options.map((o, i) => {
          const rooms = allRooms.filter((r) => r.property_id === o.property_id)
          const meals = parseJson<string[]>(o.meal_plans, [])
          // Margin = what the guest pays for rooms (after discount, before GST) minus the B2B net cost for these exact dates.
          const net = netStay.get(o.id) ?? null
          const margin = net ? o.subtotal - o.discount - net * nightsBetween(o.check_in, o.check_out) * o.rooms_count : null
          return (
            <section class="card stack">
              <div class="row-between"><h3>Option {i + 1}: {o.property_name}</h3>{editable && <button class="linklike small" formaction={`/staff/quotes/${q.id}/options/${o.id}/delete`} formnovalidate>Remove</button>}</div>
              <input type="hidden" name="opt_id" value={o.id} />
              <div class="row wrap-row">
                <Field label="Room"><Select name={`room_${o.id}`} value={o.room_id} options={rooms.map((r) => [r.id, `${r.name} (${guestsText(r)})`])} /></Field>
                <Field label="Check-in"><input type="date" name={`in_${o.id}`} value={o.check_in} required /></Field>
                <Field label="Check-out"><input type="date" name={`out_${o.id}`} value={o.check_out} required /></Field>
                <Field label="Rooms"><input type="number" name={`rooms_${o.id}`} value={o.rooms_count} min="1" /></Field>
                <Field label="Adults"><input type="number" name={`adults_${o.id}`} value={o.adults} min="1" /></Field>
                <div class="field kids-policy-field">
                  <div class="kids-policy-label"><label class="field-label" for={`children_${o.id}`}>Children</label><button type="button" class="linklike kids-policy-trigger" data-kids-policy-toggle aria-controls={`kids-policy-${o.id}`} aria-expanded="false">See Kids Policy</button></div>
                  <input id={`children_${o.id}`} type="number" name={`children_${o.id}`} value={o.children} min="0" />
                  <div id={`kids-policy-${o.id}`} class="kids-policy-popover" hidden role="dialog" aria-label={`${o.property_name} — Kids Policy`} tabindex={-1} data-kids-room-select={`room_${o.id}`}>
                    <strong>{o.property_name} — Kids Policy</strong>
                    {o.child_free_below != null && <p>Children below {o.child_free_below}: Complimentary</p>}
                    {o.child_age_to != null && <p>Child rate up to age {o.child_age_to}; {o.child_age_to + 1}+ years treated as adult.</p>}
                    {rooms.map(r => <div data-kids-room={r.id} hidden={r.id !== o.room_id}>
                      <strong>Selected room: {r.name}</strong>
                      {r.extra_child_rate != null && <p>With bed: {money(r.extra_child_rate)}</p>}
                      {r.child_no_bed_rate != null && <p>Without bed: {money(r.child_no_bed_rate)}</p>}
                      {r.extra_child_rate == null && r.child_no_bed_rate == null && <p>Room kids charges not supplied.</p>}
                    </div>)}
                  </div>
                </div>
                <Field label="Kids Amount ₹" hint="Total child charge for this option's entire stay, after checking the policy."><input type="number" name={`kids_${o.id}`} value={chosenAddons(o.addons).find(a => a.kind === 'kids')?.total ?? ''} min="0" /></Field>
                <Field label="Meal plan"><Select name={`meal_${o.id}`} value={o.meal_plan ?? ''} options={[['', 'Room only'], ...meals.map((m) => [m, MEAL_PLANS[m] ?? m] as [string, string])]} /></Field>
                <Field label="Guest rate ₹ / room / night" hint="Your selling price. Blank = website rate."><input type="number" name={`grate_${o.id}`} value={o.guest_rate ?? ''} min="0" placeholder={String(o.base_rate)} /></Field>
                <Field label="Discount Amount ₹" hint={resolvedPrices.get(o.id)?.maximumDiscount != null ? `Maximum accommodation discount: ${money(resolvedPrices.get(o.id)!.maximumDiscount!)} (recalculated for the selected dates on save).` : 'Staff Rate not supplied: a positive discount cannot be applied.'}><input type="number" name={`discount_${o.id}`} value={o.discount || ''} min="0" step="1" /></Field>
                <Field label="Other extras ₹"><input type="number" name={`extra_${o.id}`} value={Math.max(0, o.extra_charges - chosenAddons(o.addons).reduce((a, x) => a + x.total, 0))} min="0" /></Field>
                <Field label="Other extras label"><input name={`extralabel_${o.id}`} value={o.extra_label ?? ''} placeholder="e.g. Airport pickup" /></Field>
              </div>
              {readAddons(o.property_addons).length > 0 && (
                <fieldset class="addon-pick">
                  <legend class="small">Add-ons for this option</legend>
                  {readAddons(o.property_addons).map((a, idx) => {
                    const chosen = chosenAddons(o.addons).find((x) => x.kind !== 'kids' && x.name === a.name)
                    const n = nightsBetween(o.check_in, o.check_out)
                    const defQty = a.per === 'night' ? n : a.per === 'person' ? o.adults + o.children : 1
                    return (
                      <label class="check addon-row">
                        <input type="checkbox" name={`addon_${o.id}`} value={idx} checked={!!chosen} disabled={!editable} />
                        {a.name} — {money(a.price)}{a.per && a.per !== 'stay' ? ` ${ADDON_PER[a.per]}` : ''}
                        {perms.view_net_rates && a.net ? <span class="internal small"> (net {money(a.net)})</span> : null}
                        <span class="small muted">× <input type="number" name={`addonqty_${o.id}_${idx}`} value={chosen?.qty ?? defQty} min="1" max="99" class="w-sm" aria-label="Quantity" disabled={!editable} /></span>
                      </label>
                    )
                  })}
                </fieldset>
              )}
              <div class="rate-strip small">
                <span class="internal">Staff rate: <strong>{o.staff_rate ? money(o.staff_rate) : 'not set'}</strong></span>
                <span>Website rate: {money(o.base_rate)}{o.weekend_rate && o.weekend_rate !== o.base_rate ? ` / ${money(o.weekend_rate)} ${weekendLabel(weekendOf.get(o.property_id)).replace(' nights', '')}` : ''}</span>
                <span>Quoted: <strong>{money(effectiveNightly({ ...o, subtotal: resolvedPrices.get(o.id)?.roomCharges ?? o.subtotal }))}</strong> / room / night{o.guest_rate ? '' : ' (website rate)'}</span>
                {perms.view_net_rates && netStay.get(o.id) && <span class="internal">B2B / Net for these dates: {money(netStay.get(o.id)!)} / room / night</span>}
                {resolvedPrices.get(o.id)?.errors.map(error => <span class="pill pill-red">{error}</span>)}
              </div>
              <table class="breakdown narrow-table">
                {(() => {
                  const room = rooms.find((r) => r.id === o.room_id)
                  const n = nightsBetween(o.check_in, o.check_out)
                  const occ = room ? occupancy({ ...room, extra_child_rate: 0 }, o.rooms_count, o.adults, o.children, n) : null
                  return (
                    <>
                      <tr><td>Room charges ({n} nights × {o.rooms_count} room{o.rooms_count > 1 ? 's' : ''}{occ && occ.included < occ.max ? `, rate covers ${occ.included} guests` : ''})</td><td>{money(o.subtotal - (occ?.total ?? 0))}</td></tr>
                      {occ && occ.total > 0 && <tr><td>Extra guests ({[occ.extraAdults && `${occ.extraAdults} adult${occ.extraAdults > 1 ? 's' : ''}`, false].filter(Boolean).join(' + ')} × {n} nights)</td><td>{money(occ.total)}</td></tr>}
                      {occ && o.adults + o.children > occ.max && <tr class="row-red"><td colSpan={2}>⚠ {o.adults + o.children} guests is more than {o.rooms_count} room{o.rooms_count > 1 ? 's' : ''} can take (max {occ.max}). Add a room.</td></tr>}
                    </>
                  )
                })()}
                {o.discount > 0 && <tr><td>Accommodation discount</td><td>− {money(o.discount)}</td></tr>}
                {o.extra_charges > 0 && <tr><td>{extrasLabel(o)}</td><td>{money(o.extra_charges)}</td></tr>}
                <tr><td>{gstLabel(q.apply_gst)}</td><td>{money(o.taxes)}</td></tr>
                <tr class="total"><td>Total</td><td>{money(o.total)}</td></tr>
                {perms.view_net_rates && margin != null && <tr class="internal"><td>Room margin (internal, before GST)</td><td>{money(margin)}</td></tr>}
              </table>
              <p class="muted small">Prices are calculated by the rate rules. Save to recalculate.</p>
            </section>
          )
        })}

        {editable && (
          <section class="card">
            <h3>Add an option</h3>
            <div class="row wrap-row">
              <Select name="new_property" options={[['', 'Choose a property…'], ...props.map((p) => [p.id, `${p.name} (${p.destination})`] as [number, string])]} />
              <button class="btn btn-sm btn-outline" formaction={`/staff/quotes/${q.id}/add`}>Add</button>
              <a class="btn btn-sm btn-outline" href={`/staff/finder?quote=${q.id}${enquiry ? `&enquiry=${enquiry.id}&destination=${encodeURIComponent(enquiry.destination ?? '')}&checkIn=${enquiry.check_in ?? ''}&checkOut=${enquiry.check_out ?? ''}&guests=${enquiry.adults + enquiry.children}` : ''}`}>Find in property finder</a>
            </div>
          </section>
        )}

        <section class="card stack">
          <h3>Terms</h3>
          <div class="row">
            <Field label="Inclusions"><textarea name="inclusions" rows={3}>{q.inclusions}</textarea></Field>
            <Field label="Exclusions"><textarea name="exclusions" rows={3}>{q.exclusions}</textarea></Field>
          </div>
          <div class="row">
            <Field label="Valid till"><input type="date" name="valid_till" value={q.valid_till ?? ''} min={todayIST()} /></Field>
            <Field label="Payment terms"><input name="payment_terms" value={q.payment_terms} /></Field>
          </div>
          <Field label="Message to guest">
            <textarea name="message" rows={4} id="quote-msg">{q.message}</textarea>
          </Field>
          {editable && <button class="btn btn-sm btn-outline" formaction={`/staff/quotes/${q.id}/draft-message`} title="AI drafts a friendly message; edit before sending">✨ Draft friendly message</button>}
        </section>

        {q.explainer && <AiNote label="Guest will see">{q.explainer}</AiNote>}

        <div class="row wrap-row sticky-actions">
          {editable && <button class="btn">Save draft</button>}
          {editable && !needsApproval && options.length > 0 && (
            <>
              <button class="btn" formaction={`/staff/quotes/${q.id}/send?via=whatsapp`}>Save & send on WhatsApp</button>
              <button class="btn btn-outline" formaction={`/staff/quotes/${q.id}/send?via=email`}>Save & email</button>
              <label class="check small"><input type="checkbox" name="hold" value="1" /> Hold rooms until valid date</label>
            </>
          )}
          {editable && needsApproval && q.status !== 'pending_approval' && <button class="btn" formaction={`/staff/quotes/${q.id}/request-approval`}>Request approval</button>}
          {!editable && <a class="btn btn-outline" href={`https://wa.me/${(q.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(link)}`} target="_blank">Resend link on WhatsApp</a>}
          {!editable && q.status !== 'accepted' && <button class="btn btn-outline" formaction={`/staff/quotes/${q.id}/reopen`}>Edit (reopen)</button>}
          {!editable && q.status !== 'accepted' && options.length > 0 && <button class="btn btn-outline" formaction={`/staff/quotes/${q.id}/convert`}>Convert to booking</button>}
        </div>
        {q.status !== 'draft' && <p class="small">Guest link: <a href={link} target="_blank">{link}</a> · viewed {q.view_count}× {q.last_viewed_at ? `(last ${fmtDateTime(q.last_viewed_at)})` : ''}</p>}
      </form>
    </div>
  ))
})

/** Save all fields and re-price every option by the rate rules. */
async function saveQuote(c: Context<AppEnv>, q: QuotationRow) {
  const u = c.get('user')!
  const f = await form(c)
  const applyGst = f.gst_control === '1' ? (f.apply_gst === '1' ? 1 : 0) : q.apply_gst ?? 1
  if (['draft', 'pending_approval', 'changes_requested'].includes(q.status)) {
    // Validate every option before writing anything; stored discounts remain fixed rupee amounts.
    // Management exceptions cannot bypass the current Staff accommodation floor.
    for (const oid of f.__all.opt_id ?? []) {
      const o = await first<QuoteOptionRow>(c.env, 'SELECT * FROM quotation_options WHERE id = ? AND quotation_id = ?', int(oid), q.id)
      if (!o) continue
      const amount = f[`discount_${oid}`] == null ? o.discount : Number(f[`discount_${oid}`] || 0)
      if (!Number.isSafeInteger(amount) || amount < 0) throw new HTTPException(303, { res: redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'Enter a valid whole-rupee Discount Amount.' }) })
      const checkIn = isDate(f[`in_${oid}`]) ? f[`in_${oid}`] : o.check_in
      const checkOut = isDate(f[`out_${oid}`]) && f[`out_${oid}`] > checkIn ? f[`out_${oid}`] : addDays(checkIn, Math.max(1, nightsBetween(o.check_in, o.check_out)))
      const base = await priceOption(c, { room_id: int(f[`room_${oid}`], o.room_id), check_in: checkIn, check_out: checkOut,
        rooms_count: Math.max(1, int(f[`rooms_${oid}`], o.rooms_count)), apply_gst: applyGst, discount_pct: 0, discount: amount, extra_charges: 0,
        guest_rate: int(f[`grate_${oid}`]) > 0 ? int(f[`grate_${oid}`]) : null,
        adults: Math.max(1, int(f[`adults_${oid}`], o.adults)), children: Math.max(0, int(f[`children_${oid}`], o.children)), meal_plan: f[`meal_${oid}`] || null })
      if (!base) continue
      if (base.errors.length) throw new HTTPException(303, { res: redirectMsg(c, `/staff/quotes/${q.id}`, { err: base.errors[0] }) })
    }
    const untouched = await all<QuoteOptionRow>(c.env, 'SELECT * FROM quotation_options WHERE quotation_id = ?', q.id)
    const gstUpdates: { option: QuoteOptionRow; price: NonNullable<Awaited<ReturnType<typeof priceOption>>> }[] = []
    for (const option of untouched.filter(o => !(f.__all.opt_id ?? []).includes(String(o.id)))) {
      if (applyGst === q.apply_gst) continue
      const price = await priceOption(c, { ...option, apply_gst: applyGst })
      if (!price || price.errors.length) throw new HTTPException(303, { res: redirectMsg(c, `/staff/quotes/${q.id}`, { err: price?.errors[0] ?? 'Room rate could not be resolved.' }) })
      gstUpdates.push({ option, price })
    }
    await run(c.env, 'UPDATE quotations SET guest_name = ?, phone = ?, email = ?, apply_gst = ?, explainer = CASE WHEN apply_gst != ? THEN NULL ELSE explainer END WHERE id = ?', str(f.guest_name, 80) || q.guest_name, normalizePhone(f.phone) ?? q.phone, str(f.email, 120) || null, applyGst, applyGst, q.id)
    q.apply_gst = applyGst
    for (const { option, price } of gstUpdates) await run(c.env, 'UPDATE quotation_options SET subtotal=?,discount=?,taxes=?,total=? WHERE id=? AND quotation_id=?', price.subtotal, price.discount, price.taxes, price.total, option.id, q.id)
    for (const oid of f.__all.opt_id ?? []) {
      const o = await first<QuoteOptionRow>(c.env, 'SELECT * FROM quotation_options WHERE id = ? AND quotation_id = ?', int(oid), q.id)
      if (!o) continue
      const checkIn = isDate(f[`in_${oid}`]) ? f[`in_${oid}`] : o.check_in
      const checkOut = isDate(f[`out_${oid}`]) && f[`out_${oid}`] > checkIn ? f[`out_${oid}`] : addDays(checkIn, Math.max(1, nightsBetween(o.check_in, o.check_out)))
      const amount = f[`discount_${oid}`] == null ? o.discount : Number(f[`discount_${oid}`] || 0)
      const grate = int(f[`grate_${oid}`]) > 0 ? int(f[`grate_${oid}`]) : null
      // Add-ons ticked from the property's list (prices from the property, never from the form).
      const propAddons = readAddons((await first<{ addons: string }>(c.env, 'SELECT addons FROM properties WHERE id = ?', o.property_id))?.addons)
      const picked: ChosenAddon[] = (f.__all[`addon_${oid}`] ?? []).map((i) => propAddons[int(i)]).filter(Boolean).map((a) => {
        const qty = Math.max(1, Math.min(99, int(f[`addonqty_${oid}_${propAddons.indexOf(a)}`], 1)))
        return { name: a.name, price: a.price, qty, total: a.price * qty }
      })
      const kids = f[`kids_${oid}`] == null
        ? chosenAddons(o.addons).find(a => a.kind === 'kids')?.total ?? 0
        : Math.max(0, int(f[`kids_${oid}`]))
      if (kids > 0) picked.push({ kind: 'kids', name: 'Kids Amount', price: kids, qty: 1, total: kids })
      const addonTotal = picked.reduce((a, x) => a + x.total, 0)
      const next = {
        room_id: int(f[`room_${oid}`], o.room_id), check_in: checkIn, check_out: checkOut, rooms_count: Math.max(1, int(f[`rooms_${oid}`], o.rooms_count)),
        apply_gst: applyGst, discount_pct: 0, discount: amount, extra_charges: Math.max(0, int(f[`extra_${oid}`])) + addonTotal, guest_rate: grate,
        adults: Math.max(1, int(f[`adults_${oid}`], o.adults)), children: Math.max(0, int(f[`children_${oid}`], o.children)),
        meal_plan: f[`meal_${oid}`] || null,
      }
      const p = await priceOption(c, next)
      if (!p) continue
      const disc = amount === o.discount && p.subtotal === o.subtotal
        ? o.discount_pct // Retain legacy descriptive percentage; it no longer controls authorization.
        : p.subtotal > 0 ? p.discount * 100 / p.subtotal : 0
      next.discount_pct = disc
      const staffRate = await optionStaffRate(c, next)
      const approved = null // Management approval cannot bypass the accommodation floor.
      await run(
        c.env,
        `UPDATE quotation_options SET room_id = ?, check_in = ?, check_out = ?, rooms_count = ?, adults = ?, children = ?, meal_plan = ?, discount_pct = ?, extra_charges = ?, extra_label = ?,
           subtotal = ?, discount = ?, taxes = ?, total = ?, discount_approved_by = ?, guest_rate = ?, addons = ? WHERE id = ?`,
        next.room_id, checkIn, checkOut, next.rooms_count, Math.max(1, int(f[`adults_${oid}`], o.adults)), Math.max(0, int(f[`children_${oid}`], o.children)), f[`meal_${oid}`] || null,
        disc, next.extra_charges, str(f[`extralabel_${oid}`], 60) || null, p.subtotal, p.discount, p.taxes, p.total, approved, grate, JSON.stringify(picked), o.id,
      )
      if (disc !== o.discount_pct) await logActivity(c.env, u.id, 'quote.discount', 'quotation', q.id, { option: o.id, from: o.discount_pct, to: disc })
      if (grate !== o.guest_rate) await logActivity(c.env, u.id, 'quote.guest_rate', 'quotation', q.id, { option: o.id, from: o.guest_rate, to: grate, staff_rate: staffRate })
    }
  }
  await run(
    c.env,
    'UPDATE quotations SET inclusions = ?, exclusions = ?, valid_till = ?, payment_terms = ?, message = ?, updated_at = ? WHERE id = ?',
    str(f.inclusions, 2000), str(f.exclusions, 2000), isDate(f.valid_till) ? f.valid_till : q.valid_till, str(f.payment_terms, 500), str(f.message, 3000), nowIso(), q.id,
  )
  return f
}

opsRoutes.post('/staff/quotes/:id', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  await saveQuote(c, q)
  return redirectMsg(c, `/staff/quotes/${q.id}`, { ok: 'Saved and re-priced.' })
})

opsRoutes.post('/staff/quotes/:id/add', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const f = await saveQuote(c, q)
  const e = q.enquiry_id ? await first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', q.enquiry_id) : null
  if (int(f.new_property)) await addOption(c, q.id, int(f.new_property), null, e?.check_in ?? null, e?.check_out ?? null, e?.adults ?? 2, e?.children ?? 0)
  return c.redirect(`/staff/quotes/${q.id}`, 303)
})

opsRoutes.post('/staff/quotes/:id/options/:oid/delete', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  await run(c.env, 'DELETE FROM quotation_options WHERE id = ? AND quotation_id = ?', int(c.req.param('oid')), q.id)
  return c.redirect(`/staff/quotes/${q.id}`, 303)
})

opsRoutes.post('/staff/quotes/:id/fill', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q || !q.enquiry_id) return c.notFound()
  await saveQuote(c, q)
  const e = await first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', q.enquiry_id)
  const fill = await quoteFillFromEnquiry(c.env, e!)
  const opts = await all<QuoteOptionRow>(c.env, 'SELECT * FROM quotation_options WHERE quotation_id = ?', q.id)
  if (fill.propertyId && !opts.length) await addOption(c, q.id, fill.propertyId, null, fill.checkIn, fill.checkOut, fill.adults, fill.children)
  // Validate every prospective date/rate change before updating an existing option.
  const updates: { option: QuoteOptionRow; price: NonNullable<Awaited<ReturnType<typeof priceOption>>> }[] = []
  for (const old of opts) {
    const option = fill.propertyId ? { ...old, check_in: fill.checkIn ?? old.check_in, check_out: fill.checkOut ?? old.check_out, adults: fill.adults, children: fill.children } : old
    const price = await priceOption(c, { ...option, apply_gst: q.apply_gst })
    if (!price || price.errors.length) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: price?.errors[0] ?? 'Room rate could not be resolved.' })
    updates.push({ option, price })
  }
  for (const { option: o, price: p } of updates) await run(c.env,
    'UPDATE quotation_options SET check_in=?,check_out=?,adults=?,children=?,subtotal=?,discount=?,taxes=?,total=?,discount_pct=? WHERE id=?',
    o.check_in, o.check_out, o.adults, o.children, p.subtotal, p.discount, p.taxes, p.total, p.subtotal === o.subtotal ? o.discount_pct : p.subtotal > 0 ? p.discount * 100 / p.subtotal : 0, o.id)
  return redirectMsg(c, `/staff/quotes/${q.id}`, { ok: `Filled from enquiry${fill.matches.length ? ` — suggested ${fill.matches.map((m) => m.name).join(', ')}` : ''}. Please check.` })
})

opsRoutes.post('/staff/quotes/:id/draft-message', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  await saveQuote(c, q)
  const opts = await all<QuoteOptionRow & { property_name: string }>(c.env, 'SELECT o.*, p.name AS property_name FROM quotation_options o JOIN properties p ON p.id = o.property_id WHERE quotation_id = ?', q.id)
  const lang = q.enquiry_id ? (await first<{ language: 'en' | 'ml' }>(c.env, 'SELECT language FROM enquiries WHERE id = ?', q.enquiry_id))?.language ?? 'en' : 'en'
  const msg = await quoteMessageDraft(c.env, q, opts.map((o) => `${o.property_name}, ${fmtDate(o.check_in)}–${fmtDate(o.check_out)}, ${gstLabel(q.apply_gst)}: ${money(o.taxes)}`), lang)
  if (!msg) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'AI drafting is off or unavailable.' })
  await run(c.env, 'UPDATE quotations SET message = ? WHERE id = ?', msg, q.id)
  return redirectMsg(c, `/staff/quotes/${q.id}`, { ok: 'Message drafted — please review before sending.' })
})

opsRoutes.post('/staff/quotes/:id/request-approval', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  await saveQuote(c, q)
  await run(c.env, "UPDATE quotations SET status = 'pending_approval' WHERE id = ?", q.id)
  await logActivity(c.env, c.get('user')!.id, 'quote.approval_requested', 'quotation', q.id)
  return redirectMsg(c, `/staff/quotes/${q.id}`, { ok: 'Sent for approval.' })
})

opsRoutes.post('/staff/quotes/:id/reopen', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  await run(c.env, "UPDATE quotations SET status = 'draft' WHERE id = ? AND status != 'accepted'", q.id)
  return c.redirect(`/staff/quotes/${q.id}`, 303)
})

opsRoutes.post('/staff/quotes/:id/send', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  let q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const f = await saveQuote(c, q)
  q = (await first<QuotationRow>(c.env, 'SELECT * FROM quotations WHERE id = ?', q.id))!
  const opts = await all<QuoteOptionRow & { staff_rate: number | null }>(c.env, 'SELECT o.* FROM quotation_options o WHERE o.quotation_id = ?', q.id)
  for (const o of opts) o.staff_rate = await optionStaffRate(c, o)
  if (!opts.length) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'Add at least one option.' })
  for (const option of opts) {
    const price = await priceOption(c, { ...option, apply_gst: q.apply_gst })
    if (!price || price.errors.length) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: price?.errors[0] ?? 'Room rate could not be resolved.' })
  }
  const s = await getSettings(c.env)
  const link = `${c.env.SITE_URL}/q/${q.token}`
  const via = c.req.query('via')
  const prop = await first<{ name: string }>(c.env, 'SELECT p.name FROM quotation_options o JOIN properties p ON p.id = o.property_id WHERE o.quotation_id = ? LIMIT 1', q.id)
  const gstText = q.apply_gst === 0 ? 'GST not applied: ₹0' : `GST: ${opts.map(o => money(o.taxes)).join(' / ')}`
  const text = (q.message ? q.message + '\n\n' : '') + gstText + '\n' + fillTemplate(s.whatsapp_templates.quote, { name: q.guest_name, link, valid: fmtDate(q.valid_till), property: prop?.name })
  if (via === 'whatsapp') {
    if (!q.phone) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'Add the guest phone number.' })
    const r = await sendWhatsApp(c.env, q.phone, text)
    if (!r.ok) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: `WhatsApp failed: ${r.error}` })
  } else {
    if (!q.email) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'Add the guest email.' })
    await sendEmail(c.env, q.email, `Your quote from ${s.business.name}`, `<p style="white-space:pre-line">${text.replace(/</g, '&lt;')}</p><p><a href="${link}">Open your quote</a></p>`)
  }
  await run(c.env, "UPDATE quotations SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), q.id)
  if (q.enquiry_id) {
    await run(c.env, "INSERT INTO messages (enquiry_id, sender, user_id, channel, body) VALUES (?, 'staff', ?, ?, ?)", q.enquiry_id, u.id, via === 'whatsapp' ? 'whatsapp' : 'email', text)
    await run(c.env, "UPDATE enquiries SET status = 'quoted', waiting_on = 'guest', last_staff_reply_at = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?", nowIso(), nowIso(), nowIso(), q.enquiry_id)
  }
  if (f.hold && q.valid_till) {
    const until = new Date(Date.parse(q.valid_till + 'T23:59:59+05:30')).toISOString()
    for (const o of opts) for (const d of eachNight(o.check_in, o.check_out)) for (let k = 0; k < o.rooms_count; k++) {
      await run(c.env, 'INSERT INTO blocked_dates (property_id, room_id, date, reason, quotation_id, hold_until, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', o.property_id, o.room_id, d, `Hold for quote ${q.code}`, q.id, until, u.id)
    }
  }
  // Explainer is written once now and stored; follow-up is scheduled for tomorrow.
  await enqueue(c.env, { type: 'quote_explainer', quotationId: q.id })
  const taskId = await insertId(c.env, 'INSERT INTO tasks (assigned_to, enquiry_id, quotation_id, guest_name, phone, reason, due_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', u.id, q.enquiry_id, q.id, q.guest_name, q.phone, `Follow up on quote ${q.code}`, new Date(Date.now() + 24 * 3600_000).toISOString(), u.id)
  await enqueue(c.env, { type: 'followup_draft', taskId })
  await logActivity(c.env, u.id, 'quote.sent', 'quotation', q.id, { via, total: opts.map((o) => o.total) })
  return redirectMsg(c, `/staff/quotes/${q.id}`, { ok: `Quote sent by ${via === 'whatsapp' ? 'WhatsApp' : 'email'}.` })
})

opsRoutes.post('/staff/quotes/:id/duplicate', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const id = await insertId(
    c.env,
    `INSERT INTO quotations (code, token, enquiry_id, user_id, staff_id, guest_name, phone, email, valid_till, inclusions, exclusions, payment_terms, message, apply_gst)
     SELECT ?, ?, enquiry_id, user_id, ?, guest_name, phone, email, ?, inclusions, exclusions, payment_terms, message, apply_gst FROM quotations WHERE id = ?`,
    refCode('QT'), randomToken(18), u.id, addDays(todayIST(), (await getSettings(c.env)).booking.quote_validity_days), q.id,
  )
  await run(
    c.env,
    `INSERT INTO quotation_options (quotation_id, property_id, room_id, check_in, check_out, adults, children, rooms_count, meal_plan, subtotal, discount, extra_charges, extra_label, taxes, total, discount_pct, guest_rate, addons)
     SELECT ?, property_id, room_id, check_in, check_out, adults, children, rooms_count, meal_plan, subtotal, discount, extra_charges, extra_label, taxes, total, discount_pct, guest_rate, addons FROM quotation_options WHERE quotation_id = ?`,
    id, q.id,
  )
  return c.redirect(`/staff/quotes/${id}`, 303)
})

opsRoutes.post('/staff/quotes/:id/convert', requirePerm('manage_quotes', 'manage_bookings'), async (c) => {
  const u = c.get('user')!
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const o = await first<QuoteOptionRow>(c.env, 'SELECT * FROM quotation_options WHERE quotation_id = ? ORDER BY (id = ?) DESC, id LIMIT 1', q.id, q.accepted_option_id ?? 0)
  if (!o || !q.phone) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: 'Quote needs an option and a guest phone.' })
  const validated = await priceOption(c, { ...o, apply_gst: q.apply_gst })
  if (!validated || validated.errors.length) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: validated?.errors[0] ?? 'Room rate could not be resolved.' })
  const r = await createBooking(c.env, {
    applyGst: q.apply_gst !== 0, roomId: o.room_id, checkIn: o.check_in, checkOut: o.check_out, adults: o.adults, children: o.children, roomsCount: o.rooms_count,
    guestName: q.guest_name, guestPhone: q.phone, guestEmail: q.email, userId: q.user_id, source: 'staff', mealPlan: o.meal_plan,
    quotationId: q.id, enquiryId: q.enquiry_id, staffId: u.id,
    fixedPrice: { subtotal: o.subtotal, discount: o.discount, extraCharges: o.extra_charges, taxes: o.taxes, total: o.total },
  })
  if ('error' in r) return redirectMsg(c, `/staff/quotes/${q.id}`, { err: r.error })
  // The guest has agreed: confirm now (rooms are blocked); payment is collected offline and recorded on the booking.
  await confirmBooking(c.env, r.id, u.id)
  await logActivity(c.env, u.id, 'quote.converted', 'quotation', q.id, { booking: r.code })
  return redirectMsg(c, `/staff/bookings/${r.id}`, { ok: 'Booking confirmed and the guest notified. Record payments here when received.' })
})

opsRoutes.get('/staff/quotes/:id/preview', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const opts = await all<QuoteOptionRow & { property_name: string; room_name: string; destination: string }>(c.env, 'SELECT o.*, p.name AS property_name, p.destination, r.name AS room_name FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE quotation_id = ? ORDER BY o.id', q.id)
  return page(c, { title: `Preview ${q.code}`, noindex: true }, (
    <div class="wrap narrow section">
      <p class="flash">Preview — this is what the guest will see.</p>
      <h1>Your stay quote</h1>
      {q.explainer && <AiNote label="In short">{q.explainer}</AiNote>}
      {q.message && <div class="card"><p style="white-space:pre-line">{q.message}</p></div>}
      {opts.map((o, i) => (
        <div class="card">
          <h2>{opts.length > 1 ? `Option ${i + 1}: ` : ''}{o.property_name}</h2>
          <p>{o.destination} · {o.room_name} × {o.rooms_count} · {fmtDate(o.check_in)} → {fmtDate(o.check_out)} · {o.adults + o.children} guests</p>
          <table class="breakdown"><tr><td>Room charges</td><td>{money(o.subtotal)}</td></tr>{o.discount > 0 && <tr><td>Discount</td><td>− {money(o.discount)}</td></tr>}{o.extra_charges > 0 && <tr><td>{extrasLabel(o)}</td><td>{money(o.extra_charges)}</td></tr>}<tr><td>{gstLabel(q.apply_gst)}</td><td>{money(o.taxes)}</td></tr><tr class="total"><td>Total</td><td>{money(o.total)}</td></tr></table>
        </div>
      ))}
      <p class="muted">Valid till {fmtDate(q.valid_till)}</p>
    </div>
  ))
})

// A direct PDF response works with native mobile browser Save/Download/Share.
opsRoutes.get('/staff/quotes/:id/pdf', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const s = await getSettings(c.env)
  const options = await all<PdfQuoteOption>(c.env, 'SELECT o.*, p.name AS property_name, p.destination, r.name AS room_name FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE quotation_id = ? ORDER BY o.id', q.id)
  const bytes = await quotationPdf(q, options, s.business, c.env.SITE_URL)
  return new Response(bytes, { headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${quotationPdfFilename(q.code)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  } })
})

opsRoutes.get('/staff/quotes/:id/print', requirePerm('manage_quotes'), async (c) => {
  const q = await loadQuoteFor(c, int(c.req.param('id')))
  if (!q) return c.notFound()
  const s = await getSettings(c.env)
  const opts = await all<QuoteOptionRow & { property_name: string; room_name: string; destination: string }>(c.env, 'SELECT o.*, p.name AS property_name, p.destination, r.name AS room_name FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE quotation_id = ? ORDER BY o.id', q.id)
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Quote ${esc(q.code)}</title><style>body{font:14px/1.5 system-ui;max-width:760px;margin:24px auto;padding:0 16px;color:#1d2b2a}table{width:100%;border-collapse:collapse}td{padding:6px;border-bottom:1px solid #ddd}.r{text-align:right}.t td{font-weight:700}@media print{button{display:none}}</style></head><body>
<button data-print>Print / Save as PDF</button><script src="/app.js" defer></script><h1>${esc(s.business.name)} — Quotation ${esc(q.code)}</h1><p>For ${esc(q.guest_name)} · valid till ${esc(fmtDate(q.valid_till))}</p>
${q.explainer ? `<p><em>${esc(q.explainer)}</em></p>` : ''}${opts.map((o, i) => `<h2>${opts.length > 1 ? `Option ${i + 1}: ` : ''}${esc(o.property_name)}</h2><p>${esc(o.destination)} · ${esc(o.room_name)} × ${o.rooms_count} · ${esc(fmtDate(o.check_in))} → ${esc(fmtDate(o.check_out))} · ${o.adults + o.children} guests · ${esc(o.meal_plan ? MEAL_PLANS[o.meal_plan] ?? o.meal_plan : 'Room only')}</p>
<table><tr><td>Room charges</td><td class="r">${money(o.subtotal)}</td></tr>${o.discount ? `<tr><td>Discount</td><td class="r">− ${money(o.discount)}</td></tr>` : ''}${o.extra_charges ? `<tr><td>${esc(extrasLabel(o))}</td><td class="r">${money(o.extra_charges)}</td></tr>` : ''}<tr><td>${gstLabel(q.apply_gst)}</td><td class="r">${money(o.taxes)}</td></tr><tr class="t"><td>Total</td><td class="r">${money(o.total)}</td></tr></table>`).join('')}
${q.inclusions ? `<h3>Included</h3><p style="white-space:pre-line">${esc(quotationInclusions(q.inclusions, q.apply_gst))}</p>` : ''}${q.exclusions ? `<h3>Not included</h3><p style="white-space:pre-line">${esc(q.exclusions)}</p>` : ''}${q.payment_terms ? `<h3>Payment terms</h3><p>${esc(q.payment_terms)}</p>` : ''}
<p>Accept online: ${esc(c.env.SITE_URL)}/q/${esc(q.token)}</p><p>${esc(s.business.phone)} · ${esc(s.business.email)}</p></body></html>`)
})

// ---------- 24. Quotations list ----------
export async function renderQuotes(c: Context<AppEnv>, admin: boolean) {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const status = c.req.query('status') ?? (admin ? 'pending_approval' : 'all')
  const pg = pageNum(c)
  const where: string[] = []
  const binds: (string | number)[] = []
  if (status === 'viewed3') where.push("q.view_count >= 3 AND q.status IN ('sent','viewed')")
  else if (status !== 'all') { where.push('q.status = ?'); binds.push(status) }
  if (!perms.view_all_enquiries) { where.push('q.staff_id = ?'); binds.push(u.id) }
  const rows = await all<QuotationRow & { total: number; property_name: string | null; staff_name: string | null; max_disc: number }>(
    c.env,
    `SELECT q.*, (SELECT MIN(total) FROM quotation_options o WHERE o.quotation_id = q.id) AS total,
       (SELECT MAX(discount_pct) FROM quotation_options o WHERE o.quotation_id = q.id) AS max_disc,
       (SELECT p.name FROM quotation_options o JOIN properties p ON p.id = o.property_id WHERE o.quotation_id = q.id LIMIT 1) AS property_name, s.name AS staff_name
     FROM quotations q LEFT JOIN users s ON s.id = q.staff_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.updated_at DESC LIMIT 51 OFFSET ?`,
    ...binds, (pg - 1) * 50,
  )
  const conv = admin
    ? await all<{ name: string; sent: number; accepted: number }>(c.env, "SELECT s.name, COUNT(*) AS sent, SUM(q.status = 'accepted') AS accepted FROM quotations q JOIN users s ON s.id = q.staff_id WHERE q.sent_at IS NOT NULL AND q.sent_at >= ? GROUP BY s.id", new Date(Date.now() - 90 * 86400_000).toISOString())
    : []
  const base = admin ? '/admin/quotes' : '/staff/quotes'
  return page(c, { title: admin ? 'All quotations' : 'Quotations', area: admin ? 'admin' : 'staff', active: admin ? 'all-quotes' : 'quotes' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>{admin ? 'All quotations' : 'Quotations'}</h1><a class="btn btn-sm" href="/staff/quotes/new">+ New quotation</a></div>
      {admin && conv.length > 0 && (
        <div class="card"><h3>Conversion by staff (90 days)</h3>
          <Table head={['Staff', 'Sent', 'Accepted', 'Rate']}>{conv.map((r) => <tr><td>{r.name}</td><td>{r.sent}</td><td>{r.accepted}</td><td>{r.sent ? Math.round((r.accepted / r.sent) * 100) : 0}%</td></tr>)}</Table>
        </div>
      )}
      <Tabs base={base} param="status" active={status} items={[['all', 'All'], ['draft', 'Draft'], ['pending_approval', 'Needs approval'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['viewed3', 'Viewed 3+, not booked'], ['accepted', 'Accepted'], ['changes_requested', 'Changes asked'], ['expired', 'Expired'], ['declined', 'Declined']]} />
      <Table head={['Quote', 'Guest', 'Property', 'Amount', 'Sent', 'Status', ...(admin ? ['Staff', 'Discount'] : []), 'Actions']}>
        {rows.slice(0, 50).map((q) => (
          <tr>
            <td><a href={`/staff/quotes/${q.id}`}>{q.code}</a></td>
            <td>{q.guest_name}</td>
            <td>{q.property_name ?? '—'}</td>
            <td>{money(q.total)}</td>
            <td class="small">{fmtDateTime(q.sent_at)}</td>
            <td><Pill s={q.status} />{q.view_count >= 3 && !['accepted', 'declined'].includes(q.status) && <span class="pill pill-urgent" title="Viewed 3+ times, not booked">👁 {q.view_count}</span>}</td>
            {admin && <td>{q.staff_name}</td>}
            {admin && <td>{q.max_disc ? `${q.max_disc}%` : '—'}</td>}
            <td class="nowrap">
              <a class="btn btn-sm" href={`/staff/quotes/${q.id}`}>Edit</a>
              {admin && q.status === 'pending_approval' && perms.approve_discounts && (
                <form method="post" action={`/admin/quotes/${q.id}/approve`} class="inline"><button class="btn btn-sm">Approve</button></form>
              )}
              {['sent', 'viewed'].includes(q.status) && q.phone && <a class="btn btn-sm btn-outline" target="_blank" href={`https://wa.me/${q.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`${c.env.SITE_URL}/q/${q.token}`)}`}>Resend</a>}
            </td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <Empty>No quotations here.</Empty>}
      <Pager page={pg} hasMore={rows.length > 50} base={`${base}?status=${status}`} />
    </div>
  ))
}
opsRoutes.get('/staff/quotes', requirePerm('manage_quotes'), (c) => renderQuotes(c, false))

// ---------- 25. Bookings ----------
export async function renderBookings(c: Context<AppEnv>, admin: boolean) {
  const tab = c.req.query('tab') ?? (admin ? 'all' : 'upcoming')
  const q = str(c.req.query('q'), 60)
  const pg = pageNum(c)
  const today = todayIST()
  const where: string[] = []
  const binds: (string | number)[] = []
  if (tab === 'upcoming') { where.push("b.status IN ('confirmed','pending') AND b.check_in > ?"); binds.push(today) }
  if (tab === 'today') { where.push("b.status IN ('confirmed','checked_in') AND b.check_in = ?"); binds.push(today) }
  if (tab === 'in_stay') where.push("b.status = 'checked_in'")
  if (tab === 'completed') where.push("b.status = 'completed'")
  if (tab === 'cancelled') where.push("b.status = 'cancelled' AND b.amount_paid > 0")
  if (tab === 'requests') where.push("b.change_status = 'requested'")
  if (q) { where.push('(b.guest_name LIKE ? OR b.guest_phone LIKE ? OR b.code LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  // Admin filters
  const fp = int(c.req.query('property')); if (fp) { where.push('b.property_id = ?'); binds.push(fp) }
  const fs = int(c.req.query('staff')); if (fs) { where.push('b.staff_id = ?'); binds.push(fs) }
  const fsrc = c.req.query('source'); if (fsrc) { where.push('b.source = ?'); binds.push(fsrc) }
  const from = c.req.query('from'); if (isDate(from)) { where.push('b.check_in >= ?'); binds.push(from) }
  const to = c.req.query('to'); if (isDate(to)) { where.push('b.check_in <= ?'); binds.push(to) }
  if (tab === 'all') where.push("NOT (b.status = 'cancelled' AND b.amount_paid = 0)")
  const rows = await all<BookingRow & { property_name: string; staff_name: string | null }>(
    c.env,
    `SELECT b.*, p.name AS property_name, s.name AS staff_name FROM bookings b JOIN properties p ON p.id = b.property_id LEFT JOIN users s ON s.id = b.staff_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${tab === 'completed' || tab === 'cancelled' ? 'b.check_in DESC' : 'b.check_in ASC'} LIMIT 51 OFFSET ?`,
    ...binds, (pg - 1) * 50,
  )
  const base = admin ? '/admin/bookings' : '/staff/bookings'
  const props = admin ? await all<{ id: number; name: string }>(c.env, 'SELECT id, name FROM properties ORDER BY name') : []
  const staff = admin ? await all<{ id: number; name: string }>(c.env, "SELECT id, name FROM users WHERE role != 'guest' ORDER BY name") : []
  const qs = new URL(c.req.url).searchParams
  qs.delete('page')
  return page(c, { title: admin ? 'All bookings' : 'Bookings', area: admin ? 'admin' : 'staff', active: admin ? 'all-bookings' : 'bookings' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>{admin ? 'All bookings' : 'Bookings'}</h1>{admin && <a class="btn btn-sm btn-outline" href={`/admin/bookings/export?${qs}`}>Export to Excel (CSV)</a>}</div>
      <Tabs base={base} active={tab} items={[...(admin ? [['all', 'All'] as [string, string]] : []), ['upcoming', 'Upcoming'], ['today', "Today's check-ins"], ['in_stay', 'In stay'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['requests', 'Change requests']]} />
      <form method="get" class="row filters-inline wrap-row">
        <input type="hidden" name="tab" value={tab} />
        <input name="q" value={q} placeholder="Guest name, phone or booking ID" />
        {admin && (
          <>
            <Select name="property" value={fp || ''} options={[['', 'Any property'], ...props.map((p) => [p.id, p.name] as [number, string])]} />
            <Select name="staff" value={fs || ''} options={[['', 'Any staff'], ...staff.map((p) => [p.id, p.name] as [number, string])]} />
            <Select name="source" value={fsrc ?? ''} options={[['', 'Any source'], ['website', 'Website'], ['quotation', 'Quotation'], ['staff', 'Staff']]} />
            <input type="date" name="from" value={from ?? ''} /><input type="date" name="to" value={to ?? ''} />
          </>
        )}
        <button class="btn btn-sm">Search</button>
      </form>
      <Table head={['Booking', 'Guest', 'Property', 'Dates', 'Total', 'Status', ...(admin ? ['Staff', 'Source'] : []), 'Actions']}>
        {rows.slice(0, 50).map((b) => (
          <tr>
            <td><a href={`/staff/bookings/${b.id}`}>{b.code}</a>{b.change_status === 'requested' && <span class="pill pill-urgent">request</span>}</td>
            <td>{b.guest_name}<div class="muted small">{b.guest_phone}</div></td>
            <td>{b.property_name}</td>
            <td class="nowrap">{fmtShortDate(b.check_in)} → {fmtShortDate(b.check_out)}</td>
            <td>{money(b.total)}<div class="muted small">paid {money(b.amount_paid)}</div></td>
            <td><Pill s={b.status} /> <Pill s={b.payment_status} /></td>
            {admin && <td>{b.staff_name ?? '—'}</td>}
            {admin && <td>{b.source}</td>}
            <td class="nowrap">
              <a class="btn btn-sm" href={`/staff/bookings/${b.id}`}>View</a>
              {b.status === 'confirmed' && b.check_in <= today && <form method="post" action={`/staff/bookings/${b.id}/checkin`} class="inline"><button class="btn btn-sm btn-outline">Checked in</button></form>}
              {b.status === 'confirmed' && b.check_in > today && <form method="post" action={`/staff/bookings/${b.id}/whatsapp?kind=reminder`} class="inline"><button class="btn btn-sm btn-outline">Reminder</button></form>}
              {b.amount_paid < b.total && b.status !== 'cancelled' && <a class="btn btn-sm btn-outline" href={`/staff/bookings/${b.id}#payment`}>Record payment</a>}
            </td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <Empty>No bookings here.</Empty>}
      <Pager page={pg} hasMore={rows.length > 50} base={`${base}?${qs}`} />
    </div>
  ))
}
opsRoutes.get('/staff/bookings', requirePerm('manage_bookings'), (c) => renderBookings(c, false))

// ---------- 26. Booking detail (staff) ----------
opsRoutes.get('/staff/bookings/:id', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const b = await first<BookingRow & { property_name: string; room_name: string; owner_phone: string | null; owner_name: string | null }>(
    c.env,
    'SELECT b.*, p.name AS property_name, p.owner_phone, p.owner_name, r.name AS room_name FROM bookings b JOIN properties p ON p.id = b.property_id JOIN rooms r ON r.id = b.room_id WHERE b.id = ?',
    int(c.req.param('id')),
  )
  if (!b) return c.notFound()
  const [payments, refunds, msgs, rooms] = await Promise.all([
    all<{ id: number; amount: number; status: string; gateway: string; gateway_payment_id: string | null; created_at: string; failure_reason: string | null }>(c.env, 'SELECT * FROM payments WHERE booking_id = ? ORDER BY id', b.id),
    all<{ id: number; amount: number; status: string; reason: string; created_at: string }>(c.env, 'SELECT * FROM refunds WHERE booking_id = ? ORDER BY id', b.id),
    all<{ sender: string; body: string; channel: string; created_at: string }>(c.env, 'SELECT sender, body, channel, created_at FROM messages WHERE booking_id = ? ORDER BY id', b.id),
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1', b.property_id),
  ])
  return page(c, { title: `Booking ${b.code}`, area: 'staff', active: 'bookings' }, (
    <div class="stack-lg">
      <a href="/staff/bookings" class="small">← Bookings</a>
      <div class="row-between"><h1>{b.code} · {b.guest_name}</h1><div><Pill s={b.status} /> <Pill s={b.payment_status} /></div></div>
      {b.change_status === 'requested' && (
        <div class="flash flash-err">
          Request: {b.change_request}
          {perms.approve_cancellations && (
            <div class="row wrap-row mt-sm">
              {b.change_request?.startsWith('CANCEL') && (
                <form method="post" action={`/admin/bookings/${b.id}/approve-cancel`} class="row">
                  {b.amount_paid > 0 && <input type="number" name="refund" min="0" max={b.amount_paid} value={/refund (\d+)/.exec(b.change_request ?? '')?.[1] ?? '0'} class="w-md" title="Refund ₹" />}
                  <button class="btn btn-sm btn-danger">Approve cancellation</button>
                </form>
              )}
              {b.change_request?.startsWith('CHANGE') && <span class="small">Use “Change dates” below to apply it.</span>}
              <form method="post" action={`/admin/bookings/${b.id}/reject-request`} class="inline"><button class="btn btn-sm btn-outline">Reject request</button></form>
            </div>
          )}
        </div>
      )}
      <div class="grid grid-2">
        <section class="card">
          <table class="breakdown">
            <tr><td>Guest</td><td>{b.guest_name} · <a href={`tel:${b.guest_phone}`}>{b.guest_phone}</a>{b.guest_email ? ` · ${b.guest_email}` : ''}</td></tr>
            <tr><td>Property</td><td>{b.property_name} — {b.room_name} × {b.rooms_count}</td></tr>
            <tr><td>Dates</td><td>{fmtDate(b.check_in)} → {fmtDate(b.check_out)} ({b.nights} nights)</td></tr>
            <tr><td>Guests</td><td>{b.adults} adults, {b.children} children · ID: {b.id_type ?? 'not given'}</td></tr>
            <tr><td>Meal plan</td><td>{b.meal_plan ? MEAL_PLANS[b.meal_plan] ?? b.meal_plan : 'Room only'}</td></tr>
            <tr><td>Subtotal / discount</td><td>{money(b.subtotal)} / − {money(b.discount)}{b.coupon_code ? ` (${b.coupon_code})` : ''}</td></tr>
            <tr><td>{gstLabel(b.apply_gst)}</td><td>{money(b.taxes)}</td></tr>
            <tr class="total"><td>Total</td><td>{money(b.total)}</td></tr>
            <tr><td>Paid</td><td>{money(b.amount_paid)}</td></tr>
            {perms.view_property_contacts && b.owner_phone && <tr class="internal"><td>Owner</td><td>{b.owner_name} {b.owner_phone}</td></tr>}
          </table>
          <div class="row wrap-row mt-sm">
            <a class="btn btn-sm btn-outline" href={`/invoice/${b.code}`} target="_blank">Invoice</a>
            {b.status === 'pending' && <form method="post" action={`/staff/bookings/${b.id}/confirm`} class="inline"><button class="btn btn-sm">Confirm booking</button></form>}
            {b.status === 'confirmed' && <form method="post" action={`/staff/bookings/${b.id}/checkin`} class="inline"><button class="btn btn-sm btn-outline">Mark checked-in</button></form>}
            {b.status === 'checked_in' && <form method="post" action={`/staff/bookings/${b.id}/checkout`} class="inline"><button class="btn btn-sm btn-outline">Mark completed</button></form>}
          </div>
          {b.amount_paid < b.total && b.status !== 'cancelled' && (
            <form method="post" action={`/staff/bookings/${b.id}/payment`} class="stack mt-sm" id="payment">
              <h3>Record a payment</h3>
              <div class="row wrap-row">
                <Field label="Amount ₹"><input type="number" name="amount" min="1" max={b.total - b.amount_paid} value={b.total - b.amount_paid} required /></Field>
                <Field label="Method"><Select name="method" options={PAYMENT_METHODS.map((m) => [m, m.replace('_', ' ')])} /></Field>
                <Field label="Reference (UTR / receipt no.)"><input name="reference" maxlength={80} /></Field>
              </div>
              <button class="btn btn-sm">Save payment</button>
            </form>
          )}
          <h3 class="mt">Payments</h3>
          <ul class="plain small">
            {payments.map((p) => <li>{money(p.amount)} · <Pill s={p.status} /> · {p.gateway} {p.gateway_payment_id ?? ''} · {fmtDateTime(p.created_at)} {p.failure_reason && <span class="error">{p.failure_reason}</span>}</li>)}
            {refunds.map((r) => <li>Refund {money(r.amount)} · <Pill s={r.status} /> · {r.reason}</li>)}
          </ul>
        </section>
        <section class="card stack">
          <h3>Send on WhatsApp</h3>
          <div class="row wrap-row">
            {(['confirmation', 'checkin', 'reminder'] as const).map((k) => (
              <form method="post" action={`/staff/bookings/${b.id}/whatsapp?kind=${k}`} class="inline"><button class="btn btn-sm btn-outline">{k === 'checkin' ? 'Directions & check-in' : k[0].toUpperCase() + k.slice(1)}</button></form>
            ))}
          </div>
          <form method="post" action={`/staff/bookings/${b.id}/notes`} class="stack">
            <Field label="Special requests (from guest)"><textarea name="special_requests" rows={2}>{b.special_requests}</textarea></Field>
            <Field label="Internal notes"><textarea name="internal_notes" rows={3}>{b.internal_notes}</textarea></Field>
            <button class="btn btn-sm btn-outline">Save notes</button>
          </form>
          {b.status !== 'cancelled' && (
            <>
              <h3>Change dates</h3>
              <form method="post" action={`/staff/bookings/${b.id}/change`} class="stack">
                <div class="row">
                  <Select name="room_id" value={b.room_id} options={rooms.map((r) => [r.id, r.name])} />
                  <input type="date" name="check_in" value={b.check_in} required />
                  <input type="date" name="check_out" value={b.check_out} required />
                </div>
                <button class="btn btn-sm btn-outline">{perms.approve_cancellations ? 'Change & re-price' : 'Request change (needs approval)'}</button>
              </form>
              <h3>Cancel</h3>
              <form method="post" action={`/staff/bookings/${b.id}/cancel`} class="stack">
                <input name="reason" placeholder="Reason" required />
                {b.amount_paid > 0 && <Field label={`Refund amount (paid ${money(b.amount_paid)})`}><input type="number" name="refund" min="0" max={b.amount_paid} value="0" /></Field>}
                <button class="btn btn-sm btn-danger">{perms.approve_cancellations ? 'Cancel booking' : 'Request cancellation (needs approval)'}</button>
              </form>
            </>
          )}
        </section>
      </div>
      <section class="card">
        <h3>Messages</h3>
        <div class="thread">{msgs.map((m) => <div class={`msg msg-${m.sender}`}><div>{m.body}</div><div class="muted small">{m.channel} · {fmtDateTime(m.created_at)}</div></div>)}</div>
      </section>
    </div>
  ))
})

async function loadBooking(c: Context<AppEnv>) {
  return first<BookingRow & { property_name: string; address: string | null; lat: number | null; lng: number | null; checkin_time: string; owner_phone: string | null; destination: string }>(
    c.env,
    'SELECT b.*, p.name AS property_name, p.address, p.lat, p.lng, p.checkin_time, p.owner_phone, p.destination FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ?',
    int(c.req.param('id')),
  )
}

opsRoutes.post('/staff/bookings/:id/whatsapp', requirePerm('manage_bookings'), async (c) => {
  const b = await loadBooking(c)
  if (!b) return c.notFound()
  const s = await getSettings(c.env)
  const kind = (c.req.query('kind') ?? 'confirmation') as 'confirmation' | 'checkin' | 'reminder'
  const map = b.lat && b.lng ? `https://maps.google.com/?q=${b.lat},${b.lng}` : `https://maps.google.com/?q=${encodeURIComponent(b.property_name + ' ' + b.destination)}`
  const text = fillTemplate(s.whatsapp_templates[kind] ?? s.whatsapp_templates.confirmation, {
    name: b.guest_name, code: b.code, property: b.property_name, dates: `${fmtDate(b.check_in)} – ${fmtDate(b.check_out)}`, date: fmtDate(b.check_in),
    amount: money(b.amount_paid), time: b.checkin_time, map, address: b.address ?? b.destination, contact: s.business.phone,
  })
  const r = await sendWhatsApp(c.env, b.guest_phone, text)
  await run(c.env, "INSERT INTO messages (booking_id, sender, user_id, channel, body) VALUES (?, 'staff', ?, 'whatsapp', ?)", b.id, c.get('user')!.id, text)
  if (kind === 'reminder' || kind === 'checkin') await run(c.env, 'UPDATE bookings SET reminder_sent_at = ? WHERE id = ?', nowIso(), b.id)
  return redirectMsg(c, c.req.header('referer') ? new URL(c.req.header('referer')!).pathname : `/staff/bookings/${b.id}`, r.ok ? { ok: 'Sent on WhatsApp.' } : { err: `WhatsApp failed: ${r.error}` })
})

opsRoutes.post('/staff/bookings/:id/payment', requirePerm('manage_bookings'), async (c) => {
  const b = await loadBooking(c)
  if (!b) return c.notFound()
  const f = await form(c)
  const r = await recordPayment(c.env, b.id, int(f.amount), f.method, str(f.reference, 80), c.get('user')!.id)
  return redirectMsg(c, `/staff/bookings/${b.id}`, 'error' in r ? { err: r.error } : { ok: 'Payment recorded.' })
})

opsRoutes.post('/staff/bookings/:id/confirm', requirePerm('manage_bookings'), async (c) => {
  const b = await loadBooking(c)
  if (!b) return c.notFound()
  await confirmBooking(c.env, b.id, c.get('user')!.id)
  return redirectMsg(c, `/staff/bookings/${b.id}`, { ok: 'Booking confirmed and the guest notified.' })
})

opsRoutes.post('/staff/bookings/:id/checkin', requirePerm('manage_bookings'), async (c) => {
  await run(c.env, "UPDATE bookings SET status = 'checked_in', updated_at = ? WHERE id = ? AND status = 'confirmed'", nowIso(), int(c.req.param('id')))
  await logActivity(c.env, c.get('user')!.id, 'booking.checked_in', 'booking', c.req.param('id'))
  return c.redirect(c.req.header('referer') ?? '/staff/bookings', 303)
})

opsRoutes.post('/staff/bookings/:id/checkout', requirePerm('manage_bookings'), async (c) => {
  await run(c.env, "UPDATE bookings SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'checked_in'", nowIso(), int(c.req.param('id')))
  return c.redirect(c.req.header('referer') ?? '/staff/bookings', 303)
})

opsRoutes.post('/staff/bookings/:id/notes', requirePerm('manage_bookings'), async (c) => {
  const f = await form(c)
  await run(c.env, 'UPDATE bookings SET special_requests = ?, internal_notes = ?, updated_at = ? WHERE id = ?', str(f.special_requests, 1000), str(f.internal_notes, 2000), nowIso(), int(c.req.param('id')))
  return redirectMsg(c, `/staff/bookings/${c.req.param('id')}`, { ok: 'Notes saved.' })
})

opsRoutes.post('/staff/bookings/:id/change', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const b = await loadBooking(c)
  if (!b) return c.notFound()
  const f = await form(c)
  if (!isDate(f.check_in) || !isDate(f.check_out) || f.check_out <= f.check_in) return redirectMsg(c, `/staff/bookings/${b.id}`, { err: 'Invalid dates.' })
  const roomId = int(f.room_id, b.room_id)
  if (!perms.approve_cancellations) {
    await run(c.env, "UPDATE bookings SET change_request = ?, change_status = 'requested' WHERE id = ?", `CHANGE (staff ${u.name}): room ${roomId}, ${f.check_in} → ${f.check_out}`, b.id)
    await logActivity(c.env, u.id, 'booking.change_requested', 'booking', b.id, { roomId, checkIn: f.check_in, checkOut: f.check_out })
    return redirectMsg(c, `/staff/bookings/${b.id}`, { ok: 'Change sent to admin for approval.' })
  }
  return applyDateChange(c, b, roomId, f.check_in, f.check_out)
})

export async function applyDateChange(c: Context<AppEnv>, b: BookingRow, roomId: number, checkIn: string, checkOut: string) {
  const u = c.get('user')!
  // Availability excluding this booking itself.
  const avail = await roomAvailability(c.env, [b.property_id], checkIn, checkOut, undefined, b.id)
  if ((avail.get(roomId)?.free ?? 0) < b.rooms_count) return redirectMsg(c, `/staff/bookings/${b.id}`, { err: 'Not available for those dates.' })
  const p = await priceStay(c.env, roomId, checkIn, checkOut, b.rooms_count, null, { adults: b.adults, children: b.children, mealPlan: b.meal_plan })
  if (p.errors.length) return redirectMsg(c, `/staff/bookings/${b.id}`, { err: p.errors[0] })
  // Keep the original discount share; price itself comes from the rules.
  const discount = Math.min(p.subtotal, b.discount)
  const taxable = p.subtotal - discount + b.extra_charges
  const taxes = b.apply_gst === 0 ? 0 : Math.round((taxable * p.taxRate) / 100)
  const total = taxable + taxes
  await run(
    c.env,
    `UPDATE bookings SET room_id = ?, check_in = ?, check_out = ?, nights = ?, subtotal = ?, discount = ?, taxes = ?, total = ?,
       payment_status = CASE WHEN amount_paid >= ? THEN 'paid' WHEN amount_paid > 0 THEN 'partial' ELSE payment_status END,
       change_status = CASE WHEN change_status = 'requested' THEN 'approved' ELSE change_status END, updated_at = ? WHERE id = ?`,
    roomId, checkIn, checkOut, p.nights, p.subtotal, discount, taxes, total, total, nowIso(), b.id,
  )
  await storeInvoice(c.env, b.id)
  await logActivity(c.env, u.id, 'booking.dates_changed', 'booking', b.id, { from: [b.check_in, b.check_out, b.total], to: [checkIn, checkOut, total] })
  const diff = total - b.amount_paid
  return redirectMsg(c, `/staff/bookings/${b.id}`, { ok: `Dates changed. New total ${money(total)}${diff > 0 ? ` — ${money(diff)} due (record it when paid)` : diff < 0 ? ` — ${money(-diff)} to refund` : ''}.` })
}

opsRoutes.post('/staff/bookings/:id/cancel', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const b = await loadBooking(c)
  if (!b) return c.notFound()
  const f = await form(c)
  const refund = Math.max(0, Math.min(b.amount_paid, int(f.refund)))
  if (!perms.approve_cancellations) {
    await run(c.env, "UPDATE bookings SET change_request = ?, change_status = 'requested' WHERE id = ?", `CANCEL (staff ${u.name}): ${str(f.reason, 300)}; refund ${refund}`, b.id)
    await logActivity(c.env, u.id, 'booking.cancel_requested', 'booking', b.id, { refund, reason: f.reason })
    return redirectMsg(c, `/staff/bookings/${b.id}`, { ok: 'Cancellation sent to admin for approval.' })
  }
  const r = await cancelBooking(c.env, b.id, u.id, str(f.reason, 300), refund)
  return redirectMsg(c, `/staff/bookings/${b.id}`, 'error' in r ? { err: r.error } : { ok: refund ? 'Cancelled. Refund sent for approval in Payments.' : 'Cancelled.' })
})

// ---------- 27. Availability calendar ----------
opsRoutes.get('/staff/calendar', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const month = /^\d{4}-\d{2}$/.test(c.req.query('month') ?? '') ? c.req.query('month')! : todayIST().slice(0, 7)
  const from = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const days = eachNight(from, to)
  const dest = c.req.query('destination') ?? ''
  const props = await all<{ id: number; name: string; destination: string }>(c.env, `SELECT id, name, destination FROM properties WHERE status != 'draft' ${dest ? 'AND destination = ?' : ''} ORDER BY destination, name`, ...(dest ? [dest] : []))
  const rooms = await all<{ property_id: number; units: number }>(c.env, 'SELECT property_id, units FROM rooms WHERE active = 1')
  const occ = await Promise.all(props.map((p) => monthOccupancy(c.env, p.id, from, to)))
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
  const dests = await destinations(c.env)
  return page(c, { title: 'Availability', area: 'staff', active: 'calendar' }, (
    <div class="stack-lg">
      <div class="row-between">
        <h1>Availability · {new Date(from + 'T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h1>
        <div class="row">
          <a class="btn btn-sm btn-outline" href={`/staff/calendar?month=${prev}&destination=${encodeURIComponent(dest)}`}>←</a>
          <a class="btn btn-sm btn-outline" href={`/staff/calendar?destination=${encodeURIComponent(dest)}`}>Today</a>
          <a class="btn btn-sm btn-outline" href={`/staff/calendar?month=${next}&destination=${encodeURIComponent(dest)}`}>→</a>
        </div>
      </div>
      <form method="get" class="row filters-inline"><input type="hidden" name="month" value={month} /><Select name="destination" value={dest} class="autosubmit" options={[['', 'All destinations'], ...dests.map((d) => [d, d] as [string, string])]} /></form>
      <div class="legend small"><span class="cell cell-open">open</span> <span class="cell cell-part">part booked</span> <span class="cell cell-full">full</span> <span class="cell cell-blocked">blocked / held</span></div>
      <div class="cal-wrap">
        <table class="cal">
          <thead><tr><th>Property</th>{days.map((d) => <th class={[0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) ? 'we' : ''}>{Number(d.slice(8))}</th>)}</tr></thead>
          <tbody>
            {props.map((p, i) => {
              const units = rooms.filter((r) => r.property_id === p.id).reduce((a, r) => a + r.units, 0)
              return (
                <tr>
                  <th><a href={`/staff/calendar/day?property=${p.id}&date=${from}`}>{p.name}</a><div class="muted small">{p.destination}</div></th>
                  {days.map((d) => {
                    const used = occ[i].bookings.filter((b) => b.check_in <= d && d < b.check_out).reduce((a, b) => a + b.rooms_count, 0)
                    const blocks = occ[i].blocks.filter((b) => b.date === d)
                    const blocked = blocks.some((b) => b.room_id == null) ? units : blocks.length
                    const taken = used + blocked
                    const cls = taken >= units ? (blocked && !used ? 'cell-blocked' : 'cell-full') : taken > 0 ? (blocked ? 'cell-blocked' : 'cell-part') : 'cell-open'
                    return <td class={`cell ${cls}`}><a href={`/staff/calendar/day?property=${p.id}&date=${d}`} title={`${d}: ${taken}/${units} taken`}>{units - taken}</a></td>
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {perms.manage_rates && <p class="small"><a href="/admin/rates">Set rates and block dates →</a></p>}
    </div>
  ))
})

opsRoutes.get('/staff/calendar/day', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const pid = int(c.req.query('property'))
  const date = isDate(c.req.query('date')) ? c.req.query('date')! : todayIST()
  const p = await first<{ id: number; name: string }>(c.env, 'SELECT id, name FROM properties WHERE id = ?', pid)
  if (!p) return c.notFound()
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1', pid)
  const occ = await monthOccupancy(c.env, pid, date, addDays(date, 1))
  const quotes = await all<{ id: number; code: string; guest_name: string }>(c.env, "SELECT id, code, guest_name FROM quotations WHERE status IN ('draft','sent','viewed','changes_requested') AND (staff_id = ? OR ?) ORDER BY id DESC LIMIT 30", u.id, perms.view_all_enquiries ? 1 : 0)
  return page(c, { title: `${p.name} · ${fmtDate(date)}`, area: 'staff', active: 'calendar' }, (
    <div class="stack-lg">
      <a href={`/staff/calendar?month=${date.slice(0, 7)}`} class="small">← Calendar</a>
      <div class="row-between"><h1>{p.name}</h1><div class="row"><a class="btn btn-sm btn-outline" href={`?property=${pid}&date=${addDays(date, -1)}`}>←</a><strong>{fmtDate(date)}</strong><a class="btn btn-sm btn-outline" href={`?property=${pid}&date=${addDays(date, 1)}`}>→</a></div></div>
      <section class="card">
        <h3>Staying this night</h3>
        {occ.bookings.length === 0 && <p class="muted">No one.</p>}
        <ul class="plain">{occ.bookings.map((b) => <li><a href={`/staff/bookings/${b.id}`}>{b.code}</a> · {b.guest_name} · {rooms.find((r) => r.id === b.room_id)?.name} × {b.rooms_count} · {fmtShortDate(b.check_in)}–{fmtShortDate(b.check_out)} <Pill s={b.status} /></li>)}</ul>
        <h3>Blocks & holds</h3>
        <ul class="plain">{occ.blocks.map((b) => (
          <li>{b.room_id ? rooms.find((r) => r.id === b.room_id)?.name : 'Whole property'} — {b.reason ?? 'Blocked'}
            {(perms.manage_rates || b.quotation_id) && <form method="post" action={`/staff/calendar/release/${b.id}`} class="inline"> <button class="linklike small">Release</button></form>}
          </li>
        ))}</ul>
      </section>
      <form method="post" action="/staff/calendar/hold" class="card stack">
        <h3>Hold dates for a quote</h3>
        <input type="hidden" name="property_id" value={pid} />
        <div class="row wrap-row">
          <Select name="room_id" options={rooms.map((r) => [r.id, `${r.name} (${r.units} units)`])} />
          <Field label="From"><input type="date" name="from" value={date} required /></Field>
          <Field label="Nights"><input type="number" name="nights" value="1" min="1" max="30" /></Field>
          <Select name="quotation_id" options={[['', 'No quote (manual hold)'], ...quotes.map((q) => [q.id, `${q.code} · ${q.guest_name}`] as [number, string])]} />
          <Field label="Hold for (hours)"><input type="number" name="hours" value="48" min="1" max="336" /></Field>
        </div>
        <button class="btn btn-sm">Hold</button>
      </form>
      {perms.manage_rates && (
        <form method="post" action="/staff/calendar/hold" class="card stack">
          <h3>Block dates (no expiry)</h3>
          <input type="hidden" name="property_id" value={pid} /><input type="hidden" name="block" value="1" />
          <div class="row wrap-row">
            <Select name="room_id" options={[['', 'Whole property'], ...rooms.map((r) => [r.id, r.name] as [number, string])]} />
            <Field label="From"><input type="date" name="from" value={date} required /></Field>
            <Field label="Nights"><input type="number" name="nights" value="1" min="1" max="120" /></Field>
            <input name="reason" placeholder="Reason (maintenance, owner use…)" />
          </div>
          <button class="btn btn-sm btn-outline">Block</button>
        </form>
      )}
    </div>
  ))
})

opsRoutes.post('/staff/calendar/hold', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const f = await form(c)
  const pid = int(f.property_id)
  const from = isDate(f.from) ? f.from : todayIST()
  const nights = Math.max(1, Math.min(120, int(f.nights, 1)))
  const block = f.block === '1'
  if (block && !perms.manage_rates) return c.text('Not allowed', 403)
  const roomId = int(f.room_id) || null
  const quoteId = int(f.quotation_id) || null
  const until = block ? null : new Date(Date.now() + Math.max(1, Math.min(336, int(f.hours, 48))) * 3600_000).toISOString()
  const reason = block ? str(f.reason, 100) || 'Blocked' : `Hold${quoteId ? ` for quote #${quoteId}` : ''} by ${u.name}`
  if (roomId && !block) {
    const avail = await roomAvailability(c.env, [pid], from, addDays(from, nights))
    if ((avail.get(roomId)?.free ?? 0) < 1) return redirectMsg(c, `/staff/calendar/day?property=${pid}&date=${from}`, { err: 'No free unit to hold on those dates.' })
  }
  for (let i = 0; i < nights; i++) {
    await run(c.env, 'INSERT INTO blocked_dates (property_id, room_id, date, reason, quotation_id, hold_until, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', pid, roomId, addDays(from, i), reason, quoteId, until, u.id)
  }
  await logActivity(c.env, u.id, block ? 'dates.blocked' : 'dates.held', 'property', pid, { from, nights, roomId, quoteId })
  return redirectMsg(c, `/staff/calendar/day?property=${pid}&date=${from}`, { ok: block ? 'Dates blocked.' : 'Dates held.' })
})

opsRoutes.post('/staff/calendar/release/:id', requirePerm('manage_bookings'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const b = await first<{ id: number; property_id: number; date: string; quotation_id: number | null; hold_until: string | null }>(c.env, 'SELECT * FROM blocked_dates WHERE id = ?', int(c.req.param('id')))
  if (!b) return c.notFound()
  if (!b.hold_until && !perms.manage_rates) return c.text('Not allowed', 403)
  await run(c.env, 'DELETE FROM blocked_dates WHERE id = ?', b.id)
  await logActivity(c.env, u.id, 'dates.released', 'property', b.property_id, { date: b.date })
  return c.redirect(`/staff/calendar/day?property=${b.property_id}&date=${b.date}`, 303)
})
