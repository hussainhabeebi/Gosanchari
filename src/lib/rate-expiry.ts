// Season / off-season rate periods that are about to end (or have ended) with no newer rates entered.
// Shown on the admin dashboard and the Expiring rates page, and sent as a WhatsApp reminder by the daily cron.

import type { Env } from '../env'
import { all } from './db'
import { addDays, todayIST } from './util'

/** Remind this many days before a rate period ends. */
export const EXPIRY_WINDOW_DAYS = 30
/** Keep showing an ended period (until new rates are added or it is marked handled) for this long. */
export const EXPIRED_LOOKBACK_DAYS = 90
/** Days before the end date on which the daily WhatsApp reminder goes out (0 = last day). */
export const REMINDER_DAYS = [30, 7, 0]

export interface ExpiringRate {
  property_id: number | null
  property_name: string | null
  destination: string | null
  name: string
  kind: string
  start_date: string
  end_date: string
  rows: number
}

/**
 * Rate periods ending between `from` and `to` (inclusive) that have not been renewed. A period counts as renewed
 * when the same property has a later-ending period of the same type (for special / holiday rates: the same name too).
 */
export function expiringRates(env: Env, from: string, to: string): Promise<ExpiringRate[]> {
  return all<ExpiringRate>(
    env,
    `SELECT s.property_id, p.name AS property_name, p.destination, s.name, COALESCE(s.kind, 'season') AS kind,
            MIN(s.start_date) AS start_date, s.end_date, COUNT(*) AS rows
     FROM season_rates s LEFT JOIN properties p ON p.id = s.property_id
     WHERE s.end_date >= ? AND s.end_date <= ? AND s.renewal_dismissed_at IS NULL
       AND (s.property_id IS NULL OR p.status != 'hidden')
       AND NOT EXISTS (
         SELECT 1 FROM season_rates n
         WHERE n.property_id IS s.property_id AND COALESCE(n.kind, 'season') = COALESCE(s.kind, 'season') AND n.end_date > s.end_date
           AND (COALESCE(s.kind, 'season') != 'special' OR n.name = s.name)
       )
     GROUP BY s.property_id, s.name, COALESCE(s.kind, 'season'), s.end_date
     ORDER BY s.end_date, p.name`,
    from, to,
  )
}

/** Everything the admin should look at: ended in the last 90 days or ending in the next 30. */
export function rateExpiryAlerts(env: Env, today = todayIST()): Promise<ExpiringRate[]> {
  return expiringRates(env, addDays(today, -EXPIRED_LOOKBACK_DAYS), addDays(today, EXPIRY_WINDOW_DAYS))
}

/** Whole days from `today` to the period's last night (negative once it has ended). */
export function daysLeft(endDate: string, today = todayIST()): number {
  return Math.round((Date.parse(endDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400_000)
}

export function expiryText(endDate: string, today = todayIST()): string {
  const d = daysLeft(endDate, today)
  if (d < 0) return `ended ${-d} day${d === -1 ? '' : 's'} ago`
  if (d === 0) return 'ends today'
  return `ends in ${d} day${d === 1 ? '' : 's'}`
}

/** The WhatsApp reminder for today, or null when no period hits a reminder day. */
export async function rateExpiryReminder(env: Env, today = todayIST()): Promise<string | null> {
  const due: ExpiringRate[] = []
  for (const d of REMINDER_DAYS) due.push(...(await expiringRates(env, addDays(today, d), addDays(today, d))))
  if (!due.length) return null
  const lines = due.map((r) => `• ${r.property_name ?? 'All properties'}${r.destination ? ` (${r.destination})` : ''}: ${r.name} — ${expiryText(r.end_date, today)}`)
  return `Rate reminder: these season rates are ending. Please add the new rates.\n${lines.join('\n')}`
}
