// "Quick fill with AI": staff paste everything they know about a property as one paragraph (notes, an owner's
// WhatsApp message, a brochure), AI sorts it into the editor's fields. Nothing is saved until staff review and save.

import type { Env } from '../env'
import { aiEnabled, aiJson } from './ai'
import { CONTACT_FIELDS, CUISINES, LANGUAGES, MENU_TYPES, POLICY_FIELDS, ROOM_AMENITIES, ROOM_VIEWS, STAY_TYPES, THEMES } from './catalog'
import { FACILITIES, MEAL_PLANS } from './search'
import { todayIST } from './util'

type Kind = 'text' | 'long' | 'num' | 'bool' | 'time' | 'lines' | { pick: string[] } | { list: string[] }

/** Editor field name → kind. Names match the inputs in the property form. */
const FIELDS: Record<string, [Kind, string]> = {
  name: ['text', 'property name'],
  type: [{ pick: Object.keys(STAY_TYPES) }, 'property type'],
  destination: ['text', 'town / area, e.g. Munnar, Wayanad, Alleppey'],
  star_category: ['num', 'star rating 1-5'],
  built_year: ['num', 'year built or renovated'],
  themes: [{ list: Object.keys(THEMES) }, 'best for'],
  languages: [{ list: LANGUAGES }, 'languages spoken by staff'],
  highlights: ['lines', 'up to 6 short selling points'],
  address: ['long', 'full postal address'],
  map_url: ['text', 'Google Maps link'],
  lat: ['num', 'latitude'],
  lng: ['num', 'longitude'],
  how_to_reach: ['long', 'directions, distance from station/airport'],
  best_time: ['text', 'best time to visit'],
  description: ['long', 'guest-facing description in English, 2-4 short paragraphs, only facts given'],
  good_to_know: ['long', 'honest notes: steep road, no lift, weak signal…'],
  d_restaurant_name: ['text', 'restaurant name'],
  d_breakfast: ['text', 'breakfast timing, e.g. 7:30 – 10:00'],
  d_lunch: ['text', 'lunch timing'],
  d_dinner: ['text', 'dinner timing'],
  d_cuisines: [{ list: CUISINES }, 'cuisines'],
  d_menu_types: [{ list: MENU_TYPES }, 'menu types'],
  d_in_room_dining: ['bool', 'in-room dining'],
  d_bar: ['bool', 'has a bar'],
  d_outside_food: ['bool', 'outside food allowed'],
  meal_plans: [{ list: Object.keys(MEAL_PLANS) }, 'meal plans offered (EP room only, CP breakfast, MAP half board, AP full board)'],
  d_price_cp: ['num', 'breakfast plan ₹ per person per night'],
  d_price_map: ['num', 'half board ₹ per person per night'],
  d_price_ap: ['num', 'full board ₹ per person per night'],
  d_child_meal_note: ['text', 'children meal charges'],
  d_notes: ['long', 'other dining notes'],
  facilities: [{ list: Object.keys(FACILITIES) }, 'property facilities'],
  pet_friendly: ['bool', 'pets allowed'],
  family_friendly: ['bool', 'good for families'],
  checkin_time: ['time', 'check-in time HH:MM 24h'],
  checkout_time: ['time', 'check-out time HH:MM 24h'],
  id_required: ['bool', 'photo ID required'],
  cancellation_policy: ['long', 'cancellation policy'],
  ...Object.fromEntries(POLICY_FIELDS.map(([k, label]) => [`pol_${k}`, ['text', label.toLowerCase()] as [Kind, string]])),
  house_rules: ['lines', 'other house rules'],
  owner_name: ['text', 'owner name'],
  owner_phone: ['text', 'owner phone'],
  owner_email: ['text', 'owner email'],
  ...Object.fromEntries(CONTACT_FIELDS.map(([k, label]) => [`con_${k}`, [k === 'bank_details' ? 'long' : 'text', label.toLowerCase()] as [Kind, string]])),
  commission_pct: ['num', 'our commission %'],
  nearby: ['lines', 'nearby places, each "Name | type | km | travel time"; type one of attraction, railway, airport, bus, hospital, atm, shopping, restaurant, beach, waterfall, viewpoint'],
  internal_notes: ['long', 'anything else that does not fit another field (internal remarks)'],
}

const ROOM_KEYS: Record<string, [Kind, string]> = {
  name: ['text', 'room category name'],
  units: ['num', 'number of rooms of this type'],
  capacity: ['num', 'max guests'],
  max_adults: ['num', 'max adults'],
  max_children: ['num', 'max children'],
  bed_type: ['text', 'bed type'],
  size_sqft: ['num', 'size in sq ft'],
  room_view: [{ pick: ROOM_VIEWS }, 'view'],
  base_rate: ['num', 'regular weekday rate ₹ per night'],
  weekend_rate: ['num', 'Fri/Sat rate ₹'],
  min_nights: ['num', 'minimum nights'],
  extra_bed: ['bool', 'extra bed available'],
  extra_bed_rate: ['num', 'extra bed ₹ per night'],
  inclusions: ['text', 'what the rate includes'],
  description: ['long', 'short room description'],
  amenities: [{ list: Object.keys(ROOM_AMENITIES) }, 'room amenities'],
}

export interface ExtractedRoom { [k: string]: string | number | boolean | string[] }
export interface ExtractedSeason { name: string; start_date: string; end_date: string; min_nights?: number; rates: Record<string, number> }
export interface Extracted {
  fields: Record<string, string | boolean | string[]>
  rooms: ExtractedRoom[]
  seasons: ExtractedSeason[]
}

function describe(spec: Record<string, [Kind, string]>) {
  return Object.entries(spec).map(([k, [kind, hint]]) => {
    const t = typeof kind === 'string'
      ? { text: 'string', long: 'string', num: 'number', bool: 'true/false', time: '"HH:MM"', lines: 'array of strings' }[kind]
      : 'pick' in kind ? `one of ${kind.pick.join(', ')}` : `array, only from: ${kind.list.join(', ')}`
    return `- ${k} (${t}): ${hint}`
  }).join('\n')
}

const RULES = `Rules: use ONLY facts in the notes, never invent. Leave out a key when the notes don't say.
Rates are plain numbers in rupees (no symbols; "4.5k" = 4500). Translate Malayalam facts to English. Reply with JSON only, no explanation.`

/** Prompt for the property's own fields (call 1 of 2). */
export function fieldsPrompt(text: string) {
  return `Below are notes about a holiday property in Kerala, India. Sort the facts into one JSON object with these keys:
${describe(FIELDS)}
${RULES}

Notes:
"""
${text}
"""`
}

/** Prompt for room categories and seasonal rates (call 2 of 2). */
export function roomsPrompt(text: string, today = todayIST()) {
  return `Today is ${today}. Below are notes about a holiday property in Kerala, India. Find its room categories and seasonal rates.
Reply as JSON: {"rooms": [...], "seasons": [...]}.
"rooms": one object per room category with keys:
${describe(ROOM_KEYS)}
"seasons": seasonal / peak / festival rates, each {"name": string, "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" (last night), "min_nights": number, "rates": {"<room category name exactly as in rooms>": rate}}.
For dates without a year use the next upcoming occurrence. Use [] when there are none.
${RULES}

Notes:
"""
${text}
"""`
}

/** Strip chat formatting (markdown, emoji, separators) so the model gets the facts in fewer tokens. */
export function tidyNotes(text: string) {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/^\s*(?:-{3,}|_{3,}|\*{3,}|={3,})\s*$/gm, '')
    .replace(/^[ \t]*[*•▪►]\s+/gm, '- ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const clean = (v: unknown, max = 2000) => (v == null ? '' : String(v).replace(/\s+\n/g, '\n').trim().slice(0, max))

function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = clean(v).toLowerCase().replace(/[₹,\s]|rs\.?|inr/g, '')
  const m = s.match(/^(-?\d+(?:\.\d+)?)(k|l|lakh)?/)
  if (!m) return null
  const n = parseFloat(m[1]) * (m[2] === 'k' ? 1000 : m[2] ? 100000 : 1)
  return Number.isFinite(n) ? n : null
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  const s = clean(v).toLowerCase()
  if (['yes', 'true', 'y', '1', 'allowed', 'available'].includes(s)) return true
  if (['no', 'false', 'n', '0', 'not allowed', 'not available'].includes(s)) return false
  return null
}

function timeOf(v: unknown): string | null {
  const m = clean(v).toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|noon)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  const min = m[2] ?? '00'
  return h < 24 && +min < 60 ? `${String(h).padStart(2, '0')}:${min}` : null
}

/** Match a free value to an allowed option (key or label, case-insensitive, loose). */
function matchOption(v: unknown, options: string[], labels: Record<string, string> = {}): string | null {
  const s = clean(v, 80).toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (!s) return null
  for (const o of options) {
    const keys = [o, labels[o] ?? ''].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter(Boolean)
    if (keys.some((k) => k === s)) return o
  }
  for (const o of options) {
    const keys = [o, labels[o] ?? ''].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((k) => k.length >= 3)
    if (keys.some((k) => k.startsWith(s) || s.startsWith(k))) return o
  }
  // Last try: the value contains an option ("Swimming pool" → pool); the longest option wins ("lake view" → lake_view).
  let best: [string, number] | null = null
  for (const o of options) {
    for (const k of [o, labels[o] ?? ''].map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((k) => k.length >= 4)) {
      if (s.includes(k) && (!best || k.length > best[1])) best = [o, k.length]
    }
  }
  return best?.[0] ?? null
}

const LABELS: Record<string, string> = { ...STAY_TYPES, ...THEMES, ...FACILITIES, ...MEAL_PLANS, ...ROOM_AMENITIES }

function normalizeValue(kind: Kind, v: unknown): string | boolean | string[] | null {
  if (v == null || v === '') return null
  if (kind === 'bool') return boolOf(v)
  if (kind === 'num') {
    const n = numOf(v)
    return n == null ? null : String(Math.round(n * 1e6) / 1e6)
  }
  if (kind === 'time') return timeOf(v)
  if (kind === 'lines') {
    const arr = Array.isArray(v) ? v : clean(v).split(/\n|;/)
    const out = arr.map((x) => (typeof x === 'object' && x ? Object.values(x).join(' | ') : clean(x, 300))).filter(Boolean)
    return out.length ? out.join('\n') : null
  }
  if (kind === 'text' || kind === 'long') {
    const s = Array.isArray(v) ? v.map((x) => clean(x)).join(kind === 'long' ? '\n' : ', ') : clean(v, kind === 'long' ? 8000 : 300)
    return s || null
  }
  if ('pick' in kind) return matchOption(v, kind.pick, LABELS)
  const arr = Array.isArray(v) ? v : clean(v).split(/,|\n/)
  const out = [...new Set(arr.map((x) => matchOption(x, kind.list, LABELS)).filter((x): x is string => !!x))]
  return out.length ? out : null
}

function normalizeObject(spec: Record<string, [Kind, string]>, raw: unknown) {
  const out: Record<string, string | boolean | string[]> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = spec[k]
    if (!s) continue
    const n = normalizeValue(s[0], v)
    if (n != null) out[k] = n
  }
  return out
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

/** Turn whatever the model returned into safe values keyed by the editor's field names. */
export function normalizeExtract(raw: unknown): Extracted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fields = normalizeObject(FIELDS, r.fields ?? r)
  const lat = parseFloat(String(fields.lat ?? ''))
  const lng = parseFloat(String(fields.lng ?? ''))
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) { delete fields.lat; delete fields.lng }
  if (typeof fields.map_url === 'string' && !/^https?:\/\//.test(fields.map_url)) delete fields.map_url
  const rooms = (Array.isArray(r.rooms) ? r.rooms : [])
    .map((x) => normalizeObject(ROOM_KEYS, x))
    .filter((x) => typeof x.name === 'string' && x.name)
    .slice(0, 20) as ExtractedRoom[]
  const seasons: ExtractedSeason[] = []
  for (const s of Array.isArray(r.seasons) ? (r.seasons as Record<string, unknown>[]).slice(0, 20) : []) {
    if (!s || typeof s !== 'object') continue
    const name = clean(s.name, 60)
    if (!name || !isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    const rates: Record<string, number> = {}
    for (const [room, v] of Object.entries((s.rates && typeof s.rates === 'object' ? s.rates : {}) as Record<string, unknown>)) {
      const n = numOf(v)
      if (n && n > 0) rates[clean(room, 80)] = Math.round(n)
    }
    if (!Object.keys(rates).length) continue
    const mn = numOf(s.min_nights)
    seasons.push({ name, start_date: s.start_date, end_date: s.end_date, ...(mn && mn > 0 ? { min_nights: Math.round(mn) } : {}), rates })
  }
  return { fields, rooms, seasons }
}

export type ExtractResult = (Extracted & { warning?: string }) | { error: string }

/** Two smaller AI calls in parallel (fields; rooms + seasons): faster, and less chance of a cut-off reply. */
export async function extractProperty(env: Env, text: string): Promise<ExtractResult> {
  if (!env.AI) return { error: 'Workers AI is not connected to this site (the [ai] binding is missing).' }
  if (!(await aiEnabled(env, 'property_extract'))) return { error: 'Quick fill is switched off in Admin → AI settings.' }
  const notes = tidyNotes(text)
  const [a, b] = await Promise.all([
    aiJson<unknown>(env, 'property_extract', { size: 'large', prompt: fieldsPrompt(notes), maxTokens: 2500 }),
    aiJson<unknown>(env, 'property_extract', { size: 'large', prompt: roomsPrompt(notes), maxTokens: 2000 }),
  ])
  if (!a && !b) return { error: 'The AI service did not answer (or the daily AI limit was reached). Please try again in a minute.' }
  const r = normalizeExtract({ fields: a ?? {}, ...(b && typeof b === 'object' ? b : {}) })
  const warning = !a ? 'Room categories were read, but the other details could not be — please fill them by hand.'
    : !b ? 'Property details were read, but room categories and seasons could not be — add them by hand.' : undefined
  return { ...r, ...(warning ? { warning } : {}) }
}
