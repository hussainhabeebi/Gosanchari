// Scheduled batches (Cron Triggers). Daily 07:00 IST and weekly Monday 08:00 IST.

import type { Env } from '../env'
import { aiText } from '../lib/ai'
import { all, enqueue, first, insertId, notifyStaff, run } from '../lib/db'
import { expireHolds } from '../lib/bookings'
import { fillTemplate } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import { fmtDate, moneyShort, nowIso, todayIST } from '../lib/util'

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === '30 2 * * 1') return weekly(env)
  return daily(env)
}

export async function daily(env: Env): Promise<void> {
  const today = todayIST()
  const tomorrow = todayIST(1)
  const s = await getSettings(env)

  // 1. Housekeeping (rules only).
  await expireHolds(env)
  await run(env, "UPDATE quotations SET status = 'expired', updated_at = ? WHERE status IN ('sent','viewed','changes_requested') AND valid_till < ?", nowIso(), today)
  await run(env, "DELETE FROM blocked_dates WHERE quotation_id IN (SELECT id FROM quotations WHERE status IN ('expired','declined'))")
  await run(env, "UPDATE bookings SET status = 'completed', updated_at = ? WHERE status IN ('confirmed','checked_in') AND check_out < ?", nowIso(), today)

  // 2. Check-in details on WhatsApp one day before.
  const arriving = await all<{ id: number; guest_name: string; guest_phone: string; property_name: string; address: string | null; destination: string; lat: number | null; lng: number | null; checkin_time: string; owner_phone: string | null }>(
    env,
    "SELECT b.id, b.guest_name, b.guest_phone, p.name AS property_name, p.address, p.destination, p.lat, p.lng, p.checkin_time, p.owner_phone FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.status = 'confirmed' AND b.check_in = ? AND b.reminder_sent_at IS NULL",
    tomorrow,
  )
  for (const b of arriving) {
    const map = b.lat && b.lng ? `https://maps.google.com/?q=${b.lat},${b.lng}` : `https://maps.google.com/?q=${encodeURIComponent(b.property_name + ' ' + b.destination)}`
    const text = fillTemplate(s.whatsapp_templates.checkin, { name: b.guest_name, property: b.property_name, address: b.address ?? b.destination, contact: b.owner_phone ?? s.business.phone, map, time: b.checkin_time, date: fmtDate(tomorrow) })
    await enqueue(env, { type: 'whatsapp', to: b.guest_phone, text })
    await run(env, "INSERT INTO messages (booking_id, sender, channel, body) VALUES (?, 'system', 'whatsapp', ?)", b.id, text)
    await run(env, 'UPDATE bookings SET reminder_sent_at = ? WHERE id = ?', nowIso(), b.id)
  }

  // 3. Ask yesterday's leavers for a review.
  const left = await all<{ id: number; guest_name: string; guest_phone: string; property_name: string }>(
    env,
    "SELECT b.id, b.guest_name, b.guest_phone, p.name AS property_name FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.check_out = ? AND b.status IN ('completed','checked_in','confirmed') AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)",
    todayIST(-1),
  )
  for (const b of left) await enqueue(env, { type: 'whatsapp', to: b.guest_phone, text: `Hi ${b.guest_name}, hope you enjoyed ${b.property_name}! Could you leave a quick review? ${env.SITE_URL}/my/review/${b.id}` })

  // 4. Review summaries — only for properties with new approved reviews since the last summary.
  const props = await all<{ id: number }>(
    env,
    "SELECT p.id FROM properties p WHERE p.status = 'live' AND EXISTS (SELECT 1 FROM reviews r WHERE r.property_id = p.id AND r.status = 'approved' AND (p.review_summary_at IS NULL OR r.created_at > p.review_summary_at))",
  )
  for (const p of props) await enqueue(env, { type: 'review_summary', propertyId: p.id })

  // 5. Follow-up tasks + AI drafts for pending quotes, ready when staff log in.
  const pending = await all<{ id: number; staff_id: number | null; enquiry_id: number | null; guest_name: string; phone: string | null; code: string; view_count: number }>(
    env,
    `SELECT q.id, q.staff_id, q.enquiry_id, q.guest_name, q.phone, q.code, q.view_count FROM quotations q
     WHERE q.status IN ('sent','viewed') AND q.sent_at < ? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.quotation_id = q.id AND t.status = 'open')`,
    new Date(Date.now() - 20 * 3600_000).toISOString(),
  )
  const dueAt = new Date(Date.parse(today + 'T10:00:00+05:30')).toISOString()
  for (const q of pending) {
    const id = await insertId(env, 'INSERT INTO tasks (assigned_to, enquiry_id, quotation_id, guest_name, phone, reason, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)', q.staff_id, q.enquiry_id, q.id, q.guest_name, q.phone, `Follow up on quote ${q.code}${q.view_count ? ` (viewed ${q.view_count}×)` : ' (not opened yet)'}`, dueAt)
    await enqueue(env, { type: 'followup_draft', taskId: id })
  }
  const undrafted = await all<{ id: number }>(env, "SELECT id FROM tasks WHERE status = 'open' AND draft_message IS NULL AND due_at <= ? LIMIT 200", new Date(Date.parse(today + 'T23:59:59+05:30')).toISOString())
  for (const t of undrafted) await enqueue(env, { type: 'followup_draft', taskId: t.id })

  // 6. Daily summary for the owner.
  await dailySummary(env)
}

export async function dailySummary(env: Env): Promise<string> {
  const s = await getSettings(env)
  const y = todayIST(-1)
  const from = new Date(Date.parse(y + 'T00:00:00+05:30')).toISOString()
  const to = new Date(Date.parse(y + 'T00:00:00+05:30') + 86400_000).toISOString()
  const k = await first<{ enquiries: number; bookings: number; collected: number; waiting: number; failed: number; checkins: number }>(
    env,
    `SELECT (SELECT COUNT(*) FROM enquiries WHERE created_at >= ? AND created_at < ?) AS enquiries,
            (SELECT COUNT(*) FROM bookings WHERE status IN ('confirmed','checked_in','completed') AND created_at >= ? AND created_at < ?) AS bookings,
            (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'paid' AND updated_at >= ? AND updated_at < ?) AS collected,
            (SELECT COUNT(*) FROM enquiries WHERE waiting_on = 'us' AND status IN ('new','in_progress','quoted') AND COALESCE(last_guest_msg_at, created_at) < ?) AS waiting,
            (SELECT COUNT(*) FROM payments WHERE status = 'failed' AND created_at >= ? AND created_at < ?) AS failed,
            (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed' AND check_in = ?) AS checkins`,
    from, to, from, to, from, to, new Date(Date.now() - 3 * 3600_000).toISOString(), from, to, todayIST(),
  )
  // Numbers come from the database; AI only phrases them (and plain text is used if AI is off).
  const facts = `Yesterday: ${k?.enquiries ?? 0} enquiries, ${k?.bookings ?? 0} bookings, ${moneyShort(k?.collected ?? 0)} collected. ${k?.waiting ?? 0} enquiries waiting more than 3 hours. ${k?.failed ?? 0} failed payments. ${k?.checkins ?? 0} check-ins today.`
  const phrased = await aiText(env, 'daily_summary', {
    size: 'small',
    maxTokens: 120,
    system: 'Rewrite this business update as a short, friendly WhatsApp message for the owner (under 50 words). Keep every number exactly as given. Return only the message.',
    prompt: facts,
  })
  const numbers = facts.match(/\d+(?:\.\d+)?/g) ?? []
  const body = phrased && numbers.every((n) => phrased.includes(n)) ? phrased : facts
  await run(env, "INSERT INTO insights (kind, period, body, data) VALUES ('daily_summary', ?, ?, ?)", y, body, JSON.stringify(k ?? {}))
  if (s.owner_whatsapp) await enqueue(env, { type: 'whatsapp', to: s.owner_whatsapp, text: body })
  await notifyStaff(env, 'daily_summary', body)
  return body
}

export async function weekly(env: Env): Promise<void> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const period = `${fmtDate(todayIST(-7))} – ${fmtDate(todayIST(-1))}`

  // Lost-reason insights.
  const lost = await all<{ lost_reason: string | null; destination: string | null; budget: number | null; summary: string | null }>(env, "SELECT lost_reason, destination, budget, summary FROM enquiries WHERE status = 'lost' AND updated_at >= ?", since)
  if (lost.length) {
    const counts = new Map<string, number>()
    for (const l of lost) counts.set(`${l.lost_reason ?? 'Not given'}${l.destination ? ` (${l.destination})` : ''}`, (counts.get(`${l.lost_reason ?? 'Not given'}${l.destination ? ` (${l.destination})` : ''}`) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}: ${n}`).join('; ')
    const out = await aiText(env, 'lost_insights', {
      size: 'small',
      maxTokens: 90,
      system: 'Write ONE sentence (under 30 words) for a travel business owner about why enquiries were lost this week, like "Most lost enquiries this week: price too high for Munnar villas." Use only the data given.',
      prompt: `Lost enquiries (${lost.length}): ${top}\nNotes: ${lost.map((l) => l.summary).filter(Boolean).slice(0, 15).join(' | ')}`,
    })
    await run(env, "INSERT INTO insights (kind, period, body, data) VALUES ('lost_reasons', ?, ?, ?)", period, out ?? `Lost this week (${lost.length}): ${top}.`, JSON.stringify(Object.fromEntries(counts)))
  }

  // Review problem alerts, grouped per property (last 30 days).
  const props = await all<{ id: number; name: string }>(
    env,
    "SELECT p.id, p.name FROM properties p WHERE (SELECT COUNT(*) FROM reviews r WHERE r.property_id = p.id AND r.rating <= 3 AND r.created_at >= ?) >= 2",
    new Date(Date.now() - 30 * 86400_000).toISOString(),
  )
  for (const p of props) {
    const reviews = await all<{ rating: number; body: string }>(env, 'SELECT rating, body FROM reviews WHERE property_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 30', p.id, new Date(Date.now() - 30 * 86400_000).toISOString())
    const out = await aiText(env, 'review_insights', {
      size: 'small',
      maxTokens: 90,
      system: 'Find a problem mentioned by 2 or more guests in these reviews and write ONE sentence like "3 guests mentioned AC not working at Hill View Villa this month." If no problem repeats, reply exactly NONE.',
      prompt: `Property: ${p.name}\n${reviews.map((r) => `(${r.rating}/5) ${r.body}`).join('\n').slice(0, 5000)}`,
    })
    if (out && !out.includes('NONE')) await run(env, "INSERT INTO insights (kind, period, property_id, body) VALUES ('review_problems', ?, ?, ?)", period, p.id, out)
  }
}
