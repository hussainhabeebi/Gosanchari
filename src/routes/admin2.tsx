// Admin pages 41–47: staff & roles, reports, Ask AI, reviews, website content, settings, activity log.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, ChartHead, Empty, Field, jsonScript, Pager, Pill, Select, Stat, Table } from '../views/components'
import { hashPassword, permissionsFor, requirePerm, requireStaff } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, run } from '../lib/db'
import { askAi } from '../lib/assist'
import { DEFAULT_PERMISSIONS, PERMISSION_LABELS, ROLE_LABELS, STAFF_ROLES, type PermissionKey, type Permissions, type Role } from '../lib/permissions'
import { AI_FEATURES, DEFAULT_SETTINGS, getContent, getSettings, saveContent, saveSetting, type AiFeature, type Settings } from '../lib/settings'
import { mediaUrl } from '../lib/integrations'
import type { TaxSlab } from '../lib/pricing'
import type { ReviewRow } from '../lib/types'
import { addDays, fmtDate, fmtDateTime, int, isDate, money, normalizePhone, parseJson, slugify, str, toCsv, todayIST } from '../lib/util'
import { form, pageNum, redirectMsg } from './helpers'
import { destinations } from '../lib/properties'
import { MOODS, sceneSvg, type Mood } from '../views/moods'
import { raw } from 'hono/html'
import { geminiKey, maskKey, setGeminiKey, testGeminiKey } from '../lib/gemini'

export const admin2Routes = new Hono<AppEnv>()
admin2Routes.use('/admin/*', requireStaff)

const CONFIRMED = "status IN ('confirmed','checked_in','completed')"

// ---------- 41. Staff and roles ----------
admin2Routes.get('/admin/staff', requirePerm('manage_staff'), async (c) => {
  const s = await getSettings(c.env)
  const staff = await all<{ id: number; name: string; phone: string | null; email: string | null; role: Role; active: number; created_at: string }>(c.env, "SELECT id, name, phone, email, role, active, created_at FROM users WHERE role != 'guest' ORDER BY active DESC, role, name")
  const dests = await all<{ user_id: number; destination: string }>(c.env, 'SELECT * FROM staff_destinations')
  const allDests = await destinations(c.env)
  const editable: Role[] = ['manager', 'sales', 'accounts']
  const keys = Object.keys(PERMISSION_LABELS) as PermissionKey[]
  const effective = (r: Role) => ({ ...DEFAULT_PERMISSIONS[r], ...(s.role_permissions[r] ?? {}) }) as Permissions
  return page(c, { title: 'Staff & roles', area: 'admin', active: 'staff' }, (
    <div class="stack-lg">
      <h1>Staff and roles</h1>
      <Table head={['Name', 'Phone / email', 'Role', 'Destinations', 'Status', '']}>
        {staff.map((u) => (
          <tr class={u.active ? '' : 'muted'}>
            <td colSpan={6}>
              <form method="post" action={`/admin/staff/${u.id}`} class="row wrap-row">
                <input name="name" value={u.name} required class="w-md" />
                <span class="small">{u.phone}<br />{u.email}</span>
                <Select name="role" value={u.role} options={STAFF_ROLES.map((r) => [r, ROLE_LABELS[r]])} />
                <select name="destinations" multiple size={3} class="w-md">{allDests.map((d) => <option value={d} selected={dests.some((x) => x.user_id === u.id && x.destination === d)}>{d}</option>)}</select>
                <label class="check"><input type="checkbox" name="active" value="1" checked={!!u.active} /> active</label>
                <input type="password" name="password" placeholder="New password (optional)" minlength={8} class="w-md" autocomplete="new-password" />
                <button class="btn btn-sm btn-outline">Save</button>
              </form>
            </td>
          </tr>
        ))}
      </Table>
      <form method="post" action="/admin/staff" class="card stack">
        <h2>Add staff member</h2>
        <div class="row">
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Mobile (for login code & alerts)"><input name="phone" inputmode="tel" /></Field>
          <Field label="Email"><input type="email" name="email" /></Field>
        </div>
        <div class="row">
          <Field label="Role"><Select name="role" value="sales" options={STAFF_ROLES.map((r) => [r, ROLE_LABELS[r]])} /></Field>
          <Field label="Password (optional; they can log in with a phone code)"><input type="password" name="password" minlength={8} autocomplete="new-password" /></Field>
        </div>
        <button class="btn">Add staff</button>
      </form>
      <form method="post" action="/admin/staff/permissions" class="card stack">
        <h2>Permissions by role</h2>
        <p class="muted small">Admins always have every permission. Example: Sales can't see net rates and can give at most 5% discount.</p>
        <Table head={['Permission', ...editable.map((r) => ROLE_LABELS[r])]}>
          {keys.map((k) => (
            <tr>
              <td>{PERMISSION_LABELS[k]}</td>
              {editable.map((r) => (
                <td>{k === 'max_discount_pct'
                  ? <input type="number" name={`${r}.${k}`} value={effective(r)[k]} min="0" max="100" class="w-sm" />
                  : <input type="checkbox" name={`${r}.${k}`} value="1" checked={!!effective(r)[k]} aria-label={`${ROLE_LABELS[r]}: ${PERMISSION_LABELS[k]}`} />}
                </td>
              ))}
            </tr>
          ))}
        </Table>
        <button class="btn">Save permissions</button>
      </form>
    </div>
  ))
})

admin2Routes.post('/admin/staff', requirePerm('manage_staff'), async (c) => {
  const f = await form(c)
  const phone = normalizePhone(f.phone)
  const email = str(f.email, 120).toLowerCase() || null
  if (!str(f.name) || (!phone && !email)) return redirectMsg(c, '/admin/staff', { err: 'Name and a phone or email are required.' })
  const role = (STAFF_ROLES as string[]).includes(f.role) ? (f.role as Role) : 'sales'
  const existing = await first<{ id: number; role: string }>(c.env, 'SELECT id, role FROM users WHERE (phone = ? AND ? IS NOT NULL) OR (email = ? AND ? IS NOT NULL)', phone, phone, email, email)
  let id: number
  if (existing) {
    await run(c.env, 'UPDATE users SET role = ?, name = ?, active = 1 WHERE id = ?', role, str(f.name, 80), existing.id)
    id = existing.id
  } else {
    id = await insertId(c.env, 'INSERT INTO users (role, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)', role, str(f.name, 80), phone, email, f.password && f.password.length >= 8 ? await hashPassword(f.password) : null)
  }
  await logActivity(c.env, c.get('user')!.id, 'staff.added', 'user', id, { role })
  return redirectMsg(c, '/admin/staff', { ok: existing ? 'Existing account promoted to staff.' : 'Staff member added.' })
})

admin2Routes.post('/admin/staff/permissions', requirePerm('manage_staff'), async (c) => {
  const f = await form(c)
  const out: Partial<Record<Role, Partial<Permissions>>> = {}
  for (const r of ['manager', 'sales', 'accounts'] as Role[]) {
    const p: Partial<Permissions> = {}
    for (const k of Object.keys(PERMISSION_LABELS) as PermissionKey[]) {
      if (k === 'max_discount_pct') p.max_discount_pct = Math.max(0, Math.min(100, parseFloat(f[`${r}.${k}`]) || 0))
      else (p as Record<string, boolean>)[k] = f[`${r}.${k}`] === '1'
    }
    out[r] = p
  }
  await saveSetting(c.env, 'role_permissions', out)
  await logActivity(c.env, c.get('user')!.id, 'permissions.updated', 'settings', 'role_permissions', out)
  return redirectMsg(c, '/admin/staff', { ok: 'Permissions saved.' })
})

admin2Routes.post('/admin/staff/:id', requirePerm('manage_staff'), async (c) => {
  const id = int(c.req.param('id'))
  const me = c.get('user')!
  const f = await form(c)
  const role = (STAFF_ROLES as string[]).includes(f.role) ? (f.role as Role) : 'sales'
  if (id === me.id && (role !== 'admin' || !f.active)) return redirectMsg(c, '/admin/staff', { err: "You can't remove your own admin access." })
  const before = await first<{ role: string; active: number }>(c.env, 'SELECT role, active FROM users WHERE id = ?', id)
  await run(c.env, "UPDATE users SET name = ?, role = ?, active = ? WHERE id = ? AND role != 'guest'", str(f.name, 80), role, f.active ? 1 : 0, id)
  if (f.password && f.password.length >= 8) await run(c.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(f.password), id)
  await run(c.env, 'DELETE FROM staff_destinations WHERE user_id = ?', id)
  for (const d of f.__all.destinations ?? []) await run(c.env, 'INSERT OR IGNORE INTO staff_destinations (user_id, destination) VALUES (?, ?)', id, d)
  await logActivity(c.env, me.id, 'staff.updated', 'user', id, { before, role, active: !!f.active, destinations: f.__all.destinations ?? [] })
  return redirectMsg(c, '/admin/staff', { ok: 'Saved.' })
})

// ---------- 42. Reports ----------
admin2Routes.get('/admin/reports', requirePerm('view_reports'), async (c) => {
  const from = isDate(c.req.query('from')) ? c.req.query('from')! : addDays(todayIST(), -29)
  const to = isDate(c.req.query('to')) ? c.req.query('to')! : todayIST()
  const fromTs = new Date(Date.parse(from + 'T00:00:00+05:30')).toISOString()
  const toTs = new Date(Date.parse(to + 'T23:59:59+05:30')).toISOString()
  const nights = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1)
  const [summary, occupancy, staffPerf, sources, funnel, cancellations, daily] = await Promise.all([
    first<{ bookings: number; revenue: number; nights: number; avg: number }>(c.env, `SELECT COUNT(*) AS bookings, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(nights * rooms_count),0) AS nights, COALESCE(AVG(total),0) AS avg FROM bookings WHERE ${CONFIRMED} AND created_at BETWEEN ? AND ?`, fromTs, toTs),
    all<{ name: string; units: number; sold: number; revenue: number }>(
      c.env,
      `SELECT p.name, (SELECT COALESCE(SUM(units),0) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) AS units,
         COALESCE(SUM(MAX(0, julianday(MIN(b.check_out, ?)) - julianday(MAX(b.check_in, ?))) * b.rooms_count), 0) AS sold, COALESCE(SUM(b.total), 0) AS revenue
       FROM properties p LEFT JOIN bookings b ON b.property_id = p.id AND b.${CONFIRMED} AND b.check_in <= ? AND b.check_out > ?
       WHERE p.status = 'live' GROUP BY p.id ORDER BY revenue DESC`,
      addDays(to, 1), from, to, from,
    ),
    all<{ name: string; enquiries: number; booked: number; quotes: number; revenue: number }>(
      c.env,
      `SELECT u.name,
         (SELECT COUNT(*) FROM enquiries e WHERE e.assigned_to = u.id AND e.created_at BETWEEN ? AND ?) AS enquiries,
         (SELECT COUNT(*) FROM enquiries e WHERE e.assigned_to = u.id AND e.created_at BETWEEN ? AND ? AND e.status = 'booked') AS booked,
         (SELECT COUNT(*) FROM quotations q WHERE q.staff_id = u.id AND q.sent_at BETWEEN ? AND ?) AS quotes,
         (SELECT COALESCE(SUM(total),0) FROM bookings b WHERE b.staff_id = u.id AND b.${CONFIRMED} AND b.created_at BETWEEN ? AND ?) AS revenue
       FROM users u WHERE u.role IN ('sales','manager','admin') AND u.active = 1 ORDER BY revenue DESC`,
      fromTs, toTs, fromTs, toTs, fromTs, toTs, fromTs, toTs,
    ),
    all<{ source: string; n: number; booked: number }>(c.env, "SELECT source, COUNT(*) AS n, SUM(status = 'booked') AS booked FROM enquiries WHERE created_at BETWEEN ? AND ? GROUP BY source ORDER BY n DESC", fromTs, toTs),
    first<{ enquiries: number; quoted: number; booked: number }>(
      c.env,
      `SELECT COUNT(*) AS enquiries, SUM(EXISTS (SELECT 1 FROM quotations q WHERE q.enquiry_id = e.id AND q.sent_at IS NOT NULL)) AS quoted, SUM(e.status = 'booked') AS booked FROM enquiries e WHERE e.created_at BETWEEN ? AND ?`,
      fromTs, toTs,
    ),
    all<{ name: string; n: number; value: number }>(c.env, "SELECT p.name, COUNT(*) AS n, SUM(b.total) AS value FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.status = 'cancelled' AND b.amount_paid > 0 AND b.cancelled_at BETWEEN ? AND ? GROUP BY p.id ORDER BY n DESC", fromTs, toTs),
    all<{ d: string; n: number; rev: number }>(c.env, `SELECT substr(created_at,1,10) AS d, COUNT(*) AS n, SUM(total) AS rev FROM bookings WHERE ${CONFIRMED} AND created_at BETWEEN ? AND ? GROUP BY d ORDER BY d`, fromTs, toTs),
  ])
  const exportName = c.req.query('export')
  if (exportName) {
    const map: Record<string, Record<string, unknown>[]> = { occupancy, staff: staffPerf, sources, cancellations, daily }
    const rows = map[exportName]
    if (!rows) return c.notFound()
    return new Response('\uFEFF' + toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${exportName}-${from}-${to}.csv"` } })
  }
  const qs = `from=${from}&to=${to}`
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
  return page(c, { title: 'Reports', area: 'admin', active: 'reports', head: <ChartHead /> }, (
    <div class="stack-lg">
      <h1>Reports</h1>
      <form method="get" class="row filters-inline">
        <Field label="From"><input type="date" name="from" value={from} /></Field>
        <Field label="To"><input type="date" name="to" value={to} /></Field>
        <button class="btn btn-sm">Apply</button>
      </form>
      <div class="stats">
        <Stat label="Bookings" value={summary?.bookings ?? 0} />
        <Stat label="Revenue" value={money(summary?.revenue ?? 0)} />
        <Stat label="Room-nights sold" value={summary?.nights ?? 0} />
        <Stat label="Average booking" value={money(summary?.avg ?? 0)} />
      </div>
      <section class="card">
        <div class="row-between"><h2>Bookings and revenue</h2><a class="small" href={`/admin/reports?${qs}&export=daily`}>Export</a></div>
        <canvas id="ch-report" height="120"></canvas>
        {jsonScript('report-data', { labels: daily.map((d) => d.d.slice(5)), bookings: daily.map((d) => d.n), revenue: daily.map((d) => d.rev) })}
      </section>
      <section class="card">
        <h2>Conversion funnel</h2>
        <div class="funnel">
          <div><strong>{funnel?.enquiries ?? 0}</strong> enquiries</div>
          <div>→ <strong>{funnel?.quoted ?? 0}</strong> quoted ({pct(funnel?.quoted ?? 0, funnel?.enquiries ?? 0)})</div>
          <div>→ <strong>{funnel?.booked ?? 0}</strong> booked ({pct(funnel?.booked ?? 0, funnel?.enquiries ?? 0)})</div>
        </div>
      </section>
      <section class="card">
        <div class="row-between"><h2>Occupancy per property</h2><a class="small" href={`/admin/reports?${qs}&export=occupancy`}>Export</a></div>
        <Table head={['Property', 'Room-nights sold', 'Available', 'Occupancy', 'Revenue']}>
          {occupancy.map((o) => <tr><td>{o.name}</td><td>{Math.round(o.sold)}</td><td>{o.units * nights}</td><td>{pct(o.sold, o.units * nights)}</td><td>{money(o.revenue)}</td></tr>)}
        </Table>
      </section>
      <div class="grid grid-2">
        <section class="card">
          <div class="row-between"><h2>Staff performance</h2><a class="small" href={`/admin/reports?${qs}&export=staff`}>Export</a></div>
          <Table head={['Staff', 'Enquiries', 'Quotes', 'Booked', 'Conversion', 'Revenue']}>
            {staffPerf.map((s) => <tr><td>{s.name}</td><td>{s.enquiries}</td><td>{s.quotes}</td><td>{s.booked}</td><td>{pct(s.booked, s.enquiries)}</td><td>{money(s.revenue)}</td></tr>)}
          </Table>
        </section>
        <section class="card">
          <div class="row-between"><h2>Enquiry sources</h2><a class="small" href={`/admin/reports?${qs}&export=sources`}>Export</a></div>
          <Table head={['Source', 'Enquiries', 'Booked', 'Conversion']}>{sources.map((s) => <tr><td>{s.source}</td><td>{s.n}</td><td>{s.booked}</td><td>{pct(s.booked, s.n)}</td></tr>)}</Table>
        </section>
      </div>
      <section class="card">
        <div class="row-between"><h2>Cancellations</h2><a class="small" href={`/admin/reports?${qs}&export=cancellations`}>Export</a></div>
        {cancellations.length === 0 ? <p class="muted">None in this period.</p> : <Table head={['Property', 'Cancelled', 'Value']}>{cancellations.map((x) => <tr><td>{x.name}</td><td>{x.n}</td><td>{money(x.value)}</td></tr>)}</Table>}
      </section>
    </div>
  ))
})

// ---------- 43. Ask AI ----------
admin2Routes.get('/admin/ask', requirePerm('ask_ai'), async (c) => {
  const u = c.get('user')!
  const q = str(c.req.query('q'), 300)
  const result = q ? await askAi(c.env, q) : null
  const historyKey = `askai:history:${u.id}`
  const history = (await c.env.KV.get<string[]>(historyKey, 'json')) ?? []
  if (q && result && !result.error) await c.env.KV.put(historyKey, JSON.stringify([q, ...history.filter((h) => h !== q)].slice(0, 10)), { expirationTtl: 30 * 86400 })
  if (q) await logActivity(c.env, u.id, 'ask_ai', 'ai', null, { question: q, sql: result?.sql, error: result?.error })
  const examples = ['Which property earned the most in the last 30 days?', 'Which staff member closed the most bookings last week?', 'How many enquiries came from Instagram this month?', 'Average booking value by destination this year']
  return page(c, { title: 'Ask AI', area: 'admin', active: 'ask', head: result?.chart ? <ChartHead /> : undefined }, (
    <div class="stack-lg">
      <h1>Ask AI <span class="ai-badge">AI</span></h1>
      <p class="muted">Ask a business question in plain words. The AI writes a safe, read-only query on your data and explains the result.</p>
      <form method="get" class="row ask-form">
        <input name="q" value={q} maxlength={300} placeholder="Which property earned the most in November?" required autofocus />
        <button class="btn">Ask</button>
      </form>
      <div class="chips">{[...history, ...examples].slice(0, 8).map((e) => <a class="chip" href={`/admin/ask?q=${encodeURIComponent(e)}`}>{e}</a>)}</div>
      {result && (
        <section class="card stack">
          {result.error ? <p class="error">{result.error}</p> : <AiNote>{result.explanation}</AiNote>}
          {result.rows.length === 1 && result.columns.length <= 2 ? (
            <div class="big-number">{result.columns.map((col) => <div><span class="muted small">{col}</span><strong>{String(result.rows[0][col] ?? '')}</strong></div>)}</div>
          ) : result.rows.length > 0 && (
            <Table head={result.columns}>{result.rows.slice(0, 50).map((r) => <tr>{result.columns.map((col) => <td>{typeof r[col] === 'number' && /total|revenue|amount|earn|value|spent/i.test(col) ? money(r[col] as number) : String(r[col] ?? '')}</td>)}</tr>)}</Table>
          )}
          {result.chart && <><canvas id="ch-ask" height="140"></canvas>{jsonScript('ask-data', result.chart)}</>}
          {result.sql && <details><summary class="small muted">Show query</summary><pre class="sql">{result.sql}</pre></details>}
        </section>
      )}
    </div>
  ))
})

// ---------- 44. Reviews ----------
admin2Routes.get('/admin/reviews', requirePerm('manage_reviews'), async (c) => {
  const status = c.req.query('status') ?? 'pending'
  const pg = pageNum(c)
  const rows = await all<ReviewRow & { property_name: string; slug: string }>(
    c.env,
    `SELECT r.*, p.name AS property_name, p.slug FROM reviews r JOIN properties p ON p.id = r.property_id ${status === 'all' ? '' : 'WHERE r.status = ?'} ORDER BY r.flagged DESC, r.id DESC LIMIT 31 OFFSET ?`,
    ...(status === 'all' ? [] : [status]), (pg - 1) * 30,
  )
  const problems = await all<{ body: string; period: string; property_id: number | null }>(c.env, "SELECT body, period, property_id FROM insights WHERE kind = 'review_problems' ORDER BY id DESC LIMIT 5")
  return page(c, { title: 'Reviews', area: 'admin', active: 'reviews' }, (
    <div class="stack-lg">
      <h1>Reviews</h1>
      {problems.map((p) => <AiNote label={`Problem alert (${p.period})`}>{p.body}</AiNote>)}
      <nav class="tabs">{[['pending', 'Waiting'], ['approved', 'Live'], ['hidden', 'Hidden'], ['all', 'All']].map(([k, l]) => <a href={`/admin/reviews?status=${k}`} class={status === k ? 'active' : ''}>{l}</a>)}</nav>
      {rows.length === 0 && <Empty>No reviews here.</Empty>}
      {rows.slice(0, 30).map((r) => (
        <div class={`card review-admin ${r.flagged ? 'flagged' : ''}`}>
          <div class="row-between">
            <div><strong>{r.guest_name}</strong> on <a href={`/stay/${r.slug}`} target="_blank">{r.property_name}</a> · {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} · {fmtDate(r.created_at)}</div>
            <div><Pill s={r.status} />{r.flagged ? <span class="pill pill-urgent" title={r.flag_reason ?? ''}>⚑ flagged: {r.flag_reason}</span> : null}</div>
          </div>
          <p>{r.body}</p>
          {parseJson<string[]>(r.photos, []).length > 0 && <div class="review-photos">{parseJson<string[]>(r.photos, []).map((k) => <img src={mediaUrl(k, 200)} alt="" />)}</div>}
          <form method="post" action={`/admin/reviews/${r.id}`} class="stack">
            <Field label="Public reply">
              <textarea name="reply" rows={2} placeholder={r.reply_draft ? '' : 'Write a reply (optional)'}>{r.reply ?? r.reply_draft ?? ''}</textarea>
            </Field>
            {!r.reply && r.reply_draft && <span class="small muted"><span class="ai-badge sm">AI</span> Draft reply — edit before saving.</span>}
            <div class="row">
              <button class="btn btn-sm" name="action" value="approve">Approve{r.status === 'approved' ? ' & save reply' : ''}</button>
              <button class="btn btn-sm btn-outline" name="action" value="hide">Hide</button>
            </div>
          </form>
        </div>
      ))}
      <Pager page={pg} hasMore={rows.length > 30} base={`/admin/reviews?status=${status}`} />
    </div>
  ))
})

admin2Routes.post('/admin/reviews/:id', requirePerm('manage_reviews'), async (c) => {
  const id = int(c.req.param('id'))
  const f = await form(c)
  const r = await first<ReviewRow>(c.env, 'SELECT * FROM reviews WHERE id = ?', id)
  if (!r) return c.notFound()
  const status = f.action === 'hide' ? 'hidden' : 'approved'
  await run(c.env, 'UPDATE reviews SET status = ?, reply = ? WHERE id = ?', status, str(f.reply, 1000) || null, id)
  await run(
    c.env,
    "UPDATE properties SET rating_avg = COALESCE((SELECT AVG(rating) FROM reviews WHERE property_id = ? AND status = 'approved'), 0), rating_count = (SELECT COUNT(*) FROM reviews WHERE property_id = ? AND status = 'approved') WHERE id = ?",
    r.property_id, r.property_id, r.property_id,
  )
  await logActivity(c.env, c.get('user')!.id, `review.${status}`, 'review', id)
  return c.redirect(c.req.header('referer') ?? '/admin/reviews', 303)
})

// ---------- 45. Website content ----------
admin2Routes.get('/admin/content', requirePerm('manage_content'), async (c) => {
  const content = await getContent(c.env)
  const [dests, props, reviews] = await Promise.all([
    all<{ id: number; name: string; image: string | null; blurb: string | null; popular: number; sort: number }>(c.env, 'SELECT * FROM destinations ORDER BY sort, name'),
    all<{ id: number; name: string; featured: number; status: string }>(c.env, "SELECT id, name, featured, status FROM properties WHERE status = 'live' ORDER BY name"),
    all<{ id: number; guest_name: string; rating: number; body: string; property_name: string }>(c.env, "SELECT r.id, r.guest_name, r.rating, r.body, p.name AS property_name FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.status = 'approved' AND r.rating >= 4 ORDER BY r.id DESC LIMIT 30"),
  ])
  return page(c, { title: 'Website content', area: 'admin', active: 'content' }, (
    <div class="stack-lg">
      <h1>Website content</h1>
      <section class="card stack" id="moods">
        <h2>Page moods — the solo traveller</h2>
        <p class="muted small">Each page opens with the same solo traveller in a different mood. They are drawn by default; upload a photo (wide, at least 1600 px, the traveller on the left) to use it instead.</p>
        <div class="mood-admin">
          {(Object.keys(MOODS) as Mood[]).map((m) => (
            <form method="post" action={`/admin/content/mood/${m}`} enctype="multipart/form-data" class="mood-card">
              <div class="mood-thumb">{content.mood_photos[m] ? <img src={mediaUrl(content.mood_photos[m]!, 600)} alt="" /> : raw(sceneSvg(m))}</div>
              <strong class="small">{MOODS[m].label}</strong>
              <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
              <div class="row wrap-row">
                <button class="btn btn-sm">Upload</button>
                {content.mood_photos[m] && <button class="btn btn-sm btn-outline" name="remove" value="1">Use drawing</button>}
              </div>
            </form>
          ))}
        </div>
      </section>
      <form method="post" action="/admin/content" class="stack">
        <section class="card stack">
          <h2>Home page banner</h2>
          <div class="row wrap-row">
            <Field label="Small line above"><input name="hero_kicker" value={content.hero.kicker ?? ''} placeholder="Explore · Stay · Unwind" /></Field>
            <Field label="Title" class="grow"><input name="hero_title" value={content.hero.title} /></Field>
            <Field label="Handwritten words"><input name="hero_script" value={content.hero.script ?? ''} placeholder="Your Way" /></Field>
          </div>
          <Field label="Subtitle"><input name="hero_subtitle" value={content.hero.subtitle} /></Field>
          <input type="hidden" name="hero_image" value={content.hero.image} />
          <Field label="Offer banners (one per line: Title | text | link)"><textarea name="banners" rows={3}>{content.banners.map((b) => `${b.title} | ${b.text} | ${b.link}`).join('\n')}</textarea></Field>
          <Field label="Why book with us (one per line: icon | title | text)"><textarea name="why_us" rows={4}>{content.why_us.map((w) => `${w.icon} | ${w.title} | ${w.text}`).join('\n')}</textarea></Field>
        </section>
        <section class="card stack">
          <h2>Featured properties</h2>
          <div class="facility-grid">{props.map((p) => <label class="check"><input type="checkbox" name="featured" value={p.id} checked={!!p.featured} /> {p.name}</label>)}</div>
          <h2>Guest reviews on the home page</h2>
          <p class="muted small">Pick 3–4; if none are picked, the latest 4–5★ reviews are shown.</p>
          {reviews.map((r) => <label class="check"><input type="checkbox" name="featured_reviews" value={r.id} checked={content.featured_review_ids.includes(r.id)} /> {r.guest_name} · {r.property_name} · {'★'.repeat(r.rating)} “{r.body.slice(0, 80)}…”</label>)}
        </section>
        <section class="card stack">
          <h2>FAQs</h2>
          <p class="muted small">Format: a line starting with “Q:” then a line starting with “A:”. The chat assistant re-reads these automatically.</p>
          <textarea name="faqs" rows={12}>{content.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}</textarea>
        </section>
        <section class="card stack">
          <h2>About and policies</h2>
          <Field label="About us"><textarea name="about" rows={5}>{content.about}</textarea></Field>
          <Field label="Cancellation and refund policy"><textarea name="policy_cancellation" rows={6}>{content.policies.cancellation}</textarea></Field>
          <Field label="Privacy policy"><textarea name="policy_privacy" rows={6}>{content.policies.privacy}</textarea></Field>
          <Field label="Terms"><textarea name="policy_terms" rows={6}>{content.policies.terms}</textarea></Field>
        </section>
        <div class="sticky-actions"><button class="btn">Save content</button></div>
      </form>
      <section class="card stack">
        <h2>Popular destinations</h2>
        {dests.map((d) => (
          <form method="post" action={`/admin/destinations/${d.id}`} enctype="multipart/form-data" class="row wrap-row dest-form">
            <img class="thumb" src={mediaUrl(d.image, 120)} alt="" />
            <input name="name" value={d.name} class="w-md" />
            <input name="blurb" value={d.blurb ?? ''} placeholder="Short line" />
            <input name="image" value={d.image ?? ''} placeholder="Image URL or upload →" class="w-md" />
            <input type="file" name="upload" accept="image/*" />
            <input type="number" name="sort" value={d.sort} class="w-sm" title="Order" />
            <label class="check small"><input type="checkbox" name="popular" value="1" checked={!!d.popular} /> show</label>
            <button class="btn btn-sm btn-outline">Save</button>
          </form>
        ))}
        <form method="post" action="/admin/destinations" class="row"><input name="name" placeholder="New destination" required /><button class="btn btn-sm">Add</button></form>
      </section>
    </div>
  ))
})

admin2Routes.post('/admin/content', requirePerm('manage_content'), async (c) => {
  const f = await form(c)
  const lines = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const faqs: { q: string; a: string }[] = []
  let cur: { q: string; a: string } | null = null
  for (const l of lines(f.faqs)) {
    if (/^Q:/i.test(l)) { if (cur) faqs.push(cur); cur = { q: l.slice(2).trim(), a: '' } }
    else if (/^A:/i.test(l) && cur) cur.a = l.slice(2).trim()
    else if (cur) cur.a += (cur.a ? ' ' : '') + l
  }
  if (cur) faqs.push(cur)
  await saveContent(c.env, 'hero', { title: str(f.hero_title, 120), script: str(f.hero_script, 40), kicker: str(f.hero_kicker, 60), subtitle: str(f.hero_subtitle, 240), image: str(f.hero_image, 500) })
  await saveContent(c.env, 'banners', lines(f.banners).map((l) => { const [title, text, link] = l.split('|').map((x) => x.trim()); return { title, text: text ?? '', link: link || '/offers' } }))
  await saveContent(c.env, 'why_us', lines(f.why_us).map((l) => { const [icon, title, text] = l.split('|').map((x) => x.trim()); return { icon, title, text: text ?? '' } }))
  await saveContent(c.env, 'faqs', faqs.filter((x) => x.q && x.a))
  await saveContent(c.env, 'about', str(f.about, 8000))
  await saveContent(c.env, 'policies', { cancellation: str(f.policy_cancellation, 20000), privacy: str(f.policy_privacy, 20000), terms: str(f.policy_terms, 20000) })
  await saveContent(c.env, 'featured_review_ids', (f.__all.featured_reviews ?? []).map(Number).filter(Boolean).slice(0, 4))
  const featured = (f.__all.featured ?? []).map(Number).filter(Boolean)
  await run(c.env, 'UPDATE properties SET featured = 0')
  for (const id of featured) await run(c.env, 'UPDATE properties SET featured = 1 WHERE id = ?', id)
  // FAQs/policies changed → AI Search re-reads them.
  await enqueue(c.env, { type: 'sync_kb', what: 'content' })
  await logActivity(c.env, c.get('user')!.id, 'content.updated', 'content', null, { faqs: faqs.length, featured })
  return redirectMsg(c, '/admin/content', { ok: 'Saved. The chat assistant will use the new FAQs and policies shortly.' })
})

admin2Routes.post('/admin/destinations', requirePerm('manage_content'), async (c) => {
  const f = await form(c)
  if (str(f.name)) await run(c.env, 'INSERT OR IGNORE INTO destinations (name, slug) VALUES (?, ?)', str(f.name, 60), slugify(f.name))
  return c.redirect('/admin/content', 303)
})

admin2Routes.post('/admin/destinations/:id', requirePerm('manage_content'), async (c) => {
  const body = await c.req.parseBody()
  let image = str(body.image as string, 500) || null
  const up = body.upload
  if (up instanceof File && up.size > 0 && up.size < 10 * 1024 * 1024 && up.type.startsWith('image/')) {
    image = `destinations/${crypto.randomUUID()}.${up.type.split('/')[1]}`
    await c.env.MEDIA.put(image, await up.arrayBuffer(), { httpMetadata: { contentType: up.type } })
  }
  await run(c.env, 'UPDATE destinations SET name = ?, blurb = ?, image = ?, sort = ?, popular = ? WHERE id = ?', str(body.name as string, 60), str(body.blurb as string, 200) || null, image, int(body.sort as string), body.popular ? 1 : 0, int(c.req.param('id')))
  return c.redirect('/admin/content', 303)
})

// ---------- 46. Settings ----------
admin2Routes.get('/admin/settings', requirePerm('manage_settings'), async (c) => {
  const s = await getSettings(c.env)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const usage = await all<{ feature: string; n: number; failed: number; avg_ms: number }>(c.env, 'SELECT feature, COUNT(*) AS n, SUM(ok = 0) AS failed, AVG(ms) AS avg_ms FROM ai_usage WHERE created_at >= ? GROUP BY feature ORDER BY n DESC', since)
  const today = parseInt((await c.env.KV.get(`ai:count:${todayIST()}`)) ?? '0', 10)
  const gkey = await geminiKey(c.env)
  const events = Object.keys(s.notifications) as (keyof Settings['notifications'])[]
  const eventLabel: Record<string, string> = { new_enquiry: 'New enquiry', booking: 'New booking', quote_accepted: 'Quote accepted by guest', refund_request: 'Refund request', low_review: 'Low-rated review', daily_summary: 'Daily summary', rate_expiry: 'Season rates ending (renew rates)', voucher_request: 'Booking voucher waiting for approval' }
  return page(c, { title: 'Settings', area: 'admin', active: 'settings' }, (
    <form method="post" action="/admin/settings" class="stack-lg">
      <h1>Settings</h1>
      <section class="card stack">
        <h2>Business</h2>
        <div class="row">
          <Field label="Name"><input name="b_name" value={s.business.name} /></Field>
          <Field label="Legal name (invoices)"><input name="b_legal_name" value={s.business.legal_name} /></Field>
          <Field label="Tagline"><input name="b_tagline" value={s.business.tagline} /></Field>
        </div>
        <div class="row">
          <Field label="Phone"><input name="b_phone" value={s.business.phone} /></Field>
          <Field label="WhatsApp number"><input name="b_whatsapp" value={s.business.whatsapp} /></Field>
          <Field label="Email"><input name="b_email" value={s.business.email} /></Field>
        </div>
        <Field label="Address"><input name="b_address" value={s.business.address} /></Field>
        <div class="row">
          <Field label="GSTIN"><input name="b_gstin" value={s.business.gstin} /></Field>
          <Field label="Invoice prefix"><input name="b_invoice_prefix" value={s.business.invoice_prefix} /></Field>
          <Field label="Instagram URL"><input name="b_instagram" value={s.business.social.instagram ?? ''} /></Field>
          <Field label="Facebook URL"><input name="b_facebook" value={s.business.social.facebook ?? ''} /></Field>
        </div>
        <Field label="GST slabs (one per line: up to ₹ per room-night | rate %; blank limit = above)">
          <textarea name="tax_slabs" rows={3}>{s.tax_slabs.map((t) => `${t.upto ?? ''} | ${t.rate}`).join('\n')}</textarea>
        </Field>
        <div class="row">
          <Field label="Rooms held for an unconfirmed booking (minutes)"><input type="number" name="hold_minutes" value={s.booking.hold_minutes} min="30" max="10080" /></Field>
          <Field label="Quote validity (days)"><input type="number" name="quote_validity_days" value={s.booking.quote_validity_days} min="1" max="60" /></Field>
        </div>
        <label class="check"><input type="checkbox" name="images_transform" value="1" checked={s.images_transform} /> Cloudflare Images resizing is enabled on this zone (serve resized photos)</label>
      </section>

      <section class="card stack">
        <h2>WhatsApp</h2>
        <p>Status: {c.env.WHATSAPP_TOKEN ? <span class="ok">Connected (number id {c.env.WHATSAPP_PHONE_NUMBER_ID})</span> : <span class="error">Not connected — messages are logged only</span>}. Webhook: <code>{c.env.SITE_URL}/webhooks/whatsapp</code></p>
        <Field label="Owner's WhatsApp (daily summary)"><input name="owner_whatsapp" value={s.owner_whatsapp} /></Field>
        {(Object.keys(s.whatsapp_templates) as (keyof Settings['whatsapp_templates'])[]).map((k) => (
          <Field label={`Template: ${k}`} hint="Placeholders: {name} {code} {property} {dates} {date} {amount} {time} {map} {address} {contact} {link} {valid}"><textarea name={`wa_${k}`} rows={2}>{s.whatsapp_templates[k]}</textarea></Field>
        ))}
      </section>

      <section class="card stack">
        <h2>Email</h2>
        <div class="row">
          <Field label="From"><input name="email_from" value={s.email.from} /></Field>
          <Field label="Reply-to"><input name="email_reply_to" value={s.email.reply_to} /></Field>
        </div>
        <p class="small">Status: {c.env.RESEND_API_KEY ? <span class="ok">Connected</span> : <span class="error">Not connected — emails are logged only</span>}</p>
      </section>

      <section class="card stack">
        <h2>Notifications (WhatsApp alerts to staff)</h2>
        <Table head={['Event', ...STAFF_ROLES.map((r) => ROLE_LABELS[r])]}>
          {events.map((e) => <tr><td>{eventLabel[e]}</td>{STAFF_ROLES.map((r) => <td><input type="checkbox" name={`n_${e}`} value={r} checked={s.notifications[e].includes(r)} /></td>)}</tr>)}
        </Table>
      </section>

      <section class="card stack">
        <h2>AI settings</h2>
        <div class="stats">
          <Stat label="AI calls today" value={`${today} / ${s.ai.daily_limit}`} tone={today > s.ai.daily_limit * 0.8 ? 'warn' : ''} />
          <Stat label="AI calls (30 days)" value={usage.reduce((a, u) => a + u.n, 0)} />
        </div>
        <p class="small">Cost, cache hits and hard rate limits are in the AI Gateway “{c.env.AI_GATEWAY_ID}” dashboard (Cloudflare → AI → AI Gateway).</p>
        <div class="upload-box stack" id="gemini">
          <h3>Google Gemini (recommended for the staff assistant and reading PDF / Word rate sheets)</h3>
          <p class="small muted">Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and paste it here. The key is stored privately and never shown again in full.</p>
          {gkey ? <p class="small ok">✓ Gemini key saved ({maskKey(gkey)}).</p> : <p class="small">No Gemini key yet — Workers AI is used.</p>}
          <div class="row wrap-row">
            <Field label={gkey ? 'Replace Gemini API key' : 'Gemini API key'}><input type="password" name="gemini_key" autocomplete="off" placeholder={gkey ? 'Leave blank to keep the saved key' : 'AIza…'} /></Field>
            <Field label="Gemini model"><input name="model_gemini" value={s.ai.models.gemini} placeholder={DEFAULT_SETTINGS.ai.models.gemini} /></Field>
            <Field label="Use for AI text"><Select name="ai_provider" value={s.ai.provider} options={[['auto', 'Gemini when a key is saved (fallback: Workers AI)'], ['workers', 'Always Workers AI']]} /></Field>
          </div>
          {gkey && <label class="check small"><input type="checkbox" name="gemini_remove" value="1" /> Remove the saved key</label>}
        </div>
        <h3>Features</h3>
        <div class="facility-grid">{(Object.keys(AI_FEATURES) as AiFeature[]).map((k) => <label class="check"><input type="checkbox" name="ai_features" value={k} checked={s.ai.features[k] !== false} /> {AI_FEATURES[k]}</label>)}</div>
        <Field label="Chat assistant welcome message"><textarea name="ai_welcome" rows={2}>{s.ai.assistant_welcome}</textarea></Field>
        <Field label="Tone"><input name="ai_tone" value={s.ai.assistant_tone} /></Field>
        <Field label="Topics always handed to staff (comma separated)"><input name="ai_handoff" value={s.ai.handoff_topics.join(', ')} /></Field>
        <Field label="Daily AI call limit"><input type="number" name="ai_limit" value={s.ai.daily_limit} min="0" /></Field>
        <details>
          <summary>Models</summary>
          {(Object.keys(s.ai.models) as (keyof Settings['ai']['models'])[]).filter((k) => k !== 'gemini').map((k) => <Field label={k}><input name={`model_${k}`} value={s.ai.models[k]} placeholder={DEFAULT_SETTINGS.ai.models[k]} /></Field>)}
        </details>
        <h3>Usage by feature (30 days)</h3>
        <Table head={['Feature', 'Calls', 'Failed', 'Avg time']}>{usage.map((u) => <tr><td>{AI_FEATURES[u.feature as AiFeature] ?? u.feature}</td><td>{u.n}</td><td>{u.failed}</td><td>{Math.round(u.avg_ms ?? 0)} ms</td></tr>)}</Table>
      </section>
      <div class="sticky-actions"><button class="btn">Save settings</button></div>
    </form>
  ))
})

admin2Routes.post('/admin/settings', requirePerm('manage_settings'), async (c) => {
  const f = await form(c)
  const s = await getSettings(c.env)
  const business: Settings['business'] = {
    ...s.business,
    name: str(f.b_name, 80) || s.business.name, legal_name: str(f.b_legal_name, 120), tagline: str(f.b_tagline, 160), phone: str(f.b_phone, 30),
    whatsapp: str(f.b_whatsapp, 20), email: str(f.b_email, 120), address: str(f.b_address, 300), gstin: str(f.b_gstin, 20), invoice_prefix: str(f.b_invoice_prefix, 10) || 'GSINV',
    social: { ...s.business.social, instagram: str(f.b_instagram, 200) || undefined, facebook: str(f.b_facebook, 200) || undefined },
  }
  const slabs: TaxSlab[] = (f.tax_slabs ?? '').split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x.length === 2 && x[1] !== '').map(([upto, rate]) => ({ upto: upto ? parseInt(upto, 10) : null, rate: parseFloat(rate) }))
  const templates = { ...s.whatsapp_templates }
  for (const k of Object.keys(templates) as (keyof typeof templates)[]) if (f[`wa_${k}`] != null) templates[k] = str(f[`wa_${k}`], 1000)
  const notifications = { ...s.notifications }
  for (const k of Object.keys(notifications) as (keyof typeof notifications)[]) notifications[k] = (f.__all[`n_${k}`] ?? []).filter((r): r is Role => (STAFF_ROLES as string[]).includes(r))
  const features = Object.fromEntries((Object.keys(AI_FEATURES) as AiFeature[]).map((k) => [k, (f.__all.ai_features ?? []).includes(k)])) as Record<AiFeature, boolean>
  const models = { ...s.ai.models }
  for (const k of Object.keys(models) as (keyof typeof models)[]) if (str(f[`model_${k}`])) models[k] = str(f[`model_${k}`], 120)
  await saveSetting(c.env, 'business', business)
  if (slabs.length && slabs.every((x) => Number.isFinite(x.rate))) await saveSetting(c.env, 'tax_slabs', slabs)
  await saveSetting(c.env, 'booking', { hold_minutes: Math.max(30, int(f.hold_minutes, 1440)), quote_validity_days: Math.max(1, int(f.quote_validity_days, 3)) })
  await saveSetting(c.env, 'whatsapp_templates', templates)
  await saveSetting(c.env, 'owner_whatsapp', normalizePhone(f.owner_whatsapp) ?? '')
  await saveSetting(c.env, 'email', { from: str(f.email_from, 120), reply_to: str(f.email_reply_to, 120) })
  await saveSetting(c.env, 'notifications', notifications)
  await saveSetting(c.env, 'images_transform', f.images_transform === '1')
  await saveSetting(c.env, 'ai', {
    features, assistant_welcome: str(f.ai_welcome, 500), assistant_tone: str(f.ai_tone, 100),
    handoff_topics: (f.ai_handoff ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    daily_limit: Math.max(0, int(f.ai_limit, 2000)), models, provider: f.ai_provider === 'workers' ? 'workers' : 'auto',
  })
  let keyMsg = ''
  const newKey = str(f.gemini_key, 200)
  if (f.gemini_remove) {
    await setGeminiKey(c.env, null)
    keyMsg = ' Gemini key removed.'
    await logActivity(c.env, c.get('user')!.id, 'settings.gemini_key_removed', 'settings', null)
  } else if (newKey) {
    const problem = await testGeminiKey(newKey, models.gemini)
    if (problem) return redirectMsg(c, '/admin/settings#gemini', { err: `Other settings saved, but the Gemini key did not work: ${problem.slice(0, 160)}` })
    await setGeminiKey(c.env, newKey)
    keyMsg = ' Gemini key saved and tested ✓.'
    await logActivity(c.env, c.get('user')!.id, 'settings.gemini_key_set', 'settings', null, { key: maskKey(newKey) })
  }
  const off = (Object.keys(features) as AiFeature[]).filter((k) => !features[k])
  await logActivity(c.env, c.get('user')!.id, 'settings.updated', 'settings', null, { aiOff: off, taxSlabs: slabs })
  return redirectMsg(c, '/admin/settings', { ok: `Settings saved.${keyMsg}` })
})

// ---------- 47. Activity log ----------
admin2Routes.get('/admin/activity', requirePerm('view_activity'), async (c) => {
  const showNet = (await permissionsFor(c.env, c.get('user')!.role)).view_net_rates
  const pg = pageNum(c)
  const userId = int(c.req.query('user'))
  const action = str(c.req.query('action'), 40)
  const date = isDate(c.req.query('date')) ? c.req.query('date')! : ''
  const where: string[] = []
  const binds: (string | number)[] = []
  if (userId) { where.push('a.user_id = ?'); binds.push(userId) }
  if (action) { where.push('a.action LIKE ?'); binds.push(`${action}%`) }
  if (date) { where.push('a.created_at >= ? AND a.created_at < ?'); binds.push(new Date(Date.parse(date + 'T00:00:00+05:30')).toISOString(), new Date(Date.parse(date + 'T00:00:00+05:30') + 86400000).toISOString()) }
  const rows = await all<{ id: number; action: string; entity: string; entity_id: string | null; details: string; created_at: string; name: string | null; role: string | null }>(
    c.env,
    `SELECT a.*, u.name, u.role FROM activity_log a LEFT JOIN users u ON u.id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 101 OFFSET ?`,
    ...binds, (pg - 1) * 100,
  )
  const staff = await all<{ id: number; name: string }>(c.env, "SELECT id, name FROM users WHERE role != 'guest' ORDER BY name")
  const important = /price|discount|cancel|refund|delete|permission|settings|merged|block|staff|export/
  const link = (entity: string, id: string | null) => {
    if (!id) return null
    const map: Record<string, string> = { booking: '/staff/bookings/', enquiry: '/staff/enquiries/', quotation: '/staff/quotes/', property: '/admin/properties/', user: '/staff/guests/' }
    return map[entity] ? map[entity] + id : null
  }
  return page(c, { title: 'Activity log', area: 'admin', active: 'activity' }, (
    <div class="stack-lg">
      <h1>Activity log</h1>
      <form method="get" class="row filters-inline wrap-row">
        <Select name="user" value={userId || ''} options={[['', 'Anyone'], ...staff.map((s) => [s.id, s.name] as [number, string])]} />
        <Select name="action" value={action} options={[['', 'Any action'], ['price', 'Price changes'], ['quote.discount', 'Discounts'], ['booking.cancel', 'Cancellations'], ['refund', 'Refunds'], ['photo.deleted', 'Deletions'], ['settings', 'Settings'], ['permissions', 'Permissions'], ['export', 'Exports'], ['login', 'Logins']]} />
        <input type="date" name="date" value={date} />
        <button class="btn btn-sm">Filter</button>
      </form>
      <Table head={['When', 'Who', 'What', 'Item', 'Details']}>
        {rows.slice(0, 100).map((a) => {
          const href = link(a.entity, a.entity_id)
          return (
            <tr class={important.test(a.action) ? 'row-amber' : ''}>
              <td class="nowrap small">{fmtDateTime(a.created_at)}</td>
              <td>{a.name ?? 'System / guest'}{a.role && a.role !== 'guest' ? <span class="muted small"> ({a.role})</span> : null}</td>
              <td><code>{a.action}</code></td>
              <td>{href ? <a href={href}>{a.entity} #{a.entity_id}</a> : `${a.entity}${a.entity_id ? ' #' + a.entity_id : ''}`}</td>
              <td class="small details-cell">{a.details !== '{}' ? (showNet ? a.details : a.details.replace(/"net(_rate)?":\s*-?\d+(\.\d+)?/g, '"net":"hidden"')).slice(0, 300) : ''}</td>
            </tr>
          )
        })}
      </Table>
      <Pager page={pg} hasMore={rows.length > 100} base={`/admin/activity?user=${userId || ''}&action=${action}&date=${date}`} />
    </div>
  ))
})

admin2Routes.post('/admin/content/mood/:mood', requirePerm('manage_content'), async (c) => {
  const mood = c.req.param('mood') as Mood
  if (!(mood in MOODS)) return c.notFound()
  const body = await c.req.parseBody()
  const content = await getContent(c.env)
  const photos = { ...content.mood_photos }
  const up = body.photo
  if (body.remove) delete photos[mood]
  else if (up instanceof File && up.size > 0) {
    if (!/^image\/(jpeg|png|webp)$/.test(up.type) || up.size > 15 * 1024 * 1024) return redirectMsg(c, '/admin/content#moods', { err: 'Please upload a JPG, PNG or WebP photo under 15 MB.' })
    const key = `site/moods/${mood}-${crypto.randomUUID()}.${up.type === 'image/jpeg' ? 'jpg' : up.type.split('/')[1]}`
    await c.env.MEDIA.put(key, up.stream(), { httpMetadata: { contentType: up.type } })
    photos[mood] = key
  } else return redirectMsg(c, '/admin/content#moods', { err: 'Choose a photo first.' })
  await saveContent(c.env, 'mood_photos', photos)
  await logActivity(c.env, c.get('user')!.id, 'content.mood_photo', 'content', null, { mood, removed: !!body.remove })
  return redirectMsg(c, '/admin/content#moods', { ok: body.remove ? 'Back to the drawn scene.' : 'Photo saved for this mood.' })
})
