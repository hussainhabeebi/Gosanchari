import { describe, expect, it } from 'vitest'
import { staffRateForStay, netRateForStay, calculatePrice, couponDiscount, couponProblem, nightlyRate, roomsNeeded, taxRateFor, type Coupon, type RoomRates, type SeasonRate } from '../src/lib/pricing'

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


describe('CP-only private matrix rates', () => {
  const matrixRoom = {...room, base_rate: 0, weekend_rate: null, weekend_nights: '5,6,0', rate_meal_plan: 'CP'}
  const season: SeasonRate = {property_id:10,room_id:1,name:'Season',kind:'season',source:'wizard',meal_plan:'CP',start_date:'2026-10-01',end_date:'2027-03-31',rate:null,weekend_rate:null,staff_rate:3250,staff_weekend_rate:3500,net_rate:3000,net_weekend_rate:3250,pct_adjust:null,min_nights:null}
  it('resolves only the configured meal plan, dates and private tiers', () => {
    expect(staffRateForStay(matrixRoom,[season],'2026-10-08','2026-10-09')).toBe(3250)
    expect(staffRateForStay(matrixRoom,[season],'2026-10-09','2026-10-10')).toBe(3500)
    expect(netRateForStay(matrixRoom,[season],'2026-10-11','2026-10-12')).toBe(3250)
    for (const plan of ['MAP','AP','EP']) expect(staffRateForStay(matrixRoom,[season],'2026-10-08','2026-10-09',plan)).toBeNull()
    expect(staffRateForStay(matrixRoom,[season],'2027-04-01','2027-04-02')).toBeNull()
  })
  it('rejects unresolved Direct rates and never sells a supplement alone or a legacy fallback', () => {
    const peak: SeasonRate = {...season,name:'Peak',kind:'special',meal_plan:null,start_date:'2026-12-20',end_date:'2027-01-05',staff_rate:null,net_rate:null,supplement:1000}
    for (const checkIn of ['2026-10-08','2026-10-09','2026-12-24']) {
      const checkOut = checkIn.slice(0,8)+String(Number(checkIn.slice(8))+1).padStart(2,'0')
      const result = calculatePrice({room:{...matrixRoom,base_rate:9999},seasons:[season,peak],checkIn,checkOut})
      expect(result.errors).toEqual(['For a personalised offer, fill in your details below and enquire.'])
      expect(result.lines).toEqual([])
    }
    expect(staffRateForStay(matrixRoom,[season,peak],'2026-12-24','2026-12-25')).toBe(4250)
    expect(netRateForStay(matrixRoom,[season,peak],'2026-12-24','2026-12-25')).toBe(4000)
  })
  it('preserves blank weekday/weekend Direct cells independently', () => {
    expect(nightlyRate(matrixRoom,[{...season,rate:7000}],'2026-10-08').rate).toBe(7000)
    expect(nightlyRate(matrixRoom,[{...season,rate:7000}],'2026-10-09').rate).toBe(0)
    expect(nightlyRate(matrixRoom,[{...season,weekend_rate:7500}],'2026-10-09').rate).toBe(7500)
    expect(nightlyRate(matrixRoom,[{...season,weekend_rate:7500}],'2026-10-08').rate).toBe(0)
  })
})


it.each([[3000,3250,3250,3500],[3500,3750,3800,4000],[4250,4500,4750,5000],[5250,5500,5750,6000],[5000,5250,5500,5750]])('keeps supplied CP private tiers independent: %s/%s', (net,netWeekend,staff,staffWeekend) => {
  const r = {...room,base_rate:0,weekend_rate:null,rate_meal_plan:'CP',weekend_nights:'5,6,0'}
  const s: SeasonRate = {property_id:10,room_id:1,name:'CP',source:'wizard',kind:'season',meal_plan:'CP',start_date:'2026-10-01',end_date:'2027-03-31',rate:null,pct_adjust:null,min_nights:null,staff_rate:staff,staff_weekend_rate:staffWeekend,net_rate:net,net_weekend_rate:netWeekend}
  expect(staffRateForStay(r,[s],'2026-10-08','2026-10-09')).toBe(staff)
  expect(staffRateForStay(r,[s],'2026-10-09','2026-10-10')).toBe(staffWeekend)
  expect(netRateForStay(r,[s],'2026-10-08','2026-10-09')).toBe(net)
  expect(netRateForStay(r,[s],'2026-10-09','2026-10-10')).toBe(netWeekend)
  expect(calculatePrice({room:r,seasons:[s],checkIn:'2026-10-09',checkOut:'2026-10-10'}).errors).not.toEqual([])
})

it('preserves legacy catalogue dated public rates and missing Staff without fallback', () => {
  const r = {...room,rate_meal_plan:'CP'}
  const s: SeasonRate = {property_id:10,room_id:1,name:'May',source:'catalogue',meal_plan:'CP',start_date:'2026-05-01',end_date:'2026-05-31',rate:7000,staff_rate:null,net_rate:null,pct_adjust:null,min_nights:null}
  expect(nightlyRate(r,[s],'2026-05-08').rate).toBe(7000)
  expect(staffRateForStay(r,[s],'2026-05-08','2026-05-09')).toBeNull()
  expect(nightlyRate(r,[],'2026-10-23').rate).toBe(5000)
})
