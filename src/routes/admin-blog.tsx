// Admin → Website Settings → Blog. Everything here needs the manage_blog permission (Admin only by default).
// Posts are drafts until published; a published post can be unpublished; only a post that is not published can
// be deleted, after an explicit confirmation. Every change goes to the activity log with the staff member.
import { Hono, type Context } from 'hono'
import { raw } from 'hono/html'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Pager, Table, Tabs } from '../views/components'
import { requirePerm } from '../lib/auth'
import { all, first, insertId, logActivity, run } from '../lib/db'
import { mediaUrl } from '../lib/integrations'
import { PROPERTY_IMAGE_ACCEPT, propertyImageType } from '../lib/property-images'
import { htmlToText, sanitizeHtml } from '../lib/sanitize'
import {
  BLOG_ALT_MAX, BLOG_CONTENT_MAX, BLOG_EXCERPT_MAX, BLOG_SLUG_MAX, BLOG_TITLE_MAX, type BlogPost, type BlogStatus,
  isPublic, normaliseSlug, slugTaken, validSlug,
} from '../lib/blog'
import { META_DESCRIPTION_MAX, META_TITLE_MAX } from '../lib/property-seo'
import { fmtDate, fmtDateTime, int, isDate, nowIso, str, todayIST } from '../lib/util'
import { pageNum, redirectMsg } from './helpers'
import { renderPost } from './blog'

export const adminBlogRoutes = new Hono<AppEnv>()
const guard = requirePerm('manage_blog')
const IMAGE_MAX = 5 * 1024 * 1024
/** Check the file's real bytes, never the type the browser claims (same as guest review photos). */
const imageType = (file: File) => propertyImageType(new File([file.slice(0, 4096)], '', { type: 'application/octet-stream' }))
const STATUS_LABEL: Record<BlogStatus, string> = { draft: 'Draft', published: 'Published', unpublished: 'Unpublished' }

const load = (c: Context<AppEnv>) => first<BlogPost>(c.env, 'SELECT * FROM blog_posts WHERE id = ?', int(c.req.param('id')))

function statusLabel(p: BlogPost) {
  if (p.status === 'published' && !isPublic(p)) return `Scheduled for ${fmtDate(p.published_at)}`
  return STATUS_LABEL[p.status]
}

// ---------- List ----------
adminBlogRoutes.get('/admin/blog', guard, async (c) => {
  const tab = ['all', 'draft', 'published', 'unpublished'].includes(c.req.query('status') ?? '') ? c.req.query('status')! : 'all'
  const pg = pageNum(c)
  const rows = await all<BlogPost & { author: string | null }>(
    c.env,
    `SELECT b.*, u.name AS author FROM blog_posts b LEFT JOIN users u ON u.id = COALESCE(b.updated_by, b.created_by)
     ${tab === 'all' ? '' : 'WHERE b.status = ?'} ORDER BY b.updated_at DESC LIMIT 51 OFFSET ?`,
    ...(tab === 'all' ? [] : [tab]), (pg - 1) * 50,
  )
  return page(c, { title: 'Blog', area: 'admin', active: 'blog' }, (
    <div class="stack-lg">
      <div class="row-between"><h1>Blog</h1><a class="btn" href="/admin/blog/new">+ New post</a></div>
      <Tabs base="/admin/blog" param="status" active={tab} items={[['all', 'All'], ['draft', 'Drafts'], ['published', 'Published'], ['unpublished', 'Unpublished']]} />
      <Table head={['Title', 'Status', 'Publication date', 'Last change', '']}>
        {rows.slice(0, 50).map((p) => (
          <tr>
            <td><a href={`/admin/blog/${p.id}/edit`}><strong>{p.title}</strong></a><div class="muted small">/blog/{p.slug}</div></td>
            <td>{statusLabel(p)}</td>
            <td>{p.published_at ? fmtDate(p.published_at) : '—'}</td>
            <td class="small">{fmtDateTime(p.updated_at)}{p.author ? ` · ${p.author}` : ''}</td>
            <td class="nowrap">
              <a class="btn btn-sm btn-outline" href={`/admin/blog/${p.id}/edit`}>Edit</a>
              {isPublic(p) ? <a class="btn btn-sm btn-outline" href={`/blog/${p.slug}`} target="_blank" rel="noopener">View</a> : <a class="btn btn-sm btn-outline" href={`/admin/blog/${p.id}/preview`} target="_blank" rel="noopener">Preview</a>}
            </td>
          </tr>
        ))}
      </Table>
      {rows.length === 0 && <Empty>No posts here yet.</Empty>}
      <Pager page={pg} hasMore={rows.length > 50} base={`/admin/blog?status=${tab}`} />
    </div>
  ))
})

// ---------- Form ----------
type Values = Pick<BlogPost, 'title' | 'slug' | 'excerpt' | 'content_html' | 'meta_title' | 'meta_description' | 'featured_image_alt' | 'published_at'>

const TOOLBAR: [string, string, string][] = [
  ['formatBlock:p', 'Paragraph', '¶'], ['formatBlock:h2', 'Heading', 'H2'], ['formatBlock:h3', 'Subheading', 'H3'],
  ['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['underline', 'Underline', 'U'],
  ['insertUnorderedList', 'Bulleted list', '• List'], ['insertOrderedList', 'Numbered list', '1. List'], ['formatBlock:blockquote', 'Quote', '❝'],
  ['link', 'Add link', 'Link'], ['unlink', 'Remove link', 'Unlink'], ['image', 'Insert image', 'Image'],
  ['removeFormat', 'Clear formatting', 'Clear'], ['undo', 'Undo', '↶'], ['redo', 'Redo', '↷'],
]

function postForm(c: Context<AppEnv>, post: BlogPost | null, v: Values, err?: string, status = 200) {
  const action = post ? `/admin/blog/${post.id}` : '/admin/blog/new'
  const live = post ? isPublic(post) : false
  return page(c, { title: post ? `Edit: ${post.title}` : 'New blog post', area: 'admin', active: 'blog', head: <script src="/content-editor.js" defer /> }, (
    <div class="stack-lg blog-admin">
      <p><a href="/admin/blog">← All posts</a></p>
      <div class="row-between">
        <h1>{post ? 'Edit blog post' : 'New blog post'}</h1>
        {post && <span class="pill">{statusLabel(post)}</span>}
      </div>
      {err && <div class="flash flash-err" role="alert">{err}</div>}
      {post?.status === 'published' && <p class="small muted">This post is {live ? 'live' : 'scheduled'}. Saving updates it straight away{live ? ` at /blog/${post.slug}` : ''}.</p>}
      <form method="post" action={action} enctype="multipart/form-data" class="stack" data-blog-form>
        {post && <input type="hidden" name="version" value={post.updated_at} />}
        <section class="card stack">
          <Field label="Title *"><input name="title" value={v.title} required maxlength={BLOG_TITLE_MAX} data-blog-title /></Field>
          <Field label="URL slug" hint={`Lowercase letters, numbers and hyphens. Leave blank to create it from the title.${post?.first_published_at ? ' Changing it keeps the old link working (it redirects to the new one).' : ''}`}>
            <span class="with-prefix"><span class="muted">/blog/</span><input name="slug" value={v.slug} maxlength={BLOG_SLUG_MAX} pattern="[a-z0-9]+(-[a-z0-9]+)*" data-blog-slug /></span>
          </Field>
          <Field label="Short excerpt" hint={`Shown on the blog list and used as the description if Meta Description is blank. Up to ${BLOG_EXCERPT_MAX} characters. Needed to publish.`}>
            <textarea name="excerpt" rows={3} maxlength={BLOG_EXCERPT_MAX}>{v.excerpt}</textarea>
          </Field>
          <div class="field">
            <span class="field-label">Content *</span>
            <div class="rich-editor" data-rich-editor data-upload-url="/admin/blog/upload">
              <div class="rich-toolbar" role="toolbar" aria-label="Formatting">
                {TOOLBAR.map(([cmd, label, icon]) => <button type="button" class="btn btn-sm btn-outline" data-cmd={cmd} title={label} aria-label={label}>{icon}</button>)}
              </div>
              <div class="rich-area" contenteditable={true} role="textbox" aria-multiline="true" aria-label="Post content" data-rich-area hidden>{raw(v.content_html)}</div>
              <textarea name="content" rows={16} maxlength={BLOG_CONTENT_MAX} data-rich-source aria-label="Post content (HTML)">{v.content_html}</textarea>
              <input type="file" accept={PROPERTY_IMAGE_ACCEPT} hidden data-rich-image />
              <p class="small muted" data-rich-status role="status" aria-live="polite">Headings, bold, italic, lists, quotes, links and images. Pasted text is added without its original formatting.</p>
            </div>
          </div>
        </section>
        <section class="card stack">
          <h2>Featured image</h2>
          {post?.featured_image_key && <div class="row wrap-row"><img src={mediaUrl(post.featured_image_key, 400)} alt={post.featured_image_alt ?? ''} class="blog-admin-thumb" /><label class="check"><input type="checkbox" name="remove_image" value="1" /> Remove image</label></div>}
          <Field label={post?.featured_image_key ? 'Replace image' : 'Upload image'} hint="JPG, PNG, WebP or AVIF, up to 5 MB. Shown on the blog list, at the top of the post and when shared."><input type="file" name="featured_image" accept={PROPERTY_IMAGE_ACCEPT} /></Field>
          <Field label="Featured image alt text" hint="Describe the image. Needed to publish a post with an image."><input name="featured_image_alt" value={v.featured_image_alt ?? ''} maxlength={BLOG_ALT_MAX} /></Field>
        </section>
        <section class="card stack">
          <h2>SEO and publishing</h2>
          <Field label="Meta Title" hint={`Up to ${META_TITLE_MAX} characters. Blank uses the post title.`}><input name="meta_title" value={v.meta_title ?? ''} maxlength={META_TITLE_MAX} /></Field>
          <Field label="Meta Description" hint={`Up to ${META_DESCRIPTION_MAX} characters. Blank uses the excerpt.`}><textarea name="meta_description" rows={2} maxlength={META_DESCRIPTION_MAX}>{v.meta_description ?? ''}</textarea></Field>
          <Field label="Publication date" hint="A future date schedules the post: it appears on the website from that day (India time). Blank uses today when you publish."><input type="date" name="published_at" value={v.published_at ?? ''} /></Field>
        </section>
        <div class="row wrap-row">
          {(!post || post.status !== 'published') && <button class="btn btn-outline" name="action" value="save">Save draft</button>}
          {post?.status === 'published' && <button class="btn" name="action" value="save">Save changes</button>}
          {(!post || post.status !== 'published') && <button class="btn" name="action" value="publish">Publish</button>}
          {post?.status === 'published' && <button class="btn btn-outline" name="action" value="unpublish" data-confirm="Unpublish this post? It will disappear from the website and the sitemap.">Unpublish</button>}
          {post && <a class="btn btn-outline" href={live ? `/blog/${post.slug}` : `/admin/blog/${post.id}/preview`} target="_blank" rel="noopener">{live ? 'View on website' : 'Preview'}</a>}
        </div>
      </form>
      {post && (
        <form method="post" action={`/admin/blog/${post.id}/delete`} class="card stack" data-confirm={`Delete “${post.title}” permanently? This cannot be undone.`}>
          <h2>Delete post</h2>
          {post.status === 'published'
            ? <p class="small muted">Unpublish this post before deleting it.</p>
            : <>
                <p class="small muted">Deleting removes the post, its old-link redirects and its featured image. Images inside the content stay in storage.</p>
                <label class="check"><input type="checkbox" name="confirm" value="1" required /> I understand this cannot be undone</label>
                <div><button class="btn btn-danger">Delete post</button></div>
              </>}
        </form>
      )}
    </div>
  ), status)
}

const blank: Values = { title: '', slug: '', excerpt: '', content_html: '', meta_title: null, meta_description: null, featured_image_alt: null, published_at: null }

adminBlogRoutes.get('/admin/blog/new', guard, (c) => postForm(c, null, blank))
adminBlogRoutes.get('/admin/blog/:id/edit', guard, async (c) => {
  const post = await load(c)
  return post ? postForm(c, post, post) : c.notFound()
})

// ---------- Save ----------
type Action = 'save' | 'publish' | 'unpublish'

async function save(c: Context<AppEnv>, before: BlogPost | null) {
  const body = await c.req.parseBody()
  const f = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')
  const action: Action = (['save', 'publish', 'unpublish'] as const).find((a) => a === f('action')) ?? 'save'
  const user = c.get('user')!
  const content = sanitizeHtml(f('content'), { siteUrl: c.env.SITE_URL, maxLength: BLOG_CONTENT_MAX * 2 })
  const v: Values = {
    title: str(f('title'), BLOG_TITLE_MAX),
    slug: normaliseSlug(f('slug').trim() || f('title')),
    excerpt: f('excerpt').replace(/\r\n/g, '\n').trim().slice(0, BLOG_EXCERPT_MAX),
    content_html: content,
    meta_title: str(f('meta_title'), META_TITLE_MAX) || null,
    meta_description: str(f('meta_description'), META_DESCRIPTION_MAX) || null,
    featured_image_alt: str(f('featured_image_alt'), BLOG_ALT_MAX) || null,
    published_at: isDate(f('published_at')) ? f('published_at') : null,
  }
  const fail = (err: string) => postForm(c, before, v, err, 400)
  if (before && f('version') && f('version') !== before.updated_at) return fail('Someone else saved this post while you were editing. Copy your changes, reload the page and try again.')
  if (!v.title) return fail('Enter a title.')
  if (!validSlug(v.slug)) return fail('Enter a URL slug of 3–80 lowercase letters, numbers and hyphens.')
  if (await slugTaken(c.env, v.slug, before?.id ?? null)) return fail(`The URL /blog/${v.slug} is already used by another post (or was used before and still redirects). Choose a different slug.`)
  if (content.length > BLOG_CONTENT_MAX) return fail('The content is too long. Split it into two posts.')
  if (f('published_at') && !v.published_at) return fail('Enter a valid publication date.')

  // Featured image: a new upload replaces the old one; "Remove image" clears it.
  const file = body.featured_image
  let imageKey = before?.featured_image_key ?? null
  let uploaded: string | null = null
  if (file instanceof File && file.size > 0) {
    if (file.size > IMAGE_MAX) return fail('The featured image must be 5 MB or smaller.')
    const type = await imageType(file)
    if (!type) return fail('The featured image must be a JPG, PNG, WebP, AVIF, GIF, BMP or APNG file.')
    uploaded = `blog/${crypto.randomUUID()}.${type.extension}`
    await c.env.MEDIA.put(uploaded, file.stream(), { httpMetadata: { contentType: type.contentType } })
    imageKey = uploaded
  } else if (f('remove_image') === '1') imageKey = null

  let status: BlogStatus = before?.status ?? 'draft'
  if (action === 'publish') status = 'published'
  if (action === 'unpublish') status = 'unpublished'
  if (status === 'published') {
    const missing = [!htmlToText(content) && !/<img /.test(content) && 'content', !v.excerpt && 'a short excerpt', imageKey && !v.featured_image_alt && 'alt text for the featured image'].filter(Boolean)
    if (missing.length) {
      if (uploaded) await c.env.MEDIA.delete(uploaded).catch(() => {})
      return fail(`To publish, add ${missing.join(', ')}.`)
    }
    v.published_at ??= todayIST()
  }
  const now = nowIso()
  const firstPublished = before?.first_published_at ?? (status === 'published' ? now : null)
  const cols = {
    ...v, featured_image_key: imageKey, status, first_published_at: firstPublished, updated_by: user.id, updated_at: now,
  }
  let id: number
  if (before) {
    id = before.id
    const res = await c.env.DB.prepare(`UPDATE blog_posts SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND updated_at = ?`)
      .bind(...Object.values(cols), id, before.updated_at).run()
    if (!res.meta.changes) {
      if (uploaded) await c.env.MEDIA.delete(uploaded).catch(() => {})
      return fail('Someone else saved this post while you were editing. Copy your changes, reload the page and try again.')
    }
    // Keep links to a post that has been public working when its slug changes; reclaiming an old slug drops its redirect.
    if (before.slug !== v.slug) {
      if (before.first_published_at) await run(c.env, 'INSERT OR REPLACE INTO blog_slug_redirects (old_slug, post_id) VALUES (?, ?)', before.slug, id)
      await run(c.env, 'DELETE FROM blog_slug_redirects WHERE old_slug = ? AND post_id = ?', v.slug, id)
    }
    if (before.featured_image_key && before.featured_image_key !== imageKey) await c.env.MEDIA.delete(before.featured_image_key).catch(() => {})
  } else {
    id = await insertId(c.env, `INSERT INTO blog_posts (${[...Object.keys(cols), 'created_by'].join(', ')}) VALUES (${[...Object.keys(cols), 'created_by'].map(() => '?').join(', ')})`, ...Object.values(cols), user.id)
  }
  const event = action === 'publish' ? 'blog.published' : action === 'unpublish' ? 'blog.unpublished' : before ? 'blog.updated' : 'blog.created'
  await logActivity(c.env, user.id, event, 'blog_post', id, { title: v.title, slug: v.slug, ...(before && before.slug !== v.slug ? { old_slug: before.slug } : {}) })
  const msg = action === 'publish'
    ? (v.published_at! > todayIST() ? `Scheduled: the post appears on the website on ${fmtDate(v.published_at)}.` : 'Published. The post is live on the website.')
    : action === 'unpublish' ? 'Unpublished. The post is no longer on the website.' : 'Saved.'
  return redirectMsg(c, `/admin/blog/${id}/edit`, { ok: msg })
}

// ---------- Images inside the content (registered before /admin/blog/:id) ----------
adminBlogRoutes.post('/admin/blog/upload', guard, async (c) => {
  const body = await c.req.parseBody()
  const file = body.image
  if (!(file instanceof File) || !file.size) return c.json({ error: 'Choose an image.' }, 400)
  if (file.size > IMAGE_MAX) return c.json({ error: 'Images must be 5 MB or smaller.' }, 400)
  const type = await imageType(file)
  if (!type) return c.json({ error: 'Use a JPG, PNG, WebP, AVIF, GIF, BMP or APNG image.' }, 400)
  const key = `blog/content/${crypto.randomUUID()}.${type.extension}`
  await c.env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type.contentType } })
  await logActivity(c.env, c.get('user')!.id, 'blog.image_uploaded', 'blog_post', null, { key })
  return c.json({ url: `/media/${key}` })
})

adminBlogRoutes.post('/admin/blog/new', guard, (c) => save(c, null))
adminBlogRoutes.post('/admin/blog/:id', guard, async (c) => {
  const post = await load(c)
  return post ? save(c, post) : c.notFound()
})

// ---------- Delete ----------
adminBlogRoutes.post('/admin/blog/:id/delete', guard, async (c) => {
  const post = await load(c)
  if (!post) return c.notFound()
  const body = await c.req.parseBody()
  if (post.status === 'published') return redirectMsg(c, `/admin/blog/${post.id}/edit`, { err: 'Unpublish the post before deleting it.' })
  if (body.confirm !== '1') return redirectMsg(c, `/admin/blog/${post.id}/edit`, { err: 'Tick “I understand this cannot be undone” to delete the post.' })
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM blog_slug_redirects WHERE post_id = ?').bind(post.id),
    c.env.DB.prepare("DELETE FROM blog_posts WHERE id = ? AND status != 'published'").bind(post.id),
  ])
  if (post.featured_image_key) await c.env.MEDIA.delete(post.featured_image_key).catch(() => {})
  await logActivity(c.env, c.get('user')!.id, 'blog.deleted', 'blog_post', post.id, { title: post.title, slug: post.slug })
  return redirectMsg(c, '/admin/blog', { ok: `Deleted “${post.title}”.` })
})

// ---------- Preview (drafts, unpublished and scheduled posts; never indexed) ----------
adminBlogRoutes.get('/admin/blog/:id/preview', guard, async (c) => {
  const post = await load(c)
  if (!post) return c.notFound()
  return renderPost(c, post, true)
})

