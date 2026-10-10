// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseQueryRules } from '../src/lib/search'
import { fallbackAnswer, findOptions, readNeed } from '../src/lib/assistant'

describe('assistant dates: what staff type', () => {
  const today = '2026-10-10'
  const dates = (q: string) => { const f = parseQueryRules(q, ['Vagamon', 'Munnar'], today); return [f.checkIn, f.checkOut] }
  it.each([
    ['Vagamon 4 guests 11 to 12 feb', '2027-02-11', '2027-02-12'],
    ['vagamon 11th feb to 12th feb 4 people', '2027-02-11', '2027-02-12'],
    ['vagamon feb 11 to 13, 4 pax', '2027-02-11', '2027-02-13'],
    ['vagamon 4 guests 12 feb 2 nights', '2027-02-12', '2027-02-14'],
    ['vagamon 11/2 to 12/2', '2027-02-11', '2027-02-12'],
    ['vagamon 24 dec to 2 jan', '2026-12-24', '2027-01-02'],
    ['munnar 30 dec - 1 jan', '2026-12-30', '2027-01-01'],
    ['munnar dec 12', '2026-12-12', '2026-12-13'],
  ])('%s → %s to %s', (q, ci, co) => expect(dates(q)).toEqual([ci, co]))
  it('does not read ordinary words as months', () => expect(dates('marriage party 12 guests munnar')).toEqual([undefined, undefined]))
})

function fixture(aiReply?: Record<string, unknown>) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  db.exec("UPDATE properties SET status = 'hidden' WHERE destination = 'Vagamon'")
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('ice-hills-vagamon','Ice Hills Vagamon','resort','Vagamon','live')").run().lastInsertRowid)
  // Staff and B2B rates only — no website (guest) rate, as entered for staff-only properties.
  const rid = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,base_guests,units) VALUES(?,'Standard Room Non-AC',0,3492,3242,3,2,5)").run(pid).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st } }
  const AI = aiReply ? { run: vi.fn(async () => ({ response: JSON.stringify(aiReply) })) } : undefined
  const env: any = { DB, AI, KV: { async get() { return null }, async put() {}, async delete() {} }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  return { db, env, pid, rid }
}

describe('assistant: impossible dates and missing guest rates', () => {
  it('keeps the dates typed in the message when the AI misreads them (the 124-night case)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T06:00:00Z'))
    try {
      // AI mixes "11" of this month with "12 feb": 11 Oct → 12 Feb.
      const f = fixture({ intent: 'find', destination: 'Vagamon', checkIn: '2026-10-11', checkOut: '2027-02-12', adults: 4 })
      const need = await readNeed(f.env, 'Vagamon 4 guests 11 to 12 feb', null)
      expect([need.checkIn, need.checkOut]).toEqual(['2027-02-11', '2027-02-12'])
      // AI-only dates far apart (nothing in the message to check against) are cut back to the asked length.
      const g = fixture({ intent: 'find', destination: 'Vagamon', checkIn: '2026-10-11', checkOut: '2027-02-12', nights: 2, adults: 4 })
      const n2 = await readNeed(g.env, 'Vagamon for 4, next long weekend', null)
      expect([n2.checkIn, n2.checkOut]).toEqual(['2026-10-11', '2026-10-13'])
    } finally { vi.useRealTimers() }
  })

  it('refuses to price a stay longer than 30 nights and says why', async () => {
    const f = fixture()
    const r = await findOptions(f.env, { intent: 'find', destination: 'Vagamon', checkIn: '2026-10-11', checkOut: '2027-02-12', adults: 4, guests: 4 }, true)
    expect(r.options).toEqual([])
    expect(r.datesIssue).toContain('124-night stay')
    expect(fallbackAnswer(r)).toContain('mistyped date')
  })

  it('shows “guest rate not set” (not ₹0) when a property has only staff rates', async () => {
    const f = fixture()
    const r = await findOptions(f.env, { intent: 'find', destination: 'Vagamon', checkIn: '2027-02-11', checkOut: '2027-02-12', adults: 4, guests: 4 }, true)
    const o = r.options.find((x) => x.id === f.pid)!
    expect(o.fits).toBe(true)
    expect(o.guestTotal).toBeNull()
    expect(o.gst).toBeNull()
    expect(o.lines.every((l) => l.guestPerNight === null)).toBe(true)
    expect(o.staffTotal).toBe(3492 * 2)
    expect(fallbackAnswer(r)).toContain('guest rate not set — staff total ₹6,984')
    expect(fallbackAnswer(r)).not.toContain('₹0')
  })
})
