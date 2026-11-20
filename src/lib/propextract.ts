// "Quick fill with AI": staff give everything they have about a property — pasted notes (an owner's WhatsApp
// message, brochure text), files (PDF, Word, photos / screenshots of a rate card) and/or the resort's website link —
// and AI sorts it into the editor's fields. All sources are read together in one run, and every filled field says
// where it came from. Nothing is saved until staff review and save.

import type { Env } from '../env'
import { aiEnabled, aiJson, aiText, geminiActive } from './ai'
import { aiJsonFromDocuments, type DocInput } from './docs'
import { readWebsite, type WebImport } from './webimport'
import { CONTACT_FIELDS, CUISINES, MENU_TYPES, POLICY_FIELDS, ROOM_AMENITIES, ROOM_VIEWS, STAY_TYPES, THEMES } from './catalog'
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
  highlights: ['lines', 'up to 6 short selling points'],
  address: ['long', 'full postal address'],
  map_url: ['text', 'Google Maps link'],
  lat: ['num', 'latitude'],
  lng: ['num', 'longitude'],
  how_to_reach: ['long', 'directions, distance from station/airport'],
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
  // Bank details are never copied into the form by AI (privacy; staff type them in).
  ...Object.fromEntries(CONTACT_FIELDS.filter(([k]) => k !== 'bank_details').map(([k, label]) => [`con_${k}`, ['text', label.toLowerCase()] as [Kind, string]])),
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
  base_guests: ['num', 'guests included in the room rate (e.g. 2; a large cottage may include 8)'],
  extra_adult_rate: ['num', 'charge per extra adult (extra bed / mattress) per night above the included guests'],
  extra_child_rate: ['num', 'charge per extra child per night'],
  inclusions: ['text', 'what the rate includes'],
  description: ['long', 'short room description'],
  amenities: [{ list: Object.keys(ROOM_AMENITIES) }, 'room amenities'],
}

export interface ExtractedRoom { [k: string]: string | number | boolean | string[] }
export interface ExtractedSeason { name: string; start_date: string; end_date: string; min_nights?: number; rates: Record<string, number>; src?: string }
export interface Extracted {
  fields: Record<string, string | boolean | string[]>
  rooms: ExtractedRoom[]
  seasons: ExtractedSeason[]
  /** Field name → where it came from (only when more than one source was given, or set for all from the only one). */
  sources?: Record<string, string>
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

/** Where a fact came from. Notes are marked with "=== Source: … ===" headers when there is more than one. */
export type Source = 'notes' | 'file' | 'website'
export const SOURCE_LABEL: Record<Source, string> = { notes: 'your notes', file: 'file', website: 'website' }

const srcRule = (sources: Source[], what: string) => sources.length > 1
  ? `\nThe notes come from several sources (${sources.join(', ')}). When they disagree, prefer: file and notes over website for rates; website structured data for name, address and coordinates. ${what}`
  : ''

/** Prompt for the property's own fields (call 1 of 2). */
export function fieldsPrompt(text: string, sources: Source[] = []) {
  return `Below are notes about a holiday property in Kerala, India. Sort the facts into one JSON object with these keys:
${describe(FIELDS)}
${RULES}${srcRule(sources, `Also add "_src": an object giving, for each key you filled, the source it came from (one of ${sources.join(', ')}).`)}

Notes:
"""
${text}
"""`
}

/** Prompt for room categories and seasonal rates (call 2 of 2). */
export function roomsPrompt(text: string, today = todayIST(), sources: Source[] = []) {
  return `Today is ${today}. Below are notes about a holiday property in Kerala, India. Find its room categories and seasonal rates.
Reply as JSON: {"rooms": [...], "seasons": [...]}.
"rooms": one object per room category with keys:
${describe(ROOM_KEYS)}
"seasons": seasonal / peak / festival rates, each {"name": string, "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" (last night), "min_nights": number, "rates": {"<room category name exactly as in rooms>": rate}}.
For dates without a year use the next upcoming occurrence. Use [] when there are none.
${RULES}${srcRule(sources, `Give every room and season a "src" key: the source its rates came from (one of ${sources.join(', ')}).`)}

Notes:
"""
${text}
"""`
}

// ---- Gemini structured output: the same keys as the prompts, so Gemini cannot reply with broken or made-up keys ----
type Schema = Record<string, unknown>
function schemaOf(kind: Kind): Schema {
  if (typeof kind === 'string') {
    if (kind === 'num') return { type: 'NUMBER' }
    if (kind === 'bool') return { type: 'BOOLEAN' }
    if (kind === 'lines') return { type: 'ARRAY', items: { type: 'STRING' } }
    return { type: 'STRING' }
  }
  if ('pick' in kind) return { type: 'STRING', enum: kind.pick }
  return { type: 'ARRAY', items: { type: 'STRING', enum: kind.list } }
}
const objectSchema = (spec: Record<string, [Kind, string]>, extra: Schema = {}): Schema => ({
  type: 'OBJECT',
  properties: { ...Object.fromEntries(Object.entries(spec).map(([k, [kind]]) => [k, schemaOf(kind)])), ...extra },
})

export function fieldsSchema(sources: Source[] = []): Schema {
  const src = sources.length > 1 ? { _src: objectSchema(Object.fromEntries(Object.keys(FIELDS).map((k) => [k, [{ pick: sources }, ''] as [Kind, string]]))) } : {}
  return objectSchema(FIELDS, src)
}

export function roomsSchema(sources: Source[] = []): Schema {
  const src: Schema = sources.length > 1 ? { src: { type: 'STRING', enum: sources } } : {}
  return {
    type: 'OBJECT',
    properties: {
      rooms: { type: 'ARRAY', items: objectSchema(ROOM_KEYS, src) },
      seasons: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' }, start_date: { type: 'STRING' }, end_date: { type: 'STRING' }, min_nights: { type: 'NUMBER' },
            // Room names are free text, so rates come as a list and are turned back into a map in normalizeExtract.
            rates: { type: 'ARRAY', items: { type: 'OBJECT', properties: { room: { type: 'STRING' }, rate: { type: 'NUMBER' } }, required: ['room', 'rate'] } },
            ...src,
          },
          required: ['name', 'start_date', 'end_date', 'rates'],
        },
      },
    },
    required: ['rooms', 'seasons'],
  }
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
const SOURCES: Source[] = ['notes', 'file', 'website']
const srcOf = (v: unknown) => (SOURCES as unknown[]).includes(v) ? (v as Source) : null

export function normalizeExtract(raw: unknown, only?: Source): Extracted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawFields = (r.fields ?? r) as Record<string, unknown>
  const fields = normalizeObject(FIELDS, rawFields)
  const lat = parseFloat(String(fields.lat ?? ''))
  const lng = parseFloat(String(fields.lng ?? ''))
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) { delete fields.lat; delete fields.lng }
  if (typeof fields.map_url === 'string' && !/^https?:\/\//.test(fields.map_url)) delete fields.map_url
  const rooms = (Array.isArray(r.rooms) ? r.rooms : [])
    .map((x) => {
      const o = normalizeObject(ROOM_KEYS, x) as ExtractedRoom
      const src = only ?? srcOf((x as Record<string, unknown> | null)?.src)
      if (src) o.src = src
      return o
    })
    .filter((x) => typeof x.name === 'string' && x.name)
    .slice(0, 20)
  const seasons: ExtractedSeason[] = []
  for (const s of Array.isArray(r.seasons) ? (r.seasons as Record<string, unknown>[]).slice(0, 20) : []) {
    if (!s || typeof s !== 'object') continue
    const name = clean(s.name, 60)
    if (!name || !isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    const rates: Record<string, number> = {}
    // Structured output gives [{room, rate}]; plain JSON mode gives {"room": rate}.
    const rateMap = Array.isArray(s.rates)
      ? Object.fromEntries((s.rates as Record<string, unknown>[]).filter((x) => x && typeof x === 'object').map((x) => [String(x.room ?? ''), x.rate]))
      : (s.rates && typeof s.rates === 'object' ? s.rates : {})
    for (const [room, v] of Object.entries(rateMap as Record<string, unknown>)) {
      const n = numOf(v)
      if (n && n > 0) rates[clean(room, 80)] = Math.round(n)
    }
    if (!Object.keys(rates).length) continue
    const mn = numOf(s.min_nights)
    const src = only ?? srcOf(s.src)
    seasons.push({ name, start_date: s.start_date, end_date: s.end_date, ...(mn && mn > 0 ? { min_nights: Math.round(mn) } : {}), rates, ...(src ? { src } : {}) })
  }
  const sources: Record<string, string> = {}
  const rawSrc = (rawFields && typeof rawFields === 'object' ? rawFields._src : null) as Record<string, unknown> | null
  for (const k of Object.keys(fields)) {
    const src = only ?? srcOf(rawSrc && typeof rawSrc === 'object' ? rawSrc[k] : null)
    if (src) sources[k] = src
  }
  return { fields, rooms, seasons, ...(Object.keys(sources).length ? { sources } : {}) }
}

export type ExtractResult = (Extracted & { warning?: string; website?: { url: string; pages: string[]; images: string[] } }) | { error: string }

export interface ExtractInput {
  text?: string
  docs?: DocInput[]
  /** Resort website link (the resort's own site; booking sites are refused). */
  url?: string
  /** "Read carefully": the slower Gemini model (Settings → AI). */
  careful?: boolean
}

/** Website notes for the AI. When the site draws its text with JavaScript (little text found), Gemini reads it itself. */
async function websiteNotes(env: Env, web: WebImport, careful: boolean): Promise<string> {
  if (web.textLength >= 400 || !(await geminiActive(env))) return web.notes
  const read = await aiText(env, 'property_extract', {
    size: 'large', careful, urlContext: true, maxTokens: 4000, temperature: 0,
    prompt: `Open these pages of a holiday property's website and write down every fact about the property as plain notes: name, address, location, rooms (names, beds, guests, sizes, rates), facilities, dining, policies, check-in / check-out, contact numbers. Facts only, no opinions.\n${web.pages.join('\n')}`,
  })
  return read ? `${web.notes}\n\n--- Read by Gemini from the live pages ---\n${read}` : web.notes
}

/**
 * All sources together in one run (pasted notes + files + website), as two smaller AI calls in parallel
 * (fields; rooms + seasons): faster, and less chance of a cut-off reply.
 */
export async function extractProperty(env: Env, input: ExtractInput): Promise<ExtractResult> {
  if (!env.AI && !(await geminiActive(env))) return { error: 'No AI is connected. Add a Gemini API key in Admin → Settings → AI, or enable Workers AI.' }
  if (!(await aiEnabled(env, 'property_extract'))) return { error: 'Quick fill is switched off in Admin → AI settings.' }
  const notes = tidyNotes(input.text ?? '')
  const docs = input.docs ?? []
  const careful = !!input.careful
  let web: WebImport | null = null
  if (input.url) {
    const w = await readWebsite(input.url)
    if ('error' in w) return { error: `Website: ${w.error}` }
    web = w
  }
  const webText = web ? await websiteNotes(env, web, careful) : ''
  const sources: Source[] = [...(notes ? ['notes' as const] : []), ...(docs.length ? ['file' as const] : []), ...(webText ? ['website' as const] : [])]
  if (!sources.length) return { error: 'Paste a few lines about the property, attach a file, or give a website link.' }
  const only = sources.length === 1 ? sources[0] : undefined
  const multi = sources.length > 1
  // With several sources each block is labelled, so the AI can say where each fact came from.
  const combine = (fileNotes: string) => [
    notes && (multi ? `=== Source: notes (typed by staff) ===\n${notes}` : notes),
    fileNotes && (multi ? `=== Source: file (attached documents) ===\n${fileNotes}` : fileNotes),
    webText && (multi ? `=== Source: website (${web!.url}) ===\n${webText}` : webText),
  ].filter(Boolean).join('\n\n')
  const fOpts = { size: 'large' as const, maxTokens: multi ? 3500 : 2500, careful, schema: fieldsSchema(sources) }
  const rOpts = { size: 'large' as const, maxTokens: 2500, careful, schema: roomsSchema(sources) }
  let a: unknown, b: unknown
  if (docs.length) {
    const [ra, rb] = await Promise.all([
      aiJsonFromDocuments<unknown>(env, 'property_extract', docs, (n) => fieldsPrompt(combine(n), sources), fOpts),
      aiJsonFromDocuments<unknown>(env, 'property_extract', docs, (n) => roomsPrompt(combine(n), todayIST(), sources), rOpts),
    ])
    if (!ra.data && !rb.data) return { error: ra.error ?? rb.error ?? 'Could not read the files.' }
    a = ra.data
    b = rb.data
  } else {
    const all = combine('')
    ;[a, b] = await Promise.all([
      aiJson<unknown>(env, 'property_extract', { ...fOpts, prompt: fieldsPrompt(all, sources) }),
      aiJson<unknown>(env, 'property_extract', { ...rOpts, prompt: roomsPrompt(all, todayIST(), sources) }),
    ])
  }
  if (!a && !b) return { error: 'The AI service did not answer (or the daily AI limit was reached). Please try again in a minute.' }
  const r = normalizeExtract({ fields: a ?? {}, ...(b && typeof b === 'object' ? b : {}) }, only)
  const warning = !a ? 'Room categories were read, but the other details could not be — please fill them by hand.'
    : !b ? 'Property details were read, but room categories and seasons could not be — add them by hand.' : undefined
  return { ...r, ...(warning ? { warning } : {}), ...(web ? { website: { url: web.url, pages: web.pages, images: web.images } } : {}) }
}
