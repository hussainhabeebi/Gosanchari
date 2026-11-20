// Property cards and the stay page show total rooms and the guest range (one room's included guests → whole property).
import { describe, expect, it, vi } from 'vitest'
import { appFixture } from './helpers/app-fixture'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

describe('rooms and guest capacity on the public site', () => {
  it('sums active rooms and capacity, ignores inactive rooms, and shows them on cards and the stay page', async () => {
    const f = appFixture()
    const id = Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status,featured,facilities) VALUES('cap-test','Capacity Test Villa','villa','Munnar','live',1,'[\"pool\"]')").run().lastInsertRowid)
    const room = (name: string, units: number, capacity: number, base: number | null, active = 1) =>
      f.db.prepare('INSERT INTO rooms(property_id,name,base_rate,units,capacity,base_guests,active) VALUES(?,?,5000,?,?,?,?)').run(id, name, units, capacity, base, active)
    room('Deluxe', 6, 3, 2)      // 6 rooms, up to 18 guests
    room('Family Suite', 3, 4, 4) // 3 rooms, up to 12 guests
    room('Old Wing', 5, 4, 1, 0)  // inactive: not counted
    const card = await (await f.req('/search?destination=Munnar')).text()
    const block = card.slice(card.indexOf('Capacity Test Villa') - 1500, card.indexOf('Capacity Test Villa') + 1500)
    expect(block).toContain('aria-label="9 rooms, 2–30 guests"')
    expect(block).toMatch(/<strong>9<\/strong> rooms/)
    expect(block).toMatch(/<strong>2–30<\/strong> guests/)
    const stay = await (await f.req('/stay/cap-test')).text()
    expect(stay).toContain('aria-label="9 rooms, 2–30 guests"')
  })

  it('shows "Up to N" when every room includes the full capacity, and nothing when there are no rooms', async () => {
    const f = appFixture()
    const id = Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('cap-one','One Room Stay','homestay','Vagamon','live')").run().lastInsertRowid)
    const summary = (html: string) => html.slice(html.indexOf('<div class="property-summary">'), html.indexOf('<section', html.indexOf('<div class="property-summary">')))
    expect(summary(await (await f.req('/stay/cap-one')).text())).not.toContain('capacity-facts')
    f.db.prepare("INSERT INTO rooms(property_id,name,base_rate,units,capacity,base_guests) VALUES(?,'Cottage',3000,1,2,NULL)").run(id)
    expect(await (await f.req('/stay/cap-one')).text()).toContain('aria-label="1 room, Up to 2 guests"')
  })
})
