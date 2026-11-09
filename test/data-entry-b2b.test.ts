// End to end through the real app (CSRF, sessions, password login): the Accounts role shown as Data Entry,
// individual Data Entry logins managed by an admin, and the B2B rate permissions enforced on the server.
// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
import { app } from '../src/index'
import { hashPassword } from '../src/lib/auth'
import { DEFAULT_PERMISSIONS, ROLE_LABELS, resolvePermissions } from '../src/lib/permissions'

const ORIGIN = 'http://localhost'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,address,status,commission_pct,is_partner,internal_notes) VALUES('green-valley','Green Valley Resort','resort','Wayanad','Vythiri','live',18,1,'Owner prefers calls after 6')").run().lastInsertRowid)
  const r1 = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units,net_rate,staff_rate) VALUES(?,'Pool Villa',9000,3,2,6000,7500)").run(pid).lastInsertRowid)
  const r2 = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Garden Room',5000,2,4)").run(pid).lastInsertRowid)
  const s1 = Number(db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,net_rate,kind,meal_plan) VALUES(?,?,'Christmas','2030-12-20','2030-12-31',12000,NULL,'special','CP')").run(pid, r1).lastInsertRowid)
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = []
      const st = {
        bind(...v: any[]) { args = v; return st },
        async all() { return { results: db.prepare(sql).all(...args) } },
        async first(col?: string) { const row = db.prepare(sql).get(...args) as any; return row == null ? null : col ? row[col] : row },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } } },
      }
      return st
    },
    async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } },
  }
  const kv = new Map<string, string>()
  const env: any = {
    DB, ENVIRONMENT: 'development', SITE_URL: ORIGIN,
    KV: { async get(k: string, t?: string) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v }, async put(k: string, v: string) { kv.set(k, v) }, async delete(k: string) { kv.delete(k) }, async list() { return { keys: [] } } },
    JOBS: { async send() {} }, MEDIA: { async get() { return null }, async put() {}, async delete() {} },
    ASSETS: { async fetch() { return new Response('') } },
  }
  const pending: Promise<unknown>[] = []
  const ctx: any = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} }
  const req = async (path: string, init: { method?: string; body?: Record<string, string>; cookie?: string; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {}
    if (init.cookie) headers.cookie = init.cookie
    if (init.method === 'POST' && init.origin !== null) headers.Origin = init.origin ?? ORIGIN
    const r = await app.request(ORIGIN + path, { method: init.method ?? 'GET', headers, body: init.body ? new URLSearchParams(init.body) : undefined }, env, ctx)
    await Promise.all(pending.splice(0))
    return r
  }
  const login = async (email: string, password: string) => {
    const r = await req('/login/password', { method: 'POST', body: { email, password } })
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]
    return { status: r.status, location: r.headers.get('location') ?? '', cookie: cookie.includes('=') && !cookie.endsWith('=') ? cookie : '' }
  }
  const staffUser = async (role: string, email: string, password = 'Passw0rd!') => {
    const id = Number(db.prepare('INSERT INTO users(role,name,email,password_hash) VALUES(?,?,?,?)').run(role, role + ' user', email, await hashPassword(password)).lastInsertRowid)
    return { id, cookie: (await login(email, password)).cookie }
  }
  const room = (id: number) => db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as any
  const season = (id: number) => db.prepare('SELECT * FROM season_rates WHERE id=?').get(id) as any
  const prop = () => db.prepare('SELECT * FROM properties WHERE id=?').get(pid) as any
  const setPerms = (perms: Record<string, unknown>) => { db.prepare("INSERT INTO settings(key,value) VALUES('role_permissions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(perms)); kv.delete('cache:settings:v1') }
  const msg = (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/\+/g, ' '))
  return { db, env, kv, req, login, staffUser, pid, r1, r2, s1, room, season, prop, setPerms, msg }
}

describe('Accounts role shown as Data Entry', () => {
  it('keeps the stored role value and every existing permission, and adds only B2B access', () => {
    expect(ROLE_LABELS.accounts).toBe('Data Entry')
    const p = DEFAULT_PERMISSIONS.accounts
    expect(p).toMatchObject({ view_b2b_rates: true, create_b2b_rates: true, edit_b2b_rates: true })
    // Unchanged from the Accounts role.
    expect(p).toMatchObject({ view_net_rates: true, manage_bookings: true, manage_payments: true, approve_refunds: true, view_reports: true, export_data: true })
    expect(p).toMatchObject({ manage_staff: false, manage_settings: false, approve_vouchers: false, approve_cancellations: false, manage_properties: false, manage_rates: false, view_property_contacts: false })
    // Manager and Sales staff are unchanged and get no access to the new B2B page by default.
    expect(DEFAULT_PERMISSIONS.manager).toMatchObject({ view_b2b_rates: false, create_b2b_rates: false, edit_b2b_rates: false, view_net_rates: true, manage_rates: true, approve_discounts: true })
    expect(DEFAULT_PERMISSIONS.sales).toMatchObject({ view_b2b_rates: false, create_b2b_rates: false, edit_b2b_rates: false, view_net_rates: false, max_discount_pct: 5 })
    // Saved overrides from before the change keep working; new keys fall back to the defaults.
    expect(resolvePermissions('accounts', { accounts: { manage_payments: false } })).toMatchObject({ manage_payments: false, view_b2b_rates: true })
    expect(resolvePermissions('admin')).toMatchObject({ view_b2b_rates: true, create_b2b_rates: true, edit_b2b_rates: true })
  })

  it('an existing Accounts user still logs in and sees "Data Entry" in staff lists', async () => {
    const f = fixture()
    const seeded = await f.login('accounts@gosanchari.com', 'wrong-password')
    expect(seeded.cookie).toBe('') // seed account untouched; just proving lookups work
    const legacy = await f.staffUser('accounts', 'legacy-accounts@example.test')
    expect(legacy.cookie).not.toBe('')
    expect((await f.req('/admin/b2b-rates', { cookie: legacy.cookie })).status).toBe(200)
    const admin = await f.staffUser('admin', 'boss@example.test')
    const list = await (await f.req('/admin/staff', { cookie: admin.cookie })).text()
    expect(list).toContain('Data Entry')
    expect(list).not.toMatch(/>Accounts</)
    expect(f.db.prepare('SELECT role FROM users WHERE id=?').get(legacy.id)).toEqual({ role: 'accounts' })
  })
})

describe('Individual Data Entry logins', () => {
  it('admin creates, resets, deactivates and reactivates individual accounts; every change is audited to that admin', async () => {
    const f = fixture()
    const admin = await f.staffUser('admin', 'boss@example.test')
    // Create two separate Data Entry employees.
    for (const [name, email] of [['Rahul Entry', 'rahul@example.test'], ['Meera Entry', 'meera@example.test']]) {
      const r = await f.req('/admin/staff', { method: 'POST', cookie: admin.cookie, body: { name, email, phone: '', role: 'accounts', password: 'Start-pass-1' } })
      expect(f.msg(r)).toContain('Staff member added.')
    }
    const rahul = f.db.prepare("SELECT * FROM users WHERE email='rahul@example.test'").get() as any
    expect(rahul.role).toBe('accounts')
    expect(rahul.password_hash).toMatch(/^pbkdf2\$/)
    expect(rahul.password_hash).not.toContain('Start-pass-1')
    // A second account can't take over the first one's login.
    expect(f.msg(await f.req('/admin/staff', { method: 'POST', cookie: admin.cookie, body: { name: 'Dup', email: 'RAHUL@example.test', role: 'accounts', password: 'Another-pass-1' } }))).toContain('already belongs to a staff account')
    expect(f.msg(await f.req('/admin/staff', { method: 'POST', cookie: admin.cookie, body: { name: 'Short', email: 'short@example.test', role: 'accounts', password: 'short' } }))).toContain('8–128 characters')

    // Login, then logout.
    const first = await f.login('rahul@example.test', 'Start-pass-1')
    expect(first.location).toBe('/admin/payments')
    expect((await f.req('/admin/b2b-rates', { cookie: first.cookie })).status).toBe(200)
    await f.req('/logout', { method: 'POST', cookie: first.cookie })
    expect((await f.req('/admin/b2b-rates', { cookie: first.cookie })).status).toBe(302)

    // Password reset by admin: old password stops working and old sessions end.
    const live = await f.login('rahul@example.test', 'Start-pass-1')
    const edit = { name: 'Rahul Entry', phone: '', email: 'rahul@example.test', role: 'accounts', active: '1', password: 'Reset-pass-22' }
    expect(f.msg(await f.req(`/admin/staff/${rahul.id}`, { method: 'POST', cookie: admin.cookie, body: edit }))).toContain('Staff changes saved.')
    expect((await f.req('/admin/b2b-rates', { cookie: live.cookie })).status).toBe(302)
    expect((await f.login('rahul@example.test', 'Start-pass-1')).cookie).toBe('')
    const renewed = await f.login('rahul@example.test', 'Reset-pass-22')
    expect(renewed.cookie).not.toBe('')

    // Deactivate: the open session stops working at once and login is refused. Reactivate restores it.
    const { password: _, ...noPassword } = edit
    expect(f.msg(await f.req(`/admin/staff/${rahul.id}`, { method: 'POST', cookie: admin.cookie, body: { ...noPassword, active: '' } }))).toContain('Staff changes saved.')
    expect((await f.req('/admin/b2b-rates', { cookie: renewed.cookie })).status).toBe(302)
    expect((await f.login('rahul@example.test', 'Reset-pass-22')).cookie).toBe('')
    await f.req(`/admin/staff/${rahul.id}`, { method: 'POST', cookie: admin.cookie, body: noPassword })
    expect((await f.login('rahul@example.test', 'Reset-pass-22')).cookie).not.toBe('')
    // Meera's login is unaffected by any of this.
    expect((await f.login('meera@example.test', 'Start-pass-1')).cookie).not.toBe('')

    const audit = f.db.prepare("SELECT user_id, action, entity_id FROM activity_log WHERE action IN ('staff.added','staff.updated') ORDER BY id").all() as any[]
    expect(audit.length).toBe(5)
    expect(audit.every((a) => a.user_id === admin.id)).toBe(true)
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='login.password' AND user_id=?").get(rahul.id)).toEqual({ n: 4 })
  })

  it('Data Entry cannot manage staff or create an admin, even by posting directly', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    expect((await f.req('/admin/staff', { cookie: entry.cookie })).status).toBe(403)
    const r = await f.req('/admin/staff', { method: 'POST', cookie: entry.cookie, body: { name: 'Sneaky', email: 'sneaky@example.test', role: 'admin', password: 'Sneaky-pass-1' } })
    expect(r.status).toBe(403)
    expect((await f.req('/admin/staff/permissions', { method: 'POST', cookie: entry.cookie, body: { 'accounts.manage_staff': '1' } })).status).toBe(403)
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email='sneaky@example.test'").get()).toEqual({ n: 0 })
  })
})

describe('B2B rates page', () => {
  it('Data Entry views B2B rates and the property details, without public/staff rates, commission or contacts', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    const list = await (await f.req('/admin/b2b-rates', { cookie: entry.cookie })).text()
    expect(list).toContain('Green Valley Resort')
    expect(list).toContain('href="/admin/b2b-rates"') // menu entry
    const page = await (await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: entry.cookie })).text()
    for (const s of ['Pool Villa', 'Garden Room', 'Christmas', 'Wayanad', 'value="6000"']) expect(page).toContain(s)
    for (const s of ['value="9000"', 'value="7500"', '12,000', 'Owner prefers', '18%']) expect(page).not.toContain(s)
  })

  it('creates and edits room and period B2B rates, recording the employee who changed them', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    const r = await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: {
      [`room_${f.r1}_net_rate`]: '6500', // edit
      [`room_${f.r2}_net_rate`]: '3200', // create
      [`room_${f.r2}_net_extra_adult_rate`]: '900', // create
      [`period_${f.s1}_net_rate`]: '8800', // create
    } })
    expect(f.msg(r)).toContain('4 B2B rate(s) saved.')
    expect(f.room(f.r1).net_rate).toBe(6500)
    expect(f.room(f.r2)).toMatchObject({ net_rate: 3200, net_extra_adult_rate: 900, base_rate: 5000 })
    expect(f.room(f.r1)).toMatchObject({ base_rate: 9000, staff_rate: 7500 }) // never touched
    expect(f.season(f.s1)).toMatchObject({ net_rate: 8800, rate: 12000 })
    const contract = await f.req(`/admin/b2b-rates/${f.pid}/contract`, { method: 'POST', cookie: entry.cookie, body: { b2b_valid_from: '2030-04-01', b2b_valid_to: '2031-03-31', b2b_terms: 'Rates per room per night, CP.' } })
    expect(f.msg(contract)).toContain('B2B contract saved.')
    expect(f.prop()).toMatchObject({ b2b_valid_from: '2030-04-01', b2b_valid_to: '2031-03-31', b2b_terms: 'Rates per room per night, CP.' })
    const log = f.db.prepare("SELECT user_id, action, entity, entity_id, details FROM activity_log WHERE action LIKE 'b2b.%' ORDER BY id").all() as any[]
    expect(log.map((l) => [l.user_id, l.action, l.entity, l.entity_id])).toEqual([[entry.id, 'b2b.rates_saved', 'property', String(f.pid)], [entry.id, 'b2b.contract_saved', 'property', String(f.pid)]])
    expect(JSON.parse(log[0].details).changes).toContainEqual({ label: 'Pool Villa · B2B room rate / night', from: 6000, to: 6500 })
    const page = await (await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: entry.cookie })).text()
    expect(page).toContain('accounts user') // who, in Recent B2B changes
  })

  it('rejects invalid amounts and rates of other properties', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r2}_net_rate`]: '-5' } }))).toContain('whole rupee amount')
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r2}_net_rate`]: '12.5' } }))).toContain('whole rupee amount')
    const other = Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('other','Other','resort','Munnar','live')").run().lastInsertRowid)
    const otherRoom = Number(f.db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES(?,'X',1000)").run(other).lastInsertRowid)
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${otherRoom}_net_rate`]: '700' } }))).toContain('No changes.')
    expect(f.room(otherRoom).net_rate).toBeNull()
    expect(f.room(f.r2).net_rate).toBeNull()
  })

  it('enforces view, create and edit separately on the server, as set by the admin', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    // View only.
    f.setPerms({ accounts: { ...DEFAULT_PERMISSIONS.accounts, create_b2b_rates: false, edit_b2b_rates: false } })
    const viewOnly = await (await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: entry.cookie })).text()
    expect(viewOnly).toContain('You can view these rates')
    expect(viewOnly).not.toContain('Save B2B rates')
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r2}_net_rate`]: '3000' } })).status).toBe(403)
    expect((await f.req(`/admin/b2b-rates/${f.pid}/contract`, { method: 'POST', cookie: entry.cookie, body: { b2b_terms: 'x' } })).status).toBe(403)
    // Create only: may fill blanks, may not change existing values.
    f.setPerms({ accounts: { ...DEFAULT_PERMISSIONS.accounts, edit_b2b_rates: false } })
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '1' } })).status).toBe(403)
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '' } })).status).toBe(403) // clearing is an edit
    expect(f.room(f.r1).net_rate).toBe(6000)
    const createOnlyPage = await (await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: entry.cookie })).text()
    expect(createOnlyPage).toMatch(new RegExp(`name="room_${f.r1}_net_rate" value="6000"[^>]*readonly`))
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '6000', [`room_${f.r2}_net_rate`]: '3000' } }))).toContain('1 B2B rate(s) saved.')
    // Edit only: may change existing values, may not fill blanks. A mixed form is rejected as a whole.
    f.setPerms({ accounts: { ...DEFAULT_PERMISSIONS.accounts, create_b2b_rates: false } })
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '6100', [`period_${f.s1}_net_rate`]: '9000' } })).status).toBe(403)
    expect(f.room(f.r1).net_rate).toBe(6000)
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '6100' } }))).toContain('1 B2B rate(s) saved.')
    // No view: page, menu and writes are all denied.
    f.setPerms({ accounts: { ...DEFAULT_PERMISSIONS.accounts, view_b2b_rates: false } })
    expect((await f.req('/admin/b2b-rates', { cookie: entry.cookie })).status).toBe(403)
    expect((await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: entry.cookie })).status).toBe(403)
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '1' } })).status).toBe(403)
    expect(await (await f.req('/staff/profile', { cookie: entry.cookie })).text()).not.toContain('href="/admin/b2b-rates"')
    // The admin always keeps full control.
    const admin = await f.staffUser('admin', 'boss@example.test')
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: admin.cookie, body: { [`room_${f.r1}_net_rate`]: '' } }))).toContain('1 B2B rate(s) saved.')
    expect(f.room(f.r1).net_rate).toBeNull()
  })

  it('denies other roles and anonymous visitors, and rejects cross-site posts', async () => {
    const f = fixture()
    const sales = await f.staffUser('sales', 'sales-x@example.test')
    const manager = await f.staffUser('manager', 'manager-x@example.test')
    for (const who of [sales, manager]) {
      expect((await f.req(`/admin/b2b-rates/${f.pid}`, { cookie: who.cookie })).status).toBe(403)
      expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: who.cookie, body: { [`room_${f.r2}_net_rate`]: '1' } })).status).toBe(403)
    }
    expect((await f.req(`/admin/b2b-rates/${f.pid}`)).status).toBe(302) // to login
    const entry = await f.staffUser('accounts', 'entry@example.test')
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, origin: 'https://evil.test', body: { [`room_${f.r2}_net_rate`]: '1' } })).status).toBe(403)
    expect(f.room(f.r2).net_rate).toBeNull()
  })
})

describe('Admin controls the Data Entry B2B permissions from Staff & roles', () => {
  it('shows the three permissions and saving them changes what Data Entry can do, leaving other roles alone', async () => {
    const f = fixture()
    const admin = await f.staffUser('admin', 'boss@example.test')
    const entry = await f.staffUser('accounts', 'entry@example.test')
    const staffPage = await (await f.req('/admin/staff', { cookie: admin.cookie })).text()
    for (const k of ['view_b2b_rates', 'create_b2b_rates', 'edit_b2b_rates']) expect(staffPage).toContain(`name="accounts.${k}" value="1" checked`)
    // Re-submit the form as shown, with Data Entry's edit permission unticked.
    const body: Record<string, string> = {}
    for (const m of staffPage.matchAll(/<input type="checkbox" name="([^"]+)" value="1" checked=""/g)) body[m[1]] = '1'
    for (const m of staffPage.matchAll(/<input type="number" name="([^"]+)" value="([^"]*)"/g)) body[m[1]] = m[2]
    delete body['accounts.edit_b2b_rates']
    expect(f.msg(await f.req('/admin/staff/permissions', { method: 'POST', cookie: admin.cookie, body }))).toContain('Permissions saved.')
    expect((await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r1}_net_rate`]: '1' } })).status).toBe(403)
    expect(f.msg(await f.req(`/admin/b2b-rates/${f.pid}/rates`, { method: 'POST', cookie: entry.cookie, body: { [`room_${f.r2}_net_rate`]: '2000' } }))).toContain('1 B2B rate(s) saved.')
    const saved = JSON.parse((f.db.prepare("SELECT value FROM settings WHERE key='role_permissions'").get() as any).value)
    expect(saved.manager).toMatchObject({ ...DEFAULT_PERMISSIONS.manager })
    expect(saved.sales).toMatchObject({ ...DEFAULT_PERMISSIONS.sales })
    expect(saved.accounts).toMatchObject({ ...DEFAULT_PERMISSIONS.accounts, edit_b2b_rates: false })
  })
})

describe('Data Entry is kept out of admin-only functions', () => {
  it('cannot open settings, staff, booking or voucher approvals, integrations, properties or the activity log', async () => {
    const f = fixture()
    const entry = await f.staffUser('accounts', 'entry@example.test')
    for (const path of ['/admin/settings', '/admin/staff', '/admin/booking-approvals', '/admin/vouchers', '/admin/integrations', '/admin/properties', '/admin/rates', '/admin/contacts', '/admin/activity', '/admin/reviews']) {
      expect([path, (await f.req(path, { cookie: entry.cookie })).status]).toEqual([path, 403])
    }
    const approve = await f.req('/admin/booking-approvals/1/decision', { method: 'POST', cookie: entry.cookie, body: { decision: 'approved' } })
    expect(approve.status).toBe(403)
  })

  it('Manager and Sales staff keep their existing access', async () => {
    const f = fixture()
    const manager = await f.staffUser('manager', 'manager-y@example.test')
    const sales = await f.staffUser('sales', 'sales-y@example.test')
    expect((await f.req('/admin/rates', { cookie: manager.cookie })).status).toBe(200)
    expect((await f.req('/admin/properties', { cookie: manager.cookie })).status).toBe(200)
    expect((await f.req('/admin/staff', { cookie: manager.cookie })).status).toBe(403)
    expect((await f.req('/staff/quotes', { cookie: sales.cookie })).status).toBe(200)
    expect((await f.req('/admin/rates', { cookie: sales.cookie })).status).toBe(403)
  })
})
