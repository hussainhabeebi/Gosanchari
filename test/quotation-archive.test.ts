// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local browser-controller fixture.
import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { expect, it } from 'vitest'
import { quotationArchiveRoutes } from '../src/routes/quotation-archive'
import { opsRoutes } from '../src/routes/staff-ops'
import { adminRoutes } from '../src/routes/admin'
import { publicRoutes } from '../src/routes/public'
import { guestRoutes } from '../src/routes/guest'
import { confirmationRoutes } from '../src/routes/confirmation-requests'
import { archiveBlocker, ARCHIVE_CONFIRMATION } from '../src/lib/quotation-archive'

function fixture() {
 const db=new DatabaseSync(':memory:')
 for(const name of readdirSync('migrations').filter((n:string)=>n.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+name,'utf8'))
 db.exec(readFileSync('seed/seed.sql','utf8'))
 const uid=Number(db.prepare("SELECT id FROM users WHERE role='sales' ORDER BY id LIMIT 1").get().id),aid=Number(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id)
 const pid=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('archive-test','Archive Test Resort','resort','Munnar','live')").run().lastInsertRowid)
 const rid=Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,units) VALUES(?,'Test room',3000,2500,2100,3,10)").run(pid).lastInsertRowid)
 const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,valid_till) VALUES('QT-ARCHIVE','archive-token',?,'Test Guest','919999999999','2030-12-31')").run(uid).lastInsertRowid)
 const oid=Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,subtotal,taxes,total) VALUES(?,?,?,'2030-11-04','2030-11-06',2,1,6000,300,6300)").run(qid,pid,rid).lastInsertRowid)
 const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
 const messages:any[]=[],env:any={DB,SITE_URL:'http://localhost',ENVIRONMENT:'development',KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(m:any){messages.push(m)}},MEDIA:{async put(){throw Error('No media writes allowed')}}}
 const as=(id=uid,role='sales')=>new Hono<any>().use('*',async(c,next)=>{c.set('user',id?{id,name:role,role,language:'en'}:null);await next()}).route('/',opsRoutes).route('/',quotationArchiveRoutes).route('/',adminRoutes).route('/',confirmationRoutes).route('/',guestRoutes).route('/',publicRoutes)
 const quote=()=>db.prepare('SELECT * FROM quotations WHERE id=?').get(qid) as any
 const archiveBody=()=>({reviewed_at:quote().updated_at,archive_revision:String(quote().archive_revision),reason:'Test record no longer needed'})
 const post=(app:Hono<any>,path:string,b:Record<string,string>={})=>app.request('http://localhost'+path,{method:'POST',body:new URLSearchParams(b)},env)
 const url=`/staff/quotes/${qid}`
 const archive=(app=as(),body=archiveBody())=>post(app,url+'/archive',body)
 const events=()=>db.prepare("SELECT * FROM activity_log WHERE entity='quotation' AND entity_id=? AND action IN ('quote.archived','quote.restored') ORDER BY id").all(String(qid)) as any[]
 const snapshot=()=>JSON.stringify(['quotation_options','bookings','payments','refunds','booking_vouchers','quotation_confirmation_requests','quotation_confirmation_audit'].map(t=>db.prepare('SELECT * FROM '+t).all()))
 const booking=(status='confirmed',amount=0)=>Number(db.prepare(`INSERT INTO bookings(code,property_id,room_id,check_in,check_out,nights,adults,rooms_count,subtotal,total,status,amount_paid,guest_name,guest_phone,quotation_id,staff_id) VALUES('BK-ARCHIVE',?,?,'2030-11-04','2030-11-06',2,2,1,6000,6300,?,?,'Test Guest','919999999999',?,?)`).run(pid,rid,status,amount,qid,uid).lastInsertRowid)
 const confirmation=(status='pending',paid=0)=>Number(db.prepare(`INSERT INTO quotation_confirmation_requests(code,quotation_id,option_id,requested_by,submission_key,details,status,payment_verified,availability_verified,decided_by,decided_at) VALUES('VC-ARCHIVE',?,?,?,'archive-test-submission-key',?,?,?, ?,?,?)`).run(qid,oid,uid,JSON.stringify({paid,reported_advance:paid}),status,status==='approved'?1:0,status==='approved'?1:0,status==='approved'?aid:null,status==='approved'?'2026-01-01':null).lastInsertRowid)
 return {db,env,uid,aid,pid,rid,qid,oid,as,quote,url,archiveBody,archive,post,events,snapshot,booking,confirmation,messages}
}

it.each(['draft','sent','viewed','declined','changes_requested','pending_approval','expired','accepted'])('archives eligible %s without deleting records or changing amounts',async status=>{
 const f=fixture();try{
  f.db.prepare('UPDATE quotations SET status=? WHERE id=?').run(status,f.qid)
  f.db.prepare("INSERT INTO activity_log(user_id,action,entity,entity_id,details) VALUES(?,'quote.discount_approved','quotation',?,'{}')").run(f.aid,String(f.qid))
  const before=f.snapshot();const response=await f.archive()
  expect(response.status).toBe(303);expect(response.headers.get('location')).toContain('ok=');expect(f.quote().archived_at).toBeTruthy();expect(f.quote()).toMatchObject({status,archived_by:f.uid,archive_revision:1,archive_reason:'Test record no longer needed'})
  expect(f.snapshot()).toBe(before);expect(f.events()).toHaveLength(1);expect(f.events()[0].user_id).toBe(f.uid);expect(f.events()[0].action).toBe('quote.archived');expect(f.messages).toHaveLength(0)
  const active=await(await f.as().request('http://localhost/staff/quotes',{},f.env)).text();expect(active).not.toContain('QT-ARCHIVE')
  expect(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='quote.discount_approved'").get().n).toBe(1)
 }finally{f.db.close()}
})
it('offers accessible confirmation with Cancel and an optional reason before mutation',async()=>{
 const f=fixture();try{
  const list=await(await f.as().request('http://localhost/staff/quotes',{},f.env)).text()
  for(const label of ['Actions','View / Edit','Download','Share','Delete',ARCHIVE_CONFIRMATION,'Cancel','data-quotation-archive-dialog'])expect(list).toContain(label)
  const confirm=await(await f.as().request('http://localhost'+f.url+'/archive',{},f.env)).text();expect(confirm).toContain(ARCHIVE_CONFIRMATION);expect(confirm).toContain('Reason (optional)');expect(confirm).toContain('Delete quotation');expect(confirm).toContain('Cancel');expect(f.quote().archived_at).toBeNull()
 }finally{f.db.close()}
})
it('only Admin can view archived quotations and restore their original status/customer link',async()=>{
 const f=fixture();try{
  f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid);const before=f.snapshot();await f.archive()
  const archived=await(await f.as(f.aid,'admin').request('http://localhost/admin/quotes?archive=archived',{},f.env)).text();expect(archived).toContain('QT-ARCHIVE');expect(archived).toContain('View archive / Restore')
  const detail=await(await f.as(f.aid,'admin').request(`http://localhost/admin/quotes/${f.qid}/archive`,{},f.env)).text();expect(detail).toContain('Test record no longer needed');expect(detail).toContain('Archive history');expect(detail).toContain('₹6,300')
  expect((await f.as().request(`http://localhost/admin/quotes/${f.qid}/archive`,{},f.env)).status).toBe(404)
  expect((await f.post(f.as(),`/admin/quotes/${f.qid}/restore`,{archive_revision:'1'})).status).toBe(403)
  const restore=await f.post(f.as(f.aid,'admin'),`/admin/quotes/${f.qid}/restore`,{archive_revision:'1'});expect(restore.headers.get('location')).toContain('ok=')
  expect(f.quote()).toMatchObject({archived_at:null,archived_by:null,archive_revision:2,restored_by:f.aid,status:'sent'})
  expect(f.events().map(e=>e.action)).toEqual(['quote.archived','quote.restored']);expect(f.events()[1].user_id).toBe(f.aid);expect(f.snapshot()).toBe(before)
  expect((await f.as(0).request('http://localhost/q/archive-token',{},f.env)).status).toBe(200)
 }finally{f.db.close()}
})
it('enforces ownership and explicit management permissions, including unassigned quotes',async()=>{
 const f=fixture();try{
  const other=Number(f.db.prepare("SELECT id FROM users WHERE role='sales' AND id!=? LIMIT 1").get(f.uid).id)
  expect((await f.archive(f.as(other))).status).toBe(404)
  expect((await f.as(other).request('http://localhost'+f.url+'/archive',{},f.env)).status).toBe(404)
  f.db.prepare('UPDATE quotations SET staff_id=NULL WHERE id=?').run(f.qid);expect((await f.archive()).status).toBe(404)
  expect((await f.archive(f.as(f.aid,'admin'))).headers.get('location')).toContain('ok=')
 }finally{f.db.close()}
})
it.each(['confirmed','pending','checked_in','completed'])('blocks %s bookings for both Staff and Admin',async status=>{
 const f=fixture();try{f.booking(status);const before=f.snapshot();for(const app of [f.as(),f.as(f.aid,'admin')])expect((await f.archive(app)).headers.get('location')).toContain('err=');expect(f.quote().archived_at).toBeNull();expect(f.snapshot()).toBe(before);expect(f.events()).toHaveLength(0)}finally{f.db.close()}
})
it.each(['advance','evidence','payment','refund','paid_booking','pending_request','approved_request','rejected_evidence','approved_voucher','pending_voucher','active_hold'])('blocks financially/operationally protected %s',async kind=>{
 const f=fixture();try{
  if(kind==='advance')f.db.prepare('UPDATE quotation_options SET reported_advance=100 WHERE id=?').run(f.oid)
  if(kind==='evidence')f.db.prepare('UPDATE quotation_options SET advance_details=? WHERE id=?').run('{"reference":"unresolved"}',f.oid)
  if(['payment','refund','paid_booking','approved_voucher','pending_voucher'].includes(kind)){
   const bid=f.booking('cancelled',kind==='paid_booking'?100:0)
   if(kind==='payment')f.db.prepare("INSERT INTO payments(booking_id,amount,status) VALUES(?,100,'refunded')").run(bid)
   if(kind==='refund')f.db.prepare("INSERT INTO refunds(booking_id,amount,reason) VALUES(?,100,'Test')").run(bid)
   if(kind.endsWith('voucher'))f.db.prepare('INSERT INTO booking_vouchers(code,booking_id,status,snapshot,requested_by) VALUES(?,?,?,?,?)').run('BV-ARCHIVE',bid,kind==='approved_voucher'?'approved':'pending','{"paid":100}',f.uid)
  }
  if(kind.endsWith('request'))f.confirmation(kind==='approved_request'?'approved':'pending')
  if(kind==='rejected_evidence')f.confirmation('rejected',100)
  if(kind==='active_hold')f.db.prepare("INSERT INTO blocked_dates(property_id,room_id,date,quotation_id,hold_until) VALUES(?,?,'2030-11-04',?,'2030-11-03')").run(f.pid,f.rid,f.qid)
  const before=f.snapshot();expect(await archiveBlocker(f.env,f.qid)).toBeTruthy()
  for(const app of [f.as(),f.as(f.aid,'admin')])expect((await f.archive(app)).headers.get('location')).toContain('err=')
  expect(f.quote().archived_at).toBeNull();expect(f.snapshot()).toBe(before);expect(f.events()).toHaveLength(0)
 }finally{f.db.close()}
})
it('permits cancelled/rejected history with no money or pending dependency and preserves it',async()=>{
 const f=fixture();try{f.booking('cancelled');f.confirmation('rejected',0);const before=f.snapshot();await f.archive();expect(f.quote().archived_at).toBeTruthy();expect(f.snapshot()).toBe(before)}finally{f.db.close()}
})
it('rejects stale/double archive and restore submissions, and stale requests after a restore cycle',async()=>{
 const f=fixture();try{
  const stale=f.archiveBody();f.db.prepare("UPDATE quotations SET updated_at='2099-01-01' WHERE id=?").run(f.qid)
  expect((await f.archive(f.as(),stale)).headers.get('location')).toContain('err=');expect(f.events()).toHaveLength(0)
  const form=f.archiveBody();await f.archive();expect((await f.archive(f.as(),form)).status).toBe(404)
  expect((await f.post(f.as(f.aid,'admin'),`/admin/quotes/${f.qid}/restore`,{archive_revision:'0'})).headers.get('location')).toContain('err=')
  await f.post(f.as(f.aid,'admin'),`/admin/quotes/${f.qid}/restore`,{archive_revision:'1'})
  expect((await f.archive(f.as(),form)).headers.get('location')).toContain('err=');expect(f.events()).toHaveLength(2)
 }finally{f.db.close()}
})
it('blocks archived private editing/sharing/PDF/confirmation and customer GET/POST links',async()=>{
 const f=fixture();try{
  f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid);await f.archive();const before=f.snapshot(),q=JSON.stringify(f.quote())
  for(const suffix of ['', '/print','/preview','/advance','/confirmation','/options?property='+f.pid])expect((await f.as().request('http://localhost'+f.url+suffix,{},f.env)).status).toBe(404)
  for(const suffix of ['', '/share','/send','/download','/advance','/confirmation','/duplicate','/add','/reopen','/convert','/recalculate','/options/'+f.oid+'/delete'])expect((await f.post(f.as(),f.url+suffix)).status).toBe(404)
  for(const suffix of ['', '/accept','/feedback','/decline']){const r=suffix?await f.post(f.as(0),'/q/archive-token'+suffix,{option:String(f.oid),message:'Test'}):await f.as(0).request('http://localhost/q/archive-token',{},f.env);expect(r.status).toBe(404)}
  expect(f.snapshot()).toBe(before);expect(JSON.stringify(f.quote())).toBe(q);expect(f.messages).toHaveLength(0)
  const staffArchived=await(await f.as().request('http://localhost/staff/quotes?archive=archived',{},f.env)).text();expect(staffArchived).not.toContain('QT-ARCHIVE')
 }finally{f.db.close()}
})
it('retains CSRF and role restrictions',async()=>{
 const f=fixture();try{
  for(const role of ['guest','driver'])expect((await f.archive(f.as(f.uid,role))).status).toBe(403)
  expect((await f.archive(f.as(0))).status).toBe(302)
  const app=new Hono<any>().use('*',csrf()).route('/',quotationArchiveRoutes)
  for(const path of [f.url+'/archive',`/admin/quotes/${f.qid}/restore`])expect((await app.request('http://localhost'+path,{method:'POST',headers:{origin:'https://evil.test'},body:new URLSearchParams(f.archiveBody())},f.env)).status).toBe(403)
  expect(f.quote().archived_at).toBeNull()
 }finally{f.db.close()}
})

it('does not allow clearing a previously reported advance to bypass financial retention',async()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO activity_log(user_id,action,entity,entity_id,details) VALUES(?,'quote.reported_advance','quotation',?,?)").run(f.uid,String(f.qid),JSON.stringify({option:f.oid,from:0,to:1000,verified:false}))
  expect(f.db.prepare('SELECT reported_advance FROM quotation_options WHERE id=?').get(f.oid).reported_advance).toBe(0)
  expect((await f.archive()).headers.get('location')).toContain('err=');expect(f.quote().archived_at).toBeNull()
 }finally{f.db.close()}
})
it.each(['advance','confirmation','booking'])('blocks archive if a concurrent %s wins the database write first',async kind=>{
 const f=fixture();try{
  const original=f.env.DB.prepare.bind(f.env.DB);let raced=false
  f.env.DB.prepare=(sql:string)=>{
   if(!raced&&sql.startsWith('UPDATE quotations SET archived_at=')){
    raced=true
    if(kind==='advance')f.db.prepare('UPDATE quotation_options SET reported_advance=100 WHERE id=?').run(f.oid)
    else if(kind==='confirmation')f.confirmation()
    else f.booking()
   }
   return original(sql)
  }
  const response=await f.archive();expect(response.headers.get('location')).toContain('err=');expect(raced).toBe(true);expect(f.quote().archived_at).toBeNull();expect(f.events()).toHaveLength(0)
 }finally{f.db.close()}
})
it('blocks late confirmations, funds, bookings, holds and option edits if archive wins first',async()=>{
 const f=fixture();try{
  const bid=f.booking('cancelled');await f.archive();expect(f.quote().archived_at).toBeTruthy();const before=f.snapshot()
  expect(()=>f.confirmation()).toThrow(/Archived quotation/)
  expect(()=>f.db.prepare('UPDATE quotation_options SET reported_advance=100 WHERE id=?').run(f.oid)).toThrow(/Archived quotation/)
  expect(()=>f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid)).toThrow(/read-only/)
  expect(()=>f.db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(bid)).toThrow(/Archived quotation/)
  expect(()=>f.db.prepare("INSERT INTO payments(booking_id,amount,status) VALUES(?,100,'paid')").run(bid)).toThrow(/Restore the quotation/)
  expect(()=>f.db.prepare("INSERT INTO refunds(booking_id,amount) VALUES(?,100)").run(bid)).toThrow(/Restore the quotation/)
  expect(()=>f.db.prepare("INSERT INTO booking_vouchers(code,booking_id,status) VALUES('NEW-VOUCHER',?,'pending')").run(bid)).toThrow(/Restore the quotation/)
  expect(()=>f.db.prepare("INSERT INTO blocked_dates(property_id,room_id,date,quotation_id) VALUES(?,?,'2030-11-04',?)").run(f.pid,f.rid,f.qid)).toThrow(/Archived quotation/)
  expect(()=>f.db.prepare('DELETE FROM quotation_options WHERE id=?').run(f.oid)).toThrow(/retained/)
  expect(()=>f.db.prepare('DELETE FROM quotations WHERE id=?').run(f.qid)).toThrow(/retained/)
  expect(f.snapshot()).toBe(before)
 }finally{f.db.close()}
})
it('rolls back archive when its audit cannot be written, and keeps successful audit immutable',async()=>{
 const f=fixture();try{
  f.db.exec("CREATE TRIGGER fail_archive_audit BEFORE INSERT ON activity_log WHEN NEW.action='quote.archived' BEGIN SELECT RAISE(ABORT,'Audit unavailable'); END")
  await f.archive();expect(f.quote().archived_at).toBeNull();expect(f.events()).toHaveLength(0)
  f.db.exec('DROP TRIGGER fail_archive_audit');await f.archive();expect(f.events()).toHaveLength(1)
  expect(()=>f.db.prepare('DELETE FROM activity_log WHERE id=?').run(f.events()[0].id)).toThrow(/retained/)
  expect(()=>f.db.prepare("UPDATE activity_log SET details='{}' WHERE id=?").run(f.events()[0].id)).toThrow(/immutable/)
 }finally{f.db.close()}
})
it('records exactly one archive under simultaneous duplicate submissions',async()=>{
 const f=fixture();try{const b=f.archiveBody();await Promise.all([f.archive(f.as(),b),f.archive(f.as(),b)]);expect(f.quote().archive_revision).toBe(1);expect(f.events()).toHaveLength(1)}finally{f.db.close()}
})
it('refuses restore if legacy or intervening protected dependencies exist',async()=>{
 const f=fixture();try{
  await f.archive()
  // Model inconsistent historical data without removing the transition safeguard.
  f.db.exec('DROP TRIGGER archive_guard_quotation_options_update')
  f.db.prepare('UPDATE quotation_options SET reported_advance=100 WHERE id=?').run(f.oid)
  expect((await f.post(f.as(f.aid,'admin'),`/admin/quotes/${f.qid}/restore`,{archive_revision:'1'})).headers.get('location')).toContain('err=')
  expect(f.quote().archived_at).toBeTruthy();expect(f.events()).toHaveLength(1)
 }finally{f.db.close()}
})
it('adds archive metadata/guards to existing data without backfilling or rewriting it',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON')
  for(const name of readdirSync('migrations').filter((n:string)=>n.endsWith('.sql')&&n<'0022').sort())db.exec(readFileSync('migrations/'+name,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const id=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,status) VALUES('LEGACY-ARCHIVE','legacy-archive',1,'Guest','accepted')").run().lastInsertRowid)
  db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,subtotal,total,reported_advance) SELECT ?,property_id,id,?,?,6000,6300,1000 FROM rooms LIMIT 1').run(id,'2030-11-04','2030-11-06')
  const old=db.prepare('SELECT * FROM quotations').all(),before=JSON.stringify(db.prepare('SELECT * FROM quotation_options').all())
  db.exec(readFileSync('migrations/0022_quotation_archive.sql','utf8'))
  expect(db.prepare('SELECT * FROM quotations').all().map(({archived_at,archived_by,archive_reason,archive_revision,restored_at,restored_by,...q}:any)=>q)).toEqual(old)
  expect(JSON.stringify(db.prepare('SELECT * FROM quotation_options').all())).toBe(before)
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='quote.archived'").get().n).toBe(0)
 }finally{db.close()}
})

it('opens the real confirmation controller, restores focus on cancel and blocks repeat submit clicks',()=>{
 const source=readFileSync('public/app.js','utf8'),script=source.slice(source.indexOf('// Recoverable quotation deletion:'))
 const events:Record<string,Function>={},dialogEvents:Record<string,Function>={};let open=false,focused='',prevented=false
 const submit={disabled:false},cancel={focus(){focused='cancel'},addEventListener(name:string,fn:Function){events['cancel:'+name]=fn}}
 const code={textContent:''},form={action:'',elements:{reviewed_at:{value:''},archive_revision:{value:''}},reset(){submit.disabled=false},querySelector(){return submit},addEventListener(name:string,fn:Function){events['form:'+name]=fn}}
 const link={dataset:{quotationArchiveUrl:'/staff/quotes/42/archive',archiveVersion:'version-1',archiveRevision:'0',archiveCode:'QT-42'},focus(){focused='trigger'},addEventListener(name:string,fn:Function){events['link:'+name]=fn}}
 const dialog={showModal(){open=true},close(){open=false;dialogEvents.close()},getBoundingClientRect(){return {left:10,right:400,top:10,bottom:500}},querySelector(selector:string){return selector.includes('form')?form:selector.includes('code')?code:cancel},addEventListener(name:string,fn:Function){dialogEvents[name]=fn}}
 runInNewContext(script,{document:{querySelector(){return dialog},querySelectorAll(){return [link]}}})
 events['link:click']({button:0,preventDefault(){prevented=true}})
 expect(prevented).toBe(true);expect(open).toBe(true);expect(focused).toBe('cancel');expect(form.action).toBe('/staff/quotes/42/archive');expect(form.elements.archive_revision.value).toBe('0');expect(form.elements.reviewed_at.value).toBe('version-1');expect(code.textContent).toBe('QT-42')
 events['cancel:click']();expect(open).toBe(false);expect(focused).toBe('trigger')
 events['link:click']({button:0,preventDefault(){}});events['form:submit']();expect(submit.disabled).toBe(true)
 dialogEvents.close();events['link:click']({button:0,preventDefault(){}});expect(submit.disabled).toBe(false)
 expect(readFileSync('public/app.css','utf8')).toContain('width:min(480px,calc(100vw - 32px))')
})
it('uses no-store customer responses and escapes archive reasons without exposing restricted rates',async()=>{
 const f=fixture();try{
  const r=await f.archive(f.as(),{...f.archiveBody(),reason:'<script>alert(1)</script>'});expect(r.headers.get('location')).toContain('ok=')
  const customer=await f.as(0).request('http://localhost/q/archive-token',{},f.env);expect(customer.headers.get('cache-control')).toBe('private, no-store')
  const html=await(await f.as(f.aid,'admin').request(`http://localhost/admin/quotes/${f.qid}/archive`,{},f.env)).text();expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>alert(1)</script>');expect(html).not.toContain('₹2,100')
 }finally{f.db.close()}
})
