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
      expect(html).not.toContain('<details class="kids-policy"')
      expect(html).toContain('class="kids-policy-popover" hidden="" role="dialog"')
      expect(html).toContain('data-kids-room="'+a.rid+'"')
      expect(html).toContain('Selected room: Family room')
      expect(html).toContain('With bed: ₹900'); expect(html).toContain('Without bed: ₹650')
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

// Keep the policy outside normal flow; opening it cannot resize the quotation row.
describe('Quotation kids policy floating layout', () => {
  it('uses a fixed, viewport-sized overlay and supports option-scoped room selection and dismissal', () => {
    const css = readFileSync('public/app.css', 'utf8')
    const js = readFileSync('public/app.js', 'utf8')
    expect(css).toMatch(/\.kids-policy-popover \{ position:fixed;/)
    expect(css).toContain('max-width:calc(100vw - 24px)')
    expect(js).toContain('item.dataset.kidsRoom !== room.value')
    expect(js).toContain("room.addEventListener('change'")
    expect(js).toContain("event.key === 'Escape'")
    expect(js).toContain('!panel.contains(event.target) && !button.contains(event.target)')
  })
})

describe('Staff quotation fixed rupee discounts', () => {
  it('enforces the percentage allowance, preserves legacy amounts, GST order and booking totals', async () => {
    const f = fixture()
    try {
      const pid = Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES ('discount-fixture','Discount fixture','resort','Munnar','live')").run().lastInsertRowid)
      const rid = Number(f.db.prepare("INSERT INTO rooms(property_id,name,capacity,base_guests,units,base_rate,extra_adult_rate) VALUES (?,'Discount room',5,2,10,5000,1000)").run(pid).lastInsertRowid)
      const qid = Number(f.db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,valid_till) VALUES ('FLAT-DISCOUNT','flat-token',1,'Guest','919999999999','2026-12-01')").run().lastInsertRowid)
      const oid = Number(f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,children,rooms_count,subtotal,discount,discount_pct,taxes,total) VALUES (?,?,?,'2026-10-16','2026-10-18',2,0,1,10000,300,3,485,10185)").run(qid,pid,rid).lastInsertRowid)
      const url = 'http://localhost/staff/quotes/' + qid
      const read = () => f.db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
      const save = (amount: string, extras='0', kids='0', adults='2', guestRate='') => f.app.request(url,{method:'POST',body:new URLSearchParams({opt_id:String(oid),guest_name:'Guest',valid_till:'2026-12-01', ['room_'+oid]:String(rid),['in_'+oid]:'2026-10-16',['out_'+oid]:'2026-10-18',['rooms_'+oid]:'1',['adults_'+oid]:adults,['children_'+oid]:'0',['discount_'+oid]:amount,['extra_'+oid]:extras,['kids_'+oid]:kids,['grate_'+oid]:guestRate})},f.env)
      const html = await (await f.app.request(url,{},f.env)).text()
      expect(html).toContain('Discount Amount ₹');expect(html).not.toContain('Discount % (your limit')
      expect(html).toContain('name="discount_'+oid+'" value="300"')
      expect(html).toContain('Maximum allowed: ₹500')
      await save('300')
      expect(read().discount).toBe(300);expect(read().total).toBe(10185)
      await save('500')
      expect(read().discount).toBe(500);expect(read().discount_pct).toBe(5)
      expect(read().taxes).toBe(475);expect(read().total).toBe(9975)
      const before = JSON.stringify(read())
      const denied = await save('600')
      expect(denied.status).toBe(303)
      expect(new URL(denied.headers.get('location')!, 'http://localhost').searchParams.get('err')).toContain('Maximum discount allowed for this quotation is ₹500.')
      expect(JSON.stringify(read())).toBe(before)
      await save('500','100','900')
      expect(read().extra_charges).toBe(1000);expect(read().taxes).toBe(525);expect(read().total).toBe(11025)
      const reopened = await (await f.app.request(url,{},f.env)).text()
      expect(reopened).toContain('name="discount_'+oid+'" value="500"')
      expect(reopened).toContain('name="kids_'+oid+'" value="900"')
      const preview = await (await f.app.request(url+'/preview',{},f.env)).text()
      const print = await (await f.app.request(url+'/print',{},f.env)).text()
      expect(preview).toContain('− ₹500');expect(print).toContain('− ₹500')
      await save('600','0','0','3') // Extra-adult charges are part of the discount base.
      expect(read().subtotal).toBe(12000);expect(read().discount).toBe(600);expect(read().total).toBe(11970)
      await save('500','0','0','2','6000')
      expect(read().subtotal).toBe(12000);expect(read().discount).toBe(500)
      await save('')
      expect(read().discount).toBe(0);expect(read().total).toBe(10500)
      // Forged old percentage field cannot bypass the fixed amount or permission check.
      const tampered = new URLSearchParams({opt_id:String(oid),['discount_'+oid]:'501',['disc_'+oid]:'0'})
      const rejected = await f.app.request(url,{method:'POST',body:tampered},f.env)
      expect(new URL(rejected.headers.get('location')!, 'http://localhost').searchParams.get('err')).toContain('Maximum discount allowed')
      expect(read().discount).toBe(0)
      await save('500','100','900')
      const expected = read()
      // Legacy 5% of ₹99 rounds to ₹5; unchanged quotations keep that exact amount.
      f.db.prepare('UPDATE rooms SET base_rate=99 WHERE id=?').run(rid)
      f.db.prepare('UPDATE quotation_options SET check_out=\'2026-10-17\',subtotal=99,discount=5,discount_pct=5,extra_charges=0,taxes=5,total=99 WHERE id=?').run(oid)
      const legacyBody = new URLSearchParams({opt_id:String(oid),['in_'+oid]:'2026-10-16',['out_'+oid]:'2026-10-17',['discount_'+oid]:'5'})
      const legacySave = await f.app.request(url,{method:'POST',body:legacyBody},f.env)
      expect(new URL(legacySave.headers.get('location')!,'http://localhost').searchParams.get('err')).toBeNull()
      expect(read().discount).toBe(5);expect(read().discount_pct).toBe(5)
      f.db.prepare('UPDATE rooms SET base_rate=5000 WHERE id=?').run(rid)
      await save('500','100','900')
      f.env.JOBS = { async send() {} }
      const converted = await f.app.request(url+'/convert',{method:'POST'},f.env)
      expect(converted.status).toBe(303)
      const booking = f.db.prepare('SELECT * FROM bookings WHERE quotation_id=?').get(qid) as any
      expect(booking).toBeTruthy()
      for (const field of ['subtotal','discount','extra_charges','taxes','total']) expect(booking[field]).toBe(expected[field])
    } finally { f.db.close() }
  })
})
