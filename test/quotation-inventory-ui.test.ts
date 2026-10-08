// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'
import { publicRoutes } from '../src/routes/public'

function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const pid=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,meal_plans,addons) VALUES('gst-fixture','GST fixture','resort','Munnar','live','[\"CP\"]','[{\"name\":\"Activity\",\"price\":500,\"net\":4321,\"per\":\"stay\"}]')").run().lastInsertRowid)
  const rid=Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,base_guests,units,extra_adult_rate) VALUES(?,'GST room',3999,3250,1234,6,2,20,1000)").run(pid).lastInsertRowid)
  const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,email,valid_till) VALUES('GST-TEST','gst-token',1,'Guest','919999999999','guest@example.test','2030-12-31')").run().lastInsertRowid)
  const oid=Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan,subtotal,taxes,total) VALUES(?,?,?,'2030-11-01','2030-11-02',2,1,'CP',3999,200,4199)").run(qid,pid,rid).lastInsertRowid)
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const put=vi.fn(async()=>{}),env:any={DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},MEDIA:{put},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Sales',role:'sales',language:'en'});await next()}).route('/',opsRoutes)
  const publicApp=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',publicRoutes)
  const url='http://localhost/staff/quotes/'+qid
  const form=(amount='500',gst=true)=>{const b=new URLSearchParams({opt_id:String(oid),guest_name:'Guest',phone:'919999999999',email:'guest@example.test',valid_till:'2030-12-31',gst_control:'1',[`room_${oid}`]:String(rid),[`in_${oid}`]:'2030-11-01',[`out_${oid}`]:'2030-11-02',[`rooms_${oid}`]:'1',[`adults_${oid}`]:'2',[`children_${oid}`]:'0',[`meal_${oid}`]:'CP',[`discount_${oid}`]:amount,[`extra_${oid}`]:'100',[`kids_${oid}`]:'900',[`addon_${oid}`]:'0'});if(gst)b.set('apply_gst','1');return b}
  const read=()=>db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
  const quote=()=>db.prepare('SELECT * FROM quotations WHERE id=?').get(qid) as any
  const save=(b:URLSearchParams)=>app.request(url,{method:'POST',body:b},env)
  return {db,env,app,publicApp,url,pid,rid,qid,oid,put,form,save,read,quote}
}

describe('quotation inventory and professional customer print',()=>{
 it('renders actual category units and customer-only amenities without mutating stored pricing',async()=>{
 const f=fixture();try{
 f.db.prepare('UPDATE properties SET facilities=? WHERE id=?').run('["pool","Custom property facility"]',f.pid);
 f.db.prepare('UPDATE rooms SET facilities=?,units=4 WHERE id=?').run('["wifi","Custom room amenity"]',f.rid);
 const before=JSON.stringify(f.read());
 const html=await(await f.app.request(f.url,{},f.env)).text();expect(html).toContain('data-units="4"');expect(html).toContain('Total rooms in category: 4 — live availability not verified.');
 const printed=await(await f.app.request(f.url+'/print',{},f.env)).text();expect(printed).toContain('/brand/logo-wide.webp');expect(printed).toContain('Please note this is not a confirmation voucher');expect(printed).toContain('Voucher not issued by this quotation');expect(printed).toContain('reservation@gosanchari.com');expect(printed).toContain('GST-TEST');expect(printed).toContain('Quotation date:');expect(printed).toContain('Property amenities');expect(printed).toContain('Selected-room amenities');expect(printed).toContain('Custom property facility');expect(printed).toContain('Custom room amenity');expect(printed).not.toContain('4321');expect(printed).not.toContain('Staff floor');expect(printed).not.toContain('B2B');expect(JSON.stringify(f.read())).toBe(before);
 }finally{f.db.close()}
 });
});

// @ts-expect-error Local browser state fixture.
import {runInNewContext} from 'node:vm'
const inventoryScript=readFileSync('public/app.js','utf8').split('// Configured category totals only;')[1].split('// Unsaved Staff quotation price preview.')[0];
it('updates valid, exceeded, unknown and switched categories without changing count or saving',()=>{
 const handlers:any={};const room:any={selectedIndex:0,options:['4','','8'].map(v=>({getAttribute:()=>v})),addEventListener:(k:string,fn:any)=>handlers['room'+k]=fn};
 const count:any={value:'3',addEventListener:(k:string,fn:any)=>handlers['count'+k]=fn};const label={textContent:''},warning={textContent:'',hidden:true};
 const nodes:any={'[data-inventory-room]':room,'[data-inventory-count]':count,'[data-inventory-label]':label,'[data-inventory-warning]':warning};
 runInNewContext("// Configured category totals only;"+inventoryScript,{document:{querySelectorAll:()=>[{querySelector:(k:string)=>nodes[k]}]}});
 expect(label.textContent).toContain('category: 4');expect(warning.hidden).toBe(true);count.value='5';handlers.countinput();expect(warning.textContent).toBe('Requested 5 rooms; configured category inventory is 4. Please verify with the property or choose another category.');
 room.selectedIndex=1;handlers.roomchange();expect(label.textContent).toBe('Category inventory not supplied');expect(warning.hidden).toBe(true);
 room.selectedIndex=2;handlers.roomchange();expect(label.textContent).toContain('category: 8');expect(warning.hidden).toBe(true);expect(count.value).toBe('5');
});
