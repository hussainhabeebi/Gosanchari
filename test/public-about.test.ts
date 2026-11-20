// @ts-expect-error Tests use local Node filesystem fixtures.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local in-memory database; application types target Workers.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ABOUT, DEFAULT_CONTENT } from '../src/lib/settings'
import { AboutContent } from '../src/views/about-content'
import { publicRoutes } from '../src/routes/public'

function fixture(about?: string) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((name: string) => name.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  if (about !== undefined) db.prepare("INSERT INTO content(key,value) VALUES('about',?)").run(JSON.stringify(about))
  const DB = { prepare(sql: string) { let values: any[] = []; const statement = { bind(...v: any[]) { values=v;return statement }, async all() { return {results:db.prepare(sql).all(...values)} }, async first() {return db.prepare(sql).get(...values) ?? null} };return statement } }
  return {db,app:new Hono().route('/',publicRoutes),env:{DB,KV:{async get(){return null},async put(){}},SITE_URL:'https://gosanchari.com',TURNSTILE_SITE_KEY:''} as any}
}
const plain = (html: string) => html.replace(/<\/?strong>/g,'').replace(/<[^>]*>/g,' ').replace(/&#39;|&#x27;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()
describe('Go Sanchari About page',()=>{
  it('renders every approved paragraph and requested emphasis without literal asterisks',()=>{
    const html=AboutContent({text:DEFAULT_ABOUT}).toString()
    expect(plain(html)).toBe(DEFAULT_ABOUT.replace(/\*/g,'').replace(/\s+/g,' ').trim())
    expect(html).toContain('<h2 class="about-tagline">More Than a Stay. A Friend for Every Journey.</h2>')
    expect(html).toContain('<strong>Go Sanchari</strong>');expect(html).toContain('<strong>24/7 customer support</strong>')
    expect(plain(html)).toContain("Our relationship doesn't end at checkout.")
    expect(html).toContain('about-motto');expect(html).toContain('about-signoff')
    expect(DEFAULT_CONTENT.about).toBe(DEFAULT_ABOUT)
  })
  it.each([undefined,''])('publishes approved default for missing/empty About content: %s',async about=>{
    const f=fixture(about);try {
      const before=JSON.stringify(f.db.prepare('SELECT * FROM content').all())
      const response=await f.app.request('https://gosanchari.com/about',{},f.env);const html=await response.text()
      expect(response.status).toBe(200);expect(html).toContain('<h1>About Go Sanchari</h1>')
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
      expect(plain(html)).toContain('More Than a Stay. A Friend for Every Journey.')
      expect(plain(html)).toContain('Go Sanchari — Your Travel Friend, Wherever You Go.')
      expect(html).toContain('/brand/logo-wide.webp');expect(html).toContain('href="/contact"')
      expect(html).toContain('rel="canonical" href="https://gosanchari.com/about"')
      expect(JSON.stringify(f.db.prepare('SELECT * FROM content').all())).toBe(before)
    } finally {f.db.close()}
  })
  it('preserves saved Admin custom content and subsequent editing, without rewriting records',async()=>{
    const f=fixture('Approved custom story.\n\nSecond custom paragraph.');try {
      const before=JSON.stringify(f.db.prepare('SELECT * FROM content').all())
      const html=await(await f.app.request('https://gosanchari.com/about',{},f.env)).text()
      expect(html).toContain('Approved custom story.');expect(html).toContain('Second custom paragraph.')
      expect(html).not.toContain('More Than a Stay.')
      expect(JSON.stringify(f.db.prepare('SELECT * FROM content').all())).toBe(before)
      f.db.prepare("UPDATE content SET value=? WHERE key='about'").run(JSON.stringify('Later Admin update.'))
      const changed=await(await f.app.request('https://gosanchari.com/about',{},f.env)).text()
      expect(changed).toContain('Later Admin update.');expect(changed).not.toContain('Approved custom story.')
    } finally {f.db.close()}
  })
  it('escapes stored HTML, preserves single line breaks, and allows safe text emphasis only',()=>{
    const html=AboutContent({text:'Custom *emphasis*\r\nNext line\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>'}).toString()
    expect(html).toContain('<strong>emphasis</strong>');expect(html).toContain('<br/>Next line')
    expect(html).not.toContain('<script>');expect(html).not.toContain('<img ');expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<h2')
  })
  it('scopes styles to the About page and wraps text on phones without fixed-height containers',()=>{
    const css=readFileSync('public/app.css','utf8') as string
    const rules=css.slice(css.indexOf('/* About Go Sanchari:'))
    expect(rules).toContain('@media(max-width:650px)');expect(rules).toContain('overflow-wrap:anywhere')
    expect(rules).toContain('max-width:760px');expect(rules).toContain('flex-wrap:wrap')
    expect(rules).not.toContain('overflow:hidden')
  })
})
