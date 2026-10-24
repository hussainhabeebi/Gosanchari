// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { adminRoutes } from '../src/routes/admin'
import { opsRoutes } from '../src/routes/staff-ops'
import { publicRoutes } from '../src/routes/public'
import { confirmationRoutes } from '../src/routes/confirmation-requests'
import { csrf } from 'hono/csrf'
import { staffRoutes } from '../src/routes/staff'
function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,meal_plans) VALUES('ice-hills','Ice Hills Resort','resort','Munnar','live','[\"CP\"]')").run().lastInsertRowid)
  const room = (name: string, rate: number, staff: number) => Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,units) VALUES(?,?,?,?,?,2,4)').run(pid, name, rate, staff, staff - 500).lastInsertRowid)
  const nonAcId = room('Standard Non-AC', 3000, 2500), acId = room('Standard AC', 4000, 3200)
  const qid = Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,email,valid_till,status) VALUES('GS-QT-4FTY2J','ice-token',1,'Guest','919999999999','guest@example.test','2030-12-31','draft')").run().lastInsertRowid)
  const oid = Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan,subtotal,taxes,total) VALUES(?,?,?,'2030-11-04','2030-11-06',2,1,'CP',6000,300,6300)").run(qid, pid, nonAcId).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(statements:any[]){db.exec('BEGIN');try{const results=[];for(const st of statements)results.push(await st.all());db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}} }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, MEDIA: { put: vi.fn(async () => {}) }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', { id: 1, name: 'Admin', role: 'admin', language: 'en' }); await next() }).route('/', opsRoutes).route('/', adminRoutes)
  const as=(id:number,role:string)=>new Hono<any>().use('*',async(c,next)=>{c.set('user',{id,name:role,role,language:'en'});await next()}).route('/',opsRoutes).route('/',adminRoutes).route('/',confirmationRoutes).route('/',staffRoutes)
  const publicApp = new Hono<any>().use('*', async (c, next) => { c.set('user', null); await next() }).route('/', publicRoutes)
  const url = 'http://localhost/staff/quotes/' + qid
  const form = (extra: [number, number, string?][] = [[acId, 2]]) => {
    const b = new URLSearchParams({ opt_id: String(oid), guest_name: 'Guest', phone: '919999999999', email: 'guest@example.test', valid_till: '2030-12-31', gst_control: '1', apply_gst: '1',
      [`room_${oid}`]: String(nonAcId), [`in_${oid}`]: '2030-11-04', [`out_${oid}`]: '2030-11-06', [`rooms_${oid}`]: '4', [`adults_${oid}`]: '12', [`children_${oid}`]: '0', [`meal_${oid}`]: 'CP', [`discount_${oid}`]: '0' })
    for (const [id, n, rate] of extra) { b.append(`xroom_${oid}`, String(id)); b.append(`xrooms_${oid}`, String(n)); b.append(`xgrate_${oid}`, rate ?? '') }
    return b
  }
  const read = () => db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
  return { db, env, app, publicApp, as, url, pid, nonAcId, acId, qid, oid, form, read }
}

const quote=(f:ReturnType<typeof fixture>)=>f.db.prepare('SELECT * FROM quotations WHERE id=?').get(f.qid) as any
const post=(f:ReturnType<typeof fixture>,app:any,path:string,body:Record<string,string>|URLSearchParams={})=>app.request('http://localhost'+path,{method:'POST',body:body instanceof URLSearchParams?body:new URLSearchParams(body)},f.env)
const financial=(f:ReturnType<typeof fixture>)=>JSON.stringify(['bookings','payments','booking_vouchers'].map(t=>f.db.prepare('SELECT * FROM '+t).all()))
const legacy=(f:ReturnType<typeof fixture>,status:string,action='quote.discount_approved')=>{
 f.db.prepare('UPDATE quotations SET status=? WHERE id=?').run(status,f.qid)
 f.db.prepare("INSERT INTO activity_log(user_id,action,entity,entity_id,details) VALUES(1,?,'quotation',?,?)").run(action,String(f.qid),JSON.stringify({reason:'Historical decision',quotation_version:quote(f).updated_at}))
}
const advanceForm=(f:ReturnType<typeof fixture>,override:Record<string,string>={})=>{
 const o=f.read();return {option_id:String(f.oid),advance:'1000',payment_date:'2020-01-01',payment_method:'upi',payment_reference:'TEST-UTR-123',previous_advance:String(o.reported_advance),previous_details:o.advance_details,previous_total:String(o.total),...override}
}
const request=(f:ReturnType<typeof fixture>,override:Record<string,string>={})=>({option_id:String(f.oid),submission_key:'single-approval-test-12345',guest_name:'Test Guest',guest_phone:'919999999999',resort_name:'Test Resort',resort_phone:'919888888888',location:'Munnar',kids_ages:'',advance:'1000',room_rent:'6000',remarks:'UAT only',...override})
const prepare=(f:ReturnType<typeof fixture>)=>post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f))
const submit=(f:ReturnType<typeof fixture>,override:Record<string,string>={})=>post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/confirmation`,request(f,override))
const requests=(f:ReturnType<typeof fixture>)=>f.db.prepare('SELECT * FROM quotation_confirmation_requests ORDER BY id').all() as any[]

describe('single final booking approval workflow',()=>{
 it('shows direct issue/payment actions and only one Admin approval stage',async()=>{
  const f=fixture();try{
   const html=await(await f.as(1,'sales').request(f.url,{},f.env)).text()
   for(const text of ['Save Draft','Generate / Download Quotation','Share Quotation','Record Advance Payment','Request Booking Confirmation'])expect(html).toContain(text)
   for(const text of ['Send to Approval','Approve quotation only','Reject quotation','Convert to booking'])expect(html).not.toContain(text)
   for(const role of ['sales','admin']){
    const list=await(await f.as(1,role).request('http://localhost/'+(role==='admin'?'admin':'staff')+'/quotes',{},f.env)).text()
    expect(list).toContain('GS-QT-4FTY2J');expect(list).not.toContain('status=pending_approval');expect(list).not.toContain('status=quotation_approved');expect(list).not.toContain('data-quotation-approve')
   }
  }finally{f.db.close()}
 })
 it('generates an unapproved quotation directly and publishes its customer link without messages, payments or booking holds',async()=>{
  const f=fixture();try{
   const before=financial(f),blocked=f.db.prepare('SELECT COUNT(*) n FROM blocked_dates').get().n
   const downloaded=await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/download`,f.form())
   expect(downloaded.headers.get('location')).toBe(`/staff/quotes/${f.qid}/print?download=1`)
   const printed=await(await f.as(1,'sales').request(f.url+'/print?download=1',{},f.env)).text()
   expect(printed).toContain('Please note this is not a confirmation voucher');expect(printed).not.toContain('BOOKING CONFIRMED');expect(printed).not.toContain('QUOTATION APPROVED');expect(printed).toContain('data-auto-download="1"')
   expect((await f.publicApp.request('http://localhost/q/ice-token',{},f.env)).status).toBe(404)
   const shared=await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/share`,f.form())
   expect(shared.headers.get('location')).not.toContain('err=');expect(quote(f).status).toBe('sent')
   const customer=await f.publicApp.request('http://localhost/q/ice-token',{},f.env)
   expect(customer.status).toBe(200);const publicHtml=await customer.text();expect(publicHtml).toContain('Standard AC');expect(publicHtml).not.toContain('B2B');expect(publicHtml).not.toContain('Staff Rate');expect(publicHtml).not.toContain('BOOKING CONFIRMED')
   expect(financial(f)).toBe(before);expect(f.db.prepare('SELECT COUNT(*) n FROM blocked_dates').get().n).toBe(blocked);expect(requests(f)).toHaveLength(0)
   expect(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='quote.approval_requested'").get().n).toBe(0)
  }finally{f.db.close()}
 })
 it.each(['draft','pending_approval','changes_requested','sent','viewed','expired','declined'])('keeps legacy %s quotations usable without preliminary review',async status=>{
  const f=fixture();try{
   legacy(f,status,status==='changes_requested'?'quote.review_rejected':'quote.discount_approved')
   const before=JSON.stringify(f.db.prepare('SELECT * FROM activity_log').all()),saved=f.read()
   const html=await(await f.as(1,'sales').request(f.url,{},f.env)).text();expect(html).toContain('Share Quotation');expect(html).toContain('Historical quotation approval history');expect(html).toContain('Historical decision')
   const view=await(await f.as(1,'sales').request(f.url+'/print',{},f.env)).text();expect(view).toContain('Please note this is not a confirmation voucher');expect(view).not.toContain('BOOKING CONFIRMED')
   expect(f.read()).toEqual(saved);expect(JSON.stringify(f.db.prepare('SELECT * FROM activity_log').all())).toBe(before)
   const result=await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/share`,f.form());expect(result.headers.get('location')).not.toContain('err=');expect(quote(f).status).toBe('sent')
   expect(f.db.prepare('SELECT COUNT(*) n FROM activity_log WHERE details LIKE ?').get('%Historical decision%').n).toBe(1)
  }finally{f.db.close()}
 })
 it('retired preliminary endpoints cannot mutate statuses, audit records or money',async()=>{
  const f=fixture();try{
   legacy(f,'pending_approval','quote.approval_requested')
   const before=JSON.stringify(['quotations','quotation_options','activity_log','tasks'].map(t=>f.db.prepare('SELECT * FROM '+t).all()))
   for(const path of [`/staff/quotes/${f.qid}/request-approval`,`/admin/quotes/${f.qid}/approve`,`/admin/quotes/${f.qid}/reject`])await post(f,f.app,path,{reviewed_at:quote(f).updated_at,reason:'Old browser form'})
   expect(JSON.stringify(['quotations','quotation_options','activity_log','tasks'].map(t=>f.db.prepare('SELECT * FROM '+t).all()))).toBe(before)
  }finally{f.db.close()}
 })
 it('keeps missing rates and the Staff discount floor enforced for direct sharing',async()=>{
  const f=fixture();try{
   const before=financial(f),form=f.form();form.set(`discount_${f.oid}`,'999999')
   expect((await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/share`,form)).headers.get('location')).toContain('err=');expect(quote(f).status).toBe('draft')
   f.db.prepare('UPDATE rooms SET base_rate=0,staff_rate=NULL WHERE id=?').run(f.acId)
   expect((await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/share`,f.form())).headers.get('location')).toContain('err=');expect(financial(f)).toBe(before)
  }finally{f.db.close()}
 })
 it('records payment metadata against one selected option, restores it and never creates verified payment records',async()=>{
  const f=fixture();try{
   const second=Number(f.db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,subtotal,total) SELECT quotation_id,property_id,room_id,check_in,check_out,subtotal,total FROM quotation_options WHERE id=?').run(f.oid).lastInsertRowid)
   const before=financial(f);const response=await prepare(f);expect(response.headers.get('location')).not.toContain('err=')
   expect(f.read().reported_advance).toBe(1000);expect(JSON.parse(f.read().advance_details)).toEqual({date:'2020-01-01',method:'upi',reference:'TEST-UTR-123'})
   expect(f.db.prepare('SELECT reported_advance FROM quotation_options WHERE id=?').get(second).reported_advance).toBe(0)
   const page=await(await f.as(1,'sales').request(f.url+'/advance?option='+f.oid,{},f.env)).text();expect(page).toContain('TEST-UTR-123');expect(page).toContain('₹5,300');expect(page).toContain('Staff-reported funds only');expect(page).not.toContain('name="payment_verified"')
   expect(financial(f)).toBe(before)
  }finally{f.db.close()}
 })
 it.each([{advance:'-1'},{advance:'6301'},{advance:'1.5'},{payment_date:'2099-01-01'},{payment_date:'not-date'},{payment_date:'2026-02-31'},{payment_method:'verified'},{payment_reference:'x'.repeat(101)}])('rejects invalid reported-payment input %j',async invalid=>{
  const f=fixture();try{const before=JSON.stringify(f.read());const response=await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f,Object.fromEntries(Object.entries(invalid).filter((pair):pair is [string,string]=>typeof pair[1]==='string'))));expect(response.headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before)}finally{f.db.close()}
 })
 it('clears reported funds safely and rejects stale edits or access by another staff member',async()=>{
  const f=fixture();try{
   const stale=advanceForm(f);await prepare(f)
   expect((await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,stale)).headers.get('location')).toContain('err=')
   expect((await post(f,f.as(2,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f))).status).toBe(404)
   expect((await f.as(2,'sales').request(f.url+'/advance',{},f.env)).status).toBe(404)
   await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f,{advance:'0'}));expect(f.read().reported_advance).toBe(0);expect(f.read().advance_details).toBe('{}')
  }finally{f.db.close()}
 })
 it('uses the selected accepted option without granting quotation edit or payment verification privileges',async()=>{
  const f=fixture();try{
   f.db.prepare("UPDATE quotations SET status='accepted',accepted_option_id=? WHERE id=?").run(f.oid,f.qid)
   await prepare(f);expect(f.read().reported_advance).toBe(1000)
   const page=await(await f.as(1,'sales').request(f.url+'/confirmation',{},f.env)).text();expect(page).toContain('TEST-UTR-123');expect(page).not.toContain('Approve quotation')
   const before=JSON.stringify(f.read());await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}`,f.form());expect(JSON.stringify(f.read())).toBe(before)
  }finally{f.db.close()}
 })
 it('requires recorded evidence; legacy pending quotation status does not prevent final submission',async()=>{
  const f=fixture();try{
   await submit(f);expect(requests(f)).toHaveLength(0)
   await prepare(f);legacy(f,'pending_approval','quote.approval_requested')
   await submit(f);expect(requests(f)).toHaveLength(1);expect(requests(f)[0].payment_verified).toBe(0)
   const d=JSON.parse(requests(f)[0].details);expect(d.payment_details.reference).toBe('TEST-UTR-123');expect(d.balance).toBe(5300)
   await submit(f);await submit(f,{submission_key:'another-submission-12345'});expect(requests(f)).toHaveLength(1)
  }finally{f.db.close()}
 })
 it('requires one final Admin decision, both verifications, ownership and immutable approved snapshots',async()=>{
  const f=fixture();try{
   const before=financial(f);await prepare(f);await submit(f);const r=requests(f)[0],path=`/admin/booking-approvals/${r.id}/decision`,print=`http://localhost/staff/confirmation-requests/${r.id}/print`
   expect((await f.as(1,'sales').request(print,{},f.env)).status).toBe(404)
   const decision={decision:'approved',revision:'0',payment_verified:'1',availability_verified:'1',remarks:'Verified actual receipt and availability'}
   expect((await post(f,f.as(1,'sales'),path,decision)).status).toBe(403)
   for(const body of [{...decision,payment_verified:'0'},{...decision,availability_verified:'0'}]){await post(f,f.as(1,'admin'),path,body);expect(requests(f)[0].status).toBe('pending')}
   await post(f,f.as(1,'admin'),path,decision);expect(requests(f)[0].status).toBe('approved')
   const pdf=await(await f.as(1,'sales').request(print,{},f.env)).text();expect(pdf).toContain('BOOKING CONFIRMED');expect(pdf).not.toContain('not a confirmation voucher');expect(pdf).not.toContain('Staff Rate');expect(pdf).not.toContain('B2B')
   expect((await f.as(2,'sales').request(print,{},f.env)).status).toBe(404)
   await post(f,f.as(1,'admin'),path,decision);await submit(f,{submission_key:'post-approval-submit-12345'});expect(requests(f)).toHaveLength(1)
   expect(f.db.prepare("SELECT COUNT(*) n FROM quotation_confirmation_audit WHERE status='approved'").get().n).toBe(1)
   expect((await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f))).headers.get('location')).toContain('err=')
   await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}`,f.form());expect(await(await f.as(1,'sales').request(print,{},f.env)).text()).toBe(pdf)
   expect(financial(f)).toBe(before)
  }finally{f.db.close()}
 })
 it('rejects confirmation with a reason and permits a fresh corrected request without altering history',async()=>{
  const f=fixture();try{
   await prepare(f);await submit(f);const r=requests(f)[0]
   await post(f,f.as(1,'admin'),`/admin/booking-approvals/${r.id}/decision`,{decision:'rejected',remarks:'Please correct payment evidence',revision:'0'})
   expect(requests(f)[0].status).toBe('rejected');expect((await f.as(1,'sales').request(`http://localhost/staff/confirmation-requests/${r.id}/print`,{},f.env)).status).toBe(404)
   await submit(f,{submission_key:'corrected-final-request-12345'});expect(requests(f)).toHaveLength(2)
  }finally{f.db.close()}
 })
 it('blocks a stale confirmation after the quotation or reported advance changes',async()=>{
  const f=fixture();try{await prepare(f);await submit(f);f.db.prepare("UPDATE quotations SET updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(f.qid)
   await post(f,f.as(1,'admin'),'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'0'});expect(requests(f)[0].status).toBe('pending')
  }finally{f.db.close()}
 })
 it('does not allow old Convert to booking to bypass final verification',async()=>{
  const f=fixture();try{const before=financial(f);await post(f,f.as(1,'admin'),`/staff/quotes/${f.qid}/convert`);expect(financial(f)).toBe(before)}finally{f.db.close()}
 })
 it('keeps remarks, saved payment amounts and current public PDF formatting',async()=>{
  const f=fixture();try{f.db.prepare("UPDATE quotations SET message='Guest-facing remark',payment_terms='Existing custom terms' WHERE id=?").run(f.qid);const before=JSON.stringify(f.read());const html=await(await f.app.request(f.url+'/print',{},f.env)).text()
   for(const text of ['Remarks','Guest-facing remark','Advance Received','Balance Payable','Payment Terms','Please note this is not a confirmation voucher'])expect(html).toContain(text)
   for(const text of ['Valid till:','Selected-room amenities','QUOTATION APPROVED','BOOKING CONFIRMED','TEST-UTR'])expect(html).not.toContain(text)
   expect(JSON.stringify(f.read())).toBe(before)
  }finally{f.db.close()}
 })
 it('enforces existing authentication and CSRF boundaries',async()=>{
  const f=fixture();try{
   const anonymous=new Hono<any>().route('/',opsRoutes);expect((await anonymous.request(f.url+'/advance',{},f.env)).status).toBe(302)
   const app=new Hono<any>().use('*',csrf()).route('/',opsRoutes).route('/',confirmationRoutes)
   for(const path of [`/staff/quotes/${f.qid}/advance`,`/staff/quotes/${f.qid}/share`,'/admin/booking-approvals/1/decision'])expect((await app.request('http://localhost'+path,{method:'POST',headers:{origin:'https://evil.test'},body:new URLSearchParams({})},f.env)).status).toBe(403)
  }finally{f.db.close()}
 })
})


describe('single approval compatibility and race safeguards',()=>{
 it('adds payment metadata without rewriting existing quotations, amounts or approval history',()=>{
  const db=new DatabaseSync(':memory:');try{
   for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')&&f<'0021').sort())db.exec(readFileSync('migrations/'+file,'utf8'))
   db.exec(readFileSync('seed/seed.sql','utf8'))
   const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,status) VALUES('LEGACY','legacy',1,'Guest','pending_approval')").run().lastInsertRowid)
   db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,subtotal,total,reported_advance) SELECT ?,property_id,id,?, ?,6000,6300,1000 FROM rooms LIMIT 1').run(qid,'2030-11-04','2030-11-06')
   db.prepare("INSERT INTO activity_log(user_id,action,entity,entity_id,details) VALUES(1,'quote.discount_approved','quotation',?,'{}')").run(String(qid))
   const before=JSON.stringify(['quotations','activity_log'].map(t=>db.prepare('SELECT * FROM '+t).all()))
   const options=db.prepare('SELECT * FROM quotation_options').all() as any[]
   db.exec(readFileSync('migrations/0021_quotation_advance_details.sql','utf8'))
   expect(JSON.stringify(['quotations','activity_log'].map(t=>db.prepare('SELECT * FROM '+t).all()))).toBe(before)
   const after=db.prepare('SELECT * FROM quotation_options').all() as any[]
   expect(after.map(({advance_details,...row})=>row)).toEqual(options)
   expect(after.every(row=>row.advance_details==='{}')).toBe(true)
   expect(()=>db.prepare("UPDATE quotation_options SET advance_details='invalid'").run()).toThrow()
  }finally{db.close()}
 })
 it('does not accept Staff verification flags or expose payment references to customers',async()=>{
  const f=fixture();try{
   await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/advance`,advanceForm(f,{payment_verified:'1',availability_verified:'1',status:'approved'}))
   await submit(f,{payment_verified:'1',availability_verified:'1',status:'approved'})
   expect(requests(f)[0]).toMatchObject({status:'pending',payment_verified:0,availability_verified:0})
   expect(JSON.parse(requests(f)[0].details).payment_details).toEqual({date:'2020-01-01',method:'upi',reference:'TEST-UTR-123'})
   f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid)
   for(const html of [await(await f.publicApp.request('http://localhost/q/ice-token',{},f.env)).text(),await(await f.app.request(f.url+'/print',{},f.env)).text()]){
    expect(html).not.toContain('TEST-UTR-123');expect(html).not.toContain('₹2,000');expect(html).not.toContain('B2B');expect(html).not.toContain('BOOKING CONFIRMED')
   }
  }finally{f.db.close()}
 })
 it('requires fresh evidence when the reported amount changes in the quotation form',async()=>{
  const f=fixture();try{
   await prepare(f)
   const form=f.form([]);form.set(`rooms_${f.oid}`,'1');form.set(`adults_${f.oid}`,'2');form.set(`advance_${f.oid}`,'1200')
   await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}`,form)
   expect(f.read().reported_advance).toBe(1200);expect(f.read().advance_details).toBe('{}')
   await submit(f,{advance:'1200'});expect(requests(f)).toHaveLength(0)
  }finally{f.db.close()}
 })
 it('preserves historical confirmation requests lacking new metadata and their Admin-approved vouchers',async()=>{
  const f=fixture();try{
   await prepare(f);await submit(f)
   const d=JSON.parse(requests(f)[0].details);delete d.payment_details;delete d.quotation_version
   f.db.prepare('UPDATE quotation_confirmation_requests SET details=?,edited_by=1,edited_at=?,revision=1 WHERE id=1').run(JSON.stringify(d),'2020-01-01')
   await post(f,f.as(1,'admin'),'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'1'})
   expect(requests(f)[0].status).toBe('approved')
   expect(await(await f.as(1,'sales').request('http://localhost/staff/confirmation-requests/1/print',{},f.env)).text()).toContain('BOOKING CONFIRMED')
  }finally{f.db.close()}
 })
 it('deduplicates pending requests even when submitted by a second authorised reviewer',async()=>{
  const f=fixture();try{await prepare(f);await submit(f)
   await post(f,f.as(2,'admin'),`/staff/quotes/${f.qid}/confirmation`,request(f,{submission_key:'another-reviewer-request-123'}))
   expect(requests(f)).toHaveLength(1);expect(requests(f)[0].requested_by).toBe(1)
  }finally{f.db.close()}
 })
 it('rejects a source change occurring between the Admin check and the winning decision update',async()=>{
  const f=fixture();try{
   await prepare(f);await submit(f)
   const original=f.env.DB.prepare.bind(f.env.DB)
   f.env.DB.prepare=(sql:string)=>{
    if(sql.startsWith('UPDATE quotation_confirmation_requests SET status='))f.db.prepare("UPDATE quotations SET updated_at='2099-01-01' WHERE id=?").run(f.qid)
    return original(sql)
   }
   await post(f,f.as(1,'admin'),'/admin/booking-approvals/1/decision',{decision:'approved',payment_verified:'1',availability_verified:'1',revision:'0'})
   expect(requests(f)[0].status).toBe('pending')
   expect(f.db.prepare("SELECT COUNT(*) n FROM quotation_confirmation_audit WHERE status='approved'").get().n).toBe(0)
  }finally{f.db.close()}
 })
})


it('does not confirm a different alternative after the customer selected an option',async()=>{
 const f=fixture();try{
  await prepare(f)
  const second=Number(f.db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,subtotal,taxes,total,reported_advance,advance_details) SELECT quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,subtotal,taxes,total,reported_advance,advance_details FROM quotation_options WHERE id=?').run(f.oid).lastInsertRowid)
  f.db.prepare("UPDATE quotations SET status='accepted',accepted_option_id=? WHERE id=?").run(second,f.qid)
  await submit(f);expect(requests(f)).toHaveLength(0)
  await submit(f,{option_id:String(second)});expect(requests(f)).toHaveLength(1);expect(requests(f)[0].option_id).toBe(second)
 }finally{f.db.close()}
})
