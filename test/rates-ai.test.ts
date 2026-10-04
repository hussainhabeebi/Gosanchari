import { describe, expect, it } from 'vitest'
import { allocateRooms } from '../src/lib/assistant'
import { calculatePrice, staffRateForStay, type RoomRates, type SeasonRate } from '../src/lib/pricing'
import { docxText, docxXmlToText } from '../src/lib/docs'
import { markup, matchRoom, normalizeRateSheet } from '../src/lib/ratesheet'

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
  it('cleans AI output and keeps only valid seasons', () => {
    const s = normalizeRateSheet({
      meal_plan: 'CP', rooms: [{ name: 'Deluxe Room', net_rate: '3,000', capacity: 3 }, { name: '' }],
      seasons: [
        { name: 'Christmas', kind: 'special', start_date: '2026-12-20', end_date: '2027-01-02', min_nights: 2, rates: { 'Deluxe Room': '5.5k', 'Pool Villa': 9000 } },
        { name: 'Bad', start_date: 'Dec 20', end_date: '2027-01-02', rates: { 'Deluxe Room': 1 } },
      ],
    })
    expect(s.rooms.map((r) => r.name)).toEqual(['Deluxe Room', 'Pool Villa'])
    expect(s.rooms[0].net_rate).toBe(3000)
    expect(s.seasons).toHaveLength(1)
    expect(s.seasons[0]).toMatchObject({ kind: 'special', min_nights: 2, rates: { 'Deluxe Room': 5500, 'Pool Villa': 9000 } })
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
