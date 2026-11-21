// Blog: admin management (permission manage_blog), the public /blog pages, slugs and redirects, metadata,
// structured data, sitemap and stored-XSS protection — through the real app with login, sessions and CSRF.
import { describe, expect, it, vi } from 'vitest'
import { appFixture, jsonLd, metaContent, pngFile } from './helpers/app-fixture'
import { DEFAULT_PERMISSIONS } from '../src/lib/permissions'
import { todayIST } from '../src/lib/util'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

const SITE = 'https://gosanchari.test'
const post = (extra: Record<string, any> = {}) => ({
  title: 'Monsoon in Munnar', slug: '', excerpt: 'Why the rains are the best time to visit the hills.',
  content: '<h2>Green hills</h2><p>Mist and <strong>waterfalls</strong>.</p>', meta_title: '', meta_description: '', featured_image_alt: '', published_at: '', action: 'save', ...extra,
})

async function setup() {
  const f = appFixture()
  const admin = await f.user('admin', 'blog-admin@example.test')
  const row = (slug: string) => f.db.prepare('SELECT * FROM blog_posts WHERE slug = ?').get(slug) as any
  const save = (id: number | null, body: Record<string, any>, cookie = admin.cookie) => f.req(id ? `/admin/blog/${id}` : '/admin/blog/new', { method: 'POST', cookie, body })
  const create = async (extra: Record<string, any> = {}) => { const r = await save(null, post(extra)); return { r, p: row(extra.slug || 'monsoon-in-munnar') } }
  const version = (id: number) => (f.db.prepare('SELECT updated_at FROM blog_posts WHERE id = ?').get(id) as any).updated_at
  const update = (id: number, extra: Record<string, any>) => save(id, { ...post(extra), version: version(id) })
  const sitemap = async () => (await f.req('/sitemap.xml')).text()
  return { ...f, admin, row, save, create, update, sitemap }
}

describe('blog admin permissions', () => {
  it('only Admin (or a role given manage_blog) can open or change the blog', async () => {
    const f = await setup()
    const { p } = await f.create()
    for (const role of ['sales', 'manager', 'accounts']) {
      const u = await f.user(role, `${role}-blog@example.test`)
      for (const path of ['/admin/blog', '/admin/blog/new', `/admin/blog/${p.id}/edit`, `/admin/blog/${p.id}/preview`]) expect([role, path, (await f.req(path, { cookie: u.cookie })).status]).toEqual([role, path, 403])
      for (const path of ['/admin/blog/new', `/admin/blog/${p.id}`, `/admin/blog/${p.id}/delete`, '/admin/blog/upload']) expect([role, path, (await f.req(path, { method: 'POST', cookie: u.cookie, body: post({ action: 'publish', confirm: '1' }) })).status]).toEqual([role, path, 403])
    }
    expect((await f.req('/admin/blog')).status).toBe(302) // anonymous → login
    expect(f.row('monsoon-in-munnar').status).toBe('draft')
    // Admin can grant it from Staff & roles.
    f.setPerms({ manager: { ...DEFAULT_PERMISSIONS.manager, manage_blog: true } })
    const manager = await f.user('manager', 'manager2-blog@example.test')
    expect((await f.req('/admin/blog', { cookie: manager.cookie })).status).toBe(200)
    // Cross-site form posts are refused.
    expect((await f.req('/admin/blog/new', { method: 'POST', cookie: f.admin.cookie, headers: { Origin: 'https://evil.example' }, body: post({ title: 'X' }) })).status).toBe(403)
  })
})

describe('blog lifecycle', () => {
  it('draft → publish → edit → unpublish → delete, with the public site and sitemap following along', async () => {
    const f = await setup()
    const { r, p } = await f.create({ content: '<p>Draft body</p><script>alert(1)</script>' })
    expect(f.msg(r)).toContain('Saved.')
    expect(p).toMatchObject({ status: 'draft', title: 'Monsoon in Munnar', slug: 'monsoon-in-munnar', content_html: '<p>Draft body</p>', created_by: f.admin.id, first_published_at: null })
    expect((await f.req('/blog/monsoon-in-munnar')).status).toBe(404)
    expect(await (await f.req('/blog')).text()).not.toContain('Monsoon in Munnar')
    expect(await f.sitemap()).not.toContain('/blog/monsoon-in-munnar')
    const preview = await (await f.req(`/admin/blog/${p.id}/preview`, { cookie: f.admin.cookie })).text()
    expect(preview).toContain('Preview — this post is not on the website')
    expect(preview).toContain('<meta name="robots" content="noindex"')

    // Publishing needs an excerpt (and alt text when there is a featured image).
    expect(await (await f.update(p.id, { excerpt: '', action: 'publish' })).text()).toContain('To publish, add a short excerpt')
    expect(f.row('monsoon-in-munnar').status).toBe('draft')
    const pub = await f.update(p.id, { action: 'publish', featured_image: pngFile(), featured_image_alt: '' })
    expect(await pub.text()).toContain('alt text for the featured image')
    const ok = await f.update(p.id, { action: 'publish', featured_image: pngFile(), featured_image_alt: 'Waterfall near Munnar', meta_title: 'Monsoon Munnar Guide', meta_description: 'Plan a monsoon trip to Munnar.' })
    expect(f.msg(ok)).toContain('Published')
    const live = f.row('monsoon-in-munnar')
    expect(live).toMatchObject({ status: 'published', published_at: todayIST(), featured_image_alt: 'Waterfall near Munnar' })
    expect(live.featured_image_key).toMatch(/^blog\/[0-9a-f-]+\.png$/)
    expect(f.media.has(live.featured_image_key)).toBe(true)

    const list = await (await f.req('/blog')).text()
    for (const s of ['Monsoon in Munnar', 'Why the rains are the best time', 'href="/blog/monsoon-in-munnar"', 'alt="Waterfall near Munnar"', 'Read the full article']) expect(list).toContain(s)
    expect(list).toContain(`<link rel="canonical" href="${SITE}/blog"`)
    const page = await (await f.req('/blog/monsoon-in-munnar')).text()
    expect(page).toContain('<title>Monsoon Munnar Guide')
    expect(page).toContain('<title>Monsoon Munnar Guide · Go Sanchari</title>')
    expect(metaContent(page, 'name', 'description')).toBe('Plan a monsoon trip to Munnar.')
    expect(page).toContain(`<link rel="canonical" href="${SITE}/blog/monsoon-in-munnar"`)
    expect(metaContent(page, 'property', 'og:type')).toBe('article')
    expect(metaContent(page, 'property', 'og:url')).toBe(`${SITE}/blog/monsoon-in-munnar`)
    expect(metaContent(page, 'property', 'og:image')).toBe(`${SITE}/media/${live.featured_image_key}`)
    expect(metaContent(page, 'property', 'og:image:alt')).toBe('Waterfall near Munnar')
    expect(page).not.toContain('<meta name="robots" content="noindex"')
    expect(page).toContain('<h2>Green hills</h2><p>Mist and <strong>waterfalls</strong>.</p>')
    const ld = jsonLd(page)
    expect(ld.find((x) => x['@type'] === 'BlogPosting')).toMatchObject({ headline: 'Monsoon in Munnar', url: `${SITE}/blog/monsoon-in-munnar`, description: 'Plan a monsoon trip to Munnar.', image: [`${SITE}/media/${live.featured_image_key}`], datePublished: `${todayIST()}T00:00:00+05:30` })
    expect(ld.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.map((x: any) => x.name)).toEqual(['Home', 'Blog', 'Monsoon in Munnar'])
    expect(await f.sitemap()).toContain(`<loc>${SITE}/blog/monsoon-in-munnar</loc><lastmod>`)
    expect(await f.sitemap()).toContain(`<loc>${SITE}/blog</loc>`)
    // Published posts can't be deleted.
    expect(f.msg(await f.req(`/admin/blog/${p.id}/delete`, { method: 'POST', cookie: f.admin.cookie, body: { confirm: '1' } }))).toContain('Unpublish the post before deleting it')

    // Edit the live post; replacing the image removes the old file.
    const oldImage = live.featured_image_key
    await f.update(p.id, { title: 'Monsoon in Munnar (2026)', slug: 'monsoon-in-munnar', featured_image: pngFile('b.png'), featured_image_alt: 'New view', meta_title: 'Monsoon Munnar Guide', meta_description: 'Plan a monsoon trip to Munnar.' })
    expect(f.row('monsoon-in-munnar')).toMatchObject({ title: 'Monsoon in Munnar (2026)', status: 'published', updated_by: f.admin.id })
    expect(f.media.has(oldImage)).toBe(false)

    // Unpublish: gone from the site and the sitemap.
    expect(f.msg(await f.update(p.id, { action: 'unpublish', featured_image_alt: 'New view' }))).toContain('Unpublished')
    expect((await f.req('/blog/monsoon-in-munnar')).status).toBe(404)
    expect(await f.sitemap()).not.toContain('/blog/monsoon-in-munnar')
    expect(await (await f.req('/blog')).text()).not.toContain('Monsoon in Munnar')

    // Delete needs the confirmation tick.
    expect(f.msg(await f.req(`/admin/blog/${p.id}/delete`, { method: 'POST', cookie: f.admin.cookie, body: {} }))).toContain('Tick “I understand this cannot be undone”')
    expect(f.row('monsoon-in-munnar')).toBeTruthy()
    const image = f.row('monsoon-in-munnar').featured_image_key
    expect(f.msg(await f.req(`/admin/blog/${p.id}/delete`, { method: 'POST', cookie: f.admin.cookie, body: { confirm: '1' } }))).toContain('Deleted')
    expect(f.row('monsoon-in-munnar')).toBeUndefined()
    expect(f.media.has(image)).toBe(false)
    const audit = (f.db.prepare("SELECT action, user_id FROM activity_log WHERE entity = 'blog_post' ORDER BY id").all() as any[])
    expect(audit.map((a) => a.action)).toEqual(['blog.created', 'blog.published', 'blog.updated', 'blog.unpublished', 'blog.deleted'])
    expect(audit.every((a) => a.user_id === f.admin.id)).toBe(true)
  })

  it('schedules a post with a future publication date and keeps it off the site until then', async () => {
    const f = await setup()
    const future = todayIST(10)
    const { r } = await f.create({ action: 'publish', published_at: future })
    expect(f.msg(r)).toContain('Scheduled')
    expect((await f.req('/blog/monsoon-in-munnar')).status).toBe(404)
    expect(await f.sitemap()).not.toContain('/blog/monsoon-in-munnar')
    f.db.prepare('UPDATE blog_posts SET published_at = ?').run(todayIST(-1))
    expect((await f.req('/blog/monsoon-in-munnar')).status).toBe(200)
  })

  it('rejects stale edits so two people cannot overwrite each other', async () => {
    const f = await setup()
    const { p } = await f.create()
    const res = await f.save(p.id, { ...post({ title: 'Mine' }), version: '2000-01-01T00:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Someone else saved this post')
    expect(f.row('monsoon-in-munnar').title).toBe('Monsoon in Munnar')
  })
})

describe('blog slugs and redirects', () => {
  it('prevents duplicate slugs, including old slugs that still redirect', async () => {
    const f = await setup()
    await f.create({ action: 'publish' })
    const dup = await f.save(null, post({ title: 'Another', slug: 'monsoon-in-munnar' }))
    expect(dup.status).toBe(400)
    expect(await dup.text()).toContain('already used by another post')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get()).toEqual({ n: 1 })
    expect((await f.save(null, post({ title: 'Bad', slug: 'ab' }))).status).toBe(400)
    // Slugs are normalised from the title.
    await f.save(null, post({ title: 'Kerala Backwaters: A Guide!', slug: '' }))
    expect(f.row('kerala-backwaters-a-guide')).toBeTruthy()
  })

  it('redirects the old URL with a 301 when a published slug changes, and lets the post take it back', async () => {
    const f = await setup()
    const { p } = await f.create({ action: 'publish' })
    await f.update(p.id, { slug: 'munnar-in-the-monsoon' })
    const r = await f.req('/blog/monsoon-in-munnar')
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/blog/munnar-in-the-monsoon')
    expect((await f.req('/blog/munnar-in-the-monsoon')).status).toBe(200)
    await f.update(p.id, { slug: 'munnar-monsoon-guide' })
    expect((await f.req('/blog/monsoon-in-munnar')).headers.get('location')).toBe('/blog/munnar-monsoon-guide') // no redirect chains
    expect((await f.req('/blog/munnar-in-the-monsoon')).headers.get('location')).toBe('/blog/munnar-monsoon-guide')
    // Another post can't take an old slug.
    expect((await f.save(null, post({ title: 'X', slug: 'monsoon-in-munnar' }))).status).toBe(400)
    // The post itself can go back to it; that redirect is then removed.
    await f.update(p.id, { slug: 'monsoon-in-munnar' })
    expect((await f.req('/blog/monsoon-in-munnar')).status).toBe(200)
    expect(f.db.prepare('SELECT old_slug FROM blog_slug_redirects ORDER BY old_slug').all()).toEqual([{ old_slug: 'munnar-in-the-monsoon' }, { old_slug: 'munnar-monsoon-guide' }])
    // Old URLs of an unpublished post don't redirect anywhere.
    await f.update(p.id, { action: 'unpublish' })
    expect((await f.req('/blog/munnar-monsoon-guide')).status).toBe(404)
  })

  it('does not create redirects for a post that was never published', async () => {
    const f = await setup()
    const { p } = await f.create()
    await f.update(p.id, { slug: 'draft-new-slug' })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM blog_slug_redirects').get()).toEqual({ n: 0 })
    expect((await f.save(null, post({ title: 'Other', slug: 'monsoon-in-munnar' }))).status).toBe(303)
  })
})

describe('blog content safety and metadata', () => {
  it('stores and shows sanitized content only', async () => {
    const f = await setup()
    await f.create({ action: 'publish', content: '<p onclick="steal()">Hi <a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></p><iframe src="https://evil.example"></iframe><a href="https://example.com">ext</a>' })
    const stored = f.row('monsoon-in-munnar').content_html
    expect(stored).toBe('<p>Hi <a>x</a></p><a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">ext</a>')
    // Even content written straight into the database is cleaned on the way out.
    f.db.prepare("UPDATE blog_posts SET content_html = ? WHERE slug = 'monsoon-in-munnar'").run('<p>ok</p><script>alert(1)</script><img src="/media/a.png" onerror="x()">')
    const html = await (await f.req('/blog/monsoon-in-munnar')).text()
    const body = html.slice(html.indexOf('<div class="blog-content">'), html.indexOf('</article>'))
    expect(body).toContain('<p>ok</p><img src="/media/a.png" alt="">')
    expect(body).not.toMatch(/<script|onerror/)
    // Titles and excerpts are escaped text.
    await f.save(null, post({ title: '<img src=x onerror=alert(1)> Title', slug: 'xss-title', excerpt: '"><script>alert(1)</script>', action: 'publish' }))
    const list = await (await f.req('/blog')).text()
    expect(list).toContain('&lt;img src=x onerror=alert(1)&gt; Title')
    expect(list).not.toContain('<script>alert(1)</script>')
  })

  it('accepts only real images for uploads, inside the content too', async () => {
    const f = await setup()
    const fake = new File([new TextEncoder().encode('<script>alert(1)</script>')], 'evil.png', { type: 'image/png' })
    expect(await (await f.save(null, post({ featured_image: fake }))).text()).toContain('featured image must be a JPG')
    const bad = await f.req('/admin/blog/upload', { method: 'POST', cookie: f.admin.cookie, body: { image: fake } })
    expect(bad.status).toBe(400)
    const good = await f.req('/admin/blog/upload', { method: 'POST', cookie: f.admin.cookie, body: { image: pngFile() } })
    const { url } = await good.json() as any
    expect(url).toMatch(/^\/media\/blog\/content\/[0-9a-f-]+\.png$/)
    expect(f.media.has(url.slice(7))).toBe(true)
  })

  it('gives every page its own title, description and canonical URL, and falls back sensibly', async () => {
    const f = await setup()
    await f.save(null, post({ title: 'Branded', slug: 'branded-title', meta_title: 'Houseboats | Go Sanchari', action: 'publish' }))
    expect(await (await f.req('/blog/branded-title')).text()).toContain('<title>Houseboats | Go Sanchari</title>')
    await f.create({ action: 'publish', meta_title: '', meta_description: '' })
    await f.save(null, post({ title: 'Vagamon Pine Forest', slug: 'vagamon-pine-forest', excerpt: 'A walk through the pines.', action: 'publish' }))
    const a = await (await f.req('/blog/monsoon-in-munnar')).text(), b = await (await f.req('/blog/vagamon-pine-forest')).text()
    expect(a).toContain('<title>Monsoon in Munnar')
    expect(metaContent(a, 'name', 'description')).toBe('Why the rains are the best time to visit the hills.')
    expect(b).toContain('<title>Vagamon Pine Forest')
    expect(metaContent(b, 'name', 'description')).toBe('A walk through the pines.')
    expect(a.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).not.toBe(b.match(/<link rel="canonical" href="([^"]+)"/)?.[1])
    const list = await (await f.req('/blog')).text()
    expect(jsonLd(list).find((x) => x['@type'] === 'BreadcrumbList').itemListElement).toHaveLength(2)
    expect((await f.req('/blog?page=5')).status).toBe(404)
  })

  it('keeps robots.txt allowing /blog and existing URLs and sitemap entries unchanged', async () => {
    const f = await setup()
    const robots = await (await f.req('/robots.txt')).text()
    expect(robots).not.toMatch(/Disallow: \/blog/)
    const map = await f.sitemap()
    for (const path of ['/', '/search', '/offers', '/about', '/contact', '/enquiry']) expect(map).toContain(`<loc>${new URL(path, SITE).href}</loc>`)
  })
})
