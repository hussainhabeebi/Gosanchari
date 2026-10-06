// Lists the data-entry team can extend from the admin (property categories, "best for", facilities & activities,
// room amenities, room category names). Built-in items live in code; additions and hidden built-ins live in the
// `taxonomy` table. Additions are merged into the built-in maps at the start of each request, so every filter,
// label and validation in the app sees them.

import type { Env } from '../env'
import { ACTIVITIES, ROOM_AMENITIES, ROOM_CATEGORY_NAMES, STAY_TYPES, THEMES, WIZARD_AMENITIES, WIZARD_FACILITIES } from './catalog'
import { FACILITIES } from './search'
import { all, run } from './db'
import { slugify } from './util'

export const KINDS = {
  property_type: { label: 'Property categories', map: STAY_TYPES, defaults: () => Object.keys(STAY_TYPES) },
  theme: { label: 'Best for', map: THEMES, defaults: () => Object.keys(THEMES) },
  facility: { label: 'Facilities & activities (property)', map: FACILITIES, defaults: () => WIZARD_FACILITIES },
  activity: { label: 'Chargeable activities', map: ACTIVITIES, defaults: () => Object.keys(ACTIVITIES) },
  amenity: { label: 'Room amenities', map: ROOM_AMENITIES, defaults: () => WIZARD_AMENITIES },
  room_category: { label: 'Room category names', map: Object.fromEntries(ROOM_CATEGORY_NAMES.map((n) => [n, n])) as Record<string, string>, defaults: () => ROOM_CATEGORY_NAMES },
} as const
export type Kind = keyof typeof KINDS

interface Row { kind: Kind; key: string; label: string; icon: string | null; hidden: number }

/** Built-in keys of each map, captured before any additions. */
const BUILT_IN: Record<Kind, Set<string>> = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, new Set(Object.keys(v.map))])) as Record<Kind, Set<string>>
export const CUSTOM_ICONS: Record<string, string> = {}

let cache: { at: number; rows: Row[] } | null = null
const CACHE_KEY = 'cache:taxonomy:v1'

async function rows(env: Env): Promise<Row[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows
  let list = (await env.KV.get(CACHE_KEY, 'json').catch(() => null)) as Row[] | null
  if (!list) {
    list = await all<Row>(env, 'SELECT kind, key, label, icon, hidden FROM taxonomy ORDER BY id').catch(() => [] as Row[])
    await env.KV.put(CACHE_KEY, JSON.stringify(list), { expirationTtl: 300 }).catch(() => {})
  }
  cache = { at: Date.now(), rows: list }
  return list
}

/** Merge additions into the shared maps (run once per request, cheap thanks to the cache). */
export async function applyTaxonomy(env: Env) {
  const list = await rows(env)
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const map = KINDS[kind].map as Record<string, string>
    for (const key of Object.keys(map)) if (!BUILT_IN[kind].has(key)) delete map[key]
  }
  for (const r of list) {
    if (r.hidden || !(r.kind in KINDS)) continue
    ;(KINDS[r.kind].map as Record<string, string>)[r.key] = r.label
    if (r.icon) CUSTOM_ICONS[r.key] = r.icon
  }
}

/** The list shown in the wizard for a kind: built-in defaults (minus hidden) + additions, as [key, label]. */
export async function listFor(env: Env, kind: Kind): Promise<[string, string][]> {
  const list = (await rows(env)).filter((r) => r.kind === kind)
  const hidden = new Set(list.filter((r) => r.hidden).map((r) => r.key))
  const map = KINDS[kind].map as Record<string, string>
  const base = KINDS[kind].defaults().filter((k) => !hidden.has(k)).map((k) => [k, map[k] ?? k] as [string, string])
  const extra = list.filter((r) => !r.hidden && !BUILT_IN[kind].has(r.key)).map((r) => [r.key, r.label] as [string, string])
  return [...base, ...extra]
}

export async function allRows(env: Env, kind: Kind) {
  const list = (await rows(env)).filter((r) => r.kind === kind)
  const hidden = new Set(list.filter((r) => r.hidden).map((r) => r.key))
  const map = KINDS[kind].map as Record<string, string>
  return [
    ...KINDS[kind].defaults().map((k) => ({ key: k, label: map[k] ?? k, builtIn: true, hidden: hidden.has(k) })),
    ...list.filter((r) => !r.hidden && !BUILT_IN[kind].has(r.key)).map((r) => ({ key: r.key, label: r.label, builtIn: false, hidden: false })),
  ]
}

async function bust(env: Env) {
  cache = null
  await env.KV.delete(CACHE_KEY).catch(() => {})
}

/** Add an item; returns its key (existing key when the label already exists). */
export async function addItem(env: Env, kind: Kind, label: string, icon?: string | null): Promise<string> {
  const clean = label.trim().slice(0, 60)
  const map = KINDS[kind].map as Record<string, string>
  const existing = Object.entries(map).find(([, l]) => l.toLowerCase() === clean.toLowerCase())
  if (existing) {
    if (BUILT_IN[kind].has(existing[0])) await run(env, 'UPDATE taxonomy SET hidden = 0 WHERE kind = ? AND key = ?', kind, existing[0])
    else await run(env, 'INSERT INTO taxonomy (kind, key, label, icon) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET hidden = 0', kind, existing[0], existing[1], icon?.slice(0, 8) || null)
    await bust(env)
    return existing[0]
  }
  const key = kind === 'room_category' ? clean : slugify(clean).replace(/-/g, '_').slice(0, 40) || `item_${Date.now().toString(36)}`
  await run(env, 'INSERT INTO taxonomy (kind, key, label, icon) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET label = excluded.label, hidden = 0', kind, key, clean, icon?.slice(0, 8) || null)
  await bust(env)
  await applyTaxonomy(env)
  return key
}

/** Remove an addition, or hide a built-in item from the lists (existing data keeps its label). */
export async function removeItem(env: Env, kind: Kind, key: string) {
  if (BUILT_IN[kind].has(key)) await run(env, 'INSERT INTO taxonomy (kind, key, label, hidden) VALUES (?, ?, ?, 1) ON CONFLICT(kind, key) DO UPDATE SET hidden = 1', kind, key, (KINDS[kind].map as Record<string, string>)[key] ?? key)
  else await run(env, 'DELETE FROM taxonomy WHERE kind = ? AND key = ?', kind, key)
  await bust(env)
}

export async function restoreItem(env: Env, kind: Kind, key: string) {
  await run(env, 'DELETE FROM taxonomy WHERE kind = ? AND key = ? AND hidden = 1', kind, key)
  await bust(env)
}
