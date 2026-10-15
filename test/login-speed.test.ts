// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createSession, loadUserById, logOutEverywhere, sessionMiddleware } from '../src/lib/auth'
import { assetUrl, assetVersion } from '../src/lib/assets'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const staff = db.prepare("SELECT id, role FROM users WHERE role IN ('sales','admin') LIMIT 1").get() as any
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } } } }; return st } }
  const kv = new Map<string, { v: string; ttl?: number }>()
  const KV = { async get(k: string, t?: string) { const e = kv.get(k); return e ? (t === 'json' ? JSON.parse(e.v) : e.v) : null }, async put(k: string, v: string, o?: { expirationTtl?: number }) { kv.set(k, { v, ttl: o?.expirationTtl }) }, async delete(k: string) { kv.delete(k) } }
  const env: any = { DB, KV, ENVIRONMENT: 'development' }
  const app = new Hono<any>()
  app.post('/login', async (c) => { await createSession(c, staff.id, staff.role); return c.text('ok') })
  app.get('/me', sessionMiddleware, (c) => c.text(c.get('user') ? 'in' : 'out'))
  const login = async () => (await app.request('http://localhost/login', { method: 'POST' }, env)).headers.get('set-cookie')!.split(';')[0]
  const me = async (cookie: string) => (await app.request('http://localhost/me', { headers: { cookie } }, env)).text()
  return { env, kv, staff, login, me }
}

describe('staff sessions', () => {
  it('keep staff logged in for 7 days', async () => {
    const f = fixture()
    await f.login()
    expect([...f.kv.values()][0].ttl).toBe(7 * 86400)
  })

  it('"Log out of all devices" ends every existing session but allows a fresh login', async () => {
    const f = fixture()
    const phone = await f.login(), laptop = await f.login()
    expect(await f.me(phone)).toBe('in')
    await logOutEverywhere(f.env, f.staff.id)
    expect(await f.me(phone)).toBe('out')
    expect(await f.me(laptop)).toBe('out')
    expect(await f.me(await f.login())).toBe('in')
  })

  it('accepts sessions created before session versions existed', async () => {
    const f = fixture()
    expect(await loadUserById(f.env, f.staff.id, 0)).toMatchObject({ id: f.staff.id })
    expect(await loadUserById(f.env, f.staff.id, 0)).not.toHaveProperty('session_version')
  })
})

describe('versioned assets', () => {
  it('puts the deploy version in the stylesheet/script URL only', () => {
    const v = assetVersion({ CF_VERSION_METADATA: { id: 'ab12cd34-0000-1111' } })
    expect(assetUrl(v, '/app.css')).toBe('/v/ab12cd340000/app.css')
    expect(assetUrl(v, '/brand/logo.webp')).toBe('/brand/logo.webp')
    expect(assetUrl(assetVersion({}), '/app.js')).toBe('/app.js')
  })
})
