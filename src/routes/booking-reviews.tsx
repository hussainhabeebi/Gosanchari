import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../env'
import { permissionsFor, rateLimit, requirePerm, requireStaff } from '../lib/auth'
import { reviewEligibleSql, reviewOtpHash, reviewPhotoKey, reviewStay } from '../lib/booking-reviews'
import { enqueue, first, logActivity, run } from '../lib/db'
import { sendWhatsApp, whatsappConfigured } from '../lib/integrations'
import { propertyImageType } from '../lib/property-images'
import { int, normalizePhone, nowIso, randomToken, sha256Hex, todayIST } from '../lib/util'
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
  if (!c.env.SESSION_SECRET || !whatsappConfigured(c.env)) return c.text('Guest review verification is not configured. Contact an administrator.', 503)
  if (!(await rateLimit(c.env, `review-link-issue:${user.id}`, 40, 3600))) return c.text('Too many requests.', 429)
  const booking = await first<{ guest_phone: string }>(c.env, `SELECT b.guest_phone FROM bookings b JOIN properties p ON p.id=b.property_id
    WHERE b.id=? AND ${owner} AND ${reviewEligibleSql}`, ...scope, todayIST())
  if (!booking) return c.text('This booking is not eligible for a review link.', 409)
  if (!(await guestVerificationPhone(c, booking.guest_phone))) return c.text('A valid guest WhatsApp number is required for review verification.', 422)
  const token = randomToken(32)
  const issued = await first<{ booking_id: number }>(c.env, `INSERT INTO booking_review_links (booking_id,property_id,token_hash,expires_at)
    SELECT b.id,b.property_id,?,? FROM bookings b JOIN properties p ON p.id=b.property_id
    WHERE b.id=? AND ${owner} AND ${reviewEligibleSql} AND b.guest_phone=?
    ON CONFLICT(booking_id) DO UPDATE SET property_id=excluded.property_id, token_hash=excluded.token_hash, expires_at=excluded.expires_at,
      otp_hash=NULL, otp_expires_at=NULL, otp_sent_at=NULL, otp_attempts=0 RETURNING booking_id`,
    await sha256Hex(token), new Date(Date.now() + 30 * 86400000).toISOString(), ...scope, todayIST(), booking.guest_phone)
  if (!issued) return c.text('This booking is not eligible for a review link.', 409)
  await logActivity(c.env, user.id, 'review_link.issued', 'booking', id)
  const url = new URL('/review-stay#' + token, c.env.SITE_URL).href
  return page(c, { title: 'Send review link', area: 'staff', active: 'bookings', noindex: true }, (
    <section class="card stack narrow">
      <h1>Send review link</h1>
      <p>Share this private link with the guest. It expires in 30 days and replaces any earlier link. Guests verify their booking phone without signing in.</p>
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
  const user = c.get('user')
  if (user && user.role !== 'guest') return c.text('Only guests can use this review link.', 403)
  return next()
})

function unavailable(c: Context<AppEnv>) {
  return c.text('This review link is no longer available. Ask Go Sanchari for help.', 404)
}
function reviewForm(c: Context<AppEnv>, name: string, hash: string, step: 'code' | 'review') {
  const path = guestPath
  return page(c, { title: 'Review your stay', noindex: true }, (
    <section class="card stack narrow">
      <h1>How was {name}?</h1>
      {step === 'code' ? <>
        <p>We’ll send a verification code to the WhatsApp number on your booking. No account is required.</p>
        <form method="post" action={path + '/code'}><input type="hidden" name="invite" value={hash} /><button class="btn">Send verification code</button></form>
      </> : <>
        <p>Enter the code sent to the WhatsApp number on your booking. It expires in 10 minutes.</p>
        <form method="post" action={path} enctype="multipart/form-data" class="stack">
          <input type="hidden" name="invite" value={hash} />
          <Field label="Verification code"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength={6} required /></Field>
          <fieldset class="stack"><legend>Rating</legend><div class="row wrap-row">{[1,2,3,4,5].map(n => <label><input type="radio" name="rating" value={n} required /> {n} ★</label>)}</div></fieldset>
          <Field label="Your review"><textarea name="body" rows={5} maxlength={2000} required /></Field>
          <Field label="Photos (optional, up to 4, 4 MB each)"><input type="file" name="photos" accept="image/jpeg,image/png,image/webp,image/avif" multiple /></Field>
          <p class="small muted">Please don’t include personal or booking details. Your review is checked by our team before it appears publicly.</p>
          <button class="btn">Submit review</button>
        </form>
        <form method="post" action={path + '/code'}><input type="hidden" name="invite" value={hash} /><button class="btn btn-outline">Send a new code</button></form>
      </>}
    </section>
  ))
}

async function guestVerificationPhone(c: Context<AppEnv>, rawPhone: string) {
  const phone = normalizePhone(rawPhone)
  if (!phone || !/^\+[1-9][0-9]{9,14}$/.test(phone)) return null
  const digits = phone.slice(1)
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  if (await first(c.env, "SELECT 1 FROM users WHERE role != 'guest' AND phone IN (?,?,?,?,?)", phone, digits, '00'+digits, local, '0'+local)) return null
  return phone
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
  return reviewForm(c, found.stay.property_name, found.hash, found.stay.otp_expires_at && found.stay.otp_expires_at > nowIso() ? 'review' : 'code')
})

bookingReviewRoutes.post(guestPath + '/open', bodyLimit({ maxSize: 1024 }), async c => {
  const token = (await c.req.parseBody().catch(() => ({} as Record<string, string>))).token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !(await reviewStay(c.env, await sha256Hex(token)))) return unavailable(c)
  setCookie(c, 'gs_review_invite', token, {
    path: guestPath, httpOnly: true, secure: c.env.ENVIRONMENT === 'production' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict', maxAge: 86400,
  })
  return c.redirect(guestPath, 303)
})

bookingReviewRoutes.post(guestPath + '/code', bodyLimit({ maxSize: 1024 }), async c => {
  const secret = c.env.SESSION_SECRET
  if (!secret || !whatsappConfigured(c.env)) return c.text('Verification is temporarily unavailable.', 503)
  if (!(await rateLimit(c.env, `review-code-ip:${ip(c)}`, 12, 3600))) return c.text('Too many requests. Try later.', 429)
  const found = await lookup(c)
  if (!found) return unavailable(c)
  const { hash, stay } = found
  if ((await c.req.parseBody().catch(() => ({} as Record<string, string>))).invite !== hash) return unavailable(c)
  const phone = await guestVerificationPhone(c, stay.guest_phone)
  if (!phone) return c.text('This booking cannot be verified. Please contact Go Sanchari.', 422)
  if (!(await rateLimit(c.env, `review-code-booking:${stay.booking_id}`, 4, 3600))) return c.text('Too many requests. Try later.', 429)
  // Rejection sampling avoids modulo bias in the six-digit code.
  const buffer = new Uint32Array(1)
  do { crypto.getRandomValues(buffer) } while (buffer[0] >= 4294000000)
  const code = String(buffer[0] % 1000000).padStart(6, '0')
  const otpHash = await reviewOtpHash(secret, hash, phone, code)
  const updated = await first(c.env, `UPDATE booking_review_links SET otp_hash=?,otp_expires_at=?,otp_sent_at=?,otp_attempts=0
    WHERE token_hash=? AND expires_at>? AND (otp_sent_at IS NULL OR otp_sent_at<=?) RETURNING booking_id`,
    otpHash, new Date(Date.now()+600000).toISOString(), nowIso(), hash, nowIso(), new Date(Date.now()-60000).toISOString())
  if (!updated) return c.text('Please wait one minute before requesting another code.', 429)
  const sent = await sendWhatsApp(c.env, phone, `Your Go Sanchari review verification code is ${code}.`, { name: 'otp', params: [code], copyCode: code })
  if (!sent.ok) {
    await run(c.env, 'UPDATE booking_review_links SET otp_hash=NULL,otp_expires_at=NULL WHERE token_hash=? AND otp_hash=?', hash, otpHash)
    return c.text('We could not send a verification code. Try again later or contact Go Sanchari.', 503)
  }
  return c.redirect(guestPath, 303)
})

bookingReviewRoutes.post(guestPath, bodyLimit({ maxSize: 17 * 1024 * 1024 }), async c => {
  const secret = c.env.SESSION_SECRET
  if (!secret) return c.text('Verification is temporarily unavailable.', 503)
  if (!(await rateLimit(c.env, `review-submit-ip:${ip(c)}`, 30, 3600))) return c.text('Too many requests. Try later.', 429)
  const found = await lookup(c)
  if (!found) return unavailable(c)
  const { hash, stay } = found
  const fields = await c.req.parseBody({ all: true }).catch(() => null)
  if (!fields) return c.text('Invalid review form.', 400)
  if (fields.invite !== hash) return unavailable(c)
  const { code, rating } = fields
  const feedback = typeof fields.body === 'string' ? fields.body.trim() : ''
  if (typeof rating !== 'string' || !/^[1-5]$/.test(rating) || !feedback || feedback.length > 2000 || typeof code !== 'string' || !/^\d{6}$/.test(code)) return c.text('Enter a rating, review and six-digit verification code.', 400)
  const phone = await guestVerificationPhone(c, stay.guest_phone)
  if (!phone) return unavailable(c)
  const codeHash = await reviewOtpHash(secret, hash, phone, code)
  const attempt = await first<{ valid: number }>(c.env, `UPDATE booking_review_links SET otp_attempts=otp_attempts+1
    WHERE token_hash=? AND otp_expires_at>? AND otp_attempts<5 RETURNING (otp_hash=?) AS valid`, hash, nowIso(), codeHash)
  if (!attempt?.valid) return c.text('Verification code is incorrect or expired. Request a new code if needed.', 403)
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
    review = await first<{ id: number }>(c.env, `INSERT INTO reviews (booking_id,property_id,guest_name,rating,body,photos)
      SELECT b.id,b.property_id,'Verified guest',?,?,? FROM booking_review_links l
      JOIN bookings b ON b.id=l.booking_id AND b.property_id=l.property_id JOIN properties p ON p.id=b.property_id
      WHERE l.token_hash=? AND l.expires_at>? AND l.otp_hash=? AND l.otp_expires_at>? AND b.guest_phone=? AND ${reviewEligibleSql}
      ON CONFLICT(booking_id) DO NOTHING RETURNING id`,
      Number(rating), feedback, JSON.stringify(keys), hash, nowIso(), codeHash, nowIso(), stay.guest_phone, todayIST())
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
