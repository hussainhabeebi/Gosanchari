// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { propertyMetaDescription, publicCanonical, publicSitemap, robotsText, travelAgencySchema } from '../src/lib/seo'
import { DEFAULT_SETTINGS } from '../src/lib/settings'
import { jsonScript } from '../src/views/components'
import { page } from '../src/views/layout'
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
  const app = new Hono<any>().get('/sitemap.xml', publicSitemap).get('/robots.txt', c=>c.text(robotsText(c.env.SITE_URL))).get('/staff/metadata-check',c=>page(c,{title:'Private',area:'staff'},'private')).route('/',publicRoutes)
  return { db, property, env, app }
}


function schemas(html: string) {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match=>JSON.parse(match[1]))
}
function description(html: string): string | undefined {
  return html.match(/<meta name="description" content="([^"]*)"/)?.[1]
}

describe('public technical SEO',()=>{
  it('improves homepage, About and Contact metadata without changing their visible heading/content',async()=>{
    const f=fixture();try {
      for (const [path,title,h1] of [
        ['/','Kerala Stays, Resorts &amp; Holiday Enquiries','Discover Kerala,'],
        ['/about','About Our Kerala Travel Team','About Go Sanchari'],
        ['/contact','Contact Us for Kerala Stay Enquiries','Contact us'],
      ]) {
        const html=await(await f.app.request('http://localhost'+path,{},f.env)).text()
        expect(html).toContain('<title>'+title+' · Go Sanchari</title>')
        expect(description(html)!.length).toBeGreaterThan(90)
        expect(html).toContain('rel="canonical" href="http://localhost'+(path==='/'?'/':path)+'"')
        expect(html).toContain(h1)
        expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
      }
    } finally {f.db.close()}
  })

  it('fills missing property descriptions from public highlights, keeps explicit SEO text and never uses legacy generated paragraphs',async()=>{
    const f=fixture();try {
      f.db.prepare('UPDATE properties SET seo_description=NULL,description=?,highlights=? WHERE id=?').run('LEGACY GENERATED PARAGRAPH NOT PUBLIC',JSON.stringify(['Existing estate setting','Existing balcony views']),f.property.id)
      const before=JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())
      const html=await(await f.app.request('http://localhost/stay/'+f.property.slug,{},f.env)).text()
      expect(description(html)).toContain(f.property.name)
      expect(description(html)).toContain('Existing estate setting')
      expect(html).not.toContain('LEGACY GENERATED PARAGRAPH NOT PUBLIC')
      expect(schemas(html)[0].description).toContain('Existing balcony views')
      expect(JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())).toBe(before)
      f.db.prepare('UPDATE properties SET seo_description=? WHERE id=?').run('Existing custom SEO description',f.property.id)
      expect(description(await(await f.app.request('http://localhost/stay/'+f.property.slug,{},f.env)).text())).toBe('Existing custom SEO description')
    } finally {f.db.close()}
  })

  it('makes fallback descriptions property-specific without inventing facilities or rates, and handles missing/malformed highlights',()=>{
    const base={name:'Existing Lodge',destination:'Vagamon',seo_description:null,highlights:'[]'}
    const first=propertyMetaDescription(base),second=propertyMetaDescription({...base,name:'Another Lodge'})
    expect(first).not.toBe(second);expect(first).toContain('Existing Lodge in Vagamon')
    expect(first).not.toMatch(/pool|spa|₹|breakfast|five.star/i)
    for(const highlights of ['', 'broken JSON', '{}', 'null', '[null,12,""]']) expect(propertyMetaDescription({...base,highlights})).toBe(first)
    const long=propertyMetaDescription({...base,highlights:JSON.stringify(['Existing public highlight '.repeat(30)])})
    expect(long.length).toBeLessThanOrEqual(160);expect(long).toContain('Existing Lodge')
  })

  it('uses clean canonicals on static pages and destination listings while excluding private/customer paths',async()=>{
    const f=fixture();try {
      for(const path of ['/offers','/enquiry','/policies/privacy']) {
        const html=await(await f.app.request('http://localhost'+path+'?utm_source=test',{},f.env)).text()
        expect(html).toContain('rel="canonical" href="http://localhost'+path+'"')
      }
      const html=await(await f.app.request('http://localhost/search?destination=MUNNAR&guests=2&sort=price_desc&view=map',{},f.env)).text()
      expect(html).toContain('rel="canonical" href="http://localhost/search?destination=Munnar%2C+Kerala"')
      const privateHtml=await(await f.app.request('http://localhost/staff/metadata-check',{},f.env)).text()
      expect(privateHtml).toContain('name="robots" content="noindex"');expect(privateHtml).not.toContain('rel="canonical"')
      for(const path of ['/q/private-token','/admin','/staff/quotes/1','/invoice/secret','/my/bookings']) expect(publicCanonical('https://gosanchari.com',path)).toBeUndefined()
      const missing=await f.app.request('http://localhost/stay/nonexistent',{},f.env)
      expect(missing.status).toBe(404);expect(await missing.text()).toContain('name="robots" content="noindex"')
    } finally {f.db.close()}
  })

  it('emits actual TravelAgency JSON-LD using public settings, without fabricated hours, ratings or contacts',async()=>{
    const f=fixture();try {
      f.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('business',JSON.stringify({...DEFAULT_SETTINGS.business,phone:'+91 8714082100',email:'hello@gosanchari.com',address:'Kochi, Kerala, India'}))
      const schema=schemas(await(await f.app.request('http://localhost/',{},f.env)).text())[0]
      expect(schema).toMatchObject({'@type':'TravelAgency',name:'Go Sanchari',telephone:'+91 8714082100',address:'Kochi, Kerala, India',logo:'http://localhost/brand/logo-wide.webp'})
      expect(schema).not.toHaveProperty('openingHours');expect(schema).not.toHaveProperty('aggregateRating')
      expect(schema).not.toHaveProperty('geo');expect(schema).not.toHaveProperty('priceRange')
      expect(travelAgencySchema('https://gosanchari.com',DEFAULT_SETTINGS.business)).not.toHaveProperty('telephone')
    } finally {f.db.close()}
  })

  it('emits lodging JSON-LD with valid image URLs and no invented region, private rates or invalid review ratings',async()=>{
    const f=fixture();try {
      f.db.prepare('UPDATE properties SET destination=?,rating_count=0,seo_description=NULL WHERE id=?').run('Masanagudi',f.property.id)
      f.db.prepare('INSERT INTO property_photos(property_id,r2_key,category) VALUES (?,?,?)').run(f.property.id,'https://images.example.test/existing-photo.jpg','facade')
      const html=await(await f.app.request('http://localhost/stay/'+f.property.slug+'?checkIn=2030-01-01&guests=4',{},f.env)).text()
      const [schema]=schemas(html)
      expect(schema['@type']).toBe('LodgingBusiness');expect(schema.address).toEqual({'@type':'PostalAddress',addressLocality:'Masanagudi'})
      expect(schema.image).toContain('https://images.example.test/existing-photo.jpg')
      expect(schema).not.toHaveProperty('aggregateRating');expect(schema).not.toHaveProperty('offers')
      expect(JSON.stringify(schema)).not.toMatch(/staff_rate|net_rate|owner_phone|contact_person/)
      expect(html).toContain('rel="canonical" href="http://localhost/stay/'+f.property.slug+'"')
      const preview=await(await f.app.request('http://localhost/stay/'+f.property.slug+'?preview=1',{},f.env)).text()
      expect(preview).toContain('name="robots" content="noindex"')
      f.db.prepare('UPDATE properties SET rating_count=2,rating_avg=4.5 WHERE id=?').run(f.property.id)
      const rated=schemas(await(await f.app.request('http://localhost/stay/'+f.property.slug,{},f.env)).text())[0]
      expect(rated.aggregateRating.ratingValue).toBe('4.5')
    } finally {f.db.close()}
  })

  it('escapes structured data safely while keeping existing application/json data scripts unchanged',()=>{
    const data={name:'Existing </script><img src=x> & text'}
    const ld=String(jsonScript('schema',data,'application/ld+json'))
    expect(ld).toContain('type="application/ld+json"');expect(ld).not.toContain('</script><img')
    expect(schemas(ld)[0]).toEqual(data)
    expect(String(jsonScript('gallery-data',data))).toContain('type="application/json"')
  })

  it('updates the sitemap from Live properties, excludes private paths and removes hidden/draft entries without writes',async()=>{
    const f=fixture();try {
      f.db.prepare('UPDATE content SET value=? WHERE key=?').run(JSON.stringify({privacy:'',terms:'',cancellation:''}),'policies')
      const snapshot=()=>JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())
      let before=snapshot()
      let xml=await(await f.app.request('http://localhost/sitemap.xml',{},f.env)).text()
      expect(snapshot()).toBe(before)
      expect(xml).toContain('http://localhost/enquiry');expect(xml).toContain('/stay/'+f.property.slug)
      expect(xml).not.toContain('/policies/privacy')
      expect(xml).not.toMatch(/\/staff|\/admin|\/my|\/q\/|\/invoice|\/booking|\/enquiry\/thanks|token=/)
      f.db.prepare("UPDATE properties SET status='hidden' WHERE id=?").run(f.property.id)
      xml=await(await f.app.request('http://localhost/sitemap.xml',{},f.env)).text();expect(xml).not.toContain('/stay/'+f.property.slug)
      f.db.prepare("UPDATE properties SET status='draft' WHERE id=?").run(f.property.id)
      expect(await(await f.app.request('http://localhost/sitemap.xml',{},f.env)).text()).not.toContain('/stay/'+f.property.slug)
      f.db.prepare("UPDATE properties SET status='live' WHERE id=?").run(f.property.id)
      f.db.prepare('UPDATE content SET value=? WHERE key=?').run(JSON.stringify({privacy:'Existing saved policy text',terms:'',cancellation:''}),'policies')
      before=snapshot();const response=await f.app.request('http://localhost/sitemap.xml',{},f.env);xml=await response.text()
      expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
      expect(xml).toContain('/policies/privacy');expect(xml).toContain('/stay/'+f.property.slug)
      expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].length).toBe(new Set([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1])).size)
      expect(snapshot()).toBe(before)
    } finally {f.db.close()}
  })

  it('keeps policy content unchanged, and robots protects customer paths while advertising the canonical sitemap',async()=>{
    const f=fixture();try {
      f.db.prepare('UPDATE content SET value=? WHERE key=?').run(JSON.stringify({privacy:'Client-approved saved text remains exactly the same.',terms:'',cancellation:''}),'policies')
      const before=JSON.stringify(f.db.prepare('SELECT * FROM content ORDER BY key').all())
      const html=await(await f.app.request('http://localhost/policies/privacy',{},f.env)).text()
      expect(html).toContain('Client-approved saved text remains exactly the same.')
      expect(JSON.stringify(f.db.prepare('SELECT * FROM content ORDER BY key').all())).toBe(before)
      const robots=await(await f.app.request('http://localhost/robots.txt',{},f.env)).text()
      for(const path of ['/staff','/admin','/my','/q/','/invoice/','/booking/','/enquiry/thanks/']) expect(robots).toContain('Disallow: '+path)
      expect(robots).toContain('Sitemap: http://localhost/sitemap.xml')
      expect(robots).not.toContain('Disallow: /stay')
    } finally {f.db.close()}
  })
})
