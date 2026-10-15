// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { propertyEditorRoutes } from '../src/routes/admin-properties'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('dup-test','Dup Test Resort','resort','Munnar','live')").run().lastInsertRowid)
  const room = (name: string) => Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate) VALUES(?,?,5000)').run(pid, name).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(s: any[]) { for (const x of s) await x.run(); return [] } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, MEDIA: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, KB: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const admin = new Hono<any>().use('*', async (c, next) => { c.set('user', user); await next() }).route('/', wizardRoutes).route('/', propertyEditorRoutes)
  const del = (id: number, body: Record<string, string> = {}) => admin.request(`http://localhost/admin/rooms/${id}/delete`, { method: 'POST', body: new URLSearchParams(body) }, env)
  const exists = (id: number) => !!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id)
  return { db, env, pid, room, admin, del, exists }
}

describe('delete room category', () => {
  it('removes an unused duplicate with its room photos and rates, keeping the other category', async () => {
    const f = fixture()
    const keep = f.room('Deluxe'), dup = f.room('Deluxe')
    const ph = Number(f.db.prepare("INSERT INTO property_photos(property_id,r2_key,category,room_id,sort,media_type) VALUES(?,?,'room',?,1,'image')").run(f.pid, 'dup.jpg', dup).lastInsertRowid)
    f.db.prepare('UPDATE properties SET thumbnail_photo_id = ? WHERE id = ?').run(ph, f.pid)
    f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate) VALUES(?,?,'Peak','2026-12-20','2027-01-05',9000)").run(f.pid, dup)
    const res = await f.del(dup)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain(`/admin/properties/${f.pid}`)
    expect(f.exists(dup)).toBe(false)
    expect(f.exists(keep)).toBe(true)
    expect(f.db.prepare('SELECT COUNT(*) n FROM property_photos WHERE id = ?').get(ph)).toEqual({ n: 0 })
    expect(f.db.prepare('SELECT COUNT(*) n FROM season_rates WHERE room_id = ?').get(dup)).toEqual({ n: 0 })
    expect((f.db.prepare('SELECT thumbnail_photo_id t FROM properties WHERE id = ?').get(f.pid) as any).t).toBeNull()
  })

  it('returns to the wizard when deleted from the Room Categories step', async () => {
    const f = fixture()
    const dup = f.room('Deluxe')
    const res = await f.del(dup, { back: 'wizard', rb0_name: 'Deluxe' })
    expect(res.headers.get('location')).toContain(`/admin/properties/${f.pid}/setup/2`)
    expect(f.exists(dup)).toBe(false)
  })

  it('refuses when the category is used by a quotation, directly or as a combined room', async () => {
    const f = fixture()
    const main = f.room('Deluxe'), extra = f.room('Suite')
    const qid = Number(f.db.prepare("INSERT INTO quotations(code,token,guest_name) VALUES('Q-DEL-1','tok-del-1','Test')").run().lastInsertRowid)
    f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,extra_rooms) VALUES(?,?,?,'2026-12-01','2026-12-03',?)").run(qid, f.pid, main, JSON.stringify([{ room_id: extra, rooms_count: 1, guest_rate: null }]))
    for (const id of [main, extra]) {
      const res = await f.del(id)
      expect(res.status).toBe(303)
      expect(f.exists(id)).toBe(true)
    }
  })
})
