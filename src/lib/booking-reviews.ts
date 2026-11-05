import type { Env } from '../env'
import { first } from './db'
import { isDate, nowIso, todayIST } from './util'

export const reviewEligibleSql = "b.status = 'completed' AND b.check_out < ? AND p.status = 'live' AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)"
export const reviewPhotoKey = /^private\/booking-review-photos\/[a-f0-9-]{36}\.(jpg|png|webp|avif)$/
export const isReviewCheckoutPast = (date: string) => isDate(date) && date < todayIST()

export function reviewStay(env: Env, hash: string) {
  return first<{ property_name: string; kind: 'booking' | 'property' }>(env, `SELECT p.name AS property_name, 'booking' AS kind
    FROM booking_review_links l JOIN bookings b ON b.id=l.booking_id AND b.property_id=l.property_id
    JOIN properties p ON p.id=b.property_id
    WHERE l.token_hash=? AND l.expires_at>? AND ${reviewEligibleSql}
    UNION ALL
    SELECT p.name AS property_name, 'property' AS kind FROM property_review_links l
    JOIN properties p ON p.id=l.property_id
    WHERE l.token_hash=? AND l.expires_at>? AND l.revoked_at IS NULL AND p.status='live'
    AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.property_review_link_id=l.id)
    LIMIT 1`, hash, nowIso(), todayIST(), hash, nowIso())
}
