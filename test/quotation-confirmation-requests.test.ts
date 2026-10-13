// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { confirmationRoutes, validateConfirmationAmounts, validateKidsAges } from '../src/routes/confirmation-requests'
import { csrf } from 'hono/csrf'
import { voucherRoutes } from '../src/routes/vouchers'
import { opsRoutes } from '../src/routes/staff-ops'

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
  const as = (id: number, role: string) => new Hono<any>().use('*', async (c, next) => { c.set('user', { id, name: role, role, language: 'en' }); await next() }).route('/', confirmationRoutes).route('/', voucherRoutes).route('/', opsRoutes)
  const pay = (amount: number, ref = 'UTR123') => {
    db.prepare("INSERT INTO payments(booking_id,amount,status,gateway,gateway_payment_id,updated_at) VALUES(?,?,'paid','upi',?,'2030-11-01T10:00:00.000Z')").run(bid, amount, ref)
    db.prepare('UPDATE bookings SET amount_paid = amount_paid + ? WHERE id = ?').run(amount, bid)
  }
  const post = (app: Hono<any>, path: string, body: Record<string, string> = {}) => app.request('http://localhost' + path, { method: 'POST', body: new URLSearchParams(body) }, env)
  const location = async (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/\+/g, ' '))
  const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,valid_till) VALUES('GS-QT-TEST','test-quote',?,'Anu','1234567890','2030-12-31')").run(sales.id).lastInsertRowid)
  const oid=Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,children,rooms_count,subtotal,discount,extra_charges,taxes,total,meal_plan) VALUES(?,?,?,'2030-12-24','2030-12-27',4,2,2,21000,1000,3000,1800,24800,'CP')").run(qid,pid,rid).lastInsertRowid)
  const request=(overrides:Record<string,string>={})=>({option_id:String(oid),submission_key:'test-unique-submission-123',guest_name:'Anu',guest_phone:'1234567890',resort_name:'Ice Hills Resort',resort_phone:'9876543210',location:'Vagamon',kids_ages:'4, 9',advance:'10000',room_rent:'19000',remarks:'Staff guest-facing remark',...overrides})
  const rows=()=>db.prepare('SELECT * FROM quotation_confirmation_requests ORDER BY id').all() as any[]
  return { qid,oid,rid,request,rows, db, env, sent, pid, bid, sales: as(sales.id, 'sales'), other: as(other.id, 'sales'), admin: as(admin.id, 'admin'), salesId: sales.id, pay, post, location }
}


describe('quotation confirmation approval workflow',()=>{
 it('submits without booking/payment/quote mutation; deduplicates and denies pending PDF',async()=>{
  const f=fixture();try{
   const before=JSON.stringify(['quotations','quotation_options','bookings','payments'].map(t=>f.db.prepare('SELECT * FROM '+t).all()))
   const response=await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   expect(response.status).toBe(303);expect(f.rows()).toHaveLength(1)
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request({submission_key:'second-click-submission-123'}))
   expect(f.rows()).toHaveLength(1)
   expect(JSON.stringify(['quotations','quotation_options','bookings','payments'].map(t=>f.db.prepare('SELECT * FROM '+t).all()))).toBe(before)
   expect((await f.sales.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).status).toBe(404)
   const history=await(await f.sales.request('http://localhost/staff/confirmation-requests/1',{},f.env)).text()
   expect(history).toContain('No official confirmed voucher');expect(history).not.toContain('BOOKING CONFIRMED')
  }finally{f.db.close()}
 })
 it('requires Admin and explicit payment/availability verification, then exposes frozen approved PDF',async()=>{
  const f=fixture();try{
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   const path='/admin/booking-approvals/1/decision'
   expect((await f.post(f.sales,path,{decision:'approved'})).status).toBe(403)
   await f.post(f.admin,path,{decision:'approved'});expect(f.rows()[0].status).toBe('pending')
   await f.post(f.admin,path,{decision:'approved',payment_verified:'1',availability_verified:'1',remarks:'Verified with resort'})
   expect(f.rows()[0].status).toBe('approved')
   const url='http://localhost/staff/confirmation-requests/1/print'
   const response=await f.sales.request(url,{},f.env), html=await response.text()
   expect(response.headers.get('cache-control')).toBe('private, no-store')
   for(const text of ['BOOKING CONFIRMED','Booking Status: Confirmed','Total Room Rent','₹19,000','Total Amount','₹24,800','₹14,800','Verified with resort','Balance amount to be paid at the hotel at check-in time.','data-file-prefix="Booking-Confirmed"','format']) {
    if(text!=='format')expect(html).toContain(text)
   }
   expect(html).not.toContain('not a confirmation voucher');expect(html).not.toContain('Staff Rate');expect(html).not.toContain('net_rate')
   f.db.prepare("UPDATE quotations SET guest_name='Changed' WHERE id=?").run(f.qid)
   f.db.prepare('UPDATE quotation_options SET total=1 WHERE id=?').run(f.oid)
   expect(await(await f.sales.request(url,{},f.env)).text()).toBe(html)
   await f.post(f.admin,path,{decision:'rejected',remarks:'Later'});expect(f.rows()[0].status).toBe('approved')
   expect(()=>f.db.prepare("UPDATE quotation_confirmation_requests SET details='{}' WHERE id=1").run()).toThrow(/immutable/i)
   expect(f.db.prepare('SELECT status FROM quotation_confirmation_audit ORDER BY id').all()).toEqual([{status:'pending'},{status:'approved'}])
  }finally{f.db.close()}
 })
 it('rejects with remarks, denies rejected PDF, and allows a new approval request',async()=>{
  const f=fixture();try{
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   await f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'rejected',remarks:'Verify dates'})
   expect(f.rows()[0].status).toBe('rejected')
   expect((await f.sales.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).status).toBe(404)
   expect(await(await f.sales.request('http://localhost/staff/confirmation-requests',{},f.env)).text()).toContain('Verify dates')
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request({submission_key:'revised-submission-123'}));expect(f.rows()).toHaveLength(2)
  }finally{f.db.close()}
 })
 it('denies another staff member, guest, and manager approval; supports multiple categories',async()=>{
  const f=fixture();try{
   const room2=Number(f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Non AC',3000,3,5)").run(f.pid).lastInsertRowid)
   f.db.prepare('UPDATE quotation_options SET extra_rooms=? WHERE id=?').run(JSON.stringify([{room_id:room2,rooms_count:3,guest_rate:777777}]),f.oid)
   expect((await f.other.request(`http://localhost/staff/quotes/${f.qid}/confirmation`,{},f.env)).status).toBe(404)
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   expect((await f.other.request('http://localhost/staff/confirmation-requests/1',{},f.env)).status).toBe(404)
   const manager=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,role:'manager'});await next()}).route('/',confirmationRoutes)
   expect((await f.post(manager,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1'})).status).toBe(403)
   const guest=new Hono<any>().route('/',confirmationRoutes)
   expect((await guest.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).status).toBe(302)
   await f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1'})
   const html=await(await f.sales.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).text()
   expect(html).toContain('Standard AC × 2 + Non AC × 3');expect(html).not.toContain('777777')
   expect((await f.other.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).status).toBe(404)
  }finally{f.db.close()}
 })
 it.each([{advance:'0'},{advance:'-1'},{advance:'25000'},{advance:'NaN'},{room_rent:'21000'},{kids_ages:'4'},{resort_phone:''}])('rejects invalid input %j without writes',async invalid=>{
  const f=fixture();try{await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request(Object.fromEntries(Object.entries(invalid).filter((pair): pair is [string,string] => typeof pair[1] === 'string'))));expect(f.rows()).toHaveLength(0)}finally{f.db.close()}
 })
 it('enforces CSRF on decisions using the application middleware',async()=>{
  const f=fixture();try{const app=new Hono<any>().use('*',csrf()).route('/',confirmationRoutes);expect((await app.request('http://localhost/admin/booking-approvals/1/decision',{method:'POST',headers:{origin:'https://evil.test'},body:new URLSearchParams({decision:'approved'})},f.env)).status).toBe(403)}finally{f.db.close()}
 })
 it('validates full paid balance and exact children ages',()=>{expect(validateConfirmationAmounts(24800,24800,19000,20000)).toBe(0);expect(validateKidsAges(0,'')).toBe('');expect(()=>validateKidsAges(1,'18')).toThrow()})
})

describe('decision race and ownership',()=>{
 it('records only one winning decision and one audit event',async()=>{
  const f=fixture();try{
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   await Promise.all([f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1'}),f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'rejected',remarks:'Not available'})])
   expect(['approved','rejected']).toContain(f.rows()[0].status)
   expect(f.db.prepare('SELECT * FROM quotation_confirmation_audit').all()).toHaveLength(2)
  }finally{f.db.close()}
 })
 it('cannot submit another quotation option or a room from a different property',async()=>{
  const f=fixture();try{
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request({option_id:'999999'}));expect(f.rows()).toHaveLength(0)
   const otherRoom=f.db.prepare('SELECT id FROM rooms WHERE property_id != ? LIMIT 1').get(f.pid) as any
   f.db.prepare('UPDATE quotation_options SET extra_rooms=? WHERE id=?').run(JSON.stringify([{room_id:otherRoom.id,rooms_count:1}]),f.oid)
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request());expect(f.rows()).toHaveLength(0)
  }finally{f.db.close()}
 })
})

describe('Admin editable confirmation review',()=>{
 const edits=(f:ReturnType<typeof fixture>,extra:Record<string,string>={})=>({...f.request(),revision:'0',advance:'12000',guest_name:'Admin corrected guest',...extra})
 it('saves Admin corrections and preserves staff-reported advance with audited snapshots',async()=>{
  const f=fixture();try{
   await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request())
   expect((await f.post(f.sales,'/admin/booking-approvals/1/edit',edits(f))).status).toBe(403)
   await f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f))
   const r=f.rows()[0],d=JSON.parse(r.details);expect(d).toMatchObject({paid:12000,reported_advance:10000,balance:12800,guest_name:'Admin corrected guest',total:24800})
   expect(r.revision).toBe(1);expect(r.edited_by).toBeTruthy();expect(r.edited_at).toBeTruthy()
   const audit=f.db.prepare('SELECT * FROM quotation_confirmation_audit ORDER BY id').all() as any[]
   expect(audit.map(a=>a.status)).toEqual(['pending','edited']);expect(JSON.parse(audit[0].details).paid).toBe(10000);expect(JSON.parse(audit[1].details).paid).toBe(12000)
   await f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'0'})
   expect(f.rows()[0].status).toBe('pending')
   await f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'1'})
   expect(f.rows()[0].status).toBe('approved')
   const html=await(await f.sales.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).text()
   expect(html).toContain('Admin corrected guest');expect(html).toContain('₹12,800');expect(html).toContain('Balance amount to be paid at the hotel at check-in time.')
   await f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f,{advance:'1',revision:'1'}));expect(JSON.parse(f.rows()[0].details).paid).toBe(12000)
  }finally{f.db.close()}
 })
 it.each(['-1','24801','1.5','NaN'])('rejects invalid Admin advance %s without audit or data changes',async amount=>{
  const f=fixture();try{await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request());const before=f.rows()[0].details;await f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f,{advance:amount}));expect(f.rows()[0].details).toBe(before);expect(f.db.prepare('SELECT COUNT(*) AS n FROM quotation_confirmation_audit').get().n).toBe(1)}finally{f.db.close()}
 })
 it('accepts zero in the review but does not confirm without a positive advance',async()=>{
  const f=fixture();try{await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request());await f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f,{advance:'0'}));expect(JSON.parse(f.rows()[0].details).balance).toBe(24800)
   await f.post(f.admin,'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'1'});expect(f.rows()[0].status).toBe('pending')
   expect((await f.sales.request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).status).toBe(404)
  }finally{f.db.close()}
 })
 it('does not lose a concurrent Admin correction',async()=>{
  const f=fixture();try{await f.post(f.sales,`/staff/quotes/${f.qid}/confirmation`,f.request());await Promise.all([f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f)),f.post(f.admin,'/admin/booking-approvals/1/edit',edits(f,{advance:'11000'}))]);expect(f.rows()[0].revision).toBe(1);expect(f.db.prepare('SELECT COUNT(*) AS n FROM quotation_confirmation_audit').get().n).toBe(2)}finally{f.db.close()}
 })
})
