// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { contactRoutes } from '../src/routes/admin-contacts'
import { adminRoutes } from '../src/routes/admin'
import { expiringRates, expiryText, rateExpiryAlerts, rateExpiryReminder } from '../src/lib/rate-expiry'

function fixture(role = 'admin') {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  db.exec('DELETE FROM season_rates')
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const statement = {
      bind(...v: any[]) { values = v; return statement },
      async all() { return { results: db.prepare(sql).all(...values) } },
      async first() { return db.prepare(sql).get(...values) ?? null },
      async run() { db.prepare(sql).run(...values); return { meta: {} } },
    }
    return statement
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', { id: 1, name: 'Test', role, language: 'en' }); await next() }).route('/', contactRoutes).route('/', adminRoutes)
  return { db, env, app }
}

const season = (db: any, pid: number | null, name: string, kind: string, start: string, end: string) =>
  db.prepare('INSERT INTO season_rates (property_id, name, kind, start_date, end_date, rate) VALUES (?, ?, ?, ?, ?, 5000)').run(pid, name, kind, start, end)

describe('Resort contacts (admin only)', () => {
  it('lists contact details and filters by location and resort name', async () => {
    const f = fixture()
    f.db.prepare("UPDATE properties SET contact = ? WHERE id = 3").run(JSON.stringify({ person: 'Abdul Salam', phone: '98470 00003', email: 'stay@greencanopy.example', others: 'Ravi – manager – 9847011111' }))
    const res = await f.app.request('http://localhost/admin/contacts?location=Wayanad&q=green', {}, f.env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Green Canopy Homestay')
    expect(html).toContain('href="tel:9847000003"')
    expect(html).toContain('https://wa.me/919847000003')
    expect(html).toContain('mailto:stay@greencanopy.example')
    expect(html).toContain('href="tel:9847011111"')
    // Non-matching resorts stay in the page for instant filtering, but hidden.
    expect(html).toMatch(/data-location="Munnar"[^>]*hidden/)
    expect(html).toContain('1 of ')
  })

  it('matches a phone number typed with different spacing', async () => {
    const f = fixture()
    const html = await (await f.app.request('http://localhost/admin/contacts?q=%2B91-98470-00001', {}, f.env)).text()
    expect(html).toContain('1 of ')
    expect(html).toMatch(/<article[^>]*data-search="[^"]*misty tea[^"]*"(?![^>]*hidden)/)
  })

  it('is closed to sales and manager staff', async () => {
    for (const role of ['sales', 'manager']) {
      const f = fixture(role)
      expect((await f.app.request('http://localhost/admin/contacts', {}, f.env)).status).toBe(403)
    }
  })
})

describe('Season rate expiry reminders', () => {
  it('flags ending periods until a newer period of the same type is added', async () => {
    const f = fixture()
    season(f.db, 1, 'Off season 2026', 'off_season', '2026-04-01', '2026-10-15')
    season(f.db, 2, 'Season 2026', 'season', '2026-10-01', '2026-10-20')
    season(f.db, 2, 'Season 2027', 'season', '2026-10-21', '2027-03-31') // already renewed
    season(f.db, 3, 'Season far away', 'season', '2026-10-01', '2027-01-31') // outside the 30-day window
    const rows = await rateExpiryAlerts(f.env, '2026-10-08')
    expect(rows.map((r) => r.name)).toEqual(['Off season 2026'])
    expect(expiryText('2026-10-15', '2026-10-08')).toBe('ends in 7 days')
    expect(expiryText('2026-10-07', '2026-10-08')).toBe('ended 1 day ago')

    season(f.db, 1, 'Off season 2027', 'off_season', '2027-04-01', '2027-09-30')
    expect(await rateExpiryAlerts(f.env, '2026-10-08')).toEqual([])
  })

  it('needs the same name to renew a special / holiday period', async () => {
    const f = fixture()
    season(f.db, 1, 'Diwali', 'special', '2026-10-18', '2026-10-21')
    season(f.db, 1, 'Christmas', 'special', '2026-12-20', '2026-12-31')
    expect((await expiringRates(f.env, '2026-10-01', '2026-10-31')).map((r) => r.name)).toEqual(['Diwali'])
  })

  it('sends the WhatsApp reminder 30 days, 7 days and on the last day only', async () => {
    const f = fixture()
    season(f.db, 1, 'Off season 2026', 'off_season', '2026-04-01', '2026-10-15')
    expect(await rateExpiryReminder(f.env, '2026-10-08')).toContain('Misty Tea Bungalow (Munnar): Off season 2026 — ends in 7 days')
    expect(await rateExpiryReminder(f.env, '2026-10-15')).toContain('ends today')
    expect(await rateExpiryReminder(f.env, '2026-10-09')).toBeNull()
  })

  it('shows the Expiring rates page and lets the admin mark a period handled', async () => {
    const f = fixture()
    const end = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10)
    season(f.db, 1, 'Monsoon offer', 'off_season', '2026-06-01', end)
    const html = await (await f.app.request('http://localhost/admin/rates/expiring', {}, f.env)).text()
    expect(html).toContain('Monsoon offer')
    expect(html).toContain('/admin/properties/1/setup/3')

    const body = new URLSearchParams({ property_id: '1', name: 'Monsoon offer', kind: 'off_season', end_date: end })
    const res = await f.app.request('http://localhost/admin/rates/expiring/dismiss', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, f.env)
    expect(res.status).toBe(303)
    expect(await rateExpiryAlerts(f.env)).toEqual([])
  })
})
