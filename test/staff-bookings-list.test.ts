// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'
import { adminRoutes } from '../src/routes/admin'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const pid = Number(db.prepare(`INSERT INTO properties(slug,name,type,destination,address,status) VALUES('lake-view','Lake View Resort','resort','Munnar','Munnar','live')`).run().lastInsertRowid)
  const rid = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Deluxe',4000,3,5)").run(pid).lastInsertRowid)
  const sales = (db.prepare("SELECT id FROM users WHERE email='priya@gosanchari.com'").get() as any).id
  const other = (db.prepare("SELECT id FROM users WHERE email='arjun@gosanchari.com'").get() as any).id
  const admin = (db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() as any).id
  const book = (code: string, guest: string, checkIn: string, checkOut: string, total: number, paid: number, staff: number, voucher: string | null, status = 'confirmed') => {
    const id = Number(db.prepare(`INSERT INTO bookings(code,property_id,room_id,check_in,check_out,nights,subtotal,total,amount_paid,status,payment_status,source,guest_name,guest_phone,staff_id)
      VALUES(?,?,?,?,?,2,?,?,?,?,'partial','staff',?,'+91 90000 00000',?)`).run(code, pid, rid, checkIn, checkOut, total, total, paid, status, guest, staff).lastInsertRowid)
    if (voucher) db.prepare('INSERT INTO booking_vouchers(code,booking_id,status,requested_by) VALUES(?,?,?,?)').run('V-' + code, id, voucher, staff)
  }
  book('BK-A1', 'Anu Thomas', '2030-03-10', '2030-03-12', 10000, 4000, sales, 'approved')
  book('BK-A2', 'Babu Raj', '2030-04-05', '2030-04-07', 20000, 20000, sales, 'approved')
  book('BK-A3', 'Cyril Pending', '2030-03-15', '2030-03-16', 5000, 1000, sales, 'pending')
  book('BK-B1', 'Devi Other', '2030-03-20', '2030-03-22', 30000, 9000, other, 'approved')
  book('BK-B2', 'Eli Cancelled', '2030-03-21', '2030-03-22', 8000, 2000, other, 'approved', 'cancelled')
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const as = (id: number, role: string) => new Hono<any>().use('*', async (c, next) => { c.set('user', { id, name: role, role, language: 'en' }); await next() }).route('/', opsRoutes).route('/', adminRoutes)
  const get = async (app: Hono<any>, path: string) => { const r = await app.request('http://localhost' + path, {}, env); return { status: r.status, text: await r.text() } }
  return { db, get, sales: as(sales, 'sales'), admin: as(admin, 'admin'), other }
}

describe('My bookings / All bookings', () => {
  it('staff see only their own voucher-approved bookings with the requested details and totals', async () => {
    const f = fixture()
    const { status, text } = await f.get(f.sales, '/staff/bookings')
    expect(status).toBe(200)
    expect(text).toContain('My bookings')
    for (const s of ['Anu Thomas', 'Babu Raj', 'Lake View Resort', '+91 90000 00000', 'Check-in', 'Check-out']) expect(text).toContain(s)
    expect(text).not.toContain('Cyril Pending') // voucher not approved yet
    expect(text).not.toContain('Devi Other') // another staff member's booking
    expect(text).toContain('₹30,000') // total value 10,000 + 20,000
    expect(text).toContain('₹24,000') // amount paid 4,000 + 20,000
    // A staff member cannot widen the list with the admin-only staff filter.
    expect((await f.get(f.sales, `/staff/bookings?staff=${f.other}`)).text).not.toContain('Devi Other')
  })

  it('filters by check-in month or date range', async () => {
    const f = fixture()
    const march = (await f.get(f.sales, '/staff/bookings?month=2030-03')).text
    expect(march).toContain('Anu Thomas'); expect(march).not.toContain('Babu Raj')
    const april = (await f.get(f.sales, '/staff/bookings?from=2030-04-01&to=2030-04-30')).text
    expect(april).toContain('Babu Raj'); expect(april).not.toContain('Anu Thomas')
  })

  it('admin sees every staff member’s confirmed bookings, filters by staff and month, and exports the same rows', async () => {
    const f = fixture()
    const all = (await f.get(f.admin, '/admin/bookings?month=2030-03')).text
    expect(all).toContain('Anu Thomas'); expect(all).toContain('Devi Other')
    expect(all).not.toContain('Babu Raj'); expect(all).not.toContain('Eli Cancelled'); expect(all).not.toContain('Cyril Pending')
    expect(all).toContain('₹40,000') // 10,000 + 30,000
    const byStaff = (await f.get(f.admin, `/admin/bookings?staff=${f.other}`)).text
    expect(byStaff).toContain('Devi Other'); expect(byStaff).not.toContain('Anu Thomas')
    const csv = await f.get(f.admin, '/admin/bookings/export?tab=confirmed&month=2030-03')
    expect(csv.status).toBe(200)
    expect(csv.text).toContain('BK-A1'); expect(csv.text).toContain('BK-B1'); expect(csv.text).not.toContain('BK-A2')
  })
})
