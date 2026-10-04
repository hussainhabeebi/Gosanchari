import { describe, expect, it } from 'vitest'
import { allocateRooms } from '../src/lib/assistant'
import { calculatePrice, staffRateForStay, type RoomRates, type SeasonRate } from '../src/lib/pricing'
import { docxText, docxXmlToText } from '../src/lib/docs'
import { markup, matchRoom, normalizeRateSheet, regularNet } from '../src/lib/ratesheet'

const room: RoomRates = { id: 1, property_id: 1, base_rate: 4000, weekend_rate: null, min_nights: 1, capacity: 3, units: 5, staff_rate: 3500 }
const season = (p: Partial<SeasonRate>): SeasonRate => ({ property_id: 1, room_id: 1, name: 'S', start_date: '2026-12-01', end_date: '2026-12-31', rate: null, pct_adjust: null, min_nights: null, ...p })

describe('season types', () => {
  it('special beats peak season beats off-season, whatever the scope', () => {
    const seasons = [
      season({ name: 'Peak', kind: 'season', rate: 5000 }),
      season({ name: 'Christmas', kind: 'special', room_id: null, start_date: '2026-12-24', end_date: '2026-12-25', rate: 9000 }),
      season({ name: 'Lean', kind: 'off_season', start_date: '2026-12-01', end_date: '2026-12-03', rate: 3000 }),
    ]
    const p = calculatePrice({ room, seasons, checkIn: '2026-12-02', checkOut: '2026-12-05' })
    expect(p.lines.map((l) => l.label)).toEqual(['Peak', 'Peak', 'Peak'])
    const x = calculatePrice({ room, seasons, checkIn: '2026-12-23', checkOut: '2026-12-26' })
    expect(x.lines.map((l) => l.rate)).toEqual([5000, 9000, 9000])
  })

  it('off-season applies when nothing stronger overlaps', () => {
    const p = calculatePrice({ room, seasons: [season({ name: 'Monsoon', kind: 'off_season', start_date: '2026-06-01', end_date: '2026-08-15', rate: 3000 })], checkIn: '2026-07-01', checkOut: '2026-07-03' })
    expect(p.subtotal).toBe(6000)
  })

  it('staff rate for a stay uses season staff rates when set', () => {
    const seasons = [season({ name: 'Peak', kind: 'season', rate: 5000, staff_rate: 4500, start_date: '2026-12-20' })]
    expect(staffRateForStay(room, seasons, '2026-12-19', '2026-12-21')).toBe(4000) // 3500 + 4500
    expect(staffRateForStay({ ...room, staff_rate: null }, [], '2026-12-19', '2026-12-21')).toBeNull()
  })
})

describe('group room allocation', () => {
  const rooms = [
    { name: 'Deluxe', capacity: 3, free: 4, guestStay: 8000 },
    { name: 'Suite', capacity: 5, free: 1, guestStay: 12000 },
    { name: 'Standard', capacity: 2, free: 10, guestStay: 5000 },
  ]
  it('finds the cheapest mix that sleeps everyone', () => {
    const a = allocateRooms(rooms, 15)!
    const sleeps = a.reduce((s, x) => s + x.count * x.room.capacity, 0)
    const cost = a.reduce((s, x) => s + x.count * x.room.guestStay, 0)
    expect(sleeps).toBeGreaterThanOrEqual(15)
    expect(cost).toBe(37000) // 1 × Suite (5) + 5 × Standard (10) is the cheapest way to sleep 15
  })
  it('returns null when free rooms are not enough', () => {
    expect(allocateRooms([{ capacity: 2, free: 2, guestStay: 1000 }], 5)).toBeNull()
  })
})

async function deflateRaw(b: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
}

async function zip(files: Record<string, string>): Promise<ArrayBuffer> {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name)
    const data = await deflateRaw(enc.encode(content))
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true); lh.setUint32(18, data.length, true); lh.setUint16(26, nameB.length, true)
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...nameB, ...data])
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true); ch.setUint32(20, data.length, true); ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true)
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...nameB]))
    locals.push(local)
    offset += local.length
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, centrals.length, true); end.setUint16(10, centrals.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
  const all = new Uint8Array([...locals.flatMap((l) => [...l]), ...centrals.flatMap((c) => [...c]), ...new Uint8Array(end.buffer)])
  return all.buffer
}

describe('Word documents', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Rate sheet 2026 &amp; 27</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:t>Deluxe</w:t></w:p></w:tc><w:tc><w:p><w:t>3,000</w:t></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
  it('turns Word XML into readable text with table rows', () => {
    expect(docxXmlToText(xml)).toContain('Rate sheet 2026 & 27')
    expect(docxXmlToText(xml)).toMatch(/Deluxe\s*\n?\s*\|\s*3,000/)
  })
  it('reads word/document.xml out of a .docx zip', async () => {
    const t = await docxText(await zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': xml }))
    expect(t).toContain('Deluxe')
    expect(t).toContain('3,000')
  })
})

describe('rate sheets', () => {
  it('cleans AI output and keeps only valid periods', () => {
    const s = normalizeRateSheet({
      meal_plan: 'CP', rooms: [{ name: 'Deluxe Room', net_rate: '3,000', capacity: 3 }, { name: '' }],
      seasons: [
        { name: 'Christmas', kind: 'special', start_date: '2026-12-20', end_date: '2027-01-02', min_nights: 2, rates: { 'Deluxe Room': '5.5k', 'Pool Villa': { weekday: 9000, weekend: 9500 } } },
        { name: 'Bad', start_date: 'Dec 20', end_date: '2027-01-02', rates: { 'Deluxe Room': 1 } },
      ],
    })
    expect(s.rooms.map((r) => r.name)).toEqual(['Deluxe Room', 'Pool Villa'])
    expect(s.rooms[0].net_rate).toBe(3000)
    expect(s.seasons).toHaveLength(1)
    expect(s.seasons[0]).toMatchObject({ kind: 'special', min_nights: 2, rates: { 'Deluxe Room': { weekday: 5500, weekend: null }, 'Pool Villa': { weekday: 9000, weekend: 9500 } } })
  })

  it('reads a full contract like the Ice Hills / Hawk sheet', () => {
    const s = normalizeRateSheet({
      meal_plan: 'CPAI', valid_from: '2026-04-01', valid_to: '2027-03-31', weekend_nights: ['Fri', 'Sat', 'Sun'],
      rooms: [{ name: 'Standard Room Non-AC', units: 4, rack_rate: 'Rs. 3999', base_guests: 2 }, { name: 'Honeymoon Hut Non-AC', units: '04', rack_rate: 6499 }],
      seasons: [
        { name: 'Apr–Sep 2026', kind: 'season', start_date: '2026-04-01', end_date: '2026-09-30', rates: { 'Standard Room Non-AC': { weekday: 'Rs.2500/-', weekend: 'Rs. 2750/-' }, 'Honeymoon Hut Non-AC': { weekday: 4000, weekend: 4250 } } },
        { name: 'Oct 2026–Mar 2027', start_date: '2026-10-01', end_date: '2027-03-31', rates: { 'Standard Room Non-AC': { weekday: 3000, weekend: 3250 } } },
      ],
      supplements: [{ name: "X'mas peak", start_date: '2026-12-20', end_date: '2027-01-05', amount: 'Rs.1000/-' }],
      extras: { extra_adult: 1000, child_with_bed: 750, child_no_bed: 400, child_free_below: 6, child_age_to: 11 },
      addons: [{ name: 'Campfire (1 hr)', net: 1500 }, { name: 'Candle Light Dinner', price: 'Rs.3000/-' }, { name: 'Free stuff' }],
      cancellation_policy: '30+ days: 100% credit; 15 days: 75%; 7 days: 50%; under 7 days: no refund',
      contacts: [{ name: 'Azeem A R', role: 'AGM Sales & Marketing', phone: '96053 77755' }],
    })
    expect(s.weekend_nights).toEqual([5, 6, 0])
    expect(s.rooms[1]).toMatchObject({ units: 4, rack_rate: 6499 })
    expect(s.seasons).toHaveLength(2)
    expect(s.seasons[0].rates['Standard Room Non-AC']).toEqual({ weekday: 2500, weekend: 2750 })
    expect(s.supplements).toEqual([{ name: "X'mas peak", kind: 'special', start_date: '2026-12-20', end_date: '2027-01-05', amount: 1000 }])
    expect(s.extras).toEqual({ extra_adult: 1000, child_with_bed: 750, child_no_bed: 400, child_free_below: 6, child_age_to: 11 })
    expect(s.addons.map((a) => [a.name, a.net])).toEqual([['Campfire (1 hr)', 1500], ['Candle Light Dinner', 3000]])
    expect(s.contacts[0].phone).toBe('96053 77755')
    expect(regularNet(s, s.rooms[0])).toEqual({ weekday: 2500, weekend: 2750 })
  })

  it('matches sheet rooms to our room categories', () => {
    const ours = [{ id: 1, name: 'Deluxe' }, { id: 2, name: 'Family Suite' }]
    expect(matchRoom('Deluxe Room', ours)).toBe(1)
    expect(matchRoom('FAMILY SUITE', ours)).toBe(2)
    expect(matchRoom('Tree house', ours)).toBeNull()
  })
  it('suggests staff and guest rates from net', () => {
    expect(markup(3000, 15)).toBe(3450)
    expect(markup(3000, 35)).toBe(4050)
    expect(markup(null, 10)).toBeNull()
  })
})

describe('weekend nights and supplements', () => {
  const room: RoomRates = { id: 1, property_id: 1, base_rate: 4000, weekend_rate: 4500, min_nights: 1, capacity: 2, units: 4, weekend_nights: '5,6,0' }
  const period = (p: Partial<SeasonRate>): SeasonRate => ({ property_id: 1, room_id: 1, name: 'Oct–Mar', start_date: '2026-10-01', end_date: '2027-03-31', rate: 3500, pct_adjust: null, min_nights: null, kind: 'season', weekend_rate: 3750, staff_rate: 3100, staff_weekend_rate: 3300, ...p })
  it('uses the property weekend (Fri–Sun) and the period weekend rate', () => {
    // 2026-12-06 is a Sunday night, 2026-12-07 a Monday night
    const p = calculatePrice({ room, seasons: [period({})], checkIn: '2026-12-06', checkOut: '2026-12-08' })
    expect(p.lines.map((l) => l.rate)).toEqual([3750, 3500])
    const noSun = calculatePrice({ room: { ...room, weekend_nights: '5,6' }, seasons: [period({})], checkIn: '2026-12-06', checkOut: '2026-12-07' })
    expect(noSun.lines[0].rate).toBe(3500)
  })
  it("adds a supplement on top of the period rate (X'mas +1000)", () => {
    const xmas = period({ name: "X'mas", kind: 'special', start_date: '2026-12-20', end_date: '2027-01-05', rate: null, weekend_rate: null, staff_rate: null, staff_weekend_rate: null, supplement: 1000, net_supplement: 1000 })
    const p = calculatePrice({ room, seasons: [period({}), xmas], checkIn: '2026-12-21', checkOut: '2026-12-22' }) // Monday night
    expect(p.lines[0].rate).toBe(4500)
    expect(p.lines[0].label).toContain("X'mas")
    expect(staffRateForStay(room, [period({}), xmas], '2026-12-21', '2026-12-22')).toBe(4100)
  })
})

describe('guests included in the rate and extra-guest charges', () => {
  const double: RoomRates = { id: 7, property_id: 1, base_rate: 4000, weekend_rate: null, min_nights: 1, capacity: 4, units: 5, base_guests: 2, extra_adult_rate: 1000, extra_child_rate: 500 }
  const cottage: RoomRates = { id: 8, property_id: 1, base_rate: 20000, weekend_rate: null, min_nights: 1, capacity: 10, units: 1, base_guests: 8, extra_adult_rate: 1500, extra_child_rate: null }

  it('charges each guest above the included number, per night', () => {
    const p = calculatePrice({ room: double, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-04', adults: 3, children: 1 })
    expect(p.roomCharges).toBe(8000)
    expect(p.extraGuests).toMatchObject({ included: 2, max: 4, extraAdults: 1, extraChildren: 1, perNight: 1500, total: 3000 })
    expect(p.subtotal).toBe(11000)
    expect(p.errors).toEqual([])
  })

  it('no extra charge within the included guests; children fill included places after adults', () => {
    expect(calculatePrice({ room: double, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03', adults: 1, children: 1 }).extraGuests!.total).toBe(0)
    expect(calculatePrice({ room: double, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03', adults: 2, children: 2 }).extraGuests!.total).toBe(1000)
  })

  it('large cottage: rate for 8, max 10, 2 extra adults pay', () => {
    const p = calculatePrice({ room: cottage, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03', adults: 10 })
    expect(p.extraGuests!.total).toBe(3000)
    expect(p.subtotal).toBe(23000)
    expect(calculatePrice({ room: cottage, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03', adults: 11 }).errors[0]).toMatch(/at most 10 guests/)
  })

  it('counts included guests per room when several rooms are booked', () => {
    const p = calculatePrice({ room: double, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03', roomsCount: 2, adults: 5 })
    expect(p.extraGuests).toMatchObject({ included: 4, max: 8, extraAdults: 1, total: 1000 })
  })

  it('without guest numbers, rooms are priced alone (old behaviour)', () => {
    const p = calculatePrice({ room: double, seasons: [], checkIn: '2026-11-02', checkOut: '2026-11-03' })
    expect(p.extraGuests).toBeNull()
    expect(p.subtotal).toBe(4000)
  })

  it('group allocation uses extra beds when cheaper than another room', () => {
    const a = allocateRooms([{ capacity: 4, base: 2, free: 5, guestStay: 4000, extraStay: 1000 }], 6)!
    expect(a[0].count).toBe(2)
    expect(a[0].guests).toBe(6)
    expect(a[0].extra).toBe(2000)
  })
})
