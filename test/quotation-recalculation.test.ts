// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'
import { publicRoutes } from '../src/routes/public'
// @ts-expect-error Node browser-handler regression fixture.
import { runInNewContext } from 'node:vm'

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
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:userId,name:'Sales',role,language:'en'});await next()}).route('/',opsRoutes)
  const publicApp=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',publicRoutes)
  const url='http://localhost/staff/quotes/'+qid
  const form=(amount='500',gst=true)=>{const b=new URLSearchParams({opt_id:String(oid),guest_name:'Guest',phone:'919999999999',email:'guest@example.test',valid_till:'2030-12-31',gst_control:'1',[`room_${oid}`]:String(rid),[`in_${oid}`]:'2030-11-01',[`out_${oid}`]:'2030-11-02',[`rooms_${oid}`]:'1',[`adults_${oid}`]:'2',[`children_${oid}`]:'0',[`meal_${oid}`]:'CP',[`discount_${oid}`]:amount,[`extra_${oid}`]:'100',[`kids_${oid}`]:'900',[`addon_${oid}`]:'0'});if(gst)b.set('apply_gst','1');return b}
  const read=()=>db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
  const quote=()=>db.prepare('SELECT * FROM quotations WHERE id=?').get(qid) as any
  const save=(b:URLSearchParams)=>app.request(url,{method:'POST',body:b},env)
  return {db,env,app,publicApp,url,pid,rid,qid,oid,put,form,save,read,quote}
}


describe('unsaved quotation recalculation', () => {
  it.each([true, false])('preview exactly equals Save, GST %s, without any preview writes', async gst => {
    const f = fixture(); try {
      const b = f.form('500', gst);
      b.set(`kids_${f.oid}`, '400'); b.set(`addonqty_${f.oid}_0`, '3');
      b.set(`rooms_${f.oid}`, '2'); b.set(`adults_${f.oid}`, '5'); b.set(`children_${f.oid}`, '1');
      b.set(`in_${f.oid}`, '2030-11-02'); b.set(`out_${f.oid}`, '2030-11-05');
      b.set(`grate_${f.oid}`, '4500');
      const before = f.db.prepare('SELECT total_changes() AS n').get() as any;
      const response = await f.app.request(f.url+'/recalculate', {method:'POST',body:b}, f.env);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
      const preview = (await response.json() as any).options[0];
      expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expect(JSON.stringify(preview)).not.toContain('1234');
      expect(preview.errors).toEqual([]);
      expect((await f.save(b)).headers.get('location')).not.toContain('err=');
      const saved = f.read();
      for (const [key,column] of [['subtotal','subtotal'],['discount','discount'],['extraCharges','extra_charges'],['taxes','taxes'],['total','total']]) expect(preview[key]).toBe(saved[column]);
      expect(preview.rows.find((r:any)=>r[0]==='Kids Amount')[1]).toContain('400');
    } finally { f.db.close(); }
  });
  it.each([
    ['kids', '0'], ['kids', '400'], ['rooms', '3'], ['adults', '3'], ['children', '2'],
    ['grate', '5000'], ['discount', '0'], ['extra', '950'], ['addonqty', '4'],
  ])('preview and Save agree after changing %s to %s', async (field, value) => {
    const f=fixture();try {
      const b=f.form('0'); b.set(field==='addonqty'?`addonqty_${f.oid}_0`:`${field}_${f.oid}`,value);
      const preview=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];
      expect(preview.errors).toEqual([]); expect((await f.save(b)).headers.get('location')).not.toContain('err=');
      const saved=f.read(); expect([preview.subtotal,preview.discount,preview.extraCharges,preview.taxes,preview.total]).toEqual([saved.subtotal,saved.discount,saved.extra_charges,saved.taxes,saved.total]);
      if(field==='children')expect(preview.extraCharges).toBe(1500); // No charge from child count alone.
    }finally{f.db.close()}
  });
  it('clears deselected add-ons and rejects malformed discounts without persisting',async()=>{
    const f=fixture();try {
      const b=f.form('0');b.delete(`addon_${f.oid}`);const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];
      expect(p.extraCharges).toBe(1000);await f.save(b);expect(p.total).toBe(f.read().total);
      b.set(`discount_${f.oid}`,'1.5');const before=JSON.stringify(f.read());
      const bad=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];expect(bad.errors.join(' ')).toContain('whole-rupee');
      expect((await f.save(b)).headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before);
    }finally{f.db.close()}
  });
  it('resolves changed room/meal plan/season/weekend/peak identically to Save', async () => {
    const f=fixture(); try {
      const r=Number(f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,capacity,units) VALUES(?,'Second',6000,3000,4,10)").run(f.pid).lastInsertRowid);
      const b=f.form('100'); b.set(`room_${f.oid}`,String(r)); b.set(`meal_${f.oid}`,'MAP');
      b.set(`out_${f.oid}`,'2030-11-04');
      // Use actual existing season schema rather than a separate pricing fixture.
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,kind,start_date,end_date,rate,weekend_rate,staff_rate,staff_weekend_rate,meal_plan) VALUES(?,?,'Season','season','2030-11-01','2030-11-04',7000,8000,3500,4000,'MAP')").run(f.pid,r);
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,kind,start_date,end_date,supplement) VALUES(?,NULL,'Peak','special','2030-11-02','2030-11-02',1000)").run(f.pid);
      const p=(await (await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];
      expect(p.errors).toEqual([]); await f.save(b); expect(p.total).toBe(f.read().total); expect(f.read().room_id).toBe(r);
    } finally { f.db.close(); }
  });
  it('reports pricing validation errors without saving and Save still rejects them', async () => {
    const f=fixture();try {
      const b=f.form('800'); const before=JSON.stringify(f.read());
      const p=(await (await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options[0];
      expect(p.errors.join(' ')).toContain('Staff Rate'); expect(JSON.stringify(f.read())).toBe(before);
      expect((await f.save(b)).headers.get('location')).toContain('err='); expect(JSON.stringify(f.read())).toBe(before);
    }finally{f.db.close();}
  });
  it('enforces authentication, read-only status and internal-rate permissions', async()=>{
    const f=fixture();try {
      const anonymous=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',opsRoutes);
      expect((await anonymous.request(f.url+'/recalculate',{method:'POST',body:f.form()},f.env)).status).not.toBe(200);
      const staff=await (await f.app.request(f.url+'/recalculate',{method:'POST',body:f.form()},f.env)).text();expect(staff).not.toContain('B2B');expect(staff).not.toContain('1,234');
      f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid);
      expect((await f.app.request(f.url+'/recalculate',{method:'POST',body:f.form()},f.env)).status).toBe(409);
    }finally{f.db.close()}
    const management=fixture('admin');try{const result=await(await management.app.request(management.url+'/recalculate',{method:'POST',body:management.form()},management.env)).text();expect(result).toContain('B2B');expect(result).toContain('1,234')}finally{management.db.close()}
  });
  it('keeps multiple option inputs separate and previews each without persisting',async()=>{
    const f=fixture();try {
      const second=Number(f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan,subtotal,taxes,total) VALUES(?,?,?,'2030-11-01','2030-11-02',2,1,'CP',3999,200,4199)").run(f.qid,f.pid,f.rid).lastInsertRowid);
      const b=f.form('0');b.append('opt_id',String(second));b.set(`kids_${f.oid}`,'400');b.set(`kids_${second}`,'900');
      const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:b},f.env)).json() as any).options;
      expect(p.map((x:any)=>x.id)).toEqual([f.oid,second]);expect(p[0].extraCharges).toBe(1000);expect(p[1].extraCharges).toBe(900);
      await f.save(b);expect(p[0].total).toBe(f.read().total);expect(p[1].total).toBe((f.db.prepare('SELECT total FROM quotation_options WHERE id=?').get(second) as any).total);
    }finally{f.db.close()}
  });
  it('blocks restricted quotation access and forged option IDs',async()=>{
    const f=fixture('sales',2);try{expect((await f.app.request(f.url+'/recalculate',{method:'POST',body:f.form()},f.env)).status).toBe(404)}finally{f.db.close()}
    const own=fixture();try{const b=own.form();b.set('opt_id','9999');expect((await own.app.request(own.url+'/recalculate',{method:'POST',body:b},own.env)).status).toBe(404)}finally{own.db.close()}
  });
});

const previewScript = readFileSync('public/app.js','utf8').split('// Unsaved Staff quotation price preview.')[1].split('\n').slice(1).join('\n');
function browserFixture() {
  const handlers: Record<string,(e:any)=>void> = {}, requests: any[] = [];
  let task: (()=>void)|null = null;
  const status={textContent:''}, table={rows:[] as any[],replaceChildren(){this.rows=[]},append(row:any){this.rows.push(row)}};
  const benchmarks={textContent:''}, hint={textContent:''};
  const field={value:'400',parentElement:{querySelector(){return hint}}};
  const section={querySelector(s:string){return s==='[data-price-breakdown]'?table:s==='[data-price-benchmarks]'?benchmarks:status}};
  const form={dataset:{quoteRecalculate:'/staff/quotes/1/recalculate'},elements:{discount_1:field},querySelector(){return section},querySelectorAll(){return [status]},addEventListener(t:string,fn:any){handlers[t]=fn}};
  runInNewContext(previewScript,{document:{querySelector(){return form},createElement(){return {textContent:'',children:[] as any[],append(x:any){this.children.push(x)}}}},Intl,AbortController,FormData:class {},setTimeout(fn:any){task=fn;return 1},clearTimeout(){task=null},fetch(url:any,init:any){return new Promise(resolve=>requests.push({resolve,url,init}))}});
  const change=(name:string,type='number',event='input')=>handlers[event]({type:event,target:{name,type,tagName:type==='select'?'SELECT':'INPUT'}});
  const flush=()=>{const f=task;task=null;f?.()};
  const finish=(index:number,total:string,ok=true)=>requests[index].resolve({ok,json:async()=>ok?{options:[{id:1,rows:[['Total',total]],errors:[],benchmarks:['Staff rate: ₹3,250'],maximumDiscount:500}]}:{error:'Preview unavailable'}});
  return {change,flush,finish,requests,status,table,field,benchmarks};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
describe('automatic browser preview',()=>{
  it('debounces edits and invalidates an older response even before the newer request starts',async()=>{
    const f=browserFixture();f.change('kids_1');expect(f.requests).toHaveLength(0);f.flush();expect(f.status.textContent).toBe('Updating price…');
    f.change('kids_1');expect(f.requests[0].init.signal.aborted).toBe(true);
    f.finish(0,'old');await settle();expect(f.table.rows).toHaveLength(0);
    f.flush();f.finish(1,'new');await settle();expect(f.table.rows[0].children[1].textContent).toBe('new');expect(f.field.value).toBe('400');
  });
  it('ignores out-of-order responses and keeps inputs/results on failure',async()=>{
    const f=browserFixture();f.change('room_1','select','change');f.change('apply_gst','checkbox','change');expect(f.requests).toHaveLength(2);
    f.finish(1,'latest');await settle();f.finish(0,'stale');await settle();expect(f.table.rows[0].children[1].textContent).toBe('latest');
    f.change('kids_1');f.flush();f.finish(2,'',false);await settle();expect(f.status.textContent).toBe('Preview unavailable');expect(f.table.rows[0].children[1].textContent).toBe('latest');expect(f.field.value).toBe('400');
  });
  it('watches every price-affecting field but not unrelated guest information',()=>{
    const f=browserFixture();
    for(const name of ['room_1','in_1','out_1','rooms_1','adults_1','children_1','kids_1','meal_1','grate_1','discount_1','extra_1','extralabel_1','addon_1','addonqty_1_0','apply_gst']){f.change(name);f.flush()}
    expect(f.requests).toHaveLength(15);f.change('guest_name');f.flush();expect(f.requests).toHaveLength(15);
  });
});
