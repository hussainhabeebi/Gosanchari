// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { opsRoutes } from '../src/routes/staff-ops'
import { staffRoomRoutes } from '../src/routes/staff-rooms'
import { calculatorRoutes } from '../src/routes/rate-calculator'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const prop = (slug: string, name: string, status: string) => {
    const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES(?,?,'resort','Munnar',?)").run(slug, name, status).lastInsertRowid)
    db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Standard',4000,3,5)").run(id)
    return id
  }
  const live = prop('live-resort', 'Live Resort', 'live'), draft = prop('draft-resort', 'Draft Resort', 'draft'), hidden = prop('hidden-resort', 'Hidden Resort', 'hidden')
  const sales = db.prepare("SELECT id FROM users WHERE email='priya@gosanchari.com'").get() as any
  const qid = Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,valid_till) VALUES('GS-QT-LIVE','live-token',?,'Guest','2030-12-31')").run(sales.id).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', { id: sales.id, name: 'Sales', role: 'sales', language: 'en' }); await next() }).route('/', staffRoomRoutes).route('/', calculatorRoutes).route('/', opsRoutes)
  const get = (path: string) => app.request('http://localhost' + path, {}, env)
  return { db, env, app, get, live, draft, hidden, qid }
}

describe('staff only see Live resorts', () => {
  it('lists only Live resorts and hides Draft/Hidden ones from every staff view', async () => {
    const f = fixture()
    const month = '2030-11'
    for (const path of ['/staff/rooms', '/staff/rooms?q=Resort', '/staff/rate-calculator', `/staff/calendar?month=${month}`, `/staff/quotes/${f.qid}`]) {
      const html = await (await f.get(path)).text()
      expect(html, path).toContain('Live Resort')
      expect(html, path).not.toContain('Draft Resort')
      expect(html, path).not.toContain('Hidden Resort')
    }
    for (const id of [f.draft, f.hidden]) {
      expect((await f.get(`/staff/rooms/${id}`)).status).toBe(404)
      expect((await f.get(`/staff/calendar/day?property=${id}&date=2030-11-01`)).status).toBe(404)
      expect(((await (await f.get(`/staff/rate-calculator/rooms?property=${id}`)).json()) as any).rooms).toEqual([])
    }
    expect((await f.get(`/staff/rooms/${f.live}`)).status).toBe(200)
    const compare = await (await f.get(`/staff/finder/compare?ids=${f.live}&ids=${f.draft}&ids=${f.hidden}`)).text()
    expect(compare).toContain('Live Resort')
    expect(compare).not.toContain('Draft Resort')
    expect(compare).not.toContain('Hidden Resort')
  })

  it('cannot add a Draft or Hidden resort to a quotation or hold its dates', async () => {
    const f = fixture()
    for (const id of [f.draft, f.hidden]) {
      const r = await f.get(`/staff/quotes/${f.qid}/options?property=${id}&checkIn=2030-11-01&checkOut=2030-11-03`)
      expect(decodeURIComponent(r.headers.get('location') ?? '').replace(/\+/g, ' ')).toContain('Only Live resorts')
      const hold = await f.app.request('http://localhost/staff/calendar/hold', { method: 'POST', body: new URLSearchParams({ property_id: String(id), from: '2030-11-01', nights: '1' }) }, f.env)
      expect(hold.status).toBe(404)
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM quotation_options WHERE quotation_id = ?').get(f.qid)).toEqual({ n: 0 })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blocked_dates WHERE property_id IN (?, ?)').get(f.draft, f.hidden)).toEqual({ n: 0 })
    await f.get(`/staff/quotes/${f.qid}/options?property=${f.live}&checkIn=2030-11-01&checkOut=2030-11-03`)
    expect(f.db.prepare('SELECT property_id FROM quotation_options WHERE quotation_id = ?').all(f.qid)).toEqual([{ property_id: f.live }])
  })
})
