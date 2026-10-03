// Search filters: parsing guest sentences without AI (fallback + pre-pass) and validating AI output.

import { addDays, isDate, todayIST } from './util'
import { STAY_TYPES } from './catalog'

export const PROPERTY_TYPES = Object.keys(STAY_TYPES)
export const FACILITIES: Record<string, string> = {
  pool: 'Pool',
  wifi: 'Wi-Fi',
  parking: 'Parking',
  ac: 'AC',
  kitchen: 'Kitchen',
  breakfast: 'Breakfast',
  garden: 'Garden',
  view: 'View',
  campfire: 'Campfire',
  power_backup: 'Power backup',
  hot_water: 'Hot water',
  tv: 'TV',
  lake_view: 'Lake view',
  sea_view: 'Sea view',
  hill_view: 'Hill view',
  restaurant: 'Restaurant',
  spa: 'Spa',
  wheelchair: 'Wheelchair access',
  ground_floor: 'Ground floor rooms',
  gym: 'Gym',
  ayurveda: 'Ayurveda centre',
  kids_play: 'Kids play area',
  indoor_games: 'Indoor games',
  bonfire: 'Bonfire area',
  bbq: 'Barbecue',
  elevator: 'Lift / elevator',
  laundry: 'Laundry',
  room_service: 'Room service',
  housekeeping: 'Daily housekeeping',
  front_desk_24h: '24-hour front desk',
  cctv: 'CCTV / security',
  ev_charging: 'EV charging',
  airport_transfer: 'Airport / station pickup',
  doctor_on_call: 'Doctor on call',
  conference: 'Meeting / conference hall',
  bar: 'Bar',
  trekking: 'Trekking / nature walks',
  boating: 'Boating / kayaking',
  plantation_tour: 'Plantation tour',
  cycling: 'Bicycles',
  fishing: 'Fishing',
}
export const MEAL_PLANS: Record<string, string> = {
  EP: 'Room only',
  CP: 'Breakfast',
  MAP: 'Breakfast + dinner',
  AP: 'All meals',
}
export const SORTS = ['recommended', 'price_asc', 'price_desc', 'rating', 'newest'] as const
export type Sort = (typeof SORTS)[number]

export interface SearchFilters {
  q?: string // free text for semantic ranking ("peaceful", "good for kids")
  destination?: string
  checkIn?: string
  checkOut?: string
  guests?: number
  rooms?: number
  priceMin?: number
  priceMax?: number // per night
  types?: string[]
  facilities?: string[]
  mealPlan?: string
  rating?: number
  pet?: boolean
  family?: boolean
  sort?: Sort
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

function futureDate(day: number, month: number, today: string): string | undefined {
  let year = Number(today.slice(0, 4))
  const mk = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  let d = mk(year)
  if (!isDate(d)) return undefined
  if (d < today) d = mk(++year)
  return isDate(d) ? d : undefined
}

function parseAmount(s: string): number | undefined {
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k|thousand|l|lakh|lac)?/i)
  if (!m) return undefined
  let n = parseFloat(m[1])
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === 'k' || unit === 'thousand') n *= 1000
  if (unit === 'l' || unit === 'lakh' || unit === 'lac') n *= 100000
  return Math.round(n)
}

/** Rule-based reading of a guest sentence. Used before (and instead of, when AI is off) the AI parser. */
export function parseQueryRules(text: string, destinations: string[], today = todayIST()): SearchFilters {
  const t = ' ' + text.toLowerCase().replace(/[₹]/g, ' rs ') + ' '
  const f: SearchFilters = {}

  for (const d of destinations) {
    if (t.includes(d.toLowerCase())) { f.destination = d; break }
  }
  const g = t.match(/\bfor\s+(\d{1,2})\b|\b(\d{1,2})\s*(?:people|persons|pax|guests|adults|of us|members)\b/)
  if (g) f.guests = Number(g[1] ?? g[2])
  if (/\bcouple\b|\bhoneymoon\b|\bfor two\b/.test(t) && !f.guests) f.guests = 2
  if (/\bfamily of (\d+)/.test(t)) f.guests = Number(t.match(/\bfamily of (\d+)/)![1])

  const under = t.match(/\b(?:under|below|less than|within|upto|up to|max|budget(?: of)?)\s*(?:rs\.?|inr)?\s*([\d,.]+\s*(?:k|thousand|l|lakh|lac)?)/)
  if (under) f.priceMax = parseAmount(under[1])
  const above = t.match(/\b(?:above|over|more than)\s*(?:rs\.?|inr)?\s*([\d,.]+\s*(?:k|thousand)?)/)
  if (above) f.priceMin = parseAmount(above[1])

  const types = PROPERTY_TYPES.filter((ty) => t.includes(ty) || (ty === 'houseboat' && /house ?boat/.test(t)) || (ty === 'glamping' && /\btents?\b|camping/.test(t)) || (ty === 'treehouse' && /tree ?house/.test(t)))
  if (types.length) f.types = [...types]

  const fac: string[] = []
  if (/\bpool\b/.test(t)) fac.push('pool')
  if (/wi-?fi|internet/.test(t)) fac.push('wifi')
  if (/parking/.test(t)) fac.push('parking')
  if (/\bac\b|air.?condition/.test(t)) fac.push('ac')
  if (/kitchen|self.?cook/.test(t)) fac.push('kitchen')
  if (/ground floor|elderly|wheelchair/.test(t)) fac.push('ground_floor')
  if (fac.length) f.facilities = fac
  if (/\bpets?\b|\bdog\b/.test(t)) f.pet = true
  if (/\bkids?\b|\bchildren\b|\bfamily\b/.test(t)) f.family = true
  if (/breakfast/.test(t)) f.mealPlan = 'CP'
  if (/all meals/.test(t)) f.mealPlan = 'AP'

  // Dates: "12-14 dec", "12 dec to 14 dec", "dec 12", "this weekend"
  const range = t.match(/\b(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\s+([a-z]{3,9})\b/)
  const single = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/) ?? null
  if (range && MONTHS[range[3]]) {
    f.checkIn = futureDate(Number(range[1]), MONTHS[range[3]], today)
    f.checkOut = futureDate(Number(range[2]), MONTHS[range[3]], today)
  } else if (single && MONTHS[single[2]]) {
    f.checkIn = futureDate(Number(single[1]), MONTHS[single[2]], today)
    const n = t.match(/\b(\d{1,2})\s*nights?\b/)
    if (f.checkIn) f.checkOut = addDays(f.checkIn, n ? Number(n[1]) : 1)
  } else if (/this weekend/.test(t)) {
    const dow = new Date(today + 'T00:00:00Z').getUTCDay()
    f.checkIn = addDays(today, (6 - dow + 7) % 7)
    f.checkOut = addDays(f.checkIn, 1)
  }
  if (f.checkIn && f.checkOut && f.checkOut <= f.checkIn) delete f.checkOut

  // Whatever "vibe" words remain go to semantic ranking.
  const vibe = text.match(/\b(quiet|peaceful|calm|romantic|luxur\w*|budget|cosy|cozy|secluded|nature|views?|lake\w*|beach\w*|forest|tea|hill\w*|kids?|famil\w*|honeymoon|group|party|work(?:ation)?|traditional|heritage|backwater\w*)\b/gi)
  if (vibe) f.q = [...new Set(vibe.map((v) => v.toLowerCase()))].join(' ')
  return f
}

/** Validate whatever the AI returned. Anything unexpected is dropped, never trusted. */
export function sanitizeFilters(raw: unknown, destinations: string[]): SearchFilters {
  const f: SearchFilters = {}
  if (!raw || typeof raw !== 'object') return f
  const r = raw as Record<string, unknown>
  const dest = typeof r.destination === 'string' ? destinations.find((d) => d.toLowerCase() === (r.destination as string).toLowerCase()) : undefined
  if (dest) f.destination = dest
  if (isDate(r.checkIn) && r.checkIn >= todayIST()) f.checkIn = r.checkIn
  if (isDate(r.checkOut) && f.checkIn && r.checkOut > f.checkIn) f.checkOut = r.checkOut
  const num = (v: unknown, lo: number, hi: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^\d.]/g, '')) : NaN
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : undefined
  }
  f.guests = num(r.guests, 1, 40)
  f.priceMax = num(r.priceMax ?? r.budget, 300, 1_000_000)
  f.priceMin = num(r.priceMin, 0, 1_000_000)
  if (Array.isArray(r.types)) {
    const ty = r.types.map(String).map((s) => s.toLowerCase()).filter((s) => PROPERTY_TYPES.includes(s))
    if (ty.length) f.types = ty
  }
  if (Array.isArray(r.facilities)) {
    const fa = r.facilities.map(String).map((s) => s.toLowerCase().replace(/[\s-]/g, '_')).map((s) => (s === 'wi_fi' ? 'wifi' : s)).filter((s) => s in FACILITIES)
    if (fa.length) f.facilities = [...new Set(fa)]
  }
  if (r.pet === true) f.pet = true
  if (r.family === true) f.family = true
  if (typeof r.mealPlan === 'string' && r.mealPlan.toUpperCase() in MEAL_PLANS) f.mealPlan = r.mealPlan.toUpperCase()
  if (typeof r.vibe === 'string' && r.vibe.trim()) f.q = r.vibe.trim().slice(0, 120)
  for (const k of Object.keys(f) as (keyof SearchFilters)[]) if (f[k] === undefined) delete f[k]
  return f
}

/** Merge AI filters over rule filters (AI wins where it found something). */
export function mergeFilters(rules: SearchFilters, ai: SearchFilters): SearchFilters {
  return { ...rules, ...ai, facilities: [...new Set([...(rules.facilities ?? []), ...(ai.facilities ?? [])])].filter(Boolean) }
}

export function filtersFromQuery(q: Record<string, string | string[] | undefined>): SearchFilters {
  const one = (k: string) => {
    const v = q[k]
    return Array.isArray(v) ? v[0] : v
  }
  const many = (k: string) => {
    const v = q[k]
    if (v == null) return undefined
    const arr = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  const n = (k: string) => {
    const v = one(k)
    const x = v ? parseInt(v, 10) : NaN
    return Number.isFinite(x) ? x : undefined
  }
  const f: SearchFilters = {
    q: one('q')?.slice(0, 200) || undefined,
    destination: one('destination') || undefined,
    checkIn: isDate(one('checkIn')) ? one('checkIn') : undefined,
    checkOut: isDate(one('checkOut')) ? one('checkOut') : undefined,
    guests: n('guests'),
    rooms: n('rooms'),
    priceMin: n('priceMin'),
    priceMax: n('priceMax'),
    types: many('type')?.filter((t) => PROPERTY_TYPES.includes(t)),
    facilities: many('facility')?.filter((t) => t in FACILITIES),
    mealPlan: one('meal') && one('meal')! in MEAL_PLANS ? one('meal') : undefined,
    rating: n('rating'),
    pet: one('pet') === '1' || undefined,
    family: one('family') === '1' || undefined,
    sort: (SORTS as readonly string[]).includes(one('sort') ?? '') ? (one('sort') as Sort) : undefined,
  }
  if (f.checkIn && f.checkOut && f.checkOut <= f.checkIn) f.checkOut = undefined
  for (const k of Object.keys(f) as (keyof SearchFilters)[]) if (f[k] === undefined) delete f[k]
  return f
}

export function filtersToParams(f: SearchFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.destination) p.set('destination', f.destination)
  if (f.checkIn) p.set('checkIn', f.checkIn)
  if (f.checkOut) p.set('checkOut', f.checkOut)
  if (f.guests) p.set('guests', String(f.guests))
  if (f.rooms) p.set('rooms', String(f.rooms))
  if (f.priceMin) p.set('priceMin', String(f.priceMin))
  if (f.priceMax) p.set('priceMax', String(f.priceMax))
  for (const t of f.types ?? []) p.append('type', t)
  for (const t of f.facilities ?? []) p.append('facility', t)
  if (f.mealPlan) p.set('meal', f.mealPlan)
  if (f.rating) p.set('rating', String(f.rating))
  if (f.pet) p.set('pet', '1')
  if (f.family) p.set('family', '1')
  if (f.sort) p.set('sort', f.sort)
  return p
}
