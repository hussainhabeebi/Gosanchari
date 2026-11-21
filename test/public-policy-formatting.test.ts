// @ts-expect-error Tests run in Node; application types target Workers.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local in-memory test database only.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { PolicyContent } from '../src/views/policy-content'
import { publicRoutes } from '../src/routes/public'
import { DEFAULT_SETTINGS } from '../src/lib/settings'

const render = async (text: string) => await PolicyContent({ text }).toString()

describe('safe shared policy formatting', () => {
  it('preserves paragraphs, single line breaks and Windows/Mac line endings', async () => {
    const html = await render('Company\r\nEmail: hello@gosanchari.com\r\n\r\nFirst paragraph.\r\rSecond paragraph.')
    expect(html).toContain('<p>Company<br/>Email: ')
    expect(html).toContain('<p>First paragraph.</p><p>Second paragraph.</p>')
    expect(html).not.toContain('\\n')
  })
  it('gives numbered sections and lettered subsections a hierarchy without adding another H1', async () => {
    const html = await render('1. INTRODUCTION\n\nWelcome.\n\n2. Information We Collect\n\nA. Personal Information\n\nExisting text.\n\n## Existing heading\n\n### Existing subheading')
    for (const text of ['1. INTRODUCTION', '2. Information We Collect', 'Existing heading']) expect(html).toContain(`<h2>${text}</h2>`)
    expect(html).toContain('<h3>A. Personal Information</h3>')
    expect(html).toContain('<h3>Existing subheading</h3>')
    expect(html).not.toContain('<h1')
  })
  it('renders bullet and ordered lists without losing wording or list numbers', async () => {
    const html = await render('- Full name\n- Phone & email\n\n• Existing bullet\n* Existing star\n\n3. Choose a room.\n4. Send an enquiry.')
    expect(html).toContain('<ul><li>Full name</li><li>Phone &amp; email</li></ul>')
    expect(html).toContain('<ul><li>Existing bullet</li><li>Existing star</li></ul>')
    expect(html).toContain('<ol start="3"><li value="3">Choose a room.</li><li value="4">Send an enquiry.</li></ol>')
  })
  it('safely links websites and emails while retaining surrounding punctuation', async () => {
    const html = await render('Website: https://gosanchari.com.\nEmail: hello@gosanchari.com\nRead (https://example.com/privacy).')
    expect(html).toContain('href="https://gosanchari.com/" target="_blank" rel="noopener noreferrer">https://gosanchari.com</a>.')
    expect(html).toContain('<a href="mailto:hello@gosanchari.com">hello@gosanchari.com</a>')
    expect(html).toContain('href="https://example.com/privacy"')
    expect(html).toContain('</a>).')
    const mailbox = await render('team+privacy@example.com recipient?bcc=other@example.com')
    expect(mailbox).toContain('href="mailto:team%2Bprivacy@example.com"')
    expect(mailbox).toContain('href="mailto:recipient%3Fbcc%3Dother@example.com"')
    expect(mailbox).not.toContain('href="mailto:recipient?')
  })
  it('escapes stored HTML and never creates executable or credential-bearing links', async () => {
    const html = await render('1. SECURITY\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))\ndata:text/html,<svg onload=alert(1)>\nhttps://user:password@example.com/\nhttps://example.com/?a=1&b=2')
    expect(html).not.toMatch(/<script|<img|<svg|href="javascript:|href="data:|href="https:\/\/user:/)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('https://user:password@example.com/')
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
  })
  it('keeps ordinary numbered steps together instead of turning them into section headings', async () => {
    const html = await render('1. Choose a room\n2. Contact us\n3. Request a quote')
    expect(html).toContain('<ol start="1">')
    expect(html).not.toContain('<h2>')
  })
  it('handles empty text, long links and malformed URLs safely', async () => {
    expect(await render('')).toBe('<div class="policy-content"></div>')
    const text = 'https://example.com/' + 'very-long-path/'.repeat(40)
    expect(await render(text)).toContain(`>${text}</a>`)
    expect(await render('https://')).toContain('https://')
  })
  it('formats all three public policies without changing stored content, Admin editing or GA4 readiness', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const name of readdirSync('migrations').filter((n: string) => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'))
      const text = '1. EXISTING SECTION\n\nExisting approved wording.\n\n- First item\n- Second item\n\nEmail: hello@gosanchari.com'
      const policies = { privacy: text, terms: text, cancellation: text }
      db.prepare('INSERT INTO content(key,value) VALUES (?,?)').run('policies', JSON.stringify(policies))
      const before = JSON.stringify(db.prepare('SELECT * FROM content').all())
      const DB = { prepare(sql: string) {
        let values: any[] = []
        const statement = { bind(...v: any[]) { values = v; return statement }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
        return statement
      } }
      const env: any = { SITE_URL: 'https://gosanchari.com', DB, TURNSTILE_SITE_KEY: '', KV: {
        async get(key: string) { return key.includes('content') ? { policies } : DEFAULT_SETTINGS }, async put() {},
      } }
      const app = new Hono<any>().route('/', publicRoutes)
      for (const kind of ['privacy', 'terms', 'cancellation']) {
        const response = await app.request('https://gosanchari.com/policies/' + kind, {}, env)
        const html = await response.text()
        expect(response.status).toBe(200)
        expect(html).toContain('prose policy-page')
        expect(html).toContain('<h2>1. EXISTING SECTION</h2>')
        expect(html).toContain('<li>First item</li>')
        expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
        expect(html).not.toContain('id="public-analytics"')
      }
      expect(JSON.stringify(db.prepare('SELECT * FROM content').all())).toBe(before)
      expect(readFileSync('wrangler.toml', 'utf8')).not.toContain('GA4_READINESS')
    } finally { db.close() }
  })
})
