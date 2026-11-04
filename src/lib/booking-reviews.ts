import type { Env } from '../env'
import { first } from './db'
import { isDate, normalizePhone, nowIso, todayIST } from './util'

export const reviewEligibleSql = "b.status = 'completed' AND b.check_out < ? AND p.status = 'live' AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)"
export const reviewPhotoKey = /^private\/booking-review-photos\/[a-f0-9-]{36}\.(jpg|png|webp|avif)$/
export const isReviewCheckoutPast = (date: string) => isDate(date) && date < todayIST()

export async function reviewOtpHash(secret: string, tokenHash: string, phone: string, code: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['booking-review', tokenHash, phone, code])))
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')
}

export interface ReviewStay {
  booking_id: number
  property_id: number
  guest_phone: string
  property_name: string
  otp_hash: string | null
  otp_expires_at: string | null
}
export function reviewStay(env: Env, hash: string) {
  return first<ReviewStay>(env, `SELECT l.booking_id, l.property_id, b.guest_phone, p.name AS property_name, l.otp_hash, l.otp_expires_at
    FROM booking_review_links l JOIN bookings b ON b.id=l.booking_id AND b.property_id=l.property_id
    JOIN properties p ON p.id=b.property_id
    WHERE l.token_hash=? AND l.expires_at>? AND ${reviewEligibleSql}`, hash, nowIso(), todayIST())
}

export async function guestVerificationPhone(env: Env, rawPhone: string) {
  const phone = normalizePhone(rawPhone)
  if (!phone || !/^\+[1-9][0-9]{9,14}$/.test(phone)) return null
  const digits = phone.slice(1)
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits
  if (await first(env, "SELECT 1 FROM users WHERE role != 'guest' AND phone IN (?,?,?,?,?)", phone, digits, '00'+digits, local, '0'+local)) return null
  return phone
}

export const reviewInviteExpiry = () => new Date(Date.now() + 30 * 86400000).toISOString()
export const reviewInviteUrl = (env: Env, token: string) => new URL('/review-stay#' + token, env.SITE_URL).href
