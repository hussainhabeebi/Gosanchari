// Inbound WhatsApp messages (text, voice notes, photos) → one enquiry thread per guest.

import { Hono } from 'hono'
import type { AppEnv, Env } from '../env'
import { enqueue, findOrCreateGuest, first, insertId, notifyStaff, run } from '../lib/db'
import { downloadWhatsAppMedia, verifyWhatsAppSignature } from '../lib/integrations'
import { detectLanguage } from '../lib/ai'
import { nowIso, refCode, timingSafeEqual } from '../lib/util'

export const webhookRoutes = new Hono<AppEnv>()

webhookRoutes.get('/webhooks/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token') ?? ''
  if (mode === 'subscribe' && c.env.WHATSAPP_VERIFY_TOKEN && timingSafeEqual(token, c.env.WHATSAPP_VERIFY_TOKEN)) return c.text(c.req.query('hub.challenge') ?? '')
  return c.text('forbidden', 403)
})

interface WaMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  audio?: { id: string; mime_type?: string }
  voice?: { id: string; mime_type?: string }
  image?: { id: string; mime_type?: string; caption?: string }
  document?: { id: string; filename?: string }
  button?: { text: string }
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } }
}

webhookRoutes.post('/webhooks/whatsapp', async (c) => {
  const raw = await c.req.text()
  if (!(await verifyWhatsAppSignature(c.env, raw, c.req.header('x-hub-signature-256')))) return c.text('bad signature', 401)
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { messages?: WaMessage[]; contacts?: { wa_id: string; profile?: { name?: string } }[] } }[] }[] }
  const jobs: Promise<void>[] = []
  for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
    const names = new Map((ch.value?.contacts ?? []).map((x) => [x.wa_id, x.profile?.name ?? '']))
    for (const m of ch.value?.messages ?? []) jobs.push(handleIncoming(c.env, m, names.get(m.from) ?? ''))
  }
  // Acknowledge fast; Meta retries slow webhooks.
  c.executionCtx.waitUntil(Promise.allSettled(jobs))
  return c.text('ok')
})

export async function handleIncoming(env: Env, m: WaMessage, profileName: string): Promise<void> {
  if (await first(env, 'SELECT 1 FROM messages WHERE external_id = ?', m.id)) return
  const phone = '+' + m.from.replace(/\D/g, '')
  let enquiry = await first<{ id: number; status: string }>(env, "SELECT id, status FROM enquiries WHERE phone = ? AND status IN ('new','in_progress','quoted') ORDER BY id DESC LIMIT 1", phone)
  let isNew = false
  if (!enquiry) {
    const userId = await findOrCreateGuest(env, phone, profileName || 'WhatsApp guest', null)
    const id = await insertId(env, "INSERT INTO enquiries (code, user_id, guest_name, phone, source, whatsapp_optin, message) VALUES (?, ?, ?, ?, 'whatsapp', 1, '')", refCode('ENQ'), userId, profileName || 'WhatsApp guest', phone)
    enquiry = { id, status: 'new' }
    isNew = true
  }
  let text = m.text?.body ?? m.image?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ''
  let mediaKey: string | null = null
  let mediaType: string | null = null
  const media = m.audio ?? m.voice ?? m.image ?? m.document
  if (media) {
    const file = await downloadWhatsAppMedia(env, media.id)
    if (file) {
      const ext = file.type.split('/')[1]?.split(';')[0] ?? 'bin'
      mediaKey = `${m.audio || m.voice ? 'voice' : 'private/wa'}/${enquiry.id}/${m.id}.${ext}`
      mediaType = file.type
      await env.MEDIA.put(mediaKey, file.data, { httpMetadata: { contentType: file.type } })
    } else if (!text) text = `[${m.type} received]`
  }
  const msgId = await insertId(
    env,
    "INSERT INTO messages (enquiry_id, sender, channel, body, media_key, media_type, external_id) VALUES (?, 'guest', 'whatsapp', ?, ?, ?, ?)",
    enquiry.id, text, mediaKey, mediaType, m.id,
  )
  await run(env, "UPDATE enquiries SET waiting_on = 'us', last_guest_msg_at = ?, updated_at = ?, language = CASE WHEN ? = 'ml' THEN 'ml' ELSE language END WHERE id = ?", nowIso(), nowIso(), detectLanguage(text), enquiry.id)
  if (isNew && text) await run(env, 'UPDATE enquiries SET message = ? WHERE id = ?', text, enquiry.id)
  // Voice notes → Whisper in the background.
  if (mediaKey && mediaType?.startsWith('audio')) await enqueue(env, { type: 'transcribe', messageId: msgId })
  else if (isNew) await enqueue(env, { type: 'enquiry_ai', enquiryId: enquiry.id })
  if (isNew) await notifyStaff(env, 'new_enquiry', `New WhatsApp enquiry from ${profileName || phone}.`)
}
