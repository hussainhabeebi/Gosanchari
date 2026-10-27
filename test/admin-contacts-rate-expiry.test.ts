// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('Resort contacts export and email', () => {
  afterEach(() => vi.unstubAllGlobals())
  const withContacts = (f: ReturnType<typeof fixture>) => {
    f.db.prepare('UPDATE properties SET contact = ? WHERE id = 3').run(JSON.stringify({ person: 'Abdul Salam', phone: '98470 00003', email: 'stay@greencanopy.example', email2: 'not-an-email' }))
    f.db.prepare('UPDATE properties SET contact = ? WHERE id = 1').run(JSON.stringify({ person: '=HYPERLINK("x")', email: 'tea@misty.example' }))
  }

  it('exports the shown resorts to CSV with names, emails and numbers', async () => {
    const f = fixture()
    withContacts(f)
    const res = await f.app.request('http://localhost/admin/contacts/export.csv?location=Wayanad', {}, f.env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="resort-contacts-/)
    const csv = await res.text()
    expect(csv.split('\r\n')[0]).toBe('Resort,Location,Stay type,Status,Contact person,Email,Email 2,Phone,Phone 2,Phone 3,More contacts,Address')
    expect(csv).toContain('Green Canopy Homestay,Wayanad')
    expect(csv).toContain('Abdul Salam,stay@greencanopy.example')
    expect(csv).not.toContain('Misty Tea')
    const all = await (await f.app.request('http://localhost/admin/contacts/export.csv', {}, f.env)).text()
    expect(all).toContain(`"'=HYPERLINK(""x"")"`) // formula injection neutralised
  })

  it('shows export and email actions, and only lets resorts with an email be picked', async () => {
    const f = fixture()
    withContacts(f)
    const html = await (await f.app.request('http://localhost/admin/contacts', {}, f.env)).text()
    expect(html).toContain('href="/admin/contacts/export.csv"')
    expect(html).toContain('href="/admin/contacts/email?ids=3"')
    expect(html).toMatch(/name="ids" value="3" form="contact-email"/)
    expect(html).not.toMatch(/name="ids" value="2" form="contact-email"/)
  })

  it('composes for the selected resorts and sends one personalised email per resort', async () => {
    const f = fixture()
    withContacts(f)
    const compose = await (await f.app.request('http://localhost/admin/contacts/email?ids=3&ids=1', {}, f.env)).text()
    expect(compose).toContain('Green Canopy Homestay')
    expect(compose).toContain('stay@greencanopy.example')
    expect(compose).not.toContain('not-an-email')

    const sent: any[] = []
    f.env.KV.get = async (k: string) => (k === 'secret:resend_api_key' ? 're_test_key' : null)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })
    }))
    const body = new URLSearchParams([['ids', '3'], ['ids', '1'], ['subject', 'Rates for {resort}'], ['message', 'Dear {person},\n<b>Hello</b> {location}'], ['action', 'send']])
    const res = await f.app.request('http://localhost/admin/contacts/email', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, f.env)
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get('location')!, 'http://x').searchParams.get('ok')).toBe('Email sent to 2 resorts.')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://api.resend.com/emails/batch')
    expect(sent[0].auth).toBe('Bearer re_test_key')
    const green = sent[0].body.find((e: any) => e.to[0] === 'stay@greencanopy.example')
    expect(green.to).toEqual(['stay@greencanopy.example'])
    expect(green.subject).toBe('Rates for Green Canopy Homestay')
    expect(green.text).toBe('Dear Abdul Salam,\n<b>Hello</b> Wayanad')
    expect(green.html).toContain('Dear Abdul Salam,<br>&lt;b&gt;Hello&lt;/b&gt; Wayanad')
  })

  it('is closed to sales staff', async () => {
    const f = fixture('sales')
    expect((await f.app.request('http://localhost/admin/contacts/export.csv', {}, f.env)).status).toBe(403)
    expect((await f.app.request('http://localhost/admin/contacts/email?ids=1', {}, f.env)).status).toBe(403)
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
