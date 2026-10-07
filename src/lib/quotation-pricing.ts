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
