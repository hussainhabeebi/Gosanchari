// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoutes } from '../src/routes/api'
import { integrationRoutes } from '../src/routes/admin-integrations'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,address,lat,lng,map_url,status,owner_phone,internal_notes,commission_pct,contact) VALUES('share-test','Share Test Resort','resort','Munnar','Chinnakanal, Munnar',10.08,77.05,'https://maps.google.com/?q=10.08,77.05','live','+919999900000','SECRET NOTE',15,'{\"phone\":\"+918888800000\"}')").run().lastInsertRowid)
  const room = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,weekend_rate,net_rate,staff_rate,capacity) VALUES(?,'Deluxe',6500,7500,3100,4200,3)").run(pid).lastInsertRowid)
  db.prepare("INSERT INTO property_photos(property_id,r2_key,category,sort,media_type) VALUES(?,'props/share/front.jpg','facade',1,'image')").run(pid)
  db.prepare("INSERT INTO property_photos(property_id,r2_key,category,sort,media_type,room_id) VALUES(?,'props/share/room.jpg','room',2,'image',?)").run(pid, room)
  const draft = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('share-draft','Draft Villa','villa','Wayanad','draft')").run().lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(s: any[]) { for (const x of s) await x.run(); return [] } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'https://gosanchari.com', ENVIRONMENT: 'production' }
  const admin = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', integrationRoutes)
  const api = new Hono<any>().use('*', async (c, next) => { c.set('user', null); await next() }).route('/', apiRoutes)
  const post = (path: string, body: Record<string, string>) => admin.request(`https://gosanchari.com${path}`, { method: 'POST', body: new URLSearchParams(body) }, env)
  const get = (path: string, key?: string) => api.request(`https://gosanchari.com${path}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {}, env)
  return { db, env, pid, draft, post, get }
}

afterEach(() => vi.unstubAllGlobals())

describe('property sharing API (pull)', () => {
  it('rejects requests without a valid key', async () => {
    const f = fixture()
    expect((await f.get('/api/v1/properties')).status).toBe(401)
    expect((await f.get('/api/v1/properties', 'gs_live_wrong')).status).toBe(401)
  })

  it('returns complete guest-facing details with a key created in admin, and hides private data', async () => {
    const f = fixture()
    const html = await (await f.post('/admin/integrations/keys', { name: 'LeadVyne' })).text()
    const key = html.match(/gs_live_[\w-]+/)![0]
    expect(f.db.prepare("SELECT token_hash FROM api_connections WHERE name = 'LeadVyne'").get().token_hash).not.toContain(key)

    const one = await f.get('/api/v1/properties/share-test', key)
    expect(one.status).toBe(200)
    const { data } = (await one.json()) as any
    expect(data.name).toBe('Share Test Resort')
    expect(data.url).toBe('https://gosanchari.com/stay/share-test')
    expect(data.location).toMatchObject({ destination: 'Munnar', address: 'Chinnakanal, Munnar', lat: 10.08, lng: 77.05 })
    expect(data.price).toMatchObject({ currency: 'INR', from_per_night: 6500 })
    expect(data.rooms[0].price).toMatchObject({ base_per_night: 6500, weekend_per_night: 7500 })
    expect(data.cover_image).toBe('https://gosanchari.com/media/props/share/front.jpg')
    expect(data.rooms[0].images).toEqual(['https://gosanchari.com/media/props/share/room.jpg'])
    const text = JSON.stringify(data)
    for (const secret of ['3100', '4200', '+919999900000', '+918888800000', 'SECRET NOTE', 'commission']) expect(text).not.toContain(secret)

    const list = (await (await f.get('/api/v1/properties?destination=munnar&limit=50', key)).json()) as any
    expect(list.data.some((p: any) => p.id === f.pid)).toBe(true)
    expect(list.data.every((p: any) => p.location.destination === 'Munnar')).toBe(true)
    expect((await f.get(`/api/v1/properties/${f.draft}`, key)).status).toBe(404)
  })

  it('stops accepting a revoked key', async () => {
    const f = fixture()
    const key = (await (await f.post('/admin/integrations/keys', { name: 'LeadVyne' })).text()).match(/gs_live_[\w-]+/)![0]
    const id = f.db.prepare("SELECT id FROM api_connections WHERE name = 'LeadVyne'").get().id
    await f.post(`/admin/integrations/${id}/toggle`, {})
    expect((await f.get('/api/v1/properties', key)).status).toBe(401)
  })
})

describe('property sharing to a service URL (push)', () => {
  it('posts properties to the endpoint with the API token and records the result', async () => {
    const f = fixture()
    const calls: { url: string; headers: Record<string, string>; body: any }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return new Response('{}', { status: 200 })
    }))
    const res = await f.post('/admin/integrations/push', { name: 'LeadVyne', url: 'https://api.leadvyne.example/properties', token: 'lv_token_123456', auth_style: 'bearer', send_now: '1' })
    expect(res.status).toBe(303)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].url).toBe('https://api.leadvyne.example/properties')
    expect(calls[0].headers.Authorization).toBe('Bearer lv_token_123456')
    expect(calls[0].body.event).toBe('properties.sync')
    const sent = calls.flatMap((c) => c.body.properties)
    expect(sent.find((p: any) => p.id === f.pid)?.price.from_per_night).toBe(6500)
    expect(sent.some((p: any) => p.id === f.draft)).toBe(false)
    const conn = f.db.prepare("SELECT * FROM api_connections WHERE name = 'LeadVyne'").get()
    expect(conn.last_status).toMatch(/^OK/)
    expect(conn.token_hint).toBe('lv_t…3456')

    calls.length = 0
    await f.post(`/admin/integrations/${conn.id}/sync`, { property_id: String(f.pid) })
    expect(calls).toHaveLength(1)
    expect(calls[0].body.properties.map((p: any) => p.id)).toEqual([f.pid])
  })

  it('refuses non-https endpoints and reports failures from the service', async () => {
    const f = fixture()
    const bad = await f.post('/admin/integrations/push', { name: 'X', url: 'http://insecure.example', token: 't' })
    expect(new URL(bad.headers.get('location')!, 'http://x').searchParams.get('err')).toContain('https://')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad token', { status: 401 })))
    const res = await f.post('/admin/integrations/push', { name: 'LeadVyne', url: 'https://api.leadvyne.example/p', token: 'nope-nope', auth_style: 'x-api-key', send_now: '1' })
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('err')).toContain('HTTP 401')
    expect(f.db.prepare("SELECT last_status FROM api_connections WHERE name = 'LeadVyne'").get().last_status).toMatch(/^Failed/)
  })
})
