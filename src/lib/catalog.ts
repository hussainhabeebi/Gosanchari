// Lists of options for property details (types, photo sections, amenities, dining, policies) and helpers
// to read the JSON detail columns safely.

import { parseJson } from './util'

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
  ac: 'Air conditioning',
  fan: 'Ceiling fan',
  tv: 'TV',
  wifi: 'Wi-Fi',
  kettle: 'Kettle / tea & coffee',
  minibar: 'Minibar',
  fridge: 'Fridge',
  balcony: 'Balcony',
  sitout: 'Private sit-out',
  private_pool: 'Private pool',
  jacuzzi: 'Jacuzzi / bathtub',
  hot_water: 'Hot water',
  safe: 'In-room safe',
  hairdryer: 'Hair dryer',
  work_desk: 'Work desk',
  wardrobe: 'Wardrobe',
  toiletries: 'Toiletries',
  slippers: 'Slippers & bathrobe',
  intercom: 'Intercom',
  room_service: 'Room service',
  sofa: 'Sofa / seating',
  kitchenette: 'Kitchenette',
  mosquito_net: 'Mosquito net',
  heater: 'Room heater',
}

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

export interface Contact {
  person?: string
  phone?: string
  whatsapp?: string
  email?: string
  reservation_email?: string
  website?: string
  booking_url?: string
  gstin?: string
  bank_details?: string
}
export const CONTACT_FIELDS: [keyof Contact, string][] = [
  ['person', 'Contact person / manager'],
  ['phone', 'Phone'],
  ['whatsapp', 'WhatsApp'],
  ['email', 'Email'],
  ['reservation_email', 'Reservations email'],
  ['website', 'Property website'],
  ['booking_url', 'Direct booking link'],
  ['gstin', 'Property GSTIN'],
  ['bank_details', 'Bank / UPI details for payouts'],
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
