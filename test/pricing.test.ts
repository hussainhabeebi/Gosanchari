import { describe, expect, it } from 'vitest'
import { calculatePrice, couponDiscount, couponProblem, nightlyRate, roomsNeeded, taxRateFor, type Coupon, type RoomRates, type SeasonRate } from '../src/lib/pricing'

const room: RoomRates = { id: 1, property_id: 10, base_rate: 4000, weekend_rate: 5000, min_nights: 1, capacity: 3, units: 2 }
// 2026-10-21 is a Wednesday; Fri 23 and Sat 24 are weekend nights.

describe('nightly rates', () => {
  it('uses weekend rate on Friday and Saturday nights only', () => {
    expect(nightlyRate(room, [], '2026-10-22').rate).toBe(4000) // Thu
    expect(nightlyRate(room, [], '2026-10-23').rate).toBe(5000) // Fri
    expect(nightlyRate(room, [], '2026-10-24').rate).toBe(5000) // Sat
    expect(nightlyRate(room, [], '2026-10-25').rate).toBe(4000) // Sun
  })
  it('room-specific season beats property-wide beats global', () => {
    const seasons: SeasonRate[] = [
      { property_id: null, room_id: null, name: 'Global', start_date: '2026-12-20', end_date: '2026-12-31', rate: null, pct_adjust: 10, min_nights: null },
      { property_id: 10, room_id: null, name: 'Property', start_date: '2026-12-20', end_date: '2026-12-31', rate: 6000, pct_adjust: null, min_nights: null },
      { property_id: 10, room_id: 1, name: 'Room', start_date: '2026-12-24', end_date: '2026-12-25', rate: 9000, pct_adjust: null, min_nights: null },
    ]
    expect(nightlyRate(room, seasons, '2026-12-24')).toMatchObject({ rate: 9000, label: 'Room' })
    expect(nightlyRate(room, seasons, '2026-12-22')).toMatchObject({ rate: 6000, label: 'Property' })
    const other = { ...room, id: 2, property_id: 99 }
    expect(nightlyRate(other, seasons, '2026-12-22')).toMatchObject({ rate: 4400, label: 'Global' }) // Tue +10%
  })
})

describe('calculatePrice', () => {
  it('prices a stay with weekend, rooms and GST slab', () => {
    const p = calculatePrice({ room, seasons: [], checkIn: '2026-10-22', checkOut: '2026-10-25', roomsCount: 2 })
    expect(p.nights).toBe(3)
    expect(p.subtotal).toBe((4000 + 5000 + 5000) * 2)
    expect(p.taxRate).toBe(5)
    expect(p.taxes).toBe(1400)
    expect(p.total).toBe(29400)
    expect(p.errors).toEqual([])
  })
  it('applies 18% GST above ₹7,500 per room-night', () => {
    const lux = { ...room, base_rate: 9000, weekend_rate: null }
    const p = calculatePrice({ room: lux, seasons: [], checkIn: '2026-10-21', checkOut: '2026-10-22' })
    expect(p.taxRate).toBe(18)
    expect(p.total).toBe(10620)
  })
  it('rejects bad dates and enforces season minimum nights', () => {
    expect(calculatePrice({ room, seasons: [], checkIn: '2026-10-22', checkOut: '2026-10-22' }).errors[0]).toMatch(/after check-in/)
    const s: SeasonRate[] = [{ property_id: null, room_id: null, name: 'Xmas', start_date: '2026-12-20', end_date: '2026-12-31', rate: null, pct_adjust: 25, min_nights: 3 }]
    const p = calculatePrice({ room, seasons: s, checkIn: '2026-12-24', checkOut: '2026-12-26' })
    expect(p.errors.join()).toMatch(/Minimum stay/)
    expect(p.minNights).toBe(3)
  })
  it('applies staff discount and extras before tax', () => {
    const p = calculatePrice({ room, seasons: [], checkIn: '2026-10-21', checkOut: '2026-10-22', discountPct: 10, extraCharges: 500 })
    expect(p.discount).toBe(400)
    expect(p.taxable).toBe(4100)
    expect(p.total).toBe(4100 + Math.round(4100 * 0.05))
  })
})

describe('coupons', () => {
  const c: Coupon = { id: 1, code: 'X', discount_type: 'pct', discount_value: 10, max_discount: 500, min_amount: 3000, valid_from: '2026-01-01', valid_to: '2026-12-31', property_ids: '[10]', usage_limit: 5, used_count: 0, active: 1 }
  it('caps percentage discounts', () => expect(couponDiscount(c, 10000)).toBe(500))
  it('validates scope, dates, minimum and usage', () => {
    expect(couponProblem(c, 10, 4000, '2026-06-01')).toBeNull()
    expect(couponProblem(c, 11, 4000, '2026-06-01')).toMatch(/does not apply/)
    expect(couponProblem(c, 10, 1000, '2026-06-01')).toMatch(/minimum/)
    expect(couponProblem(c, 10, 4000, '2027-01-01')).toMatch(/not valid/)
    expect(couponProblem({ ...c, used_count: 5 }, 10, 4000, '2026-06-01')).toMatch(/fully used/)
  })
  it('applies via calculatePrice', () => {
    const p = calculatePrice({ room, seasons: [], checkIn: '2026-10-21', checkOut: '2026-10-22', coupon: { ...c, min_amount: 0 }, today: '2026-06-01' })
    expect(p.discount).toBe(400)
  })
})

it('tax slabs and rooms needed', () => {
  expect(taxRateFor(900)).toBe(0)
  expect(taxRateFor(7500)).toBe(5)
  expect(taxRateFor(7501)).toBe(18)
  expect(roomsNeeded(5, 2)).toBe(3)
  expect(roomsNeeded(0, 2)).toBe(1)
})
