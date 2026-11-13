// B2B rate entry: a focused page for the Data Entry role (and anyone granted it) to view, enter and edit the
// B2B / net rates resorts send, without the wider property editor. Three separate permissions:
//   view_b2b_rates   — see the page and the B2B figures
//   create_b2b_rates — fill in a B2B figure that is blank today
//   edit_b2b_rates   — change or clear a B2B figure that already has a value
// Every check runs on the server against the stored values, so hiding or disabling inputs is only a convenience.
// Public, staff rates, margins, commission and resort contacts are not shown or written here.
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Table } from '../views/components'
import { permissionsFor, requirePerm } from '../lib/auth'
import type { Permissions } from '../lib/permissions'
import { all, first, logActivity } from '../lib/db'
import { MEAL_PLANS } from '../lib/search'
import { fmtDate, fmtDateTime, int, isDate, money, str } from '../lib/util'
import { form, redirectMsg } from './helpers'

export const b2bRateRoutes = new Hono<AppEnv>()

const MAX_RATE = 10_000_000
const ROOM_FIELDS = [
  ['net_rate', 'B2B room rate / night'],
  ['net_extra_adult_rate', 'B2B extra adult'],
  ['net_extra_child_rate', 'B2B extra child'],
  ['net_child_no_bed_rate', 'B2B child without bed'],
] as const
const PERIOD_FIELDS = [
  ['net_rate', 'B2B weekday'],
  ['net_weekend_rate', 'B2B weekend'],
  ['net_supplement', 'B2B supplement'],
] as const
type RoomField = (typeof ROOM_FIELDS)[number][0]
type PeriodField = (typeof PERIOD_FIELDS)[number][0]

interface PropertyInfo {
  id: number; name: string; destination: string; address: string | null; status: string; rate_meal_plan: string | null
  weekend_nights: string; child_free_below: number | null; child_age_to: number | null
  b2b_valid_from: string | null; b2b_valid_to: string | null; b2b_terms: string
}
type RoomB2B = { id: number; name: string; capacity: number; active: number } & Record<RoomField, number | null>
type PeriodB2B = {
  id: number; room_id: number | null; name: string; kind: string; start_date: string; end_date: string; meal_plan: string | null
  applicable_weekdays: string | null; supplement: number | null
} & Record<PeriodField, number | null>

const property = (c: Context<AppEnv>, id: number) => first<PropertyInfo>(
  c.env,
  `SELECT id, name, destination, address, status, rate_meal_plan, weekend_nights, child_free_below, child_age_to,
     b2b_valid_from, b2b_valid_to, b2b_terms FROM properties WHERE id = ?`, id,
)
const rooms = (c: Context<AppEnv>, id: number) => all<RoomB2B>(
  c.env, `SELECT id, name, capacity, active, ${ROOM_FIELDS.map(([k]) => k).join(', ')} FROM rooms WHERE property_id = ? ORDER BY active DESC, id`, id,
)
const periods = (c: Context<AppEnv>, id: number) => all<PeriodB2B>(
  c.env,
  `SELECT id, room_id, name, kind, start_date, end_date, meal_plan, applicable_weekdays, supplement, ${PERIOD_FIELDS.map(([k]) => k).join(', ')}
   FROM season_rates WHERE property_id = ? ORDER BY start_date, room_id, meal_plan, id`, id,
)

/** Blank = no rate. Otherwise a whole rupee amount from 1 to 1,00,00,000. undefined = invalid. */
function parseRate(v: string | undefined): number | null | undefined {
  const t = (v ?? '').trim().replace(/,/g, '')
  if (t === '') return null
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return n >= 1 && n <= MAX_RATE ? n : undefined
}

/** What a change needs: filling a blank needs create, anything else (change or clear) needs edit. */
function needed(before: unknown, after: unknown): 'create' | 'edit' | null {
  const b = before == null || before === '' ? null : before
  const a = after == null || after === '' ? null : after
  if (b === a) return null
  return b == null ? 'create' : 'edit'
}
function allowed(p: Permissions, need: 'create' | 'edit') {
  return need === 'create' ? p.create_b2b_rates : p.edit_b2b_rates
}
const DENIED = {
  create: 'You do not have permission to enter new B2B rates.',
  edit: 'You do not have permission to change existing B2B rates.',
}

/** An input that is read-only when this user may not change it (the server enforces the same rule). */
function canChange(p: Permissions, value: unknown) {
  return value == null || value === '' ? p.create_b2b_rates : p.edit_b2b_rates
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const nights = (v: string | null) => (v ?? '').split(',').map((x) => WEEKDAYS[parseInt(x, 10)]).filter(Boolean).join(', ')

// ---------- List ----------
// Data Entry staff land here after login; without the B2B permission, go to the next useful page instead of a 403.
b2bRateRoutes.get('/admin/b2b-rates', async (c, next) => {
  const u = c.get('user')
  if (u?.role === 'accounts') {
    const pm = await permissionsFor(c.env, u.role)
    if (!pm.view_b2b_rates) return c.redirect(pm.manage_payments ? '/admin/payments' : '/staff', 302)
  }
  await next()
})
b2bRateRoutes.get('/admin/b2b-rates', requirePerm('view_b2b_rates'), async (c) => {
  const q = str(c.req.query('q'), 80)
  const rows = await all<{ id: number; name: string; destination: string; status: string; b2b_valid_from: string | null; b2b_valid_to: string | null; room_count: number; with_rate: number }>(
    c.env,
    `SELECT p.id, p.name, p.destination, p.status, p.b2b_valid_from, p.b2b_valid_to,
       (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) AS room_count,
       (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id AND r.active = 1 AND (r.net_rate > 0 OR EXISTS (SELECT 1 FROM season_rates s WHERE s.room_id = r.id AND s.net_rate > 0))) AS with_rate
     FROM properties p ${q ? 'WHERE p.name LIKE ? OR p.destination LIKE ?' : ''} ORDER BY p.name LIMIT 500`,
    ...(q ? [`%${q}%`, `%${q}%`] : []),
  )
  return page(c, { title: 'B2B rates', area: 'admin', active: 'b2b-rates' }, (
    <div class="stack-lg">
      <h1>B2B rates</h1>
      <p class="muted small">Net rates from resorts. Pick a property to view or enter its B2B rates.</p>
      <form method="get" class="row filters-inline wrap-row">
        <input name="q" value={q} placeholder="Property or destination" />
        <button class="btn btn-sm">Search</button>
      </form>
      <Table head={['Property', 'Destination', 'Status', 'B2B contract', 'Rooms with a B2B rate', '']}>
        {rows.map((p) => (
          <tr>
            <td><a href={`/admin/b2b-rates/${p.id}`}>{p.name}</a></td>
            <td>{p.destination}</td>
            <td>{p.status}</td>
            <td class="small">{p.b2b_valid_from || p.b2b_valid_to ? `${p.b2b_valid_from ? fmtDate(p.b2b_valid_from) : '…'} – ${p.b2b_valid_to ? fmtDate(p.b2b_valid_to) : '…'}` : '—'}</td>
            <td>{p.with_rate} of {p.room_count}</td>
            <td><a class="btn btn-sm" href={`/admin/b2b-rates/${p.id}`}>Open</a></td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <Empty>No properties found.</Empty>}
    </div>
  ))
})

// ---------- One property ----------
b2bRateRoutes.get('/admin/b2b-rates/:id', requirePerm('view_b2b_rates'), async (c) => {
  const id = int(c.req.param('id'))
  const [p, rs, ps, pm, history] = await Promise.all([
    property(c, id), rooms(c, id), periods(c, id), permissionsFor(c.env, c.get('user')!.role),
    all<{ action: string; created_at: string; name: string | null; details: string }>(
      c.env,
      `SELECT a.action, a.created_at, u.name, a.details FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity = 'property' AND a.entity_id = ? AND a.action LIKE 'b2b.%' ORDER BY a.id DESC LIMIT 20`, String(id),
    ),
  ])
  if (!p) return c.notFound()
  const roomName = new Map(rs.map((r) => [r.id, r.name]))
  const canWrite = pm.create_b2b_rates || pm.edit_b2b_rates
  const RateInput = ({ name, value }: { name: string; value: number | null }) => (
    <input type="number" min="1" max={MAX_RATE} step="1" name={name} value={value ?? ''} class="w-sm"
      readonly={!canChange(pm, value)} title={canChange(pm, value) ? undefined : value == null ? DENIED.create : DENIED.edit} />
  )
  return page(c, { title: `B2B rates — ${p.name}`, area: 'admin', active: 'b2b-rates' }, (
    <div class="stack-lg">
      <p><a href="/admin/b2b-rates">← All properties</a></p>
      <h1>{p.name} — B2B rates</h1>
      <section class="card stack">
        <h2>Property details</h2>
        <p>{p.destination}{p.address ? ` · ${p.address}` : ''} · Status: {p.status}</p>
        <p class="small">Rates include: {p.rate_meal_plan ? MEAL_PLANS[p.rate_meal_plan] ?? p.rate_meal_plan : 'Not set'} · Weekend nights: {nights(p.weekend_nights) || 'Fri, Sat'}
          {p.child_free_below != null ? ` · Children free below ${p.child_free_below}` : ''}{p.child_age_to != null ? ` · Child rate up to age ${p.child_age_to}` : ''}</p>
        {!canWrite && <p class="small muted">You can view these rates. Ask an admin for permission to enter or change them.</p>}
        {canWrite && !pm.edit_b2b_rates && <p class="small muted">You can fill in blank B2B rates. Existing rates are read-only for you.</p>}
        {canWrite && !pm.create_b2b_rates && <p class="small muted">You can change existing B2B rates. Blank rates are read-only for you.</p>}
      </section>

      <form method="post" action={`/admin/b2b-rates/${p.id}/contract`} class="card stack">
        <h2>B2B contract</h2>
        <div class="grid grid-2">
          <Field label="Valid from"><input type="date" name="b2b_valid_from" value={p.b2b_valid_from ?? ''} readonly={!canChange(pm, p.b2b_valid_from)} /></Field>
          <Field label="Valid to"><input type="date" name="b2b_valid_to" value={p.b2b_valid_to ?? ''} readonly={!canChange(pm, p.b2b_valid_to)} /></Field>
        </div>
        <Field label="Contract terms"><textarea name="b2b_terms" rows={3} maxlength={2000} readonly={!canChange(pm, p.b2b_terms)}>{p.b2b_terms}</textarea></Field>
        {canWrite && <div><button class="btn">Save contract</button></div>}
      </form>

      <form method="post" action={`/admin/b2b-rates/${p.id}/rates`} class="card stack">
        <h2>Room B2B rates</h2>
        {rs.length === 0 ? <Empty>This property has no rooms yet. An admin or manager adds rooms in the property editor.</Empty> : (
          <Table head={['Room', 'Sleeps', ...ROOM_FIELDS.map(([, l]) => `${l} (₹)`)]}>
            {rs.map((r) => (
              <tr class={r.active ? '' : 'muted'}>
                <td>{r.name}{r.active ? '' : ' (inactive)'}</td>
                <td>{r.capacity}</td>
                {ROOM_FIELDS.map(([k]) => <td><RateInput name={`room_${r.id}_${k}`} value={r[k]} /></td>)}
              </tr>
            ))}
          </Table>
        )}
        <h2>Rate periods</h2>
        <p class="small muted">Seasons and special dates set up for this property. New periods are added by an admin or manager in the property editor; enter their B2B rates here.</p>
        {ps.length === 0 ? <Empty>No rate periods.</Empty> : (
          <Table head={['Period', 'Room', 'Dates', 'Meal plan', ...PERIOD_FIELDS.map(([, l]) => `${l} (₹)`)]}>
            {ps.map((s) => (
              <tr>
                <td>{s.name}<div class="muted small">{s.kind}{s.applicable_weekdays ? ` · ${nights(s.applicable_weekdays)} only` : ''}</div></td>
                <td>{s.room_id == null ? 'All rooms' : roomName.get(s.room_id) ?? `Room ${s.room_id}`}</td>
                <td class="nowrap small">{fmtDate(s.start_date)} – {fmtDate(s.end_date)}</td>
                <td>{s.meal_plan ?? 'Any'}</td>
                {PERIOD_FIELDS.map(([k]) => <td>{k === 'net_supplement' && s.supplement == null && s.net_supplement == null ? '—' : <RateInput name={`period_${s.id}_${k}`} value={s[k]} />}</td>)}
              </tr>
            ))}
          </Table>
        )}
        {canWrite && (rs.length > 0 || ps.length > 0) && <div><button class="btn">Save B2B rates</button></div>}
      </form>

      <section class="card stack">
        <h2>Recent B2B changes</h2>
        {history.length === 0 ? <p class="muted small">No B2B changes recorded on this page yet.</p> : (
          <Table head={['When', 'Who', 'What']}>
            {history.map((h) => {
              const d = JSON.parse(h.details || '{}') as { changes?: { label: string; from: unknown; to: unknown }[] }
              return (
                <tr>
                  <td class="nowrap small">{fmtDateTime(h.created_at)}</td>
                  <td>{h.name ?? '—'}</td>
                  <td class="small">{(d.changes ?? []).map((x) => `${x.label}: ${fmt(x.from)} → ${fmt(x.to)}`).join('; ')}</td>
                </tr>
              )
            })}
          </Table>
        )}
      </section>
    </div>
  ))
})
const fmt = (v: unknown) => (v == null || v === '' ? 'blank' : typeof v === 'number' ? money(v) : String(v).slice(0, 60))

type Change = { label: string; from: unknown; to: unknown; need: 'create' | 'edit' }

// ---------- Save contract ----------
b2bRateRoutes.post('/admin/b2b-rates/:id/contract', requirePerm('view_b2b_rates'), async (c) => {
  const id = int(c.req.param('id'))
  const back = `/admin/b2b-rates/${id}`
  const [p, pm] = await Promise.all([property(c, id), permissionsFor(c.env, c.get('user')!.role)])
  if (!p) return c.notFound()
  if (!pm.create_b2b_rates && !pm.edit_b2b_rates) return c.text(DENIED.edit, 403)
  const f = await form(c)
  const from = (f.b2b_valid_from ?? '').trim() || null, to = (f.b2b_valid_to ?? '').trim() || null
  const terms = (f.b2b_terms ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000)
  if ((from && !isDate(from)) || (to && !isDate(to))) return redirectMsg(c, back, { err: 'Enter valid contract dates.' })
  if (from && to && to < from) return redirectMsg(c, back, { err: 'The contract end date is before its start date.' })
  const changes: Change[] = []
  const add = (label: string, before: unknown, after: unknown) => { const need = needed(before, after); if (need) changes.push({ label, from: before, to: after, need }) }
  add('Contract valid from', p.b2b_valid_from, from)
  add('Contract valid to', p.b2b_valid_to, to)
  add('Contract terms', p.b2b_terms, terms)
  if (!changes.length) return redirectMsg(c, back, { ok: 'No changes.' })
  const denied = changes.find((x) => !allowed(pm, x.need))
  if (denied) return c.text(DENIED[denied.need], 403)
  // Only write when the stored values are still the ones checked above.
  const res = await c.env.DB.prepare(
    `UPDATE properties SET b2b_valid_from = ?, b2b_valid_to = ?, b2b_terms = ?
     WHERE id = ? AND b2b_valid_from IS ? AND b2b_valid_to IS ? AND b2b_terms = ?`,
  ).bind(from, to, terms, id, p.b2b_valid_from, p.b2b_valid_to, p.b2b_terms).run()
  if (!res.meta.changes) return redirectMsg(c, back, { err: 'Someone else changed this contract. Check the values and save again.' })
  await logActivity(c.env, c.get('user')!.id, 'b2b.contract_saved', 'property', id, { changes: changes.map(({ need: _, ...x }) => x) })
  return redirectMsg(c, back, { ok: 'B2B contract saved.' })
})

// ---------- Save room and period rates ----------
b2bRateRoutes.post('/admin/b2b-rates/:id/rates', requirePerm('view_b2b_rates'), async (c) => {
  const id = int(c.req.param('id'))
  const back = `/admin/b2b-rates/${id}`
  const [p, rs, ps, pm] = await Promise.all([property(c, id), rooms(c, id), periods(c, id), permissionsFor(c.env, c.get('user')!.role)])
  if (!p) return c.notFound()
  if (!pm.create_b2b_rates && !pm.edit_b2b_rates) return c.text(DENIED.edit, 403)
  const f = await form(c)
  const changes: Change[] = []
  const stmts: D1PreparedStatement[] = []
  // Only fields present in the form are considered, and only for rooms/periods of this property.
  for (const r of rs) {
    for (const [k, label] of ROOM_FIELDS) {
      const key = `room_${r.id}_${k}`
      if (!(key in f)) continue
      const v = parseRate(f[key])
      if (v === undefined) return redirectMsg(c, back, { err: `${r.name}: ${label} must be a whole rupee amount from 1 to ${MAX_RATE.toLocaleString('en-IN')}, or blank.` })
      const need = needed(r[k], v)
      if (!need) continue
      changes.push({ label: `${r.name} · ${label}`, from: r[k], to: v, need })
      stmts.push(c.env.DB.prepare(`UPDATE rooms SET ${k} = ? WHERE id = ? AND property_id = ? AND ${k} IS ?`).bind(v, r.id, id, r[k]))
    }
  }
  for (const s of ps) {
    for (const [k, label] of PERIOD_FIELDS) {
      const key = `period_${s.id}_${k}`
      if (!(key in f)) continue
      if (k === 'net_supplement' && s.supplement == null && s.net_supplement == null) continue
      const v = parseRate(f[key])
      if (v === undefined) return redirectMsg(c, back, { err: `${s.name}: ${label} must be a whole rupee amount from 1 to ${MAX_RATE.toLocaleString('en-IN')}, or blank.` })
      const need = needed(s[k], v)
      if (!need) continue
      changes.push({ label: `${s.name} ${fmtDate(s.start_date)}–${fmtDate(s.end_date)}${s.meal_plan ? ` ${s.meal_plan}` : ''} · ${label}`, from: s[k], to: v, need })
      stmts.push(c.env.DB.prepare(`UPDATE season_rates SET ${k} = ? WHERE id = ? AND property_id = ? AND ${k} IS ?`).bind(v, s.id, id, s[k]))
    }
  }
  if (!changes.length) return redirectMsg(c, back, { ok: 'No changes.' })
  const denied = changes.find((x) => !allowed(pm, x.need))
  if (denied) return c.text(DENIED[denied.need], 403)
  const results = await c.env.DB.batch(stmts)
  const written = changes.filter((_, i) => results[i]?.meta.changes)
  if (written.length) await logActivity(c.env, c.get('user')!.id, 'b2b.rates_saved', 'property', id, { changes: written.map(({ need: _, ...x }) => x) })
  const skipped = changes.length - written.length
  return redirectMsg(c, back, skipped
    ? { err: `${written.length} B2B rate(s) saved. ${skipped} changed meanwhile and were not saved — check them and save again.` }
    : { ok: `${written.length} B2B rate(s) saved.` })
})
