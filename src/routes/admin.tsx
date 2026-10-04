// Admin pages 31–40: dashboard, properties, rates, offers, all enquiries/quotes/bookings, payments, guests.

import { Hono } from 'hono'
import { stayTypeLabel } from '../lib/catalog'
import type { AppEnv } from '../env'
import { COVER_PHOTO_SQL } from '../lib/catalog'
import { page } from '../views/layout'
import { AiNote, ChartHead, Empty, Field, jsonScript, Pager, Pill, Select, Stat, Table, Tabs } from '../views/components'
import { permissionsFor, requirePerm, requireStaff } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, run } from '../lib/db'
import { cancelBooking, processRefund } from '../lib/bookings'
import { mediaUrl } from '../lib/integrations'
import { nightlyRate, type SeasonRate, SEASON_KINDS, seasonKindLabel } from '../lib/pricing'
import type { PropertyRow, RoomRow } from '../lib/types'
import { addDays, eachNight, fmtDate, fmtDateTime, int, isDate, money, moneyShort, nowIso, parseJson, str, toCsv, todayIST } from '../lib/util'
import { form, pageNum, redirectMsg } from './helpers'
import { renderBookings, renderQuotes } from './staff-ops'
import { renderGuests, renderInbox } from './staff'
import { destinations } from '../lib/properties'

export const adminRoutes = new Hono<AppEnv>()
adminRoutes.use('/admin', requireStaff)
adminRoutes.use('/admin/*', requireStaff)

const CONFIRMED = "status IN ('confirmed','checked_in','completed')"

function periodStart(p: string): string {
  const today = todayIST()
  const d = p === 'week' ? addDays(today, -6) : p === 'month' ? addDays(today, -29) : today
  return new Date(Date.parse(d + 'T00:00:00+05:30')).toISOString()
}

// ---------- 31. Admin dashboard ----------
adminRoutes.get('/admin', async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  if (!perms.view_reports) return c.redirect(perms.manage_payments ? '/admin/payments' : '/staff')
  const period = ['today', 'week', 'month'].includes(c.req.query('p') ?? '') ? c.req.query('p')! : 'today'
  const since = periodStart(period)
  const since30 = periodStart('month')
  const [k, series, byProp, bySource, unanswered, accepted, lowReviews, noAvail, activity, summary] = await Promise.all([
    first<{ enquiries: number; bookings: number; revenue: number; booked_enq: number }>(
      c.env,
      `SELECT (SELECT COUNT(*) FROM enquiries WHERE created_at >= ?) AS enquiries,
              (SELECT COUNT(*) FROM bookings WHERE ${CONFIRMED} AND created_at >= ?) AS bookings,
              (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'paid' AND updated_at >= ?) AS revenue,
              (SELECT COUNT(*) FROM enquiries WHERE created_at >= ? AND status = 'booked') AS booked_enq`,
      since, since, since, since,
    ),
    all<{ d: string; n: number; rev: number }>(c.env, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, SUM(total) AS rev FROM bookings WHERE ${CONFIRMED} AND created_at >= ? GROUP BY d ORDER BY d`, since30),
    all<{ name: string; rev: number }>(c.env, `SELECT p.name, SUM(b.total) AS rev FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.${CONFIRMED.replace('status', 'status')} AND b.created_at >= ? GROUP BY p.id ORDER BY rev DESC LIMIT 10`, since30),
    all<{ source: string; n: number }>(c.env, 'SELECT source, COUNT(*) AS n FROM enquiries WHERE created_at >= ? GROUP BY source', since30),
    all<{ id: number; guest_name: string; code: string; last: string }>(c.env, "SELECT id, guest_name, code, COALESCE(last_guest_msg_at, created_at) AS last FROM enquiries WHERE waiting_on = 'us' AND status IN ('new','in_progress','quoted') AND COALESCE(last_guest_msg_at, created_at) < ? ORDER BY last LIMIT 10", new Date(Date.now() - 3 * 3600_000).toISOString()),
    all<{ id: number; code: string; guest_name: string }>(c.env, "SELECT q.id, q.code, q.guest_name FROM quotations q WHERE q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.quotation_id = q.id AND b.status != 'cancelled') ORDER BY q.updated_at LIMIT 10"),
    all<{ id: number; rating: number; property_name: string; body: string }>(c.env, "SELECT r.id, r.rating, p.name AS property_name, r.body FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.rating <= 2 AND r.created_at >= ? ORDER BY r.id DESC LIMIT 10", new Date(Date.now() - 14 * 86400_000).toISOString()),
    all<{ id: number; name: string }>(c.env, "SELECT id, name FROM properties p WHERE status = 'live' AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.property_id = p.id AND r.active = 1 AND r.base_rate > 0)"),
    all<{ name: string; n: number; last: string }>(c.env, 'SELECT u.name, COUNT(*) AS n, MAX(a.created_at) AS last FROM activity_log a JOIN users u ON u.id = a.user_id WHERE a.created_at >= ? AND u.role != \'guest\' GROUP BY u.id ORDER BY n DESC LIMIT 10', new Date(Date.now() - 86400_000).toISOString()),
    first<{ body: string; period: string }>(c.env, "SELECT body, period FROM insights WHERE kind = 'daily_summary' ORDER BY id DESC LIMIT 1"),
  ])
  const conv = k?.enquiries ? Math.round(((k.booked_enq ?? 0) / k.enquiries) * 100) : 0
  const days = eachNight(todayIST(-29), todayIST(1))
  const chart = {
    days: days.map((d) => d.slice(5)),
    bookings: days.map((d) => series.find((s) => s.d === d)?.n ?? 0),
    revenueByProp: { labels: byProp.map((p) => p.name), values: byProp.map((p) => p.rev) },
    sources: { labels: bySource.map((s) => s.source), values: bySource.map((s) => s.n) },
  }
  return page(c, { title: 'Admin dashboard', area: 'admin', active: 'admin', head: <ChartHead /> }, (
    <div class="stack-lg">
      <div class="row-between">
        <h1>Overview</h1>
        <Tabs base="/admin" param="p" active={period} items={[['today', 'Today'], ['week', '7 days'], ['month', '30 days']]} />
      </div>
      {summary && <AiNote label={`Daily summary (${summary.period})`}>{summary.body}</AiNote>}
      <div class="stats">
        <Stat label="Enquiries" value={k?.enquiries ?? 0} href="/admin/enquiries" />
        <Stat label="Bookings" value={k?.bookings ?? 0} href="/admin/bookings" />
        <Stat label="Revenue collected" value={moneyShort(k?.revenue ?? 0)} href="/admin/payments" />
        <Stat label="Conversion" value={`${conv}%`} hint="enquiries → booked" />
      </div>
      <div class="grid grid-2">
        <div class="card"><h3>Bookings, last 30 days</h3><canvas id="ch-bookings" height="180"></canvas></div>
        <div class="card"><h3>Revenue by property (30 days)</h3><canvas id="ch-revenue" height="180"></canvas></div>
        <div class="card"><h3>Enquiries by source (30 days)</h3><canvas id="ch-sources" height="180"></canvas></div>
        <div class="card">
          <h3>Alerts</h3>
          <ul class="alerts">
            {unanswered.map((e) => <li class="alert-red"><a href={`/staff/enquiries/${e.id}`}>{e.guest_name} ({e.code})</a> waiting since {fmtDateTime(e.last)}</li>)}
            {accepted.map((q) => <li class="alert-red"><a href={`/staff/quotes/${q.id}`}>{q.guest_name} accepted {q.code}</a> — confirm the booking</li>)}
            {lowReviews.map((r) => <li class="alert-amber"><a href="/admin/reviews">{r.rating}★ review</a> for {r.property_name}: “{r.body.slice(0, 60)}…”</li>)}
            {noAvail.map((p) => <li class="alert-amber"><a href={`/admin/properties/${p.id}`}>{p.name}</a> has no rooms or rates set</li>)}
            {!unanswered.length && !accepted.length && !lowReviews.length && !noAvail.length && <li class="muted">All clear.</li>}
          </ul>
        </div>
      </div>
      <section class="card">
        <h3>Staff activity (24h)</h3>
        <Table head={['Staff', 'Actions', 'Last active']}>{activity.map((a) => <tr><td>{a.name}</td><td>{a.n}</td><td>{fmtDateTime(a.last)}</td></tr>)}</Table>
        <a href="/admin/activity" class="small">Full activity log →</a>
      </section>
      {jsonScript('dash-data', chart)}
    </div>
  ))
})

// ---------- 32. Properties list ----------
adminRoutes.get('/admin/properties', requirePerm('manage_properties'), async (c) => {
  const q = str(c.req.query('q'), 60)
  const status = c.req.query('status') ?? ''
  const dest = c.req.query('destination') ?? ''
  const monthStart = todayIST().slice(0, 7) + '-01'
  const rows = await all<PropertyRow & { photo: string | null; bookings: number }>(
    c.env,
    `SELECT p.*, ${COVER_PHOTO_SQL} AS photo,
       (SELECT COUNT(*) FROM bookings b WHERE b.property_id = p.id AND b.${CONFIRMED} AND b.check_in >= ?) AS bookings
     FROM properties p WHERE 1=1 ${q ? 'AND p.name LIKE ?' : ''} ${status ? 'AND p.status = ?' : ''} ${dest ? 'AND p.destination = ?' : ''} ORDER BY p.destination, p.name`,
    monthStart, ...(q ? [`%${q}%`] : []), ...(status ? [status] : []), ...(dest ? [dest] : []),
  )
  const dests = await destinations(c.env)
  return page(c, { title: 'Properties', area: 'admin', active: 'properties' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>Properties</h1><a class="btn" href="/admin/properties/new">+ Add property</a></div>
      <form method="get" class="row filters-inline wrap-row">
        <input name="q" value={q} placeholder="Search name" />
        <Select name="status" value={status} options={[['', 'Any status'], ['live', 'Live'], ['hidden', 'Hidden'], ['draft', 'Draft']]} />
        <Select name="destination" value={dest} options={[['', 'Any destination'], ...dests.map((d) => [d, d] as [string, string])]} />
        <button class="btn btn-sm">Filter</button>
      </form>
      <Table head={['', 'Name', 'Location', 'Type', 'Status', 'Rating', 'Bookings this month', 'Actions']}>
        {rows.map((p) => (
          <tr>
            <td><img class="thumb" src={mediaUrl(p.photo, 120)} alt="" /></td>
            <td><a href={`/admin/properties/${p.id}`}><strong>{p.name}</strong></a>{p.featured ? <span class="pill pill-accepted">featured</span> : null}</td>
            <td>{p.destination}</td><td>{stayTypeLabel(p)}</td><td><Pill s={p.status} /></td>
            <td>★ {p.rating_avg.toFixed(1)} ({p.rating_count})</td><td>{p.bookings}</td>
            <td class="nowrap">
              <a class="btn btn-sm" href={`/admin/properties/${p.id}`}>Edit</a>
              <a class="btn btn-sm btn-outline" href={`/stay/${p.slug}`} target="_blank">View</a>
              <form method="post" action={`/admin/properties/${p.id}/status`} class="inline"><input type="hidden" name="status" value={p.status === 'live' ? 'hidden' : 'live'} /><button class="btn btn-sm btn-outline">{p.status === 'live' ? 'Hide' : 'Publish'}</button></form>
              <form method="post" action={`/admin/properties/${p.id}/duplicate`} class="inline"><button class="btn btn-sm btn-outline">Duplicate</button></form>
            </td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <Empty>No properties yet.</Empty>}
    </div>
  ))
})

adminRoutes.post('/admin/properties/:id/status', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  const id = int(c.req.param('id'))
  const s = ['live', 'hidden', 'draft'].includes(f.status) ? f.status : 'hidden'
  await run(c.env, 'UPDATE properties SET status = ?, updated_at = ? WHERE id = ?', s, nowIso(), id)
  await enqueue(c.env, { type: 'embed_property', propertyId: id })
  await enqueue(c.env, { type: 'sync_kb', what: 'property', id })
  await logActivity(c.env, c.get('user')!.id, 'property.status', 'property', id, { status: s })
  return c.redirect(c.req.header('referer') ?? '/admin/properties', 303)
})

adminRoutes.post('/admin/properties/:id/duplicate', requirePerm('manage_properties'), async (c) => {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', int(c.req.param('id')))
  if (!p) return c.notFound()
  const slug = `${p.slug}-copy-${Date.now().toString(36)}`
  const id = await insertId(
    c.env,
    `INSERT INTO properties (slug, name, type, stay_type, destination, address, map_url, lat, lng, owner_name, owner_phone, owner_email, is_partner, commission_pct, highlights, description, description_ml, facilities, meal_plans, checkin_time, checkout_time, cancellation_policy, house_rules, id_required, nearby, pet_friendly, family_friendly, internal_notes, star_category, built_year, themes, languages, how_to_reach, best_time, good_to_know, dining, policies, contact, status)
     SELECT ?, name || ' (copy)', type, stay_type, destination, address, map_url, lat, lng, owner_name, owner_phone, owner_email, is_partner, commission_pct, highlights, description, description_ml, facilities, meal_plans, checkin_time, checkout_time, cancellation_policy, house_rules, id_required, nearby, pet_friendly, family_friendly, internal_notes, star_category, built_year, themes, languages, how_to_reach, best_time, good_to_know, dining, policies, contact, 'draft' FROM properties WHERE id = ?`,
    slug, p.id,
  )
  await run(c.env, 'INSERT INTO rooms (property_id, name, capacity, bed_type, facilities, inclusions, units, base_rate, weekend_rate, net_rate, staff_rate, min_nights, description, size_sqft, room_view, max_adults, max_children, extra_bed, extra_bed_rate) SELECT ?, name, capacity, bed_type, facilities, inclusions, units, base_rate, weekend_rate, net_rate, staff_rate, min_nights, description, size_sqft, room_view, max_adults, max_children, extra_bed, extra_bed_rate FROM rooms WHERE property_id = ? AND active = 1', id, p.id)
  await logActivity(c.env, c.get('user')!.id, 'property.duplicated', 'property', id, { from: p.id })
  return c.redirect(`/admin/properties/${id}`, 303)
})

// ---------- 33. Add / edit property: see admin-properties.tsx ----------

// ---------- 34. Rates and availability ----------
adminRoutes.get('/admin/rates', requirePerm('manage_rates'), async (c) => {
  const props = await all<{ id: number; name: string }>(c.env, 'SELECT id, name FROM properties ORDER BY name')
  const pid = int(c.req.query('property')) || props[0]?.id
  const month = /^\d{4}-\d{2}$/.test(c.req.query('month') ?? '') ? c.req.query('month')! : todayIST().slice(0, 7)
  const from = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const days = eachNight(from, to)
  const rooms = pid ? await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', pid) : []
  const seasons = await all<SeasonRate & { id: number; property_name: string | null; room_name: string | null }>(
    c.env,
    'SELECT s.*, p.name AS property_name, r.name AS room_name FROM season_rates s LEFT JOIN properties p ON p.id = s.property_id LEFT JOIN rooms r ON r.id = s.room_id WHERE (s.property_id = ? OR s.property_id IS NULL) AND s.end_date >= ? ORDER BY s.start_date',
    pid ?? 0, todayIST(),
  )
  const blocks = pid ? await all<{ room_id: number | null; date: string; reason: string | null }>(c.env, 'SELECT room_id, date, reason FROM blocked_dates WHERE property_id = ? AND date >= ? AND date < ? AND hold_until IS NULL', pid, from, to) : []
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7)
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
  return page(c, { title: 'Rates & availability', area: 'admin', active: 'rates' }, (
    <div class="stack-lg">
      <h1>Rates and availability</h1>
      <p class="muted">Rates are rule-based: base → weekend (Fri & Sat nights) → season rates. No AI.</p>
      <form method="get" class="row filters-inline">
        <Select name="property" value={pid} class="autosubmit" options={props.map((p) => [p.id, p.name])} />
        <input type="hidden" name="month" value={month} />
        <a class="btn btn-sm btn-outline" href={`/admin/rates?property=${pid}&month=${prev}`}>←</a>
        <strong>{month}</strong>
        <a class="btn btn-sm btn-outline" href={`/admin/rates?property=${pid}&month=${next}`}>→</a>
      </form>
      <div class="cal-wrap card">
        <table class="cal rates-cal">
          <thead><tr><th>Room</th>{days.map((d) => <th class={[5, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) ? 'we' : ''}>{Number(d.slice(8))}</th>)}</tr></thead>
          <tbody>
            {rooms.map((r) => (
              <tr>
                <th>{r.name}<div class="muted small">base {money(r.base_rate)}</div></th>
                {days.map((d) => {
                  const line = nightlyRate(r, seasons, d)
                  const blocked = blocks.some((b) => b.date === d && (b.room_id == null || b.room_id === r.id))
                  return <td class={`cell ${blocked ? 'cell-blocked' : line.label !== 'Standard' ? 'cell-season' : ''}`} title={`${line.label}${blocked ? ' · blocked' : ''}`}>{blocked ? '✕' : (line.rate / 1000).toFixed(1) + 'k'}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {pid && <p class="small"><a href={`/admin/properties/${pid}`}>Edit base / weekend rates and minimum nights per room →</a></p>}
      </div>

      <div class="grid grid-2">
        <form method="post" action="/admin/rates/season" class="card stack">
          <h3>Add season or special rate</h3>
          <div class="row wrap-row">
            <Field label="Name"><input name="name" placeholder="Onam, Christmas, Summer…" required /></Field>
            <Field label="Type"><Select name="kind" options={Object.entries(SEASON_KINDS)} /></Field>
          </div>
          <div class="row">
            <Field label="From"><input type="date" name="start_date" required /></Field>
            <Field label="To (last night)"><input type="date" name="end_date" required /></Field>
          </div>
          <Field label="Applies to">
            <Select name="scope" value={pid ? `p${pid}` : 'all'} options={[['all', 'All properties'], ...(pid ? [[`p${pid}`, 'This property (all rooms)'] as [string, string]] : []), ...rooms.map((r) => [`r${r.id}`, `Room: ${r.name}`] as [string, string])]} />
          </Field>
          <div class="row">
            <Field label="Fixed rate ₹/night" hint="Leave empty to use a % change"><input type="number" name="rate" min="0" /></Field>
            <Field label="or % change" hint="e.g. 10 or -15"><input type="number" name="pct_adjust" step="0.5" /></Field>
            <Field label="Minimum nights"><input type="number" name="min_nights" min="1" /></Field>
          </div>
          <input type="hidden" name="property" value={pid} />
          <button class="btn">Add rate</button>
          <p class="muted small">Bulk update example: “+10% for all properties 20–31 Dec” → All properties, 10%.</p>
        </form>
        <form method="post" action="/admin/rates/block" class="card stack">
          <h3>Block dates</h3>
          <input type="hidden" name="property_id" value={pid} />
          <Field label="Room"><Select name="room_id" options={[['', 'Whole property'], ...rooms.map((r) => [r.id, r.name] as [number, string])]} /></Field>
          <div class="row">
            <Field label="From"><input type="date" name="from" required /></Field>
            <Field label="To (last night)"><input type="date" name="to" required /></Field>
          </div>
          <Field label="Reason"><input name="reason" placeholder="Maintenance, owner use…" /></Field>
          <div class="row"><button class="btn btn-outline">Block</button><button class="btn btn-outline" name="unblock" value="1">Unblock these dates</button></div>
        </form>
      </div>
      <section class="card">
        <h3>Season and special rates</h3>
        <Table head={['Name', 'Type', 'Dates', 'Applies to', 'Rate', 'Min nights', '']}>
          {seasons.map((s) => (
            <tr>
              <td>{s.name}</td><td><span class={`pill pill-kind-${s.kind ?? 'season'}`}>{seasonKindLabel(s.kind)}</span></td><td>{fmtDate(s.start_date)} – {fmtDate(s.end_date)}</td>
              <td>{s.room_name ? `${s.property_name} · ${s.room_name}` : s.property_name ?? 'All properties'}</td>
              <td>{s.rate ? money(s.rate) : `${(s.pct_adjust ?? 0) > 0 ? '+' : ''}${s.pct_adjust}%`}</td><td>{s.min_nights ?? '—'}</td>
              <td><form method="post" action={`/admin/rates/season/${s.id}/delete`} class="inline"><button class="linklike small">Delete</button></form></td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  ))
})

adminRoutes.post('/admin/rates/season', requirePerm('manage_rates'), async (c) => {
  const f = await form(c)
  if (!isDate(f.start_date) || !isDate(f.end_date) || f.end_date < f.start_date) return redirectMsg(c, `/admin/rates?property=${f.property}`, { err: 'Check the dates.' })
  const rate = int(f.rate) || null
  const pct = f.pct_adjust ? parseFloat(f.pct_adjust) : null
  if (!rate && (pct == null || !Number.isFinite(pct))) return redirectMsg(c, `/admin/rates?property=${f.property}`, { err: 'Enter a fixed rate or a % change.' })
  let propertyId: number | null = null
  let roomId: number | null = null
  if (f.scope.startsWith('p')) propertyId = int(f.scope.slice(1))
  if (f.scope.startsWith('r')) {
    roomId = int(f.scope.slice(1))
    propertyId = (await first<{ property_id: number }>(c.env, 'SELECT property_id FROM rooms WHERE id = ?', roomId))?.property_id ?? null
  }
  const id = await insertId(c.env, 'INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, pct_adjust, min_nights, created_by, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', propertyId, roomId, str(f.name, 60), f.start_date, f.end_date, rate, rate ? null : pct, int(f.min_nights) || null, c.get('user')!.id, f.kind in SEASON_KINDS ? f.kind : 'season')
  await logActivity(c.env, c.get('user')!.id, 'price.season_added', 'season_rate', id, { scope: f.scope, rate, pct, from: f.start_date, to: f.end_date })
  return redirectMsg(c, `/admin/rates?property=${f.property}&month=${f.start_date.slice(0, 7)}`, { ok: 'Rate added.' })
})

adminRoutes.post('/admin/rates/season/:id/delete', requirePerm('manage_rates'), async (c) => {
  const s = await first<SeasonRate & { id: number }>(c.env, 'SELECT * FROM season_rates WHERE id = ?', int(c.req.param('id')))
  if (!s) return c.notFound()
  await run(c.env, 'DELETE FROM season_rates WHERE id = ?', s.id)
  await logActivity(c.env, c.get('user')!.id, 'price.season_deleted', 'season_rate', s.id, s)
  return c.redirect(c.req.header('referer') ?? '/admin/rates', 303)
})

adminRoutes.post('/admin/rates/block', requirePerm('manage_rates'), async (c) => {
  const f = await form(c)
  const pid = int(f.property_id)
  if (!isDate(f.from) || !isDate(f.to) || f.to < f.from) return redirectMsg(c, `/admin/rates?property=${pid}`, { err: 'Check the dates.' })
  const roomId = int(f.room_id) || null
  const nights = eachNight(f.from, addDays(f.to, 1)).slice(0, 366)
  if (f.unblock) {
    await run(c.env, `DELETE FROM blocked_dates WHERE property_id = ? AND hold_until IS NULL AND date >= ? AND date <= ? AND ${roomId ? 'room_id = ?' : 'room_id IS NULL'}`, pid, f.from, f.to, ...(roomId ? [roomId] : []))
  } else {
    for (const d of nights) await run(c.env, 'INSERT INTO blocked_dates (property_id, room_id, date, reason, created_by) VALUES (?, ?, ?, ?, ?)', pid, roomId, d, str(f.reason, 100) || 'Blocked', c.get('user')!.id)
  }
  await logActivity(c.env, c.get('user')!.id, f.unblock ? 'dates.unblocked' : 'dates.blocked', 'property', pid, { from: f.from, to: f.to, roomId })
  return redirectMsg(c, `/admin/rates?property=${pid}&month=${f.from.slice(0, 7)}`, { ok: f.unblock ? 'Unblocked.' : 'Blocked.' })
})

// ---------- 35. Offers and coupons ----------
adminRoutes.get('/admin/offers', requirePerm('manage_offers'), async (c) => {
  const rows = await all<{ id: number; code: string; title: string; discount_type: string; discount_value: number; max_discount: number | null; min_amount: number; valid_from: string; valid_to: string; property_ids: string | null; usage_limit: number | null; used_count: number; active: number; public: number; revenue: number; discount_given: number }>(
    c.env,
    `SELECT c.*, (SELECT COALESCE(SUM(total),0) FROM bookings b WHERE b.coupon_code = c.code AND b.${CONFIRMED}) AS revenue,
       (SELECT COALESCE(SUM(discount),0) FROM bookings b WHERE b.coupon_code = c.code AND b.${CONFIRMED}) AS discount_given
     FROM coupons c ORDER BY c.active DESC, c.valid_to DESC`,
  )
  const props = await all<{ id: number; name: string }>(c.env, 'SELECT id, name FROM properties ORDER BY name')
  return page(c, { title: 'Offers & coupons', area: 'admin', active: 'offers' }, (
    <div class="stack-lg">
      <h1>Offers and coupons</h1>
      <Table head={['Code', 'Offer', 'Valid', 'Applies to', 'Used', 'Revenue', 'Discount given', '']}>
        {rows.map((o) => {
          const ids = parseJson<number[] | null>(o.property_ids, null)
          return (
            <tr class={o.active ? '' : 'muted'}>
              <td><code>{o.code}</code>{!o.public && <span class="pill">private</span>}</td>
              <td>{o.title}<div class="small">{o.discount_type === 'pct' ? `${o.discount_value}%` : money(o.discount_value)}{o.max_discount ? ` (max ${money(o.max_discount)})` : ''}{o.min_amount ? ` · min ${money(o.min_amount)}` : ''}</div></td>
              <td class="small">{fmtDate(o.valid_from)} – {fmtDate(o.valid_to)}</td>
              <td class="small">{ids?.length ? ids.map((id) => props.find((p) => p.id === id)?.name).join(', ') : 'All'}</td>
              <td>{o.used_count}{o.usage_limit ? ` / ${o.usage_limit}` : ''}</td>
              <td>{money(o.revenue)}</td><td>{money(o.discount_given)}</td>
              <td><form method="post" action={`/admin/offers/${o.id}/toggle`} class="inline"><button class="btn btn-sm btn-outline">{o.active ? 'Deactivate' : 'Activate'}</button></form></td>
            </tr>
          )
        })}
      </Table>
      <form method="post" action="/admin/offers" class="card stack">
        <h2>Create coupon</h2>
        <div class="row">
          <Field label="Code"><input name="code" required pattern="[A-Za-z0-9_-]{3,20}" placeholder="MONSOON15" /></Field>
          <Field label="Title"><input name="title" placeholder="Monsoon special" /></Field>
        </div>
        <Field label="Description"><input name="description" /></Field>
        <div class="row">
          <Field label="Type"><Select name="discount_type" options={[['pct', '% off'], ['flat', '₹ off']]} /></Field>
          <Field label="Value"><input type="number" name="discount_value" min="1" step="0.5" required /></Field>
          <Field label="Max discount ₹"><input type="number" name="max_discount" min="0" /></Field>
          <Field label="Min booking ₹"><input type="number" name="min_amount" min="0" value="0" /></Field>
        </div>
        <div class="row">
          <Field label="Valid from"><input type="date" name="valid_from" required value={todayIST()} /></Field>
          <Field label="Valid to"><input type="date" name="valid_to" required /></Field>
          <Field label="Usage limit"><input type="number" name="usage_limit" min="1" /></Field>
        </div>
        <Field label="Properties (none ticked = all)"><div class="facility-grid">{props.map((p) => <label class="check"><input type="checkbox" name="property_ids" value={p.id} /> {p.name}</label>)}</div></Field>
        <label class="check"><input type="checkbox" name="public" value="1" checked /> Show on Offers page</label>
        <button class="btn">Create coupon</button>
      </form>
    </div>
  ))
})

adminRoutes.post('/admin/offers', requirePerm('manage_offers'), async (c) => {
  const f = await form(c)
  const code = str(f.code, 20).toUpperCase()
  if (!/^[A-Z0-9_-]{3,20}$/.test(code) || !isDate(f.valid_from) || !isDate(f.valid_to)) return redirectMsg(c, '/admin/offers', { err: 'Check the code and dates.' })
  const ids = (f.__all.property_ids ?? []).map(Number).filter(Boolean)
  try {
    const id = await insertId(
      c.env,
      'INSERT INTO coupons (code, title, description, discount_type, discount_value, max_discount, min_amount, valid_from, valid_to, property_ids, usage_limit, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      code, str(f.title, 80), str(f.description, 300), f.discount_type === 'flat' ? 'flat' : 'pct', parseFloat(f.discount_value) || 0, int(f.max_discount) || null, int(f.min_amount),
      f.valid_from, f.valid_to, ids.length ? JSON.stringify(ids) : null, int(f.usage_limit) || null, f.public ? 1 : 0,
    )
    await logActivity(c.env, c.get('user')!.id, 'coupon.created', 'coupon', id, { code, value: f.discount_value, type: f.discount_type })
  } catch {
    return redirectMsg(c, '/admin/offers', { err: 'That code already exists.' })
  }
  return redirectMsg(c, '/admin/offers', { ok: 'Coupon created.' })
})

adminRoutes.post('/admin/offers/:id/toggle', requirePerm('manage_offers'), async (c) => {
  await run(c.env, 'UPDATE coupons SET active = 1 - active WHERE id = ?', int(c.req.param('id')))
  await logActivity(c.env, c.get('user')!.id, 'coupon.toggled', 'coupon', c.req.param('id'))
  return c.redirect('/admin/offers', 303)
})

// ---------- 36–38. All enquiries / quotations / bookings ----------
adminRoutes.get('/admin/enquiries', requirePerm('view_all_enquiries'), (c) => renderInbox(c, { admin: true }))
adminRoutes.get('/admin/quotes', requirePerm('approve_discounts'), (c) => renderQuotes(c, true))

adminRoutes.post('/admin/quotes/:id/approve', requirePerm('approve_discounts'), async (c) => {
  const id = int(c.req.param('id'))
  const u = c.get('user')!
  await run(c.env, 'UPDATE quotation_options SET discount_approved_by = ? WHERE quotation_id = ?', u.id, id)
  await run(c.env, "UPDATE quotations SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'pending_approval'", nowIso(), id)
  const q = await first<{ staff_id: number | null; code: string; guest_name: string }>(c.env, 'SELECT staff_id, code, guest_name FROM quotations WHERE id = ?', id)
  if (q?.staff_id) await run(c.env, 'INSERT INTO tasks (assigned_to, quotation_id, guest_name, reason, due_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', q.staff_id, id, q.guest_name, `Price approved on ${q.code} — send it now`, nowIso(), u.id)
  await logActivity(c.env, u.id, 'quote.discount_approved', 'quotation', id)
  return redirectMsg(c, '/admin/quotes', { ok: 'Approved. The staff member can now send the quote.' })
})

adminRoutes.get('/admin/bookings', requirePerm('approve_cancellations'), (c) => renderBookings(c, true))

adminRoutes.get('/admin/bookings/export', requirePerm('export_data'), async (c) => {
  const from = isDate(c.req.query('from')) ? c.req.query('from')! : '0000-01-01'
  const to = isDate(c.req.query('to')) ? c.req.query('to')! : '9999-12-31'
  const rows = await all<Record<string, unknown>>(
    c.env,
    `SELECT b.code, b.created_at, p.name AS property, r.name AS room, b.check_in, b.check_out, b.nights, b.adults, b.children, b.rooms_count,
       b.guest_name, b.guest_phone, b.guest_email, b.subtotal, b.discount, b.extra_charges, b.taxes, b.total, b.amount_paid, b.coupon_code,
       b.status, b.payment_status, b.source, s.name AS staff
     FROM bookings b JOIN properties p ON p.id = b.property_id JOIN rooms r ON r.id = b.room_id LEFT JOIN users s ON s.id = b.staff_id
     WHERE b.check_in >= ? AND b.check_in <= ? ${int(c.req.query('property')) ? 'AND b.property_id = ' + int(c.req.query('property')) : ''} ORDER BY b.check_in`,
    from, to,
  )
  await logActivity(c.env, c.get('user')!.id, 'export.bookings', 'booking', null, { rows: rows.length })
  return new Response('﻿' + toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="bookings-${todayIST()}.csv"` } })
})

adminRoutes.post('/admin/bookings/:id/reject-request', requirePerm('approve_cancellations'), async (c) => {
  const id = int(c.req.param('id'))
  await run(c.env, "UPDATE bookings SET change_status = 'rejected' WHERE id = ?", id)
  await logActivity(c.env, c.get('user')!.id, 'booking.request_rejected', 'booking', id)
  return redirectMsg(c, `/staff/bookings/${id}`, { ok: 'Request rejected. Let the guest know.' })
})

adminRoutes.post('/admin/bookings/:id/approve-cancel', requirePerm('approve_cancellations'), async (c) => {
  const id = int(c.req.param('id'))
  const f = await form(c)
  const r = await cancelBooking(c.env, id, c.get('user')!.id, str(f.reason, 300) || 'Approved cancellation request', int(f.refund))
  await run(c.env, "UPDATE bookings SET change_status = 'approved' WHERE id = ?", id)
  return redirectMsg(c, `/staff/bookings/${id}`, 'error' in r ? { err: r.error } : { ok: 'Cancelled.' })
})

// ---------- 39. Payments and refunds ----------
adminRoutes.get('/admin/payments', requirePerm('manage_payments'), async (c) => {
  const tab = c.req.query('tab') ?? 'refunds'
  const pg = pageNum(c)
  const statusMap: Record<string, string> = { received: 'paid', refunded: 'refunded' }
  const due = tab === 'due'
    ? await all<{ id: number; code: string; guest_name: string; guest_phone: string; check_in: string; total: number; amount_paid: number }>(c.env, "SELECT id, code, guest_name, guest_phone, check_in, total, amount_paid FROM bookings WHERE status IN ('confirmed','checked_in','completed') AND amount_paid < total ORDER BY check_in LIMIT 200")
    : []
  const [totals, refunds, payments, payouts, mismatched] = await Promise.all([
    first<{ received: number; pending: number; unpaid: number; refunded: number }>(
      c.env,
      `SELECT (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'paid') AS received,
              (SELECT COALESCE(SUM(total - amount_paid),0) FROM bookings WHERE status IN ('confirmed','checked_in') AND amount_paid < total) AS pending,
              (SELECT COUNT(*) FROM bookings WHERE status IN ('confirmed','checked_in','completed') AND amount_paid < total) AS unpaid,
              (SELECT COALESCE(SUM(amount),0) FROM refunds WHERE status = 'processed') AS refunded`,
    ),
    all<{ id: number; booking_id: number; code: string; guest_name: string; amount: number; reason: string; status: string; created_at: string; requested_by_name: string | null; paid: number }>(
      c.env,
      "SELECT r.*, b.code, b.guest_name, b.amount_paid AS paid, u.name AS requested_by_name FROM refunds r JOIN bookings b ON b.id = r.booking_id LEFT JOIN users u ON u.id = r.requested_by ORDER BY (r.status = 'requested') DESC, r.id DESC LIMIT 50",
    ),
    tab in statusMap
      ? all<{ id: number; booking_id: number; code: string; guest_name: string; amount: number; status: string; gateway: string; gateway_payment_id: string | null; created_at: string; failure_reason: string | null }>(
          c.env,
          'SELECT p.*, b.code, b.guest_name FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.status = ? ORDER BY p.id DESC LIMIT 51 OFFSET ?',
          statusMap[tab], (pg - 1) * 50,
        )
      : Promise.resolve([]),
    all<{ id: number; property_name: string; code: string | null; amount: number; status: string; created_at: string; reference: string | null }>(c.env, "SELECT po.*, p.name AS property_name, b.code FROM payouts po JOIN properties p ON p.id = po.property_id LEFT JOIN bookings b ON b.id = po.booking_id ORDER BY (po.status = 'pending') DESC, po.id DESC LIMIT 100"),
    all<{ id: number; code: string; amount_paid: number; paid_sum: number }>(
      c.env,
      "SELECT b.id, b.code, b.amount_paid, (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.booking_id = b.id AND p.status IN ('paid','refunded')) AS paid_sum FROM bookings b WHERE b.amount_paid != (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.booking_id = b.id AND p.status IN ('paid','refunded')) LIMIT 20",
    ),
  ])
  return page(c, { title: 'Payments & refunds', area: 'admin', active: 'payments' }, (
    <div class="stack-lg">
      <h1>Payments and refunds</h1>
      <div class="stats">
        <Stat label="Received (all time)" value={moneyShort(totals?.received ?? 0)} />
        <Stat label="Balance pending" value={moneyShort(totals?.pending ?? 0)} />
        <Stat label="Bookings with balance due" value={totals?.unpaid ?? 0} tone={(totals?.unpaid ?? 0) > 0 ? 'warn' : ''} href="/admin/payments?tab=due" />
        <Stat label="Refunded" value={moneyShort(totals?.refunded ?? 0)} />
      </div>
      <Tabs base="/admin/payments" active={tab} items={[['refunds', 'Refund requests'], ['received', 'Received'], ['due', 'Balance due'], ['refunded', 'Refunded'], ['payouts', 'Owner payouts'], ['match', 'Match check']]} />
      {tab === 'refunds' && (
        <Table head={['Booking', 'Guest', 'Amount', 'Paid', 'Reason', 'Requested by', 'Status', '']}>
          {refunds.map((r) => (
            <tr>
              <td><a href={`/staff/bookings/${r.booking_id}`}>{r.code}</a></td><td>{r.guest_name}</td><td>{money(r.amount)}</td><td>{money(r.paid)}</td><td class="small">{r.reason}</td><td>{r.requested_by_name}</td><td><Pill s={r.status} /></td>
              <td class="nowrap">{r.status === 'requested' && (
                <>
                  <form method="post" action={`/admin/refunds/${r.id}`} class="inline"><input type="hidden" name="approve" value="1" /><input name="reference" placeholder="UTR / reference" class="w-md" /><button class="btn btn-sm">Mark refunded</button></form>
                  <form method="post" action={`/admin/refunds/${r.id}`} class="inline"><button class="btn btn-sm btn-outline">Reject</button></form>
                </>
              )}</td>
            </tr>
          ))}
        </Table>
      )}
      {tab in statusMap && (
        <>
          <Table head={['Booking', 'Guest', 'Amount', 'Gateway', 'Reference', 'Date', 'Note']}>
            {payments.slice(0, 50).map((p) => <tr><td><a href={`/staff/bookings/${p.booking_id}`}>{p.code}</a></td><td>{p.guest_name}</td><td>{money(p.amount)}</td><td>{p.gateway}</td><td class="small">{p.gateway_payment_id ?? '—'}</td><td>{fmtDateTime(p.created_at)}</td><td class="small error">{p.failure_reason ?? ''}</td></tr>)}
          </Table>
          <Pager page={pg} hasMore={payments.length > 50} base={`/admin/payments?tab=${tab}`} />
        </>
      )}
      {tab === 'payouts' && (
        <Table head={['Property', 'Booking', 'Amount', 'Status', 'Reference', '']}>
          {payouts.map((p) => (
            <tr>
              <td>{p.property_name}</td><td>{p.code}</td><td>{money(p.amount)}</td><td><Pill s={p.status} /></td><td>{p.reference ?? ''}</td>
              <td>{p.status === 'pending' && <form method="post" action={`/admin/payouts/${p.id}`} class="row"><input name="reference" placeholder="UTR / reference" required /><button class="btn btn-sm">Mark paid</button></form>}</td>
            </tr>
          ))}
        </Table>
      )}
      {tab === 'due' && (
        due.length === 0 ? <Empty>No balances due.</Empty> : (
          <Table head={['Booking', 'Guest', 'Check-in', 'Total', 'Paid', 'Due', '']}>
            {due.map((b) => <tr><td><a href={`/staff/bookings/${b.id}`}>{b.code}</a></td><td>{b.guest_name}<div class="muted small">{b.guest_phone}</div></td><td>{fmtDate(b.check_in)}</td><td>{money(b.total)}</td><td>{money(b.amount_paid)}</td><td><strong>{money(b.total - b.amount_paid)}</strong></td><td><a class="btn btn-sm" href={`/staff/bookings/${b.id}#payment`}>Record payment</a></td></tr>)}
          </Table>
        )
      )}
      {tab === 'match' && (
        <>
          <p class="muted">Bookings where the amount paid does not match gateway payments.</p>
          {mismatched.length === 0 ? <Empty>Everything matches.</Empty> : (
            <Table head={['Booking', 'Booking says paid', 'Payments total']}>{mismatched.map((m) => <tr><td><a href={`/staff/bookings/${m.id}`}>{m.code}</a></td><td>{money(m.amount_paid)}</td><td>{money(m.paid_sum)}</td></tr>)}</Table>
          )}
        </>
      )}
    </div>
  ))
})

adminRoutes.post('/admin/refunds/:id', requirePerm('approve_refunds'), async (c) => {
  const f = await form(c)
  const r = await processRefund(c.env, int(c.req.param('id')), c.get('user')!.id, f.approve === '1', f.reference)
  return redirectMsg(c, '/admin/payments?tab=refunds', 'error' in r ? { err: r.error } : { ok: f.approve === '1' ? 'Refund processed.' : 'Refund rejected.' })
})

adminRoutes.post('/admin/payouts/:id', requirePerm('manage_payments'), async (c) => {
  const f = await form(c)
  await run(c.env, "UPDATE payouts SET status = 'paid', reference = ?, paid_at = ? WHERE id = ?", str(f.reference, 60), nowIso(), int(c.req.param('id')))
  await logActivity(c.env, c.get('user')!.id, 'payout.paid', 'payout', c.req.param('id'), { reference: f.reference })
  return c.redirect('/admin/payments?tab=payouts', 303)
})

// ---------- 40. Guests (all) ----------
adminRoutes.get('/admin/guests', requirePerm('manage_guests'), (c) => renderGuests(c, true))

adminRoutes.get('/admin/guests/export', requirePerm('manage_guests', 'export_data'), async (c) => {
  const rows = await all<Record<string, unknown>>(
    c.env,
    `SELECT u.id, u.name, u.phone, u.email, u.language, u.whatsapp_updates, u.created_at,
       (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.${CONFIRMED}) AS bookings,
       (SELECT COALESCE(SUM(total),0) FROM bookings b WHERE b.user_id = u.id AND b.${CONFIRMED}) AS total_spent
     FROM users u WHERE u.role = 'guest' AND u.merged_into IS NULL ORDER BY u.id`,
  )
  await logActivity(c.env, c.get('user')!.id, 'export.guests', 'user', null, { rows: rows.length })
  return new Response('﻿' + toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="guests-${todayIST()}.csv"` } })
})

adminRoutes.get('/admin/guests/duplicates', requirePerm('manage_guests'), async (c) => {
  // Same name (case-insensitive) with different records, or same email/phone digits.
  const dups = await all<{ a: number; b: number; a_name: string; b_name: string; a_phone: string | null; b_phone: string | null; a_email: string | null; b_email: string | null; why: string }>(
    c.env,
    `SELECT u1.id AS a, u2.id AS b, u1.name AS a_name, u2.name AS b_name, u1.phone AS a_phone, u2.phone AS b_phone, u1.email AS a_email, u2.email AS b_email,
       CASE WHEN lower(u1.email) = lower(u2.email) THEN 'same email' WHEN substr(u1.phone, -10) = substr(u2.phone, -10) THEN 'same phone' ELSE 'same name' END AS why
     FROM users u1 JOIN users u2 ON u1.id < u2.id
     WHERE u1.role = 'guest' AND u2.role = 'guest' AND u1.merged_into IS NULL AND u2.merged_into IS NULL
       AND ((lower(trim(u1.name)) = lower(trim(u2.name)) AND u1.name NOT IN ('', 'Guest')) OR substr(u1.phone, -10) = substr(u2.phone, -10))
     LIMIT 100`,
  )
  return page(c, { title: 'Duplicate guests', area: 'admin', active: 'all-guests' }, (
    <div class="stack-lg">
      <a href="/admin/guests" class="small">← All guests</a>
      <h1>Possible duplicates</h1>
      {dups.length === 0 && <Empty>No duplicates found.</Empty>}
      <Table head={['Keep', 'Merge into it', 'Why', '']}>
        {dups.map((d) => (
          <tr>
            <td>#{d.a} {d.a_name}<div class="muted small">{d.a_phone} {d.a_email}</div></td>
            <td>#{d.b} {d.b_name}<div class="muted small">{d.b_phone} {d.b_email}</div></td>
            <td>{d.why}</td>
            <td><form method="post" action="/admin/guests/merge" class="inline"><input type="hidden" name="keep" value={d.a} /><input type="hidden" name="merge" value={d.b} /><button class="btn btn-sm">Merge →</button></form></td>
          </tr>
        ))}
      </Table>
    </div>
  ))
})

adminRoutes.post('/admin/guests/merge', requirePerm('manage_guests'), async (c) => {
  const f = await form(c)
  const keep = int(f.keep)
  const merge = int(f.merge)
  if (!keep || !merge || keep === merge) return redirectMsg(c, '/admin/guests/duplicates', { err: 'Invalid merge.' })
  const m = await first<{ phone: string | null; email: string | null }>(c.env, "SELECT phone, email FROM users WHERE id = ? AND role = 'guest'", merge)
  if (!m) return c.notFound()
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE bookings SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE enquiries SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE quotations SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE reviews SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE guest_notes SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE travellers SET user_id = ? WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('INSERT OR IGNORE INTO wishlist (user_id, property_id, saved_price, created_at) SELECT ?, property_id, saved_price, created_at FROM wishlist WHERE user_id = ?').bind(keep, merge),
    c.env.DB.prepare('DELETE FROM wishlist WHERE user_id = ?').bind(merge),
    // Free the unique phone/email on the merged record, then copy them to the kept one if it has none.
    c.env.DB.prepare('UPDATE users SET merged_into = ?, active = 0, phone = NULL, email = NULL, google_sub = NULL WHERE id = ?').bind(keep, merge),
    c.env.DB.prepare('UPDATE users SET phone = COALESCE(phone, ?), email = COALESCE(email, ?) WHERE id = ?').bind(m.phone, m.email, keep),
  ])
  await logActivity(c.env, c.get('user')!.id, 'guest.merged', 'user', keep, { merged: merge })
  return redirectMsg(c, `/staff/guests/${keep}`, { ok: 'Guests merged.' })
})

adminRoutes.post('/admin/guests/:id/block', requirePerm('manage_guests'), async (c) => {
  const id = int(c.req.param('id'))
  await run(c.env, "UPDATE users SET blocked = 1 - blocked WHERE id = ? AND role = 'guest'", id)
  await logActivity(c.env, c.get('user')!.id, 'guest.block_toggled', 'user', id)
  return c.redirect(`/staff/guests/${id}`, 303)
})
