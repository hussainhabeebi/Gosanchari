// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { quotationPrice } from '../src/lib/quotation-pricing'
import { opsRoutes } from '../src/routes/staff-ops'
import { publicRoutes } from '../src/routes/public'
import * as integrations from '../src/lib/integrations'
import { buildQuoteExplainer } from '../src/lib/assist'
import { storeInvoice } from '../src/lib/bookings'

const room={id:1,property_id:1,base_rate:3999,weekend_rate:null,staff_rate:3250,capacity:6,base_guests:2,extra_adult_rate:1000,extra_child_rate:800,min_nights:1,units:20}
const input={room,seasons:[],checkIn:'2030-11-01',checkOut:'2030-11-02',discountAmount:0}
describe('accommodation-only discount floor',()=>{
  it.each([500,749])('allows ₹%s without a role percentage allowance',amount=>{const p=quotationPrice({...input,discountAmount:amount});expect(p.errors).toEqual([]);expect(p.maximumDiscount).toBe(749);expect(p.roomCharges-p.discount).toBe(3999-amount)})
  it('rejects over-floor amounts and manually entered selling prices, even with large extras',()=>{
    for(const discountAmount of [750,800])expect(quotationPrice({...input,discountAmount,adults:4,children:1,extraCharges:10000}).errors).toContain('Discount cannot reduce the selling rate below the Staff Rate of ₹3,250.')
    expect(quotationPrice({...input,room:{...room,base_rate:3200},staffRoom:room}).errors).toContain('Discount cannot reduce the selling rate below the Staff Rate of ₹3,250.')
    const p=quotationPrice({...input,discountAmount:749,adults:3,children:1,extraCharges:1700})
    expect(p.maximumDiscount).toBe(749);expect(p.subtotal).toBe(5799);expect(p.extraCharges).toBe(1700);expect(p.taxable).toBe(6750)
  })
  it('does not guess a missing Staff Rate from rack or net',()=>{
    const r={...room,staff_rate:null,net_rate:1}
    expect(quotationPrice({...input,room:r,discountAmount:1}).errors.join(' ')).toContain('Staff Rate could not be resolved')
    expect(quotationPrice({...input,room:r,discountAmount:0}).errors).toEqual([])
  })
  it('uses exact dated meal-plan staff rates, weekends, multiple rooms and peaks without average-rounding leakage',()=>{
    const season={property_id:1,room_id:1,name:'CP season',source:'wizard',kind:'season',meal_plan:'CP',start_date:'2030-01-01',end_date:'2030-12-31',rate:4000,weekend_rate:4500,staff_rate:3250,staff_weekend_rate:3500,pct_adjust:null,min_nights:null}
    const peak={...season,room_id:null,kind:'special',meal_plan:null,source:'wizard-common:11111111-1111-4111-8111-111111111111',name:'Peak',rate:null,weekend_rate:null,staff_rate:null,staff_weekend_rate:null,supplement:500,start_date:'2030-11-01',end_date:'2030-11-02'}
    const p=quotationPrice({...input,seasons:[season,peak],checkOut:'2030-11-04',roomsCount:2,mealPlan:'CP'})
    expect(p.staffAccommodation).toBe((4000+4000+3250)*2)
    expect(p.roomCharges).toBe((5000+5000+4000)*2);expect(p.maximumDiscount).toBe(5500)
    expect(quotationPrice({...input,seasons:[season,peak],checkOut:'2030-11-04',roomsCount:2,mealPlan:'CP',discountAmount:5500}).errors).toEqual([])
    expect(quotationPrice({...input,seasons:[season,peak],checkOut:'2030-11-04',roomsCount:2,mealPlan:'CP',discountAmount:5501}).errors.length).toBeGreaterThan(0)
    expect(quotationPrice({...input,room:{...room,staff_rate:null},seasons:[{...season,staff_rate:null,staff_weekend_rate:null}],mealPlan:'CP',discountAmount:1}).errors.join(' ')).toContain('Staff Rate could not be resolved')
  })
  it('GST ON uses existing slabs after room discount and extras; OFF changes only GST and total',()=>{
    const on=quotationPrice({...input,discountAmount:749,adults:3,extraCharges:1200})
    const off=quotationPrice({...input,discountAmount:749,adults:3,extraCharges:1200,applyGst:false})
    expect(on.taxable).toBe(5450);expect(on.taxes).toBe(273);expect(on.total).toBe(5723)
    expect(off.taxes).toBe(0);expect(off.total).toBe(5450)
    for(const key of ['roomCharges','subtotal','discount','extraCharges','taxable','taxRate'])expect(off[key as keyof typeof off]).toBe(on[key as keyof typeof on])
  })
})

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

describe('quotation persistence and outputs',()=>{
  it('saves exact fixed amounts, rejects a forged allowance/approval and manual underpricing before writing anything',async()=>{
    const f=fixture();try{
      const unchanged=JSON.stringify(f.read());const b=f.form('800');b.set(`adults_${f.oid}`,'3');b.set(`extra_${f.oid}`,'10000');b.set(`disc_${f.oid}`,'0')
      f.db.prepare('UPDATE quotation_options SET discount_approved_by=1 WHERE id=?').run(f.oid);const before=JSON.stringify(f.read())
      const rejected=await f.save(b);expect(rejected.headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before)
      b.set(`discount_${f.oid}`,'0');b.set(`grate_${f.oid}`,'3200');expect((await f.save(b)).headers.get('location')).toContain('err=');expect(JSON.stringify(f.read())).toBe(before)
      for(const amount of ['500','749']){expect((await f.save(f.form(amount))).headers.get('location')).not.toContain('err=');expect(f.read().discount).toBe(Number(amount))}
      expect(JSON.stringify(f.read())).not.toBe(unchanged);expect(f.read().extra_charges).toBe(1500)
      f.db.prepare('UPDATE rooms SET staff_rate=NULL WHERE id=?').run(f.rid)
      const missing=await f.save(f.form('1'));expect(decodeURIComponent(missing.headers.get('location')!)).toContain('Staff+Rate+could+not+be+resolved')
    }finally{f.db.close()}
  })
  it.each([true,false])('persists GST %s through reopen, duplicate, Preview/PDF/customer output and booking conversion/date changes',async gst=>{
    const f=fixture();try{
      expect(f.quote().apply_gst).toBe(1)
      expect((await f.save(f.form('749',gst))).headers.get('location')).not.toContain('err=')
      const saved=f.read();expect(f.quote().apply_gst).toBe(gst?1:0);expect(saved.discount).toBe(749);expect(saved.extra_charges).toBe(1500)
      expect(saved.taxes).toBe(gst?238:0);expect(saved.total).toBe(gst?4988:4750)
      const edit=await(await f.app.request(f.url,{},f.env)).text();expect(edit).toContain('Discount Amount ₹');expect(edit).not.toContain('Maximum allowed:');expect(edit).not.toContain('1234');expect(edit).not.toContain('₹1,234')
      expect(edit.includes('name="apply_gst" value="1" checked')).toBe(gst)
      for(const path of ['/preview','/print']){const html=await(await f.app.request(f.url+path,{},f.env)).text();expect(html).toContain(gst?'GST':'GST not applied');expect(html).not.toContain('₹1,234')}
      const duplicate=await f.app.request(f.url+'/duplicate',{method:'POST'},f.env);const id=Number(duplicate.headers.get('location')!.match(/quotes\/(\d+)/)![1])
      expect((f.db.prepare('SELECT apply_gst FROM quotations WHERE id=?').get(id) as any).apply_gst).toBe(gst?1:0)
      const dup=f.db.prepare('SELECT * FROM quotation_options WHERE quotation_id=?').get(id) as any;for(const k of ['discount','taxes','total','extra_charges'])expect(dup[k]).toBe(saved[k])
      f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid)
      const customer=await(await f.publicApp.request('http://localhost/q/gst-token',{},f.env)).text();expect(customer).toContain(gst?'GST':'GST not applied');expect(customer).not.toContain('₹1,234')
      await f.app.request(f.url+'/reopen',{method:'POST'},f.env);expect(f.quote().status).toBe('draft');expect(f.quote().apply_gst).toBe(gst?1:0);expect(f.read().discount).toBe(749)
      f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid)
      await buildQuoteExplainer(f.env,f.qid);expect(f.quote().explainer).toContain(gst?'GST:':'GST not applied: ₹0');if(!gst)expect(f.quote().explainer).not.toContain('including taxes')
      const converted=await f.app.request(f.url+'/convert',{method:'POST'},f.env);expect(converted.headers.get('location')).toMatch(/\/staff\/bookings\/\d+/)
      const booking=f.db.prepare('SELECT * FROM bookings WHERE quotation_id=?').get(f.qid) as any
      expect(booking.apply_gst).toBe(gst?1:0);for(const k of ['subtotal','discount','taxes','total','extra_charges'])expect(booking[k]).toBe(saved[k])
      await storeInvoice(f.env,booking.id)
      expect(f.put.mock.calls.some((call:any)=>String(call[1]).includes(gst?'GST @':'GST not applied'))).toBe(true)
      const manager=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Manager',role:'admin',language:'en'});await next()}).route('/',opsRoutes)
      const change=await manager.request('http://localhost/staff/bookings/'+booking.id+'/change',{method:'POST',body:new URLSearchParams({room_id:String(f.rid),check_in:'2030-11-02',check_out:'2030-11-04'})},f.env)
      expect(change.status).toBe(303)
      const updated=f.db.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id) as any
      expect(updated.check_out).toBe('2030-11-04');expect(updated.apply_gst).toBe(gst?1:0);expect(updated.taxes).toBe(gst?437:0)
    }finally{f.db.close()}
  })
  it.each([['whatsapp',true],['whatsapp',false],['email',true],['email',false]] as const)('save/send %s with GST %s includes explicit tax state; approval cannot bypass the floor',async(via,gst)=>{
    const f=fixture(),wa=vi.spyOn(integrations,'sendWhatsApp').mockResolvedValue({ok:true}),email=vi.spyOn(integrations,'sendEmail').mockResolvedValue(true)
    try{
      const response=await f.app.request(f.url+'/send?via='+via,{method:'POST',body:f.form('749',gst)},f.env);expect(response.headers.get('location')).not.toContain('err=')
      expect(f.quote().status).toBe('sent');expect(f.quote().apply_gst).toBe(gst?1:0)
      const text=via==='whatsapp'?wa.mock.calls.at(-1)![2]:email.mock.calls.at(-1)![3];expect(text).toContain(gst?'GST: ₹238':'GST not applied: ₹0');expect(text).not.toContain('1234')
      f.db.prepare('UPDATE quotation_options SET discount=1000,discount_approved_by=1 WHERE id=?').run(f.oid)
      const blocked=await f.app.request(f.url+'/send?via='+via,{method:'POST',body:new URLSearchParams()},f.env);expect(blocked.headers.get('location')).toContain('err=')
    }finally{wa.mockRestore();email.mockRestore();f.db.close()}
  })
  it('recalculates GST-only submissions without losing the saved discount or extras',async()=>{
    const f=fixture();try{await f.save(f.form('749',true));const before=f.read();await f.save(new URLSearchParams({gst_control:'1'}));expect(f.quote().apply_gst).toBe(0);expect(f.read().taxes).toBe(0);expect(f.read().discount).toBe(before.discount);expect(f.read().extra_charges).toBe(before.extra_charges);expect(f.read().total).toBe(before.total-before.taxes)}finally{f.db.close()}
  })
})

it('additive GST migration preserves existing amounts and defaults ON without a data rewrite',()=>{
  const db=new DatabaseSync(':memory:');try{
    for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')&&!f.startsWith('0009')).sort())db.exec(readFileSync('migrations/'+file,'utf8'))
    db.exec(readFileSync('seed/seed.sql','utf8'))
    db.exec("INSERT INTO quotations(code,token,guest_name) VALUES('OLD','old','Guest'); INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,subtotal,discount,taxes,total) VALUES(1,1,1,'2030-11-01','2030-11-02',3999,749,163,3413); INSERT INTO bookings(code,property_id,room_id,check_in,check_out,nights,guest_name,guest_phone,subtotal,discount,taxes,total) VALUES('OLD-BK',1,1,'2030-11-01','2030-11-02',1,'Guest','123',3999,749,163,3413)")
    const before=['quotations','quotation_options','bookings'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all())
    db.exec(readFileSync('migrations/0009_quotation_gst.sql','utf8'))
    const after=['quotations','quotation_options','bookings'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all().map((r:any)=>{if('apply_gst'in r){expect(r.apply_gst).toBe(1);delete r.apply_gst}return r}))
    expect(after).toEqual(before);expect(()=>db.exec('UPDATE quotations SET apply_gst=2')).toThrow()
  }finally{db.close()}
})
