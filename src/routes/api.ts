// Read-only property API for external services (e.g. LeadVyne). Partners authenticate with an API key
// created in Admin → API & integrations, sent as "Authorization: Bearer <key>" or "X-API-Key: <key>".

import { Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { rateLimit } from '../lib/auth'
import { all, first, inBackground, run } from '../lib/db'
import { findApiKey, sharedProperties } from '../lib/property-share'
import { clamp, nowIso } from '../lib/util'

export const apiRoutes = new Hono<AppEnv>()

const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  const key = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : c.req.header('x-api-key') ?? '').trim()
  const conn = await findApiKey(c.env, key)
  if (!conn) return c.json({ error: 'Invalid or missing API key' }, 401)
  if (!(await rateLimit(c.env, `api:${conn.id}`, 120, 60))) return c.json({ error: 'Too many requests, slow down (120 per minute)' }, 429)
  inBackground(c, run(c.env, 'UPDATE api_connections SET last_used_at = ?, last_status = ? WHERE id = ?', nowIso(), `${c.req.method} ${c.req.path}`, conn.id))
  c.header('Cache-Control', 'no-store')
  await next()
}

apiRoutes.use('/api/v1/*', requireApiKey)

// List live properties with full details. ?page=1&limit=20 (max 50), ?destination=Munnar, ?updated_since=2026-01-01
apiRoutes.get('/api/v1/properties', async (c) => {
  const page = clamp(parseInt(c.req.query('page') ?? '1', 10) || 1, 1, 10_000)
  const limit = clamp(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1, 50)
  const where = ["status = 'live'"]
  const binds: string[] = []
  const destination = c.req.query('destination')?.trim()
  if (destination) { where.push('destination = ? COLLATE NOCASE'); binds.push(destination) }
  const since = c.req.query('updated_since')?.trim()
  if (since) {
    if (Number.isNaN(Date.parse(since))) return c.json({ error: 'updated_since must be a date, e.g. 2026-01-31 or 2026-01-31T10:00:00Z' }, 400)
    where.push('updated_at >= ?')
    binds.push(since)
  }
  const sqlWhere = where.join(' AND ')
  const [total, rows] = await Promise.all([
    first<{ n: number }>(c.env, `SELECT COUNT(*) AS n FROM properties WHERE ${sqlWhere}`, ...binds),
    all<{ id: number }>(c.env, `SELECT id FROM properties WHERE ${sqlWhere} ORDER BY id LIMIT ? OFFSET ?`, ...binds, limit, (page - 1) * limit),
  ])
  const data = await sharedProperties(c.env, rows.map((r) => r.id))
  const n = total?.n ?? 0
  return c.json({ data, page, limit, total: n, has_more: page * limit < n })
})

// One property by numeric id or slug.
apiRoutes.get('/api/v1/properties/:ref', async (c) => {
  const ref = c.req.param('ref')
  const row = await first<{ id: number }>(c.env, "SELECT id FROM properties WHERE status = 'live' AND (slug = ? OR id = ?)", ref, /^\d+$/.test(ref) ? Number(ref) : -1)
  const [data] = row ? await sharedProperties(c.env, [row.id]) : []
  if (!data) return c.json({ error: 'Property not found' }, 404)
  return c.json({ data })
})
