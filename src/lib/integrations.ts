// External services: Turnstile, WhatsApp Cloud API, email (Resend), media URLs.
// Each one degrades gracefully when its keys are missing (logs instead of sending) so the
// portal can run locally and features can be switched on one by one.

import type { Env } from '../env'
import { getSettings } from './settings'
import { hmacHex, timingSafeEqual } from './util'

// ---- Turnstile ----

export async function verifyTurnstile(env: Env, token: string | undefined, ip?: string | null): Promise<boolean> {
  // Not set up yet: allow the form (rate limits still apply). Add TURNSTILE_SECRET + TURNSTILE_SITE_KEY to turn the bot check on.
  if (!env.TURNSTILE_SECRET) {
    if (env.ENVIRONMENT === 'production') console.warn('Turnstile is not configured; bot check skipped')
    return true
  }
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
  template?: { name: string; params: string[]; lang?: string; copyCode?: string },
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
          components: [
            { type: 'body', parameters: template.params.map((p) => ({ type: 'text', text: p })) },
            // Authentication templates have a required "Copy code" button; Meta rejects the send without it.
            ...(template.copyCode ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: template.copyCode }] }] : []),
          ],
        },
      }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text, preview_url: true } }
  // A slow or stuck WhatsApp API must not leave someone waiting on the login screen.
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => e as Error)
  if (r instanceof Error) return { ok: false, error: r.name === 'TimeoutError' ? 'WhatsApp did not respond in time' : r.message }
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

const RESEND_KEY_KV = 'secret:resend_api_key'
const RESEND_API = 'https://api.resend.com'
export const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

/** Resend key from Admin → Settings → Email (stored on its own in KV), else the RESEND_API_KEY Worker secret. */
export async function resendKey(env: Env): Promise<string | null> {
  const k = (await env.KV.get(RESEND_KEY_KV).catch(() => null)) || env.RESEND_API_KEY || ''
  return k.trim() || null
}

export async function setResendKey(env: Env, key: string | null) {
  if (key) await env.KV.put(RESEND_KEY_KV, key.trim())
  else await env.KV.delete(RESEND_KEY_KV)
}

/** Checks a Resend key; returns the problem, or null when it works. "Sending access" keys cannot list domains, which still means the key is valid. */
export async function testResendKey(key: string): Promise<string | null> {
  const r = await fetch(`${RESEND_API}/domains`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch((e: unknown) => e as Error)
  if (r instanceof Error) return r.message
  if (r.ok) return null
  const j = (await r.json().catch(() => ({}))) as { name?: string; message?: string }
  return j.name === 'restricted_api_key' ? null : (j.message ?? `HTTP ${r.status}`)
}

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  const s = await getSettings(env)
  const key = await resendKey(env)
  if (!key) {
    console.log(`[email:dry-run] to=${to} subject=${subject}`)
    return true
  }
  const r = await fetch(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: s.email.from, to, subject, html, reply_to: s.email.reply_to }),
  })
  return r.ok
}

export interface OutgoingEmail { to: string[]; subject: string; html: string; text?: string }
export interface SendReport { sent: number; failed: number; errors: string[]; dryRun: boolean }

/** Sends many separate emails (one per recipient group) through Resend's batch endpoint, 100 per request. */
export async function sendEmails(env: Env, emails: OutgoingEmail[]): Promise<SendReport> {
  const s = await getSettings(env)
  const key = await resendKey(env)
  const report: SendReport = { sent: 0, failed: 0, errors: [], dryRun: !key }
  if (!key) {
    for (const e of emails) console.log(`[email:dry-run] to=${e.to.join(',')} subject=${e.subject}`)
    report.sent = emails.length
    return report
  }
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100)
    const body = JSON.stringify(chunk.map((e) => ({ from: s.email.from, reply_to: s.email.reply_to || undefined, to: e.to, subject: e.subject, html: e.html, text: e.text })))
    const post = () => fetch(`${RESEND_API}/emails/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    }).catch((e: unknown) => e as Error)
    let r = await post()
    // Resend allows a few requests per second; wait once and retry when rate limited.
    if (!(r instanceof Error) && r.status === 429) { await wait(1500); r = await post() }
    if (r instanceof Error || !r.ok) {
      const msg = r instanceof Error ? r.message : ((await r.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${r.status}`
      report.failed += chunk.length
      if (!report.errors.includes(msg)) report.errors.push(msg)
    } else report.sent += chunk.length
    if (i + 100 < emails.length) await wait(600)
  }
  return report
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
  // AVIF input resizing requires an Enterprise Images plan; BMP is not a supported
  // transformation input. Serve these original browser-readable R2 photos directly.
  return transform && !/\.(avif|bmp)$/i.test(key) ? `/cdn-cgi/image/width=${width},quality=75,format=auto${path}` : path
}
