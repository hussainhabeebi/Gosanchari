// Staff pages 19–21 and 28–30: dashboard, enquiry inbox, enquiry workspace, guests, follow-ups, profile.

import { Hono, type Context } from 'hono'
import type { AppEnv, SessionUser } from '../env'
import { page } from '../views/layout'
import { AiNote, Empty, Field, Pager, Pill, Select, Stat, Table } from '../views/components'
import { hashPassword, permissionsFor, requirePerm, requireStaff, verifyPassword } from '../lib/auth'
import { all, enqueue, findOrCreateGuest, first, insertId, logActivity, run } from '../lib/db'
import { enquirySummary, matchProperties, replySuggestion } from '../lib/assist'
import { aiTranslate, detectLanguage } from '../lib/ai'
import { leadScore, signalsFromRow } from '../lib/leadscore'
import { fillTemplate, mediaUrl, sendWhatsApp } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import type { Permissions } from '../lib/permissions'
import type { EnquiryRow, MessageRow } from '../lib/types'
import { fmtDate, fmtDateTime, int, isDate, money, normalizePhone, nowIso, parseJson, refCode, str, timeAgo, todayIST } from '../lib/util'
import { form, pageNum, redirectMsg } from './helpers'
import { destinations } from '../lib/properties'

export const staffRoutes = new Hono<AppEnv>()
staffRoutes.use('/staff', requireStaff)
staffRoutes.use('/staff/*', requireStaff)

export function canSeeEnquiry(u: SessionUser, p: Permissions, e: Pick<EnquiryRow, 'assigned_to'>): boolean {
  return p.view_all_enquiries || e.assigned_to == null || e.assigned_to === u.id
}

const LEAD_SQL = `SELECT e.*,
  (SELECT MAX(view_count) FROM quotations q WHERE q.enquiry_id = e.id) AS quote_views,
  (SELECT COUNT(*) FROM bookings b WHERE b.user_id = e.user_id AND b.status IN ('confirmed','completed','checked_in') AND e.user_id IS NOT NULL) AS past_bookings
  FROM enquiries e`

async function staffList(c: Context<AppEnv>) {
  return all<{ id: number; name: string }>(c.env, "SELECT id, name FROM users WHERE role IN ('admin','manager','sales') AND active = 1 ORDER BY name")
}

// ---------- 19. Staff dashboard ----------
staffRoutes.get('/staff', async (c) => {
  const u = c.get('user')!
  const today = todayIST()
  const startUtc = new Date(Date.parse(today + 'T00:00:00+05:30')).toISOString()
  const [counts, tasks, checkins, leadsRaw] = await Promise.all([
    first<{ new_today: number; waiting: number; quotes_today: number; bookings_today: number }>(
      c.env,
      `SELECT (SELECT COUNT(*) FROM enquiries WHERE created_at >= ?) AS new_today,
              (SELECT COUNT(*) FROM enquiries WHERE waiting_on = 'us' AND status IN ('new','in_progress','quoted')) AS waiting,
              (SELECT COUNT(*) FROM quotations WHERE sent_at >= ?) AS quotes_today,
              (SELECT COUNT(*) FROM bookings WHERE created_at >= ? AND status IN ('confirmed','checked_in','completed')) AS bookings_today`,
      startUtc, startUtc, startUtc,
    ),
    all<{ id: number; reason: string; guest_name: string | null; phone: string | null; due_at: string; enquiry_id: number | null }>(
      c.env, "SELECT * FROM tasks WHERE status = 'open' AND assigned_to = ? AND due_at < ? ORDER BY due_at LIMIT 10", u.id, new Date(Date.parse(today + 'T23:59:59+05:30')).toISOString(),
    ),
    all<{ id: number; code: string; guest_name: string; guest_phone: string; check_in: string; property_name: string; status: string }>(
      c.env,
      "SELECT b.id, b.code, b.guest_name, b.guest_phone, b.check_in, b.status, p.name AS property_name FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.check_in IN (?, ?) AND b.status IN ('confirmed','checked_in') ORDER BY b.check_in, p.name",
      today, todayIST(1),
    ),
    all<EnquiryRow & { quote_views: number | null; past_bookings: number | null }>(c.env, `${LEAD_SQL} WHERE e.status IN ('new','in_progress','quoted') ORDER BY e.updated_at DESC LIMIT 200`),
  ])
  const perms = await permissionsFor(c.env, u.role)
  const leads = leadsRaw
    .filter((e) => canSeeEnquiry(u, perms, e))
    .map((e) => ({ e, s: leadScore(signalsFromRow(e)) }))
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, 8)
  return page(c, { title: 'Staff dashboard', area: 'staff', active: 'dashboard' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>Good {new Date().getUTCHours() + 5.5 < 12 ? 'morning' : 'day'}, {u.name.split(' ')[0]}</h1><a class="btn btn-sm" href="/staff/enquiries/new">+ New enquiry</a></div>
      <div class="stats">
        <Stat label="New enquiries today" value={counts?.new_today ?? 0} href="/staff/enquiries" />
        <Stat label="Waiting for our reply" value={counts?.waiting ?? 0} tone={(counts?.waiting ?? 0) > 0 ? 'warn' : ''} href="/staff/enquiries?f=waiting_us" />
        <Stat label="Quotes sent today" value={counts?.quotes_today ?? 0} href="/staff/quotes" />
        <Stat label="Bookings today" value={counts?.bookings_today ?? 0} href="/staff/bookings" />
      </div>
      <div class="grid grid-2">
        <section class="card">
          <div class="row-between"><h2>My tasks</h2><a href="/staff/tasks" class="small">All follow-ups →</a></div>
          {tasks.length === 0 && <p class="muted">Nothing due. 🎉</p>}
          {tasks.map((t) => (
            <div class="list-item">
              <div><strong>{t.guest_name ?? 'Guest'}</strong> — {t.reason}<div class={`small ${t.due_at < nowIso() ? 'error' : 'muted'}`}>Due {fmtDateTime(t.due_at)}</div></div>
              <div class="row">
                {t.phone && <a class="btn btn-sm btn-outline" href={`tel:${t.phone}`}>Call</a>}
                {t.enquiry_id && <a class="btn btn-sm" href={`/staff/enquiries/${t.enquiry_id}`}>Open</a>}
              </div>
            </div>
          ))}
        </section>
        <section class="card">
          <h2>Check-ins today & tomorrow</h2>
          {checkins.length === 0 && <p class="muted">No check-ins.</p>}
          {checkins.map((b) => (
            <a class="list-item" href={`/staff/bookings/${b.id}`}>
              <div><strong>{b.guest_name}</strong> · {b.property_name}<div class="muted small">{b.check_in === today ? 'Today' : 'Tomorrow'} · {b.code}</div></div>
              <Pill s={b.status} />
            </a>
          ))}
        </section>
      </div>
      <section class="card">
        <h2>Hot leads</h2>
        <p class="muted small">Scored by quote opens, reply speed and how soon they travel (rules, not AI).</p>
        <Table head={['Guest', 'Destination', 'Dates', 'Score', 'Why']}>
          {leads.map(({ e, s }) => (
            <tr>
              <td><a href={`/staff/enquiries/${e.id}`}>{e.guest_name}</a></td>
              <td>{e.destination ?? '—'}</td>
              <td>{fmtDate(e.check_in)}</td>
              <td><span class={`score score-${s.label.toLowerCase()}`}>{s.score} {s.label}</span></td>
              <td class="small">{s.reasons.join(', ')}</td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  ))
})

// ---------- 20. Enquiry inbox ----------
export async function renderInbox(c: Context<AppEnv>, opts: { admin: boolean }) {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const f = c.req.query('f') ?? (opts.admin ? 'all' : 'mine')
  const status = c.req.query('status') ?? 'open'
  const q = str(c.req.query('q'), 60)
  const staffId = int(c.req.query('staff'))
  const pg = pageNum(c)
  const where: string[] = []
  const binds: (string | number)[] = []
  if (status === 'open') where.push("e.status IN ('new','in_progress','quoted')")
  else if (status !== 'all') { where.push('e.status = ?'); binds.push(status) }
  if (f === 'mine') { where.push('e.assigned_to = ?'); binds.push(u.id) }
  if (f === 'unassigned') where.push('e.assigned_to IS NULL')
  if (f === 'urgent') where.push('e.urgent = 1')
  if (f === 'waiting_guest') where.push("e.waiting_on = 'guest'")
  if (f === 'waiting_us') where.push("e.waiting_on = 'us'")
  if (staffId) { where.push('e.assigned_to = ?'); binds.push(staffId) }
  if (!perms.view_all_enquiries) { where.push('(e.assigned_to = ? OR e.assigned_to IS NULL)'); binds.push(u.id) }
  if (q) { where.push('(e.guest_name LIKE ? OR e.phone LIKE ? OR e.code LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const rows = await all<EnquiryRow & { staff_name: string | null; accepted: number }>(
    c.env,
    `SELECT e.*, s.name AS staff_name, (SELECT COUNT(*) FROM quotations qq WHERE qq.enquiry_id = e.id AND qq.status = 'accepted') AS accepted
     FROM enquiries e LEFT JOIN users s ON s.id = e.assigned_to ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY e.urgent DESC, (e.waiting_on = 'us') DESC, e.updated_at DESC LIMIT 51 OFFSET ?`,
    ...binds, (pg - 1) * 50,
  )
  const staff = await staffList(c)
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
  const base = opts.admin ? '/admin/enquiries' : '/staff/enquiries'
  const qs = new URLSearchParams({ f, status, ...(q ? { q } : {}), ...(staffId ? { staff: String(staffId) } : {}) })
  // Response-time stats for admins.
  const rt = opts.admin
    ? await all<{ name: string; n: number; avg_min: number | null }>(
        c.env,
        `SELECT s.name, COUNT(*) AS n, AVG((julianday(e.first_response_at) - julianday(e.created_at)) * 1440) AS avg_min
         FROM enquiries e JOIN users s ON s.id = e.assigned_to WHERE e.created_at >= ? GROUP BY s.id ORDER BY n DESC`,
        new Date(Date.now() - 30 * 86400_000).toISOString(),
      )
    : []
  const lost = opts.admin
    ? await all<{ lost_reason: string; n: number }>(c.env, "SELECT COALESCE(lost_reason, 'Not given') AS lost_reason, COUNT(*) AS n FROM enquiries WHERE status = 'lost' AND updated_at >= ? GROUP BY lost_reason ORDER BY n DESC LIMIT 8", new Date(Date.now() - 30 * 86400_000).toISOString())
    : []
  const insight = opts.admin ? await first<{ body: string; period: string }>(c.env, "SELECT body, period FROM insights WHERE kind = 'lost_reasons' ORDER BY id DESC LIMIT 1") : null

  return page(c, { title: opts.admin ? 'All enquiries' : 'Enquiry inbox', area: opts.admin ? 'admin' : 'staff', active: opts.admin ? 'all-enquiries' : 'inbox' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>{opts.admin ? 'All enquiries' : 'Enquiries'}</h1><a class="btn btn-sm" href="/staff/enquiries/new">+ New enquiry</a></div>
      {insight && <AiNote label={`Lost reasons (${insight.period})`}>{insight.body}</AiNote>}
      {opts.admin && (
        <div class="grid grid-2">
          <div class="card"><h3>Response time (30 days)</h3>
            <Table head={['Staff', 'Enquiries', 'Avg first reply']}>{rt.map((r) => <tr><td>{r.name}</td><td>{r.n}</td><td>{r.avg_min == null ? '—' : r.avg_min < 60 ? `${Math.round(r.avg_min)} min` : `${(r.avg_min / 60).toFixed(1)} h`}</td></tr>)}</Table>
          </div>
          <div class="card"><h3>Lost reasons (30 days)</h3>
            <Table head={['Reason', 'Count']}>{lost.map((r) => <tr><td>{r.lost_reason}</td><td>{r.n}</td></tr>)}</Table>
          </div>
        </div>
      )}
      <nav class="tabs">
        {[['mine', 'My enquiries'], ['unassigned', 'Unassigned'], ['urgent', 'Urgent'], ['waiting_guest', 'Waiting for guest'], ['waiting_us', 'Waiting for us'], ['all', 'All']].map(([k, l]) => (
          <a href={`${base}?f=${k}&status=${status}`} class={f === k ? 'active' : ''}>{l}</a>
        ))}
      </nav>
      <form method="get" class="row filters-inline">
        <input type="hidden" name="f" value={f} />
        <input name="q" value={q} placeholder="Search name, phone, code" />
        <Select name="status" value={status} options={[['open', 'Open'], ['new', 'New'], ['in_progress', 'In progress'], ['quoted', 'Quoted'], ['booked', 'Booked'], ['lost', 'Lost'], ['closed', 'Closed'], ['all', 'All']]} />
        {opts.admin && <Select name="staff" value={staffId || ''} options={[['', 'Any staff'], ...staff.map((s) => [s.id, s.name] as [number, string])]} />}
        <button class="btn btn-sm">Filter</button>
      </form>
      <Table head={['Guest', 'Destination', 'Dates', 'People', 'Budget', 'Source', 'Status', 'Assigned', 'Last reply', 'Actions']} class="inbox">
        {rows.slice(0, 50).map((e) => {
          const overdue = e.waiting_on === 'us' && ['new', 'in_progress', 'quoted'].includes(e.status) && (e.last_guest_msg_at ?? e.created_at) < twoHoursAgo
          const tags = parseJson<string[]>(e.tags, [])
          return (
            <tr class={overdue ? 'row-red' : e.accepted ? 'row-green' : ''}>
              <td><a href={`/staff/enquiries/${e.id}`}><strong>{e.guest_name}</strong></a><div class="muted small">{e.code}</div>{tags.length > 0 && <div class="chips">{tags.map((t) => <span class="chip chip-sm">{t}</span>)}</div>}</td>
              <td>{e.destination ?? '—'}</td>
              <td class="nowrap">{e.check_in ? `${fmtDate(e.check_in)}` : '—'}</td>
              <td>{e.adults + e.children}</td>
              <td>{e.budget ? money(e.budget) : '—'}</td>
              <td>{e.source}</td>
              <td><Pill s={e.status} /></td>
              <td>
                <form method="post" action={`/staff/enquiries/${e.id}/assign`} class="inline">
                  <Select name="assigned_to" value={e.assigned_to ?? ''} class="autosubmit" options={[['', 'Unassigned'], ...staff.map((s) => [s.id, s.name] as [number, string])]} />
                </form>
              </td>
              <td class="small">{timeAgo(e.last_staff_reply_at)}</td>
              <td class="nowrap">
                <a class="btn btn-sm" href={`/staff/enquiries/${e.id}`}>Open</a>
                {['new', 'in_progress', 'quoted'].includes(e.status) && (
                  <details class="inline-details"><summary class="btn btn-sm btn-outline">Lost</summary>
                    <form method="post" action={`/staff/enquiries/${e.id}/lost`} class="popover stack">
                      <Select name="reason" options={LOST_REASONS.map((r) => [r, r])} />
                      <button class="btn btn-sm btn-danger">Mark lost</button>
                    </form>
                  </details>
                )}
              </td>
            </tr>
          )
        })}
      </Table>
      {rows.length === 0 && <Empty>No enquiries here.</Empty>}
      <Pager page={pg} hasMore={rows.length > 50} base={`${base}?${qs}`} />
    </div>
  ))
}

const LOST_REASONS = ['Price too high', 'No availability', 'Booked elsewhere', 'Changed plans', 'No response from guest', 'Dates not suitable', 'Location not suitable', 'Other']

staffRoutes.get('/staff/enquiries', requirePerm('manage_enquiries'), (c) => renderInbox(c, { admin: false }))

async function loadEnquiryFor(c: Context<AppEnv>, id: number): Promise<EnquiryRow | null> {
  const u = c.get('user')!
  const e = await first<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE id = ?', id)
  if (!e) return null
  return canSeeEnquiry(u, await permissionsFor(c.env, u.role), e) ? e : null
}

staffRoutes.post('/staff/enquiries/:id/assign', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  const to = int(f.assigned_to) || null
  await run(c.env, "UPDATE enquiries SET assigned_to = ?, status = CASE WHEN status = 'new' AND ? IS NOT NULL THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?", to, to, nowIso(), e.id)
  await logActivity(c.env, u.id, 'enquiry.assigned', 'enquiry', e.id, { from: e.assigned_to, to })
  return c.redirect(c.req.header('referer') ?? '/staff/enquiries', 303)
})

staffRoutes.post('/staff/enquiries/:id/lost', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  await run(c.env, "UPDATE enquiries SET status = 'lost', lost_reason = ?, updated_at = ? WHERE id = ?", str(f.reason, 100) || 'Other', nowIso(), e.id)
  await run(c.env, "UPDATE tasks SET status = 'done' WHERE enquiry_id = ? AND status = 'open'", e.id)
  await logActivity(c.env, u.id, 'enquiry.lost', 'enquiry', e.id, { reason: f.reason })
  return c.redirect(c.req.header('referer') ?? '/staff/enquiries', 303)
})

staffRoutes.post('/staff/enquiries/:id/status', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  const s = ['new', 'in_progress', 'quoted', 'booked', 'closed'].includes(f.status) ? f.status : 'in_progress'
  await run(c.env, 'UPDATE enquiries SET status = ?, updated_at = ? WHERE id = ?', s, nowIso(), e.id)
  await logActivity(c.env, u.id, 'enquiry.status', 'enquiry', e.id, { status: s })
  return redirectMsg(c, `/staff/enquiries/${e.id}`, { ok: `Marked ${s.replace('_', ' ')}.` })
})

// Manual enquiry (phone, Instagram, walk-in).
staffRoutes.get('/staff/enquiries/new', requirePerm('manage_enquiries'), async (c) => {
  const dests = await destinations(c.env)
  return page(c, { title: 'New enquiry', area: 'staff', active: 'inbox' }, (
    <form method="post" action="/staff/enquiries/new" class="card stack narrow">
      <h1>Add an enquiry</h1>
      <div class="row">
        <Field label="Guest name"><input name="guest_name" required /></Field>
        <Field label="Phone"><input name="phone" required inputmode="tel" /></Field>
      </div>
      <div class="row">
        <Field label="Source"><Select name="source" options={[['phone', 'Phone call'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['email', 'Email'], ['website', 'Website']]} /></Field>
        <Field label="Destination"><Select name="destination" options={[['', '—'], ...dests.map((d) => [d, d] as [string, string])]} /></Field>
      </div>
      <div class="row">
        <Field label="Check-in"><input type="date" name="check_in" /></Field>
        <Field label="Check-out"><input type="date" name="check_out" /></Field>
      </div>
      <div class="row">
        <Field label="Adults"><input type="number" name="adults" value="2" min="1" /></Field>
        <Field label="Children"><input type="number" name="children" value="0" min="0" /></Field>
        <Field label="Budget ₹"><input type="number" name="budget" min="0" step="500" /></Field>
      </div>
      <Field label="Notes / what they asked"><textarea name="message" rows={4}></textarea></Field>
      <button class="btn">Save enquiry</button>
    </form>
  ))
})

staffRoutes.post('/staff/enquiries/new', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const f = await form(c)
  const phone = normalizePhone(f.phone)
  if (!phone || !str(f.guest_name)) return redirectMsg(c, '/staff/enquiries/new', { err: 'Name and a valid phone are required.' })
  const userId = await findOrCreateGuest(c.env, phone, str(f.guest_name, 80), null)
  const checkIn = isDate(f.check_in) ? f.check_in : null
  const id = await insertId(
    c.env,
    `INSERT INTO enquiries (code, user_id, guest_name, phone, destination, check_in, check_out, adults, children, budget, message, source, assigned_to, status, last_guest_msg_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)`,
    refCode('ENQ'), userId, str(f.guest_name, 80), phone, f.destination || null, checkIn, isDate(f.check_out) && checkIn && f.check_out > checkIn ? f.check_out : null,
    Math.max(1, int(f.adults, 2)), Math.max(0, int(f.children)), int(f.budget) || null, str(f.message, 2000),
    ['phone', 'whatsapp', 'instagram', 'email', 'website'].includes(f.source) ? f.source : 'phone', u.id, nowIso(),
  )
  if (str(f.message)) await run(c.env, "INSERT INTO messages (enquiry_id, sender, user_id, channel, body) VALUES (?, 'staff', ?, 'note', ?)", id, u.id, `Logged from ${f.source}: ${str(f.message, 2000)}`)
  await enqueue(c.env, { type: 'enquiry_ai', enquiryId: id })
  await logActivity(c.env, u.id, 'enquiry.created', 'enquiry', id, { source: f.source })
  return c.redirect(`/staff/enquiries/${id}`, 303)
})

// ---------- 21. Enquiry workspace ----------
staffRoutes.get('/staff/enquiries/:id', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return page(c, { title: 'Not found', area: 'staff' }, <Empty>Enquiry not found or not assigned to you.</Empty>, 404)
  const s = await getSettings(c.env)
  const [msgs, bookings, notes, quotes, otherEnquiries, staff, tasks] = await Promise.all([
    all<MessageRow & { staff_name: string | null }>(c.env, 'SELECT m.*, s.name AS staff_name FROM messages m LEFT JOIN users s ON s.id = m.user_id WHERE m.enquiry_id = ? ORDER BY m.id', e.id),
    all<{ id: number; code: string; property_name: string; check_in: string; total: number; status: string }>(c.env, "SELECT b.id, b.code, p.name AS property_name, b.check_in, b.total, b.status FROM bookings b JOIN properties p ON p.id = b.property_id WHERE (b.user_id = ? OR b.guest_phone = ?) ORDER BY b.check_in DESC LIMIT 10", e.user_id ?? -1, e.phone ?? '-'),
    all<{ id: number; note: string; kind: string; source: string; created_at: string }>(c.env, 'SELECT * FROM guest_notes WHERE (user_id = ? OR phone = ?) ORDER BY kind DESC, id DESC', e.user_id ?? -1, e.phone ?? '-'),
    all<{ id: number; code: string; status: string; view_count: number; token: string; total: number }>(c.env, 'SELECT q.id, q.code, q.status, q.view_count, q.token, (SELECT MIN(total) FROM quotation_options o WHERE o.quotation_id = q.id) AS total FROM quotations q WHERE q.enquiry_id = ? ORDER BY q.id DESC', e.id),
    all<{ id: number; code: string; status: string; created_at: string }>(c.env, 'SELECT id, code, status, created_at FROM enquiries WHERE phone = ? AND id != ? ORDER BY id DESC LIMIT 5', e.phone ?? '-', e.id),
    staffList(c),
    all<{ id: number; reason: string; due_at: string }>(c.env, "SELECT id, reason, due_at FROM tasks WHERE enquiry_id = ? AND status = 'open' ORDER BY due_at", e.id),
  ])
  const matches = await matchProperties(c.env, e, 3)
  const tags = parseJson<string[]>(e.tags, [])
  const prefs = notes.filter((n) => n.kind === 'preference')
  const plain = notes.filter((n) => n.kind === 'note')
  const templates = Object.entries(s.whatsapp_templates).filter(([k]) => k !== 'otp')
  const quick = [
    `Hi ${e.guest_name}, thanks for reaching out to Go Sanchari! I'm ${u.name}. Let me check the best options for you.`,
    `Could you confirm your travel dates and the number of adults and children?`,
    `I've sent the quote — please take a look and let me know if you'd like any changes.`,
  ]

  return page(c, { title: `${e.guest_name} · ${e.code}`, area: 'staff', active: 'inbox' }, (
    <div class="workspace">
      <div class="ws-top">
        <div>
          <a href="/staff/enquiries" class="small">← Inbox</a>
          <h1>{e.guest_name} <Pill s={e.status} /> {e.urgent ? <span class="pill pill-urgent">urgent</span> : null}</h1>
          <div class="chips">{tags.map((t) => <span class="chip">{t}</span>)}<span class="chip">via {e.source}</span><span class="chip">{e.language === 'ml' ? 'Malayalam' : 'English'}</span></div>
        </div>
        <div class="row wrap-row">
          <a class="btn btn-sm btn-outline" href={`/staff/finder?enquiry=${e.id}&destination=${encodeURIComponent(e.destination ?? '')}&checkIn=${e.check_in ?? ''}&checkOut=${e.check_out ?? ''}&guests=${e.adults + e.children}`}>Find properties</a>
          <form method="post" action={`/staff/quotes/new?enquiry=${e.id}`} class="inline"><button class="btn btn-sm">Create quotation</button></form>
          <form method="post" action={`/staff/enquiries/${e.id}/status`} class="inline"><input type="hidden" name="status" value="booked" /><button class="btn btn-sm btn-outline">Mark booked</button></form>
          <details class="inline-details"><summary class="btn btn-sm btn-outline">Mark lost</summary>
            <form method="post" action={`/staff/enquiries/${e.id}/lost`} class="popover stack">
              <Select name="reason" options={LOST_REASONS.map((r) => [r, r])} />
              <button class="btn btn-sm btn-danger">Mark lost</button>
            </form>
          </details>
        </div>
      </div>
      <AiNote label="Summary">
        <span id="ws-summary">{e.summary ?? 'No summary yet.'}</span>{' '}
        <button class="linklike small" data-ai-post={`/staff/enquiries/${e.id}/summary`} data-target="#ws-summary">Refresh</button>
      </AiNote>

      <div class="ws-grid">
        <aside class="ws-left card">
          <h3>Guest</h3>
          <p><strong>{e.guest_name}</strong><br />
            {e.phone && <><a href={`tel:${e.phone}`}>{e.phone}</a> · <a href={`https://wa.me/${e.phone.replace(/\D/g, '')}`} target="_blank" rel="noopener">WhatsApp</a><br /></>}
            {e.email && <a href={`mailto:${e.email}`}>{e.email}</a>}
          </p>
          {e.user_id && <a class="small" href={`/staff/guests/${e.user_id}`}>Full guest profile →</a>}
          <h4>Preferences</h4>
          {prefs.length === 0 && <p class="muted small">None saved yet.</p>}
          <ul class="plain">{prefs.map((n) => <li>{n.source === 'ai' && <span class="ai-badge sm">AI</span>} {n.note} <form method="post" action={`/staff/notes/${n.id}/delete`} class="inline"><button class="linklike small">×</button></form></li>)}</ul>
          <h4>Past bookings</h4>
          {bookings.length === 0 && <p class="muted small">First-time guest.</p>}
          <ul class="plain small">{bookings.map((b) => <li><a href={`/staff/bookings/${b.id}`}>{b.property_name}</a> · {fmtDate(b.check_in)} · {money(b.total)} <Pill s={b.status} /></li>)}</ul>
          {otherEnquiries.length > 0 && <><h4>Other enquiries</h4><ul class="plain small">{otherEnquiries.map((o) => <li><a href={`/staff/enquiries/${o.id}`}>{o.code}</a> <Pill s={o.status} /></li>)}</ul></>}
          <h4>Notes</h4>
          <ul class="plain small">{plain.map((n) => <li>{n.note} <span class="muted">{fmtDate(n.created_at)}</span></li>)}</ul>
          <form method="post" action={`/staff/enquiries/${e.id}/note`} class="stack">
            <textarea name="note" rows={2} placeholder="Add a note…" required></textarea>
            <label class="check small"><input type="checkbox" name="preference" value="1" /> Save as lasting preference</label>
            <button class="btn btn-sm btn-outline">Add note</button>
          </form>
        </aside>

        <section class="ws-middle card">
          <h3>Conversation</h3>
          <div class="thread" id="thread">
            {e.message && msgs.every((m) => m.body !== e.message) && <div class="msg msg-guest"><div>{e.message}</div><div class="muted small">Enquiry form · {fmtDateTime(e.created_at)}</div></div>}
            {msgs.map((m) => (
              <div class={`msg msg-${m.sender} ${m.channel === 'note' ? 'msg-note' : ''}`} id={`m${m.id}`}>
                {m.media_key && m.media_type?.startsWith('audio') && (
                  <div class="voice">🎤 Voice note <audio controls preload="none" src={`/staff/media/${encodeURIComponent(m.media_key)}`}></audio>
                    {m.transcript ? <div class="transcript"><span class="ai-badge sm">AI</span> {m.transcript}</div> : <div class="muted small">Transcribing…</div>}
                  </div>
                )}
                {m.media_key && m.media_type?.startsWith('image') && <img class="msg-img" src={`/staff/media/${encodeURIComponent(m.media_key)}`} alt="Photo from guest" />}
                {m.body && <div>{m.body}</div>}
                {m.translation && <div class="translation"><span class="ai-badge sm">AI</span> {m.translation}</div>}
                <div class="muted small">
                  {m.sender === 'guest' ? e.guest_name : m.sender === 'staff' ? m.staff_name ?? 'Staff' : m.sender} · {m.channel} · {fmtDateTime(m.created_at)}
                  {(m.body || m.transcript) && !m.translation && <> · <button class="linklike small" data-ai-post={`/staff/messages/${m.id}/translate`} data-target={`#m${m.id} .tr-slot`}>Translate</button></>}
                </div>
                <div class="tr-slot translation-slot"></div>
              </div>
            ))}
          </div>
          <form method="post" action={`/staff/enquiries/${e.id}/reply`} class="reply-box stack">
            <div class="row wrap-row">
              <select class="template-pick" aria-label="Templates">
                <option value="">Templates…</option>
                {quick.map((t) => <option value={t}>{t.slice(0, 50)}…</option>)}
                {templates.map(([k, t]) => <option value={fillTemplate(t, { name: e.guest_name })}>{k}</option>)}
              </select>
              <button type="button" class="btn btn-sm btn-outline" data-ai-post={`/staff/enquiries/${e.id}/suggest`} data-fill="#reply-text">✨ Suggest reply</button>
            </div>
            <textarea id="reply-text" name="body" rows={4} required maxlength={4000} placeholder={`Reply to ${e.guest_name}…`}></textarea>
            <div class="row-between">
              <Select name="channel" value={e.chat_room ? 'chat' : e.phone ? 'whatsapp' : 'website'} options={[['whatsapp', 'Send on WhatsApp'], ['website', 'Website message only'], ...(e.chat_room ? [['chat', 'Live chat'] as [string, string]] : [])]} />
              <button class="btn">Send</button>
            </div>
            <p class="muted small">AI drafts are suggestions — nothing is sent until you click Send.</p>
          </form>
        </section>

        <aside class="ws-right card">
          <h3>Enquiry details</h3>
          <form method="post" action={`/staff/enquiries/${e.id}/details`} class="stack">
            <Field label="Destination"><input name="destination" value={e.destination ?? ''} /></Field>
            <div class="row">
              <Field label="Check-in"><input type="date" name="check_in" value={e.check_in ?? ''} /></Field>
              <Field label="Check-out"><input type="date" name="check_out" value={e.check_out ?? ''} /></Field>
            </div>
            <div class="row">
              <Field label="Adults"><input type="number" name="adults" value={e.adults} min="1" /></Field>
              <Field label="Children"><input type="number" name="children" value={e.children} min="0" /></Field>
            </div>
            <Field label="Budget ₹"><input type="number" name="budget" value={e.budget ?? ''} min="0" step="500" /></Field>
            <Field label="Assigned to"><Select name="assigned_to" value={e.assigned_to ?? ''} options={[['', 'Unassigned'], ...staff.map((s) => [s.id, s.name] as [number, string])]} /></Field>
            <button class="btn btn-sm btn-outline">Save details</button>
          </form>
          <h3 class="mt">Top matches <span class="ai-badge sm">AI</span></h3>
          {matches.length === 0 && <p class="muted small">No available matches — try the property finder.</p>}
          {matches.map((p) => (
            <div class="match">
              <img src={mediaUrl(p.photo, 200)} alt="" />
              <div>
                <a href={`/stay/${p.slug}`} target="_blank"><strong>{p.name}</strong></a>
                <div class="muted small">{p.destination} · from {money(p.from_price)} · ★{p.rating_avg.toFixed(1)}</div>
                <form method="post" action={`/staff/quotes/new?enquiry=${e.id}&property=${p.id}`} class="inline"><button class="linklike small">Quote this →</button></form>
              </div>
            </div>
          ))}
          <h3 class="mt">Quotations</h3>
          {quotes.length === 0 && <p class="muted small">None yet.</p>}
          {quotes.map((q) => <div class="list-item sub"><a href={`/staff/quotes/${q.id}`}>{q.code}</a> <Pill s={q.status} /> <span class="small">{money(q.total)} · 👁 {q.view_count}</span></div>)}
          <h3 class="mt">Follow-ups</h3>
          {tasks.map((t) => <div class="small">• {t.reason} — {fmtDateTime(t.due_at)}</div>)}
          <form method="post" action="/staff/tasks" class="stack">
            <input type="hidden" name="enquiry_id" value={e.id} />
            <input name="reason" placeholder="Reason (e.g. call about quote)" required />
            <input type="datetime-local" name="due" required />
            <button class="btn btn-sm btn-outline">Set follow-up</button>
          </form>
        </aside>
      </div>
    </div>
  ))
})

staffRoutes.post('/staff/enquiries/:id/details', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  const checkIn = isDate(f.check_in) ? f.check_in : null
  await run(
    c.env,
    'UPDATE enquiries SET destination = ?, check_in = ?, check_out = ?, adults = ?, children = ?, budget = ?, assigned_to = ?, updated_at = ? WHERE id = ?',
    str(f.destination, 60) || null, checkIn, isDate(f.check_out) && checkIn && f.check_out > checkIn ? f.check_out : null,
    Math.max(1, int(f.adults, 1)), Math.max(0, int(f.children)), int(f.budget) || null, int(f.assigned_to) || null, nowIso(), e.id,
  )
  await logActivity(c.env, u.id, 'enquiry.updated', 'enquiry', e.id)
  return redirectMsg(c, `/staff/enquiries/${e.id}`, { ok: 'Saved.' })
})

staffRoutes.post('/staff/enquiries/:id/note', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  if (str(f.note)) await run(c.env, "INSERT INTO guest_notes (user_id, phone, note, kind, source, created_by) VALUES (?, ?, ?, ?, 'staff', ?)", e.user_id, e.phone, str(f.note, 500), f.preference ? 'preference' : 'note', u.id)
  return c.redirect(`/staff/enquiries/${e.id}`, 303)
})

staffRoutes.post('/staff/notes/:id/delete', requirePerm('manage_enquiries'), async (c) => {
  await run(c.env, 'DELETE FROM guest_notes WHERE id = ?', int(c.req.param('id')))
  return c.redirect(c.req.header('referer') ?? '/staff', 303)
})

staffRoutes.post('/staff/enquiries/:id/reply', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.notFound()
  const f = await form(c)
  const body = str(f.body, 4000)
  if (!body) return c.redirect(`/staff/enquiries/${e.id}`, 303)
  const channel = f.channel === 'whatsapp' && e.phone ? 'whatsapp' : f.channel === 'chat' && e.chat_room ? 'chat' : 'website'
  let externalId: string | null = null
  if (channel === 'whatsapp') {
    const r = await sendWhatsApp(c.env, e.phone!, body)
    if (!r.ok) return redirectMsg(c, `/staff/enquiries/${e.id}`, { err: `WhatsApp failed: ${r.error}. (Outside 24h window? Use a template.)` })
    externalId = r.id ?? null
  }
  if (channel === 'chat') {
    const stub = c.env.CHAT.get(c.env.CHAT.idFromName(e.chat_room!))
    await stub.fetch('https://chat/staff-message', { method: 'POST', body: JSON.stringify({ text: body, name: u.name }) })
  }
  await run(c.env, "INSERT INTO messages (enquiry_id, sender, user_id, channel, body, external_id) VALUES (?, 'staff', ?, ?, ?, ?)", e.id, u.id, channel, body, externalId)
  await run(
    c.env,
    "UPDATE enquiries SET last_staff_reply_at = ?, first_response_at = COALESCE(first_response_at, ?), waiting_on = 'guest', status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?",
    nowIso(), nowIso(), u.id, nowIso(), e.id,
  )
  await enqueue(c.env, { type: 'guest_prefs', enquiryId: e.id })
  return c.redirect(`/staff/enquiries/${e.id}#thread`, 303)
})

staffRoutes.post('/staff/enquiries/:id/suggest', requirePerm('manage_enquiries'), async (c) => {
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.json({ error: 'not found' }, 404)
  const msgs = await all<MessageRow>(c.env, "SELECT * FROM messages WHERE enquiry_id = ? AND channel != 'note' ORDER BY id DESC LIMIT 12", e.id)
  const text = await replySuggestion(c.env, e, msgs.reverse(), c.get('user')!.name)
  return c.json(text ? { text } : { error: 'AI reply suggestions are off or unavailable.' })
})

staffRoutes.post('/staff/enquiries/:id/summary', requirePerm('manage_enquiries'), async (c) => {
  const e = await loadEnquiryFor(c, int(c.req.param('id')))
  if (!e) return c.json({ error: 'not found' }, 404)
  const msgs = await all<MessageRow>(c.env, 'SELECT * FROM messages WHERE enquiry_id = ? ORDER BY id', e.id)
  const text = await enquirySummary(c.env, e, msgs)
  if (text) await run(c.env, 'UPDATE enquiries SET summary = ? WHERE id = ?', text, e.id)
  return c.json(text ? { text } : { error: 'AI summary is off or unavailable.' })
})

staffRoutes.post('/staff/messages/:id/translate', requireStaff, async (c) => {
  const m = await first<MessageRow>(c.env, 'SELECT * FROM messages WHERE id = ?', int(c.req.param('id')))
  if (!m) return c.json({ error: 'not found' }, 404)
  const text = m.transcript ?? m.body
  const src = detectLanguage(text)
  const out = await aiTranslate(c.env, text, src, src === 'ml' ? 'en' : 'ml')
  if (!out) return c.json({ error: 'Translation is off or unavailable.' })
  await run(c.env, 'UPDATE messages SET translation = ? WHERE id = ?', out, m.id)
  return c.json({ text: out })
})

// Private media (voice notes, WhatsApp images) for staff only.
staffRoutes.get('/staff/media/:key', async (c) => {
  const key = decodeURIComponent(c.req.param('key'))
  if (key.includes('..')) return c.notFound()
  const obj = await c.env.MEDIA.get(key)
  if (!obj) return c.notFound()
  const h = new Headers()
  obj.writeHttpMetadata(h)
  h.set('cache-control', 'private, max-age=3600')
  return new Response(obj.body, { headers: h })
})

// ---------- 28. Guests ----------
export async function renderGuests(c: Context<AppEnv>, admin: boolean) {
  const q = str(c.req.query('q'), 60)
  const pg = pageNum(c)
  const rows = await all<{ id: number; name: string; phone: string | null; email: string | null; bookings: number; spent: number; last_trip: string | null; blocked: number }>(
    c.env,
    `SELECT u.id, u.name, u.phone, u.email, u.blocked,
       (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('confirmed','checked_in','completed')) AS bookings,
       (SELECT COALESCE(SUM(b.total),0) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('confirmed','checked_in','completed')) AS spent,
       (SELECT MAX(b.check_in) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('confirmed','checked_in','completed')) AS last_trip
     FROM users u WHERE u.role = 'guest' AND u.merged_into IS NULL ${q ? 'AND (u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ?)' : ''}
     ORDER BY last_trip DESC NULLS LAST, u.id DESC LIMIT 51 OFFSET ?`,
    ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), (pg - 1) * 50,
  )
  const base = admin ? '/admin/guests' : '/staff/guests'
  return page(c, { title: admin ? 'All guests' : 'Guests', area: admin ? 'admin' : 'staff', active: admin ? 'all-guests' : 'guests' }, (
    <div class="stack-lg">
      <div class="row-between">
        <h1>{admin ? 'All guests' : 'Guests'}</h1>
        {admin && <div class="row"><a class="btn btn-sm btn-outline" href="/admin/guests/export">Export CSV</a><a class="btn btn-sm btn-outline" href="/admin/guests/duplicates">Find duplicates</a></div>}
      </div>
      <form method="get" class="row filters-inline"><input name="q" value={q} placeholder="Search name, phone, email" /><button class="btn btn-sm">Search</button></form>
      <Table head={['Guest', 'Phone', 'Bookings', 'Total spent', 'Last trip', '']}>
        {rows.slice(0, 50).map((g) => (
          <tr>
            <td><a href={`/staff/guests/${g.id}`}>{g.name || '—'}</a>{g.blocked ? <span class="pill pill-cancelled">blocked</span> : null}<div class="muted small">{g.email}</div></td>
            <td>{g.phone}</td><td>{g.bookings}</td><td>{money(g.spent)}</td><td>{fmtDate(g.last_trip)}</td>
            <td><a class="btn btn-sm" href={`/staff/guests/${g.id}`}>Profile</a></td>
          </tr>
        ))}
      </Table>
      <Pager page={pg} hasMore={rows.length > 50} base={`${base}?q=${encodeURIComponent(q)}`} />
    </div>
  ))
}
staffRoutes.get('/staff/guests', requirePerm('manage_enquiries'), (c) => renderGuests(c, false))

staffRoutes.get('/staff/guests/:id', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const g = await first<{ id: number; name: string; phone: string | null; email: string | null; language: string; blocked: number; created_at: string }>(c.env, "SELECT id, name, phone, email, language, blocked, created_at FROM users WHERE id = ? AND role = 'guest'", int(c.req.param('id')))
  if (!g) return c.notFound()
  const [bookings, enquiries, notes, msgs, travellers] = await Promise.all([
    all<{ id: number; code: string; property_name: string; check_in: string; total: number; status: string }>(c.env, 'SELECT b.id, b.code, p.name AS property_name, b.check_in, b.total, b.status FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.user_id = ? ORDER BY b.check_in DESC', g.id),
    all<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE user_id = ? OR (phone = ? AND phone IS NOT NULL) ORDER BY id DESC', g.id, g.phone ?? '-'),
    all<{ id: number; note: string; kind: string; source: string; created_at: string }>(c.env, 'SELECT * FROM guest_notes WHERE user_id = ? OR (phone = ? AND phone IS NOT NULL) ORDER BY kind DESC, id DESC', g.id, g.phone ?? '-'),
    all<MessageRow & { code: string | null }>(c.env, 'SELECT m.*, e.code FROM messages m LEFT JOIN enquiries e ON e.id = m.enquiry_id WHERE (e.user_id = ? OR e.phone = ?) ORDER BY m.id DESC LIMIT 60', g.id, g.phone ?? '-'),
    all<{ name: string; age: number | null; relation: string | null }>(c.env, 'SELECT name, age, relation FROM travellers WHERE user_id = ?', g.id),
  ])
  const visibleEnq = enquiries.filter((e) => canSeeEnquiry(u, perms, e))
  return page(c, { title: g.name || 'Guest', area: 'staff', active: 'guests' }, (
    <div class="stack-lg">
      <a href="/staff/guests" class="small">← Guests</a>
      <div class="row-between">
        <h1>{g.name || 'Guest'} {g.blocked ? <span class="pill pill-cancelled">blocked</span> : null}</h1>
        {perms.manage_guests && <form method="post" action={`/admin/guests/${g.id}/block`}><button class="btn btn-sm btn-outline btn-danger">{g.blocked ? 'Unblock guest' : 'Block guest'}</button></form>}
      </div>
      <p>{g.phone} · {g.email} · prefers {g.language === 'ml' ? 'Malayalam' : 'English'} · since {fmtDate(g.created_at)}</p>
      {travellers.length > 0 && <p class="small">Travels with: {travellers.map((t) => `${t.name}${t.relation ? ` (${t.relation})` : ''}`).join(', ')}</p>}
      <div class="grid grid-2">
        <section class="card">
          <h3>Preferences & notes</h3>
          <ul class="plain">
            {notes.map((n) => (
              <li>
                {n.source === 'ai' && <span class="ai-badge sm">AI</span>} {n.kind === 'preference' ? <strong>{n.note}</strong> : n.note}
                <form method="post" action={`/staff/notes/${n.id}/edit`} class="inline-edit"><input name="note" value={n.note} /><button class="linklike small">Save</button></form>
                <form method="post" action={`/staff/notes/${n.id}/delete`} class="inline"><button class="linklike small">Delete</button></form>
              </li>
            ))}
          </ul>
          <form method="post" action={`/staff/guests/${g.id}/note`} class="row">
            <input name="note" placeholder="Add preference or note" required />
            <label class="check small"><input type="checkbox" name="preference" value="1" checked /> Preference</label>
            <button class="btn btn-sm">Add</button>
          </form>
        </section>
        <section class="card">
          <h3>Bookings</h3>
          <Table head={['Property', 'Check-in', 'Total', 'Status']}>
            {bookings.map((b) => <tr><td><a href={`/staff/bookings/${b.id}`}>{b.property_name}</a></td><td>{fmtDate(b.check_in)}</td><td>{money(b.total)}</td><td><Pill s={b.status} /></td></tr>)}
          </Table>
          <h3>Enquiries</h3>
          <ul class="plain">{visibleEnq.map((e) => <li><a href={`/staff/enquiries/${e.id}`}>{e.code}</a> · {e.destination ?? '—'} · <Pill s={e.status} /></li>)}</ul>
        </section>
      </div>
      <section class="card">
        <h3>All chats</h3>
        <div class="thread">
          {msgs.map((m) => <div class={`msg msg-${m.sender}`}><div>{m.transcript ?? m.body}</div><div class="muted small">{m.code} · {m.channel} · {fmtDateTime(m.created_at)}</div></div>)}
        </div>
      </section>
    </div>
  ))
})

staffRoutes.post('/staff/guests/:id/note', requirePerm('manage_enquiries'), async (c) => {
  const f = await form(c)
  const gid = int(c.req.param('id'))
  if (str(f.note)) await run(c.env, "INSERT INTO guest_notes (user_id, note, kind, source, created_by) VALUES (?, ?, ?, 'staff', ?)", gid, str(f.note, 500), f.preference ? 'preference' : 'note', c.get('user')!.id)
  return c.redirect(`/staff/guests/${gid}`, 303)
})

staffRoutes.post('/staff/notes/:id/edit', requirePerm('manage_enquiries'), async (c) => {
  const f = await form(c)
  if (str(f.note)) await run(c.env, "UPDATE guest_notes SET note = ?, source = 'staff' WHERE id = ?", str(f.note, 500), int(c.req.param('id')))
  return c.redirect(c.req.header('referer') ?? '/staff/guests', 303)
})

// ---------- 29. Follow-ups ----------
staffRoutes.get('/staff/tasks', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const perms = await permissionsFor(c.env, u.role)
  const mine = c.req.query('all') !== '1' || !perms.view_all_enquiries
  const now = nowIso()
  const endToday = new Date(Date.parse(todayIST() + 'T23:59:59+05:30')).toISOString()
  const rows = await all<{ id: number; reason: string; guest_name: string | null; phone: string | null; due_at: string; draft_message: string | null; enquiry_id: number | null; booking_id: number | null; quotation_id: number | null; staff_name: string | null }>(
    c.env,
    `SELECT t.*, s.name AS staff_name FROM tasks t LEFT JOIN users s ON s.id = t.assigned_to WHERE t.status = 'open' ${mine ? 'AND t.assigned_to = ?' : ''} ORDER BY t.due_at LIMIT 300`,
    ...(mine ? [u.id] : []),
  )
  const groups: [string, typeof rows][] = [
    ['Overdue', rows.filter((t) => t.due_at < now)],
    ['Today', rows.filter((t) => t.due_at >= now && t.due_at <= endToday)],
    ['Upcoming', rows.filter((t) => t.due_at > endToday)],
  ]
  return page(c, { title: 'Follow-ups', area: 'staff', active: 'tasks' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>Follow-ups</h1>{perms.view_all_enquiries && <a href={mine ? '/staff/tasks?all=1' : '/staff/tasks'} class="btn btn-sm btn-outline">{mine ? 'Show everyone’s' : 'Show mine'}</a>}</div>
      {groups.map(([label, list]) => (
        <section>
          <h2>{label} <span class="muted">({list.length})</span></h2>
          {list.length === 0 && <p class="muted">Nothing here.</p>}
          {list.map((t) => (
            <div class={`card task ${label === 'Overdue' ? 'task-overdue' : ''}`}>
              <div class="row-between">
                <div><strong>{t.guest_name ?? 'Guest'}</strong> — {t.reason}<div class="muted small">Due {fmtDateTime(t.due_at)}{!mine && t.staff_name ? ` · ${t.staff_name}` : ''}</div></div>
                <div class="row wrap-row">
                  {t.phone && <a class="btn btn-sm btn-outline" href={`tel:${t.phone}`}>📞 Call</a>}
                  {t.phone && <a class="btn btn-sm" target="_blank" rel="noopener" href={`https://wa.me/${t.phone.replace(/\D/g, '')}?text=${encodeURIComponent(t.draft_message ?? '')}`}>WhatsApp</a>}
                  {t.enquiry_id && <a class="btn btn-sm btn-outline" href={`/staff/enquiries/${t.enquiry_id}`}>Open</a>}
                  {t.booking_id && <a class="btn btn-sm btn-outline" href={`/staff/bookings/${t.booking_id}`}>Booking</a>}
                  <form method="post" action={`/staff/tasks/${t.id}/done`} class="inline"><button class="btn btn-sm btn-outline">Done</button></form>
                </div>
              </div>
              {t.draft_message && <div class="draft"><span class="ai-badge sm">AI draft</span> {t.draft_message}</div>}
            </div>
          ))}
        </section>
      ))}
    </div>
  ))
})

staffRoutes.post('/staff/tasks', requirePerm('manage_enquiries'), async (c) => {
  const u = c.get('user')!
  const f = await form(c)
  const e = f.enquiry_id ? await loadEnquiryFor(c, int(f.enquiry_id)) : null
  const due = f.due ? new Date(f.due + '+05:30').toISOString() : nowIso()
  const id = await insertId(c.env, 'INSERT INTO tasks (assigned_to, enquiry_id, guest_user_id, guest_name, phone, reason, due_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', e?.assigned_to ?? u.id, e?.id ?? null, e?.user_id ?? null, e?.guest_name ?? null, e?.phone ?? null, str(f.reason, 300), due, u.id)
  await enqueue(c.env, { type: 'followup_draft', taskId: id })
  return redirectMsg(c, e ? `/staff/enquiries/${e.id}` : '/staff/tasks', { ok: 'Follow-up set.' })
})

staffRoutes.post('/staff/tasks/:id/done', requirePerm('manage_enquiries'), async (c) => {
  await run(c.env, "UPDATE tasks SET status = 'done' WHERE id = ?", int(c.req.param('id')))
  return c.redirect(c.req.header('referer') ?? '/staff/tasks', 303)
})

// ---------- 30. Staff profile ----------
staffRoutes.get('/staff/profile', async (c) => {
  const u = c.get('user')!
  const me = await first<{ name: string; email: string | null; phone: string | null; photo_key: string | null; notify_settings: string }>(c.env, 'SELECT name, email, phone, photo_key, notify_settings FROM users WHERE id = ?', u.id)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const perf = await first<{ handled: number; booked: number; revenue: number; quotes: number }>(
    c.env,
    `SELECT (SELECT COUNT(*) FROM enquiries WHERE assigned_to = ? AND created_at >= ?) AS handled,
            (SELECT COUNT(*) FROM enquiries WHERE assigned_to = ? AND created_at >= ? AND status = 'booked') AS booked,
            (SELECT COALESCE(SUM(total),0) FROM bookings WHERE staff_id = ? AND created_at >= ? AND status IN ('confirmed','checked_in','completed')) AS revenue,
            (SELECT COUNT(*) FROM quotations WHERE staff_id = ? AND sent_at >= ?) AS quotes`,
    u.id, since, u.id, since, u.id, since, u.id, since,
  )
  const notify = parseJson<Record<string, boolean>>(me?.notify_settings, {})
  const events: [string, string][] = [['new_enquiry', 'New enquiries'], ['booking', 'New bookings'], ['quote_accepted', 'Quotes accepted'], ['refund_request', 'Refund requests'], ['low_review', 'Low-rated reviews'], ['daily_summary', 'Daily summary']]
  return page(c, { title: 'My profile', area: 'staff', active: 'profile' }, (
    <div class="stack-lg">
      <h1>My profile</h1>
      <div class="stats">
        <Stat label="Enquiries handled (30d)" value={perf?.handled ?? 0} />
        <Stat label="Conversion rate" value={perf?.handled ? `${Math.round(((perf.booked ?? 0) / perf.handled) * 100)}%` : '—'} />
        <Stat label="Quotes sent" value={perf?.quotes ?? 0} />
        <Stat label="Revenue closed" value={money(perf?.revenue ?? 0)} />
      </div>
      <div class="grid grid-2">
        <form method="post" action="/staff/profile" enctype="multipart/form-data" class="card stack">
          <h3>Details</h3>
          {me?.photo_key && <img class="avatar" src={mediaUrl(me.photo_key, 160)} alt="" />}
          <Field label="Photo"><input type="file" name="photo" accept="image/jpeg,image/png,image/webp" /></Field>
          <Field label="Name"><input name="name" value={me?.name} required /></Field>
          <Field label="Phone (for alerts & login)"><input value={me?.phone ?? ''} disabled /></Field>
          <Field label="Email"><input value={me?.email ?? ''} disabled /></Field>
          <h4>WhatsApp notifications</h4>
          {events.map(([k, l]) => <label class="check"><input type="checkbox" name={`n_${k}`} value="1" checked={notify[k] !== false} /> {l}</label>)}
          <button class="btn">Save</button>
        </form>
        <form method="post" action="/staff/profile/password" class="card stack">
          <h3>Change password</h3>
          <Field label="Current password"><input type="password" name="current" autocomplete="current-password" /></Field>
          <Field label="New password"><input type="password" name="password" minlength={8} required autocomplete="new-password" /></Field>
          <button class="btn btn-outline">Update password</button>
        </form>
      </div>
    </div>
  ))
})

staffRoutes.post('/staff/profile', async (c) => {
  const u = c.get('user')!
  const body = await c.req.parseBody()
  const photo = body.photo
  let key: string | null = null
  if (photo instanceof File && photo.size > 0 && photo.size < 4 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(photo.type)) {
    key = `staff/${u.id}-${Date.now()}.${photo.type.split('/')[1]}`
    await c.env.MEDIA.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } })
  }
  const notify: Record<string, boolean> = {}
  for (const k of ['new_enquiry', 'booking', 'quote_accepted', 'refund_request', 'low_review', 'daily_summary']) notify[k] = body[`n_${k}`] === '1'
  await run(c.env, 'UPDATE users SET name = ?, notify_settings = ?, photo_key = COALESCE(?, photo_key) WHERE id = ?', str(body.name as string, 80) || u.name, JSON.stringify(notify), key, u.id)
  return redirectMsg(c, '/staff/profile', { ok: 'Profile saved.' })
})

staffRoutes.post('/staff/profile/password', async (c) => {
  const u = c.get('user')!
  const f = await form(c)
  const me = await first<{ password_hash: string | null }>(c.env, 'SELECT password_hash FROM users WHERE id = ?', u.id)
  if (me?.password_hash && !(await verifyPassword(f.current ?? '', me.password_hash))) return redirectMsg(c, '/staff/profile', { err: 'Current password is wrong.' })
  if ((f.password ?? '').length < 8) return redirectMsg(c, '/staff/profile', { err: 'Use at least 8 characters.' })
  await run(c.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(f.password), u.id)
  await logActivity(c.env, u.id, 'password.changed', 'user', u.id)
  return redirectMsg(c, '/staff/profile', { ok: 'Password updated.' })
})
