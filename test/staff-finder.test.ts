// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { searchProperties } from '../src/lib/properties'
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
    const statement = { bind(...v: any[]) { values = v; return statement }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
    return statement
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  return { db, property, env, app: new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Sales test',role:'sales',language:'en'});await next()}).route('/', opsRoutes) }
}



describe('Staff Property Finder seasonal pricing',()=>{
  it('finds CP Staff-only Munnar Resort for the supplied dates and keeps blank optional filters harmless',async()=>{
    const f=fixture()
    try{
      const id=Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status,rate_meal_plan,weekend_nights) VALUES ('staff-munnar-test','Staff Munnar test','resort','Munnar','live','CP','5,6,0')").run().lastInsertRowid)
      const rid=Number(f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES (?,'CP room',0,2,5)").run(id).lastInsertRowid)
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,staff_rate,net_rate,staff_weekend_rate,net_weekend_rate,meal_plan,source,kind) VALUES (?,?,'Season','2026-10-01','2027-03-31',NULL,3250,998877,3500,998877,'CP','wizard','season')").run(id,rid)
      const query='/staff/finder?destination=Munnar&checkIn=2026-10-16&checkOut=2026-10-21&guests=2&type=resort&sort=recommended&priceMax=&q='
      const response=await f.app.request('http://localhost'+query,{},f.env)
      expect(response.status).toBe(200)
      const html=await response.text()
      expect(html).toContain('Staff Munnar test')
      expect(html).toContain('₹3,400')
      expect(html).not.toContain('₹0')
      expect(html).not.toContain('9,98,877')
      const request=async(suffix:string)=>{
        const url=new URL('http://localhost'+query)
        new URLSearchParams(suffix.replace(/^&/,'')).forEach((v,k)=>url.searchParams.set(k,v))
        return await (await f.app.request(url.toString(),{},f.env)).text()
      }
      expect(await request('&priceMax=3300')).not.toContain('Staff Munnar test')
      expect(await request('&priceMax=3500')).toContain('Staff Munnar test')
      expect(await request('&checkIn=2026-10-19&checkOut=2026-10-21')).toContain('₹3,250')
      expect(await request('&checkOut=2026-10-19')).toContain('₹3,500')
      expect(await request('&checkIn=2027-04-01&checkOut=2027-04-03')).toContain('Not supplied')
      expect((await searchProperties(f.env,{destination:'Munnar',checkIn:'2026-10-16',checkOut:'2026-10-21',guests:2,types:['resort']})).some(p=>p.id===id)).toBe(false)
      const peak=Number(f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,supplement,kind) VALUES (?,?,'Peak','2026-10-16','2026-10-20',NULL,1000,'special')").run(id,rid).lastInsertRowid)
      expect(await request('')).toContain('₹4,400')
      f.db.prepare('DELETE FROM season_rates WHERE id=?').run(peak)
      expect(await request('&destination=Vagamon')).not.toContain('Staff Munnar test')
      expect(await request('&type=villa')).not.toContain('Staff Munnar test')
      expect(await request('&guests=11')).not.toContain('Staff Munnar test')
      expect(await request('&q=quiet&sort=price_asc')).toContain('Staff Munnar test')
      expect(await request('&checkOut=2026-10-15')).toContain('Check-out must be after check-in')
      expect(await request('&checkOut=2026-10-15')).not.toContain('Staff Munnar test')
      const basic=await (await f.app.request('http://localhost/staff/finder?destination=Munnar&type=resort',{},f.env)).text()
      expect(basic).toContain('Staff Munnar test')
      f.db.prepare("UPDATE season_rates SET staff_weekend_rate=NULL WHERE room_id=?").run(rid)
      const blank=await request('')
      expect(blank).toContain('Staff Munnar test');expect(blank).toContain('Not supplied')
      expect(blank).not.toContain('₹3,250');expect(blank).not.toContain('₹0')
      f.db.prepare("UPDATE rooms SET base_rate=4000,staff_rate=3500 WHERE id=?").run(rid)
      f.db.prepare("DELETE FROM season_rates WHERE room_id=?").run(rid)
      const legacy=await request('')
      expect(legacy).toContain('₹3,500');expect(legacy).toContain('₹4,000')
      expect(legacy).not.toContain('9,98,877')
    }finally{f.db.close()}
  })
})
