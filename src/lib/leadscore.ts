// Hot lead score: plain rules, no AI call. 0–100, higher = more likely to book.

import { DAY_MS } from './util'

export interface LeadSignals {
  quoteViews: number
  /** Minutes the guest took to reply to our last message (null = has not replied). */
  guestReplyMinutes: number | null
  /** Days from today until check-in (null = no dates yet). */
  daysToTravel: number | null
  hasDates: boolean
  hasBudget: boolean
  isReturningGuest: boolean
  status: string
  lastGuestActivityHoursAgo: number | null
}

export interface LeadScore {
  score: number
  label: 'Hot' | 'Warm' | 'Cold'
  reasons: string[]
}

export function leadScore(s: LeadSignals): LeadScore {
  if (s.status === 'booked' || s.status === 'lost' || s.status === 'closed') return { score: 0, label: 'Cold', reasons: [] }
  let score = 10
  const reasons: string[] = []

  if (s.quoteViews >= 3) { score += 25; reasons.push(`opened quote ${s.quoteViews}×`) }
  else if (s.quoteViews >= 1) { score += 12; reasons.push('opened quote') }

  if (s.guestReplyMinutes != null) {
    if (s.guestReplyMinutes <= 30) { score += 20; reasons.push('replies fast') }
    else if (s.guestReplyMinutes <= 240) { score += 12; reasons.push('replies same day') }
    else score += 4
  }

  if (s.daysToTravel != null) {
    if (s.daysToTravel < 0) score -= 30
    else if (s.daysToTravel <= 7) { score += 20; reasons.push('travelling within a week') }
    else if (s.daysToTravel <= 30) { score += 14; reasons.push('travelling this month') }
    else if (s.daysToTravel <= 90) score += 6
  }

  if (s.hasDates) score += 5
  if (s.hasBudget) score += 5
  if (s.isReturningGuest) { score += 10; reasons.push('returning guest') }
  if (s.status === 'quoted') score += 5

  if (s.lastGuestActivityHoursAgo != null) {
    if (s.lastGuestActivityHoursAgo <= 24) score += 5
    else if (s.lastGuestActivityHoursAgo > 24 * 7) { score -= 15; reasons.push('quiet for a week') }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, label: score >= 65 ? 'Hot' : score >= 40 ? 'Warm' : 'Cold', reasons }
}

export function signalsFromRow(
  r: {
    status: string
    check_in: string | null
    budget: number | null
    quote_views: number | null
    last_guest_msg_at: string | null
    last_staff_reply_at: string | null
    past_bookings: number | null
  },
  now = Date.now(),
): LeadSignals {
  let reply: number | null = null
  if (r.last_guest_msg_at && r.last_staff_reply_at && r.last_guest_msg_at > r.last_staff_reply_at) {
    reply = (Date.parse(r.last_guest_msg_at) - Date.parse(r.last_staff_reply_at)) / 60000
  }
  return {
    quoteViews: r.quote_views ?? 0,
    guestReplyMinutes: reply,
    daysToTravel: r.check_in ? Math.floor((Date.parse(r.check_in + 'T00:00:00Z') - now) / DAY_MS) : null,
    hasDates: !!r.check_in,
    hasBudget: !!r.budget,
    isReturningGuest: (r.past_bookings ?? 0) > 0,
    status: r.status,
    lastGuestActivityHoursAgo: r.last_guest_msg_at ? (now - Date.parse(r.last_guest_msg_at)) / 3600_000 : null,
  }
}
