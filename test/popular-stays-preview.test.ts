// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'

function fixture(categories: string[]) {
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

describe('Popular Stays property preview',()=>{
  it.each([[['facade','room','pool']],[[]]])('reuses property content, photos and enquiry in preview: %j',async(categories)=>{
    const f=fixture(categories);try{
      const before=JSON.stringify(['properties','rooms','property_photos','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()));
      const html=await(await f.app.request('http://localhost/stay/'+f.property.slug+'?preview=1',{},f.env)).text();
      expect(html).toContain('embedded-stay');expect(html).toContain('data-preview-gallery');expect(html).toContain(f.property.name);
      expect(html).toContain('data-gallery-main');expect(html).toContain('data-gallery-counter');
      expect(html.match(/data-gallery-index=/g)).toHaveLength(Math.max(1,categories.length));
      const gallery=html.slice(html.indexOf('data-preview-gallery'),html.indexOf('<h1 class="property-title"'));
      expect(gallery.match(/data-full/g)).toHaveLength(Math.max(1,categories.length));
      if(categories.length>1){expect(html).toContain('data-gallery-step="1"');expect(html).toContain('data-gallery-step="-1"')}
      expect(html).toContain('data-preview-room-price');expect(html).toContain('Meal plans:');expect(html).toContain('Get Quote');expect(html).not.toContain('>Book</button>');
      expect(html).toContain('Personal');expect(html).toContain('Advisor');expect(html).toContain('data-advisor-whatsapp');expect(html).toContain('action="/enquiry"');
      expect(html).toContain('name="property_id" value="'+f.property.id+'"');expect(html).toContain('name="adults"');expect(html).toContain('name="children"');expect(html).toContain('name="rooms"');
      expect(html).toContain('rel="canonical" href="http://localhost/stay/'+f.property.slug+'"');
      expect(html).not.toContain('Similar properties');
      const direct=await(await f.app.request('http://localhost/stay/'+f.property.slug,{},f.env)).text();expect(direct).not.toContain('data-preview-gallery');expect(direct).toContain('class="mobile-book-bar"');
      expect(JSON.stringify(['properties','rooms','property_photos','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))).toBe(before);
    }finally{f.db.close()}
  });
  it.each(['guest','staff','admin'])('preview and its existing price endpoint never expose private prices to %s',async(role)=>{
    const f=fixture(['facade','room']);try{
      f.db.prepare('UPDATE rooms SET staff_rate=987654,net_rate=876543 WHERE property_id=?').run(f.property.id);
      const room=f.db.prepare('SELECT id FROM rooms WHERE property_id=? ORDER BY id LIMIT 1').get(f.property.id) as any;
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,staff_rate,net_rate,kind,meal_plan) VALUES(?,?,'CP dated public','2030-01-01','2030-01-31',8000,987654,876543,'season','CP')").run(f.property.id,room.id);
      f.db.prepare("UPDATE properties SET rate_meal_plan='CP' WHERE id=?").run(f.property.id);
      const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,role});await next()}).route('/',publicRoutes);
      const html=await(await app.request('http://localhost/stay/'+f.property.slug+'?preview=1',{},f.env)).text();expect(html).not.toMatch(/987654|876543|9,87,654|8,76,543/);
      const price=await(await app.request('http://localhost/stay/'+f.property.slug+'/price',{method:'POST',body:new URLSearchParams({room:String(room.id),checkIn:'2030-01-07',checkOut:'2030-01-08',adults:'2',children:'0',rooms:'1'})},f.env)).json() as any;
      expect(price.roomCharges).toBe(8000);expect(JSON.stringify(price)).not.toMatch(/987654|876543|staff_rate|net_rate/);
    }finally{f.db.close()}
  });
  it('loads only the selected property and does not publish hidden properties',async()=>{
    const f=fixture(['facade']);try{
      const other=f.db.prepare('SELECT slug,name FROM properties WHERE id!=? ORDER BY id LIMIT 1').get(f.property.id) as any;
      const html=await(await f.app.request('http://localhost/stay/'+f.property.slug+'?preview=1',{},f.env)).text();expect(html).toContain(f.property.name);expect(html).not.toContain(other.name);
      f.db.prepare("UPDATE properties SET status='hidden' WHERE id=?").run(f.property.id);
      expect((await f.app.request('http://localhost/stay/'+f.property.slug+'?preview=1',{},f.env)).status).toBe(404);
    }finally{f.db.close()}
  });
});
