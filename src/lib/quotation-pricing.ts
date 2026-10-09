import { calculatePrice, staffRateForStay, type PriceInput, type PriceResult } from './pricing'
import { addDays, eachNight, money } from './util'

export type QuotationPrice = PriceResult & { staffAccommodation: number | null; maximumDiscount: number | null }

/** Quote-only rules: extras never finance a room discount; public pricing is untouched. */
export function quotationPrice(input: PriceInput & { discountAmount: number; applyGst?: boolean; staffRoom?: PriceInput['room']; staffSeasons?: PriceInput['seasons'] }): QuotationPrice {
  const base = calculatePrice({ ...input, discountPct: 0, discountFlat: 0, coupon: null })
  const nights = eachNight(input.checkIn, input.checkOut)
  const staffNights = nights.map(date => staffRateForStay(input.staffRoom ?? input.room, input.staffSeasons ?? input.seasons, date, addDays(date, 1), input.mealPlan))
  const staffAccommodation = nights.length && staffNights.every(rate => rate != null && rate > 0)
    ? staffNights.reduce<number>((sum, rate) => sum + rate!, 0) * base.roomsCount : null
  const amount = input.discountAmount
  const errors = [...base.errors]
  if (!Number.isSafeInteger(amount) || amount < 0) errors.push('Enter a valid whole-rupee Discount Amount.')
  else if (staffAccommodation == null && amount > 0) errors.push('Discount cannot be applied because the Staff Rate could not be resolved for the selected room, dates and meal plan.')
  else if (staffAccommodation != null && base.roomCharges - amount < staffAccommodation) {
    const benchmark = staffAccommodation / Math.max(1, base.nights * base.roomsCount)
    errors.push(`Discount cannot reduce the selling rate below the Staff Rate of ${money(benchmark)}.`)
  } else if (amount > base.roomCharges) errors.push('Discount cannot exceed the accommodation charges.')
  const price = calculatePrice({ ...input, discountPct: 0, discountFlat: amount, coupon: null })
  const taxes = input.applyGst === false ? 0 : price.taxes
  return { ...price, errors, taxes, total: price.taxable + taxes, staffAccommodation,
    maximumDiscount: staffAccommodation == null ? null : Math.max(0, base.roomCharges - staffAccommodation) }
}

export const gstLabel = (applyGst: number | boolean | undefined) => applyGst === 0 || applyGst === false ? 'GST not applied' : 'GST'

/** Legacy default inclusions listed GST independently of the selected tax state. */
export function quotationInclusions(text: string | null, applyGst: number | undefined): string {
  return applyGst === 0 ? (text ?? '').split('\n').filter(line => line.trim().toUpperCase() !== 'GST').join('\n') : text ?? ''
}

type QuoteLineInput = Omit<Parameters<typeof quotationPrice>[0], 'discountAmount' | 'extraCharges' | 'applyGst'>
export type CombinedQuotationPrice = QuotationPrice & { parts: QuotationPrice[] }

/**
 * Share the option's guests between its room categories: each category's included places first (in order), then up to
 * its maximum; anything left stays on the first category, whose pricing then reports the shortfall.
 */
export function splitGuests(lines: { capacity: number; base_guests?: number | null; rooms: number }[], adults: number, children: number): { adults: number; children: number }[] {
  const out = lines.map(() => ({ adults: 0, children: 0 }))
  let a = Math.max(0, adults), ch = Math.max(0, children)
  const fill = (limit: (i: number) => number) => lines.forEach((_, i) => {
    let room = Math.max(0, limit(i) - out[i].adults - out[i].children)
    const ta = Math.min(a, room); out[i].adults += ta; a -= ta; room -= ta
    const tc = Math.min(ch, room); out[i].children += tc; ch -= tc
  })
  fill((i) => Math.max(1, Math.min(lines[i].base_guests ?? lines[i].capacity, lines[i].capacity)) * Math.max(1, lines[i].rooms))
  fill((i) => Math.max(1, lines[i].capacity) * Math.max(1, lines[i].rooms))
  if (out.length) { out[0].adults += a; out[0].children += ch }
  return out
}

/**
 * Quote price for an option with one or more room categories (same property, dates and meal plan). Each category is
 * priced by its own rules (and its own GST slab); the discount is checked against the combined Staff floor and shared in
 * proportion to each category's margin above its Staff Rate, so no category goes below its floor. Extras ride on the
 * first category. One category gives exactly `quotationPrice`.
 */
export function combinedQuotationPrice(lines: QuoteLineInput[], o: { discountAmount: number; extraCharges?: number; applyGst?: boolean }): CombinedQuotationPrice {
  if (lines.length <= 1) {
    const p = quotationPrice({ ...lines[0], discountAmount: o.discountAmount, extraCharges: o.extraCharges, applyGst: o.applyGst })
    return { ...p, parts: [p] }
  }
  const bases = lines.map((l) => quotationPrice({ ...l, discountAmount: 0, applyGst: o.applyGst }))
  const R = bases.reduce((a, p) => a + p.roomCharges, 0)
  const S = bases.every((p) => p.staffAccommodation != null) ? bases.reduce((a, p) => a + p.staffAccommodation!, 0) : null
  const rooms = bases.reduce((a, p) => a + p.roomsCount, 0)
  const nights = bases[0].nights
  const amount = o.discountAmount
  const errors = [...new Set(bases.flatMap((p) => p.errors))]
  if (!Number.isSafeInteger(amount) || amount < 0) errors.push('Enter a valid whole-rupee Discount Amount.')
  else if (S == null && amount > 0) errors.push('Discount cannot be applied because the Staff Rate could not be resolved for the selected rooms, dates and meal plan.')
  else if (S != null && R - amount < S) errors.push(`Discount cannot reduce the selling rate below the Staff Rate of ${money(S / Math.max(1, nights * rooms))}.`)
  else if (amount > R) errors.push('Discount cannot exceed the accommodation charges.')
  // Share the discount: by margin when every Staff Rate is known, otherwise by room charges.
  const safe = Number.isSafeInteger(amount) && amount > 0 ? Math.min(amount, R) : 0
  const weights = bases.map((p) => (S != null && R - S > 0 ? Math.max(0, p.roomCharges - p.staffAccommodation!) : p.roomCharges))
  const W = weights.reduce((a, w) => a + w, 0)
  const shares = weights.map((w) => (W > 0 ? Math.floor((safe * w) / W) : 0))
  let left = safe - shares.reduce((a, x) => a + x, 0)
  for (let i = 0; left > 0 && i < shares.length; i++) {
    const room = Math.max(0, Math.floor(weights[i]) - shares[i])
    const add = Math.min(room, left); shares[i] += add; left -= add
  }
  if (left > 0) shares[0] += left
  const parts = lines.map((l, i) => quotationPrice({ ...l, discountAmount: shares[i], extraCharges: i === 0 ? o.extraCharges : 0, applyGst: o.applyGst }))
  const sum = (k: 'roomCharges' | 'subtotal' | 'discount' | 'extraCharges' | 'taxable' | 'taxes' | 'total') => parts.reduce((a, p) => a + p[k], 0)
  const guests = parts.map((p) => p.extraGuests).filter((g): g is NonNullable<typeof g> => g != null)
  const extraGuests = guests.length ? guests.reduce((a, g) => ({
    included: a.included + g.included, max: a.max + g.max, extraAdults: a.extraAdults + g.extraAdults, extraChildren: a.extraChildren + g.extraChildren,
    perNight: a.perNight + g.perNight, total: a.total + g.total,
  })) : null
  return {
    nights, roomsCount: rooms, lines: parts.flatMap((p) => p.lines), extraGuests,
    roomCharges: sum('roomCharges'), subtotal: sum('subtotal'), discount: sum('discount'), discountLabel: null, extraCharges: sum('extraCharges'),
    taxable: sum('taxable'), taxRate: Math.max(...parts.map((p) => p.taxRate)), taxes: sum('taxes'), total: sum('total'),
    minNights: Math.max(...parts.map((p) => p.minNights)), errors,
    staffAccommodation: S, maximumDiscount: S == null ? null : Math.max(0, R - S), parts,
  }
}
