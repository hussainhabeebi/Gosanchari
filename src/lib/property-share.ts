// Sharing property details with external services (e.g. LeadVyne): one JSON shape used both by the
// pull API (/api/v1/properties, partner calls us with an API key) and by push connections (we POST to the
// partner's URL with their API token). Only guest-facing details go out: public rates, photos, location,
// policies. Never owner contacts, B2B net / staff rates, commission or internal notes.

import type { Env } from '../env'
import { addons as readAddons, ADDON_PER, COVER_ORDER, dining as readDining, policies as readPolicies, ROOM_AMENITIES, stayType, stayTypeLabel, THEMES } from './catalog'
import { all, first, placeholders, run } from './db'
import { mediaUrl } from './integrations'
import { FACILITIES, MEAL_PLANS } from './search'
import type { NearbyPlace, PhotoRow, PropertyRow, RoomRow } from './types'
import { nowIso, parseJson, randomToken, sha256Hex, todayIST } from './util'

export interface ApiConnection {
  id: number
  name: string
  direction: 'push' | 'pull'
  url: string | null
  token: string | null
  auth_style: 'bearer' | 'x-api-key'
  token_hash: string | null
  token_hint: string
  auto_sync: number
  active: number
  last_used_at: string | null
  last_status: string | null
  created_at: string
}

export interface SharedImage { url: string; caption: string | null; category: string; room_id: number | null; is_cover: boolean }

export interface SharedProperty {
  id: number
  slug: string
  name: string
  type: string
  type_label: string
  url: string
  star_category: number | null
  featured: boolean
  rating: { average: number; count: number }
  location: { destination: string; address: string | null; lat: number | null; lng: number | null; map_url: string | null; state: string; country: string }
  price: { currency: 'INR'; from_per_night: number | null; rates_include_meal_plan: string | null; note: string }
  description: string
  highlights: string[]
  themes: { key: string; label: string }[]
  facilities: { key: string; label: string }[]
  meal_plans: { key: string; label: string }[]
  languages: string[]
  checkin_time: string
  checkout_time: string
  cancellation_policy: string
  house_rules: string
  good_to_know: string
  how_to_reach: string
  best_time: string
  pet_friendly: boolean
  family_friendly: boolean
  child_free_below: number | null
  child_age_to: number | null
  nearby: NearbyPlace[]
  policies: Record<string, string>
  dining: Record<string, unknown>
  addons: { name: string; price: number; per: string; complimentary: boolean }[]
  cover_image: string | null
  images: SharedImage[]
  videos: { url: string; caption: string | null }[]
  rooms: {
    id: number
    name: string
    description: string
    capacity: number
    base_guests: number
    max_adults: number | null
    max_children: number | null
    bed_type: string | null
    size_sqft: number | null
    view: string | null
    units: number
    min_nights: number
    amenities: { key: string; label: string }[]
    inclusions: string
    price: { base_per_night: number | null; weekend_per_night: number | null; rack_per_night: number | null; extra_adult_per_night: number | null; extra_child_per_night: number | null; child_no_bed_per_night: number | null }
    images: string[]
  }[]
  seasonal_rates: { name: string; kind: string; room_id: number | null; start_date: string; end_date: string; rate: number | null; weekend_rate: number | null; pct_adjust: number | null; supplement: number | null; meal_plan: string | null; min_nights: number | null }[]
  updated_at: string
}

interface SeasonRow { property_id: number; room_id: number | null; name: string; kind: string | null; start_date: string; end_date: string; rate: number | null; weekend_rate: number | null; pct_adjust: number | null; supplement: number | null; meal_plan: string | null; min_nights: number | null }

/** Absolute URL for a photo key or site path (partners can't resolve our relative /media/… paths). */
export function absoluteUrl(env: Env, pathOrUrl: string): string {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : env.SITE_URL.replace(/\/+$/, '') + pathOrUrl
}

const positive = (n: number | null | undefined) => (n != null && n > 0 ? n : null)
const labelled = (keys: string[], labels: Record<string, string>) => keys.map((key) => ({ key, label: labels[key] ?? key }))

/** Full shareable details for the given live properties, in the order asked. */
export async function sharedProperties(env: Env, ids: number[]): Promise<SharedProperty[]> {
  if (!ids.length) return []
  const ph = placeholders(ids.length)
  const [props, rooms, photos, seasons] = await Promise.all([
    all<PropertyRow>(env, `SELECT * FROM properties WHERE status = 'live' AND id IN (${ph})`, ...ids),
    all<RoomRow>(env, `SELECT * FROM rooms WHERE active = 1 AND property_id IN (${ph}) ORDER BY base_rate, id`, ...ids),
    all<PhotoRow>(env, `SELECT * FROM property_photos WHERE property_id IN (${ph}) ORDER BY sort, id`, ...ids),
    all<SeasonRow>(env, `SELECT property_id, room_id, name, kind, start_date, end_date, rate, weekend_rate, pct_adjust, supplement, meal_plan, min_nights FROM season_rates WHERE property_id IN (${ph}) AND end_date >= ? ORDER BY start_date`, ...ids, todayIST()),
  ])
  const byId = new Map(props.map((p) => [p.id, p]))
  return ids.map((id) => byId.get(id)).filter((p): p is PropertyRow => !!p).map((p) => {
    const propRooms = rooms.filter((r) => r.property_id === p.id)
    const propPhotos = photos.filter((ph) => ph.property_id === p.id)
    const images = propPhotos.filter((ph) => ph.media_type !== 'video' && ph.r2_key)
    const cover = images.find((ph) => ph.id === p.thumbnail_photo_id)
      ?? [...images].sort((a, b) => rank(a.category) - rank(b.category) || a.sort - b.sort || a.id - b.id)[0]
    const img = (ph: PhotoRow) => absoluteUrl(env, mediaUrl(ph.r2_key, 1600))
    const publicRates = propRooms.map((r) => positive(r.base_rate)).filter((n): n is number => n != null)
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: stayType(p),
      type_label: stayTypeLabel(p),
      url: absoluteUrl(env, `/stay/${p.slug}`),
      star_category: p.star_category,
      featured: !!p.featured,
      rating: { average: p.rating_avg, count: p.rating_count },
      location: { destination: p.destination, address: p.address, lat: p.lat, lng: p.lng, map_url: p.map_url, state: 'Kerala', country: 'India' },
      price: {
        currency: 'INR',
        from_per_night: publicRates.length ? Math.min(...publicRates) : null,
        rates_include_meal_plan: p.rate_meal_plan,
        note: 'Per room per night before GST. Seasonal rates may apply; final price is confirmed in a quotation.',
      },
      description: p.description,
      highlights: parseJson<string[]>(p.highlights, []),
      themes: labelled(parseJson<string[]>(p.themes, []), THEMES),
      facilities: labelled(parseJson<string[]>(p.facilities, []), FACILITIES),
      meal_plans: labelled(parseJson<string[]>(p.meal_plans, []), MEAL_PLANS),
      languages: parseJson<string[]>(p.languages, []),
      checkin_time: p.checkin_time,
      checkout_time: p.checkout_time,
      cancellation_policy: p.cancellation_policy,
      house_rules: p.house_rules,
      good_to_know: p.good_to_know,
      how_to_reach: p.how_to_reach,
      best_time: p.best_time,
      pet_friendly: !!p.pet_friendly,
      family_friendly: !!p.family_friendly,
      child_free_below: p.child_free_below,
      child_age_to: p.child_age_to,
      nearby: parseJson<NearbyPlace[]>(p.nearby, []),
      policies: Object.fromEntries(Object.entries(readPolicies(p.policies)).filter(([, v]) => typeof v === 'string' && v.trim())) as Record<string, string>,
      dining: readDining(p.dining) as Record<string, unknown>,
      addons: readAddons(p.addons).map((a) => ({ name: a.name, price: a.price, per: ADDON_PER[a.per ?? 'stay'] ?? 'per stay', complimentary: !!a.complimentary })),
      cover_image: cover ? img(cover) : null,
      images: images.map((ph) => ({ url: img(ph), caption: ph.caption, category: ph.category, room_id: ph.room_id, is_cover: ph.id === cover?.id })),
      videos: propPhotos.filter((ph) => ph.media_type === 'video' && ph.video_url).map((ph) => ({ url: ph.video_url!, caption: ph.caption })),
      rooms: propRooms.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        capacity: r.capacity,
        base_guests: Math.min(r.base_guests ?? r.capacity, r.capacity),
        max_adults: r.max_adults,
        max_children: r.max_children,
        bed_type: r.bed_type,
        size_sqft: r.size_sqft,
        view: r.room_view,
        units: r.units,
        min_nights: r.min_nights,
        amenities: labelled(parseJson<string[]>(r.facilities, []), ROOM_AMENITIES),
        inclusions: r.inclusions,
        price: {
          base_per_night: positive(r.base_rate),
          weekend_per_night: positive(r.weekend_rate),
          rack_per_night: positive(r.rack_rate),
          extra_adult_per_night: positive(r.extra_adult_rate),
          extra_child_per_night: positive(r.extra_child_rate ?? r.extra_adult_rate),
          child_no_bed_per_night: positive(r.child_no_bed_rate),
        },
        images: images.filter((ph) => ph.room_id === r.id).map(img),
      })),
      seasonal_rates: seasons.filter((s) => s.property_id === p.id && (s.rate != null || s.pct_adjust != null || s.supplement != null)).map((s) => ({
        name: s.name, kind: s.kind ?? 'season', room_id: s.room_id, start_date: s.start_date, end_date: s.end_date,
        rate: positive(s.rate), weekend_rate: positive(s.weekend_rate), pct_adjust: s.pct_adjust, supplement: positive(s.supplement), meal_plan: s.meal_plan, min_nights: s.min_nights,
      })),
      updated_at: p.updated_at,
    }
  })
}

function rank(category: string): number {
  const i = COVER_ORDER.indexOf(category)
  return i < 0 ? COVER_ORDER.length : i
}

// ---- Pull: API keys we issue ----

export async function createApiKey(env: Env, name: string, userId: number | null): Promise<{ id: number; key: string }> {
  const key = `gs_live_${randomToken(24)}`
  const r = await run(env, "INSERT INTO api_connections (name, direction, token_hash, token_hint, created_by) VALUES (?, 'pull', ?, ?, ?)", name, await sha256Hex(key), `${key.slice(0, 10)}…${key.slice(-4)}`, userId)
  return { id: Number(r.meta.last_row_id), key }
}

export async function findApiKey(env: Env, key: string): Promise<ApiConnection | null> {
  if (!key || key.length > 200) return null
  return first<ApiConnection>(env, "SELECT * FROM api_connections WHERE direction = 'pull' AND active = 1 AND token_hash = ?", await sha256Hex(key))
}

// ---- Push: partner endpoints ----

export function maskToken(token: string | null | undefined): string {
  if (!token) return ''
  return token.length <= 8 ? '••••' : `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** Partner endpoints must be https (plain http only outside production, for local testing). */
export function validEndpoint(env: Env, raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol === 'https:' || (u.protocol === 'http:' && env.ENVIRONMENT !== 'production')) return u.toString()
  } catch { /* not a URL */ }
  return null
}

export const PUSH_BATCH = 20

/** POSTs the given (default: all live) properties to a push connection in batches; records the outcome on the connection. */
export async function pushProperties(env: Env, conn: ApiConnection, ids?: number[]): Promise<{ ok: boolean; sent: number; error?: string }> {
  if (conn.direction !== 'push' || !conn.url) return { ok: false, sent: 0, error: 'Not a push connection' }
  const list = ids ?? (await all<{ id: number }>(env, "SELECT id FROM properties WHERE status = 'live' ORDER BY id")).map((r) => r.id)
  let sent = 0
  let error: string | undefined
  for (let i = 0; i < list.length && !error; i += PUSH_BATCH) {
    const properties = await sharedProperties(env, list.slice(i, i + PUSH_BATCH))
    if (!properties.length) continue
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'GoSanchari-PropertySync/1.0' }
    if (conn.token) {
      if (conn.auth_style === 'x-api-key') headers['X-API-Key'] = conn.token
      else headers.Authorization = `Bearer ${conn.token}`
    }
    const r = await fetch(conn.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'gosanchari', event: 'properties.sync', sent_at: nowIso(), count: properties.length, properties }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => e as Error)
    if (r instanceof Error) error = r.name === 'TimeoutError' ? 'The service did not respond in time' : r.message
    else if (!r.ok) error = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`.trim()
    else sent += properties.length
  }
  const status = error ? `Failed after ${sent} sent: ${error}` : `OK: ${sent} ${sent === 1 ? 'property' : 'properties'} sent`
  await run(env, 'UPDATE api_connections SET last_used_at = ?, last_status = ? WHERE id = ?', nowIso(), status.slice(0, 300), conn.id)
  return { ok: !error, sent, error }
}

/** Daily cron: refresh every active push connection that has automatic sync on. */
export async function autoSyncConnections(env: Env): Promise<void> {
  const conns = await all<ApiConnection>(env, "SELECT * FROM api_connections WHERE direction = 'push' AND active = 1 AND auto_sync = 1")
  for (const c of conns) await pushProperties(env, c).catch((e) => console.error('property sync failed', c.id, e))
}
