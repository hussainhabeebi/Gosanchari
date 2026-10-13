// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { propertyEditorRoutes } from '../src/routes/admin-properties'
import { publicRoutes } from '../src/routes/public'
import { COVER_PHOTO_SQL } from '../src/lib/catalog'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('thumb-test','Thumb Test Resort','resort','Munnar','live')").run().lastInsertRowid)
  db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES(?,'Deluxe',5000)").run(pid)
  const photo = (key: string, category: string) => Number(db.prepare("INSERT INTO property_photos(property_id,r2_key,category,sort,media_type) VALUES(?,?,?,1,'image')").run(pid, key, category).lastInsertRowid)
  const facade = photo('facade.jpg', 'facade'), pool = photo('pool.jpg', 'pool')
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(s: any[]) { for (const x of s) await x.run(); return [] } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, MEDIA: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, KB: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const admin = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes).route('/', propertyEditorRoutes)
  const site = new Hono<any>().use('*', async (c, next) => { c.set('user', null); await next() }).route('/', publicRoutes)
  const cover = () => (db.prepare(`SELECT ${COVER_PHOTO_SQL} AS photo FROM properties p WHERE p.id = ?`).get(pid) as any).photo
  const save = (body: Record<string, string>) => admin.request(`http://localhost/admin/properties/${pid}/setup/6`, { method: 'POST', body: new URLSearchParams(body) }, env)
  const select=(id:number)=>admin.request(`http://localhost/admin/properties/${pid}/common-thumbnail`,{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams({photo_id:String(id)})},env)
  return { db, env, pid, facade, pool, admin, site, cover, save, select }
}

describe('property thumbnail', () => {
  it('is automatic (exterior photo) until one is chosen, then always wins', async () => {
    const f = fixture()
    expect(f.cover()).toBe('facade.jpg')
    await f.save({ thumbnail: String(f.pool) })
    expect(f.cover()).toBe('pool.jpg')
    const html = await (await f.site.request('http://localhost/stay/thumb-test', {}, f.env)).text()
    expect(html.indexOf('pool.jpg')).toBeLessThan(html.indexOf('facade.jpg'))
    await f.save({ thumbnail: 'auto' })
    expect(f.cover()).toBe('facade.jpg')
  })

  it('shows the picker with the current choice and ignores photos of other properties', async () => {
    const f = fixture()
    await f.save({ thumbnail: String(f.pool) })
    const page = await (await f.admin.request(`http://localhost/admin/properties/${f.pid}/setup/6`, {}, f.env)).text()
    expect(page).toContain('Thumbnail (main photo)')
    expect(page).toMatch(new RegExp(`value="${f.pool}" checked`))
    const other = Number((f.db.prepare("SELECT id FROM property_photos WHERE property_id != ? LIMIT 1").get(f.pid) as any)?.id ?? 99999)
    await f.save({ thumbnail: String(other) })
    expect(f.cover()).toBe('pool.jpg')
  })

  it('falls back to automatic when the thumbnail photo is deleted', async () => {
    const f = fixture()
    await f.save({ thumbnail: String(f.pool) })
    await f.save({ del_photo: String(f.pool) })
    expect(f.db.prepare('SELECT thumbnail_photo_id FROM properties WHERE id = ?').get(f.pid)).toEqual({ thumbnail_photo_id: null })
    expect(f.cover()).toBe('facade.jpg')
  })
})


describe('common-image cover controls',()=>{
 it('selects, changes and restores common thumbnails in both editors without rewriting property/media/room/rate data',async()=>{
  const f=fixture();try{
   const previous=f.db.prepare('SELECT * FROM properties WHERE id=?').get(f.pid) as any
   const records=JSON.stringify(['rooms','season_rates','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
   const response=await f.select(f.pool);expect(response.status).toBe(200);expect(await response.json()).toEqual({thumbnail_photo_id:f.pool});expect(f.cover()).toBe('pool.jpg')
   const current=f.db.prepare('SELECT * FROM properties WHERE id=?').get(f.pid) as any;expect({...current,thumbnail_photo_id:previous.thumbnail_photo_id}).toEqual(previous)
   for(const path of [`/admin/properties/${f.pid}/setup/1`,`/admin/properties/${f.pid}`]){
    const html=await(await f.admin.request('http://localhost'+path,{},f.env)).text()
    expect(html).toContain('Use as Thumbnail');expect(html).toContain('Selected Thumbnail');expect(html).toMatch(new RegExp(`data-common-thumbnail(?:="[^"]*")?[^>]*data-thumbnail-url="/admin/properties/${f.pid}/common-thumbnail"`))
    expect(html).toMatch(new RegExp(`data-select-common-thumbnail="${f.pool}" aria-pressed="true" disabled`))
   }
   const step6=await(await f.admin.request(`http://localhost/admin/properties/${f.pid}/setup/6`,{},f.env)).text();expect(step6).toMatch(new RegExp(`value="${f.pool}" checked`))
   await f.select(f.facade);expect(f.cover()).toBe('facade.jpg');expect(JSON.stringify(['rooms','season_rates','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))).toBe(records)
   expect(f.env.MEDIA.put).not.toHaveBeenCalled();expect(f.env.MEDIA.delete).not.toHaveBeenCalled()
  }finally{f.db.close()}
 })
 it('rejects room, video, empty and cross-property photos while preserving the existing room picker',async()=>{
  const f=fixture();try{
   const room=f.db.prepare('SELECT id FROM rooms WHERE property_id=?').get(f.pid) as any
   const roomPhoto=Number(f.db.prepare("INSERT INTO property_photos(property_id,room_id,r2_key,category,media_type) VALUES(?,?,'room.jpg','room','image')").run(f.pid,room.id).lastInsertRowid)
   const video=Number(f.db.prepare("INSERT INTO property_photos(property_id,r2_key,category,media_type) VALUES(?,'clip.mp4','common','video')").run(f.pid).lastInsertRowid)
   const empty=Number(f.db.prepare("INSERT INTO property_photos(property_id,r2_key,category,media_type) VALUES(?,'','common','image')").run(f.pid).lastInsertRowid)
   const foreign=f.db.prepare('SELECT id FROM property_photos WHERE property_id != ? LIMIT 1').get(f.pid) as any
   await f.save({thumbnail:String(roomPhoto)});expect(f.cover()).toBe('room.jpg')
   for(const id of [roomPhoto,video,empty,foreign.id,0,-1])expect((await f.select(id)).status).toBe(422)
   expect(f.cover()).toBe('room.jpg');expect((await f.select(f.pool)).status).toBe(200);expect(f.cover()).toBe('pool.jpg')
   expect(f.db.prepare('SELECT room_id FROM property_photos WHERE id=?').get(roomPhoto)).toEqual({room_id:room.id})
  }finally{f.db.close()}
 })
 it('deleting the selected common image safely falls back without affecting other images or R2 objects',async()=>{
  const f=fixture();try{
   await f.select(f.pool)
   const r=await f.admin.request(`http://localhost/admin/properties/${f.pid}/common-photos/${f.pool}/remove`,{method:'POST'},f.env)
   expect(r.status).toBe(200);expect(f.cover()).toBe('facade.jpg')
   expect(f.db.prepare('SELECT thumbnail_photo_id FROM properties WHERE id=?').get(f.pid)).toEqual({thumbnail_photo_id:null})
   expect(f.db.prepare('SELECT id FROM property_photos WHERE id=?').get(f.facade)).toBeTruthy();expect(f.env.MEDIA.delete).not.toHaveBeenCalled()
  }finally{f.db.close()}
 })
 it.each([null,'guest','sales'])('does not grant cover-write access to unauthorised role %s',async role=>{
  const f=fixture();try{
   const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',role?{id:1,role,name:'Tester'}:null);await next()}).route('/',wizardRoutes)
   const response=await app.request(`http://localhost/admin/properties/${f.pid}/common-thumbnail`,{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams({photo_id:String(f.pool)})},f.env)
   expect(response.status).toBe(role?403:302);expect(f.cover()).toBe('facade.jpg')
  }finally{f.db.close()}
 })
})
