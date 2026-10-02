import type { Context } from 'hono'
import type { AppEnv } from '../env'

export type Form = Record<string, string> & { __all: Record<string, string[]> }

/** Parse a form body; single values as strings, repeated fields available under __all. */
export async function form(c: Context<AppEnv>): Promise<Form> {
  const ct = c.req.header('content-type') ?? ''
  const out: Record<string, string> = {}
  const allVals: Record<string, string[]> = {}
  if (ct.includes('application/json')) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    for (const [k, v] of Object.entries(j)) {
      if (Array.isArray(v)) { allVals[k] = v.map(String); out[k] = String(v[0] ?? '') }
      else if (v != null) { out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v); allVals[k] = [out[k]] }
    }
  } else {
    const b = await c.req.parseBody({ all: true })
    for (const [k, v] of Object.entries(b)) {
      const arr = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string')
      allVals[k.replace(/\[\]$/, '')] = arr
      out[k.replace(/\[\]$/, '')] = arr[0] ?? ''
    }
  }
  return Object.assign(out, { __all: allVals }) as Form
}

export function redirectMsg(c: Context<AppEnv>, path: string, msg: { ok?: string; err?: string }) {
  const u = new URL(path, 'http://x')
  if (msg.ok) u.searchParams.set('ok', msg.ok)
  if (msg.err) u.searchParams.set('err', msg.err)
  return c.redirect(u.pathname + u.search + u.hash, 303)
}

/** Only allow same-site relative redirects. */
export function safeNext(next: string | undefined | null, fallback: string): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}

export function pageNum(c: Context<AppEnv>): number {
  const n = parseInt(c.req.query('page') ?? '1', 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 1
}
