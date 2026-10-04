// B2B rate sheets (PDF / Word from resorts): AI reads room categories, seasons and net rates; staff review the result
// before anything is saved. Staff and guest rates are suggested from the net rate with the markups chosen on upload.

import { todayIST } from './util'

export interface SheetRoom {
  name: string
  net_rate: number | null
  net_weekend_rate: number | null
  capacity: number | null
  extra_bed_rate: number | null
  notes: string
}

export interface SheetSeason {
  name: string
  kind: 'season' | 'off_season' | 'special'
  start_date: string
  end_date: string
  min_nights: number | null
  /** Sheet room name → net rate. */
  rates: Record<string, number>
}

export interface RateSheet {
  meal_plan: string
  valid_from: string | null
  valid_to: string | null
  rooms: SheetRoom[]
  seasons: SheetSeason[]
  notes: string
}

export function rateSheetPrompt(notes: string, today = todayIST()) {
  return `Today is ${today}. This is a B2B (net / contract) rate sheet a hotel or resort in Kerala, India sent to a travel company.
Extract the rates as JSON:
{
  "meal_plan": "plan the rates include, e.g. EP, CP (breakfast), MAP, AP",
  "valid_from": "YYYY-MM-DD or null", "valid_to": "YYYY-MM-DD or null",
  "rooms": [{"name": "room category", "net_rate": regular per room per night, "net_weekend_rate": number or null, "capacity": max guests or null, "extra_bed_rate": number or null, "notes": "short"}],
  "seasons": [{"name": "e.g. Peak season, Christmas & New Year, Off season", "kind": "season" | "off_season" | "special", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD (last night)", "min_nights": number or null, "rates": {"<room name exactly as in rooms>": net rate}}],
  "notes": "other terms: child policy, supplements, blackout dates, taxes included or not"
}
Rules: numbers only, in rupees, per room per night (convert "4.5k" to 4500). Use ONLY the sheet's figures, never invent.
"kind": "special" for festivals/holidays/events (Christmas, New Year, Onam, Diwali, Easter, long weekends), "off_season" for low/lean/monsoon season, otherwise "season".
If the regular (non-season) rate is shown only as a season (e.g. "Regular season"), put it in rooms.net_rate and do not repeat it as a season.
For dates without a year use the next upcoming occurrence. Reply with JSON only.

Rate sheet:
"""
${notes}
"""`
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null
  const s = String(v ?? '').toLowerCase().replace(/[₹,\s]|rs\.?|inr|\/-/g, '')
  const m = s.match(/^(\d+(?:\.\d+)?)(k)?/)
  if (!m) return null
  const n = parseFloat(m[1]) * (m[2] ? 1000 : 1)
  return n > 0 ? Math.round(n) : null
}
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max)

export function normalizeRateSheet(raw: unknown): RateSheet {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rooms: SheetRoom[] = (Array.isArray(r.rooms) ? r.rooms : [])
    .map((x) => (x && typeof x === 'object' ? x : {}) as Record<string, unknown>)
    .map((x) => ({ name: text(x.name, 80), net_rate: num(x.net_rate), net_weekend_rate: num(x.net_weekend_rate), capacity: num(x.capacity), extra_bed_rate: num(x.extra_bed_rate), notes: text(x.notes) }))
    .filter((x) => x.name)
    .slice(0, 30)
  const seasons: SheetSeason[] = []
  for (const s of (Array.isArray(r.seasons) ? r.seasons : []).slice(0, 30) as Record<string, unknown>[]) {
    if (!s || typeof s !== 'object' || !isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    const rates: Record<string, number> = {}
    for (const [k, v] of Object.entries((s.rates && typeof s.rates === 'object' ? s.rates : {}) as Record<string, unknown>)) {
      const n = num(v)
      if (n) rates[text(k, 80)] = n
    }
    if (!Object.keys(rates).length) continue
    const kind = s.kind === 'off_season' || s.kind === 'special' ? s.kind : 'season'
    seasons.push({ name: text(s.name, 60) || 'Season', kind, start_date: s.start_date, end_date: s.end_date, min_nights: num(s.min_nights), rates })
  }
  // Rooms that only appear inside seasons still need a row.
  for (const s of seasons) for (const name of Object.keys(s.rates)) {
    if (!rooms.some((x) => key(x.name) === key(name))) rooms.push({ name, net_rate: null, net_weekend_rate: null, capacity: null, extra_bed_rate: null, notes: '' })
  }
  return {
    meal_plan: text(r.meal_plan, 40), valid_from: isDate(r.valid_from) ? r.valid_from : null, valid_to: isDate(r.valid_to) ? r.valid_to : null,
    rooms, seasons, notes: text(r.notes, 2000),
  }
}

const key = (s: string) => s.toLowerCase().replace(/\b(room|rooms|category|the)\b/g, '').replace(/[^a-z0-9]+/g, '')

/** Best existing room category for a sheet room name (exact, then contains), or null. */
export function matchRoom(name: string, rooms: { id: number; name: string }[]): number | null {
  const k = key(name)
  if (!k) return null
  const exact = rooms.find((r) => key(r.name) === k)
  if (exact) return exact.id
  const partial = rooms.filter((r) => key(r.name) && (key(r.name).includes(k) || k.includes(key(r.name))))
  return partial.length === 1 ? partial[0].id : null
}

/** Net + markup %, rounded to a tidy figure (₹50). */
export function markup(net: number | null, pct: number): number | null {
  if (!net) return null
  return Math.round((net * (1 + pct / 100)) / 50) * 50
}
