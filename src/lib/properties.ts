import { COVER_PHOTO_SQL, dining as readDining, POLICY_FIELDS, policies as readPolicies, ROOM_AMENITIES, stayType, stayTypeLabel, THEMES } from './catalog'
// Property search (database), semantic ranking (Vectorize), similar properties, knowledge-base docs.

import type { Env } from '../env'
import { aiEmbed, aiEnabled, aiJson } from './ai'
import { all, first, loadPricing, placeholders, roomAvailability, run } from './db'
import { calculatePrice, roomsNeeded, type SeasonRate } from './pricing'
import { FACILITIES, MEAL_PLANS, mergeFilters, parseQueryRules, sanitizeFilters, type SearchFilters } from './search'
import { getContent, getSettings } from './settings'
import type { NearbyPlace, PropertyCard, PropertyRow, RoomRow } from './types'
import { nightsBetween, nowIso, parseJson, sha256Hex, todayIST } from './util'

const CARD_SQL = `
SELECT p.id, p.slug, p.name, COALESCE(p.stay_type, p.type) AS type, p.destination, p.rating_avg, p.rating_count, p.facilities, p.meal_plans,
       p.lat, p.lng, p.featured, p.pet_friendly, p.family_friendly, p.created_at,
       (SELECT MIN(base_rate) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) AS from_price,
       (SELECT COALESCE(SUM(capacity * units), 0) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) AS max_guests,
       ${COVER_PHOTO_SQL} AS photo
FROM properties p`

export async function destinations(env: Env): Promise<string[]> {
  const rows = await all<{ name: string }>(env, 'SELECT name FROM destinations ORDER BY sort, name')
  const fromProps = await all<{ destination: string }>(env, "SELECT DISTINCT destination FROM properties WHERE status = 'live'")
  return [...new Set([...rows.map((r) => r.name), ...fromProps.map((r) => r.destination)])]
}

export async function cardsByIds(env: Env, ids: number[]): Promise<PropertyCard[]> {
  if (!ids.length) return []
  const rows = await all<PropertyCard>(env, `${CARD_SQL} WHERE p.status = 'live' AND p.id IN (${placeholders(ids.length)})`, ...ids)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is PropertyCard => !!r)
}

export async function featuredCards(env: Env, limit = 8): Promise<PropertyCard[]> {
  return all<PropertyCard>(env, `${CARD_SQL} WHERE p.status = 'live' AND p.featured = 1 ORDER BY p.rating_avg DESC LIMIT ?`, limit)
}

// ---- Smart search: sentence → filters ----

export async function smartSearch(env: Env, text: string): Promise<{ filters: SearchFilters; usedAi: boolean }> {
  const dests = await destinations(env)
  const rules = parseQueryRules(text, dests)
  if (!(await aiEnabled(env, 'smart_search'))) return { filters: rules, usedAi: false }

  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const cacheKey = `ss:${await sha256Hex(norm + todayIST())}`
  const cached = await env.KV.get<SearchFilters>(cacheKey, 'json')
  if (cached) return { filters: cached, usedAi: true }

  const raw = await aiJson<Record<string, unknown>>(env, 'smart_search', {
    size: 'small',
    maxTokens: 220,
    cacheTtl: 86400,
    system:
      `You turn a traveller's request into JSON search filters for Kerala holiday stays. Today is ${todayIST()}.\n` +
      `Known destinations: ${dests.join(', ')}.\n` +
      `Return ONLY JSON with any of these keys: destination (one of the known destinations), checkIn (YYYY-MM-DD), checkOut (YYYY-MM-DD), ` +
      `guests (number), priceMax (rupees per night), priceMin, types (array of: homestay, villa, resort, houseboat, cottage), ` +
      `facilities (array of: ${Object.keys(FACILITIES).join(', ')}), mealPlan (one of ${Object.keys(MEAL_PLANS).join(', ')}), ` +
      `pet (true/false), family (true/false), vibe (short words describing the feel, e.g. "quiet nature"). Omit keys you are not sure about.`,
    prompt: text,
  })
  const filters = raw ? mergeFilters(rules, sanitizeFilters(raw, dests)) : rules
  await env.KV.put(cacheKey, JSON.stringify(filters), { expirationTtl: 86400 })
  return { filters, usedAi: !!raw }
}

// ---- Database search ----

export async function searchProperties(env: Env, f: SearchFilters, limit = 60): Promise<PropertyCard[]> {
  const where: string[] = ["p.status = 'live'"]
  const binds: (string | number)[] = []
  if (f.destination) { where.push('p.destination = ?'); binds.push(f.destination) }
  if (f.types?.length) { where.push(`COALESCE(p.stay_type, p.type) IN (${placeholders(f.types.length)})`); binds.push(...f.types) }
  if (f.rating) { where.push('p.rating_avg >= ?'); binds.push(f.rating) }
  if (f.pet) where.push('p.pet_friendly = 1')
  if (f.family) where.push('p.family_friendly = 1')
  for (const fac of f.facilities ?? []) {
    where.push('EXISTS (SELECT 1 FROM json_each(p.facilities) j WHERE j.value = ?)')
    binds.push(fac)
  }
  if (f.mealPlan) {
    where.push('EXISTS (SELECT 1 FROM json_each(p.meal_plans) j WHERE j.value = ?)')
    binds.push(f.mealPlan)
  }
  let sql = `SELECT * FROM (${CARD_SQL} WHERE ${where.join(' AND ')}) WHERE from_price IS NOT NULL`
  if (f.guests) { sql += ' AND max_guests >= ?'; binds.push(f.guests) }
  if (f.priceMin) { sql += ' AND from_price >= ?'; binds.push(f.priceMin) }
  // priceMax is checked after stay prices are known (season rates can lift the price).
  if (f.priceMax && !(f.checkIn && f.checkOut)) { sql += ' AND from_price <= ?'; binds.push(f.priceMax) }
  sql += ' LIMIT 300'
  let cards = await all<PropertyCard>(env, sql, ...binds)

  if (f.checkIn && f.checkOut && cards.length) {
    cards = await withStayPrices(env, cards, f)
    cards = cards.filter((c) => c.available)
    if (f.priceMax) cards = cards.filter((c) => (c.stay_price ?? c.from_price) <= f.priceMax!)
  }

  cards = await sortCards(env, cards, f)
  return cards.slice(0, limit)
}

async function withStayPrices(env: Env, cards: PropertyCard[], f: SearchFilters): Promise<PropertyCard[]> {
  const ids = cards.map((c) => c.id)
  const ph = placeholders(ids.length)
  const [rooms, seasons, avail] = await Promise.all([
    all<RoomRow>(env, `SELECT * FROM rooms WHERE active = 1 AND property_id IN (${ph})`, ...ids),
    all<SeasonRate>(env, `SELECT property_id, room_id, name, start_date, end_date, rate, pct_adjust, min_nights, kind, staff_rate FROM season_rates WHERE (property_id IN (${ph}) OR property_id IS NULL) AND end_date >= ? AND start_date < ?`, ...ids, f.checkIn!, f.checkOut!),
    roomAvailability(env, ids, f.checkIn!, f.checkOut!),
  ])
  const nights = nightsBetween(f.checkIn!, f.checkOut!)
  const guests = f.guests ?? 2
  for (const c of cards) {
    let best: { perNight: number; total: number } | null = null
    const propRooms = rooms.filter((r) => r.property_id === c.id)
    // Can the whole group fit in the free units?
    const freeCapacity = propRooms.reduce((a, r) => a + (avail.get(r.id)?.free ?? 0) * r.capacity, 0)
    for (const r of propRooms) {
      const free = avail.get(r.id)?.free ?? 0
      const need = roomsNeeded(guests, r.capacity)
      if (free < need) continue
      const p = calculatePrice({ room: r, seasons, checkIn: f.checkIn!, checkOut: f.checkOut!, roomsCount: need })
      if (p.errors.length) continue
      const perNight = Math.round(p.subtotal / nights)
      if (!best || perNight < best.perNight) best = { perNight, total: p.total }
    }
    c.available = !!best || (freeCapacity >= guests && propRooms.length > 1)
    if (best) {
      c.stay_price = best.perNight
      c.stay_total = best.total
    }
  }
  return cards
}

// ---- Semantic ranking (Vectorize) ----

export function propertyEmbeddingText(p: PropertyRow, rooms: Pick<RoomRow, 'name' | 'capacity'>[]): string {
  const fac = parseJson<string[]>(p.facilities, []).map((k) => FACILITIES[k] ?? k)
  const hl = parseJson<string[]>(p.highlights, [])
  return [
    `${p.name}, a ${stayTypeLabel(p)} in ${p.destination}, Kerala.`,
    hl.join('. '),
    p.description,
    `Facilities: ${fac.join(', ')}.`,
    parseJson<string[]>(p.themes, []).map((t) => THEMES[t] ?? t).join(', '),
    p.good_to_know,
    readDining(p.dining).cuisines?.join(', ') ?? '',
    p.family_friendly ? 'Good for families and kids.' : '',
    p.pet_friendly ? 'Pet friendly.' : '',
    `Rooms: ${rooms.map((r) => `${r.name} for ${r.capacity}`).join('; ')}.`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000)
}

async function queryVector(env: Env, text: string): Promise<number[] | null> {
  const key = `emb:${await sha256Hex(text.toLowerCase().trim())}`
  const cached = await env.KV.get<number[]>(key, 'json')
  if (cached) return cached
  const v = await aiEmbed(env, 'recommended', [text])
  if (!v?.[0]) return null
  await env.KV.put(key, JSON.stringify(v[0]), { expirationTtl: 7 * 86400 })
  return v[0]
}

export async function semanticScores(env: Env, text: string, topK = 50): Promise<Map<number, number> | null> {
  if (!env.VECTORIZE || !(await aiEnabled(env, 'recommended'))) return null
  const v = await queryVector(env, text)
  if (!v) return null
  try {
    const r = await env.VECTORIZE.query(v, { topK, returnMetadata: 'none', filter: { status: 'live' } })
    return new Map(r.matches.map((m) => [Number(m.id.replace('p-', '')), m.score]))
  } catch (e) {
    console.error('vectorize query failed', e)
    return null
  }
}

async function sortCards(env: Env, cards: PropertyCard[], f: SearchFilters): Promise<PropertyCard[]> {
  const price = (c: PropertyCard) => c.stay_price ?? c.from_price
  switch (f.sort) {
    case 'price_asc': return cards.sort((a, b) => price(a) - price(b))
    case 'price_desc': return cards.sort((a, b) => price(b) - price(a))
    case 'rating': return cards.sort((a, b) => b.rating_avg - a.rating_avg || b.rating_count - a.rating_count)
    case 'newest': return cards.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
  // Recommended: semantic match on the guest's words (if any) blended with quality signals.
  const sem = f.q ? await semanticScores(env, f.q, 100) : null
  for (const c of cards) {
    const quality = (c.rating_avg / 5) * 0.6 + Math.min(1, c.rating_count / 30) * 0.2 + (c.featured ? 0.2 : 0)
    c.score = sem ? (sem.get(c.id) ?? 0) * 0.7 + quality * 0.3 : quality
  }
  return cards.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/** Similar properties from Vectorize (no text generation), with a database fallback. */
export async function similarProperties(env: Env, propertyId: number, n = 4): Promise<PropertyCard[]> {
  const cacheKey = `similar:${propertyId}`
  const cachedIds = await env.KV.get<number[]>(cacheKey, 'json')
  if (cachedIds) return cardsByIds(env, cachedIds)
  let ids: number[] = []
  if (env.VECTORIZE && (await aiEnabled(env, 'recommended'))) {
    try {
      const [vec] = await env.VECTORIZE.getByIds([`p-${propertyId}`])
      if (vec?.values) {
        const r = await env.VECTORIZE.query(Array.from(vec.values), { topK: n + 1, filter: { status: 'live' } })
        ids = r.matches.map((m) => Number(m.id.replace('p-', ''))).filter((id) => id !== propertyId).slice(0, n)
      }
    } catch (e) {
      console.error('similar via vectorize failed', e)
    }
  }
  if (ids.length < n) {
    const p = await first<{ destination: string; type: string; stay_type: string | null }>(env, 'SELECT destination, type, stay_type FROM properties WHERE id = ?', propertyId)
    if (p) {
      const extra = await all<{ id: number }>(
        env,
        "SELECT id FROM properties WHERE status = 'live' AND id != ? ORDER BY (destination = ?) DESC, (COALESCE(stay_type, type) = ?) DESC, rating_avg DESC LIMIT ?",
        propertyId, p.destination, stayType(p), n * 2,
      )
      for (const e of extra) if (!ids.includes(e.id) && ids.length < n) ids.push(e.id)
    }
  }
  await env.KV.put(cacheKey, JSON.stringify(ids), { expirationTtl: 6 * 3600 })
  return cardsByIds(env, ids)
}

/** Fallback when filters return too few: nearest by meaning, ignoring strict filters. */
export async function closeMatches(env: Env, f: SearchFilters, exclude: number[], n = 4): Promise<PropertyCard[]> {
  const text = [f.q, f.destination, ...(f.types ?? []), ...(f.facilities ?? []), f.family ? 'family' : ''].filter(Boolean).join(' ')
  const sem = text ? await semanticScores(env, text, 20) : null
  let ids = sem ? [...sem.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id) : []
  if (!ids.length) {
    ids = (await all<{ id: number }>(env, "SELECT id FROM properties WHERE status = 'live' ORDER BY (destination = ?) DESC, rating_avg DESC LIMIT 20", f.destination ?? '')).map((r) => r.id)
  }
  return cardsByIds(env, ids.filter((id) => !exclude.includes(id)).slice(0, n))
}

/** Create/refresh a property's embedding. Runs from the queue only when a property changes. */
export async function embedProperty(env: Env, propertyId: number): Promise<void> {
  if (!env.VECTORIZE) return
  const p = await first<PropertyRow>(env, 'SELECT * FROM properties WHERE id = ?', propertyId)
  if (!p) {
    await env.VECTORIZE.deleteByIds([`p-${propertyId}`]).catch(() => {})
    return
  }
  const rooms = await all<RoomRow>(env, 'SELECT name, capacity FROM rooms WHERE property_id = ? AND active = 1', propertyId)
  const v = await aiEmbed(env, 'recommended', [propertyEmbeddingText(p, rooms)])
  if (!v?.[0]) return
  await env.VECTORIZE.upsert([{ id: `p-${p.id}`, values: v[0], metadata: { status: p.status, destination: p.destination, type: stayType(p) } }])
  await run(env, 'UPDATE properties SET embedded_at = ? WHERE id = ?', nowIso(), p.id)
  await env.KV.delete(`similar:${p.id}`)
}

// ---- Knowledge base documents for AI Search (stored in R2) ----

export async function propertyDoc(env: Env, p: PropertyRow): Promise<string> {
  const rooms = await all<RoomRow>(env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', p.id)
  const seasons = await all<{ name: string; start_date: string; end_date: string; room_id: number | null; rate: number | null; pct_adjust: number | null }>(
    env, 'SELECT name, start_date, end_date, room_id, rate, pct_adjust FROM season_rates WHERE property_id = ? ORDER BY start_date', p.id,
  )
  const fac = parseJson<string[]>(p.facilities, []).map((k) => FACILITIES[k] ?? k)
  const meals = parseJson<string[]>(p.meal_plans, []).map((k) => MEAL_PLANS[k] ?? k)
  const near = parseJson<NearbyPlace[]>(p.nearby, [])
  const d = readDining(p.dining)
  const pol = readPolicies(p.policies)
  const themes = parseJson<string[]>(p.themes, []).map((t) => THEMES[t] ?? t)
  const roomLine = (r: RoomRow) => {
    const am = parseJson<string[]>(r.facilities, []).map((k) => ROOM_AMENITIES[k] ?? FACILITIES[k] ?? k)
    return `- ${r.name}: ${r.units} room(s) of this type, sleeps up to ${r.capacity}${r.max_adults ? ` (max ${r.max_adults} adults${r.max_children != null ? `, ${r.max_children} children` : ''})` : ''}` +
      `${r.bed_type ? `, ${r.bed_type}` : ''}${r.size_sqft ? `, ${r.size_sqft} sq ft` : ''}${r.room_view ? `, ${r.room_view} view` : ''}. ` +
      `From ₹${r.base_rate} per night${r.weekend_rate ? ` (weekends ₹${r.weekend_rate})` : ''}. Includes: ${r.inclusions || 'room only'}. ` +
      `Amenities: ${am.join(', ') || 'standard'}. ${r.extra_bed ? `Extra bed available${r.extra_bed_rate ? ` at ₹${r.extra_bed_rate}/night` : ''}.` : 'No extra bed.'} ${r.description}`
  }
  const seasonLines = [...new Set(seasons.map((s) => `${s.name} (${s.start_date} to ${s.end_date})`))]
  return `# ${p.name}

Type: ${stayTypeLabel(p)}${p.star_category ? `, ${p.star_category}-star` : ''}. Location: ${p.destination}, Kerala. ${p.address ?? ''}
${themes.length ? `Best for: ${themes.join(', ')}.` : ''} ${p.built_year ? `Built/renovated: ${p.built_year}.` : ''}

## Highlights
${parseJson<string[]>(p.highlights, []).map((h) => `- ${h}`).join('\n')}

## About
${p.description}
${p.good_to_know ? `\nGood to know: ${p.good_to_know}` : ''}

## Room categories
${rooms.map(roomLine).join('\n')}

## Seasonal rates
${seasonLines.length ? `Special season rates apply during: ${seasonLines.join('; ')}. Exact prices are confirmed in the quote.` : 'Regular rates all year.'}

## Facilities
${fac.join(', ') || 'Not listed'}

## Dining
${d.restaurant_name ? `Restaurant: ${d.restaurant_name}. ` : ''}Cuisines: ${d.cuisines?.join(', ') || 'not listed'}. Menu: ${d.menu_types?.join(', ') || 'not listed'}.
Timings: breakfast ${d.breakfast || 'not listed'}, lunch ${d.lunch || 'not listed'}, dinner ${d.dinner || 'not listed'}.
Meal plans available: ${meals.join(', ') || 'Room only'}.${d.price_cp ? ` Breakfast plan ₹${d.price_cp}/person/night.` : ''}${d.price_map ? ` Breakfast + dinner ₹${d.price_map}/person/night.` : ''}${d.price_ap ? ` All meals ₹${d.price_ap}/person/night.` : ''}
In-room dining: ${d.in_room_dining ? 'yes' : 'no'}. Bar: ${d.bar ? 'yes' : 'no'}. Outside food: ${d.outside_food ? 'allowed' : 'not allowed'}. ${d.child_meal_note ?? ''} ${d.notes ?? ''}

## Policies
- Check-in from ${p.checkin_time}, check-out by ${p.checkout_time}.
- ID: ${pol.id_documents || (p.id_required ? 'Government photo ID required for all adult guests' : 'not required')}.
- Pets: ${pol.pet || (p.pet_friendly ? 'allowed' : 'not allowed')}.
- Children: ${pol.child || (p.family_friendly ? 'welcome, good for families' : 'better suited to adults')}.
${POLICY_FIELDS.filter(([k]) => !['pet', 'child', 'id_documents'].includes(k) && pol[k]).map(([k, label]) => `- ${label}: ${pol[k]}`).join('\n')}
${p.house_rules ? p.house_rules.split('\n').map((l) => `- ${l.replace(/^-\s*/, '')}`).join('\n') : ''}

## Cancellation policy
${p.cancellation_policy || 'Standard Go Sanchari cancellation policy applies.'}

## Location and how to reach
${p.address ?? ''} ${p.how_to_reach ?? ''}

## Nearby
${near.map((n) => `- ${n.name} (${n.kind}): ${n.km} km${n.time ? `, about ${n.time}` : ''}`).join('\n') || 'Not listed'}
`
}

export async function syncPropertyKb(env: Env, propertyId: number): Promise<void> {
  const p = await first<PropertyRow>(env, 'SELECT * FROM properties WHERE id = ?', propertyId)
  if (!p) return
  const key = `properties/${p.slug}/details.md`
  if (p.status !== 'live') await env.KB.delete(key)
  else await env.KB.put(key, await propertyDoc(env, p), { httpMetadata: { contentType: 'text/markdown' } })
  await reindexKb(env)
}

export async function syncContentKb(env: Env): Promise<void> {
  const c = await getContent(env)
  const s = await getSettings(env)
  const faqs = c.faqs.map((f) => `## ${f.q}\n${f.a}`).join('\n\n')
  await Promise.all([
    env.KB.put('general/faqs.md', `# Frequently asked questions — ${s.business.name}\n\n${faqs}`),
    env.KB.put('general/policies/cancellation.md', `# Cancellation and refund policy\n\n${c.policies.cancellation}`),
    env.KB.put('general/policies/privacy.md', `# Privacy policy\n\n${c.policies.privacy}`),
    env.KB.put('general/policies/terms.md', `# Terms and conditions\n\n${c.policies.terms}`),
    env.KB.put('general/about.md', `# About ${s.business.name}\n\n${c.about}\n\nContact: phone ${s.business.phone}, WhatsApp ${s.business.whatsapp}, email ${s.business.email}. Office: ${s.business.address}.`),
  ])
  await reindexKb(env)
}

/** Ask AI Search to re-read the bucket now (it also syncs on its own schedule). */
async function reindexKb(env: Env): Promise<void> {
  if (!env.AI_SEARCH) return
  // Debounce: at most one re-index request every 5 minutes.
  if (await env.KV.get('kb:reindex')) return
  await env.KV.put('kb:reindex', '1', { expirationTtl: 300 })
  await env.AI_SEARCH.jobs.create().catch((e) => console.error('AI Search re-index failed', e))
}

export async function bestRoomFor(env: Env, propertyId: number, guests: number, checkIn: string | null, checkOut: string | null) {
  const rooms = await all<RoomRow>(env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', propertyId)
  if (!rooms.length) return null
  if (!checkIn || !checkOut) return { room: rooms[0], roomsCount: roomsNeeded(guests, rooms[0].capacity), price: null }
  const avail = await roomAvailability(env, [propertyId], checkIn, checkOut)
  for (const r of rooms) {
    const need = roomsNeeded(guests, r.capacity)
    if ((avail.get(r.id)?.free ?? 0) >= need) {
      const pr = await loadPricing(env, r.id)
      const price = pr ? calculatePrice({ room: pr.room, seasons: pr.seasons, checkIn, checkOut, roomsCount: need }) : null
      return { room: r, roomsCount: need, price }
    }
  }
  return null
}
