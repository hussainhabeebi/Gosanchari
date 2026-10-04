// Booking lifecycle: create (with hold), pay, confirm, cancel, refund, invoice, calendar file.
// All amounts here are rule-based and exact.

import type { Env } from '../env'
import { all, enqueue, first, insertId, loadPricing, logActivity, notifyStaff, roomAvailability, run } from './db'
import { fillTemplate, sendEmail } from './integrations'
import { calculatePrice, type Coupon, type PriceResult } from './pricing'
import { getSettings } from './settings'
import type { BookingRow, PropertyRow } from './types'
import { eachNight, fmtDate, money, nowIso, refCode, todayIST } from './util'

export interface NewBooking {
  roomId: number
  checkIn: string
  checkOut: string
  adults: number
  children: number
  roomsCount: number
  couponCode?: string | null
  guestName: string
  guestPhone: string
  guestEmail?: string | null
  idType?: string | null
  specialRequests?: string
  userId: number | null
  source?: string
  mealPlan?: string | null
  quotationId?: number | null
  enquiryId?: number | null
  staffId?: number | null
  /** For quotes: the exact price already agreed (built by the same rules). */
  fixedPrice?: { subtotal: number; discount: number; extraCharges: number; taxes: number; total: number }
}

export async function findCoupon(env: Env, code: string | null | undefined): Promise<Coupon | null> {
  if (!code) return null
  return first<Coupon>(env, 'SELECT * FROM coupons WHERE code = ? COLLATE NOCASE', code.trim().toUpperCase())
}

export async function priceStay(env: Env, roomId: number, checkIn: string, checkOut: string, roomsCount: number, couponCode?: string | null): Promise<PriceResult> {
  const pr = await loadPricing(env, roomId)
  if (!pr) return { nights: 0, roomsCount, lines: [], subtotal: 0, discount: 0, discountLabel: null, extraCharges: 0, taxable: 0, taxRate: 0, taxes: 0, total: 0, minNights: 1, errors: ['Room not found'] }
  const s = await getSettings(env)
  const coupon = await findCoupon(env, couponCode)
  if (couponCode && !coupon) return { ...calculatePrice({ room: pr.room, seasons: pr.seasons, checkIn, checkOut, roomsCount, taxSlabs: s.tax_slabs }), errors: ['Coupon code not found.'] }
  return calculatePrice({ room: pr.room, seasons: pr.seasons, checkIn, checkOut, roomsCount, taxSlabs: s.tax_slabs, coupon, today: todayIST() })
}

export async function createBooking(env: Env, b: NewBooking): Promise<{ id: number; code: string } | { error: string }> {
  const pr = await loadPricing(env, b.roomId)
  if (!pr) return { error: 'Room not found.' }
  if (b.adults + b.children > pr.room.capacity * b.roomsCount) return { error: `This room sleeps ${pr.room.capacity}; please add rooms for your group.` }
  if (b.checkIn < todayIST()) return { error: 'Check-in date is in the past.' }

  const avail = await roomAvailability(env, [pr.room.property_id], b.checkIn, b.checkOut, b.quotationId ?? undefined)
  if ((avail.get(b.roomId)?.free ?? 0) < b.roomsCount) return { error: 'Sorry, this room is no longer available for those dates.' }

  let price: { subtotal: number; discount: number; extraCharges: number; taxes: number; total: number; nights: number }
  if (b.fixedPrice) {
    price = { ...b.fixedPrice, nights: Math.round((Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 86400000) }
  } else {
    const p = await priceStay(env, b.roomId, b.checkIn, b.checkOut, b.roomsCount, b.couponCode)
    if (p.errors.length) return { error: p.errors[0] }
    price = p
  }

  const s = await getSettings(env)
  const code = refCode('BK')
  const hold = new Date(Date.now() + s.booking.hold_minutes * 60_000).toISOString()
  const id = await insertId(
    env,
    `INSERT INTO bookings (code, user_id, property_id, room_id, check_in, check_out, nights, adults, children, rooms_count, meal_plan,
      subtotal, discount, extra_charges, taxes, total, coupon_code, status, payment_status, source, guest_name, guest_phone, guest_email,
      id_type, special_requests, quotation_id, enquiry_id, staff_id, hold_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, b.userId, pr.room.property_id, b.roomId, b.checkIn, b.checkOut, price.nights, b.adults, b.children, b.roomsCount, b.mealPlan ?? null,
    price.subtotal, price.discount, price.extraCharges, price.taxes, price.total, b.couponCode?.toUpperCase() ?? null,
    b.source ?? 'website', b.guestName, b.guestPhone, b.guestEmail ?? null, b.idType ?? null, b.specialRequests ?? '',
    b.quotationId ?? null, b.enquiryId ?? null, b.staffId ?? null, hold,
  )
  // Re-check after insert: if two guests raced for the last room, the later one loses.
  if (await oversold(env, id)) {
    await run(env, "UPDATE bookings SET status = 'cancelled', cancelled_at = ?, internal_notes = 'Auto-cancelled: overbooked during checkout' WHERE id = ?", nowIso(), id)
    return { error: 'Sorry, someone just booked the last room for those dates.' }
  }
  await logActivity(env, b.userId, 'booking.created', 'booking', id, { code, total: price.total })
  return { id, code }
}

/** Per-night check counting only bookings created up to this one, so the earlier booker keeps the room. */
async function oversold(env: Env, bookingId: number): Promise<boolean> {
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', bookingId)
  if (!b) return false
  const room = await first<{ units: number }>(env, 'SELECT units FROM rooms WHERE id = ?', b.room_id)
  const others = await all<{ check_in: string; check_out: string; rooms_count: number }>(
    env,
    `SELECT check_in, check_out, rooms_count FROM bookings WHERE room_id = ? AND check_in < ? AND check_out > ? AND id <= ?
       AND (status IN ('confirmed','checked_in') OR (status = 'pending' AND hold_expires_at > ?))`,
    b.room_id, b.check_out, b.check_in, bookingId, nowIso(),
  )
  const blocks = await all<{ date: string }>(env, 'SELECT date FROM blocked_dates WHERE (room_id = ? OR (room_id IS NULL AND property_id = ?)) AND date >= ? AND date < ? AND (hold_until IS NULL OR hold_until > ?) AND (quotation_id IS NULL OR quotation_id != ?)', b.room_id, b.property_id, b.check_in, b.check_out, nowIso(), b.quotation_id ?? -1)
  for (const n of eachNight(b.check_in, b.check_out)) {
    const used = others.filter((o) => o.check_in <= n && n < o.check_out).reduce((a, o) => a + o.rooms_count, 0) + blocks.filter((x) => x.date === n).length
    if (used > (room?.units ?? 0)) return true
  }
  return false
}

/** Staff confirm a booking once the guest has agreed. Payment is collected offline and recorded separately. */
export async function confirmBooking(env: Env, bookingId: number, byUserId: number): Promise<void> {
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', bookingId)
  if (!b || b.status !== 'pending') return
  await run(env, "UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = ? WHERE id = ?", nowIso(), b.id)
  await onConfirmed(env, b.id)
  await logActivity(env, byUserId, 'booking.confirmed_by_staff', 'booking', b.id)
}

export const PAYMENT_METHODS = ['upi', 'bank_transfer', 'cash', 'card', 'other'] as const

/** Record a payment collected offline (UPI, bank transfer, cash…). Confirms a pending booking. */
export async function recordPayment(env: Env, bookingId: number, amount: number, method: string, reference: string, byUserId: number): Promise<{ ok: true } | { error: string }> {
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', bookingId)
  if (!b) return { error: 'Booking not found.' }
  if (b.status === 'cancelled') return { error: 'This booking is cancelled.' }
  const due = b.total - b.amount_paid
  if (!(amount > 0) || amount > due) return { error: `Enter an amount between ₹1 and ${money(due)}.` }
  const gateway = (PAYMENT_METHODS as readonly string[]).includes(method) ? method : 'other'
  await run(env, "INSERT INTO payments (booking_id, amount, status, gateway, gateway_payment_id) VALUES (?, ?, 'paid', ?, ?)", b.id, Math.round(amount), gateway, reference.slice(0, 80) || null)
  const paid = b.amount_paid + Math.round(amount)
  await run(
    env,
    `UPDATE bookings SET amount_paid = ?, payment_status = ?, status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END, hold_expires_at = NULL, updated_at = ? WHERE id = ?`,
    paid, paid >= b.total ? 'paid' : 'partial', nowIso(), b.id,
  )
  if (b.status === 'pending') await onConfirmed(env, b.id)
  await logActivity(env, byUserId, 'payment.recorded', 'booking', b.id, { amount, method: gateway, reference })
  return { ok: true }
}

async function onConfirmed(env: Env, bookingId: number) {
  const b = await first<BookingRow & { property_name: string; is_partner: number; commission_pct: number }>(
    env,
    'SELECT b.*, p.name AS property_name, p.is_partner, p.commission_pct FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ?',
    bookingId,
  )
  if (!b) return
  const s = await getSettings(env)
  if (b.coupon_code) await run(env, 'UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', b.coupon_code)
  if (b.quotation_id) {
    await run(env, "UPDATE quotations SET status = 'accepted', updated_at = ? WHERE id = ?", nowIso(), b.quotation_id)
    await run(env, "UPDATE tasks SET status = 'done' WHERE status = 'open' AND (quotation_id = ? OR (enquiry_id = ? AND quotation_id IS NOT NULL))", b.quotation_id, b.enquiry_id ?? -1)
  }
  if (b.enquiry_id) await run(env, "UPDATE enquiries SET status = 'booked', updated_at = ? WHERE id = ?", nowIso(), b.enquiry_id)
  await run(env, 'DELETE FROM blocked_dates WHERE quotation_id = ?', b.quotation_id ?? -1)
  if (b.is_partner) {
    const net = Math.round(b.total - b.taxes - ((b.total - b.taxes) * b.commission_pct) / 100)
    await run(env, 'INSERT INTO payouts (property_id, booking_id, amount) VALUES (?, ?, ?)', b.property_id, b.id, net)
  }
  const text = fillTemplate(s.whatsapp_templates.confirmation, {
    name: b.guest_name, code: b.code, property: b.property_name, dates: `${fmtDate(b.check_in)} – ${fmtDate(b.check_out)}`, amount: money(b.amount_paid || b.total),
  })
  await enqueue(env, { type: 'whatsapp', to: b.guest_phone, text })
  if (b.guest_email) {
    await sendEmail(env, b.guest_email, `Booking confirmed – ${b.code}`, `<p>${text}</p><p><a href="${env.SITE_URL}/my/bookings/${b.id}">View your booking</a> · <a href="${env.SITE_URL}/invoice/${b.code}">Invoice</a></p>`)
  }
  await notifyStaff(env, 'booking', `New booking ${b.code}: ${b.guest_name}, ${b.property_name}, ${fmtDate(b.check_in)}, ${money(b.total)}`)
  await logActivity(env, b.user_id, 'booking.confirmed', 'booking', b.id, { code: b.code, paid: b.amount_paid })
}

export async function cancelBooking(env: Env, bookingId: number, byUserId: number, reason: string, refundAmount: number | null): Promise<{ ok: true } | { error: string }> {
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', bookingId)
  if (!b) return { error: 'Booking not found' }
  if (b.status === 'cancelled') return { error: 'Already cancelled' }
  await run(env, "UPDATE bookings SET status = 'cancelled', cancelled_at = ?, change_status = NULL, updated_at = ? WHERE id = ?", nowIso(), nowIso(), b.id)
  await run(env, "DELETE FROM payouts WHERE booking_id = ? AND status = 'pending'", b.id)
  if (refundAmount && refundAmount > 0 && b.amount_paid > 0) {
    const pay = await first<{ id: number }>(env, "SELECT id FROM payments WHERE booking_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 1", b.id)
    await run(env, "INSERT INTO refunds (booking_id, payment_id, amount, reason, status, requested_by) VALUES (?, ?, ?, ?, 'requested', ?)", b.id, pay?.id ?? null, Math.min(refundAmount, b.amount_paid), reason, byUserId)
    await notifyStaff(env, 'refund_request', `Refund requested for ${b.code}: ${money(refundAmount)}`)
  }
  await logActivity(env, byUserId, 'booking.cancelled', 'booking', b.id, { code: b.code, reason, refundAmount })
  return { ok: true }
}

export async function processRefund(env: Env, refundId: number, adminId: number, approve: boolean, reference?: string): Promise<{ ok: true } | { error: string }> {
  const r = await first<{ id: number; booking_id: number; payment_id: number | null; amount: number; status: string }>(env, 'SELECT * FROM refunds WHERE id = ?', refundId)
  if (!r || r.status !== 'requested') return { error: 'Refund is not waiting for a decision' }
  if (!approve) {
    await run(env, "UPDATE refunds SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", adminId, nowIso(), r.id)
    await logActivity(env, adminId, 'refund.rejected', 'refund', r.id, { amount: r.amount })
    return { ok: true }
  }
  // Refunds are paid back offline (UPI / bank transfer); the reference is recorded here.
  const gatewayId = reference?.trim().slice(0, 80) || 'manual'
  await run(env, "UPDATE refunds SET status = 'processed', gateway_refund_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", gatewayId, adminId, nowIso(), r.id)
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', r.booking_id)
  if (b) {
    const refunded = await first<{ n: number }>(env, "SELECT COALESCE(SUM(amount),0) AS n FROM refunds WHERE booking_id = ? AND status = 'processed'", b.id)
    await run(env, 'UPDATE bookings SET payment_status = ? WHERE id = ?', (refunded?.n ?? 0) >= b.amount_paid ? 'refunded' : 'partially_refunded', b.id)
    if (r.payment_id && (refunded?.n ?? 0) >= b.amount_paid) await run(env, "UPDATE payments SET status = 'refunded' WHERE id = ?", r.payment_id)
  }
  await logActivity(env, adminId, 'refund.approved', 'refund', r.id, { amount: r.amount, gatewayId })
  return { ok: true }
}

/** Expire unpaid holds (called by cron and lazily). */
export async function expireHolds(env: Env) {
  await run(env, "UPDATE bookings SET status = 'cancelled', cancelled_at = ?, internal_notes = internal_notes || ' [Payment not completed in time]' WHERE status = 'pending' AND hold_expires_at < ?", nowIso(), nowIso())
  await run(env, 'DELETE FROM blocked_dates WHERE hold_until IS NOT NULL AND hold_until < ?', nowIso())
}

// ---- Invoice (printable HTML, also stored in R2) and calendar file ----

export async function invoiceHtml(env: Env, b: BookingRow, p: PropertyRow): Promise<string> {
  const s = await getSettings(env)
  const room = await first<{ name: string }>(env, 'SELECT name FROM rooms WHERE id = ?', b.room_id)
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const taxRate = b.total - b.taxes > 0 ? Math.round((b.taxes / (b.total - b.taxes)) * 100) : 0
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(b.code)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#1d2b2a;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}.r{text-align:right}.muted{color:#667}.tot td{font-weight:700;border-top:2px solid #1d2b2a}@media print{.noprint{display:none}}</style></head>
<body><button class="noprint" data-print>Print / Save as PDF</button><script src="/app.js" defer></script>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:12px"><div style="display:flex;gap:12px;align-items:center"><img src="/brand/logo-wide.webp" alt="" width="181" height="48"><div><h1>${esc(s.business.legal_name)}</h1><div class="muted">${esc(s.business.address)}<br>${esc(s.business.phone)} · ${esc(s.business.email)}${s.business.gstin ? `<br>GSTIN: ${esc(s.business.gstin)}` : ''}</div></div></div>
<div class="r"><strong>TAX INVOICE</strong><br>${esc(s.business.invoice_prefix)}-${esc(b.code.replace('GS-BK-', ''))}<br>${esc(fmtDate(b.created_at))}</div></div>
<p><strong>Billed to:</strong> ${esc(b.guest_name)}<br>${esc(b.guest_phone)}${b.guest_email ? ' · ' + esc(b.guest_email) : ''}</p>
<p><strong>Stay:</strong> ${esc(p.name)}, ${esc(p.destination)} — ${esc(room?.name)} × ${b.rooms_count}<br>${esc(fmtDate(b.check_in))} to ${esc(fmtDate(b.check_out))} (${b.nights} night${b.nights > 1 ? 's' : ''}), ${b.adults} adults${b.children ? `, ${b.children} children` : ''}<br>Booking ID: ${esc(b.code)}</p>
<table><tr><th>Description</th><th class="r">Amount</th></tr>
<tr><td>Accommodation (SAC 996311)</td><td class="r">${money(b.subtotal)}</td></tr>
${b.discount ? `<tr><td>Discount${b.coupon_code ? ` (${esc(b.coupon_code)})` : ''}</td><td class="r">− ${money(b.discount)}</td></tr>` : ''}
${b.extra_charges ? `<tr><td>Extra charges</td><td class="r">${money(b.extra_charges)}</td></tr>` : ''}
<tr><td>GST @ ${taxRate}%</td><td class="r">${money(b.taxes)}</td></tr>
<tr class="tot"><td>Total</td><td class="r">${money(b.total)}</td></tr>
<tr><td>Paid</td><td class="r">${money(b.amount_paid)}</td></tr>
${b.total - b.amount_paid > 0 ? `<tr><td>Balance due</td><td class="r">${money(b.total - b.amount_paid)}</td></tr>` : ''}
</table><p class="muted">Payment status: ${esc(b.payment_status)}. This is a computer-generated invoice.</p></body></html>`
}

export async function storeInvoice(env: Env, bookingId: number): Promise<string | null> {
  const b = await first<BookingRow>(env, 'SELECT * FROM bookings WHERE id = ?', bookingId)
  if (!b) return null
  const p = await first<PropertyRow>(env, 'SELECT * FROM properties WHERE id = ?', b.property_id)
  if (!p) return null
  const key = `invoices/${b.code}.html`
  await env.MEDIA.put(key, await invoiceHtml(env, b, p), { httpMetadata: { contentType: 'text/html; charset=utf-8' } })
  await run(env, 'UPDATE bookings SET invoice_key = ? WHERE id = ?', key, b.id)
  return key
}

export function icsFor(b: BookingRow, p: PropertyRow, siteUrl: string): string {
  const d = (x: string) => x.replace(/-/g, '')
  const esc = (s: string) => s.replace(/[,;\\]/g, (c) => '\\' + c).replace(/\n/g, '\\n')
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Go Sanchari//Booking//EN', 'BEGIN:VEVENT',
    `UID:${b.code}@gosanchari`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d(b.check_in)}`, `DTEND;VALUE=DATE:${d(b.check_out)}`,
    `SUMMARY:${esc(`Stay at ${p.name}`)}`,
    `LOCATION:${esc(`${p.address ?? ''} ${p.destination}`.trim())}`,
    `DESCRIPTION:${esc(`Booking ${b.code}. Check-in from ${p.checkin_time}. ${siteUrl}/my/bookings/${b.id}`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
}

export async function pendingRefundTotal(env: Env): Promise<number> {
  const r = await all<{ n: number }>(env, "SELECT COALESCE(SUM(amount),0) AS n FROM refunds WHERE status = 'requested'")
  return r[0]?.n ?? 0
}
