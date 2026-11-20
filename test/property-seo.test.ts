// Property SEO Details: public description, meta title / description, FAQs (with FAQPage data) and image alt text,
// through the real Add/Edit wizard, the full editor and the public stay page.
import { describe, expect, it, vi } from 'vitest'
import { appFixture, jsonLd, metaContent } from './helpers/app-fixture'
import { faqsFromForm, readFaqs } from '../src/lib/property-seo'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

const step1 = (extra: Record<string, string | string[]> = {}) => ({
  name: 'Mist Valley Retreat', destination: 'Munnar, Kerala', type: 'homestay', facilities: 'pool', best_for: 'family',
  highlights: 'Tea garden views\nHeated pool', ...extra,
})

async function setup() {
  const f = appFixture()
  const admin = await f.user('admin', 'seo-admin@example.test')
  return { ...f, admin }
}
const prop = (f: ReturnType<typeof appFixture>, name = 'Mist Valley Retreat') => f.db.prepare('SELECT * FROM properties WHERE name = ?').get(name) as any
const live = (f: ReturnType<typeof appFixture>, id: number) => f.db.prepare("UPDATE properties SET status = 'live' WHERE id = ?").run(id)

describe('property SEO Details in Add / Edit property', () => {
  it('creates a property with description, meta title, meta description and FAQs, and shows them on the stay page', async () => {
    const f = await setup()
    const r = await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1({
      public_description: 'A quiet homestay above the tea estates.\n\nHome-cooked Kerala meals.',
      seo_title: 'Mist Valley Retreat Munnar | Tea Garden Homestay',
      seo_description: 'Family homestay in Munnar with tea garden views and a heated pool.',
      faq_q: ['Is breakfast included?', '', 'Do you allow pets?'],
      faq_a: ['Yes, breakfast is included.', '', 'Small pets are welcome.'],
    }) })
    expect(r.status).toBe(303)
    const p = prop(f)
    expect(p).toMatchObject({ public_description: 'A quiet homestay above the tea estates.\n\nHome-cooked Kerala meals.', seo_title: 'Mist Valley Retreat Munnar | Tea Garden Homestay' })
    expect(readFaqs(p.faqs)).toEqual([{ q: 'Is breakfast included?', a: 'Yes, breakfast is included.' }, { q: 'Do you allow pets?', a: 'Small pets are welcome.' }])
    live(f, p.id)
    const html = await (await f.req(`/stay/${p.slug}`)).text()
    expect(html).toContain('<title>Mist Valley Retreat Munnar | Tea Garden Homestay')
    expect(metaContent(html, 'name', 'description')).toBe('Family homestay in Munnar with tea garden views and a heated pool.')
    expect(html).toContain('A quiet homestay above the tea estates.')
    expect(html).toContain('<h2>Frequently asked questions</h2>')
    expect(html).toContain('<summary>Is breakfast included?</summary>')
    const faq = jsonLd(html).find((x) => x['@type'] === 'FAQPage')
    expect(faq.mainEntity).toEqual([
      { '@type': 'Question', name: 'Is breakfast included?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, breakfast is included.' } },
      { '@type': 'Question', name: 'Do you allow pets?', acceptedAnswer: { '@type': 'Answer', text: 'Small pets are welcome.' } },
    ])
    // The structured data matches exactly the questions shown on the page.
    const shown = [...html.matchAll(/<details class="faq"><summary>([^<]*)<\/summary>/g)].map((m) => m[1])
    expect(faq.mainEntity.map((q: any) => q.name)).toEqual(shown)
  })

  it('edits and removes FAQs, rejects half-filled rows and over-long descriptions without losing saved data', async () => {
    const f = await setup()
    await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1({ faq_q: 'Q1?', faq_a: 'A1.', seo_title: '' }) })
    const p = prop(f)
    const edit = (extra: Record<string, string | string[]>) => f.req(`/admin/properties/${p.id}/setup/1`, { method: 'POST', cookie: f.admin.cookie, body: step1({ seo_title: '', ...extra }) })
    expect(f.msg(await edit({ faq_q: ['Q1 edited?', 'Q2?'], faq_a: ['A1 edited.', ''] }))).toContain('enter both a question and an answer')
    expect(readFaqs(prop(f).faqs)).toEqual([{ q: 'Q1?', a: 'A1.' }])
    expect(f.msg(await edit({ public_description: 'x'.repeat(2001) }))).toContain('at most 2,000 characters')
    expect(prop(f).public_description).toBe('')
    await edit({ faq_q: ['Q1 edited?', 'Q2?'], faq_a: ['A1 edited.', 'A2.'], public_description: 'y'.repeat(2000) })
    expect(readFaqs(prop(f).faqs).map((x) => x.q)).toEqual(['Q1 edited?', 'Q2?'])
    expect(prop(f).public_description).toHaveLength(2000)
    await edit({}) // every FAQ row removed
    expect(readFaqs(prop(f).faqs)).toEqual([])
    live(f, p.id)
    const html = await (await f.req(`/stay/${p.slug}`)).text()
    expect(html).not.toContain('Frequently asked questions')
    expect(jsonLd(html).some((x) => x['@type'] === 'FAQPage')).toBe(false)
  })

  it('shows the SEO fields and the FAQ editor in the wizard, prefilled, and warns about a duplicate meta title', async () => {
    const f = await setup()
    await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1({ seo_title: 'Same Title', faq_q: 'Q?', faq_a: 'A.' }) })
    await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1({ name: 'Second Stay', seo_title: 'Same Title' }) })
    const page = await (await f.req(`/admin/properties/${prop(f, 'Second Stay').id}/setup/1`, { cookie: f.admin.cookie })).text()
    for (const s of ['SEO Details', 'name="seo_title" value="Same Title"', 'name="seo_description"', 'data-faq-editor', 'name="public_description"', '/content-editor.js']) expect(page).toContain(s)
    expect(page).toContain('Another property already uses this meta title (Mist Valley Retreat)')
  })

  it('saves image alt text from the wizard and the full editor, and renders it in the stay page images', async () => {
    const f = await setup()
    await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1() })
    const p = prop(f)
    const room = Number(f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity,units) VALUES(?,'Valley Room',4000,2,2)").run(p.id).lastInsertRowid)
    const add = (key: string, caption: string | null, roomId: number | null, category = 'common') => Number(f.db.prepare("INSERT INTO property_photos(property_id,r2_key,caption,sort,category,room_id,media_type) VALUES(?,?,?,1,?,?,'image')").run(p.id, key, caption, category, roomId).lastInsertRowid)
    const a = add('properties/x/common/a.jpg', 'Front view', null), b = add('properties/x/common/b.jpg', null, null), r = add('properties/x/room/c.jpg', null, room, 'room')
    const wizard = await (await f.req(`/admin/properties/${p.id}/setup/6`, { cookie: f.admin.cookie })).text()
    expect(wizard).toContain(`name="alt_${a}"`)
    await f.req(`/admin/properties/${p.id}/setup/6`, { method: 'POST', cookie: f.admin.cookie, body: { [`alt_${a}`]: 'Mist Valley Retreat entrance at dusk', [`alt_${r}`]: 'Valley Room double bed' } })
    expect(f.db.prepare('SELECT id, alt_text FROM property_photos WHERE property_id = ? ORDER BY id').all(p.id)).toEqual([
      { id: a, alt_text: 'Mist Valley Retreat entrance at dusk' }, { id: b, alt_text: null }, { id: r, alt_text: 'Valley Room double bed' },
    ])
    await f.req(`/admin/photos/${b}`, { method: 'POST', cookie: f.admin.cookie, body: { caption: '', sort: '2', category: 'common', alt_text: 'Heated pool with hills' } })
    live(f, p.id)
    const html = await (await f.req(`/stay/${p.slug}`)).text()
    expect(html).toContain('alt="Mist Valley Retreat entrance at dusk"')
    expect(html).toContain('alt="Heated pool with hills"')
    expect(html).toContain('alt="Valley Room double bed"')
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'property.alt_text' AND user_id = ?").get(f.admin.id)).toEqual({ n: 1 })
  })

  it('keeps existing properties working with no SEO fields, and never shows the older stored description', async () => {
    const f = await setup()
    const id = Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status,description,highlights) VALUES('old-stay','Old Stay','resort','Vagamon','live','LEGACY GENERATED TEXT','[\"Pine forest\"]')").run().lastInsertRowid)
    f.db.prepare("INSERT INTO property_photos(property_id,r2_key,caption,sort,category,media_type) VALUES(?,'properties/old/a.jpg','Old caption',1,'common','image')").run(id)
    const before = JSON.stringify(f.db.prepare('SELECT * FROM properties WHERE id = ?').get(id))
    const r = await f.req('/stay/old-stay')
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('<title>Old Stay, Vagamon')
    expect(metaContent(html, 'name', 'description')).toContain('Pine forest')
    expect(html).toContain('alt="Old caption"')
    expect(html).not.toContain('LEGACY GENERATED TEXT')
    expect(html).not.toContain('Frequently asked questions')
    expect(JSON.stringify(f.db.prepare('SELECT * FROM properties WHERE id = ?').get(id))).toBe(before)
    // The new columns default to empty for existing rows.
    expect(prop(f, 'Old Stay')).toMatchObject({ faqs: '[]', public_description: '' })
  })

  it('full editor saves the public description and FAQs too, and only users who can edit properties can', async () => {
    const f = await setup()
    await f.req('/admin/properties/new', { method: 'POST', cookie: f.admin.cookie, body: step1() })
    const p = prop(f)
    const editor = await (await f.req(`/admin/properties/${p.id}`, { cookie: f.admin.cookie })).text()
    expect(editor).toContain('name="public_description"')
    expect(editor).toContain('data-faq-editor')
    const sales = await f.user('sales', 'seo-sales@example.test')
    expect((await f.req(`/admin/properties/${p.id}/setup/1`, { method: 'POST', cookie: sales.cookie, body: step1({ seo_title: 'Hijack' }) })).status).toBe(403)
    expect(prop(f).seo_title).toBeNull()
  })
})

describe('FAQ form parsing', () => {
  it('drops blank rows, enforces limits and reads stored JSON defensively', () => {
    expect(faqsFromForm({ faq_q: [' Q ', ''], faq_a: [' A ', ''] })).toEqual({ faqs: [{ q: 'Q', a: 'A' }] })
    expect('err' in faqsFromForm({ faq_q: Array(21).fill('Q'), faq_a: Array(21).fill('A') })).toBe(true)
    expect('err' in faqsFromForm({ faq_q: ['x'.repeat(201)], faq_a: ['A'] })).toBe(true)
    expect(readFaqs('not json')).toEqual([])
    expect(readFaqs('[{"q":"Q","a":"A"},{"q":"","a":"x"},5]')).toEqual([{ q: 'Q', a: 'A' }])
  })
})
