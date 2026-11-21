// Blog posts: shared rules for the admin (src/routes/admin-blog.tsx), the public pages (src/routes/blog.tsx)
// and the sitemap. A post is public only when status = 'published' and its publication date has arrived.
import type { Env } from '../env'
import { all, first } from './db'
import { htmlToText, sanitizeHtml } from './sanitize'
import { todayIST } from './util'

export const BLOG_TITLE_MAX = 150
export const BLOG_EXCERPT_MAX = 300
export const BLOG_SLUG_MAX = 80
export const BLOG_ALT_MAX = 150
export const BLOG_CONTENT_MAX = 100_000
export const BLOG_PAGE_SIZE = 12

export type BlogStatus = 'draft' | 'published' | 'unpublished'

export interface BlogPost {
  id: number
  title: string
  slug: string
  excerpt: string
  content_html: string
  meta_title: string | null
  meta_description: string | null
  featured_image_key: string | null
  featured_image_alt: string | null
  status: BlogStatus
  published_at: string | null
  first_published_at: string | null
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
}

/** SQL condition for posts visible to the public (alias b). */
export const PUBLIC_POST_SQL = "b.status = 'published' AND b.published_at IS NOT NULL AND b.published_at <= ?"

export function isPublic(p: Pick<BlogPost, 'status' | 'published_at'>, today = todayIST()): boolean {
  return p.status === 'published' && !!p.published_at && p.published_at <= today
}

/** Lowercase letters, digits and single hyphens; 3–80 characters. */
export function normaliseSlug(raw: string): string {
  return raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, BLOG_SLUG_MAX).replace(/-+$/g, '')
}
export const validSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length >= 3 && s.length <= BLOG_SLUG_MAX

/** Who already uses a slug: another post (current or old slug). Reusing your own old slug is allowed. */
export async function slugTaken(env: Env, slug: string, postId: number | null): Promise<boolean> {
  const own = postId ?? -1
  if (await first(env, 'SELECT 1 FROM blog_posts WHERE slug = ? AND id != ?', slug, own)) return true
  return !!(await first(env, 'SELECT 1 FROM blog_slug_redirects WHERE old_slug = ? AND post_id != ?', slug, own))
}

export const metaTitle = (p: Pick<BlogPost, 'title' | 'meta_title'>) => p.meta_title?.trim() || p.title

export function metaDescription(p: Pick<BlogPost, 'excerpt' | 'meta_description' | 'content_html'>): string {
  const text = p.meta_description?.trim() || p.excerpt.trim() || htmlToText(p.content_html)
  if (text.length <= 160) return text
  const cut = text.slice(0, 157), at = cut.lastIndexOf(' ')
  return cut.slice(0, at > 100 ? at : cut.length).replace(/[.,;:\s]+$/, '') + '…'
}

/** Content is stored sanitized and sanitized again on the way out (defence in depth). */
export const renderContent = (html: string, siteUrl: string) => sanitizeHtml(html, { siteUrl })

export async function publicPosts(env: Env, page: number) {
  return all<BlogPost>(
    env,
    `SELECT * FROM blog_posts b WHERE ${PUBLIC_POST_SQL} ORDER BY b.published_at DESC, b.id DESC LIMIT ? OFFSET ?`,
    todayIST(), BLOG_PAGE_SIZE + 1, (page - 1) * BLOG_PAGE_SIZE,
  )
}

/** The public post for a slug; or, for an old slug of a public post, where to redirect. */
export async function resolvePublicSlug(env: Env, slug: string): Promise<{ post: BlogPost } | { redirect: string } | null> {
  const today = todayIST()
  const post = await first<BlogPost>(env, `SELECT * FROM blog_posts b WHERE b.slug = ? AND ${PUBLIC_POST_SQL}`, slug, today)
  if (post) return { post }
  const moved = await first<{ slug: string }>(
    env, `SELECT b.slug FROM blog_slug_redirects r JOIN blog_posts b ON b.id = r.post_id WHERE r.old_slug = ? AND ${PUBLIC_POST_SQL}`, slug, today,
  )
  return moved ? { redirect: moved.slug } : null
}

export async function sitemapPosts(env: Env) {
  return all<{ slug: string; updated_at: string; published_at: string }>(
    env, `SELECT b.slug, b.updated_at, b.published_at FROM blog_posts b WHERE ${PUBLIC_POST_SQL} ORDER BY b.published_at DESC`, todayIST(),
  )
}
