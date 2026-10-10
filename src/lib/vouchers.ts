// Booking confirmation vouchers: staff request one after the guest pays an advance, an admin approves it, and the
// approved "Booking Confirmed" voucher is frozen as a snapshot (JSON) so later edits never change what was issued.

import type { Env } from '../env'
import { all, first } from './db'
import { contact as readContact } from './catalog'
import { roomNames, roomsLabel } from './quote-rooms'
import { FACILITIES, MEAL_PLANS } from './search'
import { fmtDate, money, parseJson } from './util'

export interface VoucherPayment { date: string; method: string; reference: string; amount: number }

export interface VoucherData {
  booking_code: string
  status: 'Confirmed'
  guest_name: string
  guest_phone: string
  adults: number
  children: number
  kids_ages: string
  resort_name: string
  resort_phone: string
  location: string
  map_url: string | null
  check_in: string
  check_out: string
  nights: number
  checkin_time: string
  checkout_time: string
  rooms: string
  meal_plan: string
  amenities: string[]
  payments: VoucherPayment[]
  total: number
  paid: number
  balance: number
  staff_remarks: string
  admin_remarks: string
}

export const PAYMENT_LABELS: Record<string, string> = { upi: 'UPI', bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card', other: 'Other', manual: 'Manual' }

/** Everything the voucher shows, read from the booking as it is now. */
export async function voucherData(env: Env, bookingId: number, extra: { kids_ages: string; staff_remarks: string; admin_remarks: string }): Promise<VoucherData | null> {
  const b = await first<{
    code: string; guest_name: string; guest_phone: string; adults: number; children: number; check_in: string; check_out: string; nights: number
    room_id: number; rooms_count: number; extra_rooms: string; meal_plan: string | null; total: number; amount_paid: number
    property_name: string; destination: string; address: string | null; map_url: string | null; lat: number | null; lng: number | null
    checkin_time: string; checkout_time: string; facilities: string; contact: string; owner_phone: string | null
  }>(
    env,
    `SELECT b.code, b.guest_name, b.guest_phone, b.adults, b.children, b.check_in, b.check_out, b.nights, b.room_id, b.rooms_count, b.extra_rooms, b.meal_plan,
       b.total, b.amount_paid, p.name AS property_name, p.destination, p.address, p.map_url, p.lat, p.lng, p.checkin_time, p.checkout_time, p.facilities,
       p.contact, p.owner_phone
     FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.id = ?`,
    bookingId,
  )
  if (!b) return null
  const payments = await all<{ amount: number; gateway: string; gateway_payment_id: string | null; updated_at: string }>(
    env, "SELECT amount, gateway, gateway_payment_id, updated_at FROM payments WHERE booking_id = ? AND status = 'paid' ORDER BY id", bookingId,
  )
  const con = readContact(b.contact)
  const phones = [con.phone, con.phone2, con.phone3].filter((x): x is string => !!x)
  const line = { room_id: b.room_id, rooms_count: b.rooms_count, extra_rooms: b.extra_rooms ?? '[]' }
  return {
    booking_code: b.code,
    status: 'Confirmed',
    guest_name: b.guest_name,
    guest_phone: b.guest_phone,
    adults: b.adults,
    children: b.children,
    kids_ages: extra.kids_ages,
    resort_name: b.property_name,
    resort_phone: (phones.length ? phones : [b.owner_phone].filter((x): x is string => !!x)).join(' / '),
    // Address, plus the destination when the address does not already name it.
    location: b.address && b.address.toLowerCase().includes(b.destination.toLowerCase()) ? b.address : [b.address, b.destination].filter(Boolean).join(', '),
    map_url: b.map_url || (b.lat != null && b.lng != null ? `https://maps.google.com/?q=${b.lat},${b.lng}` : null),
    check_in: b.check_in,
    check_out: b.check_out,
    nights: b.nights,
    checkin_time: b.checkin_time,
    checkout_time: b.checkout_time,
    rooms: roomsLabel(line, await roomNames(env, [line])),
    meal_plan: b.meal_plan ? MEAL_PLANS[b.meal_plan] ?? b.meal_plan : 'Room only',
    amenities: parseJson<string[]>(b.facilities, []).map((k) => FACILITIES[k] ?? k),
    payments: payments.map((p) => ({ date: p.updated_at.slice(0, 10), method: PAYMENT_LABELS[p.gateway] ?? p.gateway, reference: p.gateway_payment_id ?? '', amount: p.amount })),
    total: b.total,
    paid: b.amount_paid,
    balance: Math.max(0, b.total - b.amount_paid),
    staff_remarks: extra.staff_remarks,
    admin_remarks: extra.admin_remarks,
  }
}

const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
const time12 = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return t
  const h = Number(m[1])
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** The printable voucher page. `draft` adds a clear "not yet approved" banner for previews. */
export function voucherHtml(v: VoucherData, meta: { code: string; issued: string | null; draft?: string }): string {
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`
  const amenities = v.amenities.length
    ? `<ul class="v-amenities">${v.amenities.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '<p class="v-muted">Not listed</p>'
  const payments = v.payments.length
    ? `<table class="v-pay"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead><tbody>${v.payments.map((p) => `<tr><td>${esc(fmtDate(p.date))}</td><td>${esc(p.method)}</td><td>${esc(p.reference || '—')}</td><td class="r">${money(p.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="v-muted">No payment recorded</p>'
  const remarks = [v.staff_remarks, v.admin_remarks].map((x) => x.trim()).filter(Boolean)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking Confirmed ${esc(v.booking_code)}</title><style>
:root{--navy:#14213d;--teal:#0f5e57;--ok:#1d7a46;--line:#dfe5e3;--soft:#e6f2ef;--muted:#5d6b69}
*{box-sizing:border-box}
body{font:12px/1.5 Arial,"Helvetica Neue",sans-serif;max-width:760px;margin:24px auto;padding:0 20px;color:var(--navy);background:#fff;overflow-wrap:anywhere}
h1{font-size:22px;line-height:1.2;margin:0;font-weight:700}
h2{font-size:13px;letter-spacing:.4px;color:var(--teal);margin:16px 0 6px;text-transform:uppercase}
p{margin:6px 0}
a{color:var(--teal)}
.v-brand{display:flex;justify-content:space-between;gap:24px;align-items:center;border-bottom:2px solid var(--navy);padding:0 0 14px;margin-bottom:14px}
.v-brand img{width:181px;height:48px;object-fit:contain;flex:none}
.v-brand>div{text-align:right}
.v-brand p{margin:3px 0 0;font-size:11px;color:var(--teal);letter-spacing:.8px}
.v-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;border:1px solid #bfe0cc;border-left:4px solid var(--ok);background:#effaf3;padding:12px 14px;margin:12px 0}
.v-hero h1{color:var(--ok);font-size:24px}
.v-hero p{margin:2px 0 0;color:var(--muted);font-size:11px}
.v-badge{display:inline-block;border-radius:999px;background:var(--ok);color:#fff;font-weight:700;padding:5px 14px;font-size:12px;white-space:nowrap}
.v-draft{border:1px solid #f0c36d;background:#fff8e6;color:#7a4b00;padding:8px 12px;margin:0 0 12px;font-weight:700}
.v-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 24px}
table{width:100%;border-collapse:collapse;font-size:12px}
.v-table th,.v-table td{padding:6px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.v-table th{width:42%;font-weight:600;color:var(--muted)}
.v-pay th,.v-pay td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}
.v-pay thead th{background:#f8fafb;color:var(--muted);font-weight:600}
.r,.v-pay .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.v-amenities{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 16px}
.v-amenities li{padding:3px 0;border-bottom:1px solid #edf0f2}
.v-totals{margin-top:10px}
.v-totals td{padding:7px 10px;border-bottom:1px solid var(--line)}
.v-totals .t td{font-weight:700;background:var(--soft);border-top:1px solid #c4dcd6;font-size:14px}
.v-note{font-size:11px;color:var(--muted);margin-top:4px}
.v-muted{color:var(--muted)}
.v-remarks{border:1px solid var(--line);background:#f8fafb;padding:8px 12px;white-space:pre-line}
.v-footer{border-top:2px solid var(--navy);margin-top:20px;padding-top:10px;text-align:center}
.v-footer strong{font-size:16px;letter-spacing:.5px}
.v-footer p{margin:2px 0;color:var(--muted);font-size:10px}
[data-quote-actions]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
[data-quote-actions] button{min-height:44px;padding:10px 16px;cursor:pointer;border:1px solid var(--navy);border-radius:6px;font:600 14px Arial}
[data-download-quote]{background:var(--navy);color:#fff}
[data-quote-actions] [data-print]{background:#fff;color:var(--navy)}
@media(max-width:560px){body{padding:0 16px;margin:16px auto}.v-grid{grid-template-columns:1fr}.v-brand img{width:130px;height:auto}.v-amenities{grid-template-columns:repeat(2,minmax(0,1fr))}.v-hero{flex-direction:column;align-items:flex-start}}
@media print{body{margin:0;max-width:none;padding:0}[data-quote-actions]{display:none}tr,li,.v-hero,.v-brand,.v-totals,.v-remarks{break-inside:avoid}h2{break-after:avoid}}
@page{size:A4;margin:12mm}
</style></head><body><div data-quote-actions><button type="button" data-download-quote data-quote-code="${esc(v.booking_code)}" data-file-prefix="Booking-Confirmed">⬇ Download PDF</button><button type="button" data-print>Print</button><span data-pdf-status role="status" aria-live="polite"></span></div><script src="/vendor/html2pdf-0.14.0.bundle.min.js" defer></script><script src="/quotation-download.js" defer></script><script src="/app.js" defer></script><main data-quote-export>
${meta.draft ? `<div class="v-draft">${esc(meta.draft)}</div>` : ''}<header class="v-brand"><img src="/brand/logo-wide.webp" alt="Go Sanchari" width="181" height="48"><div><strong>Go Sanchari</strong><br><a href="mailto:reservation@gosanchari.com">reservation@gosanchari.com</a><p>Booking confirmation voucher</p></div></header>
<section class="v-hero"><div><h1>Booking Confirmed</h1><p>Voucher ${esc(meta.code)} · Booking ${esc(v.booking_code)}${meta.issued ? ` · Issued ${esc(fmtDate(meta.issued))}` : ''}</p></div><span class="v-badge">${meta.draft ? 'Awaiting admin approval' : `Booking Status: ${esc(v.status)}`}</span></section>
<div class="v-grid"><div><h2>Guest</h2><table class="v-table">
${row('Guest Name', esc(v.guest_name))}${row('Guest Contact Number', esc(v.guest_phone))}${row('No. of Adults', String(v.adults))}${row('No. of Kids', String(v.children))}${row('Kids Age', esc(v.kids_ages || (v.children ? '—' : 'No kids')))}
</table></div><div><h2>Resort</h2><table class="v-table">
${row('Resort Name', esc(v.resort_name))}${row('Resort Contact Number', esc(v.resort_phone || '—'))}${row('Location', `${esc(v.location || '—')}${v.map_url ? `<br><a href="${esc(v.map_url)}">Open in Google Maps</a>` : ''}`)}
</table></div></div>
<h2>Stay</h2><table class="v-table">
${row('Check-in Date', `${esc(fmtDate(v.check_in))} · from ${esc(time12(v.checkin_time))}`)}${row('Check-out Date', `${esc(fmtDate(v.check_out))} · by ${esc(time12(v.checkout_time))}`)}${row('Nights', String(v.nights))}${row('Room Type / Category', esc(v.rooms))}${row('Meal Plan', esc(v.meal_plan))}
</table>
<h2>Amenities in Resort</h2>${amenities}
<h2>Payment Details</h2>${payments}
<table class="v-totals"><tr><td>Total Room Rent</td><td class="r">${money(v.total)}</td></tr><tr><td>Advance Paid</td><td class="r">${money(v.paid)}</td></tr><tr class="t"><td>Balance Amount</td><td class="r">${money(v.balance)}</td></tr></table>
<p class="v-note">${v.balance > 0 ? 'The balance amount is to be paid at the resort at the time of check-in.' : 'Fully paid — nothing is due at check-in.'}</p>
${remarks.length ? `<h2>Remarks</h2><div class="v-remarks">${remarks.map(esc).join('\n\n')}</div>` : ''}
<footer class="v-footer"><strong>Go Sanchari</strong><p>Travel more, worry less · reservation@gosanchari.com</p></footer></main></body></html>`
}
