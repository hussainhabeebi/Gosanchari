// Guard for "Ask AI": only single, read-only SELECT queries over an allow-list of tables.

export const ASK_AI_TABLES: Record<string, string> = {
  properties: 'id, name, type, destination, status, rating_avg, rating_count, is_partner, commission_pct, created_at',
  rooms: 'id, property_id, name, capacity, units, base_rate, weekend_rate, net_rate',
  bookings:
    "id, code, user_id, property_id, room_id, check_in, check_out, nights, adults, children, rooms_count, subtotal, discount, taxes, total, amount_paid, status ('pending','confirmed','checked_in','completed','cancelled'), payment_status ('unpaid','partial','paid','failed','refunded','partially_refunded'), source, guest_name, staff_id, quotation_id, enquiry_id, created_at, cancelled_at",
  payments: "id, booking_id, amount, status ('created','paid','failed','refunded'), created_at",
  refunds: "id, booking_id, amount, reason, status ('requested','approved','rejected','processed','failed'), created_at",
  enquiries:
    "id, code, user_id, guest_name, destination, property_id, check_in, check_out, adults, children, budget, source ('website','whatsapp','phone','instagram','chat','email'), status ('new','in_progress','quoted','booked','closed','lost'), lost_reason, assigned_to, tags (JSON array text), language, urgent, first_response_at, created_at",
  quotes: "id, code, enquiry_id, staff_id, guest_name, status ('draft','pending_approval','sent','viewed','accepted','expired','declined','changes_requested'), total, view_count, sent_at, created_at",
  quotation_options: 'id, quotation_id, property_id, room_id, check_in, check_out, subtotal, discount, total',
  reviews: "id, booking_id, property_id, rating, body, status ('pending','approved','hidden'), flagged, created_at",
  coupons: 'id, code, discount_type, discount_value, used_count, valid_from, valid_to',
  people: "id, role ('guest','admin','manager','sales','accounts'), name, created_at",
  destinations: 'id, name',
  payouts: 'id, property_id, booking_id, amount, status, created_at',
  tasks: "id, assigned_to, enquiry_id, reason, due_at, status ('open','done'), created_at",
}

const FORBIDDEN = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'attach', 'detach', 'pragma', 'replace', 'vacuum',
  'reindex', 'analyze', 'begin', 'commit', 'rollback', 'savepoint', 'release', 'trigger', 'load_extension',
  'upsert', 'returning', 'into',
]
const FORBIDDEN_IDENTIFIERS = ['password_hash', 'google_sub', 'token', 'sqlite_master', 'sqlite_schema', 'sqlite_temp_master', 'd1_', '_cf_']

export interface GuardResult {
  ok: boolean
  sql?: string
  error?: string
}

/** Remove string literals and comments so keyword checks cannot be fooled by them. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

export function guardSql(raw: string, maxRows = 200): GuardResult {
  let sql = raw.trim().replace(/^```(?:sql)?/i, '').replace(/```$/, '').trim()
  sql = sql.replace(/;\s*$/, '').trim()
  if (!sql) return { ok: false, error: 'Empty query' }
  if (sql.length > 4000) return { ok: false, error: 'Query too long' }

  const bare = stripLiterals(sql)
  const lower = bare.toLowerCase()
  if (lower.includes(';')) return { ok: false, error: 'Only one statement is allowed' }
  if (/"|`|\[/.test(bare)) return { ok: false, error: 'Quoted identifiers are not allowed' }
  if (!/^(select|with)\b/.test(lower)) return { ok: false, error: 'Only SELECT queries are allowed' }

  const words = new Set(lower.match(/[a-z_][a-z0-9_]*/g) ?? [])
  for (const k of FORBIDDEN) if (words.has(k)) return { ok: false, error: `Keyword not allowed: ${k}` }
  for (const w of words) {
    if (FORBIDDEN_IDENTIFIERS.some((f) => w === f || (f.endsWith('_') && w.startsWith(f)) || (f.startsWith('sqlite') && w.startsWith('sqlite'))))
      return { ok: false, error: `Not allowed: ${w}` }
  }

  // CTE names are allowed as table sources.
  const ctes = new Set<string>()
  for (const m of lower.matchAll(/(?:with|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/g)) ctes.add(m[1])

  // Every table after FROM / JOIN must be allowed. Sub-selects "FROM (" are fine.
  for (const m of lower.matchAll(/\b(from|join)\s+([a-z_][a-z0-9_]*|\()/g)) {
    const t = m[2]
    if (t === '(') continue
    if (!(t in ASK_AI_TABLES) && !ctes.has(t)) return { ok: false, error: `Table not allowed: ${t}` }
  }
  // Comma-joined tables: FROM a, b
  for (const m of lower.matchAll(/\bfrom\s+([a-z_][a-z0-9_]*(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?(?:\s*,\s*[a-z_][a-z0-9_]*(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?)+)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+/)[0]
      if (!(t in ASK_AI_TABLES) && !ctes.has(t)) return { ok: false, error: `Table not allowed: ${t}` }
    }
  }

  return { ok: true, sql: `SELECT * FROM (${sql}) LIMIT ${maxRows}` }
}

export function schemaForPrompt(): string {
  return Object.entries(ASK_AI_TABLES)
    .map(([t, cols]) => `${t}(${cols})`)
    .join('\n')
}
