// Small shared helpers: dates, money, ids, JSON.

export const DAY_MS = 86_400_000

export function nowIso(): string {
  return new Date().toISOString()
}

/** Today's date in India (IST, UTC+5:30) as YYYY-MM-DD. */
export function todayIST(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * DAY_MS)
  return d.toISOString().slice(0, 10)
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(checkOut + 'T00:00:00Z') - Date.parse(checkIn + 'T00:00:00Z')) / DAY_MS)
}

/** Each night's date (the date you sleep there), from check-in up to the day before check-out. */
export function eachNight(checkIn: string, checkOut: string): string[] {
  const out: string[] = []
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d)
  return out
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay()
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
export function money(n: number | null | undefined): string {
  return '₹' + inr.format(Math.round(n ?? 0))
}

/** Short "₹1.2L" style amount, used in summaries. */
export function moneyShort(n: number): string {
  if (n >= 1_00_00_000) return '₹' + (n / 1_00_00_000).toFixed(1).replace(/\.0$/, '') + 'Cr'
  if (n >= 1_00_000) return '₹' + (n / 1_00_000).toFixed(1).replace(/\.0$/, '') + 'L'
  if (n >= 1000) return '₹' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return '₹' + Math.round(n)
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtDate(date: string | null | undefined): string {
  if (!date) return '—'
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  return `${d} ${months[m - 1]} ${y}`
}
export function fmtShortDate(date: string | null | undefined): string {
  if (!date) return '—'
  const [, m, d] = date.slice(0, 10).split('-').map(Number)
  return `${d} ${months[m - 1]}`
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(Date.parse(iso) + 5.5 * 3600_000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hh}:${mm}`
}
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function randomToken(bytes = 24): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Human-friendly reference like "GS-ENQ-7K3PQ2". Avoids look-alike characters. */
export function refCode(prefix: string): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const a = crypto.getRandomValues(new Uint8Array(6))
  return `GS-${prefix}-` + Array.from(a, (b) => alphabet[b % alphabet.length]).join('')
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 80)
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** Normalise an Indian phone number to E.164 (+91XXXXXXXXXX) where possible. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(/[^\d+]/g, '')
  if (d.startsWith('00')) d = '+' + d.slice(2)
  if (d.startsWith('+')) return d.length >= 11 ? d : null
  if (d.length === 10) return '+91' + d
  if (d.length === 12 && d.startsWith('91')) return '+' + d
  if (d.length === 11 && d.startsWith('0')) return '+91' + d.slice(1)
  return null
}

export function int(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : fallback
}

export function str(v: unknown, max = 2000): string {
  if (v == null) return ''
  return String(v).trim().slice(0, max)
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v)
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : [])
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\r\n')
}

export async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
