// Public blog: /blog (list) and /blog/:slug (article). Only published posts whose publication date has arrived
// are shown; anything else is a 404. An old slug of a public post redirects (301) to its current URL.
import { Hono, type Context } from 'hono'
import { raw } from 'hono/html'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, jsonScript, Pager } from '../views/components'
import { mediaUrl } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import { BLOG_PAGE_SIZE, type BlogPost, metaDescription, metaTitle, publicPosts, renderContent, resolvePublicSlug } from '../lib/blog'
import { fmtDate } from '../lib/util'
import { pageNum } from './helpers'

export const blogRoutes = new Hono<AppEnv>()

const abs = (c: Context<AppEnv>, path: string) => new URL(path, c.env.SITE_URL).href
const imageUrl = (c: Context<AppEnv>, key: string | null, width = 1200) => (key ? abs(c, mediaUrl(key, width)) : undefined)
/** ISO date-time for structured data (publication dates are India time). */
const isoDate = (d: string) => (d.length === 10 ? `${d}T00:00:00+05:30` : d)

blogRoutes.get('/blog', async (c) => {
  const pg = pageNum(c)
  const rows = await publicPosts(c.env, pg)
  if (pg > 1 && !rows.length) return c.notFound()
  const posts = rows.slice(0, BLOG_PAGE_SIZE)
  const settings = await getSettings(c.env)
  const canonical = abs(c, pg > 1 ? `/blog?page=${pg}` : '/blog')
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: abs(c, '/') },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: abs(c, '/blog') },
    ],
  }
  return page(c, {
    title: pg > 1 ? `Travel Blog — Page ${pg}` : 'Travel Blog: Kerala Stays, Tips & Guides',
    description: `Travel ideas, destination guides and stay tips for Kerala from ${settings.business.name}.${pg > 1 ? ` Page ${pg}.` : ''}`,
    canonical, hideJourneyBanner: true,
  }, (
    <div class="wrap section blog-list-page">
      <nav class="breadcrumbs small" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Blog</span></nav>
      <h1>Travel Blog</h1>
      {posts.length === 0 ? <Empty>New articles are coming soon.</Empty> : (
        <div class="blog-grid">
          {posts.map((p) => (
            <article class="blog-card card">
              {p.featured_image_key && <a href={`/blog/${p.slug}`} tabindex={-1} aria-hidden="true"><img src={mediaUrl(p.featured_image_key, 600)} alt={p.featured_image_alt ?? ''} loading="lazy" width="600" height="338" /></a>}
              <div class="blog-card-body stack">
                <h2><a href={`/blog/${p.slug}`}>{p.title}</a></h2>
                <p class="muted small"><time datetime={p.published_at!}>{fmtDate(p.published_at)}</time></p>
                {p.excerpt && <p>{p.excerpt}</p>}
                <a class="blog-read-more" href={`/blog/${p.slug}`}>Read the full article<span class="sr-only">: {p.title}</span> →</a>
              </div>
            </article>
          ))}
        </div>
      )}
      <Pager page={pg} hasMore={rows.length > BLOG_PAGE_SIZE} base="/blog" />
      {jsonScript('ld-breadcrumb', breadcrumb, 'application/ld+json')}
    </div>
  ))
})

/** The article page. Also used by the admin preview (preview = true: never indexed, no canonical, no schema). */
export async function renderPost(c: Context<AppEnv>, p: BlogPost, preview = false) {
  const settings = await getSettings(c.env)
  const url = abs(c, `/blog/${p.slug}`)
  const image = imageUrl(c, p.featured_image_key)
  const description = metaDescription(p)
  const published = p.published_at ?? p.created_at.slice(0, 10)
  const posting = {
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: p.title.slice(0, 110), description, url, mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    datePublished: isoDate(published), dateModified: p.updated_at,
    ...(image ? { image: [image] } : {}),
    author: { '@type': 'Organization', name: settings.business.name, url: abs(c, '/') },
    publisher: { '@type': 'Organization', name: settings.business.name, logo: { '@type': 'ImageObject', url: abs(c, '/brand/logo-wide.webp') } },
  }
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: abs(c, '/') },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: abs(c, '/blog') },
      { '@type': 'ListItem', position: 3, name: p.title, item: url },
    ],
  }
  return page(c, {
    title: metaTitle(p), description, noindex: preview, image, imageAlt: p.featured_image_alt ?? undefined,
    canonical: preview ? undefined : url, ogType: 'article', hideJourneyBanner: true, articlePublished: isoDate(published), articleModified: p.updated_at,
  }, (
    <div class="wrap section blog-post-page">
      {preview && <div class="flash flash-err">Preview — this post is not on the website ({p.status}{p.published_at ? `, date ${fmtDate(p.published_at)}` : ''}).</div>}
      <article class="blog-article">
        <nav class="breadcrumbs small" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/blog">Blog</a> › <span aria-current="page">{p.title}</span></nav>
        <header class="stack">
          <h1>{p.title}</h1>
          <p class="muted small"><time datetime={published}>{fmtDate(published)}</time></p>
        </header>
        {p.featured_image_key && <img class="blog-hero" src={mediaUrl(p.featured_image_key, 1200)} alt={p.featured_image_alt ?? ''} width="1200" height="675" />}
        <div class="blog-content">{raw(renderContent(p.content_html, c.env.SITE_URL))}</div>
        <p class="blog-more"><a href="/blog">← More articles</a></p>
      </article>
      {!preview && jsonScript('ld-blogposting', posting, 'application/ld+json')}
      {!preview && jsonScript('ld-breadcrumb', breadcrumb, 'application/ld+json')}
    </div>
  ))
}

blogRoutes.get('/blog/:slug', async (c) => {
  const found = await resolvePublicSlug(c.env, c.req.param('slug'))
  if (!found) return c.notFound()
  if ('redirect' in found) return c.redirect(`/blog/${found.redirect}`, 301)
  return renderPost(c, found.post)
})
