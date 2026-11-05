import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../env'
import { rateLimit, requirePerm, requireStaff } from '../lib/auth'
import { all, first } from '../lib/db'
import { int, nowIso, randomToken, sha256Hex, str } from '../lib/util'
import { Field, Pager, Table } from '../views/components'
import { page } from '../views/layout'

export const propertyReviewLinkRoutes = new Hono<AppEnv>()
const path = '/staff/review-links'
propertyReviewLinkRoutes.use(path + '*', requireStaff, requirePerm('manage_bookings'), async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})

propertyReviewLinkRoutes.get(path, async c => {
  const user = c.get('user')!
  const q = str(c.req.query('q'), 100)
  const pg = Math.max(1, int(c.req.query('page'), 1))
  const search = '%' + q.replace(/[\\%_]/g, '\\$&') + '%'
  const properties = await all<{ id: number; name: string; destination: string }>(c.env,
    "SELECT id,name,destination FROM properties WHERE status='live' AND (name LIKE ? ESCAPE '\\' OR destination LIKE ? ESCAPE '\\') ORDER BY name,id LIMIT 100", search, search)
  const links = await all<{ id: number; property_name: string; creator: string; expires_at: string; revoked_at: string | null; review_id: number | null }>(c.env,
    `SELECT l.id,p.name AS property_name,u.name AS creator,l.expires_at,l.revoked_at,r.id AS review_id
     FROM property_review_links l JOIN properties p ON p.id=l.property_id JOIN users u ON u.id=l.created_by
     LEFT JOIN reviews r ON r.property_review_link_id=l.id
     WHERE (l.created_by=? OR ?=1) ORDER BY l.id DESC LIMIT 31 OFFSET ?`, user.id, Number(user.role === 'admin'), (pg-1)*30)
  return page(c, { title: 'Review Links', area: user.role === 'admin' ? 'admin' : 'staff', active: 'review-links', noindex: true }, (
    <div class="stack-lg">
      <h1>Review Links</h1>
      <section class="card stack">
        <h2>Generate Review Link</h2>
        <p>Choose a Live property and share one private link with one guest. No booking, login or OTP is required. Links expire after 30 days and accept one review, subject to Admin moderation.</p>
        <form method="get" action={path} class="row wrap-row">
          <Field label="Find a property"><input name="q" value={q} placeholder="Property or destination" maxlength={100} /></Field>
          <button class="btn btn-outline">Search</button>
        </form>
        <form method="post" action={path} class="stack">
          <Field label="Live property"><select name="property_id" required><option value="">Select a property</option>{properties.map(p => <option value={p.id}>{p.name} — {p.destination}</option>)}</select></Field>
          {!properties.length && <p class="muted">No matching Live properties. Try another search.</p>}
          <p class="small muted">Search to narrow the first 100 results. A generated link is shown once; if lost, revoke it and generate another.</p>
          <button class="btn" disabled={!properties.length}>Generate Review Link</button>
        </form>
      </section>
      <section class="card stack"><h2>{user.role === 'admin' ? 'All property review links' : 'Your property review links'}</h2>
        <Table head={['Property','Created by','Expires','Status','Action']}>{links.slice(0,30).map(l => {
          const status = l.review_id ? 'Submitted' : l.revoked_at ? 'Revoked' : l.expires_at <= nowIso() ? 'Expired' : 'Active'
          return <tr><td>{l.property_name}</td><td>{l.creator}</td><td>{l.expires_at.slice(0,10)}</td><td>{status}</td><td>{status === 'Active' && <form method="post" action={`${path}/${l.id}/revoke`}><button class="btn btn-sm btn-outline">Revoke Link</button></form>}</td></tr>
        })}</Table>
        {!links.length && <p class="muted">No review links yet.</p>}
        <Pager page={pg} hasMore={links.length>30} base={path + '?q=' + encodeURIComponent(q)} />
      </section>
    </div>
  ))
})

propertyReviewLinkRoutes.post(path, bodyLimit({ maxSize: 2048 }), async c => {
  const user = c.get('user')!
  if (!(await rateLimit(c.env, `property-review-issue:${user.id}`, 40, 3600))) return c.text('Too many requests. Try later.', 429)
  const body = await c.req.parseBody()
  const id = typeof body.property_id === 'string' && /^[1-9]\d*$/.test(body.property_id) ? Number(body.property_id) : 0
  if (!Number.isSafeInteger(id) || id <= 0) return c.text('Select a Live property.', 400)
  const token = randomToken(32)
  const link = await first<{ id: number; property_id: number }>(c.env,
    `INSERT INTO property_review_links(property_id,created_by,token_hash,expires_at)
     SELECT id,?,?,? FROM properties WHERE id=? AND status='live' RETURNING id,property_id`,
    user.id, await sha256Hex(token), new Date(Date.now()+30*86400000).toISOString(), id)
  if (!link) return c.text('Select a Live property.', 409)
  const property = await first<{ name: string }>(c.env,'SELECT name FROM properties WHERE id=?', link.property_id)
  const url = new URL('/review-stay#'+token, c.env.SITE_URL).href
  return page(c, { title: 'Share review link', area: user.role === 'admin' ? 'admin' : 'staff', active: 'review-links', noindex: true }, (
    <section class="card stack narrow">
      <h1>Review link for {property?.name}</h1>
      <p>Expires in 30 days. Share privately with one guest. The link allows one submission and does not verify a completed stay.</p>
      <Field label="Review link"><input readonly value={url} /></Field>
      <div class="row wrap-row"><button type="button" class="btn btn-outline" data-copy-review-link={url}>Copy Link</button>
        <a class="btn btn-wa" href={'https://wa.me/?text='+encodeURIComponent(`Hi! Thank you for choosing Go Sanchari. How was your stay at ${property?.name || 'the resort'}? Please share your feedback here: ${url}`)} target="_blank" rel="noopener noreferrer">Share via WhatsApp</a></div>
      <form method="post" action={`${path}/${link.id}/revoke`}><button class="btn btn-outline">Revoke Link</button></form>
      <a href={path}>Back to Review Links</a>
    </section>
  ))
})

propertyReviewLinkRoutes.post(path+'/:id/revoke', bodyLimit({ maxSize: 1024 }), async c => {
  const user = c.get('user')!
  const link = await first(c.env, `UPDATE property_review_links SET revoked_at=?,revoked_by=?
    WHERE id=? AND (created_by=? OR ?=1) AND revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM reviews WHERE property_review_link_id=property_review_links.id) RETURNING id`,
    nowIso(), user.id, int(c.req.param('id')), user.id, Number(user.role === 'admin'))
  if (!link) return c.text('Link unavailable, already submitted or already revoked.',409)
  return c.redirect(path+'?ok=Review+link+revoked',303)
})
