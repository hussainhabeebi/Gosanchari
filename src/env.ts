import type { Role } from './lib/permissions'

export type JobMessage =
  | { type: 'enquiry_ai'; enquiryId: number }
  | { type: 'embed_property'; propertyId: number }
  | { type: 'photo_tags'; photoId: number }
  | { type: 'review_check'; reviewId: number }
  | { type: 'transcribe'; messageId: number }
  | { type: 'quote_explainer'; quotationId: number }
  | { type: 'guest_prefs'; enquiryId: number }
  | { type: 'followup_draft'; taskId: number }
  | { type: 'review_reply_draft'; reviewId: number }
  | { type: 'review_summary'; propertyId: number }
  | { type: 'sync_kb'; what: 'property' | 'content'; id?: number }
  | { type: 'whatsapp'; to: string; text: string; template?: string; params?: string[] }

export interface Env {
  DB: D1Database
  KV: KVNamespace
  MEDIA: R2Bucket
  KB: R2Bucket
  AI: Ai
  /** Optional so the portal still runs (with database-only answers) where AI Search is not set up. */
  AI_SEARCH?: AiSearchInstance
  /** Optional: semantic "Recommended" ranking and similar properties. Without it, rating-based ordering is used. */
  VECTORIZE?: VectorizeIndex
  JOBS: Queue<JobMessage>
  CHAT: DurableObjectNamespace
  ASSETS: Fetcher

  ENVIRONMENT: string
  SITE_URL: string
  AI_GATEWAY_ID: string
  TURNSTILE_SITE_KEY: string

  SESSION_SECRET?: string
  TURNSTILE_SECRET?: string
  WHATSAPP_TOKEN?: string
  WHATSAPP_PHONE_NUMBER_ID?: string
  WHATSAPP_VERIFY_TOKEN?: string
  WHATSAPP_APP_SECRET?: string
  RESEND_API_KEY?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** One-time code for /setup (creating the first admin). Set it in the dashboard, use it once, then delete it. */
  SETUP_CODE?: string
}

export interface SessionUser {
  id: number
  role: Role
  name: string
  phone: string | null
  email: string | null
  language: 'en' | 'ml'
}

export type AppEnv = {
  Bindings: Env
  Variables: { user: SessionUser | null; sessionToken: string | null }
}
