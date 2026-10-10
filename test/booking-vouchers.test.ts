// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { voucherRoutes } from '../src/routes/vouchers'
import { opsRoutes } from '../src/routes/staff-ops'
import { voucherHtml, type VoucherData } from '../src/lib/vouchers'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const pid = Number(db.prepare(`INSERT INTO properties(slug,name,type,destination,address,status,facilities,contact,checkin_time,checkout_time)
    VALUES('ice-hills','Ice Hills Resort','resort','Munnar','Chinnakanal, Munnar','live','["pool","wifi","parking"]','{"person":"Front office","phone":"+91 94470 11111","phone2":"+91 94470 22222"}','14:00','11:00')`).run().lastInsertRowid)
  const rid = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Standard AC',4000,3,5)").run(pid).lastInsertRowid)
  const sales = db.prepare("SELECT id FROM users WHERE email='priya@gosanchari.com'").get() as any
  const other = db.prepare("SELECT id FROM users WHERE email='arjun@gosanchari.com'").get() as any
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() as any
  const bid = Number(db.prepare(`INSERT INTO bookings(code,property_id,room_id,check_in,check_out,nights,adults,children,rooms_count,meal_plan,subtotal,taxes,total,amount_paid,status,payment_status,source,guest_name,guest_phone,staff_id)
    VALUES('GS-BK-ICE001',?,?,'2030-12-24','2030-12-26',2,2,2,1,'CP',16000,800,16800,0,'confirmed','unpaid','staff','Anu Thomas','+91 98470 55555',?)`).run(pid, rid, sales.id).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st } }
  const sent: any[] = []
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send(m: any) { sent.push(m) } }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const as = (id: number, role: string) => new Hono<any>().use('*', async (c, next) => { c.set('user', { id, name: role, role, language: 'en' }); await next() }).route('/', voucherRoutes).route('/', opsRoutes)
  const pay = (amount: number, ref = 'UTR123') => {
    db.prepare("INSERT INTO payments(booking_id,amount,status,gateway,gateway_payment_id,updated_at) VALUES(?,?,'paid','upi',?,'2030-11-01T10:00:00.000Z')").run(bid, amount, ref)
    db.prepare('UPDATE bookings SET amount_paid = amount_paid + ? WHERE id = ?').run(amount, bid)
  }
  const post = (app: Hono<any>, path: string, body: Record<string, string> = {}) => app.request('http://localhost' + path, { method: 'POST', body: new URLSearchParams(body) }, env)
  const location = async (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/\+/g, ' '))
  return { db, env, sent, pid, bid, sales: as(sales.id, 'sales'), other: as(other.id, 'sales'), admin: as(admin.id, 'admin'), salesId: sales.id, pay, post, location }
}

describe('Booking confirmation voucher', () => {
  it('can only be requested after an advance payment, with the kids’ ages', async () => {
    const f = fixture()
    expect(await f.location(await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9' }))).toContain('advance payment first')
    f.pay(6000)
    expect(await f.location(await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, {}))).toContain('kids’ ages')
    expect(await f.location(await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9', remarks: 'Honeymoon cake on arrival' }))).toContain('sent to admin for approval')
    expect(await f.location(await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9' }))).toContain('already waiting')
    expect(f.db.prepare('SELECT status, kids_ages, staff_remarks, requested_by FROM booking_vouchers').all()).toEqual([{ status: 'pending', kids_ages: '4, 9', staff_remarks: 'Honeymoon cake on arrival', requested_by: f.salesId }])
    expect(f.sent.some((m) => m.type === 'whatsapp' && /waiting for approval/.test(m.text))).toBe(true) // admins are told
  })

  it('admin approves; the requesting staff member receives the “Booking Confirmed” voucher with every detail', async () => {
    const f = fixture()
    f.pay(6000)
    await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9', remarks: 'Honeymoon cake on arrival' })
    const vid = (f.db.prepare('SELECT id FROM booking_vouchers').get() as any).id

    expect((await f.sales.request('http://localhost/admin/vouchers', {}, f.env)).status).toBe(403) // staff cannot approve
    const queue = await (await f.admin.request('http://localhost/admin/vouchers', {}, f.env)).text()
    expect(queue).toContain('GS-BK-ICE001')
    expect(queue).toContain('Honeymoon cake on arrival')

    const preview = await (await f.sales.request(`http://localhost/vouchers/${vid}`, {}, f.env)).text()
    expect(preview).toContain('PREVIEW — waiting for admin approval')
    expect(preview).toContain('Awaiting admin approval')

    const ok = await f.location(await f.post(f.admin, `/admin/vouchers/${vid}/approve`, { admin_remarks: 'Early check-in confirmed by resort' }))
    expect(ok).toContain('approved')
    expect(f.sent.some((m) => m.type === 'whatsapp' && /is approved — Booking Confirmed/.test(m.text))).toBe(true)

    const mine = await (await f.sales.request('http://localhost/staff/vouchers', {}, f.env)).text()
    expect(mine).toContain('Open voucher')
    const html = await (await f.sales.request(`http://localhost/vouchers/${vid}`, {}, f.env)).text()
    expect(html).not.toContain('PREVIEW')
    for (const text of ['<h1>Booking Confirmed</h1>', 'Booking Status: Confirmed', 'Anu Thomas', '+91 98470 55555', 'No. of Adults</th><td>2', 'No. of Kids</th><td>2', 'Kids Age</th><td>4, 9',
      'Ice Hills Resort', '+91 94470 11111 / +91 94470 22222', 'Location</th><td>Chinnakanal, Munnar<', '24 Dec 2030', '26 Dec 2030', 'Standard AC × 1', '<li>Pool</li>', '<li>Wi-Fi</li>',
      'UPI', 'UTR123', 'Total Room Rent</td><td class="r">₹16,800', 'Advance Paid</td><td class="r">₹6,000', 'Balance Amount</td><td class="r">₹10,800',
      'balance amount is to be paid at the resort at the time of check-in', 'Honeymoon cake on arrival', 'Early check-in confirmed by resort', '<strong>Go Sanchari</strong>']) expect(html).toContain(text)
    expect(html.indexOf('Remarks')).toBeLessThan(html.indexOf('class="v-footer"'))
  })

  it('keeps the approved voucher unchanged when the booking changes later', async () => {
    const f = fixture()
    f.pay(6000)
    await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9' })
    const vid = (f.db.prepare('SELECT id FROM booking_vouchers').get() as any).id
    await f.post(f.admin, `/admin/vouchers/${vid}/approve`)
    f.pay(10800, 'UTR999')
    const html = await (await f.sales.request(`http://localhost/vouchers/${vid}`, {}, f.env)).text()
    expect(html).toContain('Balance Amount</td><td class="r">₹10,800')
    expect(html).not.toContain('UTR999')
  })

  it('is private to the requester and approvers, and can be sent back with a reason', async () => {
    const f = fixture()
    f.pay(6000)
    await f.post(f.sales, `/staff/bookings/${f.bid}/voucher`, { kids_ages: '4, 9' })
    const vid = (f.db.prepare('SELECT id FROM booking_vouchers').get() as any).id
    expect((await f.other.request(`http://localhost/vouchers/${vid}`, {}, f.env)).status).toBe(404)
    await f.post(f.admin, `/admin/vouchers/${vid}/reject`, { reason: 'Kids ages do not match the ID copies' })
    expect(f.db.prepare('SELECT status, reject_reason FROM booking_vouchers').get()).toEqual({ status: 'rejected', reject_reason: 'Kids ages do not match the ID copies' })
    const html = await (await f.sales.request(`http://localhost/vouchers/${vid}`, {}, f.env)).text()
    expect(html).toContain('NOT VALID — sent back by admin: Kids ages do not match the ID copies')
    const page = await (await f.sales.request(`http://localhost/staff/bookings/${f.bid}`, {}, f.env)).text()
    expect(page).toContain('sent back: Kids ages do not match the ID copies')
    expect(page).toContain('Send voucher for admin approval') // can fix and resend
    expect(await f.location(await f.post(f.admin, `/admin/vouchers/${vid}/approve`))).toContain('no longer waiting')
  })
})

describe('voucher layout', () => {
  it('says fully paid when nothing is due and leaves out empty remarks', () => {
    const v: VoucherData = { booking_code: 'B1', status: 'Confirmed', guest_name: 'G', guest_phone: '1', adults: 2, children: 0, kids_ages: '', resort_name: 'R', resort_phone: '', location: 'Munnar', map_url: null,
      check_in: '2030-01-01', check_out: '2030-01-02', nights: 1, checkin_time: '14:00', checkout_time: '11:00', rooms: 'Deluxe × 1', meal_plan: 'Room only', amenities: [], payments: [],
      total: 5000, paid: 5000, balance: 0, staff_remarks: '', admin_remarks: '' }
    const html = voucherHtml(v, { code: 'V1', issued: '2030-01-01T00:00:00Z' })
    expect(html).toContain('Fully paid — nothing is due at check-in.')
    expect(html).toContain('Kids Age</th><td>No kids')
    expect(html).toContain('from 2:00 PM')
    expect(html).not.toContain('<h2>Remarks</h2>')
  })
})
