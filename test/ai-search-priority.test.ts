// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'

function fixture(categories: string[] = []) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const property = db.prepare('SELECT id,slug,name FROM properties WHERE status=\'live\' ORDER BY id LIMIT 1').get() as { id: number; slug: string; name: string }
  db.prepare('DELETE FROM property_photos WHERE property_id=?').run(property.id)
  categories.forEach((category, index) => db.prepare('INSERT INTO property_photos(property_id,r2_key,category,sort) VALUES (?,?,?,?)').run(property.id, `ui-photo-${index}.jpg`, category, index))
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const statement = { bind(...v: any[]) { values = v; return statement }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
    return statement
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  return { db, property, env, app: new Hono().route('/', publicRoutes) }
}

describe('public AI discovery', () => {
  it('puts working AI search and insights before popular stays', async () => {
    const { db, env, app } = fixture()
    try {
      db.exec("UPDATE properties SET review_summary='Quiet surroundings and welcoming hosts',rating_count=5 WHERE status='live'")
      const response = await app.request('http://localhost/', {}, env)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html.indexOf('id="ai-search"')).toBeLessThan(html.indexOf('class="manual-search"'))
      expect(html.indexOf('id="ai-insights"')).toBeLessThan(html.indexOf('popular-stays'))
      expect(html).toContain('name="ai"')
      expect(html).toContain('Quiet surroundings and welcoming hosts')
      expect(html).toContain('AI-generated summaries of guest reviews')
    } finally { db.close() }
  })
  it('redirects a natural language search with filters and without a second AI query', async () => {
    const { db, env, app } = fixture()
    try {
      const query = 'Munnar for 2 with a pool'
      const response = await app.request('http://localhost/search?ai=' + encodeURIComponent(query), {}, env)
      expect(response.status).toBe(302)
      const target = new URL(response.headers.get('location')!, 'http://localhost')
      expect(target.searchParams.get('destination')).toBe('Munnar')
      expect(target.searchParams.getAll('facility')).toContain('pool')
      expect(target.searchParams.get('understood')).toBe(query)
      expect(target.searchParams.has('ai')).toBe(false)
    } finally { db.close() }
  })
})
