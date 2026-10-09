// @ts-expect-error Node-only local SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node-only local filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { nightlyRate } from '../src/lib/pricing'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { loadPricing } from '../src/lib/db'

const key = '33333333-3333-4333-8333-333333333333'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  db.exec('DELETE FROM season_rates WHERE property_id IS NULL') // demo +25% Christmas season would mask the peak charges
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const id = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('peak-room-test','Peak room test','resort','Munnar','live')").run().lastInsertRowid)
  const rooms = [['Standard', 4000], ['Deluxe', 6000], ['Suite', 9000]].map(([name, rate]) => Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate) VALUES(?,?,?)').run(id, name, rate).lastInsertRowid))
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes)
  const step = `http://localhost/admin/properties/${id}/setup/3`
  const save = (body: URLSearchParams) => app.request(step, { method: 'POST', body }, env)
  const price = async (roomId: number, date: string) => { const p = (await loadPricing(env, roomId))!; return nightlyRate(p.room, p.seasons, date).rate }
  return { db, env, app, id, rooms, step, save, price }
}

/** The form exactly as the Room Rates screen submits it: one common peak row and one charge box per room category. */
function peakForm(rooms: number[], perRoom: (string | [string, string])[], common = '1000') {
  const b = new URLSearchParams({ common_managed_id: '', common_managed_key: key, common_managed_remove: '0', common_managed_from: '2026-12-24', common_managed_to: '2026-12-31', common_managed_amt: common, common_managed_desc: 'Christmas & New Year' })
  rooms.forEach((r, i) => {
    const [amount, id] = Array.isArray(perRoom[i]) ? perRoom[i] as [string, string] : [perRoom[i] as string, '']
    b.append(`r${r}_managed_id`, id); b.append(`r${r}_managed_key`, key); b.append(`r${r}_managed_remove`, '0'); b.append(`r${r}_managed_amt`, amount)
  })
  return b
}

describe('peak season: a different rate hike for each room category', () => {
  it('charges each category its own hike, and the common hike where none is given', async () => {
    const f = fixture()
    const res = await f.save(peakForm(f.rooms, ['', '1500', '3000']))
    expect(res.headers.get('location')).toContain('/setup/4')
    expect(await f.price(f.rooms[0], '2026-12-25')).toBe(4000 + 1000)
    expect(await f.price(f.rooms[1], '2026-12-25')).toBe(6000 + 1500)
    expect(await f.price(f.rooms[2], '2026-12-25')).toBe(9000 + 3000)
    expect(await f.price(f.rooms[2], '2027-01-02')).toBe(9000) // outside the peak
    const overrides = f.db.prepare("SELECT room_id, name, supplement, start_date, end_date FROM season_rates WHERE source = ? ORDER BY room_id").all('wizard-override:' + key)
    expect(overrides).toEqual([
      { room_id: f.rooms[1], name: 'Christmas & New Year', supplement: 1500, start_date: '2026-12-24', end_date: '2026-12-31' },
      { room_id: f.rooms[2], name: 'Christmas & New Year', supplement: 3000, start_date: '2026-12-24', end_date: '2026-12-31' },
    ])
  })

  it('reopens with the saved amounts, and clearing a box returns that category to the common hike', async () => {
    const f = fixture()
    await f.save(peakForm(f.rooms, ['', '1500', '3000']))
    const commonId = String((f.db.prepare("SELECT id FROM season_rates WHERE source = ?").get('wizard-common:' + key) as any).id)
    const ids = f.rooms.map((r) => String((f.db.prepare('SELECT id FROM season_rates WHERE room_id = ? AND source = ?').get(r, 'wizard-override:' + key) as any)?.id ?? ''))
    const html = await (await f.app.request(f.step, {}, f.env)).text()
    expect(html).toContain('Different charge for each room category')
    expect(html).toMatch(new RegExp(`name="r${f.rooms[2]}_managed_amt" value="3000"`))
    expect(html).toMatch(new RegExp(`name="r${f.rooms[1]}_managed_key" value="${key}"`))

    const again = peakForm(f.rooms, ['', ['', ids[1]], ['3500', ids[2]]])
    again.set('common_managed_id', commonId)
    await f.save(again)
    expect(await f.price(f.rooms[1], '2026-12-25')).toBe(6000 + 1000)
    expect(await f.price(f.rooms[2], '2026-12-25')).toBe(9000 + 3500)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM season_rates WHERE source = ?').get('wizard-override:' + key)).toMatchObject({ n: 1 })
  })

  it('moves the per-category hikes with the peak dates and removes them with the peak', async () => {
    const f = fixture()
    await f.save(peakForm(f.rooms, ['', '1500', '']))
    const commonId = String((f.db.prepare("SELECT id FROM season_rates WHERE source = ?").get('wizard-common:' + key) as any).id)
    const overrideId = String((f.db.prepare('SELECT id FROM season_rates WHERE source = ?').get('wizard-override:' + key) as any).id)
    const moved = peakForm(f.rooms, ['', ['1500', overrideId], ''])
    moved.set('common_managed_id', commonId); moved.set('common_managed_from', '2027-01-10'); moved.set('common_managed_to', '2027-01-12')
    await f.save(moved)
    expect(await f.price(f.rooms[1], '2027-01-11')).toBe(6000 + 1500)
    expect(await f.price(f.rooms[1], '2026-12-25')).toBe(6000)

    const removed = peakForm(f.rooms, ['', ['1500', overrideId], ''])
    removed.set('common_managed_id', commonId); removed.set('common_managed_remove', '1')
    await f.save(removed)
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM season_rates WHERE source LIKE 'wizard-%:' || ?").get(key)).toMatchObject({ n: 0 })
  })

  it('a blank new peak row saves nothing', async () => {
    const f = fixture()
    const b = new URLSearchParams({ common_managed_id: '', common_managed_key: '', common_managed_remove: '0', common_managed_from: '', common_managed_to: '', common_managed_amt: '', common_managed_desc: '' })
    for (const r of f.rooms) { b.append(`r${r}_managed_id`, ''); b.append(`r${r}_managed_key`, ''); b.append(`r${r}_managed_remove`, '0'); b.append(`r${r}_managed_amt`, '') }
    expect((await f.save(b)).headers.get('location')).not.toContain('err=')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM season_rates WHERE property_id = ?').get(f.id)).toMatchObject({ n: 0 })
  })
})
