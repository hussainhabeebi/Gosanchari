// B2B rate sheets from resorts (PDF, Word or photos): AI reads everything a contract usually has — room categories
// with rack and net rates, rate periods with weekday / weekend rates, supplements (X'mas…), extra-person and child
// charges, add-ons, cancellation policy, contacts. Management reviews every figure before anything is saved; staff
// and guest rates are suggested from the net rate with the markups chosen on upload.

import { todayIST } from './util'

export type SeasonKind = 'season' | 'off_season' | 'special'

export interface SheetRoom {
  name: string
  units: number | null
  rack_rate: number | null
  /** Regular net rate per room per night (weekday / weekend), when the sheet has one outside the periods. */
  net_rate: number | null
  net_weekend_rate: number | null
  capacity: number | null
  base_guests: number | null
  extra_bed_rate: number | null
  notes: string
}

export interface SheetRate { weekday: number; weekend: number | null }

export interface SheetSeason {
  name: string
  kind: SeasonKind
  start_date: string
  end_date: string
  min_nights: number | null
  /** Sheet room name → net rates. */
  rates: Record<string, SheetRate>
}

export interface SheetSupplement {
  name: string
  kind: SeasonKind
  start_date: string
  end_date: string
  /** Net amount added per room per night. */
  amount: number
}

export interface SheetAddon { name: string; net: number; per: 'stay' | 'night' | 'person' }
export interface SheetContact { name: string; role: string; phone: string; email: string }

export interface RateSheet {
  meal_plan: string
  valid_from: string | null
  valid_to: string | null
  /** Weekend nights as JS weekday numbers (5 = Fri, 6 = Sat, 0 = Sun); null when the sheet doesn't say. */
  weekend_nights: number[] | null
  rooms: SheetRoom[]
  seasons: SheetSeason[]
  supplements: SheetSupplement[]
  extras: { extra_adult: number | null; child_with_bed: number | null; child_no_bed: number | null; child_free_below: number | null; child_age_to: number | null }
  addons: SheetAddon[]
  cancellation_policy: string
  contacts: SheetContact[]
  notes: string
}

export function rateSheetPrompt(notes: string, today = todayIST()) {
  return `Today is ${today}. This is a B2B (net / contract) rate sheet a hotel or resort in Kerala, India sent to a travel company.
It may span several pages / images. Extract EVERYTHING as JSON:
{
  "meal_plan": "plan the special/net rates include: EP (room only), CP (breakfast; 'CPAI' = CP), MAP, AP",
  "valid_from": "YYYY-MM-DD or null", "valid_to": "YYYY-MM-DD or null" (whole contract),
  "weekend_nights": ["Fri","Sat","Sun"] — the nights the sheet calls weekend (e.g. "Weekends Fri - Sun"), or null,
  "rooms": [{"name": "room type as written", "units": number of rooms or null, "rack_rate": published / rack rate per night (EP) or null,
             "net_rate": regular net weekday rate if the sheet has one outside any dated period, else null, "net_weekend_rate": number or null,
             "capacity": max guests or null, "base_guests": guests the rate includes ("Double" = 2) or null, "extra_bed_rate": null, "notes": "AC / Non-AC etc."}],
  "seasons": [{"name": "e.g. Apr–Sep 2026 special rate", "kind": "season" | "off_season" | "special", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD (last night)",
               "min_nights": number or null, "rates": {"<room name exactly as in rooms>": {"weekday": net rate, "weekend": net rate or null}}}],
  "supplements": [{"name": "e.g. X'mas peak supplement", "kind": "special", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "amount": extra per room per night}],
  "extras": {"extra_adult": extra mattress / extra adult per night, "child_with_bed": child with mattress per night, "child_no_bed": child without bed per night,
             "child_free_below": age below which children are free (e.g. 6), "child_age_to": oldest child age (e.g. 11)} (numbers or null),
  "addons": [{"name": "e.g. Campfire (1 hr), Candle light dinner, Flower bed", "net": price, "per": "stay" | "night" | "person"}],
  "cancellation_policy": "the cancellation rules, short and complete",
  "contacts": [{"name": "", "role": "", "phone": "", "email": ""}],
  "notes": "anything else: GST on rates or not, à la carte dinner, blackout dates, payment terms"
}
Rules: numbers only, in rupees ("Rs. 3,000/-" = 3000, "4.5k" = 4500). Use ONLY the sheet's figures, never invent.
Each dated rate table ("Special rate valid from 1 Apr 2026 – 30 Sep 2026") is one entry in "seasons" (kind "season", or "off_season" if it is called lean / off / monsoon season).
A "peak time supplement" (e.g. "X'mas 20 Dec to 5 Jan Rs.1000 per room per night") goes in "supplements", not in "seasons".
Weekday / weekend columns go into {"weekday", "weekend"}. For dates without a year use the next upcoming occurrence. Reply with JSON only.

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
const age = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) && n >= 0 && n <= 17 ? Math.round(n) : null
}
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max)
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const kindOf = (v: unknown): SeasonKind => (v === 'off_season' || v === 'special' ? v : 'season')
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function sheetRate(v: unknown): SheetRate | null {
  if (typeof v === 'number' || typeof v === 'string') { const n = num(v); return n ? { weekday: n, weekend: null } : null }
  const o = obj(v)
  const wd = num(o.weekday ?? o.rate ?? o.net)
  const we = num(o.weekend)
  if (!wd && !we) return null
  return { weekday: wd ?? we!, weekend: wd ? we : null }
}

export function normalizeRateSheet(raw: unknown): RateSheet {
  const r = obj(raw)
  const rooms: SheetRoom[] = (Array.isArray(r.rooms) ? r.rooms : [])
    .map(obj)
    .map((x) => ({
      name: text(x.name, 80), units: num(x.units), rack_rate: num(x.rack_rate), net_rate: num(x.net_rate), net_weekend_rate: num(x.net_weekend_rate),
      capacity: num(x.capacity), base_guests: num(x.base_guests), extra_bed_rate: num(x.extra_bed_rate), notes: text(x.notes),
    }))
    .filter((x) => x.name)
    .slice(0, 30)
  const seasons: SheetSeason[] = []
  for (const s of (Array.isArray(r.seasons) ? r.seasons : []).slice(0, 30).map(obj)) {
    if (!isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    const rates: Record<string, SheetRate> = {}
    for (const [k, v] of Object.entries(obj(s.rates))) {
      const sr = sheetRate(v)
      if (sr) rates[text(k, 80)] = sr
    }
    if (!Object.keys(rates).length) continue
    seasons.push({ name: text(s.name, 60) || 'Season', kind: kindOf(s.kind), start_date: s.start_date, end_date: s.end_date, min_nights: num(s.min_nights), rates })
  }
  const supplements: SheetSupplement[] = []
  for (const s of (Array.isArray(r.supplements) ? r.supplements : []).slice(0, 20).map(obj)) {
    const amount = num(s.amount)
    if (!amount || !isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    supplements.push({ name: text(s.name, 60) || 'Peak supplement', kind: s.kind === 'season' ? 'season' : 'special', start_date: s.start_date, end_date: s.end_date, amount })
  }
  // Rooms that only appear inside seasons still need a row.
  for (const s of seasons) for (const name of Object.keys(s.rates)) {
    if (!rooms.some((x) => key(x.name) === key(name))) rooms.push({ name, units: null, rack_rate: null, net_rate: null, net_weekend_rate: null, capacity: null, base_guests: null, extra_bed_rate: null, notes: '' })
  }
  const ex = obj(r.extras)
  const wk = Array.isArray(r.weekend_nights) ? [...new Set(r.weekend_nights.map((d) => DAYS[String(d).slice(0, 3).toLowerCase()]).filter((d) => d != null))] : null
  return {
    meal_plan: text(r.meal_plan, 40), valid_from: isDate(r.valid_from) ? r.valid_from : null, valid_to: isDate(r.valid_to) ? r.valid_to : null,
    weekend_nights: wk && wk.length ? wk : null,
    rooms, seasons, supplements,
    extras: { extra_adult: num(ex.extra_adult), child_with_bed: num(ex.child_with_bed), child_no_bed: num(ex.child_no_bed), child_free_below: age(ex.child_free_below), child_age_to: age(ex.child_age_to) },
    addons: (Array.isArray(r.addons) ? r.addons : []).map(obj).map((a) => ({ name: text(a.name, 80), net: num(a.net ?? a.price) ?? 0, per: (['night', 'person'].includes(String(a.per)) ? a.per : 'stay') as SheetAddon['per'] })).filter((a) => a.name && a.net).slice(0, 30),
    cancellation_policy: text(r.cancellation_policy, 2000),
    contacts: (Array.isArray(r.contacts) ? r.contacts : []).map(obj).map((c) => ({ name: text(c.name, 80), role: text(c.role, 80), phone: text(c.phone, 30), email: text(c.email, 120) })).filter((c) => c.name || c.phone).slice(0, 15),
    notes: text(r.notes, 2000),
  }
}

const key = (s: string) => s.toLowerCase().replace(/\b(room|rooms|category|the)\b/g, '').replace(/[^a-z0-9]+/g, '')
export const sheetKey = key

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
export function markup(net: number | null | undefined, pct: number): number | null {
  if (!net) return null
  return Math.round((net * (1 + pct / 100)) / 50) * 50
}

/** The rate a room starts from: its regular net rate, else its rate in the first period on the sheet. */
export function regularNet(sheet: RateSheet, room: SheetRoom): SheetRate | null {
  if (room.net_rate) return { weekday: room.net_rate, weekend: room.net_weekend_rate }
  for (const s of sheet.seasons) {
    const hit = Object.entries(s.rates).find(([n]) => key(n) === key(room.name))
    if (hit) return hit[1]
  }
  return null
}
