import { describe, expect, it } from 'vitest'
import { filtersFromQuery, filtersToParams, parseQueryRules, sanitizeFilters } from '../src/lib/search'
import { leadScore } from '../src/lib/leadscore'
import { normalizePhone, toCsv, nightsBetween, eachNight } from '../src/lib/util'
import { ruleTags } from '../src/lib/assist'
import { detectLanguage, extractJson } from '../src/lib/ai'

const dests = ['Munnar', 'Wayanad', 'Alleppey']

describe('smart search rules', () => {
  it('reads the example sentence', () => {
    const f = parseQueryRules('Quiet homestay in Wayanad for 4, under ₹8,000', dests, '2026-10-02')
    expect(f).toMatchObject({ destination: 'Wayanad', guests: 4, priceMax: 8000, types: ['homestay'], q: 'quiet' })
  })
  it('reads date ranges and k amounts', () => {
    const f = parseQueryRules('houseboat alleppey 12-14 dec for 2 under 15k with breakfast', dests, '2026-10-02')
    expect(f).toMatchObject({ destination: 'Alleppey', checkIn: '2026-12-12', checkOut: '2026-12-14', priceMax: 15000, types: ['houseboat'], mealPlan: 'CP' })
  })
  it('rolls past dates into next year', () => {
    expect(parseQueryRules('5 jan', dests, '2026-10-02').checkIn).toBe('2027-01-05')
  })
  it('never trusts unexpected AI output', () => {
    const f = sanitizeFilters({ destination: 'Goa', guests: 999, types: ['castle', 'villa'], facilities: ['Wi-Fi', 'helipad'], priceMax: '₹9,000', checkIn: '2020-01-01' }, dests)
    expect(f).toEqual({ types: ['villa'], facilities: ['wifi'], priceMax: 9000 })
  })
  it('round-trips query params', () => {
    const f = filtersFromQuery({ destination: 'Munnar', type: ['villa', 'bogus'], facility: 'pool', guests: '4', sort: 'rating', checkIn: '2026-11-02', checkOut: '2026-11-01' })
    expect(f).toEqual({ destination: 'Munnar', types: ['villa'], facilities: ['pool'], guests: 4, sort: 'rating', checkIn: '2026-11-02' })
    expect(filtersToParams(f).getAll('type')).toEqual(['villa'])
  })
})

describe('lead score (rules, no AI)', () => {
  const base = { quoteViews: 0, guestReplyMinutes: null, daysToTravel: null, hasDates: false, hasBudget: false, isReturningGuest: false, status: 'new', lastGuestActivityHoursAgo: null }
  it('ranks an engaged, soon-travelling guest as hot', () => {
    const s = leadScore({ ...base, quoteViews: 3, guestReplyMinutes: 10, daysToTravel: 5, hasDates: true, hasBudget: true, status: 'quoted', lastGuestActivityHoursAgo: 2 })
    expect(s.label).toBe('Hot')
    expect(s.score).toBeGreaterThanOrEqual(65)
  })
  it('scores closed enquiries as zero', () => expect(leadScore({ ...base, status: 'lost' }).score).toBe(0))
  it('cold when nothing is known', () => expect(leadScore(base).label).toBe('Cold'))
})

describe('helpers', () => {
  it('normalises Indian phone numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210')
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210')
    expect(normalizePhone('09876543210')).toBe('+919876543210')
    expect(normalizePhone('123')).toBeNull()
  })
  it('escapes CSV and blocks formula injection', () => {
    expect(toCsv([{ a: '=HYPERLINK("x")', b: 'x,y' }])).toBe('a,b\r\n"\'=HYPERLINK(""x"")","x,y"')
  })
  it('counts nights', () => {
    expect(nightsBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(eachNight('2026-12-30', '2027-01-01')).toEqual(['2026-12-30', '2026-12-31'])
  })
  it('detects Malayalam and extracts JSON from model replies', () => {
    expect(detectLanguage('ഞങ്ങൾ 10 പേരുണ്ട്')).toBe('ml')
    expect(detectLanguage('We are 10 people')).toBe('en')
    expect(extractJson<{ a: number }>('Sure! ```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('no json here')).toBeNull()
  })
  it('tags enquiries by rules', () => {
    const t = ruleTags({ adults: 6, children: 4, budget: null, check_in: null, check_out: null, message: 'with elderly parents' })
    expect(t).toEqual(expect.arrayContaining(['family', 'group', 'elderly']))
  })
})
