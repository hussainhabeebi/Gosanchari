import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../env'
import { permissionsFor, rateLimit, requirePerm, requireStaff } from '../lib/auth'
import { reviewEligibleSql, reviewPhotoKey, reviewStay } from '../lib/booking-reviews'
import { enqueue, first, logActivity } from '../lib/db'
import { propertyImageType } from '../lib/property-images'
import { int, nowIso, randomToken, sha256Hex, todayIST } from '../lib/util'
import { Field } from '../views/components'
import { page } from '../views/layout'

export const bookingReviewRoutes = new Hono<AppEnv>()
const staffPath = '/staff/bookings/:id/review-link'
const guestPath = '/review-stay'
const maxPhoto = 4 * 1024 * 1024
const photoTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
const ip = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') || 'unknown'
const bookingPath = (id: number) => '/staff/bookings/' + id

bookingReviewRoutes.use(staffPath, async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return next()
})
bookingReviewRoutes.post(staffPath, requireStaff, requirePerm('manage_bookings'), async c => {
  const user = c.get('user')!
  const id = int(c.req.param('id'))
  const accessAll = user.role === 'admin'
  const action = (await c.req.parseBody()).action
  if (action !== 'issue' && action !== 'revoke') return c.text('Invalid action.', 400)
  const owner = '(b.staff_id = ? OR ? = 1)'
  const scope = [id, user.id, Number(accessAll)] as const
  if (action === 'revoke') {
    const removed = await first<{ booking_id: number }>(c.env, `DELETE FROM booking_review_links WHERE booking_id IN
      (SELECT b.id FROM bookings b WHERE b.id=? AND ${owner}) RETURNING booking_id`, ...scope)
    if (!removed) return c.notFound()
    await logActivity(c.env, user.id, 'review_link.revoked', 'booking', id)
    return c.redirect(bookingPath(id), 303)
  }
  if (!(await rateLimit(c.env, `review-link-issue:${user.id}`, 40, 3600))) return c.text('Too many requests.', 429)
  const token = randomToken(32)
  const issued = await first<{ booking_id: number }>(c.env, `INSERT INTO booking_review_links (booking_id,property_id,token_hash,expires_at)
    SELECT b.id,b.property_id,?,? FROM bookings b JOIN properties p ON p.id=b.property_id
    WHERE b.id=? AND ${owner} AND ${reviewEligibleSql}
    ON CONFLICT(booking_id) DO UPDATE SET property_id=excluded.property_id, token_hash=excluded.token_hash, expires_at=excluded.expires_at RETURNING booking_id`,
    await sha256Hex(token), new Date(Date.now() + 30 * 86400000).toISOString(), ...scope, todayIST())
  if (!issued) return c.text('This booking is not eligible for a review link.', 409)
  await logActivity(c.env, user.id, 'review_link.issued', 'booking', id)
  const url = new URL('/review-stay#' + token, c.env.SITE_URL).href
  return page(c, { title: 'Send review link', area: 'staff', active: 'bookings', noindex: true }, (
    <section class="card stack narrow">
      <h1>Send review link</h1>
      <p>Share this private link with the guest. It expires in 30 days and replaces any earlier link. Guests can submit once without signing in. Share it only with the guest.</p>
      <Field label="Review link"><input value={url} readonly /></Field>
      <div class="row wrap-row">
        <button type="button" class="btn btn-outline" data-copy-review-link={url}>Copy Review Link</button>
        <a class="btn btn-wa" href={`https://wa.me/?text=${encodeURIComponent('How was your Go Sanchari stay? Share your review: ' + url)}`} rel="noopener noreferrer" target="_blank">Share via WhatsApp</a>
      </div>
      <form method="post" action={`/staff/bookings/${id}/review-link`}><button class="btn btn-outline" name="action" value="revoke">Revoke review link</button></form>
      <a href={bookingPath(id)}>Back to booking</a>
    </section>
  ))
})

bookingReviewRoutes.use('/review-stay/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  // Signed-in staff may open guest review links too (e.g. to test them);
  // the link token alone authorises the one review submission.
  return next()
})

function unavailable(c: Context<AppEnv>) {
  return c.text('This review link is no longer available. Ask Go Sanchari for help.', 404)
}
function reviewForm(c: Context<AppEnv>, name: string, hash: string) {
  return page(c, { title: 'Review your stay', noindex: true }, (
    <section class="card stack narrow">
      <h1>How was {name}?</h1>
      <form method="post" action={guestPath} enctype="multipart/form-data" class="stack">
        <input type="hidden" name="invite" value={hash} />
        <div hidden><label>Leave this field empty <input name="website" tabindex={-1} autocomplete="off" /></label></div>
        <Field label="Your name"><input name="guest_name" autocomplete="name" maxlength={80} required /></Field>
        <fieldset class="stack"><legend>Rating</legend><div class="row wrap-row">{[1,2,3,4,5].map(n => <label><input type="radio" name="rating" value={n} required /> {n} ★</label>)}</div></fieldset>
        <Field label="Your review"><textarea name="body" rows={5} maxlength={2000} required /></Field>
        <Field label="Photos (optional, up to 4, 4 MB each)"><input type="file" name="photos" accept="image/jpeg,image/png,image/webp,image/avif" multiple /></Field>
        <p class="small muted">Please don’t include personal contact or booking details. Your name, feedback and photos may appear publicly after moderation.</p>
        <button class="btn">Submit review</button>
      </form>
    </section>
  ))
}

async function lookup(c: Context<AppEnv>) {
  const token = getCookie(c, 'gs_review_invite') ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const hash = await sha256Hex(token)
  const stay = await reviewStay(c.env, hash)
  return stay ? { hash, stay } : null
}

bookingReviewRoutes.get('/review-stay/thanks', c => page(c, { title: 'Thank you', noindex: true }, (
  <section class="card stack narrow"><h1>Thank you for your review</h1><p>Our team will check it before it appears on the resort page.</p></section>
)))

bookingReviewRoutes.get(guestPath, async c => {
  const found = await lookup(c)
  if (!found) return page(c, { title: 'Open your review link', noindex: true }, (
    <section class="card stack narrow"><h1>Review your stay</h1>
      <p>Open the private review link shared by Go Sanchari. If it no longer works, ask our team for a new one.</p>
      <noscript>Enable JavaScript to open the review link.</noscript>
    </section>
  ))
  return reviewForm(c, found.stay.property_name, found.hash)
})

bookingReviewRoutes.post(guestPath + '/open', bodyLimit({ maxSize: 1024 }), async c => {
  if (!(await rateLimit(c.env, `review-open-ip:${ip(c)}`, 60, 3600))) return c.text('Too many requests. Try later.', 429)
  const token = (await c.req.parseBody().catch(() => ({} as Record<string, string>))).token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !(await reviewStay(c.env, await sha256Hex(token)))) return unavailable(c)
  setCookie(c, 'gs_review_invite', token, {
    path: guestPath, httpOnly: true, secure: c.env.ENVIRONMENT === 'production' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict', maxAge: 86400,
  })
  return c.redirect(guestPath, 303)
})

bookingReviewRoutes.post(guestPath, bodyLimit({ maxSize: 17 * 1024 * 1024 }), async c => {
  if (!(await rateLimit(c.env, `review-submit-ip:${ip(c)}`, 30, 3600))) return c.text('Too many requests. Try later.', 429)
  const found = await lookup(c)
  if (!found) return unavailable(c)
  const { hash } = found
  const fields = await c.req.parseBody({ all: true }).catch(() => null)
  if (!fields) return c.text('Invalid review form.', 400)
  if (fields.invite !== hash) return unavailable(c)
  if (fields.website != null && fields.website !== '') return c.text('Invalid review form.', 400)
  const { rating } = fields
  const name = typeof fields.guest_name === 'string' ? fields.guest_name.trim() : ''
  const feedback = typeof fields.body === 'string' ? fields.body.trim() : ''
  if (!name || name.length > 80 || typeof rating !== 'string' || !/^[1-5]$/.test(rating) || !feedback || feedback.length > 2000) {
    return c.text('Enter your name, a rating from 1 to 5, and feedback.', 400)
  }
  const files = (Array.isArray(fields.photos) ? fields.photos : [fields.photos]).filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length > 4 || files.some(f => f.size > maxPhoto)) return c.text('Upload up to four photos, each no larger than 4 MB.', 400)
  const photos: { key: string; file: File; type: string }[] = []
  for (const file of files) {
    // Force content sniffing rather than trusting the browser-supplied MIME.
    const signature = new File([file.slice(0, 4096)], '', { type: 'application/octet-stream' })
    const image = await propertyImageType(signature)
    if (!image || !photoTypes.has(image.contentType)) return c.text('Use JPEG, PNG, WebP or AVIF photos.', 400)
    photos.push({ key: `private/booking-review-photos/${crypto.randomUUID()}.${image.extension}`, file, type: image.contentType })
  }
  const keys = photos.map(p => p.key)
  const cleanup = () => keys.length ? c.env.MEDIA.delete(keys).catch(() => {}) : Promise.resolve()
  let review: { id: number } | null
  try {
    for (const photo of photos) await c.env.MEDIA.put(photo.key, photo.file.stream(), { httpMetadata: { contentType: photo.type } })
  } catch {
    await cleanup()
    return c.text('Photo upload failed. Please try again.', 503)
  }
  try {
    review = found.stay.kind === 'property' ? await first<{ id: number }>(c.env, `INSERT INTO reviews (property_review_link_id,property_id,guest_name,rating,body,photos)
      SELECT l.id,l.property_id,?,?,?,? FROM property_review_links l JOIN properties p ON p.id=l.property_id
      WHERE l.token_hash=? AND l.expires_at>? AND l.revoked_at IS NULL AND p.status='live'
      AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.property_review_link_id=l.id)
      ON CONFLICT DO NOTHING RETURNING id`, name, Number(rating), feedback, JSON.stringify(keys), hash, nowIso())
      : await first<{ id: number }>(c.env, `INSERT INTO reviews (booking_id,property_id,guest_name,rating,body,photos)
      SELECT b.id,b.property_id,?,?,?,? FROM booking_review_links l
      JOIN bookings b ON b.id=l.booking_id AND b.property_id=l.property_id JOIN properties p ON p.id=b.property_id
      WHERE l.token_hash=? AND l.expires_at>? AND ${reviewEligibleSql}
      ON CONFLICT(booking_id) DO NOTHING RETURNING id`,
      name, Number(rating), feedback, JSON.stringify(keys), hash, nowIso(), todayIST())
  } catch (error) {
    // A remote write may have committed before a transport failure. Keep files
    // private rather than risk deleting photos attached to a committed review.
    throw error
  }
  if (!review) { await cleanup(); return unavailable(c) }
  await Promise.allSettled([enqueue(c.env, { type: 'review_check', reviewId: review.id }), enqueue(c.env, { type: 'review_reply_draft', reviewId: review.id })])
  return c.redirect('/review-stay/thanks', 303)
})

bookingReviewRoutes.get('/media/private/booking-review-photos/:file', async c => {
  const key = 'private/booking-review-photos/' + c.req.param('file')
  if (!reviewPhotoKey.test(key)) return c.notFound()
  const user = c.get('user')
  const moderator = user && user.role !== 'guest' && (await permissionsFor(c.env, user.role)).manage_reviews
  if (!(await first(c.env, `SELECT 1 FROM reviews r JOIN properties p ON p.id=r.property_id
    WHERE (?=1 OR (r.status='approved' AND p.status='live')) AND EXISTS (SELECT 1 FROM json_each(r.photos) WHERE value=?) LIMIT 1`,
    Number(!!moderator), key))) return c.notFound()
  const photo = await c.env.MEDIA.get(key)
  if (!photo) return c.notFound()
  const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
  photo.writeHttpMetadata(headers)
  return new Response(photo.body, { headers })
})
