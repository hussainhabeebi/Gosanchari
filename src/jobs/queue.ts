// Background jobs (Cloudflare Queues): anything the user does not need to wait for.

import type { Env, JobMessage } from '../env'
import { buildQuoteExplainer, checkReview, extractGuestPrefs, followupDraft, processEnquiryAI, refreshReviewSummary, reviewReplyDraft } from '../lib/assist'
import { aiImageTags, aiTranscribe, detectLanguage } from '../lib/ai'
import { first, notifyStaff, run } from '../lib/db'
import { sendWhatsApp } from '../lib/integrations'
import { embedProperty, syncContentKb, syncPropertyKb } from '../lib/properties'
import type { MessageRow, ReviewRow } from '../lib/types'

const PHOTO_TAGS = ['pool', 'garden', 'sea_view', 'lake_view', 'hill_view', 'campfire', 'kitchen', 'restaurant', 'spa', 'parking', 'ac', 'tv']

export async function runJob(env: Env, job: JobMessage): Promise<void> {
  switch (job.type) {
    case 'enquiry_ai':
      return processEnquiryAI(env, job.enquiryId)
    case 'embed_property':
      return embedProperty(env, job.propertyId)
    case 'photo_tags': {
      const ph = await first<{ id: number; r2_key: string }>(env, 'SELECT id, r2_key FROM property_photos WHERE id = ?', job.photoId)
      if (!ph || ph.r2_key.startsWith('http')) return
      const obj = await env.MEDIA.get(ph.r2_key)
      if (!obj) return
      const tags = await aiImageTags(env, await obj.arrayBuffer(), PHOTO_TAGS)
      if (tags) await run(env, 'UPDATE property_photos SET ai_tags = ? WHERE id = ?', JSON.stringify(tags), ph.id)
      return
    }
    case 'review_check': {
      await checkReview(env, job.reviewId)
      const r = await first<ReviewRow & { property_name: string }>(env, 'SELECT r.*, p.name AS property_name FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.id = ?', job.reviewId)
      if (r && r.rating <= 2) await notifyStaff(env, 'low_review', `${r.rating}★ review for ${r.property_name} from ${r.guest_name}: “${r.body.slice(0, 120)}”`)
      return
    }
    case 'review_reply_draft':
      return reviewReplyDraft(env, job.reviewId)
    case 'review_summary':
      return refreshReviewSummary(env, job.propertyId)
    case 'transcribe': {
      const m = await first<MessageRow>(env, 'SELECT * FROM messages WHERE id = ?', job.messageId)
      if (!m?.media_key) return
      const obj = await env.MEDIA.get(m.media_key)
      if (!obj) return
      const text = await aiTranscribe(env, await obj.arrayBuffer())
      if (text) {
        await run(env, 'UPDATE messages SET transcript = ? WHERE id = ?', text, m.id)
        if (m.enquiry_id) {
          if (detectLanguage(text) === 'ml') await run(env, "UPDATE enquiries SET language = 'ml' WHERE id = ?", m.enquiry_id)
          const e = await first<{ summary: string | null; message: string }>(env, 'SELECT summary, message FROM enquiries WHERE id = ?', m.enquiry_id)
          if (e && !e.message) await run(env, 'UPDATE enquiries SET message = ? WHERE id = ?', text, m.enquiry_id)
          if (e && !e.summary) await processEnquiryAI(env, m.enquiry_id)
        }
      }
      return
    }
    case 'quote_explainer':
      return buildQuoteExplainer(env, job.quotationId)
    case 'guest_prefs': {
      // At most once an hour per enquiry.
      const k = `prefs:${job.enquiryId}`
      if (await env.KV.get(k)) return
      await env.KV.put(k, '1', { expirationTtl: 3600 })
      return extractGuestPrefs(env, job.enquiryId)
    }
    case 'followup_draft':
      return followupDraft(env, job.taskId)
    case 'sync_kb':
      return job.what === 'property' && job.id ? syncPropertyKb(env, job.id) : syncContentKb(env)
    case 'whatsapp': {
      const r = await sendWhatsApp(env, job.to, job.text, job.template ? { name: job.template, params: job.params ?? [] } : undefined)
      if (!r.ok) throw new Error(`WhatsApp send failed: ${r.error}`)
      return
    }
  }
}

export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await runJob(env, msg.body)
      msg.ack()
    } catch (e) {
      console.error('job failed', msg.body.type, e)
      msg.retry({ delaySeconds: 30 * msg.attempts })
    }
  }
}
