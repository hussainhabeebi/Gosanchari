// Public destination labels are a read-only view of Live property locations.
import type { Env } from '../env'
import { all } from './db'

export interface PublicDestination { label: string; aliases: string[] }
const keralaTowns = new Set(['munnar', 'vagamon', 'wayanad', 'alleppey', 'alappuzha', 'varkala', 'thekkady', 'kumarakom', 'kochi', 'kovalam', 'thattekad', 'kothamangalam'])
const invalid = /^(?:anywhere|unknown|n\/?a|none|null|test|destination|location|keral|kerala|india)$/i
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const title = (s: string) => s.replace(/\b\p{L}/gu, c => c.toUpperCase())

export async function publicDestinations(env: Env): Promise<PublicDestination[]> {
  const rows = await all<{ destination: string }>(env, "SELECT DISTINCT destination FROM properties WHERE status = 'live' AND trim(destination) <> ''")
  const masters = await all<{ name: string }>(env, 'SELECT name FROM destinations')
  const masterNames = new Set(masters.map(r => key(r.name)))
  const anchors = [...new Set([...masterNames, ...rows.map(r => key(r.destination).split(',')[0].trim()).filter(s => keralaTowns.has(s))])]
    .filter(s => s.length >= 4 && /^[\p{L} .'-]+$/u.test(s) && !invalid.test(s))
  const groups = new Map<string, Set<string>>()
  for (const row of rows) {
    const parts = key(row.destination).split(',').map(s => s.trim()).filter(Boolean)
    // Prefer a recognised town in a locality/town pair. An abbreviation is only
    // expanded when exactly one complete, existing destination starts with it.
    let town = parts.find(p => keralaTowns.has(p)) || parts[0] || ''
    const completions = anchors.filter(a => a !== town && a.startsWith(town))
    if (!masterNames.has(town) && !keralaTowns.has(town) && town.length >= 3 && town.length <= 5 && completions.length === 1) town = completions[0]
    if ((town.length < 4 && !masterNames.has(town)) || invalid.test(town) || !/^[\p{L} .'-]+$/u.test(town)) continue
    const label = keralaTowns.has(town) ? `${title(town)}, Kerala` : parts.map(title).join(', ')
    const aliases = groups.get(label) || new Set<string>()
    aliases.add(row.destination)
    groups.set(label, aliases)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([label, aliases]) => ({ label, aliases: [...aliases] }))
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]))
    row = next
  }
  return row[b.length]
}

export function matchingDestinations(catalog: PublicDestination[], query: string): PublicDestination[] {
  const q = key(query).slice(0, 100)
  if (!q) return catalog
  const exact = catalog.filter(d => key(d.label) === q || d.aliases.some(a => key(a) === q))
  if (exact.length) return exact
  return catalog.map(d => {
    const names = [d.label, ...d.aliases].map(key)
    const partial = names.some(n => n.includes(q))
    const typo = q.length >= 4 && names.some(n => distance(q, n.split(',')[0].trim()) <= (q.length >= 7 ? 2 : 1))
    return { d, score: partial ? 0 : typo ? 1 : 2 }
  }).filter(r => r.score < 2).sort((a, b) => a.score - b.score || a.d.label.localeCompare(b.d.label)).map(r => r.d)
}
