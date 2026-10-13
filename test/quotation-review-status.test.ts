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

const quote=(f:ReturnType<typeof fixture>)=>f.db.prepare('SELECT * FROM quotations WHERE id=?').get(f.qid) as any;
const title=(html:string)=>html.split('<h1>')[1]?.split('</h1>')[0]??'';
const post=(f:ReturnType<typeof fixture>,app:any,path:string,body:any)=>app.request('http://localhost'+path,{method:'POST',body:new URLSearchParams(body)},f.env);
const submit=(f:ReturnType<typeof fixture>)=>f.as(1,'sales').request(f.url+'/request-approval',{method:'POST',body:f.form()},f.env);
const decide=(f:ReturnType<typeof fixture>,decision='approve',extra:Record<string,string>={})=>post(f,f.app,`/admin/quotes/${f.qid}/${decision}`,{reviewed_at:quote(f).updated_at,...extra});
const counts=(f:ReturnType<typeof fixture>)=>['bookings','payments','booking_vouchers','quotation_confirmation_requests'].map(t=>f.db.prepare('SELECT count(*) n FROM '+t).get());

describe('persisted quotation review status',()=>{
 it('reproduces the legacy Draft transition but consistently displays Quotation Approved for Staff and Admin',async()=>{
  const f=fixture();try{
   const financial=counts(f);await submit(f);
   for(const role of ['sales','admin']){const html=await(await f.as(1,role).request(f.url,{},f.env)).text();expect(title(html)).toContain('Pending Approval')}
   const before=f.read();await decide(f);expect(quote(f).status).toBe('draft'); // legacy lifecycle, separate persisted review status
   const event=f.db.prepare("SELECT * FROM activity_log WHERE action='quote.discount_approved' AND entity_id=?").get(String(f.qid)) as any;
   expect(JSON.parse(event.details)).toMatchObject({status:'approved',quotation_version:quote(f).updated_at});
   const actor=(f.db.prepare('SELECT name FROM users WHERE id=1').get() as any).name;
   for(const role of ['sales','admin']){
    const html=await(await f.as(1,role).request(f.url,{},f.env)).text();expect(title(html)).toContain('Quotation Approved');expect(title(html)).not.toContain('draft');expect(html).toContain('Quotation approval history');expect(html).toContain(actor);expect(html).not.toContain('BOOKING CONFIRMED');
    const list=await(await f.as(1,role).request('http://localhost/'+(role==='admin'?'admin':'staff')+'/quotes?status=all',{},f.env)).text();expect(list).toMatch(/GS-QT-4FTY2J[\s\S]*?Quotation Approved/);
   }
   const approved=await(await f.app.request('http://localhost/admin/quotes?status=quotation_approved',{},f.env)).text();expect(approved).toContain('GS-QT-4FTY2J');
   const drafts=await(await f.app.request('http://localhost/admin/quotes?status=draft',{},f.env)).text();expect(drafts).not.toContain('GS-QT-4FTY2J');
   const {discount_approved_by:old,...oldMoney}=before,{discount_approved_by:now,...newMoney}=f.read();expect(newMoney).toEqual(oldMoney);expect(counts(f)).toEqual(financial);
  }finally{f.db.close()}
 });
 it('preserves approval on Download and stale Save while keeping the saved advance/pricing unchanged',async()=>{
  const f=fixture();try{
   const b=f.form();b.set(`advance_${f.oid}`,'2000');await f.as(1,'sales').request(f.url+'/request-approval',{method:'POST',body:b},f.env);await decide(f);
   const before=JSON.stringify([quote(f),f.read()]);
   const download=await f.as(1,'sales').request(f.url+'/download',{method:'POST',body:b},f.env);expect(download.headers.get('location')).toContain('/print?download=1');
   b.set(`advance_${f.oid}`,'3000');const save=await f.as(1,'sales').request(f.url,{method:'POST',body:b},f.env);expect(decodeURIComponent(save.headers.get('location')??'')).toContain('Quotation');expect(JSON.stringify([quote(f),f.read()])).toBe(before);
   const html=await(await f.as(1,'sales').request(f.url,{},f.env)).text();expect(title(html)).toContain('Quotation Approved');expect(html).toContain('Request Booking Confirmation');expect(html).toContain('Download');expect(html).toContain('Edit (reopen)');
   expect((await f.as(1,'sales').request(f.url+'/recalculate',{method:'POST',body:b},f.env)).status).toBe(409);
  }finally{f.db.close()}
 });
 it('requires explicit reopen before editing and retains the old approval in history',async()=>{
  const f=fixture();try{await submit(f);await decide(f);await f.as(1,'sales').request(f.url+'/reopen',{method:'POST'},f.env);
   const html=await(await f.as(1,'sales').request(f.url,{},f.env)).text();expect(title(html)).toContain('draft');expect(title(html)).not.toContain('Quotation Approved');expect(html).toContain('Quotation Approved');expect(html).toContain('Save to Draft');
   await submit(f);const pending=await(await f.app.request(f.url,{},f.env)).text();expect(title(pending)).toContain('Pending Approval');
  }finally{f.db.close()}
 });
 it('records rejection reason, displays Rejected in detail/list, and supports revision and resubmission',async()=>{
  const f=fixture();try{await submit(f);await decide(f,'reject',{reason:'Please correct the guest contact.'});expect(quote(f).status).toBe('changes_requested');
   for(const role of ['sales','admin']){const html=await(await f.as(1,role).request(f.url,{},f.env)).text();expect(title(html)).toContain('Rejected');expect(html).toContain('Please correct the guest contact.');expect(html).toContain('Send to Approval')}
   const list=await(await f.app.request('http://localhost/admin/quotes?status=quotation_rejected',{},f.env)).text();expect(list).toContain('GS-QT-4FTY2J');
   await submit(f);expect(quote(f).status).toBe('pending_approval');await decide(f);const html=await(await f.app.request(f.url,{},f.env)).text();expect(title(html)).toContain('Quotation Approved');expect(html).toContain('Please correct the guest contact.');expect(html).toContain('Rejected');
  }finally{f.db.close()}
 });
 it('rejects missing reasons, stale revisions, duplicate decisions and unauthorized reviewers without financial mutations',async()=>{
  const f=fixture();try{await submit(f);const before=counts(f);const version=quote(f).updated_at;
   await decide(f,'reject',{reason:'  '});expect(quote(f).status).toBe('pending_approval');
   expect((await post(f,f.as(1,'sales'),`/admin/quotes/${f.qid}/approve`,{reviewed_at:version})).status).toBe(403);
   expect((await post(f,f.as(1,'manager'),`/admin/quotes/${f.qid}/reject`,{reviewed_at:version,reason:'No'})).status).toBe(403);
   await decide(f,'approve',{reviewed_at:'stale'});expect(quote(f).status).toBe('pending_approval');
   await decide(f);await decide(f,'reject',{reviewed_at:version,reason:'Late decision'});await decide(f);
   expect((f.db.prepare("SELECT count(*) n FROM activity_log WHERE action IN ('quote.discount_approved','quote.review_rejected') AND entity_id=?").get(String(f.qid)) as any).n).toBe(1);expect(counts(f)).toEqual(before);
   expect((await f.as(2,'sales').request(f.url,{},f.env)).status).toBe(404);
  }finally{f.db.close()}
 });
 it('restores existing legacy approvals from audit records without rewriting quotations',async()=>{
  const f=fixture();try{
   f.db.prepare("UPDATE quotations SET updated_at='2026-10-13T05:00:00Z' WHERE id=?").run(f.qid);
   f.db.prepare("INSERT INTO activity_log(user_id,action,entity,entity_id,details,created_at) VALUES(1,'quote.discount_approved','quotation',?,'{}','2026-10-13T05:00:01Z')").run(String(f.qid));
   const before=quote(f);const html=await(await f.as(1,'sales').request(f.url,{},f.env)).text();expect(title(html)).toContain('Quotation Approved');expect(quote(f)).toEqual(before);
   f.db.prepare("UPDATE quotations SET updated_at='2026-10-13T05:00:02Z' WHERE id=?").run(f.qid);
   const changed=await(await f.as(1,'sales').request(f.url,{},f.env)).text();expect(title(changed)).toContain('draft');expect(title(changed)).not.toContain('Quotation Approved');
  }finally{f.db.close()}
 });
 it('keeps pending status on Download; explicit Save to Draft withdraws the review',async()=>{
  const f=fixture();try{await submit(f);await f.as(1,'sales').request(f.url+'/download',{method:'POST',body:f.form()},f.env);expect(quote(f).status).toBe('pending_approval');
   await f.as(1,'sales').request(f.url,{method:'POST',body:f.form()},f.env);expect(quote(f).status).toBe('draft');
   const html=await(await f.app.request(f.url,{},f.env)).text();expect(title(html)).toContain('draft');expect(html).toContain('Saved to Draft; review must be submitted again.');
  }finally{f.db.close()}
 });
 it('does not issue a confirmation voucher when only the quotation is approved',async()=>{
  const f=fixture();try{await submit(f);await decide(f);const before=counts(f);
   const html=await(await f.as(1,'sales').request(f.url+'/print',{},f.env)).text();expect(html).toContain('Please note this is not a confirmation voucher');expect(html).not.toContain('<h1>BOOKING CONFIRMED</h1>');expect(counts(f)).toEqual(before);
  }finally{f.db.close()}
 });
 it('enforces CSRF on quotation review decisions',async()=>{
  const f=fixture();try{await submit(f);const secured=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,role:'admin'});await next()}).use('*',csrf()).route('/',adminRoutes);
   const r=await secured.request('http://localhost/admin/quotes/'+f.qid+'/approve',{method:'POST',headers:{Origin:'https://attacker.invalid'},body:new URLSearchParams({reviewed_at:quote(f).updated_at})},f.env);expect(r.status).toBe(403);expect(quote(f).status).toBe('pending_approval');
  }finally{f.db.close()}
 });
});

it('uses the same approved status on quotation links inside the enquiry workspace',async()=>{
 const f=fixture();try{
  await submit(f);await decide(f);
  const enquiry=Number(f.db.prepare("INSERT INTO enquiries(code,guest_name,phone,assigned_to) VALUES('REVIEW-ENQ','Guest','919999999999',1)").run().lastInsertRowid);
  f.db.prepare('UPDATE quotations SET enquiry_id=? WHERE id=?').run(enquiry,f.qid);
  const html=await(await f.as(1,'sales').request('http://localhost/staff/enquiries/'+enquiry,{},f.env)).text();
  expect(html).toMatch(/GS-QT-4FTY2J<\/a> <span class="pill pill-live">Quotation Approved<\/span>/);
 }finally{f.db.close()}
});

describe('quotation PDF versus official confirmation voucher',()=>{
 it('retains the disclaimer in drafts and pending quotations, adds QUOTATION APPROVED only after quotation approval',async()=>{
  const f=fixture();try{
   const print=async()=>await(await f.as(1,'sales').request(f.url+'/print?download=1',{},f.env)).text();
   const draft=await print();expect(draft).toContain('Please note this is not a confirmation voucher');expect(draft).not.toContain('<h2>QUOTATION APPROVED</h2>');
   await submit(f);const pending=await print();expect(pending).not.toContain('<h2>QUOTATION APPROVED</h2>');expect(pending).toContain('Please note this is not a confirmation voucher');
   await decide(f);const approved=await print();expect(approved).toContain('<h2>QUOTATION APPROVED</h2>');expect(approved).toContain('Quotation approval only. Booking confirmation requires separate Admin verification.');
   expect(approved).toContain('Please note this is not a confirmation voucher');expect(approved).toContain('Voucher not issued by this quotation');expect(approved).not.toContain('<h2>BOOKING CONFIRMED</h2>');expect(approved).toContain('data-auto-download="1"');expect(approved).not.toContain('data-file-prefix="Booking-Confirmed"');
   await f.as(1,'sales').request(f.url+'/reopen',{method:'POST'},f.env);expect(await print()).not.toContain('<h2>QUOTATION APPROVED</h2>');
  }finally{f.db.close()}
 });
 it('keeps rejected quotations unconfirmed and preserves the disclaimer',async()=>{
  const f=fixture();try{await submit(f);await decide(f,'reject',{reason:'Review required'});const html=await(await f.as(1,'sales').request(f.url+'/print',{},f.env)).text();expect(html).toContain('Please note this is not a confirmation voucher');expect(html).not.toContain('<h2>QUOTATION APPROVED</h2>');expect(html).not.toContain('<h2>BOOKING CONFIRMED</h2>')}finally{f.db.close()}
 });
 it('exposes the official downloadable voucher to its requester only after separate payment and availability verification',async()=>{
  const f=fixture();try{
   await submit(f);await decide(f);
   const option=f.read(), original=JSON.stringify(option);
   const request={option_id:String(f.oid),submission_key:'pdf-confirmation-flow-request-1',guest_name:'Guest',guest_phone:'9999999999',resort_name:'Ice Hills Resort',resort_phone:'9999999998',location:'Munnar',kids_ages:'',room_rent:String(option.subtotal-option.discount),advance:'10000'};
   await post(f,f.as(1,'sales'),`/staff/quotes/${f.qid}/confirmation`,request);
   const row=f.db.prepare('SELECT * FROM quotation_confirmation_requests WHERE quotation_id=?').get(f.qid) as any;expect(row.status).toBe('pending');
   const voucher='http://localhost/staff/confirmation-requests/'+row.id+'/print';
   expect((await f.as(1,'sales').request(voucher,{},f.env)).status).toBe(404);
   const pending=await(await f.as(1,'sales').request(f.url+'/print',{},f.env)).text();expect(pending).toContain('<h2>QUOTATION APPROVED</h2>');expect(pending).toContain('Please note this is not a confirmation voucher');
   const path='/admin/booking-approvals/'+row.id+'/decision';
   await post(f,f.as(1,'admin'),path,{revision:'0',decision:'approved',payment_verified:'1'});expect((await f.as(1,'sales').request(voucher,{},f.env)).status).toBe(404);
   await post(f,f.as(1,'admin'),path,{revision:'0',decision:'approved',payment_verified:'1',availability_verified:'1'});
   const response=await f.as(1,'sales').request(voucher,{},f.env), html=await response.text();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
   for(const text of ['<h1>BOOKING CONFIRMED</h1>','Booking Status: Confirmed','data-download-quote','data-file-prefix="Booking-Confirmed"','/quotation-download.js','Advance Received','verified by Admin'])expect(html).toContain(text);
   expect(html).not.toContain('Please note this is not a confirmation voucher');expect(html).not.toContain('Voucher not issued by this quotation');expect(html).not.toContain('QUOTATION APPROVED');
   expect((await f.as(2,'sales').request(voucher,{},f.env)).status).toBe(404);
   const staff=await(await f.as(1,'sales').request('http://localhost/staff/confirmation-requests/'+row.id,{},f.env)).text();expect(staff).toContain('Open approved voucher / Download PDF');
   const print=await(await f.as(1,'sales').request(f.url+'/print?download=1',{},f.env)).text();expect(print).toContain('<h2>BOOKING CONFIRMED</h2>');expect(print).not.toContain('Please note this is not a confirmation voucher');expect(print).not.toContain('<h2>QUOTATION APPROVED</h2>');
   expect(JSON.stringify(f.read())).toBe(original);
  }finally{f.db.close()}
 });
});
