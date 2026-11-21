// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'
import { addDays, todayIST } from '../src/lib/util'

// A property set up only through the Room Rates wizard: rooms.base_rate stays 0, rates live in season_rates.
function fixture(seasons: { from: string; to: string; direct: number | null; staff: number; net: number }[]) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,rate_meal_plan,weekend_nights) VALUES ('moonlight-foggy-woods-vagamon','Moonlight Foggy Woods','resort','Vagamon','live','CP','')").run().lastInsertRowid)
  const room = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES (?,'Dome',0,2,3)").run(id).lastInsertRowid)
  for (const s of seasons) db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,weekend_rate,staff_rate,staff_weekend_rate,net_rate,net_weekend_rate,kind,meal_plan,source) VALUES (?,?,'Season',?,?,?,?,?,?,?,?,'season','CP','wizard')").run(id, room, s.from, s.to, s.direct, s.direct, s.staff, s.staff, s.net, s.net)
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const st = { bind(...v: any[]) { values = v; return st }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
    return st
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  const as = (role?: string) => {
    const user = role ? { ...(db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as any), role } : null
    return new Hono<any>().use('*', async (c, next) => { if (user) c.set('user', user); await next() }).route('/', publicRoutes)
  }
  const html = async (role?: string, path = '/stay/moonlight-foggy-woods-vagamon') => (await as(role).request('http://localhost' + path, {}, env)).text()
  return { html, room }
}
const rooms = (html: string) => html.slice(html.indexOf('class="prop-layout"'), html.indexOf('class="mobile-book-bar"'))
const today = todayIST()

describe('property page room rates from the Room Rates wizard', () => {
  it("shows guests tonight's Direct rate even when the room's legacy base rate is empty", async () => {
    const f = fixture([{ from: addDays(today, -10), to: addDays(today, 60), direct: 7500, staff: 6200, net: 5100 }])
    const guest = await f.html()
    expect(rooms(guest)).toContain('₹7,500')
    expect(rooms(guest)).toContain('per night tonight')
    expect(guest).not.toMatch(/6,200|5,100|Staff rate/) // internal rates never public
    expect(guest).toContain('From <strong>₹7,500</strong> per night') // mobile bar
    const staff = await f.html('staff')
    expect(rooms(staff)).toContain('₹7,500')
    expect(rooms(staff)).toContain('Staff rate: ₹6,200')
    expect(staff).not.toContain('5,100')
    // The shareable room page shows the same rate.
    const roomPage = await f.html(undefined, `/stay/moonlight-foggy-woods-vagamon/room/${f.room}`)
    expect(roomPage).toContain('₹7,500')
    expect(roomPage).not.toMatch(/6,200|5,100/)
  })

  it('shows "from" the lowest upcoming Direct rate when tonight has none', async () => {
    const f = fixture([
      { from: addDays(today, 20), to: addDays(today, 40), direct: 9000, staff: 8000, net: 7000 },
      { from: addDays(today, 50), to: addDays(today, 80), direct: 8200, staff: 7000, net: 6000 },
      { from: addDays(today, -40), to: addDays(today, -5), direct: 3000, staff: 2000, net: 1000 }, // past
    ])
    const guest = rooms(await f.html())
    expect(guest).toContain('from </small>₹8,200')
    expect(guest).not.toContain('₹3,000')
  })

  it('keeps "personalised offer" when only Staff/B2B rates were entered (Direct blank)', async () => {
    const f = fixture([{ from: addDays(today, -10), to: addDays(today, 60), direct: null, staff: 6200, net: 5100 }])
    const guest = await f.html()
    expect(rooms(guest)).toContain('For a personalised offer')
    expect(guest).not.toMatch(/₹0|6,200|5,100/)
    expect(rooms(await f.html('staff'))).toContain('Staff rate: ₹6,200')
  })
})
