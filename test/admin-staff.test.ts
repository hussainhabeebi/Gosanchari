// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { describe, expect, it } from 'vitest'
import { admin2Routes } from '../src/routes/admin2'
import { authRoutes } from '../src/routes/auth'
import { hashPassword, loadUserById, sessionMiddleware, verifyPassword } from '../src/lib/auth'
import { sha256Hex } from '../src/lib/util'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const admin = Number(db.prepare("INSERT INTO users(name,email,role) VALUES('Admin','staff-test-admin@example.test','admin')").run().lastInsertRowid)
  const staff = Number(db.prepare("INSERT INTO users(name,email,phone,role) VALUES('Test staff','staff-test@example.test','+919876543210','sales')").run().lastInsertRowid)
  db.prepare('INSERT INTO staff_destinations(user_id,destination) VALUES(?,?)').run(staff, 'Munnar')
  const DB: any = { prepare(sql: string) {
    let args: any[] = []
    const stmt = { bind(...v: any[]) { args = v; return stmt }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } } } }
    return stmt
  }, async batch(stmts: any[]) { db.exec('BEGIN'); try { const out = []; for (const st of stmts) out.push(await st.run()); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e } } }
  const kv = new Map<string, string>()
  const env: any = { DB, KV: { async get(k: string, type?: string) { const v = kv.get(k); return v ? type === 'json' ? JSON.parse(v) : v : null }, async put(k: string, v: string) { kv.set(k, v) }, async delete(k: string) { kv.delete(k) } }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  let identity: any = { id: admin, role: 'admin', name: 'Admin', language: 'en' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', identity); await next() }).use('*', csrf()).route('/', admin2Routes)
  const read = () => db.prepare('SELECT * FROM users WHERE id=?').get(staff) as any
  const values = () => new URLSearchParams({ name: 'Edited staff', phone: '+919876543210', email: 'staff-test@example.test', role: 'sales', active: '1', destinations: 'Munnar' })
  const post = (path: string, body = values()) => app.request('http://localhost' + path, { method: 'POST', headers: { Origin: 'http://localhost' }, body }, env)
  const save = (body = values()) => post('/admin/staff/' + staff, body)
  const del = (id = staff) => post('/admin/staff/' + id + '/delete', new URLSearchParams())
  return { db, env, app, kv, admin, staff, read, values, save, del, post, as(user: any) { identity = user } }
}
const message = (r: Response) => decodeURIComponent(r.headers.get('location')!.replaceAll('+', ' '))

describe('Admin staff editing and safe deactivation', () => {
  it('shows named confirmation actions and prefilled accessible edit fields', async () => {
    const f = fixture(); try {
      const list = await (await f.app.request('http://localhost/admin/staff', {}, f.env)).text()
      expect(list).toContain(`/admin/staff/${f.staff}/edit`)
      expect(list).toContain('data-confirm="Delete Test staff (staff-test@example.test)?')
      expect(list).toContain('>Delete</button>')
      const edit = await (await f.app.request(`http://localhost/admin/staff/${f.staff}/edit`, {}, f.env)).text()
      for (const value of ['Test staff', '+919876543210', 'staff-test@example.test', 'Save Changes', 'Cancel', 'Assigned destinations']) expect(edit).toContain(value)
      expect(edit).toContain('value="Munnar" selected')
      expect(edit).toContain('value="sales" selected')
      expect(edit).toContain('name="password" type="password"')
      expect(edit).not.toContain('password_hash')
    } finally { f.db.close() }
  })
  it('saves all editable details, assignments and active status; reopening restores them', async () => {
    const f = fixture(); try {
      const b = f.values(); b.set('name', 'New name'); b.set('phone', '9876543211'); b.set('email', 'NEW@example.test'); b.set('role', 'manager'); b.delete('active'); b.append('destinations', 'Wayanad')
      expect(message(await f.save(b))).toContain('Staff changes saved.')
      expect(f.read()).toMatchObject({ name: 'New name', phone: '+919876543211', email: 'new@example.test', role: 'manager', active: 0 })
      const edit = await (await f.app.request(`http://localhost/admin/staff/${f.staff}/edit`, {}, f.env)).text()
      expect(edit).toContain('value="New name"'); expect(edit).toContain('value="Wayanad" selected')
      const audit: any = f.db.prepare("SELECT * FROM activity_log WHERE action='staff.updated'").get()
      expect(audit.user_id).toBe(f.admin); expect(audit.created_at).toBeTruthy()
    } finally { f.db.close() }
  })
  it('preserves a password when blank and securely resets it when supplied', async () => {
    const f = fixture(); try {
      const original = await hashPassword('original-password')
      f.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(original, f.staff)
      await f.save(); expect(f.read().password_hash).toBe(original)
      const b = f.values(); b.set('password', 'replacement-password'); await f.save(b)
      expect(await verifyPassword('replacement-password', f.read().password_hash)).toBe(true)
      expect(await verifyPassword('original-password', f.read().password_hash)).toBe(false)
      expect(JSON.stringify(f.db.prepare('SELECT details FROM activity_log').all())).not.toContain('replacement-password')
    } finally { f.db.close() }
  })
  it('rejects contact conflicts including case-insensitive emails without changing the account', async () => {
    const f = fixture(); try {
      f.db.prepare("INSERT INTO users(name,email,phone) VALUES('Guest','TAKEN@example.test','+919876543212')").run()
      const before = JSON.stringify(f.read())
      for (const [key, value] of [['email', 'taken@example.test'], ['phone', '9876543212']]) {
        const b = f.values(); b.set(key, value); expect(message(await f.save(b))).toContain('belongs to another account')
        expect(JSON.stringify(f.read())).toBe(before)
      }
    } finally { f.db.close() }
  })
  it('rejects malformed names, contacts, roles, passwords and destinations', async () => {
    const f = fixture(); try {
      const before = JSON.stringify(f.read())
      for (const [key, value] of [['name', ' '], ['email', 'invalid'], ['phone', '123'], ['role', 'guest'], ['password', 'short'], ['destinations', 'invented destination']]) {
        const b = f.values(); b.set(key, value); const r = await f.save(b)
        expect(r.headers.get('location')).toContain('err='); expect(JSON.stringify(f.read())).toBe(before)
      }
    } finally { f.db.close() }
  })
  it('soft deletes once, preserving assignments, quotation ownership, approvals and audit history', async () => {
    const f = fixture(); try {
      f.db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,valid_till) VALUES('STAFF-HISTORY','staff-history-token',?,'Guest','2030-01-01')").run(f.staff)
      // Snapshot every business table, excluding accounts and the new audit event.
      const tables = (f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('users','activity_log','sqlite_sequence')").all() as any[]).map(r => r.name)
      const snapshot = () => JSON.stringify(tables.map(t => [t, f.db.prepare(`SELECT * FROM "${t}"`).all()]))
      const before = snapshot()
      expect(message(await f.del())).toContain('Staff member deactivated')
      expect(f.read().active).toBe(0); expect(snapshot()).toBe(before)
      expect(await loadUserById(f.env, f.staff)).toBeNull()
      await f.del()
      const audit = f.db.prepare("SELECT * FROM activity_log WHERE action='staff.deactivated'").all() as any[]
      expect(audit).toHaveLength(1); expect(audit[0].user_id).toBe(f.admin); expect(audit[0].created_at).toBeTruthy()
    } finally { f.db.close() }
  })
  it('blocks existing sessions and email-password login after deactivation', async () => {
    const f = fixture(); try {
      f.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('existing-password'), f.staff)
      f.kv.set('sess:' + await sha256Hex('existing-session'), JSON.stringify({ userId: f.staff }))
      await f.del()
      const sessionApp = new Hono<any>().use('*', sessionMiddleware).get('/', c => c.json(c.get('user')))
      expect(await (await sessionApp.request('http://localhost/', { headers: { Cookie: 'gs_session=existing-session' } }, f.env)).json()).toBeNull()
      const loginApp = new Hono<any>().route('/', authRoutes)
      const response = await loginApp.request('http://localhost/login/password', { method: 'POST', body: new URLSearchParams({ email: 'staff-test@example.test', password: 'existing-password' }) }, f.env)
      expect(message(response)).toContain('incorrect')
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally { f.db.close() }
  })
  it('forbids non-Admins even if their configurable manage_staff permission is enabled', async () => {
    const f = fixture(); try {
      f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('role_permissions',?)").run(JSON.stringify({ manager: { manage_staff: true } }))
      f.as({ id: f.staff, role: 'manager', name: 'Manager' })
      expect((await f.save()).status).toBe(403); expect((await f.del()).status).toBe(403)
      expect((await f.app.request(`http://localhost/admin/staff/${f.staff}/edit`, {}, f.env)).status).toBe(403)
      expect(f.read().active).toBe(1)
      f.as(null); expect((await f.del()).headers.get('location')).toContain('/login')
    } finally { f.db.close() }
  })
  it('protects the current Admin, the last active Admin and guest accounts', async () => {
    const f = fixture(); try {
      expect(message(await f.del(f.admin))).toContain("can't delete your own Admin")
      const b = f.values(); b.set('role', 'sales')
      expect(message(await f.post('/admin/staff/' + f.admin, b))).toContain("can't remove your own admin")
      f.db.exec("UPDATE users SET active=0 WHERE role='admin'")
      f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.staff)
      expect(message(await f.del())).toContain('last active Admin')
      expect(message(await f.save())).toContain('last active Admin')
      expect(f.read().active).toBe(1)
      const guest = Number(f.db.prepare("INSERT INTO users(name,role) VALUES('Guest only','guest')").run().lastInsertRowid)
      expect((await f.del(guest)).status).toBe(404)
      expect((await f.del(999999)).status).toBe(404)
    } finally { f.db.close() }
  })
  it('blocks phone-code login for inactive staff without creating a replacement account', async () => {
    const f = fixture(); try {
      await f.del()
      f.kv.set('otp:+919876543210', JSON.stringify({ hash: await sha256Hex('123456+919876543210'), tries: 0 }))
      const count = (f.db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n
      const loginApp = new Hono<any>().route('/', authRoutes)
      const r = await loginApp.request('http://localhost/login/otp/verify', { method: 'POST', body: new URLSearchParams({ phone: '9876543210', code: '123456' }) }, f.env)
      expect(message(r)).toContain('not active')
      expect(r.headers.get('set-cookie')).toBeNull()
      expect((f.db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n).toBe(count)
    } finally { f.db.close() }
  })
  it('rolls back account edits and assignments if any transactional write fails', async () => {
    const f = fixture(); try {
      const before = JSON.stringify(f.read())
      f.db.exec("CREATE TRIGGER fail_staff_audit BEFORE INSERT ON activity_log WHEN NEW.action='staff.updated' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END")
      expect((await f.save()).status).toBe(500)
      expect(JSON.stringify(f.read())).toBe(before)
      expect(f.db.prepare('SELECT destination FROM staff_destinations WHERE user_id=?').all(f.staff)).toEqual([{ destination: 'Munnar' }])
      expect(f.db.prepare("SELECT * FROM activity_log WHERE action='staff.updated'").all()).toHaveLength(0)
    } finally { f.db.close() }
  })
  it('guards a concurrent last-Admin change without changing assignments or recording a false edit', async () => {
    const f = fixture(); try {
      f.db.exec("UPDATE users SET active=0 WHERE role='admin'")
      f.db.prepare('UPDATE users SET active=1 WHERE id=?').run(f.admin)
      f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.staff)
      const batch = f.env.DB.batch
      f.env.DB.batch = async (stmts: any[]) => {
        f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.admin)
        return batch(stmts)
      }
      const b = f.values(); b.set('destinations', 'Wayanad')
      expect(message(await f.save(b))).toContain('last active Admin')
      expect(f.read().role).toBe('admin'); expect(f.read().active).toBe(1)
      expect(f.db.prepare('SELECT destination FROM staff_destinations WHERE user_id=?').all(f.staff)).toEqual([{ destination: 'Munnar' }])
      expect(f.db.prepare("SELECT * FROM activity_log WHERE action='staff.updated'").all()).toHaveLength(0)
    } finally { f.db.close() }
  })
  it('can reactivate staff and clear destinations without touching role permission definitions', async () => {
    const f = fixture(); try {
      await f.del()
      const b = f.values(); b.delete('destinations'); b.set('role', 'accounts')
      expect(message(await f.save(b))).toContain('Staff changes saved')
      expect(f.read().active).toBe(1)
      expect((await loadUserById(f.env, f.staff))?.role).toBe('accounts')
      expect(f.db.prepare('SELECT * FROM staff_destinations WHERE user_id=?').all(f.staff)).toHaveLength(0)
    } finally { f.db.close() }
  })
  it('keeps role permissions intact and rejects cross-origin writes', async () => {
    const f = fixture(); try {
      const settings = JSON.stringify(f.db.prepare('SELECT * FROM settings').all())
      const response = await f.app.request(`http://localhost/admin/staff/${f.staff}/delete`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }, f.env)
      expect(response.status).toBe(403); expect(f.read().active).toBe(1)
      await f.save(); expect(JSON.stringify(f.db.prepare('SELECT * FROM settings').all())).toBe(settings)
    } finally { f.db.close() }
  })
})
