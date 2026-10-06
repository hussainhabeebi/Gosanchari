// Lists of options for property details (types, photo sections, amenities, dining, policies) and helpers
// to read the JSON detail columns safely.

import { money, parseJson } from './util'

/** Stay types shown to guests. Stored in properties.stay_type. */
export const STAY_TYPES: Record<string, string> = {
  homestay: 'Homestay',
  villa: 'Villa',
  cottage: 'Cottage',
  resort: 'Resort',
  houseboat: 'Houseboat',
  hotel: 'Hotel',
  boutique: 'Boutique stay',
  heritage: 'Heritage home',
  treehouse: 'Treehouse',
  glamping: 'Glamping / tents',
  farmstay: 'Farm stay',
  apartment: 'Service apartment',
  hostel: 'Hostel',
}

/** The legacy `type` column only accepts these; new stay types map to the nearest one. */
const LEGACY: Record<string, string> = {
  homestay: 'homestay', villa: 'villa', cottage: 'cottage', resort: 'resort', houseboat: 'houseboat',
  hotel: 'resort', boutique: 'resort', heritage: 'homestay', treehouse: 'cottage', glamping: 'cottage',
  farmstay: 'homestay', apartment: 'villa', hostel: 'homestay',
}
export function legacyType(stayType: string): string {
  return LEGACY[stayType] ?? 'homestay'
}
export function stayType(p: { stay_type?: string | null; type: string }): string {
  return p.stay_type || p.type
}
export function stayTypeLabel(p: { stay_type?: string | null; type: string }): string {
  const t = stayType(p)
  return STAY_TYPES[t] ?? t
}

/** Photo / video sections. 'room' photos also carry a room_id (room category). */
export const PHOTO_CATEGORIES: Record<string, string> = {
  common: 'Common areas',
  facade: 'Facade / exterior',
  room: 'Room categories',
  pool: 'Swimming pool',
  view: 'Views',
  restaurant: 'Restaurant & dining',
  activities: 'Activities',
  other: 'Other',
}
/** Order used for the cover gallery on the property page. */
export const COVER_ORDER = ['facade', 'common', 'pool', 'view', 'room', 'restaurant', 'activities', 'other']

export const ROOM_AMENITIES: Record<string, string> = {
  ac: 'AC',
  non_ac: 'Non AC',
  wifi: 'Wi-Fi',
  tv: 'TV',
  king_bed: 'King size bed',
  queen_bed: 'Queen size bed',
  extra_bed: 'Extra bed',
  study_table: 'Study table',
  wardrobe: 'Wardrobe',
  sofa: 'Sofa',
  balcony: 'Balcony',
  mountain_view: 'Mountain view',
  valley_view: 'Valley view',
  pool_view: 'Pool view',
  garden_view: 'Garden view',
  private_pool: 'Private pool',
  jacuzzi: 'Jacuzzi',
  bathtub: 'Bathtub',
  hot_water: 'Hot water',
  fridge: 'Mini fridge',
  coffee_maker: 'Coffee maker',
  kettle: 'Kettle',
  heater: 'Room heater',
  safe: 'In-room safe',
  intercom: 'Intercom',
  living_area: 'Living area',
  dining_area: 'Dining area',
  fireplace: 'Private fireplace',
  work_desk: 'Work desk',
  hairdryer: 'Hair dryer',
  // older keys still used by existing rooms
  fan: 'Ceiling fan',
  minibar: 'Minibar',
  sitout: 'Private sit-out',
  toiletries: 'Toiletries',
  slippers: 'Slippers & bathrobe',
  room_service: 'Room service',
  kitchenette: 'Kitchenette',
  mosquito_net: 'Mosquito net',
}
/** Amenities shown in the wizard (the list on the Room Categories screen). */
export const WIZARD_AMENITIES = ['ac', 'non_ac', 'wifi', 'tv', 'king_bed', 'queen_bed', 'extra_bed', 'study_table', 'wardrobe', 'sofa', 'balcony', 'mountain_view', 'valley_view', 'pool_view', 'garden_view', 'private_pool', 'jacuzzi', 'bathtub', 'hot_water', 'fridge', 'coffee_maker', 'kettle', 'heater', 'safe', 'intercom', 'living_area', 'dining_area', 'fireplace', 'work_desk', 'hairdryer']
/** Facilities shown in the wizard (the list on the Property Details screen). */
export const WIZARD_FACILITIES = ['pool', 'wifi', 'restaurant', 'parking', 'nature_walk', 'bonfire', 'indoor_games', 'outdoor_games', 'spa', 'kids_play', 'trekking', 'jeep_safari', 'campfire', 'jacuzzi', 'gym', 'conference', 'banquet', 'valley_view', 'tea_view', 'pet_friendly']
/** Activities that can carry a charge (Additional Charges step). */
export const ACTIVITIES: Record<string, string> = {
  campfire: 'Campfire', bonfire: 'Bonfire', trekking: 'Trekking', jeep_safari: 'Jeep safari', boating: 'Boating', kayaking: 'Kayaking',
  plantation_tour: 'Plantation tour', cycling: 'Cycling', fishing: 'Fishing', spa: 'Spa / massage', ayurveda: 'Ayurveda treatment',
  candle_dinner: 'Candle-light dinner', cultural_show: 'Cultural show', bird_watching: 'Bird watching', zipline: 'Zip line', bbq: 'Barbecue',
}

/** Suggested room category names (staff can still type their own). */
export const ROOM_CATEGORY_NAMES = [
  'Standard Room', 'Deluxe Room', 'Super Deluxe Room', 'Premium Room', 'Executive Room', 'Suite Room', 'Family Room', 'Family Suite',
  'Honeymoon Suite', 'Cottage', 'Premium Cottage', 'Villa', 'Pool Villa', 'Tree House', 'Tent', 'Dormitory', 'Entire Property',
]

export const ROOM_VIEWS = ['Garden', 'Pool', 'Valley', 'Hill / mountain', 'Tea estate', 'Lake / backwater', 'Sea', 'Forest', 'River', 'City', 'No view']

export const CUISINES = ['Kerala', 'South Indian', 'North Indian', 'Chinese', 'Continental', 'Seafood', 'Vegetarian', 'Jain', 'Arabic', 'Barbecue']
export const MENU_TYPES = ['À la carte', 'Buffet', 'Set menu', 'Home-cooked', 'Kids menu', 'Room service']

export const THEMES: Record<string, string> = {
  family: 'Family',
  honeymoon: 'Honeymoon / couples',
  friends: 'Friends & groups',
  budget: 'Budget',
  luxury: 'Luxury',
  workcation: 'Workcation',
  nature: 'Nature & wildlife',
  adventure: 'Adventure',
  ayurveda: 'Ayurveda & wellness',
  pet: 'Pet friendly',
  senior: 'Senior friendly',
}

export const LANGUAGES = ['Malayalam', 'English', 'Hindi', 'Tamil', 'Kannada', 'Arabic']

export interface Dining {
  restaurant_name?: string
  cuisines?: string[]
  menu_types?: string[]
  breakfast?: string
  lunch?: string
  dinner?: string
  in_room_dining?: boolean
  outside_food?: boolean
  bar?: boolean
  notes?: string
  /** Meal-plan supplement per person per night (₹). */
  price_cp?: number
  price_map?: number
  price_ap?: number
  child_meal_note?: string
}

export interface Policies {
  pet?: string
  child?: string
  extra_bed?: string
  smoking?: string
  alcohol?: string
  couples?: string
  local_id?: string
  id_documents?: string
  visitors?: string
  quiet_hours?: string
  payment?: string
  early_late?: string
}
export const POLICY_FIELDS: [keyof Policies, string, string][] = [
  ['pet', 'Pet policy', 'e.g. Small pets allowed with prior notice, ₹500/night'],
  ['child', 'Child policy', 'e.g. Below 5 free; 5–12 years ₹800/night with meals'],
  ['extra_bed', 'Extra bed policy', 'e.g. Mattress ₹1,000/night, max 1 per room'],
  ['early_late', 'Early check-in / late check-out', 'e.g. Subject to availability, half-day charge'],
  ['id_documents', 'ID required', 'e.g. Aadhaar / passport for all adults'],
  ['local_id', 'Local ID policy', 'e.g. Local IDs accepted / not accepted'],
  ['couples', 'Unmarried couples', 'e.g. Welcome with valid ID'],
  ['smoking', 'Smoking', 'e.g. Only in outdoor areas'],
  ['alcohol', 'Alcohol', 'e.g. Allowed in rooms, not in public areas'],
  ['visitors', 'Visitors', 'e.g. Not allowed after 8pm'],
  ['quiet_hours', 'Quiet hours', 'e.g. 10pm – 7am'],
  ['payment', 'Payment terms', 'e.g. 50% advance, balance at check-in'],
]

/** Property contact details. Private: only users with "view_property_contacts" (admins by default) see them. */
export interface Contact {
  person?: string
  phone?: string
  phone2?: string
  phone3?: string
  email?: string
  email2?: string
  bank_details?: string
  /** More contacts, one per line: "Name – role – phone". */
  others?: string
}
export const CONTACT_FIELDS: [keyof Contact, string][] = [
  ['person', 'Contact person'],
  ['phone', 'Contact number 1'],
  ['phone2', 'Contact number 2'],
  ['phone3', 'Contact number 3'],
  ['email', 'Email ID 1'],
  ['email2', 'Email ID 2'],
  ['bank_details', 'Account details (bank / UPI)'],
  ['others', 'More contacts (one per line: name – role – phone)'],
]

export const dining = (s: string | null | undefined) => parseJson<Dining>(s, {})
export const policies = (s: string | null | undefined) => parseJson<Policies>(s, {})
export const contact = (s: string | null | undefined) => parseJson<Contact>(s, {})

/** Read lat/lng out of a Google Maps link (…/@10.08,77.05,15z, ?q=10.08,77.05, !3d10.08!4d77.05, ll=…). */
export function latLngFromMapUrl(url: string | null | undefined): { lat: number; lng: number } | null {
  if (!url) return null
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/]
  for (const re of pats) {
    const m = url.match(re)
    if (m) {
      const lat = parseFloat(m[1])
      const lng = parseFloat(m[2])
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }
    }
  }
  return null
}

/** YouTube / Vimeo link → embeddable URL (privacy-friendly YouTube domain). */
export function videoEmbedUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/)
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`
  const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`
  return null
}

/** SQL for a property's cover image (images only; facade first). Use inside a query aliasing properties as `p`. */
export const COVER_PHOTO_SQL = `(SELECT ph.r2_key FROM property_photos ph WHERE ph.property_id = p.id AND ph.media_type = 'image' AND ph.r2_key != ''
  ORDER BY CASE ph.category WHEN 'facade' THEN 0 WHEN 'common' THEN 1 WHEN 'pool' THEN 2 WHEN 'view' THEN 3 WHEN 'room' THEN 4 ELSE 5 END, ph.sort, ph.id LIMIT 1)`

/** Who a room's rate covers: "sleeps 3" or "2 guests incl., max 4 (+₹1,000/adult, ₹500/child per night)". */
export function guestsText(r: { capacity: number; base_guests?: number | null; extra_adult_rate?: number | null; extra_child_rate?: number | null }) {
  const base = Math.min(r.base_guests ?? r.capacity, r.capacity)
  if (base >= r.capacity) return `sleeps ${r.capacity}`
  const child = r.extra_child_rate != null && r.extra_child_rate !== r.extra_adult_rate ? `, ${r.extra_child_rate ? money(r.extra_child_rate) : 'free'}/child` : ''
  const extra = r.extra_adult_rate ? ` (+${money(r.extra_adult_rate)}/adult${child} per night)` : ''
  return `${base} guests incl., max ${r.capacity}${extra}`
}

/** Extras a property sells (campfire, candle-light dinner…): guest price, and the B2B net cost (management only). */
export interface ActivityItem {
  name: string
  price: number
  complimentary: boolean
}

export interface Addon {
  /** Optional children belonging only to this property activity; not quote selections. */
  items?: ActivityItem[]
  name: string
  price: number
  net?: number | null
  /** "stay" = once per stay (default), "night" = per night, "person" = per person */
  per?: 'stay' | 'night' | 'person'
  /** Included free with the stay (shown as "complimentary"). */
  complimentary?: boolean
}
export const ADDON_PER: Record<string, string> = { stay: 'per stay', night: 'per night', person: 'per person' }
export const addons = (s: string | null | undefined) => parseJson<Addon[]>(s, []).filter((a) => a && a.name)

/** "Name | guest ₹ | net ₹ | per" lines → add-ons (net kept from `previous` when the editor can't see it). */
export function parseAddonLines(text: string, previous: Addon[], withNet: boolean): Addon[] {
  const out: Addon[] = []
  for (const line of text.split('\n')) {
    const [name, price, net, per] = line.split('|').map((x) => x.trim())
    if (!name) continue
    const n = (v: string | undefined) => (v && /\d/.test(v) ? Math.max(0, parseInt(v.replace(/[^\d]/g, ''), 10)) : null)
    const p = withNet ? per : net
    const perV = (['stay', 'night', 'person'].includes((p ?? '').toLowerCase()) ? (p ?? '').toLowerCase() : 'stay') as Addon['per']
    const old = previous.find((a) => a.name.toLowerCase() === name.toLowerCase())
    out.push({ name: name.slice(0, 80), price: n(price) ?? 0, net: withNet ? n(net) : old?.net ?? null, per: perV, ...(old?.items ? { items: old.items } : {}) })
  }
  return out.slice(0, 40)
}

export function addonLines(list: Addon[], withNet: boolean): string {
  return list.map((a) => (withNet ? [a.name, a.price, a.net ?? '', a.per ?? 'stay'] : [a.name, a.price, a.per ?? 'stay']).join(' | ')).join('\n')
}

export interface ChosenAddon { name: string; price: number; qty: number; total: number }
export const chosenAddons = (s: string | null | undefined) => parseJson<ChosenAddon[]>(s, []).filter((a) => a && a.name)
/** Guest-facing label for a quote option's extras: "Campfire + Candle-light dinner + Airport pickup". */
export function extrasLabel(o: { extra_label: string | null; addons?: string | null; extra_charges: number }): string {
  const adds = chosenAddons(o.addons)
  const manual = o.extra_charges - adds.reduce((a, x) => a + x.total, 0)
  return [...adds.map((a) => (a.qty > 1 ? `${a.name} × ${a.qty}` : a.name)), ...(manual > 0 ? [o.extra_label || 'Other extras'] : [])].join(' + ') || o.extra_label || 'Extras'
}
