import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../env'
import { rateLimit } from '../lib/auth'
import { guestVerificationPhone, reviewEligibleSql, reviewInviteExpiry, reviewInviteUrl, reviewStay } from '../lib/booking-reviews'
import { first, run } from '../lib/db'
import { sendWhatsApp, whatsappConfigured } from '../lib/integrations'
import { normalizePhone, nowIso, randomToken, sha256Hex, timingSafeEqual, todayIST } from '../lib/util'

export const reviewBotRoutes = new Hono<AppEnv>()

// A separate capability: read-only property API keys and staff cookies do not authorize dispatch.
reviewBotRoutes.post('/integrations/review-bot/dispatch', bodyLimit({ maxSize: 2048 }), async c => {
  c.header('Cache-Control', 'no-store')
  const auth = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(c.req.header('Authorization') ?? '')
  const expected = c.env.REVIEW_BOT_KEY_SHA256
  if (!auth || !expected || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(await sha256Hex(auth[1]), expected)) {
    return c.json({ status: 'unauthorized' }, 401)
  }
  const template = c.env.REVIEW_BOT_WHATSAPP_TEMPLATE
  if (c.env.REVIEW_BOT_SEND_ENABLED !== 'true' || !template || !/^[a-z0-9_]{1,128}$/.test(template) || template === 'otp' ||
      !c.env.SESSION_SECRET || !whatsappConfigured(c.env)) {
    return c.json({ status: 'disabled' }, 503)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ status: 'invalid_request' }, 415)
  const input = await c.req.json().catch(() => null)
  const code = input?.booking_code
  const sender = input?.whatsapp_number
  if (typeof code !== 'string' || !/^[A-Z0-9-]{4,64}$/.test(code) || typeof sender !== 'string' || !/^\+?[1-9]\d{9,14}$/.test(sender)) {
    return c.json({ status: 'invalid_request' }, 400)
  }
  if (!(await rateLimit(c.env, 'review-bot-dispatch', 60, 60))) return c.json({ status: 'rate_limited' }, 429)

  const booking = await first<{ id: number; guest_phone: string }>(c.env,
    `SELECT b.id,b.guest_phone FROM bookings b JOIN properties p ON p.id=b.property_id
     WHERE b.code=? AND ${reviewEligibleSql}`, code, todayIST())
  const phone = booking && await guestVerificationPhone(c.env, booking.guest_phone)
  if (!booking || !phone || normalizePhone(sender) !== phone) return c.json({ status: 'not_eligible' }, 404)

  // Durable claim before sending. A retry, crash, or ambiguous provider timeout must
  // never send a second message. Staff can resolve an unsuccessful attempt manually.
  const claim = await first(c.env, `INSERT INTO booking_review_deliveries(booking_id,status,created_at,updated_at)
    SELECT b.id,'pending',?,? FROM bookings b JOIN properties p ON p.id=b.property_id
    WHERE b.id=? AND b.guest_phone=? AND ${reviewEligibleSql}
      AND NOT EXISTS (SELECT 1 FROM booking_review_links l WHERE l.booking_id=b.id)
    ON CONFLICT(booking_id) DO NOTHING RETURNING booking_id`, nowIso(), nowIso(), booking.id, booking.guest_phone, todayIST())
  if (!claim) {
    const existing = await first<{status:string}>(c.env, 'SELECT status FROM booking_review_deliveries WHERE booking_id=?', booking.id)
    return c.json({ status: existing?.status ?? 'not_issued', duplicate: !!existing })
  }

  const finish = (status: 'sent' | 'failed' | 'skipped', id: string | null = null) => run(c.env,
    'UPDATE booking_review_deliveries SET status=?,provider_message_id=?,updated_at=? WHERE booking_id=? AND status=\'pending\'',
    status, id, nowIso(), booking.id)
  const token = randomToken(32), hash = await sha256Hex(token)
  const issued = await first(c.env, `INSERT INTO booking_review_links(booking_id,property_id,token_hash,expires_at)
    SELECT b.id,b.property_id,?,? FROM bookings b JOIN properties p ON p.id=b.property_id
    WHERE b.id=? AND b.guest_phone=? AND ${reviewEligibleSql}
    ON CONFLICT(booking_id) DO NOTHING RETURNING booking_id`, hash, reviewInviteExpiry(), booking.id, booking.guest_phone, todayIST())
  const stay = issued && await reviewStay(c.env, hash)
  if (!stay || stay.guest_phone !== booking.guest_phone) {
    await finish('skipped')
    return c.json({ status: 'skipped' })
  }

  // No raw URL or phone in the bot response or delivery ledger. The server
  // sends the approved template directly to the verified booking recipient.
  const sent = await sendWhatsApp(c.env, phone, '', { name: template, params: [reviewInviteUrl(c.env, token)] })
  const accepted = sent.ok && typeof sent.id === 'string' && !!sent.id
  await finish(accepted ? 'sent' : 'failed', accepted ? sent.id! : null)
  return c.json({ status: accepted ? 'sent' : 'failed' }, accepted ? 200 : 502)
})
