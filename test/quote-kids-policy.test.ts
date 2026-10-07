// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'

function fixture(categories: string[] = []) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const property = db.prepare('SELECT id,slug,name FROM properties WHERE status=\'live\' ORDER BY id LIMIT 1').get() as { id: number; slug: string; name: string }
  db.prepare('DELETE FROM property_photos WHERE property_id=?').run(property.id)
  categories.forEach((category, index) => db.prepare('INSERT INTO property_photos(property_id,r2_key,category,sort) VALUES (?,?,?,?)').run(property.id, `ui-photo-${index}.jpg`, category, index))
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const statement = { bind(...v: any[]) { values = v; return statement }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null }, async run() { const r=db.prepare(sql).run(...values);return {meta:{last_row_id:Number(r.lastInsertRowid)}} } }
    return statement
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  return { db, property, env, app: new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Sales test',role:'sales',language:'en'});await next()}).route('/', opsRoutes) }
}




describe('Staff quotation manual kids policy amounts',()=>{
  it('retains a manual amount per option, suppresses count-only charges, and restores property policies',async()=>{
    const f=fixture()
    try{
      const qid=Number(f.db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,valid_till) VALUES ('KIDS-TEST','kids-test-token',1,'Guest','2026-12-01')").run().lastInsertRowid)
      const make=(name:string,free:number,charge:number)=>{
        const pid=Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status,child_free_below,child_age_to) VALUES (?,?,'resort','Munnar','live',?,11)").run(name.toLowerCase().replace(/ /g,'-'),name,free).lastInsertRowid)
        const rid=Number(f.db.prepare("INSERT INTO rooms(property_id,name,capacity,base_guests,units,base_rate,extra_child_rate,child_no_bed_rate,extra_adult_rate) VALUES (?,'Family room',4,2,5,4000,?,?,1200)").run(pid,charge,charge-250).lastInsertRowid)
        const oid=Number(f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,children,rooms_count) VALUES (?,?,?,'2026-10-16','2026-10-18',2,1,1)").run(qid,pid,rid).lastInsertRowid)
        return {pid,rid,oid}
      }
      const a=make('Policy A',6,900),b=make('Policy B',5,700)
      const before=JSON.stringify(['properties','rooms'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
      const save=async(amountA:string,amountB:string,children=1)=>{
        const body=new URLSearchParams({guest_name:'Guest',valid_till:'2026-12-01'})
        for(const [o,amount] of [[a,amountA],[b,amountB]] as const){
          body.append('opt_id',String(o.oid));body.set('room_'+o.oid,String(o.rid))
          body.set('in_'+o.oid,'2026-10-16');body.set('out_'+o.oid,'2026-10-18')
          body.set('adults_'+o.oid,'2');body.set('children_'+o.oid,String(children));body.set('rooms_'+o.oid,'1')
          body.set('kids_'+o.oid,amount);body.set('extra_'+o.oid,'0')
        }
        const r=await f.app.request('http://localhost/staff/quotes/'+qid,{method:'POST',body},f.env)
        expect(r.status).toBe(303)
      }
      const read=(o:typeof a)=>f.db.prepare('SELECT * FROM quotation_options WHERE id=?').get(o.oid) as any
      await save('','')
      expect(read(a).subtotal).toBe(8000);expect(read(a).extra_charges).toBe(0)
      expect(read(a).total).toBe(8400)
      await save('900','0')
      expect(read(a).subtotal).toBe(8000);expect(read(a).extra_charges).toBe(900);expect(read(a).total).toBe(9345)
      expect(JSON.parse(read(a).addons)).toEqual([{kind:'kids',name:'Kids Amount',price:900,qty:1,total:900}])
      expect(read(b).extra_charges).toBe(0);expect(read(b).total).toBe(8400)
      await save('900','650')
      expect(read(b).extra_charges).toBe(650)
      const html=await (await f.app.request('http://localhost/staff/quotes/'+qid,{},f.env)).text()
      expect(html).toContain('See Kids Policy')
      expect(html).toContain('Policy A — Kids Policy');expect(html).toContain('Children below 6: Complimentary')
      expect(html).toContain('Policy B — Kids Policy');expect(html).toContain('Children below 5: Complimentary')
      expect(html).toContain('12+ years treated as adult')
      expect(html).toContain('name="kids_'+a.oid+'" value="900"')
      expect(html).toContain('name="kids_'+b.oid+'" value="650"')
      await save('900','650',2)
      expect(read(a).subtotal).toBe(8000);expect(read(a).extra_charges).toBe(900)
      expect(JSON.parse(read(a).addons)).toHaveLength(1)
      const preview=await (await f.app.request('http://localhost/staff/quotes/'+qid+'/preview',{},f.env)).text()
      const print=await (await f.app.request('http://localhost/staff/quotes/'+qid+'/print',{},f.env)).text()
      expect(preview).toContain('Kids Amount (₹900)');expect(print).toContain('Kids Amount (₹900)')
      await save('','',0)
      expect(read(a).extra_charges).toBe(0);expect(read(a).total).toBe(8400)
      expect(JSON.stringify(['properties','rooms'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))).toBe(before)
    }finally{f.db.close()}
  })
})
