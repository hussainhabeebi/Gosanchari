// Rule-based pricing. Prices are always calculated here, never by AI.

import { eachNight, nightsBetween, weekday, parseJson } from './util'

export interface RoomRates {
  id: number
  property_id: number
  base_rate: number
  weekend_rate: number | null
  min_nights: number
  capacity: number
  units: number
}

export interface SeasonRate {
  id?: number
  property_id: number | null
  room_id: number | null
  name: string
  start_date: string
  end_date: string // inclusive (last night the season applies to)
  rate: number | null
  pct_adjust: number | null
  min_nights: number | null
}

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

function seasonFor(room: RoomRates, seasons: SeasonRate[], date: string): SeasonRate | undefined {
  const matching = seasons.filter(
    (s) =>
      s.start_date <= date &&
      date <= s.end_date &&
      (s.room_id === room.id || (s.room_id == null && (s.property_id == null || s.property_id === room.property_id))),
  )
  // Room-specific beats property-wide, property-wide beats global; then the most recent start wins.
  const rank = (s: SeasonRate) => (s.room_id != null ? 2 : s.property_id != null ? 1 : 0)
  matching.sort((a, b) => rank(b) - rank(a) || b.start_date.localeCompare(a.start_date))
  return matching[0]
}

export function nightlyRate(room: RoomRates, seasons: SeasonRate[], date: string): NightLine {
  const dow = weekday(date)
  const isWeekendNight = dow === 5 || dow === 6 // Friday and Saturday nights
  const regular = isWeekendNight && room.weekend_rate ? room.weekend_rate : room.base_rate
  const s = seasonFor(room, seasons, date)
  if (s) {
    if (s.rate != null && s.rate > 0) return { date, rate: Math.round(s.rate), label: s.name }
    if (s.pct_adjust != null) return { date, rate: Math.round(regular * (1 + s.pct_adjust / 100)), label: s.name }
  }
  return { date, rate: regular, label: isWeekendNight && room.weekend_rate ? 'Weekend' : 'Standard' }
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
    nights: Math.max(0, nights), roomsCount, lines: [], subtotal: 0, discount: 0, discountLabel: null,
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

  const lines = eachNight(checkIn, checkOut).map((d) => nightlyRate(room, seasons, d))
  // Minimum stay: the strictest rule among the room and any season touching the stay.
  let minNights = room.min_nights || 1
  for (const d of lines) {
    const s = seasonFor(room, seasons, d.date)
    if (s?.min_nights) minNights = Math.max(minNights, s.min_nights)
  }
  if (nights < minNights) errors.push(`Minimum stay for these dates is ${minNights} nights.`)

  const subtotal = lines.reduce((a, l) => a + l.rate, 0) * roomsCount

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
    nights, roomsCount, lines, subtotal, discount, discountLabel, extraCharges, taxable, taxRate, taxes,
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
