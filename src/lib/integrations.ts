// External services: Turnstile, WhatsApp Cloud API, email (Resend), media URLs.
// Each one degrades gracefully when its keys are missing (logs instead of sending) so the
// portal can run locally and features can be switched on one by one.

import type { Env } from '../env'
import { getSettings } from './settings'
import { hmacHex, timingSafeEqual } from './util'

// ---- Turnstile ----

export async function verifyTurnstile(env: Env, token: string | undefined, ip?: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return env.ENVIRONMENT !== 'production'
  if (!token) return false
  const body = new FormData()
  body.append('secret', env.TURNSTILE_SECRET)
  body.append('response', token)
  if (ip) body.append('remoteip', ip)
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  const j = (await r.json()) as { success: boolean }
  return !!j.success
}

// ---- WhatsApp ----

export function fillTemplate(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
}

export function whatsappConfigured(env: Env): boolean {
  return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)
}

/** Sends a WhatsApp text. Outside the 24h customer-care window Meta requires approved templates;
 *  pass `template` (approved template name) with `params` for those cases. */
export async function sendWhatsApp(
  env: Env,
  to: string,
  text: string,
  template?: { name: string; params: string[]; lang?: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const phone = to.replace(/[^\d]/g, '')
  if (!whatsappConfigured(env)) {
    console.log(`[whatsapp:dry-run] to=${phone} text=${text}`)
    return { ok: true, id: 'dry-run' }
  }
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.lang ?? 'en' },
          components: [{ type: 'body', parameters: template.params.map((p) => ({ type: 'text', text: p })) }],
        },
      }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text, preview_url: true } }
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } }
  if (!r.ok) return { ok: false, error: j.error?.message ?? `HTTP ${r.status}` }
  return { ok: true, id: j.messages?.[0]?.id }
}

export async function verifyWhatsAppSignature(env: Env, body: string, header: string | undefined): Promise<boolean> {
  if (!env.WHATSAPP_APP_SECRET) return env.ENVIRONMENT !== 'production'
  if (!header?.startsWith('sha256=')) return false
  return timingSafeEqual(await hmacHex(env.WHATSAPP_APP_SECRET, body), header.slice(7))
}

export async function downloadWhatsAppMedia(env: Env, mediaId: string): Promise<{ data: ArrayBuffer; type: string } | null> {
  if (!whatsappConfigured(env)) return null
  const meta = (await (
    await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } })
  ).json()) as { url?: string; mime_type?: string }
  if (!meta.url) return null
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } })
  if (!r.ok) return null
  return { data: await r.arrayBuffer(), type: meta.mime_type ?? 'application/octet-stream' }
}

// ---- Email ----

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  const s = await getSettings(env)
  if (!env.RESEND_API_KEY) {
    console.log(`[email:dry-run] to=${to} subject=${subject}`)
    return true
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: s.email.from, to, subject, html, reply_to: s.email.reply_to }),
  })
  return r.ok
}

// ---- Media ----

/** URL for an R2 photo. With Images transformations on for the zone, resizes on the fly. */
export function mediaUrl(key: string | null | undefined, width = 800, transform = false): string {
  if (!key) return '/placeholder.svg'
  if (key.startsWith('/')) return key // bundled static image (e.g. demo data)
  if (/^https?:\/\//.test(key)) {
    // External demo photos (seed data) – ask Unsplash-style CDNs for a width when supported.
    return key.includes('images.unsplash.com') ? key.replace(/([?&])w=\d+/, `$1w=${width}`) : key
  }
  const path = `/media/${key.split('/').map(encodeURIComponent).join('/')}`
  return transform ? `/cdn-cgi/image/width=${width},quality=75,format=auto${path}` : path
}
