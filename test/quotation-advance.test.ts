// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'
import { confirmationRoutes } from '../src/routes/confirmation-requests'
import { reportedAdvance } from '../src/lib/quotation-payment'
import { publicRoutes } from '../src/routes/public'

function fixture(role = 'sales', userId = 1){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const pid=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,meal_plans,addons) VALUES('gst-fixture','GST fixture','resort','Munnar','live','[\"CP\"]','[{\"name\":\"Activity\",\"price\":500,\"net\":4321,\"per\":\"stay\"}]')").run().lastInsertRowid)
  const rid=Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,base_guests,units,extra_adult_rate) VALUES(?,'GST room',3999,3250,1234,6,2,20,1000)").run(pid).lastInsertRowid)
  const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,email,valid_till) VALUES('GST-TEST','gst-token',1,'Guest','919999999999','guest@example.test','2030-12-31')").run().lastInsertRowid)
  const oid=Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan,subtotal,taxes,total) VALUES(?,?,?,'2030-11-01','2030-11-02',2,1,'CP',3999,200,4199)").run(qid,pid,rid).lastInsertRowid)
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const put=vi.fn(async()=>{}),env:any={DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},MEDIA:{put},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:userId,name:'Sales',role,language:'en'});await next()}).route('/',opsRoutes).route('/',confirmationRoutes)
  const publicApp=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',publicRoutes)
  const url='http://localhost/staff/quotes/'+qid
  const form=(amount='500',gst=true)=>{const b=new URLSearchParams({opt_id:String(oid),guest_name:'Guest',phone:'919999999999',email:'guest@example.test',valid_till:'2030-12-31',gst_control:'1',[`room_${oid}`]:String(rid),[`in_${oid}`]:'2030-11-01',[`out_${oid}`]:'2030-11-02',[`rooms_${oid}`]:'1',[`adults_${oid}`]:'2',[`children_${oid}`]:'0',[`meal_${oid}`]:'CP',[`discount_${oid}`]:amount,[`extra_${oid}`]:'100',[`kids_${oid}`]:'900',[`addon_${oid}`]:'0'});if(gst)b.set('apply_gst','1');return b}
  const read=()=>db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
  const quote=()=>db.prepare('SELECT * FROM quotations WHERE id=?').get(qid) as any
  const save=(b:URLSearchParams)=>app.request(url,{method:'POST',body:b},env)
  return {db,env,app,publicApp,url,pid,rid,qid,oid,put,form,save,read,quote}
}


describe('quotation reported advance',()=>{
 it.each([true,false])('matches preview/save and retains pricing, GST %s',async gst=>{
  const f=fixture();try{
   const b=f.form('0',gst);b.set(`advance_${f.oid}`,'2000');
   const before=f.db.prepare('SELECT total_changes() n').get();
   const payments=f.db.prepare('SELECT * FROM payments').all();
   const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];
   expect(p.advance).toBe(2000);expect(p.balance).toBe(p.total-2000);expect(p.paymentError).toBe('');expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
   await f.save(b);expect(f.read().reported_advance).toBe(2000);expect(f.read().total).toBe(p.total);
   const html=await(await f.app.request(f.url,{},f.env)).text();expect(html).toContain(`name="advance_${f.oid}" value="2000"`);expect(html).toContain('data-payment-balance');
   expect(f.db.prepare('SELECT * FROM payments').all()).toEqual(payments);
   expect((f.db.prepare('SELECT count(*) n FROM quotation_confirmation_requests').get() as any).n).toBe(0);
  }finally{f.db.close()}
 });
 it.each(['-1','999999','1.5','NaN','Infinity'])('rejects invalid advance %s before any save',async value=>{
  const f=fixture();try{const b=f.form('0');b.set(`advance_${f.oid}`,value);const before=JSON.stringify(f.read());
   const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];expect(p.balance).toBeNull();expect(p.paymentError).toContain('Advance Received');
   expect((await f.save(b)).headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before);
  }finally{f.db.close()}
 });
 it('keeps alternative options separate and resets reported funds on duplication',async()=>{
  const f=fixture();try{const second=Number(f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,total) VALUES(?,?,?,'2030-11-01','2030-11-02',4199)").run(f.qid,f.pid,f.rid).lastInsertRowid);
   const b=f.form('0');b.append('opt_id',String(second));b.set(`advance_${f.oid}`,'2000');
   const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options;expect(p.map((o:any)=>o.advance)).toEqual([2000,0]);
   await f.save(b);expect((f.db.prepare('SELECT reported_advance FROM quotation_options WHERE id=?').get(second) as any).reported_advance).toBe(0);
   await f.app.request(f.url+'/duplicate',{method:'POST'},f.env);expect((f.db.prepare('SELECT reported_advance FROM quotation_options WHERE quotation_id!=? LIMIT 1').get(f.qid) as any).reported_advance).toBe(0);
  }finally{f.db.close()}
 });
 it('uses the final payable total and never silently truncates funds after an edit',async()=>{
  const f=fixture();try{let b=f.form('0');b.set(`rooms_${f.oid}`,'3');b.set(`advance_${f.oid}`,'10000');await f.save(b);expect(f.read().reported_advance).toBe(10000);
   b=f.form('0');const before=JSON.stringify(f.read());expect((await f.save(b)).headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before);
   b.set(`advance_${f.oid}`,'0');await f.save(b);expect(f.read().reported_advance).toBe(0);
  }finally{f.db.close()}
 });
 it('renders the 61200 / 20000 / 41200 example in PDF source, preview, customer and Admin without verification claims',async()=>{
  const f=fixture('admin');try{f.db.prepare("UPDATE quotation_options SET total=61200,reported_advance=20000 WHERE id=?").run(f.oid);
   for(const path of ['/print','/preview','']){const html=await(await f.app.request(f.url+path,{},f.env)).text();for(const text of ['₹61,200','₹41,200','Balance Payable','Advance Received'])expect(html).toContain(text);expect(html).not.toContain('BOOKING CONFIRMED');}
   f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid);const html=await(await f.publicApp.request('http://localhost/q/gst-token',{},f.env)).text();for(const text of ['₹61,200','₹20,000','₹41,200','reported, not verified','Balance amount to be paid at the hotel at check-in time.'])expect(html).toContain(text);expect(html).not.toContain('B2B');expect(html).not.toContain('Staff floor');
  }finally{f.db.close()}
 });
 it('prefills confirmation, allows audited Admin correction and issues no voucher before explicit verification',async()=>{
  const f=fixture('admin');try{f.db.prepare("UPDATE quotation_options SET subtotal=60000,taxes=1200,total=61200,reported_advance=20000 WHERE id=?").run(f.oid);
   const html=await(await f.app.request(f.url+'/confirmation',{},f.env)).text();expect(html).toContain('name="advance" type="number" value="20000"');
   f.db.prepare('UPDATE quotation_options SET advance_details=? WHERE id=?').run(JSON.stringify({date:'2020-01-01',method:'upi',reference:'UTR-TEST'}),f.oid);
   const b=new URLSearchParams({option_id:String(f.oid),submission_key:'advance-test-submission-key',guest_name:'Guest',guest_phone:'9999999999',resort_name:'Resort',resort_phone:'9999999998',location:'Munnar',kids_ages:'',room_rent:'60000',advance:'20000'});
   await f.app.request(f.url+'/confirmation',{method:'POST',body:b},f.env);const r=f.db.prepare('SELECT * FROM quotation_confirmation_requests').get() as any;expect(r.status).toBe('pending');expect(r.payment_verified).toBe(0);expect(JSON.parse(r.details).balance).toBe(41200);
   const view='http://localhost/staff/confirmation-requests/'+r.id;expect((await f.app.request(view+'/print',{},f.env)).status).toBe(404);
   const edit=new URLSearchParams({revision:'0',advance:'21000',room_rent:'60000',guest_name:'Guest',guest_phone:'9999999999',resort_name:'Resort',resort_phone:'9999999998',location:'Munnar',kids_ages:''});
   await f.app.request('http://localhost/admin/booking-approvals/'+r.id+'/edit',{method:'POST',body:edit},f.env);
   const current=f.db.prepare('SELECT * FROM quotation_confirmation_requests').get() as any;expect(JSON.parse(current.details).paid).toBe(21000);expect(JSON.parse(current.details).reported_advance).toBe(20000);
   const quotePdf=async()=>(await f.app.request(f.url+'/print',{},f.env)).text();let pdf=await quotePdf();expect(pdf).toContain('Please note this is not a confirmation voucher');expect(pdf).not.toContain('BOOKING CONFIRMED');
   const decision='http://localhost/admin/booking-approvals/'+r.id+'/decision';await f.app.request(decision,{method:'POST',body:new URLSearchParams({revision:'1',decision:'approved'})},f.env);expect((await f.app.request(view+'/print',{},f.env)).status).toBe(404);
   await f.app.request(decision,{method:'POST',body:new URLSearchParams({revision:'1',decision:'approved',payment_verified:'1',availability_verified:'1'})},f.env);
   const voucher=await(await f.app.request(view+'/print',{},f.env)).text();for(const text of ['BOOKING CONFIRMED','Advance Received','₹21,000','Balance Payable','₹40,200','verified by Admin'])expect(voucher).toContain(text);
   expect(f.read().reported_advance).toBe(20000);expect(f.read().total).toBe(61200);
   pdf=await quotePdf();for(const text of ['BOOKING CONFIRMED',r.code,'Advance Received: ₹21,000 (verified by Admin)','Balance Payable: ₹40,200','data-file-prefix="Booking-Confirmed"'])expect(pdf).toContain(text);
   for(const text of ['not a confirmation voucher','Voucher not issued by this quotation','reported, not verified','Accept online:'])expect(pdf).not.toContain(text);
  }finally{f.db.close()}
 });
 it('does not allow another staff member to report funds against a restricted quotation',async()=>{
  const f=fixture('sales',2);try{const b=f.form('0');b.set(`advance_${f.oid}`,'2000');expect((await f.save(b)).status).toBe(404);expect(f.read().reported_advance).toBe(0)}finally{f.db.close()}
 });
 it('keeps zero/blank valid and validates at the database boundary',()=>{
  expect(reportedAdvance('',61200)).toBe(0);expect(reportedAdvance('20000',61200)).toBe(20000);
  const f=fixture();try{expect(()=>f.db.prepare('UPDATE quotation_options SET reported_advance=-1 WHERE id=?').run(f.oid)).toThrow();expect(()=>f.db.prepare('UPDATE quotation_options SET reported_advance=999999 WHERE id=?').run(f.oid)).toThrow()}finally{f.db.close()}
 });
});

describe('additive advance migration safety',()=>{
 it('preserves all legacy rows and all pricing fields while adding zero report defaults',()=>{
  const db=new DatabaseSync(':memory:');try{
   const files=readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort();
   for(const name of files.filter((name:string)=>!name.startsWith('0016')))db.exec(readFileSync('migrations/'+name,'utf8'));
   db.exec(readFileSync('seed/seed.sql','utf8'));
   const tables=['quotations','quotation_options','properties','rooms','season_rates','property_photos','bookings','payments','quotation_confirmation_requests','quotation_confirmation_audit'];
   const before=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
   db.exec(readFileSync('migrations/0016_quotation_reported_advance.sql','utf8'));
   tables.forEach((t,i)=>{const after=db.prepare('SELECT * FROM '+t).all();if(t==='quotation_options'){for(const row of after){expect((row as any).reported_advance).toBe(0);delete (row as any).reported_advance}}expect(after).toEqual(before[i])});
   expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }finally{db.close()}
 });
});
