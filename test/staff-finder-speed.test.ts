// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  let queries = 0
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const st = { bind(...v: any[]) { values = v; return st }, async all() { queries++; return { results: db.prepare(sql).all(...values) } }, async first() { queries++; return db.prepare(sql).get(...values) ?? null } }
    return st
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', { id: 1, name: 'Sales test', role: 'sales', language: 'en' }); await next() }).route('/', opsRoutes)
  const addProperties = (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,rate_meal_plan,weekend_nights) VALUES (?,?,'resort','Speedtown','live','CP','5,6,0')").run(`speed-${Date.now()}-${i}-${Math.random()}`, `Speed ${i}`).lastInsertRowid)
      for (let r = 0; r < 3; r++) {
        const rid = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,capacity,units) VALUES (?,?,4000,3500,2,5)").run(id, `Room ${r}`).lastInsertRowid)
        db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,staff_rate,meal_plan,source,kind) VALUES (?,?,'Season','2026-10-01','2027-03-31',5000,4200,'CP','wizard','season')").run(id, rid)
      }
    }
  }
  const count = async (url: string) => { queries = 0; const res = await app.request('http://localhost' + url, {}, env); expect(res.status).toBe(200); return { queries, html: await res.text() } }
  return { addProperties, count }
}

describe('Staff Property Finder speed', () => {
  it('uses the same number of database queries whether 5 or 30 properties match', async () => {
    const f = fixture()
    const url = '/staff/finder?destination=Speedtown&checkIn=2026-10-19&checkOut=2026-10-21'
    f.addProperties(5)
    const small = await f.count(url)
    f.addProperties(25)
    const big = await f.count(url)
    const shown = (html: string) => (html.match(/<strong>Speed \d+<\/strong>/g) ?? []).length
    expect(shown(big.html)).toBe(20) // first page only
    expect(big.html).toContain('30 properties with free rooms')
    expect(big.html).toContain('₹4,200') // seasonal staff rate still resolved
    expect(big.html).toContain('₹5,000') // seasonal guest rate still resolved
    expect(big.queries).toBe(small.queries)
    expect(big.queries).toBeLessThan(25)
    expect(big.html).toContain('loading="lazy"')
    // "Load next 20" fetches only the result rows (no page layout), then stops.
    const more = big.html.match(/href="([^"]+)" data-finder-more/)![1].replace(/&amp;/g, '&')
    expect(more).toContain('page=2')
    const next = await f.count(more + '&partial=1')
    expect(next.html.startsWith('<div data-finder-chunk')).toBe(true)
    expect(shown(next.html)).toBe(10)
    expect(next.html).not.toContain('data-finder-more')
    expect(next.queries).toBeLessThan(big.queries)
  })

  it('runs no property queries until the user searches', async () => {
    const f = fixture()
    f.addProperties(3)
    const empty = await f.count('/staff/finder')
    expect(empty.html).toContain('Type a property name or location above to start.')
    expect(empty.html).not.toContain('<strong>Speed ')
    expect(empty.queries).toBeLessThan(10)
    const all = await f.count('/staff/finder?all=1')
    expect(all.html).toContain('<strong>Speed 0</strong>')
  })

  it('matches the keyword against property name and location, every word required', async () => {
    const f = fixture()
    f.addProperties(3)
    const byName = await f.count('/staff/finder?kw=speed+1&partial=1')
    expect(byName.html).toContain('<strong>Speed 1</strong>')
    expect(byName.html).not.toContain('<strong>Speed 2</strong>')
    const byPlace = await f.count('/staff/finder?kw=speedtown')
    expect((byPlace.html.match(/<strong>Speed \d<\/strong>/g) ?? []).length).toBe(3)
    expect((await f.count('/staff/finder?kw=speedtown+nowhere')).html).toContain('No matches')
    // LIKE wildcards typed by the user are literal characters.
    expect((await f.count('/staff/finder?kw=%25')).html).toContain('No matches')
  })
})
