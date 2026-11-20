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
  // Approved in Booking Approvals: a quotation confirmation request, with no booking row.
  const request = (code: string, guest: string, checkIn: string, total: number, paid: number, staff: number, status = 'approved', quoteId?: number) => {
    const qid = quoteId ?? Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone) VALUES(?,?,?,?,'+91 91111 11111')").run('Q-' + code, 'tok-' + code, staff, guest).lastInsertRowid)
    const oid = Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,total) VALUES(?,?,?,?,?,?)").run(qid, pid, rid, checkIn, '2030-03-31', total).lastInsertRowid)
    const details = JSON.stringify({ guest_name: guest, guest_phone: '+91 91111 11111', resort_name: 'Lake View Resort', check_in: checkIn, check_out: '2030-03-31', total, paid })
    db.prepare(`INSERT INTO quotation_confirmation_requests(code,quotation_id,option_id,requested_by,submission_key,status,details,payment_verified,availability_verified,decided_by,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(code, qid, oid, staff, 'key-' + code, status, details, status === 'approved' ? 1 : 0, status === 'approved' ? 1 : 0, status === 'approved' ? admin : null, status === 'approved' ? '2030-02-01T00:00:00Z' : null)
    return qid
  }
  request('VC-R1', 'Fathima Request', '2030-03-25', 12000, 5000, sales)
  request('VC-R2', 'Gopal Waiting', '2030-03-26', 7000, 2000, sales, 'pending')
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const as = (id: number, role: string) => new Hono<any>().use('*', async (c, next) => { c.set('user', { id, name: role, role, language: 'en' }); await next() }).route('/', opsRoutes).route('/', adminRoutes)
  const get = async (app: Hono<any>, path: string) => { const r = await app.request('http://localhost' + path, {}, env); return { status: r.status, text: await r.text() } }
  return { db, get, request, sales: as(sales, 'sales'), admin: as(admin, 'admin'), other, otherApp: as(other, 'sales') }
}

describe('My bookings / All bookings', () => {
  it('lists a quotation once when it has both an approved request and a voucher-approved booking', async () => {
    const f = fixture()
    const qid = f.request('VC-DUP', 'Hari Both', '2030-03-27', 9000, 3000, (f.db.prepare("SELECT id FROM users WHERE email='priya@gosanchari.com'").get() as any).id)
    const bid = Number(f.db.prepare("SELECT id FROM bookings WHERE code='BK-A1'").get().id)
    f.db.prepare('UPDATE bookings SET quotation_id = ? WHERE id = ?').run(qid, bid)
    const text = (await f.get(f.admin, '/admin/bookings?month=2030-03')).text
    expect(text).toContain('BK-A1'); expect(text).not.toContain('VC-DUP')
  })

  it('staff see only their own voucher-approved bookings with the requested details and totals', async () => {
    const f = fixture()
    const { status, text } = await f.get(f.sales, '/staff/bookings')
    expect(status).toBe(200)
    expect(text).toContain('My bookings')
    for (const s of ['Anu Thomas', 'Babu Raj', 'Lake View Resort', '+91 90000 00000', 'Check-in', 'Check-out']) expect(text).toContain(s)
    expect(text).not.toContain('Cyril Pending') // voucher not approved yet
    expect(text).not.toContain('Devi Other') // another staff member's booking
    expect(text).toContain('Fathima Request') // approved in Booking Approvals, no booking row
    expect(text).toContain('/staff/confirmation-requests/')
    expect(text).not.toContain('Gopal Waiting') // still waiting for approval
    expect(text).toContain('₹42,000') // total value 10,000 + 20,000 + 12,000
    expect(text).toContain('₹29,000') // amount paid 4,000 + 20,000 + 5,000
    expect((await f.get(f.otherApp, '/staff/bookings')).text).not.toContain('Fathima Request')
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
    expect(all).toContain('Fathima Request')
    expect(all).toContain('₹52,000') // 10,000 + 30,000 + 12,000
    const byStaff = (await f.get(f.admin, `/admin/bookings?staff=${f.other}`)).text
    expect(byStaff).toContain('Devi Other'); expect(byStaff).not.toContain('Anu Thomas')
    const csv = await f.get(f.admin, '/admin/bookings/export?tab=confirmed&month=2030-03')
    expect(csv.status).toBe(200)
    expect(csv.text).toContain('BK-A1'); expect(csv.text).toContain('BK-B1'); expect(csv.text).toContain('VC-R1'); expect(csv.text).not.toContain('BK-A2')
  })
})
