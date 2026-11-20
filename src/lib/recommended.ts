import type { Env } from '../env'
import { first } from './db'
import { parseJson } from './util'

export const RECOMMENDED_KEY = 'recommended_property_ids'
export function recommendedIds(value: unknown): number[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].slice(0, 6) : []
}
export async function recommendedState(env: Env) {
  const row = await first<{ value: string }>(env, 'SELECT value FROM content WHERE key = ?', RECOMMENDED_KEY)
  return { ids: recommendedIds(parseJson(row?.value, [])), revision: row?.value ?? '' }
}
/** Atomic compare-and-set and Live eligibility guard; no unrelated content/property rows are touched. */
export async function saveRecommended(env: Env, ids: number[], revision: string): Promise<boolean> {
  if (ids.length > 6 || recommendedIds(ids).length !== ids.length) return false
  const value = JSON.stringify(ids)
  const result = await env.DB.prepare(`INSERT INTO content(key,value,updated_at)
    SELECT ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE COALESCE((SELECT value FROM content WHERE key = ?), '') = ?
    AND (SELECT COUNT(*) FROM properties WHERE status = 'live' AND id IN (SELECT value FROM json_each(?))) = ?
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE content.value = ?`)
    .bind(RECOMMENDED_KEY, value, RECOMMENDED_KEY, revision, value, ids.length, revision).run()
  if (!result.meta.changes) return false
  await env.KV.delete('cache:content:v1')
  return true
}
