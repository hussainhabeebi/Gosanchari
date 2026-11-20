// Full-app test fixture: every migration + seed on an in-memory SQLite D1 stand-in, in-memory KV and R2, and the
// real Worker app (CSRF, sessions, password login). Files using it must mock cloudflare:workers:
//   vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { app } from '../../src/index'
import { hashPassword } from '../../src/lib/auth'

export const ORIGIN = 'http://localhost'
type Body = Record<string, string | string[] | File>

export function appFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const DB: any = {
    prepare(sql: string) {
      let args: any[] = []
      const st = {
        bind(...v: any[]) { args = v; return st },
        async all() { return { results: db.prepare(sql).all(...args) } },
        async first(col?: string) { const row = db.prepare(sql).get(...args) as any; return row == null ? null : col ? row[col] : row },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } } },
      }
      return st
    },
    async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } },
  }
  const kv = new Map<string, string>()
  const media = new Map<string, { bytes: Uint8Array; type?: string }>()
  const jobs: any[] = []
  const env: any = {
    DB, ENVIRONMENT: 'development', SITE_URL: 'https://gosanchari.test',
    KV: { async get(k: string, t?: string) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v }, async put(k: string, v: string) { kv.set(k, v) }, async delete(k: string) { kv.delete(k) }, async list() { return { keys: [] } } },
    JOBS: { async send(m: any) { jobs.push(m) } },
    MEDIA: {
      async get(k: string) { const o = media.get(k); return o ? { body: new Blob([o.bytes]).stream(), httpEtag: '"x"', size: o.bytes.length, writeHttpMetadata(h: Headers) { if (o.type) h.set('content-type', o.type) } } : null },
      async put(k: string, v: any, opts?: any) { const bytes = new Uint8Array(await new Response(v).arrayBuffer()); media.set(k, { bytes, type: opts?.httpMetadata?.contentType }) },
      async delete(k: string | string[]) { for (const x of [k].flat()) media.delete(x) },
    },
    KB: { async put() {}, async get() { return null }, async delete() {} },
    ASSETS: { async fetch() { return new Response('') } },
  }
  const pending: Promise<unknown>[] = []
  const ctx: any = { waitUntil(p: Promise<unknown>) { pending.push(p) }, passThroughOnException() {} }
  const encode = (body: Body) => {
    if (Object.values(body).some((v) => v instanceof File)) {
      const fd = new FormData()
      for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) fd.append(k, x as string | File)
      return fd
    }
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) p.append(k, x as string)
    return p
  }
  const req = async (path: string, init: { method?: string; body?: Body; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (init.cookie) headers.cookie = init.cookie
    if (init.method === 'POST' && !('Origin' in headers)) headers.Origin = ORIGIN
    const r = await app.request(ORIGIN + path, { method: init.method ?? 'GET', headers, body: init.body ? encode(init.body) : undefined }, env, ctx)
    await Promise.all(pending.splice(0))
    return r
  }
  const login = async (email: string, password: string) => {
    const r = await req('/login/password', { method: 'POST', body: { email, password } })
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]
    return cookie.includes('=') && !cookie.endsWith('=') ? cookie : ''
  }
  const user = async (role: string, email: string, password = 'Passw0rd!') => {
    const id = Number(db.prepare('INSERT INTO users(role,name,email,password_hash) VALUES(?,?,?,?)').run(role, `${role} tester`, email, await hashPassword(password)).lastInsertRowid)
    return { id, cookie: await login(email, password) }
  }
  const setPerms = (perms: Record<string, unknown>) => { db.prepare("INSERT INTO settings(key,value) VALUES('role_permissions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(perms)); kv.delete('cache:settings:v1') }
  const msg = (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/\+/g, ' '))
  return { db, env, kv, media, jobs, req, login, user, setPerms, msg }
}

/** A real (tiny) PNG, so content sniffing accepts it. */
export function pngFile(name = 'photo.png') {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0))
  return new File([bytes], name, { type: 'image/png' })
}

/** Every JSON-LD block on a page. */
export function jsonLd(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json" id="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))
}
export const metaContent = (html: string, attr: string, key: string) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1]
