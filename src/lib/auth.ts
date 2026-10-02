// Sessions (KV), password hashing (PBKDF2), phone OTP, role checks.

import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AppEnv, Env, SessionUser } from '../env'
import { isStaff, resolvePermissions, type PermissionKey, type Permissions, type Role } from './permissions'
import { getSettings } from './settings'
import { randomToken, timingSafeEqual, sha256Hex } from './util'

const COOKIE = 'gs_session'
const SESSION_TTL = 30 * 86400
const STAFF_SESSION_TTL = 12 * 3600

// ---- Passwords ----

const ITER = 100_000
function b64(a: Uint8Array) {
  return btoa(String.fromCharCode(...a))
}
function unb64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256)
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const [scheme, iter, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2') return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: Number(iter) }, key, 256)
  return timingSafeEqual(b64(new Uint8Array(bits)), hash)
}

// ---- Sessions ----

export async function createSession(c: Context<AppEnv>, userId: number, role: Role): Promise<void> {
  const token = randomToken(32)
  const ttl = isStaff(role) ? STAFF_SESSION_TTL : SESSION_TTL
  await c.env.KV.put(`sess:${await sha256Hex(token)}`, JSON.stringify({ userId }), { expirationTtl: ttl })
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl,
  })
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, COOKIE)
  if (token) await c.env.KV.delete(`sess:${await sha256Hex(token)}`)
  deleteCookie(c, COOKIE, { path: '/' })
}

export async function loadUserById(env: Env, id: number): Promise<SessionUser | null> {
  const u = await env.DB.prepare(
    'SELECT id, role, name, phone, email, language FROM users WHERE id = ? AND active = 1 AND blocked = 0 AND merged_into IS NULL',
  )
    .bind(id)
    .first<SessionUser>()
  return u ?? null
}

/** Loads the signed-in user (if any) on every request. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null)
  c.set('sessionToken', null)
  const token = getCookie(c, COOKIE)
  if (token) {
    const s = await c.env.KV.get<{ userId: number }>(`sess:${await sha256Hex(token)}`, 'json')
    if (s) {
      const u = await loadUserById(c.env, s.userId)
      if (u) {
        c.set('user', u)
        c.set('sessionToken', token)
      }
    }
  }
  await next()
}

export async function permissionsFor(env: Env, role: Role): Promise<Permissions> {
  const s = await getSettings(env)
  return resolvePermissions(role, s.role_permissions)
}

function loginRedirect(c: Context<AppEnv>) {
  const url = new URL(c.req.url)
  return c.redirect('/login?next=' + encodeURIComponent(url.pathname + url.search))
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) return loginRedirect(c)
  await next()
}

export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = c.get('user')
  if (!u) return loginRedirect(c)
  if (!isStaff(u.role)) return c.text('Staff only', 403)
  await next()
}

export function requirePerm(...perms: PermissionKey[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const u = c.get('user')
    if (!u) return loginRedirect(c)
    if (!isStaff(u.role)) return c.text('Staff only', 403)
    const p = await permissionsFor(c.env, u.role)
    if (!perms.every((k) => !!p[k])) return c.text('You do not have permission for this page.', 403)
    await next()
  }
}

// ---- Phone OTP ----

export async function createOtp(env: Env, phone: string): Promise<{ code: string } | { error: string }> {
  const rateKey = `otp:rate:${phone}`
  const sent = parseInt((await env.KV.get(rateKey)) ?? '0', 10)
  if (sent >= 5) return { error: 'Too many codes requested. Please try again in an hour.' }
  await env.KV.put(rateKey, String(sent + 1), { expirationTtl: 3600 })
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000
  const code = String(n).padStart(6, '0')
  await env.KV.put(`otp:${phone}`, JSON.stringify({ hash: await sha256Hex(code + phone), tries: 0 }), { expirationTtl: 600 })
  return { code }
}

export async function verifyOtp(env: Env, phone: string, code: string): Promise<boolean> {
  const key = `otp:${phone}`
  const rec = await env.KV.get<{ hash: string; tries: number }>(key, 'json')
  if (!rec) return false
  if (rec.tries >= 5) {
    await env.KV.delete(key)
    return false
  }
  const ok = timingSafeEqual(await sha256Hex(code.trim() + phone), rec.hash)
  if (ok) await env.KV.delete(key)
  else await env.KV.put(key, JSON.stringify({ ...rec, tries: rec.tries + 1 }), { expirationTtl: 600 })
  return ok
}

/** Simple fixed-window rate limit in KV. Returns false when the limit is hit. */
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`
  const n = parseInt((await env.KV.get(k)) ?? '0', 10)
  if (n >= limit) return false
  await env.KV.put(k, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) })
  return true
}

export function homeFor(role: Role): string {
  if (role === 'guest') return '/my'
  if (role === 'admin' || role === 'manager') return '/admin'
  if (role === 'accounts') return '/admin/payments'
  return '/staff'
}
