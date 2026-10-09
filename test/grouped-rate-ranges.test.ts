// @ts-expect-error Node-only local SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node-only local filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { calculatePrice, nightlyRate, seasonAppliesOn, weekdaysLabel, type RoomRates, type SeasonRate } from '../src/lib/pricing'
import { submittedRanges, wizardRoutes } from '../src/routes/admin-wizard'
import { loadPricing } from '../src/lib/db'

const room: RoomRates = { id: 1, property_id: 10, base_rate: 4000, weekend_rate: null, min_nights: 1, capacity: 2, units: 5 }
const season = (o: Partial<SeasonRate>): SeasonRate => ({ property_id: 10, room_id: 1, name: 'Season', start_date: '2027-01-01', end_date: '2027-12-31', rate: 6000, pct_adjust: null, min_nights: null, kind: 'season', ...o })

describe('recurring weekday rates', () => {
  it('applies a weekday-limited row only on those nights', () => {
    const sat = season({ applicable_weekdays: '6' })
    expect(seasonAppliesOn(sat, '2027-01-02')).toBe(true) // Saturday
    expect(seasonAppliesOn(sat, '2027-01-03')).toBe(false) // Sunday
    expect(seasonAppliesOn(season({}), '2027-01-03')).toBe(true)
    expect(weekdaysLabel('0,5,6')).toBe('Every Fri, Sat, Sun')
    expect(weekdaysLabel(null)).toBe('')
  })

  it('every-Saturday rate beats the every-night rate of the same type, and season beats off-season', () => {
    const seasons = [
      season({ name: 'Off season', kind: 'off_season', rate: 3000 }),
      season({ name: 'Saturday season', rate: 7000, applicable_weekdays: '6' }),
      season({ name: 'Season', rate: 5000, start_date: '2027-03-01', end_date: '2027-03-31' }),
      season({ name: 'Season Saturdays', rate: 8000, start_date: '2027-03-01', end_date: '2027-03-31', applicable_weekdays: '6' }),
    ]
    expect(nightlyRate(room, seasons, '2027-01-01').rate).toBe(3000) // Friday: off-season
    expect(nightlyRate(room, seasons, '2027-01-02').rate).toBe(7000) // Saturday: Saturday season rate
    expect(nightlyRate(room, seasons, '2027-03-06').rate).toBe(8000) // Saturday in March: recurring beats every-night season
    expect(nightlyRate(room, seasons, '2027-03-05').rate).toBe(5000)
    const p = calculatePrice({ room, seasons, checkIn: '2027-01-01', checkOut: '2027-01-04' })
    expect(p.lines.map((l) => l.rate)).toEqual([3000, 7000, 3000])
  })

  it('applies recurring days to peak charges too', () => {
    const sup = season({ name: 'Saturday supplement', rate: null, kind: 'special', supplement: 1000, applicable_weekdays: '6', room_id: null })
    expect(nightlyRate(room, [sup], '2027-01-02').rate).toBe(5000)
    expect(nightlyRate(room, [sup], '2027-01-03').rate).toBe(4000)
  })
})

describe('submittedRanges', () => {
  it('keeps valid ranges in date order and drops blanks, reversed and duplicate ranges', () => {
    const f = { __all: { k_from: ['2027-08-14', '', '2027-01-01', '2027-03-22', '2027-01-01'], k_to: ['2027-08-31', '', '2027-01-20', '2027-03-20', '2027-01-20'], k_days: ['', '', '', '', '6,6'] } }
    expect(submittedRanges(f, 'k')).toEqual([
      { from: '2027-01-01', to: '2027-01-20', days: '' },
      { from: '2027-01-01', to: '2027-01-20', days: '6' },
      { from: '2027-08-14', to: '2027-08-31', days: '' },
    ])
  })
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,weekend_nights) VALUES('range-test','Range test','resort','Munnar','live','5,6')").run().lastInsertRowid)
  const roomId = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES(?,'Deluxe',4000)").run(id).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes)
  const save = (body: URLSearchParams) => app.request(`http://localhost/admin/properties/${id}/setup/3`, { method: 'POST', body }, env)
  const rows = () => db.prepare("SELECT * FROM season_rates WHERE property_id=? AND kind='season' ORDER BY start_date").all(id) as any[]
  return { db, env, app, id, roomId, save, rows }
}

function seasonForm(roomId: number, ranges: [string, string, string?][], rate = '6000') {
  const body = new URLSearchParams()
  for (const [from, to, days] of ranges) {
    body.append(`r${roomId}_sea_from`, from)
    body.append(`r${roomId}_sea_to`, to)
    body.append(`r${roomId}_sea_days`, days ?? '')
  }
  body.append(`r${roomId}_sea_wk_CP_direct`, rate)
  body.append(`r${roomId}_sea_we_CP_direct`, '7000')
  return body
}

describe('Room Rates step: several date ranges under one rate table', () => {
  it('saves one row per range with shared rates, prices every range, and reopens all ranges', async () => {
    const f = fixture()
    const res = await f.save(seasonForm(f.roomId, [['2027-01-01', '2027-01-20'], ['2027-03-20', '2027-03-22'], ['2027-08-14', '2027-08-31']]))
    expect(res.headers.get('location')).toContain('/setup/4')
    const rows = f.rows()
    expect(rows.map((r) => [r.start_date, r.end_date, r.rate, r.weekend_rate, r.meal_plan])).toEqual([
      ['2027-01-01', '2027-01-20', 6000, 7000, 'CP'], ['2027-03-20', '2027-03-22', 6000, 7000, 'CP'], ['2027-08-14', '2027-08-31', 6000, 7000, 'CP'],
    ])
    expect(new Set(rows.map((r) => r.rate_group_key))).toEqual(new Set([`wizard:${f.roomId}:season`]))

    const pricing = (await loadPricing(f.env, f.roomId))!
    const at = (d: string) => nightlyRate(pricing.room, pricing.seasons, d).rate
    // Outside the ranges the room's regular rate applies (the wizard keeps it in step with the Season CP rate).
    expect([at('2027-01-05'), at('2027-03-22'), at('2027-08-17'), at('2027-02-10')]).toEqual([6000, 6000, 6000, 6000])
    expect(at('2027-03-20')).toBe(7000) // Saturday inside a range: the period's weekend rate

    const html = await (await f.app.request(`http://localhost/admin/properties/${f.id}/setup/3`, {}, f.env)).text()
    expect(html.match(new RegExp(`name="r${f.roomId}_sea_from"`, 'g'))).toHaveLength(3)
    expect(html).toContain('value="2027-03-20"')
    expect(html).toContain('Add another date range')
  })

  it('keeps row IDs on a repeat save, updates prices on every range and deletes removed ranges', async () => {
    const f = fixture()
    await f.save(seasonForm(f.roomId, [['2027-01-01', '2027-01-20'], ['2027-03-20', '2027-03-22'], ['2027-08-14', '2027-08-31']]))
    const ids = f.rows().map((r) => r.id)
    await f.save(seasonForm(f.roomId, [['2027-01-01', '2027-01-20'], ['2027-08-14', '2027-08-31']], '6500'))
    const rows = f.rows()
    expect(rows.map((r) => [r.id, r.start_date, r.rate])).toEqual([[ids[0], '2027-01-01', 6500], [ids[2], '2027-08-14', 6500]])
  })

  it('saves a recurring every-Saturday range and prices only Saturdays with it', async () => {
    const f = fixture()
    await f.save(seasonForm(f.roomId, [['2027-01-01', '2027-12-31', '6']], '9000'))
    expect(f.rows()[0]).toMatchObject({ applicable_weekdays: '6', rate: 9000 })
    const pricing = (await loadPricing(f.env, f.roomId))!
    expect(nightlyRate(pricing.room, pricing.seasons, '2027-01-02').rate).toBe(7000) // Saturday: weekend season rate
    expect(nightlyRate(pricing.room, pricing.seasons, '2027-01-04').rate).toBe(4000) // Monday: regular rate, not the Saturday rate
    expect(f.db.prepare('SELECT base_rate FROM rooms WHERE id=?').get(f.roomId)).toMatchObject({ base_rate: 4000 })
    const html = await (await f.app.request(`http://localhost/admin/properties/${f.id}/setup/3`, {}, f.env)).text()
    expect(html).toMatch(/<option value="6" selected="">Every Saturday<\/option>/)
  })

  it('leaves existing single-range rows untouched until the period is saved', async () => {
    const f = fixture()
    f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,kind,meal_plan,source) VALUES (?,?,'Season','2027-01-01','2027-03-31',5500,'season','CP','wizard')").run(f.id, f.roomId)
    const html = await (await f.app.request(`http://localhost/admin/properties/${f.id}/setup/3`, {}, f.env)).text()
    expect(html.match(new RegExp(`name="r${f.roomId}_sea_from"`, 'g'))).toHaveLength(1)
    expect(f.rows()[0]).toMatchObject({ rate_group_key: null, applicable_weekdays: null })
  })
})
