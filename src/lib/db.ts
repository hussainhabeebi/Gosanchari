// Thin D1 helpers + shared queries (availability, activity log, notifications).

import type { Env, JobMessage } from '../env'
import { eachNight, nowIso, parseJson } from './util'
import type { RoomRates, SeasonRate } from './pricing'
import { getSettings } from './settings'
import type { Role } from './permissions'

type Bind = string | number | null

export async function all<T = Record<string, unknown>>(env: Env, sql: string, ...binds: Bind[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...binds).all<T>()
  return r.results
}

export async function first<T = Record<string, unknown>>(env: Env, sql: string, ...binds: Bind[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null
}

export async function run(env: Env, sql: string, ...binds: Bind[]): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...binds).run()
}

export async function insertId(env: Env, sql: string, ...binds: Bind[]): Promise<number> {
  const r = await env.DB.prepare(sql).bind(...binds).run()
  return Number(r.meta.last_row_id)
}

export function placeholders(n: number): string {
  return Array(n).fill('?').join(',')
}

export async function logActivity(env: Env, userId: number | null, action: string, entity: string, entityId: string | number | null, details: unknown = {}) {
  await run(env, 'INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)', userId, action, entity, entityId == null ? null : String(entityId), JSON.stringify(details))
}

export async function enqueue(env: Env, msg: JobMessage): Promise<void> {
  try {
    await env.JOBS.send(msg)
  } catch (e) {
    console.error('queue send failed', msg.type, e)
  }
}

// ---- Availability ----

const ACTIVE_BOOKING = "(b.status IN ('confirmed','checked_in') OR (b.status = 'pending' AND b.hold_expires_at > ?))"

export interface RoomAvailability {
  roomId: number
  /** Units free on every night of the stay (minimum across nights). */
  free: number
}

/** Free units per room for the given stay, considering bookings, holds and blocked dates. */
export async function roomAvailability(env: Env, propertyIds: number[], checkIn: string, checkOut: string, excludeQuoteId?: number, excludeBookingId?: number): Promise<Map<number, RoomAvailability>> {
  const out = new Map<number, RoomAvailability>()
  if (!propertyIds.length) return out
  const ph = placeholders(propertyIds.length)
  const now = nowIso()
  const [rooms, bookings, blocks] = await Promise.all([
    all<{ id: number; property_id: number; units: number }>(env, `SELECT id, property_id, units FROM rooms WHERE active = 1 AND property_id IN (${ph})`, ...propertyIds),
    all<{ room_id: number; check_in: string; check_out: string; rooms_count: number }>(
      env,
      `SELECT b.room_id, b.check_in, b.check_out, b.rooms_count FROM bookings b WHERE b.property_id IN (${ph}) AND b.check_in < ? AND b.check_out > ? AND b.id != ? AND ${ACTIVE_BOOKING}`,
      ...propertyIds, checkOut, checkIn, excludeBookingId ?? -1, now,
    ),
    all<{ property_id: number; room_id: number | null; date: string; quotation_id: number | null }>(
      env,
      `SELECT property_id, room_id, date, quotation_id FROM blocked_dates WHERE property_id IN (${ph}) AND date >= ? AND date < ? AND (hold_until IS NULL OR hold_until > ?)`,
      ...propertyIds, checkIn, checkOut, now,
    ),
  ])
  const nights = eachNight(checkIn, checkOut)
  for (const room of rooms) {
    let free = room.units
    for (const n of nights) {
      const booked = bookings.filter((b) => b.room_id === room.id && b.check_in <= n && n < b.check_out).reduce((a, b) => a + b.rooms_count, 0)
      const blockedWhole = blocks.some((x) => x.property_id === room.property_id && x.room_id == null && x.date === n && x.quotation_id !== excludeQuoteId)
      const blockedUnits = blocks.filter((x) => x.room_id === room.id && x.date === n && (excludeQuoteId == null || x.quotation_id !== excludeQuoteId)).length
      free = Math.min(free, blockedWhole ? 0 : room.units - booked - blockedUnits)
    }
    out.set(room.id, { roomId: room.id, free: Math.max(0, free) })
  }
  return out
}

/** Booked/blocked map for a month calendar: date -> units taken per room. */
export async function monthOccupancy(env: Env, propertyId: number, from: string, to: string) {
  const now = nowIso()
  const [bookings, blocks] = await Promise.all([
    all<{ id: number; code: string; room_id: number; check_in: string; check_out: string; rooms_count: number; guest_name: string; status: string }>(
      env,
      `SELECT b.id, b.code, b.room_id, b.check_in, b.check_out, b.rooms_count, b.guest_name, b.status FROM bookings b WHERE b.property_id = ? AND b.check_in < ? AND b.check_out > ? AND ${ACTIVE_BOOKING}`,
      propertyId, to, from, now,
    ),
    all<{ id: number; room_id: number | null; date: string; reason: string | null; quotation_id: number | null }>(
      env,
      'SELECT id, room_id, date, reason, quotation_id FROM blocked_dates WHERE property_id = ? AND date >= ? AND date < ? AND (hold_until IS NULL OR hold_until > ?)',
      propertyId, from, to, now,
    ),
  ])
  return { bookings, blocks }
}

export async function loadPricing(env: Env, roomId: number): Promise<{ room: RoomRates & { name: string; capacity: number }; seasons: SeasonRate[] } | null> {
  const room = await first<RoomRates & { name: string }>(env, 'SELECT r.id, r.property_id, r.name, r.base_rate, r.weekend_rate, r.min_nights, r.capacity, r.units, r.staff_rate, r.net_rate, r.base_guests, r.extra_adult_rate, r.extra_child_rate, p.weekend_nights FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND r.active = 1', roomId)
  if (!room) return null
  const seasons = await all<SeasonRate>(
    env,
    'SELECT id, property_id, room_id, name, start_date, end_date, rate, pct_adjust, min_nights, kind, staff_rate, net_rate, weekend_rate, staff_weekend_rate, net_weekend_rate, supplement, net_supplement FROM season_rates WHERE (property_id = ? OR property_id IS NULL) AND (room_id IS NULL OR room_id = ?)',
    room.property_id, room.id,
  )
  return { room, seasons }
}

// ---- Notifications to staff (WhatsApp, by role, per Settings) ----

export async function notifyStaff(env: Env, event: 'new_enquiry' | 'booking' | 'quote_accepted' | 'refund_request' | 'low_review' | 'daily_summary', text: string) {
  const s = await getSettings(env)
  const roles = (s.notifications[event] ?? []) as Role[]
  if (!roles.length) return
  const staff = await all<{ phone: string | null; notify_settings: string }>(
    env,
    `SELECT phone, notify_settings FROM users WHERE active = 1 AND role IN (${placeholders(roles.length)})`,
    ...roles,
  )
  for (const u of staff) {
    const prefs = parseJson<Record<string, boolean>>(u.notify_settings, {})
    if (u.phone && prefs[event] !== false) await enqueue(env, { type: 'whatsapp', to: u.phone, text })
  }
}

/** Find or create a guest user record by phone (used for enquiries, WhatsApp and bookings). */
export async function findOrCreateGuest(env: Env, phone: string | null, name: string, email: string | null): Promise<number | null> {
  if (!phone && !email) return null
  const existing = phone
    ? await first<{ id: number; merged_into: number | null }>(env, 'SELECT id, merged_into FROM users WHERE phone = ?', phone)
    : await first<{ id: number; merged_into: number | null }>(env, 'SELECT id, merged_into FROM users WHERE email = ?', email)
  if (existing) return existing.merged_into ?? existing.id
  try {
    return await insertId(env, "INSERT INTO users (role, name, phone, email) VALUES ('guest', ?, ?, ?)", name || 'Guest', phone, email)
  } catch {
    // Email already used by a different phone — create without email.
    return await insertId(env, "INSERT INTO users (role, name, phone) VALUES ('guest', ?, ?)", name || 'Guest', phone)
  }
}
