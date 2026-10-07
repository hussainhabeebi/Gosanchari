// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'

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
  return { db, property, env, app: new Hono().route('/', publicRoutes) }
}


describe('homepage Popular Stays', () => {
  it('includes ordinary Live Admin properties, excludes Draft/Hidden, and never sends private prices', async () => {
    const f=fixture()
    try {
      f.db.exec("UPDATE properties SET status='hidden'")
      const add=(name:string,status:string,featured=0,base=0)=>{
        const id=Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status,featured) VALUES (?,?,?,?,?,?)").run(name.toLowerCase().replace(/ /g,'-'),name,'resort','Munnar',status,featured).lastInsertRowid)
        f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate) VALUES (?,?,?,?,?)").run(id,'Room',base,987654,876543)
        f.db.prepare("INSERT INTO property_photos(property_id,r2_key,category) VALUES (?,?,?)").run(id,'cover-'+id+'.jpg','facade')
        return id
      }
      add('Live Featured','live',1,7000)
      add('Live Ordinary','live',0,0)
      add('Draft Excluded','draft',1,6000)
      add('Hidden Excluded','hidden',1,6000)
      const before=JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())
      const html=await (await f.app.request('http://localhost/',{},f.env)).text()
      const section=html.slice(html.indexOf('<section class="wrap section popular-stays">'),html.indexOf('</section>',html.indexOf('<section class="wrap section popular-stays">')))
      expect(section).toContain('Live Featured');expect(section).toContain('Live Ordinary')
      expect(section).not.toContain('Draft Excluded');expect(section).not.toContain('Hidden Excluded')
      expect(section).toContain('₹7,000');expect(section).not.toContain('₹0')
      expect(section).not.toContain('987654');expect(section).not.toContain('876543')
      expect(section).not.toContain('9,87,654');expect(section).not.toContain('8,76,543')
      expect(section).toContain('For a personalised offer')
      expect(section).toContain('class="btn btn-primary" href="/search"')
      expect(section).toContain('class="btn btn-sm btn-primary" data-stay-preview')
      expect(section).toContain('/stay/live-ordinary');expect(section).toContain('href="/search"')
      expect(section).toContain('cover-')
      expect(section.match(/class="card pcard"/g)).toHaveLength(2)
      expect(JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())).toBe(before)
      for(let i=0;i<8;i++)add('Extra Live '+i,'live')
      const more=await (await f.app.request('http://localhost/',{},f.env)).text()
      const carousel=more.slice(more.indexOf('class="stay-carousel"'),more.indexOf('</section>',more.indexOf('class="stay-carousel"')))
      expect(carousel.match(/class="card pcard"/g)).toHaveLength(6)
      expect(carousel).toContain('Live Featured')
    } finally { f.db.close() }
  })
})
