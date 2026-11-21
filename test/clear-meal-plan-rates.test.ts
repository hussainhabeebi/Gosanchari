// @ts-expect-error Node-only local SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node-only local filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,weekend_nights) VALUES('clear-plan','Clear plan','resort','Munnar','live','5,6')").run().lastInsertRowid)
  const roomId = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES(?,'Deluxe',4000)").run(id).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes)
  const save = (body: URLSearchParams) => app.request(`http://localhost/admin/properties/${id}/setup/3`, { method: 'POST', body }, env)
  return { db, id, roomId, save }
}

function form(roomId: number, map: { b2b: string; direct: string; weB2b?: string; weDirect?: string }) {
  const body = new URLSearchParams()
  body.append(`r${roomId}_sea_from`, '2026-10-01'); body.append(`r${roomId}_sea_to`, '2027-03-31'); body.append(`r${roomId}_sea_days`, '')
  for (const dk of ['wk', 'we']) {
    const mapB2b = dk === 'we' && map.weB2b !== undefined ? map.weB2b : map.b2b
    const mapDirect = dk === 'we' && map.weDirect !== undefined ? map.weDirect : map.direct
    for (const [plan, b2b, staff, direct] of [['CP', '4500', '5100', '6000'], ['MAP', mapB2b, '', mapDirect], ['AP', '', '', ''], ['EP', '', '', '']]) {
      body.append(`r${roomId}_sea_${dk}_${plan}_b2b`, b2b)
      body.append(`r${roomId}_sea_${dk}_${plan}_staff`, staff)
      body.append(`r${roomId}_sea_${dk}_${plan}_direct`, direct)
    }
  }
  return body
}

describe('clearing a meal plan in the rates wizard', () => {
  it('deletes the saved rows when every rate box of the plan is emptied', async () => {
    const { db, id, roomId, save } = fixture()
    expect((await save(form(roomId, { b2b: '5700', direct: '6000' }))).headers.get('location')).toContain('/setup/4')
    const plans = () => (db.prepare("SELECT meal_plan FROM season_rates WHERE property_id=? AND kind='season' ORDER BY meal_plan").all(id) as any[]).map(r => r.meal_plan)
    expect(plans()).toEqual(['CP', 'MAP'])
    expect((await save(form(roomId, { b2b: '', direct: '' }))).headers.get('location')).toContain('/setup/4')
    expect(plans()).toEqual(['CP'])
    const prop = db.prepare('SELECT meal_plans, rate_meal_plan FROM properties WHERE id=?').get(id) as any
    expect(JSON.parse(prop.meal_plans)).toEqual(['CP'])
    expect(prop.rate_meal_plan).toBe('CP')
  })

  it('clears weekday and weekend MAP values separately and only drops MAP when both tables are empty', async () => {
    const { db, id, roomId, save } = fixture()
    await save(form(roomId, { b2b: '5700', direct: '6000' }))
    const map = () => db.prepare("SELECT rate, weekend_rate, net_rate, net_weekend_rate FROM season_rates WHERE property_id=? AND meal_plan='MAP'").all(id) as any[]
    // Weekdays cleared, weekends kept.
    await save(form(roomId, { b2b: '', direct: '', weB2b: '5900', weDirect: '6500' }))
    expect(map()).toEqual([{ rate: null, weekend_rate: 6500, net_rate: null, net_weekend_rate: 5900 }])
    // Weekends cleared too: no MAP row may survive.
    await save(form(roomId, { b2b: '', direct: '' }))
    expect(map()).toEqual([])
    // Reopening the step shows empty MAP boxes and is never served from cache.
    const res = await (fixtureApp(db, id))
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = await res.text()
    expect(html).not.toMatch(/name="r\d+_sea_(wk|we)_MAP_(b2b|direct)" value="\d/)
    expect(html).toContain('autocomplete="off"')
  })
})

async function fixtureApp(db: any, id: number) {
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { db.prepare(sql).run(...args); return { meta: {} } } }; return st } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes)
  return app.request(`http://localhost/admin/properties/${id}/setup/3`, {}, env)
}
