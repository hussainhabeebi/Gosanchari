// Row types for the main tables.

export interface PropertyRow {
  id: number
  slug: string
  name: string
  type: string
  destination: string
  address: string | null
  lat: number | null
  lng: number | null
  owner_name: string | null
  owner_phone: string | null
  owner_email: string | null
  is_partner: number
  commission_pct: number
  highlights: string
  description: string
  description_ml: string
  facilities: string
  meal_plans: string
  checkin_time: string
  checkout_time: string
  cancellation_policy: string
  house_rules: string
  id_required: number
  nearby: string
  pet_friendly: number
  family_friendly: number
  internal_notes: string
  last_minute_note: string
  seo_title: string | null
  seo_description: string | null
  status: 'draft' | 'live' | 'hidden'
  featured: number
  rating_avg: number
  rating_count: number
  review_summary: string | null
  review_summary_at: string | null
  embedded_at: string | null
  created_at: string
  updated_at: string
  stay_type: string | null
  map_url: string | null
  star_category: number | null
  built_year: number | null
  themes: string
  languages: string
  how_to_reach: string
  best_time: string
  good_to_know: string
  dining: string
  policies: string
  contact: string
}

export interface RoomRow {
  id: number
  property_id: number
  name: string
  capacity: number
  bed_type: string | null
  facilities: string
  inclusions: string
  units: number
  base_rate: number
  weekend_rate: number | null
  net_rate: number | null
  min_nights: number
  active: number
  description: string
  size_sqft: number | null
  room_view: string | null
  max_adults: number | null
  max_children: number | null
  extra_bed: number
  extra_bed_rate: number | null
}

export interface PhotoRow {
  id: number
  property_id: number
  r2_key: string
  caption: string | null
  sort: number
  ai_tags: string
  tags_confirmed: number
  category: string
  room_id: number | null
  media_type: 'image' | 'video'
  video_url: string | null
}

export interface NearbyPlace {
  name: string
  kind: string
  km: number
  time?: string
}

export interface EnquiryRow {
  id: number
  code: string
  user_id: number | null
  guest_name: string
  phone: string | null
  email: string | null
  destination: string | null
  property_id: number | null
  check_in: string | null
  check_out: string | null
  adults: number
  children: number
  budget: number | null
  message: string
  source: string
  status: 'new' | 'in_progress' | 'quoted' | 'booked' | 'closed' | 'lost'
  lost_reason: string | null
  assigned_to: number | null
  tags: string
  language: 'en' | 'ml'
  summary: string | null
  urgent: number
  whatsapp_optin: number
  waiting_on: 'us' | 'guest'
  chat_room: string | null
  last_guest_msg_at: string | null
  last_staff_reply_at: string | null
  first_response_at: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: number
  enquiry_id: number | null
  booking_id: number | null
  sender: 'guest' | 'staff' | 'ai' | 'system'
  user_id: number | null
  channel: string
  body: string
  media_key: string | null
  media_type: string | null
  transcript: string | null
  translation: string | null
  created_at: string
}

export interface QuotationRow {
  id: number
  code: string
  token: string
  enquiry_id: number | null
  user_id: number | null
  staff_id: number | null
  guest_name: string
  phone: string | null
  email: string | null
  status: 'draft' | 'pending_approval' | 'sent' | 'viewed' | 'accepted' | 'expired' | 'declined' | 'changes_requested'
  valid_till: string | null
  inclusions: string
  exclusions: string
  payment_terms: string
  message: string
  explainer: string | null
  guest_feedback: string | null
  accepted_option_id: number | null
  view_count: number
  last_viewed_at: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export interface QuoteOptionRow {
  id: number
  quotation_id: number
  property_id: number
  room_id: number
  check_in: string
  check_out: string
  adults: number
  children: number
  rooms_count: number
  meal_plan: string | null
  subtotal: number
  discount: number
  extra_charges: number
  extra_label: string | null
  taxes: number
  total: number
  discount_pct: number
  discount_approved_by: number | null
}

export interface BookingRow {
  id: number
  code: string
  user_id: number | null
  property_id: number
  room_id: number
  check_in: string
  check_out: string
  nights: number
  adults: number
  children: number
  rooms_count: number
  meal_plan: string | null
  subtotal: number
  discount: number
  extra_charges: number
  taxes: number
  total: number
  amount_paid: number
  coupon_code: string | null
  status: 'pending' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled'
  payment_status: 'unpaid' | 'partial' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'
  source: string
  guest_name: string
  guest_phone: string
  guest_email: string | null
  id_type: string | null
  special_requests: string
  internal_notes: string
  quotation_id: number | null
  enquiry_id: number | null
  staff_id: number | null
  change_request: string | null
  change_status: 'requested' | 'approved' | 'rejected' | null
  invoice_key: string | null
  reminder_sent_at: string | null
  hold_expires_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export interface ReviewRow {
  id: number
  booking_id: number | null
  user_id: number | null
  property_id: number
  guest_name: string
  rating: number
  body: string
  photos: string
  status: 'pending' | 'approved' | 'hidden'
  flagged: number
  flag_reason: string | null
  reply: string | null
  reply_draft: string | null
  created_at: string
}

export interface PropertyCard {
  id: number
  slug: string
  name: string
  type: string
  destination: string
  rating_avg: number
  rating_count: number
  facilities: string
  meal_plans: string
  from_price: number
  max_guests: number
  photo: string | null
  lat: number | null
  lng: number | null
  featured: number
  pet_friendly: number
  family_friendly: number
  created_at: string
  /** Filled when dates are given: average nightly price for the cheapest available room. */
  stay_price?: number
  stay_total?: number
  available?: boolean
  score?: number
}
