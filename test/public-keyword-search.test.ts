// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  db.exec("UPDATE properties SET status='hidden'")
  const add = (slug: string, name: string, destination: string, status = 'live') => {
    const id = Number(db.prepare('INSERT INTO properties(slug,name,type,destination,status) VALUES (?,?,?,?,?)').run(slug, name, 'resort', destination, status).lastInsertRowid)
    db.prepare('INSERT INTO rooms(property_id,name,base_rate,capacity,units,staff_rate,net_rate) VALUES (?,?,?,?,?,?,?)').run(id, 'Room', 4000, 2, 5, 987654, 876543)
  }
  add('moonlight-foggy-woods-vagamon', 'Moonlight Foggy Woods', 'Vagamon')
  add('moonlight-magic-mountain-vagamon', 'Moonlight Magic Mountain', 'Vagamon')
  add('tea-valley-munnar', 'Tea Valley Resort', 'Munnar')
  add('moonlight-draft', 'Moonlight Draft Hideaway', 'Vagamon', 'draft')
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const st = { bind(...v: any[]) { values = v; return st }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
    return st
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  const app = new Hono().route('/', publicRoutes)
  return { get: (url: string) => app.request('http://localhost' + url, {}, env) }
}

describe('homepage search: resort name, place or destination', () => {
  it('finds a particular resort by name from the hero box', async () => {
    const f = fixture()
    const html = await (await f.get('/search?destination=moonlight+foggy')).text()
    // Main results only ("You might also like" may suggest other stays below).
    const main = html.split('You might also like')[0]
    expect(main).toContain('href="/stay/moonlight-foggy-woods-vagamon')
    expect(main).not.toContain('href="/stay/moonlight-magic-mountain-vagamon')
    expect(main).not.toContain('href="/stay/tea-valley-munnar')
    expect(main).toContain('1 stay')
    expect(html).toContain('🔎 moonlight foggy') // removable keyword chip
    expect(html).toContain('name="kw" value="moonlight foggy"')
  })

  it('matches name and place words together, and still treats real destinations as destinations', async () => {
    const f = fixture()
    const both = await (await f.get('/search?destination=Moonlight+Vagamon')).text()
    expect(both).toContain('/stay/moonlight-foggy-woods-vagamon')
    expect(both).toContain('/stay/moonlight-magic-mountain-vagamon')
    expect(both).not.toContain('/stay/moonlight-draft') // only live stays
    const place = await (await f.get('/search?destination=Munnar')).text()
    expect(place).toContain('/stay/tea-valley-munnar')
    expect(place).not.toContain('🔎')
    expect(await (await f.get('/search?destination=Nowhere+Resort')).text()).toContain('0 stays')
  })

  it('suggests destinations and live stays with public fields only', async () => {
    const f = fixture()
    const res = await f.get('/api/public/suggest?q=moonl')
    const body = await res.json() as any
    expect(body.stays.map((s: any) => s.slug)).toEqual(['moonlight-foggy-woods-vagamon', 'moonlight-magic-mountain-vagamon'])
    expect(Object.keys(body.stays[0]).sort()).toEqual(['destination', 'name', 'slug'])
    expect(JSON.stringify(body)).not.toMatch(/987654|876543/)
    const place = await (await f.get('/api/public/suggest?q=vagam')).json() as any
    expect(place.destinations).toEqual(['Vagamon, Kerala'])
    expect(place.stays).toHaveLength(2)
    expect((await (await f.get('/api/public/suggest?q=%25')).json() as any).stays).toEqual([])
    const hero = await (await f.get('/')).text()
    expect(hero).toContain('Search resort name, place or destination')
  })
})
