import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkImportUrl, fetchImage, htmlToText, parsePage, pickSubpages, readWebsite } from '../src/lib/webimport'
import { fieldsPrompt, fieldsSchema, normalizeExtract, roomsPrompt, roomsSchema } from '../src/lib/propextract'
import { geminiGenerate } from '../src/lib/gemini'

describe('website link safety', () => {
  it('accepts public resort sites and adds https', () => {
    const r = checkImportUrl('mistyhills.in/rooms#top')
    expect(r.ok && r.url.toString()).toBe('https://mistyhills.in/rooms')
  })

  it.each([
    'http://localhost/admin', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'http://intranet/', 'http://printer.local/', 'ftp://mistyhills.in/', 'file:///etc/passwd', 'https://user:pw@mistyhills.in/',
    'https://mistyhills.in:8080/', 'http://2130706433/', 'https://8.8.8.8/',
  ])('refuses %s', (u) => {
    expect(checkImportUrl(u).ok).toBe(false)
  })

  it('refuses booking sites with a helpful message', () => {
    const r = checkImportUrl('https://www.booking.com/hotel/in/misty-hills.html')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/resort’s own website/)
    expect(checkImportUrl('https://www.makemytrip.com/hotels/x').ok).toBe(false)
  })
})

const HOME = `<!doctype html><html><head><title>Misty Hills Resort, Munnar</title>
<meta name="description" content="Boutique resort &amp; spa in Chithirapuram">
<meta property="og:image" content="/img/hero.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"Resort","name":"Misty Hills","geo":{"@type":"GeoCoordinates","latitude":10.08,"longitude":77.05},"checkinTime":"14:00"}]}</script>
<script type="application/ld+json">{broken</script>
<style>.x{color:red}</style><script>var tracking = 1</script></head>
<body><nav><a href="/rooms-tariff/">Rooms &amp; Tariff</a> <a href="/contact">Contact us</a> <a href="https://facebook.com/misty">FB</a> <a href="/blog/monsoon">Blog</a> <a href="/brochure.pdf">Brochure</a></nav>
<h1>Welcome</h1><p>Infinity pool facing tea hills.<br>Free Wi&#8209;Fi.</p>
<table><tr><td>Deluxe</td><td>₹4,500</td></tr></table>
<img src="/img/logo.png" width="120"><img src="/img/tiny.jpg" width="40" height="40">
<img data-src="/img/pool.jpg" src="data:image/gif;base64,R0lGOD"><img srcset="/img/room-600.webp 600w, /img/room-1200.webp 1200w">
<a href="tel:+91 98470 12345">Call</a> <a href="mailto:stay@mistyhills.in?subject=hi">Mail</a>
</body></html>`

describe('reading a resort page', () => {
  const base = new URL('https://mistyhills.in/')
  const facts = parsePage(HOME, base)

  it('keeps visible text, drops scripts and styles', () => {
    expect(facts.title).toBe('Misty Hills Resort, Munnar')
    expect(facts.text).toContain('Infinity pool facing tea hills.')
    expect(facts.text).toContain('Deluxe | ₹4,500')
    expect(facts.text).not.toContain('tracking')
    expect(facts.text).not.toContain('color:red')
    expect(htmlToText('<p>A&nbsp;&amp;&nbsp;B</p>')).toBe('A & B')
  })

  it('keeps lodging JSON-LD, meta, phones and emails', () => {
    expect(facts.meta.description).toBe('Boutique resort & spa in Chithirapuram')
    expect(facts.jsonLd).toHaveLength(1)
    expect(facts.jsonLd[0]).toMatchObject({ '@type': 'Resort', name: 'Misty Hills' })
    expect(facts.phones).toEqual(['+919847012345'])
    expect(facts.emails).toEqual(['stay@mistyhills.in'])
  })

  it('lists gallery images, skipping logos, tiny images and data URLs', () => {
    expect(facts.images).toEqual([
      'https://mistyhills.in/img/hero.jpg',
      'https://mistyhills.in/img/pool.jpg',
      'https://mistyhills.in/img/room-1200.webp',
    ])
  })

  it('picks useful same-site subpages, rooms first', () => {
    expect(pickSubpages(facts.links, base)).toEqual(['https://mistyhills.in/rooms-tariff', 'https://mistyhills.in/contact'])
  })
})

const res = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

describe('readWebsite', () => {
  it('reads home + subpages into labelled notes', async () => {
    const pages: Record<string, string> = {
      'https://mistyhills.in/': HOME,
      'https://mistyhills.in/rooms-tariff': '<h2>Family Suite</h2><p>Sleeps 4. ₹7,000 per night.</p>',
      'https://mistyhills.in/contact': '<p>Chithirapuram, Munnar 685565</p>',
    }
    const fetcher = vi.fn(async (u: RequestInfo | URL) => res(pages[String(u)] ?? 'missing', { status: pages[String(u)] ? 200 : 404 })) as unknown as typeof fetch
    const r = await readWebsite('mistyhills.in', fetcher)
    if ('error' in r) throw new Error(r.error)
    expect(r.pages).toEqual(['https://mistyhills.in/', 'https://mistyhills.in/rooms-tariff', 'https://mistyhills.in/contact'])
    expect(r.notes).toContain('Structured data published by the website')
    expect(r.notes).toContain('"latitude":10.08')
    expect(r.notes).toContain('Contact links on the website: +919847012345, stay@mistyhills.in')
    expect(r.notes).toContain('--- Page: https://mistyhills.in/rooms-tariff ---\nFamily Suite')
    expect(r.images.length).toBe(3)
  })

  it('re-checks every redirect hop (no bouncing to private addresses)', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })) as unknown as typeof fetch
    const r = await readWebsite('https://mistyhills.in/', fetcher)
    expect(r).toEqual({ error: 'Only public websites can be read.' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refuses pages over 2 MB and non-HTML links', async () => {
    const big = vi.fn(async () => res('x', { headers: { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) } })) as unknown as typeof fetch
    expect(await readWebsite('https://mistyhills.in/', big)).toEqual({ error: 'The page is too large to read.' })
    const pdf = vi.fn(async () => res('%PDF', { headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch
    expect(await readWebsite('https://mistyhills.in/b.pdf', pdf)).toMatchObject({ error: expect.stringMatching(/attach it as a file/) })
  })

  it('downloads only real images', async () => {
    const jpg = vi.fn(async () => new Response(new Uint8Array(20 * 1024), { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch
    expect(await fetchImage('https://cdn.mistyhills.in/pool.jpg', jpg)).toMatchObject({ type: 'image/jpeg' })
    const html = vi.fn(async () => res('<html>')) as unknown as typeof fetch
    expect(await fetchImage('https://cdn.mistyhills.in/pool.jpg', html)).toMatchObject({ error: expect.stringMatching(/not a JPG/) })
    expect(await fetchImage('http://127.0.0.1/a.jpg', jpg)).toMatchObject({ error: expect.any(String) })
  })
})

describe('combined sources in quick fill', () => {
  it('asks for sources only when there are several', () => {
    expect(fieldsPrompt('x')).not.toContain('_src')
    expect(fieldsPrompt('x', ['notes', 'website'])).toContain('"_src"')
    expect(roomsPrompt('x', '2026-11-04', ['file', 'website'])).toContain('"src"')
  })

  it('keeps where each field came from, and room / season sources', () => {
    const r = normalizeExtract({
      fields: { name: 'Misty Hills', destination: 'Munnar', _src: { name: 'website', destination: 'notes', star_category: 'file', bogus: 'website' } },
      rooms: [{ name: 'Deluxe', base_rate: 4500, src: 'website' }, { name: 'Suite', src: 'nonsense' }],
      seasons: [{ name: 'Xmas', start_date: '2026-12-20', end_date: '2027-01-05', rates: [{ room: 'Deluxe', rate: 7500 }], src: 'file' }],
    })
    expect(r.sources).toEqual({ name: 'website', destination: 'notes' })
    expect(r.rooms[0].src).toBe('website')
    expect(r.rooms[1].src).toBeUndefined()
    expect(r.seasons[0]).toMatchObject({ rates: { Deluxe: 7500 }, src: 'file' })
  })

  it('marks everything with the only source', () => {
    const r = normalizeExtract({ fields: { name: 'A' }, rooms: [{ name: 'R' }], seasons: [] }, 'website')
    expect(r.sources).toEqual({ name: 'website' })
    expect(r.rooms[0].src).toBe('website')
  })

  it('never fills bank details', () => {
    expect(fieldsPrompt('x')).not.toContain('con_bank_details')
    expect(normalizeExtract({ fields: { con_bank_details: 'SBI 1234' } }).fields.con_bank_details).toBeUndefined()
  })

  it('builds Gemini schemas from the field list', () => {
    const f = fieldsSchema() as { properties: Record<string, { type: string; enum?: string[]; items?: { enum?: string[] } }> }
    expect(f.properties.name).toEqual({ type: 'STRING' })
    expect(f.properties.pet_friendly).toEqual({ type: 'BOOLEAN' })
    expect(f.properties.type.enum).toContain('resort')
    expect(f.properties.facilities.items?.enum).toContain('pool')
    expect(f.properties._src).toBeUndefined()
    expect((fieldsSchema(['notes', 'website']) as { properties: Record<string, unknown> }).properties._src).toBeDefined()
    const r = roomsSchema(['file', 'website']) as { properties: { rooms: { items: { properties: Record<string, unknown> } } } }
    expect(r.properties.rooms.items.properties.src).toEqual({ type: 'STRING', enum: ['file', 'website'] })
  })
})

describe('Gemini request options', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })

  it('sends the schema, and retries without it when Gemini rejects it', async () => {
    const bodies: Record<string, unknown>[] = []
    const fake = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return bodies.length === 1 ? new Response('schema too complex', { status: 400 }) : ok('{"a":1}')
    })
    vi.stubGlobal('fetch', fake)
    const out = await geminiGenerate('k', 'gemini-2.5-flash', { messages: [{ role: 'user', content: 'hi' }], json: true, schema: { type: 'OBJECT' } })
    expect(out).toBe('{"a":1}')
    expect((bodies[0].generationConfig as Record<string, unknown>).responseSchema).toEqual({ type: 'OBJECT' })
    expect((bodies[1].generationConfig as Record<string, unknown>).responseSchema).toBeUndefined()
    expect((bodies[1].generationConfig as Record<string, unknown>).responseMimeType).toBe('application/json')
  })

  it('URL context turns on the tool and off JSON mode; Pro gets a thinking budget', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return ok('notes') }))
    await geminiGenerate('k', 'gemini-2.5-pro', { messages: [{ role: 'user', content: 'read https://x.in' }], json: true, urlContext: true, maxTokens: 1000 })
    const gc = body.generationConfig as Record<string, unknown>
    expect(body.tools).toEqual([{ url_context: {} }])
    expect(gc.responseMimeType).toBeUndefined()
    expect(gc.thinkingConfig).toEqual({ thinkingBudget: 2048 })
    expect(gc.maxOutputTokens).toBe(3048)
  })
})
