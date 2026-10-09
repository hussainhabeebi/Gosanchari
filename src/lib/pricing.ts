// Rule-based pricing. Prices are always calculated here, never by AI.

import type { RoomRow } from './types'
import { eachNight, nightsBetween, weekday, parseJson } from './util'

export interface RoomRates {
  id: number
  property_id: number
  base_rate: number
  weekend_rate: number | null
  min_nights: number
  capacity: number
  units: number
  staff_rate?: number | null
  /** Guests included in the room rate; null = all `capacity` guests are included. */
  /** Nights counted as weekend, as JS weekday numbers of the night ("5,6" = Fri & Sat; "5,6,0" adds Sunday). */
  weekend_nights?: string | null
  /** Meal plan the room's regular rates are for (property setting), used when no plan is asked for. */
  rate_meal_plan?: string | null
  base_guests?: number | null
  /** Charge per extra adult / child per night above base_guests (child falls back to adult). */
  extra_adult_rate?: number | null
  extra_child_rate?: number | null
}

export interface Occupancy {
  /** Guests included in the rate for all rooms together. */
  included: number
  max: number
  extraAdults: number
  extraChildren: number
  /** Extra-guest charge per night (all rooms). */
  perNight: number
  /** Extra-guest charge for the whole stay. */
  total: number
}

/** Guests covered by the rate, extra guests and their charge for `roomsCount` rooms of this category. */
export function occupancy(room: RoomRates, roomsCount: number, adults: number, children: number, nights: number): Occupancy {
  const rooms = Math.max(1, roomsCount)
  const base = Math.max(1, Math.min(room.base_guests ?? room.capacity, room.capacity))
  const included = base * rooms
  const max = Math.max(base, room.capacity) * rooms
  // Adults fill the included places first; children take what is left.
  const extraAdults = Math.max(0, adults - included)
  const extraChildren = Math.max(0, children - Math.max(0, included - adults))
  const adultRate = room.extra_adult_rate ?? 0
  const childRate = room.extra_child_rate ?? adultRate
  const perNight = extraAdults * adultRate + extraChildren * childRate
  return { included, max, extraAdults, extraChildren, perNight, total: perNight * Math.max(0, nights) }
}

export const PERSONALISED_OFFER = 'For a personalised offer, fill in your details below and enquire.'

export interface SeasonRate {
  source?: string | null
  id?: number
  property_id: number | null
  room_id: number | null
  name: string
  start_date: string
  end_date: string // inclusive (last night the season applies to)
  rate: number | null
  pct_adjust: number | null
  min_nights: number | null
  /** 'season' (peak), 'off_season' (low) or 'special' (holiday / event). */
  kind?: string | null
  /** Internal staff rate and B2B net rate for this season (room-specific seasons only). */
  staff_rate?: number | null
  net_rate?: number | null
  /** Weekend versions of the season rates (guest / staff / net). */
  weekend_rate?: number | null
  staff_weekend_rate?: number | null
  net_weekend_rate?: number | null
  /** Flat amount added per room per night on top of whatever rate applies (e.g. X'mas supplement). */
  supplement?: number | null
  net_supplement?: number | null
  /** Meal plan this rate is for (CP / MAP / AP / EP); null = any plan. */
  meal_plan?: string | null
  /** Rows entered together as one rate table (several date ranges, same rates) share this key. */
  rate_group_key?: string | null
  /** Nights this rate applies to, as JS weekday numbers of the night ("6" = Saturday); null = every night. */
  applicable_weekdays?: string | null
}

/** Weekday numbers (0 = Sunday … 6 = Saturday) from a stored list; empty = every night. */
export function parseWeekdays(v: string | null | undefined): number[] {
  return [...new Set((v ?? '').split(',').map((x) => parseInt(x, 10)).filter((d) => d >= 0 && d <= 6))].sort()
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Every Sat", "Every Fri, Sat" — or '' for every night. */
export function weekdaysLabel(v: string | null | undefined): string {
  const days = parseWeekdays(v)
  return days.length ? `Every ${[...days.filter((d) => d > 0), ...days.filter((d) => d === 0)].map((d) => DAY_SHORT[d]).join(', ')}` : ''
}

/** Does this season row apply on the night of `date`? (date range + recurring weekdays) */
export function seasonAppliesOn(s: Pick<SeasonRate, 'start_date' | 'end_date' | 'applicable_weekdays'>, date: string): boolean {
  if (!(s.start_date <= date && date <= s.end_date)) return false
  const days = parseWeekdays(s.applicable_weekdays)
  return !days.length || days.includes(weekday(date))
}

/** Weekend nights for a room's property (default Friday and Saturday nights). */
export function weekendNights(room: { weekend_nights?: string | null }): number[] {
  const days = (room.weekend_nights ?? '5,6').split(',').map((x) => parseInt(x, 10)).filter((d) => d >= 0 && d <= 6)
  return days.length ? days : [5, 6]
}

export const commonPeakKey = (s: SeasonRate) => s.room_id == null && s.source?.startsWith('wizard-common:') ? s.source.slice(14) : null
export const overridePeakKey = (s: SeasonRate) => s.room_id != null && s.source?.startsWith('wizard-override:') ? s.source.slice(16) : null

/** A staff-entered base tariff still carries the explicitly configured common peak charges. */
export const peaksForQuotedRate = (seasons: SeasonRate[]) => seasons.filter(s => commonPeakKey(s) || overridePeakKey(s))

const isSupplementOnly = (s: SeasonRate) => (!!s.supplement || ((commonPeakKey(s) || overridePeakKey(s)) && s.supplement === 0)) && !(s.rate && s.rate > 0) && s.pct_adjust == null

/** Season types, in the order they win when dates overlap (special first). */
export const SEASON_KINDS: Record<string, string> = {
  special: 'Special / holiday',
  season: 'Peak season',
  off_season: 'Off-season',
}
const KIND_RANK: Record<string, number> = { special: 3, season: 2, off_season: 1 }
export const seasonKindLabel = (k: string | null | undefined) => SEASON_KINDS[k ?? 'season'] ?? 'Season'

export interface TaxSlab {
  upto: number | null // per room per night tariff; null = no upper limit
  rate: number // percent
}

/** GST on accommodation (from 22 Sep 2025): up to ₹7,500/night 5%, above 18%. Editable in Settings. */
export const DEFAULT_TAX_SLABS: TaxSlab[] = [
  { upto: 1000, rate: 0 },
  { upto: 7500, rate: 5 },
  { upto: null, rate: 18 },
]

export interface Coupon {
  id: number
  code: string
  discount_type: 'pct' | 'flat'
  discount_value: number
  max_discount: number | null
  min_amount: number
  valid_from: string
  valid_to: string
  property_ids: string | null
  usage_limit: number | null
  used_count: number
  active: number
}

export interface NightLine {
  date: string
  rate: number
  label: string
}

export interface PriceInput {
  room: RoomRates
  seasons: SeasonRate[]
  checkIn: string
  checkOut: string
  roomsCount?: number
  taxSlabs?: TaxSlab[]
  coupon?: Coupon | null
  today?: string
  /** Meal plan asked for (CP / MAP / AP / EP); defaults to the plan the room's rates are for. */
  mealPlan?: string | null
  /** Guests staying (for extra-guest charges and the max-guest check). Leave out to price the rooms only. */
  adults?: number
  children?: number
  /** Staff discount as a percent of the room subtotal (quotes only). */
  discountPct?: number
  /** Flat staff discount in rupees (quotes only). */
  discountFlat?: number
  extraCharges?: number
}

export interface PriceResult {
  nights: number
  roomsCount: number
  lines: NightLine[]
  /** Extra guests above what the rate includes (when guests were given). */
  extraGuests: Occupancy | null
  /** Room rates only (before extra-guest charges). */
  roomCharges: number
  subtotal: number
  discount: number
  discountLabel: string | null
  extraCharges: number
  taxable: number
  taxRate: number
  taxes: number
  total: number
  minNights: number
  errors: string[]
}

function seasonsOn(room: RoomRates, seasons: SeasonRate[], date: string, plan?: string | null): SeasonRate[] {
  const want = plan || room.rate_meal_plan || null
  return seasons.filter(
    (s) =>
      (!s.meal_plan || s.meal_plan === want) &&
      seasonAppliesOn(s, date) &&
      (s.room_id === room.id || (s.room_id == null && (s.property_id == null || s.property_id === room.property_id))),
  )
}

function seasonFor(room: RoomRates, seasons: SeasonRate[], date: string, has?: (s: SeasonRate) => boolean, plan?: string | null): SeasonRate | undefined {
  // Supplements are added on top later; they never replace the rate.
  const matching = seasonsOn(room, seasons, date, plan).filter((s) => !isSupplementOnly(s) && (!has || has(s)))
  // Special / holiday beats season beats off-season; then room-specific beats property-wide beats global;
  // then the most recent start wins.
  const kind = (s: SeasonRate) => KIND_RANK[s.kind ?? 'season'] ?? 2
  const rank = (s: SeasonRate) => (s.room_id != null ? 2 : s.property_id != null ? 1 : 0)
  // A rate for the exact meal plan beats an "any plan" rate.
  const exact = (s: SeasonRate) => (s.meal_plan ? 1 : 0)
  // A recurring weekday rate (e.g. every Saturday) beats an every-night rate of the same type.
  const recurring = (s: SeasonRate) => (parseWeekdays(s.applicable_weekdays).length ? 1 : 0)
  matching.sort((a, b) => kind(b) - kind(a) || recurring(b) - recurring(a) || rank(b) - rank(a) || exact(b) - exact(a) || b.start_date.localeCompare(a.start_date))
  return matching[0]
}

/** New wizard peaks use stable keys; legacy records retain their name-based precedence. */
function supplementsOn(room: RoomRates, seasons: SeasonRate[], date: string): SeasonRate[] {
  const matching = seasonsOn(room, seasons, date).filter(isSupplementOnly)
  const managed: SeasonRate[] = []
  for (const common of matching.filter(s => commonPeakKey(s))) {
    const key = commonPeakKey(common)
    const override = matching.find(s => overridePeakKey(s) === key && s.property_id === common.property_id)
    managed.push(override ?? common)
  }
  const byName = new Map<string, SeasonRate>()
  const rank = (s: SeasonRate) => (s.room_id != null ? 2 : s.property_id != null ? 1 : 0)
  for (const s of matching.filter(s => !commonPeakKey(s) && !overridePeakKey(s))) {
    const cur = byName.get(s.name)
    if (!cur || rank(s) > rank(cur)) byName.set(s.name, s)
  }
  return [...byName.values(), ...managed]
}

export function isWeekendNight(room: RoomRates, date: string): boolean {
  return weekendNights(room).includes(weekday(date))
}

export function nightlyRate(room: RoomRates, seasons: SeasonRate[], date: string, plan?: string | null): NightLine {
  const isWeekend = isWeekendNight(room, date)
  const regular = isWeekend && room.weekend_rate ? room.weekend_rate : room.base_rate
  const s = seasonFor(room, seasons, date, undefined, plan)
  let line: NightLine = { date, rate: regular, label: isWeekend && room.weekend_rate ? 'Weekend' : 'Standard' }
  if (s?.source === 'wizard') {
    // Matrix blanks are intentional, including a blank weekend Direct cell.
    const direct = isWeekend ? s.weekend_rate : s.rate
    line = { date, rate: direct != null && direct > 0 ? direct : 0, label: s.name }
  } else if (s) {
    if (s.rate != null && s.rate > 0) line = { date, rate: Math.round(isWeekend && s.weekend_rate ? s.weekend_rate : s.rate), label: s.name }
    else if (s.pct_adjust != null) line = { date, rate: Math.round(regular * (1 + s.pct_adjust / 100)), label: s.name }
  }
  if (!(line.rate > 0)) return { date, rate: 0, label: PERSONALISED_OFFER }
  for (const sup of supplementsOn(room, seasons, date)) line = { date, rate: line.rate + (sup.supplement ?? 0), label: `${line.label} + ${sup.name}` }
  return line
}

/** Per-night rate of another tier (staff or net) for a stay: season tier rates beat the room's, weekends and supplements included. */
function tierForStay(room: RoomRates, seasons: SeasonRate[], checkIn: string, checkOut: string, tier: 'staff' | 'net', plan?: string | null): number | null {
  const nights = eachNight(checkIn, checkOut)
  const roomRate = tier === 'staff' ? room.staff_rate : (room as RoomRates & { net_rate?: number | null }).net_rate
  if (!nights.length) return roomRate ?? null
  let sum = 0
  for (const d of nights) {
    // The strongest season that actually has a figure for this tier (a "+25% Christmas" rule has no net rate).
    const s = seasonFor(room, seasons, d, (x) => !!(tier === 'staff' ? x.staff_rate : x.net_rate), plan)
    const wk = isWeekendNight(room, d)
    const configured = seasonFor(room, seasons, d, undefined, plan)
    if (tier === 'staff' && configured?.source === 'wizard') {
      const matrixValue = wk ? configured.staff_weekend_rate : configured.staff_rate
      if (!(matrixValue != null && matrixValue > 0)) return null
      sum += matrixValue + supplementsOn(room, seasons, d).reduce((a, x) => a + (x.supplement ?? 0), 0)
      continue
    }
    const seasonV = s ? (tier === 'staff' ? (wk && s.staff_weekend_rate) || s.staff_rate : (wk && s.net_weekend_rate) || s.net_rate) : null
    const v = seasonV || roomRate || null
    if (!v) return null
    const sup = supplementsOn(room, seasons, d).reduce((a, x) => a + ((tier === 'net' ? x.net_supplement ?? x.supplement : x.supplement) ?? 0), 0)
    sum += v + sup
  }
  return Math.round(sum / nights.length)
}

/** Average internal staff rate per room-night for a stay (season staff rates, weekends and supplements included). */
export function staffRateForStay(room: RoomRates, seasons: SeasonRate[], checkIn: string, checkOut: string, plan?: string | null): number | null {
  return tierForStay(room, seasons, checkIn, checkOut, 'staff', plan)
}

/** Average B2B net rate per room-night for a stay (management only). */
export function netRateForStay(room: RoomRates & { net_rate?: number | null }, seasons: SeasonRate[], checkIn: string, checkOut: string, plan?: string | null): number | null {
  return tierForStay(room, seasons, checkIn, checkOut, 'net', plan)
}

export function taxRateFor(perRoomNight: number, slabs: TaxSlab[] = DEFAULT_TAX_SLABS): number {
  const sorted = [...slabs].sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity))
  for (const s of sorted) if (s.upto == null || perRoomNight <= s.upto) return s.rate
  return sorted.at(-1)?.rate ?? 0
}

export function couponProblem(c: Coupon, propertyId: number, subtotal: number, today: string): string | null {
  if (!c.active) return 'This coupon is no longer active.'
  if (today < c.valid_from || today > c.valid_to) return 'This coupon is not valid today.'
  const ids = parseJson<number[] | null>(c.property_ids, null)
  if (ids && ids.length && !ids.includes(propertyId)) return 'This coupon does not apply to this property.'
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return 'This coupon has been fully used.'
  if (subtotal < c.min_amount) return `This coupon needs a minimum booking of ₹${c.min_amount}.`
  return null
}

export function couponDiscount(c: Coupon, subtotal: number): number {
  let d = c.discount_type === 'pct' ? (subtotal * c.discount_value) / 100 : c.discount_value
  if (c.max_discount != null) d = Math.min(d, c.max_discount)
  return Math.max(0, Math.min(Math.round(d), subtotal))
}

export function calculatePrice(input: PriceInput): PriceResult {
  const { room, seasons, checkIn, checkOut } = input
  const roomsCount = Math.max(1, input.roomsCount ?? 1)
  const errors: string[] = []
  const nights = nightsBetween(checkIn, checkOut)
  const empty: PriceResult = {
    nights: Math.max(0, nights), roomsCount, lines: [], extraGuests: null, roomCharges: 0, subtotal: 0, discount: 0, discountLabel: null,
    extraCharges: 0, taxable: 0, taxRate: 0, taxes: 0, total: 0, minNights: room.min_nights, errors,
  }
  if (!(nights > 0)) {
    errors.push('Check-out must be after check-in.')
    return empty
  }
  if (nights > 60) {
    errors.push('Stays longer than 60 nights need an enquiry.')
    return empty
  }

  const lines = eachNight(checkIn, checkOut).map((d) => nightlyRate(room, seasons, d, input.mealPlan))
  if (lines.some((line) => !(line.rate > 0))) {
    errors.push(PERSONALISED_OFFER)
    return empty
  }
  // Minimum stay: the strictest rule among the room and any season touching the stay.
  let minNights = room.min_nights || 1
  for (const d of lines) {
    const s = seasonFor(room, seasons, d.date, undefined, input.mealPlan)
    if (s?.min_nights) minNights = Math.max(minNights, s.min_nights)
  }
  if (nights < minNights) errors.push(`Minimum stay for these dates is ${minNights} nights.`)

  const roomCharges = lines.reduce((a, l) => a + l.rate, 0) * roomsCount
  let extraGuests: Occupancy | null = null
  if (input.adults != null || input.children != null) {
    extraGuests = occupancy(room, roomsCount, Math.max(0, input.adults ?? 0), Math.max(0, input.children ?? 0), nights)
    const guests = (input.adults ?? 0) + (input.children ?? 0)
    if (guests > extraGuests.max) errors.push(`${roomsCount} room${roomsCount > 1 ? 's' : ''} of this type sleep${roomsCount > 1 ? '' : 's'} at most ${extraGuests.max} guests. Please add a room.`)
  }
  // Extra-guest charges are part of the room tariff (GST applies to them too).
  const subtotal = roomCharges + (extraGuests?.total ?? 0)

  let discount = 0
  let discountLabel: string | null = null
  if (input.coupon) {
    const problem = couponProblem(input.coupon, room.property_id, subtotal, input.today ?? checkIn)
    if (problem) errors.push(problem)
    else {
      discount = couponDiscount(input.coupon, subtotal)
      discountLabel = `Coupon ${input.coupon.code}`
    }
  }
  if (input.discountPct && input.discountPct > 0) {
    discount += Math.round((subtotal * input.discountPct) / 100)
    discountLabel = discountLabel ? discountLabel + ' + discount' : `Discount ${input.discountPct}%`
  }
  if (input.discountFlat && input.discountFlat > 0) {
    discount += Math.round(input.discountFlat)
    discountLabel = discountLabel ?? 'Discount'
  }
  discount = Math.min(discount, subtotal)

  const extraCharges = Math.max(0, Math.round(input.extraCharges ?? 0))
  const taxable = subtotal - discount + extraCharges
  const perRoomNight = taxable / (nights * roomsCount)
  const taxRate = taxRateFor(perRoomNight, input.taxSlabs)
  const taxes = Math.round((taxable * taxRate) / 100)

  return {
    nights, roomsCount, lines, extraGuests, roomCharges, subtotal, discount, discountLabel, extraCharges, taxable, taxRate, taxes,
    total: taxable + taxes, minNights, errors,
  }
}

/** Rooms needed for a group, given room capacity. */
export function roomsNeeded(guests: number, capacity: number): number {
  return Math.max(1, Math.ceil(Math.max(1, guests) / Math.max(1, capacity)))
}

/** Effective discount percent on a quote option (for the staff limit check). */
export function discountPercent(subtotal: number, discount: number): number {
  if (subtotal <= 0) return 0
  return Math.round((discount / subtotal) * 1000) / 10
}

/** Season rows → per-room nightly rate for each upcoming season (room-specific beats property-wide beats all-property). */
export function seasonRates(rooms: Pick<RoomRow, 'id' | 'base_rate'>[], allRows: SeasonRate[], plan?: string | null) {
  // One meal plan per table (the property's rate plan): plan-specific rows for other plans are left out.
  const rows = allRows.filter((s) => !s.meal_plan || !plan || s.meal_plan === plan)
  type G = { name: string; kind: string; start: string; end: string; minNights: number | null; rates: Record<number, number>; weekendRates: Record<number, number>; staffRates: Record<number, number>; supplements: Record<number, number> }
  const groups = new Map<string, G>()
  for (const s of rows) {
    const key = `${s.name}|${s.start_date}|${s.end_date}`
    if (!groups.has(key)) groups.set(key, { name: s.name, kind: s.kind ?? 'season', start: s.start_date, end: s.end_date, minNights: s.min_nights, rates: {}, weekendRates: {}, staffRates: {}, supplements: {} })
  }
  for (const g of groups.values()) {
    const inGroup = rows.filter((s) => s.name === g.name && s.start_date === g.start && s.end_date === g.end)
    for (const r of rooms) {
      const s = inGroup.find((x) => x.room_id === r.id) ?? inGroup.find((x) => x.room_id == null && x.property_id != null) ?? inGroup.find((x) => x.property_id == null)
      if (!s) continue
      if (isSupplementOnly(s)) g.supplements[r.id] = s.supplement!
      else g.rates[r.id] = s.rate ?? Math.round(r.base_rate * (1 + (s.pct_adjust ?? 0) / 100))
      if (s.weekend_rate) g.weekendRates[r.id] = s.weekend_rate
      if (s.staff_rate) g.staffRates[r.id] = s.staff_rate
      if (s.min_nights) g.minNights = Math.max(g.minNights ?? 0, s.min_nights)
    }
  }
  return [...groups.values()].sort((a, b) => a.start.localeCompare(b.start))
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Fri – Sun nights" style label for a property's weekend. */
export function weekendLabel(weekend_nights: string | null | undefined): string {
  const d = weekendNights({ weekend_nights }).slice().sort((a, b) => ((a + 2) % 7) - ((b + 2) % 7))
  return d.length > 1 ? `${DAY[d[0]]} – ${DAY[d[d.length - 1]]} nights` : `${DAY[d[0]]} nights`
}
