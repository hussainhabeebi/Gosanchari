import { describe, expect, it } from 'vitest'
import { extractPrompt, normalizeExtract } from '../src/lib/propextract'

describe('property quick fill', () => {
  it('maps loose AI output onto editor fields', () => {
    const r = normalizeExtract({
      fields: {
        name: 'Misty Hills Resort', type: 'Resort', destination: 'Munnar', star_category: '3',
        facilities: ['Swimming pool', 'wifi', 'Parking', 'helipad'], checkin_time: '2 pm', checkout_time: '11:00',
        pet_friendly: 'no', meal_plans: 'CP, MAP', highlights: ['Valley views', 'Tea estate walks'],
        lat: 10.08, lng: 77.05, map_url: 'not a link', unknown_key: 'x', d_price_cp: '₹450',
      },
      rooms: [{ name: 'Deluxe Valley View', units: 8, base_rate: '4.5k', weekend_rate: 5500, amenities: ['AC', 'Balcony', 'Kettle'], room_view: 'valley' }, { units: 2 }],
      seasons: [
        { name: 'Christmas', start_date: '2026-12-20', end_date: '2027-01-05', min_nights: 2, rates: { 'Deluxe Valley View': '7,500' } },
        { name: 'Bad', start_date: '20 Dec', end_date: '2027-01-05', rates: { x: 1 } },
      ],
    })
    expect(r.fields.name).toBe('Misty Hills Resort')
    expect(r.fields.type).toBe('resort')
    expect(r.fields.star_category).toBe('3')
    expect(r.fields.facilities).toEqual(['pool', 'wifi', 'parking'])
    expect(r.fields.checkin_time).toBe('14:00')
    expect(r.fields.pet_friendly).toBe(false)
    expect(r.fields.meal_plans).toEqual(['CP', 'MAP'])
    expect(r.fields.highlights).toBe('Valley views\nTea estate walks')
    expect(r.fields.lat).toBe('10.08')
    expect(r.fields.map_url).toBeUndefined()
    expect(r.fields.unknown_key).toBeUndefined()
    expect(r.fields.d_price_cp).toBe('450')
    expect(r.rooms).toHaveLength(1)
    expect(r.rooms[0]).toMatchObject({ name: 'Deluxe Valley View', units: '8', base_rate: '4500', room_view: 'Valley', amenities: ['ac', 'balcony', 'kettle'] })
    expect(r.seasons).toEqual([{ name: 'Christmas', start_date: '2026-12-20', end_date: '2027-01-05', min_nights: 2, rates: { 'Deluxe Valley View': 7500 } }])
  })

  it('survives junk', () => {
    expect(normalizeExtract(null)).toEqual({ fields: {}, rooms: [], seasons: [] })
    expect(normalizeExtract('text')).toEqual({ fields: {}, rooms: [], seasons: [] })
  })

  it('prompt lists allowed options and the notes', () => {
    const p = extractPrompt('Lake view cottage', '2026-10-03')
    expect(p).toContain('Today is 2026-10-03')
    expect(p).toContain('Lake view cottage')
    expect(p).toContain('d_cuisines')
  })
})
