// Staff AI assistant ("ask about our resorts"): staff describe what a client needs in plain words; we
//  1. read the need (AI, with rule-based fallback),
//  2. search our own property database, check availability and calculate exact prices for the dates with the
//     same pricing engine as quotes (seasons, off-season, special dates, weekends, GST), and pick the cheapest mix
//     of room categories that fits the whole group,
//  3. let AI write the reply from those computed figures only.
// AI never makes up a price: every number in the reply comes from step 2.

import type { Env } from '../env'
import { aiJson, aiText } from './ai'
import { all, roomAvailability } from './db'
import { calculatePrice, netRateForStay, seasonKindLabel, staffRateForStay, type SeasonRate } from './pricing'
import { destinations } from './properties'
import { FACILITIES, MEAL_PLANS, parseQueryRules, PROPERTY_TYPES, sanitizeFilters, type SearchFilters } from './search'
import { getSettings } from './settings'
import { contact as readContact, dining as readDining, policies as readPolicies, POLICY_FIELDS, STAY_TYPES, stayTypeLabel } from './catalog'
import type { PropertyRow, RoomRow } from './types'
import { addDays, isDate, nightsBetween, parseJson, todayIST } from './util'

export interface Need extends SearchFilters {
  intent?: 'find' | 'property_info' | 'other'
  adults?: number
  children?: number
  nights?: number
  propertyName?: string
  budgetTotal?: number
}

export interface AllocLine {
  roomId: number
  room: string
  capacity: number
  /** Guests the rate covers per room, guests placed in these rooms, and extra guests above the rate. */
  includedGuests: number
  guests: number
  extraGuests: number
  /** Extra-person charge for the whole stay (all rooms of this line) and the per-night rate used. */
  extraCharge: number
  extraAdultRate: number | null
  count: number
  /** Guest price for this many rooms for the whole stay incl. extra-person charges, before GST. */
  guestSubtotal: number
  guestPerNight: number
  staffPerNight: number | null
  netPerNight?: number | null
  seasons: string[]
}

export interface PropertyOption {
  id: number
  slug: string
  name: string
  type: string
  destination: string
  rating: number
  lines: AllocLine[]
  roomsUsed: number
  sleeps: number
  fits: boolean
  guestSubtotal: number
  gst: number
  guestTotal: number
  staffTotal: number | null
  netTotal?: number | null
  freeRooms: number
  /** Guests this property can take with every free room. */
  maxSleeps: number
  minNightsIssue: string | null
  facilities: string[]
  mealPlans: string[]
  highlights: string
}

export interface AssistantResult {
  need: Need
  checkIn: string
  checkOut: string
  nights: number
  guests: number
  assumedDates: boolean
  options: PropertyOption[]
  info?: Record<string, unknown>
}

const clampInt = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : NaN
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : undefined
}

function needPrompt(question: string, prev: Need | null, dests: string[], today: string) {
  return `Today is ${today}. A travel agent at Go Sanchari (Kerala stays) is asking about options for a client.
Read their message and reply with JSON describing the client's need. If "Previous need" is given, this is a follow-up: keep everything from it unless the message changes it.
Keys (leave out unknown ones):
- intent: "find" (find stays/options/prices), "property_info" (a question about one named property), or "other"
- destination: one of ${dests.join(', ')}
- propertyName: if a specific property is named
- checkIn, checkOut: "YYYY-MM-DD" (next upcoming dates if no year). nights: number if only a length is given
- adults, children: numbers ("15 people" = 15 adults; "group of 15 incl 3 kids" = 12 adults + 3 children)
- rooms: number of rooms asked for
- priceMax: max budget per room per night in rupees; budgetTotal: max total budget in rupees
- types: from ${PROPERTY_TYPES.join(', ')}
- facilities: from ${Object.keys(FACILITIES).join(', ')}
- mealPlan: one of ${Object.keys(MEAL_PLANS).join(', ')}
- pet, family: true when asked
- vibe: other wishes in a few words
${prev ? `Previous need: ${JSON.stringify(prev)}\n` : ''}Message: """${question.slice(0, 1500)}"""
Reply with JSON only.`
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
function dayMonth(day: number, mon: string, today: string): string | undefined {
  const m = MON[mon]
  if (!m) return undefined
  let y = Number(today.slice(0, 4))
  const mk = () => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (!isDate(mk())) return undefined
  if (mk() < today) y++
  return mk()
}

/** A need edited directly by staff in the need bar (no AI needed). Only known fields, sane values. */
export function needFromForm(raw: unknown, dests: string[]): Need {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const today = todayIST()
  const out: Need = { intent: 'find' }
  const d = typeof r.destination === 'string' ? dests.find((x) => x.toLowerCase() === (r.destination as string).toLowerCase()) : undefined
  if (d) out.destination = d
  if (isDate(r.checkIn) && r.checkIn >= today) out.checkIn = r.checkIn
  if (isDate(r.checkOut) && out.checkIn && r.checkOut > out.checkIn) out.checkOut = r.checkOut
  const adults = clampInt(r.adults, 1, 300)
  const children = clampInt(r.children, 0, 100) ?? 0
  if (adults) { out.adults = adults; out.children = children; out.guests = adults + children }
  const pm = clampInt(r.priceMax, 300, 1_000_000)
  if (pm) out.priceMax = pm
  if (Array.isArray(r.types)) out.types = r.types.map(String).filter((t) => PROPERTY_TYPES.includes(t))
  if (Array.isArray(r.facilities)) out.facilities = r.facilities.map(String).filter((t) => t in FACILITIES)
  if (typeof r.mealPlan === 'string' && r.mealPlan in MEAL_PLANS) out.mealPlan = r.mealPlan
  if (r.pet === true) out.pet = true
  return out
}

/** Read what the client needs: rules first, AI on top when available. */
export async function readNeed(env: Env, question: string, prev: Need | null): Promise<Need> {
  const today = todayIST()
  const dests = await destinations(env)
  const rules = parseQueryRules(question, dests, today) as Need
  const kids = question.toLowerCase().match(/(\d{1,2})\s*(?:kids?|children|child)\b/)
  if (rules.guests) {
    rules.children = kids ? Number(kids[1]) : 0
    rules.adults = Math.max(1, rules.guests - (rules.children ?? 0))
  }
  // Dates the generic parser missed ("2 nights from 24 dec", "on 5th jan for 3 nights").
  const low = question.toLowerCase()
  const nightsM = low.match(/\b(\d{1,2})\s*nights?\b/)
  if (nightsM) rules.nights = Number(nightsM[1])
  if (!rules.checkIn) {
    for (const m of low.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g)) {
      const d = dayMonth(Number(m[1]), m[2], today)
      if (d) { rules.checkIn = d; break }
    }
  }
  if (rules.checkIn && rules.nights && (!rules.checkOut || nightsM)) rules.checkOut = addDays(rules.checkIn, rules.nights)
  if (rules.checkIn && !rules.checkOut && prev?.checkIn && prev.checkOut) rules.checkOut = addDays(rules.checkIn, nightsBetween(prev.checkIn, prev.checkOut))
  const big = question.toLowerCase().match(/\b(\d{2,3})\s*(?:people|persons|pax|guests|adults|members)\b/)
  if (big) { rules.guests = Number(big[1]); rules.adults = rules.guests - (rules.children ?? 0) }
  const raw = await aiJson<Record<string, unknown>>(env, 'staff_assistant', { size: 'large', prompt: needPrompt(question, prev, dests, today), maxTokens: 500 })
  const base: Need = { ...(prev ?? {}) }
  if (!raw) return { ...base, ...rules, intent: base.intent ?? 'find' }
  const ai = sanitizeFilters({ ...raw, guests: undefined }, dests) as Need
  const intent = raw.intent === 'property_info' || raw.intent === 'other' ? raw.intent : 'find'
  const adults = clampInt(raw.adults, 1, 300)
  const children = clampInt(raw.children, 0, 100)
  const out: Need = { ...base, ...rules, ...ai, intent }
  if (adults != null) out.adults = adults
  if (children != null) out.children = children
  if (adults != null || children != null) out.guests = (out.adults ?? 0) + (out.children ?? 0)
  const nights = clampInt(raw.nights, 1, 30)
  if (nights) out.nights = nights
  if (typeof raw.propertyName === 'string' && raw.propertyName.trim()) out.propertyName = raw.propertyName.trim().slice(0, 80)
  const rooms = clampInt(raw.rooms, 1, 100)
  if (rooms) out.rooms = rooms
  const bt = clampInt(raw.budgetTotal, 500, 50_000_000)
  if (bt) out.budgetTotal = bt
  if (isDate(raw.checkIn) && raw.checkIn >= today) out.checkIn = raw.checkIn
  if (isDate(raw.checkOut) && out.checkIn && raw.checkOut > out.checkIn) out.checkOut = raw.checkOut
  return out
}

interface PricedRoom { roomId: number; room: string; capacity: number; base: number; extraStay: number; extraAdultRate: number | null; free: number; guestStay: number; staffNight: number | null; netNight: number | null; seasons: string[]; minNights: number }

/**
 * Cheapest way to sleep the whole group in free rooms. Each room unit can take 1…capacity guests: its rate covers
 * `base` guests and every guest above that costs `extraStay` (extra-person charge for the whole stay).
 * Returns rooms used per category with guests placed and extra charges, or null when free rooms are not enough.
 */
export function allocateRooms<T extends { capacity: number; free: number; guestStay: number; base?: number; extraStay?: number }>(rooms: T[], guests: number): { room: T; count: number; guests: number; extra: number }[] | null {
  const units: T[] = []
  for (const r of rooms) for (let i = 0; i < Math.min(r.free, 60); i++) units.push(r)
  if (!units.length || guests < 1) return null
  const G = guests
  type Cell = { cost: number; pick: [number, number][] } // [unit index, guests in it]
  let best: Cell[] = Array.from({ length: G + 1 }, (_, c) => (c === 0 ? { cost: 0, pick: [] } : { cost: Infinity, pick: [] }))
  units.forEach((u, idx) => {
    const next = best.map((x) => ({ ...x }))
    const base = Math.min(u.base ?? u.capacity, u.capacity)
    for (let c = 0; c < G; c++) {
      if (!Number.isFinite(best[c].cost)) continue
      for (let k = 1; k <= u.capacity && c + k <= G; k++) {
        const cost = best[c].cost + u.guestStay + Math.max(0, k - base) * (u.extraStay ?? 0)
        if (cost < next[c + k].cost) next[c + k] = { cost, pick: [...best[c].pick, [idx, k]] }
      }
    }
    best = next
  })
  if (!Number.isFinite(best[G].cost)) return null
  const out = new Map<T, { room: T; count: number; guests: number; extra: number }>()
  for (const [i, k] of best[G].pick) {
    const u = units[i]
    const o = out.get(u) ?? { room: u, count: 0, guests: 0, extra: 0 }
    o.count++
    o.guests += k
    o.extra += Math.max(0, k - Math.min(u.base ?? u.capacity, u.capacity)) * (u.extraStay ?? 0)
    out.set(u, o)
  }
  return [...out.values()]
}

/** Search + availability + exact prices for the need. */
export async function findOptions(env: Env, need: Need, showNet: boolean): Promise<AssistantResult> {
  const today = todayIST()
  const assumedDates = !need.checkIn
  const checkIn = need.checkIn ?? addDays(today, 7)
  const checkOut = need.checkOut ?? addDays(checkIn, need.nights ?? 1)
  const nights = nightsBetween(checkIn, checkOut)
  const guests = Math.max(1, need.guests ?? (need.adults ?? 2) + (need.children ?? 0))
  const s = await getSettings(env)

  const where: string[] = ["p.status = 'live'"]
  const args: (string | number)[] = []
  if (need.propertyName) { where.push('p.name LIKE ?'); args.push(`%${need.propertyName}%`) }
  else if (need.destination) { where.push('p.destination = ?'); args.push(need.destination) }
  if (need.types?.length) { where.push(`COALESCE(p.stay_type, p.type) IN (${need.types.map(() => '?').join(', ')})`); args.push(...need.types) }
  if (need.pet) where.push('p.pet_friendly = 1')
  const props = await all<PropertyRow>(env, `SELECT p.* FROM properties p WHERE ${where.join(' AND ')} ORDER BY p.rating_avg DESC LIMIT 60`, ...args)
  const wantFac = need.facilities ?? []
  const candidates = props.filter((p) => {
    const fac = parseJson<string[]>(p.facilities, [])
    if (wantFac.some((f) => !fac.includes(f))) return false
    if (need.mealPlan && !parseJson<string[]>(p.meal_plans, []).includes(need.mealPlan)) return false
    return true
  })
  const ids = candidates.map((p) => p.id)
  if (!ids.length) return { need, checkIn, checkOut, nights, guests, assumedDates, options: [] }
  const ph = ids.map(() => '?').join(', ')
  const [rooms, seasons, avail] = await Promise.all([
    all<RoomRow & { weekend_nights: string }>(env, `SELECT r.*, p.weekend_nights FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.active = 1 AND r.property_id IN (${ph})`, ...ids),
    all<SeasonRate>(env, `SELECT property_id, room_id, name, start_date, end_date, rate, pct_adjust, min_nights, kind, staff_rate, net_rate, weekend_rate, staff_weekend_rate, net_weekend_rate, supplement, net_supplement FROM season_rates WHERE (property_id IN (${ph}) OR property_id IS NULL) AND end_date >= ? AND start_date <= ?`, ...ids, checkIn, checkOut),
    roomAvailability(env, ids, checkIn, checkOut),
  ])

  const options: PropertyOption[] = []
  for (const p of candidates) {
    const priced: PricedRoom[] = []
    for (const r of rooms.filter((x) => x.property_id === p.id)) {
      const ss = seasons.filter((x) => x.property_id == null || x.property_id === p.id)
      const price = calculatePrice({ room: r, seasons: ss, checkIn, checkOut, roomsCount: 1, taxSlabs: s.tax_slabs })
      if (!price.nights) continue
      const labels = [...new Set(price.lines.map((l) => l.label).filter((l) => l !== 'Standard' && l !== 'Weekend'))]
      const kinds = labels.map((l) => {
        const hit = ss.find((x) => x.name === l)
        return hit ? `${l} (${seasonKindLabel(hit.kind)})` : l
      })
      const netNight = showNet ? avgNet(r, ss, checkIn, checkOut) : null
      priced.push({ roomId: r.id, room: r.name, capacity: r.capacity, base: Math.min(r.base_guests ?? r.capacity, r.capacity), extraStay: (r.extra_adult_rate ?? 0) * nights, extraAdultRate: r.extra_adult_rate, free: avail.get(r.id)?.free ?? 0, guestStay: price.subtotal, staffNight: staffRateForStay(r, ss, checkIn, checkOut), netNight, seasons: kinds, minNights: price.minNights })
    }
    if (!priced.length) continue
    const alloc = allocateRooms(priced, guests)
    const lines: AllocLine[] = (alloc ?? []).map(({ room, count, guests: placed, extra }) => ({
      roomId: room.roomId, room: room.room, capacity: room.capacity, includedGuests: room.base, guests: placed, extraGuests: Math.max(0, placed - room.base * count), extraCharge: extra, extraAdultRate: room.extraAdultRate,
      count, guestSubtotal: room.guestStay * count + extra,
      guestPerNight: Math.round(room.guestStay / nights), staffPerNight: room.staffNight, ...(showNet ? { netPerNight: room.netNight } : {}), seasons: room.seasons,
    }))
    const guestSubtotal = lines.reduce((a, l) => a + l.guestSubtotal, 0)
    // GST is charged per room-night slab, so add each line's tax separately.
    let gst = 0
    for (const l of lines) {
      const perRoomNight = l.guestSubtotal / (l.count * nights)
      const rate = s.tax_slabs.slice().sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity)).find((t) => t.upto == null || perRoomNight <= t.upto)?.rate ?? 0
      gst += Math.round((l.guestSubtotal * rate) / 100)
    }
    const staffTotal = lines.every((l) => l.staffPerNight) ? lines.reduce((a, l) => a + (l.staffPerNight ?? 0) * l.count * nights, 0) : null
    const netTotal = showNet && lines.every((l) => l.netPerNight) ? lines.reduce((a, l) => a + (l.netPerNight ?? 0) * l.count * nights, 0) : null
    const minN = Math.max(...priced.filter((r) => lines.some((l) => l.roomId === r.roomId)).map((r) => r.minNights), 1)
    const opt: PropertyOption = {
      id: p.id, slug: p.slug, name: p.name, type: stayTypeLabel(p), destination: p.destination, rating: p.rating_avg,
      lines, roomsUsed: lines.reduce((a, l) => a + l.count, 0), sleeps: lines.reduce((a, l) => a + l.count * l.capacity, 0),
      fits: !!alloc, guestSubtotal, gst, guestTotal: guestSubtotal + gst, staffTotal, ...(showNet ? { netTotal } : {}),
      freeRooms: priced.reduce((a, r) => a + r.free, 0), maxSleeps: priced.reduce((a, r) => a + r.free * r.capacity, 0), minNightsIssue: nights < minN ? `Minimum stay is ${minN} nights for these dates` : null,
      facilities: parseJson<string[]>(p.facilities, []).slice(0, 8).map((f) => FACILITIES[f] ?? f),
      mealPlans: parseJson<string[]>(p.meal_plans, []).map((m) => MEAL_PLANS[m] ?? m),
      highlights: [parseJson<string[]>(p.highlights, []).slice(0, 3).join('; '), (p.description ?? '').slice(0, 220)].filter(Boolean).join(' — '),
    }
    if (need.priceMax && opt.fits && lines.some((l) => l.guestPerNight > need.priceMax! * 1.1)) continue
    if (need.budgetTotal && opt.fits && opt.guestTotal > need.budgetTotal * 1.1) continue
    options.push(opt)
  }
  options.sort((a, b) => Number(b.fits) - Number(a.fits) || Number(!!a.minNightsIssue) - Number(!!b.minNightsIssue) || a.guestTotal - b.guestTotal)
  return { need, checkIn, checkOut, nights, guests, assumedDates, options: options.slice(0, 6) }
}

function avgNet(r: RoomRow, ss: SeasonRate[], checkIn: string, checkOut: string): number | null {
  return netRateForStay(r, ss, checkIn, checkOut)
}

/** Everything staff may need about one property (for "what's the cancellation policy at X?" questions). */
export async function propertyInfo(env: Env, name: string, showContacts: boolean, showNet: boolean): Promise<Record<string, unknown> | null> {
  const p = (await all<PropertyRow>(env, "SELECT * FROM properties WHERE name LIKE ? AND status != 'hidden' ORDER BY status = 'live' DESC LIMIT 1", `%${name}%`))[0]
  if (!p) return null
  const rooms = await all<RoomRow>(env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', p.id)
  const pol = readPolicies(p.policies)
  return {
    name: p.name, type: STAY_TYPES[p.stay_type ?? p.type] ?? p.type, destination: p.destination, address: p.address, rating: p.rating_avg,
    description: (p.description ?? '').slice(0, 1500), highlights: parseJson<string[]>(p.highlights, []), how_to_reach: p.how_to_reach, good_to_know: p.good_to_know,
    facilities: parseJson<string[]>(p.facilities, []).map((f) => FACILITIES[f] ?? f), meal_plans: parseJson<string[]>(p.meal_plans, []).map((m) => MEAL_PLANS[m] ?? m),
    dining: readDining(p.dining), checkin: p.checkin_time, checkout: p.checkout_time, cancellation: p.cancellation_policy, house_rules: p.house_rules,
    policies: Object.fromEntries(POLICY_FIELDS.filter(([k]) => pol[k]).map(([k, label]) => [label, pol[k]])),
    nearby: parseJson<unknown[]>(p.nearby, []), remarks_internal: p.internal_notes,
    rooms: rooms.map((r) => ({ name: r.name, sleeps: r.capacity, rooms: r.units, bed: r.bed_type, guest_rate: r.base_rate, weekend_rate: r.weekend_rate, staff_rate: r.staff_rate, ...(showNet ? { net_rate: r.net_rate } : {}), includes: r.inclusions })),
    ...(showContacts ? { contact: readContact(p.contact) } : {}),
  }
}

const SYSTEM = `You are the internal assistant for Go Sanchari travel agents (Kerala holiday stays). Answer the agent briefly and practically.
Rules:
- Use ONLY the DATA given. Every price in DATA is already calculated exactly for the dates (seasons, special dates, weekends, GST); copy figures as they are, never calculate or invent new ones.
- "Staff rate" is the agent's minimum benchmark; "guest" prices are the selling prices. Mention net/B2B figures only if they are in DATA.
- For groups, say how the rooms are split (e.g. "4 × Deluxe (3 each) + 1 × Family Suite").
- Point out sold-out / does-not-fit options, minimum-stay rules and special/peak dates. If no single property fits the group, suggest splitting it across properties using max_guests_with_free_rooms.
- If dates were assumed, say so and ask for the real dates.
- The agent already sees a card per option with every price, so do NOT list all options or repeat all numbers.
- Format (max 4 short lines, no tables, no headings):
  1. "Best pick: <name> — <room split>, <guest total incl. GST>" and why in a few words.
  2. A runner-up or cheaper alternative, if any.
  3. One warning if needed (min stay, special-date pricing, not enough rooms, assumed dates).
  4. One next step (e.g. "Start the quote" or "Ask the guest for dates").
- For property questions, answer the question directly in 2–4 lines.`

/** Write the reply from computed data (rule-based text when AI is off). */
export async function writeAnswer(env: Env, question: string, history: { role: 'user' | 'assistant'; content: string }[], r: AssistantResult): Promise<string> {
  const data = r.info
    ? { property: r.info }
    : { dates: { checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, assumed: r.assumedDates }, guests: r.guests, need: r.need, options: r.options.map(compact) }
  const text = await aiText(env, 'staff_assistant', {
    size: 'large', system: SYSTEM, maxTokens: 900, temperature: 0.2,
    messages: [...history.slice(-6), { role: 'user', content: `Agent's question: ${question}\n\nDATA:\n${JSON.stringify(data)}` }],
  })
  return text ?? fallbackAnswer(r)
}

function compact(o: PropertyOption) {
  return {
    name: o.name, type: o.type, destination: o.destination, rating: o.rating || undefined, fits_group: o.fits, free_rooms: o.freeRooms, max_guests_with_free_rooms: o.maxSleeps,
    rooms: o.lines.map((l) => ({ room: l.room, count: l.count, rate_covers_guests_each: l.includedGuests, max_guests_each: l.capacity, guests_placed: l.guests, extra_guests: l.extraGuests || undefined, extra_person_charge_total: l.extraCharge || undefined, guest_per_room_night: l.guestPerNight, staff_per_room_night: l.staffPerNight, ...(l.netPerNight !== undefined ? { net_per_room_night: l.netPerNight } : {}), season: l.seasons.join(', ') || undefined })),
    guest_subtotal: o.guestSubtotal, gst: o.gst, guest_total_incl_gst: o.guestTotal, staff_total: o.staffTotal, ...(o.netTotal !== undefined ? { net_total: o.netTotal } : {}),
    min_stay_issue: o.minNightsIssue || undefined, meal_plans: o.mealPlans, facilities: o.facilities, about: o.highlights,
  }
}

const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

export function fallbackAnswer(r: AssistantResult): string {
  if (r.info) return `Here are the details for ${String(r.info.name)} (AI is off, so showing the raw facts).`
  if (!r.options.length) return `No live properties match this${r.need.destination ? ` in ${r.need.destination}` : ''}. Try another destination or fewer filters.`
  const fits = r.options.filter((o) => o.fits)
  const best = fits.find((o) => !o.minNightsIssue) ?? fits[0]
  const out: string[] = []
  if (best) out.push(`Best pick: ${best.name} — ${best.lines.map((l) => `${l.count} × ${l.room}`).join(' + ')}, ${inr(best.guestTotal)} incl. GST${best.staffTotal ? ` (staff ${inr(best.staffTotal)})` : ''}.`)
  if (fits.length > 1) out.push(`${fits.length - 1} more option${fits.length > 2 ? 's' : ''} below.`)
  const nofit = r.options.filter((o) => !o.fits)
  if (!best && nofit.reduce((a, o) => a + o.maxSleeps, 0) >= r.guests) out.push(`No single property takes all ${r.guests} guests — split the group: ${nofit.map((o) => `${o.name} up to ${o.maxSleeps}`).join(', ')}.`)
  else if (!best) out.push(`Not enough free rooms for ${r.guests} guests on these dates. Try other dates or a nearby destination.`)
  if (best?.minNightsIssue) out.push(`Note: ${best.minNightsIssue}.`)
  if (r.assumedDates) out.push(`Dates assumed (${r.checkIn}, ${r.nights} night${r.nights === 1 ? '' : 's'}) — set the real dates above for exact prices.`)
  return out.join('\n')
}
