// Settings and website content, stored in D1 and cached in KV.

import type { Env } from '../env'
import { DEFAULT_TAX_SLABS, type TaxSlab } from './pricing'
import type { Permissions, Role } from './permissions'
import { parseJson } from './util'

export const AI_FEATURES = {
  smart_search: 'Smart search (sentence → filters)',
  recommended: 'Recommended sort & similar properties (Vectorize)',
  property_qa: 'Property Q&A chat',
  review_summary: 'Daily review summary on property pages',
  enquiry_ai: 'Enquiry auto-tags and staff summary',
  quote_explainer: 'Quote explainer for guests',
  review_check: 'Review check (rude / spam)',
  help_chat: 'Help chat assistant',
  staff_summary: 'Enquiry summary on staff workspace',
  property_matches: 'Top 3 property matches for staff',
  reply_suggest: 'Reply suggestions for staff',
  voice_notes: 'Voice note transcription (Whisper)',
  translate: 'Malayalam ↔ English translate button',
  quote_fill: 'Quote builder "Fill from enquiry" and message draft',
  guest_prefs: 'Guest preference notes from chats',
  followup_drafts: 'Morning follow-up drafts',
  daily_summary: 'Admin daily summary (+ WhatsApp to owner)',
  lost_insights: 'Weekly lost-reason insights',
  ask_ai: 'Ask AI (business questions)',
  review_insights: 'Review problem alerts and reply drafts',
  description_writer: 'Property description writer',
  property_extract: 'Property quick fill (paste details, AI fills the form)',
  rate_sheet: 'Read B2B rate sheets (PDF / Word) into room and season rates',
  staff_assistant: 'Staff AI assistant (find properties and exact prices for a client)',
  photo_tags: 'Photo tag suggestions',
  seo_suggest: 'SEO title & description suggestions',
} as const
export type AiFeature = keyof typeof AI_FEATURES

export interface Settings {
  business: {
    name: string
    tagline: string
    phone: string
    whatsapp: string
    email: string
    address: string
    gstin: string
    legal_name: string
    invoice_prefix: string
    logo_key: string | null
    social: { instagram?: string; facebook?: string; youtube?: string }
  }
  tax_slabs: TaxSlab[]
  booking: {
    hold_minutes: number // how long an unconfirmed (pending) booking keeps its rooms
    quote_validity_days: number
  }
  whatsapp_templates: Record<'confirmation' | 'reminder' | 'quote' | 'followup' | 'otp' | 'checkin', string>
  owner_whatsapp: string
  email: { from: string; reply_to: string }
  notifications: Record<'new_enquiry' | 'booking' | 'quote_accepted' | 'refund_request' | 'low_review' | 'daily_summary' | 'rate_expiry', Role[]>
  ai: {
    features: Record<AiFeature, boolean>
    assistant_welcome: string
    assistant_tone: string
    handoff_topics: string[]
    daily_limit: number
    models: { small: string; large: string; embed: string; whisper: string; translate: string; vision: string; fallback: string; gemini: string }
    /** 'auto' = Gemini for text when an API key is saved, else Workers AI; 'workers' = always Workers AI. */
    provider: 'auto' | 'workers'
  }
  role_permissions: Partial<Record<Role, Partial<Permissions>>>
  images_transform: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  business: {
    name: 'Go Sanchari',
    tagline: 'Travel more, worry less. Handpicked stays across Kerala.',
    phone: '+91 90000 00000',
    whatsapp: '+919000000000',
    email: 'hello@gosanchari.com',
    address: 'Kochi, Kerala, India',
    gstin: '',
    legal_name: 'Go Sanchari',
    invoice_prefix: 'GSINV',
    logo_key: null,
    social: { instagram: 'https://instagram.com/gosanchari' },
  },
  tax_slabs: DEFAULT_TAX_SLABS,
  booking: { hold_minutes: 1440, quote_validity_days: 3 },
  whatsapp_templates: {
    confirmation: 'Hi {name}, your booking {code} at {property} for {dates} is confirmed. Total: {amount}. Our team will share payment details. – Go Sanchari',
    reminder: 'Hi {name}, a reminder that your stay at {property} starts on {date}. Check-in from {time}. Directions: {map}',
    checkin: 'Hi {name}, check-in details for {property}: {address}. Contact: {contact}. Directions: {map}',
    quote: 'Hi {name}, here is your quote from Go Sanchari: {link} (valid till {valid}).',
    followup: 'Hi {name}, just checking if you had a chance to look at the quote for {property}. Happy to help!',
    otp: 'Your Go Sanchari login code is {code}. It expires in 10 minutes.',
  },
  owner_whatsapp: '',
  email: { from: 'Go Sanchari <hello@gosanchari.com>', reply_to: 'hello@gosanchari.com' },
  notifications: {
    new_enquiry: ['manager', 'sales'],
    booking: ['admin', 'manager'],
    quote_accepted: ['manager', 'sales'],
    refund_request: ['accounts', 'admin'],
    low_review: ['admin', 'manager'],
    daily_summary: ['admin'],
    rate_expiry: ['admin'],
  },
  ai: {
    features: Object.fromEntries(Object.keys(AI_FEATURES).map((k) => [k, true])) as Record<AiFeature, boolean>,
    assistant_welcome: 'Hi! I am the Go Sanchari assistant. Ask me about stays, bookings or policies. You can talk to a person any time.',
    assistant_tone: 'warm, short and helpful',
    handoff_topics: ['refund', 'complaint', 'legal', 'cancel', 'change booking', 'police', 'injury', 'harassment'],
    daily_limit: 2000,
    models: {
      small: '@cf/meta/llama-3.2-3b-instruct',
      large: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      embed: '@cf/baai/bge-m3',
      whisper: '@cf/openai/whisper-large-v3-turbo',
      translate: '@cf/meta/m2m100-1.2b',
      vision: '@cf/llava-hf/llava-1.5-7b-hf',
      fallback: '@cf/meta/llama-3.1-8b-instruct-fast',
      gemini: 'gemini-2.5-flash',
    },
    provider: 'auto',
  },
  role_permissions: {},
  images_transform: false,
}

const CACHE_KEY = 'cache:settings:v1'

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over) || base == null || typeof base !== 'object' || Array.isArray(base)) {
    return (over === undefined ? base : (over as T))
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge((base as Record<string, unknown>)[k], v)
  return out as T
}

export async function getSettings(env: Env): Promise<Settings> {
  const cached = await env.KV.get(CACHE_KEY, 'json').catch(() => null)
  if (cached) return deepMerge(DEFAULT_SETTINGS, cached)
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const stored: Record<string, unknown> = {}
  for (const r of rows.results) stored[r.key] = parseJson(r.value, null)
  await env.KV.put(CACHE_KEY, JSON.stringify(stored), { expirationTtl: 300 }).catch(() => {})
  return deepMerge(DEFAULT_SETTINGS, stored)
}

export async function saveSetting(env: Env, key: keyof Settings, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, JSON.stringify(value))
    .run()
  await env.KV.delete(CACHE_KEY)
}

// ---- Website content ----

export interface Faq { q: string; a: string }
export interface Banner { title: string; text: string; link: string; image?: string }
export interface Content {
  hero: { title: string; subtitle: string; image: string; script?: string; kicker?: string }
  /** Photo per "mood" hero (replaces the drawn scene), R2 keys or URLs. */
  mood_photos: Partial<Record<string, string>>
  banners: Banner[]
  why_us: { title: string; text: string; icon: string }[]
  faqs: Faq[]
  about: string
  policies: { privacy: string; cancellation: string; terms: string }
  featured_review_ids: number[]
}

export const DEFAULT_CONTENT: Content = {
  hero: {
    title: 'Discover Kerala,',
    script: 'Your Way',
    kicker: 'Explore · Stay · Unwind',
    subtitle: 'Handpicked stays, scenic destinations and unforgettable experiences across Kerala.',
    image: '',
  },
  mood_photos: {},
  banners: [],
  why_us: [
    { icon: '✔', title: 'Personally checked stays', text: 'Our team visits every property before it goes live.' },
    { icon: '₹', title: 'Best direct prices', text: 'No hidden fees. GST shown upfront.' },
    { icon: '💬', title: 'Real people on WhatsApp', text: 'Talk to us before, during and after your trip.' },
    { icon: '📝', title: 'Free, no-obligation quotes', text: 'Send an enquiry — no payment needed until you confirm.' },
  ],
  faqs: [],
  about: '',
  policies: { privacy: '', cancellation: '', terms: '' },
  featured_review_ids: [],
}

const CONTENT_CACHE = 'cache:content:v1'

export async function getContent(env: Env): Promise<Content> {
  const cached = await env.KV.get(CONTENT_CACHE, 'json').catch(() => null)
  if (cached) return { ...DEFAULT_CONTENT, ...(cached as Partial<Content>) }
  const rows = await env.DB.prepare('SELECT key, value FROM content').all<{ key: string; value: string }>()
  const stored: Record<string, unknown> = {}
  for (const r of rows.results) stored[r.key] = parseJson(r.value, null)
  await env.KV.put(CONTENT_CACHE, JSON.stringify(stored), { expirationTtl: 300 }).catch(() => {})
  return { ...DEFAULT_CONTENT, ...(stored as Partial<Content>) }
}

export async function saveContent(env: Env, key: keyof Content, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO content (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, JSON.stringify(value))
    .run()
  await env.KV.delete(CONTENT_CACHE)
}
