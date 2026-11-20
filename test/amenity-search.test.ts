// Room amenities / facilities: a search box on the tile pickers, and no duplicate items for near-identical names.
import { describe, expect, it, vi } from 'vitest'
import { appFixture } from './helpers/app-fixture'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

async function setup() {
  const f = appFixture()
  const admin = await f.user('admin', 'tiles-admin@example.test')
  const add = async (kind: string, label: string) => (await (await f.req('/admin/taxonomy/add', { method: 'POST', cookie: admin.cookie, headers: { Accept: 'application/json' }, body: { kind, label } })).json()) as any
  return { ...f, admin, add }
}

describe('amenity search and duplicate prevention', () => {
  it('reuses an existing amenity when the new name differs only by case, spaces or punctuation', async () => {
    const f = await setup()
    const first = await f.add('amenity', 'Electric Kettle')
    for (const variant of ['electric kettle', 'Electric-Kettle', '  ELECTRIC   KETTLE ', 'Electric.Kettle']) {
      expect((await f.add('amenity', variant)).key).toBe(first.key)
    }
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM taxonomy WHERE kind = 'amenity' AND lower(label) LIKE '%kettle%'").get()).toEqual({ n: 1 })
    // Built-in items are matched too ("Wi-Fi" exists as wifi).
    const wifi = await f.add('facility', 'WiFi')
    expect(wifi.key).toBe('wifi')
    // A genuinely different name is still added.
    expect((await f.add('amenity', 'Electric Kettle & Tea Bags')).key).not.toBe(first.key)
  })

  it('shows a search box on the room amenities and facilities pickers, loaded with its script', async () => {
    const f = await setup()
    const id = Number(f.db.prepare("SELECT id FROM properties ORDER BY id LIMIT 1").get()!.id)
    const rooms = await (await f.req(`/admin/properties/${id}/setup/2`, { cookie: f.admin.cookie })).text()
    expect(rooms).toContain('placeholder="Search amenities…"')
    expect(rooms).toContain('data-tiles-search')
    expect(rooms).toContain('/content-editor.js')
    // The template for "Add Next Room Category" carries the search box as well.
    expect(rooms.slice(rooms.indexOf('room-block-tpl'))).toContain('data-tiles-search')
    const details = await (await f.req(`/admin/properties/${id}/setup/1`, { cookie: f.admin.cookie })).text()
    expect(details).toContain('placeholder="Search facilities &amp; activities…"')
  })
})
