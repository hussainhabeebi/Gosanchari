// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { publicRoutes } from '../src/routes/public'

function fixture(categories: string[]) {
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

describe('public property detail UI', () => {
  it.each([
    [['unknown', 'room', 'facade', 'common', 'pool', 'view'], 'ui-photo-2.jpg'],
    [['room', 'common', 'pool'], 'ui-photo-1.jpg'],
  ])('uses exterior cover with the existing fallback: %j', async (categories, cover) => {
    const { db, property, env, app } = fixture(categories as string[])
    try {
      const before = JSON.stringify(['properties','rooms','property_photos','season_rates'].map(t => db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()))
      const response = await app.request('http://localhost/stay/' + property.slug, {}, env)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).not.toContain('class="journey-banner"')
      expect(html).not.toContain('Pause. Breathe. Stay.')
      const title = html.indexOf('<h1 class="property-title">' + property.name)
      const galleryStart = html.indexOf('class="gallery" data-gallery')
      expect(title).toBeGreaterThan(-1)
      expect(title).toBeGreaterThan(galleryStart)
      const gallery = html.slice(galleryStart, html.indexOf('class="prop-layout"', galleryStart))
      expect(gallery.match(/href="[^"]*ui-photo-\d\.jpg[^\"]*"/g)?.[0]).toContain(cover)
      for (let i = 0; i < categories.length; i++) expect(gallery.match(new RegExp('href="[^"]*ui-photo-' + i + '\\.jpg[^\"]*"', 'g'))).toHaveLength(1)
      expect(gallery).toContain('data-full')
      if (categories.length > 5) expect(gallery).toContain('href="#photos"')
      const summaryStart = html.indexOf('class="property-summary"')
      const aboutStart = html.indexOf('<h2>About this property</h2>')
      expect(summaryStart).toBeGreaterThan(title)
      expect(aboutStart).toBeGreaterThan(summaryStart)
      const summary = html.slice(summaryStart, aboutStart)
      expect(summary).toContain('📍')
      expect(summary).toContain('class="muted"')
      expect(summary).not.toContain('<nav')
      expect(summary).not.toContain('<form')
      expect(summary).not.toContain('media-tabs')
      for (const section of ['rooms', 'photos', 'rates', 'dining', 'facilities', 'policies', 'location', 'reviews']) {
        expect(summary).not.toContain('href="#' + section + '"')
      }
      expect(html).not.toContain('action="/saved/' + property.id + '"')
      expect(html).toContain('class="mobile-book-bar"')
      expect(html).toContain('action="/enquiry"')
      expect(html).toContain('data-price-url="/stay/' + property.slug + '/price"')
      expect(JSON.stringify(['properties','rooms','property_photos','season_rates'].map(t => db.prepare('SELECT * FROM ' + t + ' ORDER BY id').all()))).toBe(before)
    } finally { db.close() }
  })
})
