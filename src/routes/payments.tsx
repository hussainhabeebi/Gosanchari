// Payment (Razorpay or local simulator), confirmation page (6), invoice and calendar downloads.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty } from '../views/components'
import { first, logActivity } from '../lib/db'
import { amountDue, icsFor, invoiceHtml, markPaid, markPaymentFailed, startPayment, storeInvoice, expireHolds } from '../lib/bookings'
import { paymentSimulatorAllowed, paymentsLive, verifyRazorpayPayment, verifyRazorpayWebhook } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import type { BookingRow, PropertyRow } from '../lib/types'
import { fmtDate, money, timingSafeEqual } from '../lib/util'
import { form, redirectMsg } from './helpers'
import { isStaff } from '../lib/permissions'

export const paymentRoutes = new Hono<AppEnv>()

/** Owner, staff, or someone holding the quote link token may open a booking's payment page. */
async function canAccess(c: Context<AppEnv>, b: BookingRow): Promise<boolean> {
  const u = c.get('user')
  if (u && (u.id === b.user_id || isStaff(u.role))) return true
  const t = c.req.query('t')
  if (t && b.quotation_id) {
    const q = await first<{ token: string }>(c.env, 'SELECT token FROM quotations WHERE id = ?', b.quotation_id)
    return !!q && timingSafeEqual(q.token, t)
  }
  return false
}

paymentRoutes.get('/pay/:code', async (c) => {
  await expireHolds(c.env)
  const b = await first<BookingRow & { property_name: string }>(c.env, 'SELECT b.*, p.name AS property_name FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.code = ?', c.req.param('code'))
  if (!b || !(await canAccess(c, b))) return page(c, { title: 'Not found', noindex: true }, <div class="wrap section"><Empty>Booking not found.</Empty></div>, 404)
  if (b.status === 'cancelled') return page(c, { title: 'Booking expired', noindex: true }, <div class="wrap narrow section center"><h1>This booking has expired</h1><p>The room hold ran out before payment finished. <a href="/search">Search again</a> or <a href="/enquiry">ask our team</a>.</p></div>)
  const due = await amountDue(c.env, b)
  if (due <= 0) return c.redirect(`/booking/${b.code}/confirmed${c.req.query('t') ? `?t=${c.req.query('t')}` : ''}`)
  const order = await startPayment(c.env, b)
  if ('error' in order) return page(c, { title: 'Payment', noindex: true }, <div class="wrap narrow section"><div class="flash flash-err">{order.error}</div></div>)
  const s = await getSettings(c.env)
  const t = c.req.query('t') ?? ''
  const live = paymentsLive(c.env)
  return page(c, { title: 'Payment', noindex: true, head: live ? <script src="https://checkout.razorpay.com/v1/checkout.js" defer></script> : undefined }, (
    <div class="wrap narrow section center">
      <h1>Complete your payment</h1>
      <p>{b.property_name} · {fmtDate(b.check_in)} → {fmtDate(b.check_out)}</p>
      <p class="price big">{money(order.amount)}</p>
      {order.amount < b.total && <p class="muted">Advance now; balance {money(b.total - b.amount_paid - order.amount)} later.</p>}
      {live ? (
        <>
          <button class="btn btn-lg" id="rzp-pay"
            data-key={c.env.RAZORPAY_KEY_ID} data-order={order.orderId} data-amount={order.amount * 100} data-name={s.business.name}
            data-desc={`Booking ${b.code}`} data-prefill-name={b.guest_name} data-prefill-phone={b.guest_phone} data-prefill-email={b.guest_email ?? ''}
            data-verify={`/pay/${b.code}/verify?t=${encodeURIComponent(t)}`}>Pay {money(order.amount)}</button>
          <form id="rzp-form" method="post" action={`/pay/${b.code}/verify?t=${encodeURIComponent(t)}`} hidden>
            <input name="razorpay_order_id" /><input name="razorpay_payment_id" /><input name="razorpay_signature" />
          </form>
        </>
      ) : paymentSimulatorAllowed(c.env) ? (
        <form method="post" action={`/pay/${b.code}/simulate?t=${encodeURIComponent(t)}`} class="stack">
          <input type="hidden" name="order" value={order.orderId} />
          <p class="flash">Test mode: payment gateway keys are not set. Use the simulator.</p>
          <button class="btn btn-lg" name="result" value="success">Simulate successful payment</button>
          <button class="btn btn-outline" name="result" value="fail">Simulate failed payment</button>
        </form>
      ) : (
        <p class="flash flash-err">Online payment is not available right now. Please contact us on WhatsApp.</p>
      )}
      <p class="muted small">Room held until {b.hold_expires_at ? new Date(b.hold_expires_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'}.</p>
    </div>
  ))
})

paymentRoutes.post('/pay/:code/verify', async (c) => {
  const f = await form(c)
  const code = c.req.param('code')
  const t = c.req.query('t')
  const q = t ? `?t=${encodeURIComponent(t)}` : ''
  if (!(await verifyRazorpayPayment(c.env, f.razorpay_order_id, f.razorpay_payment_id, f.razorpay_signature))) {
    await markPaymentFailed(c.env, f.razorpay_order_id, 'Signature check failed')
    return redirectMsg(c, `/pay/${code}${q}`, { err: 'We could not verify the payment. If money was deducted it will be confirmed automatically or refunded.' })
  }
  const b = await markPaid(c.env, f.razorpay_order_id, f.razorpay_payment_id)
  if (!b || b.code !== code) return redirectMsg(c, `/pay/${code}${q}`, { err: 'Payment not matched to this booking.' })
  return c.redirect(`/booking/${code}/confirmed${q}`, 303)
})

paymentRoutes.post('/pay/:code/simulate', async (c) => {
  if (!paymentSimulatorAllowed(c.env)) return c.text('Not available', 403)
  const f = await form(c)
  const code = c.req.param('code')
  const t = c.req.query('t')
  const q = t ? `?t=${encodeURIComponent(t)}` : ''
  const pay = await first<{ booking_id: number }>(c.env, 'SELECT booking_id FROM payments WHERE gateway_order_id = ?', f.order)
  const b = pay ? await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE id = ?', pay.booking_id) : null
  if (!b || b.code !== code || !(await canAccess(c, b))) return c.text('Not found', 404)
  if (f.result !== 'success') {
    await markPaymentFailed(c.env, f.order, 'Simulated failure')
    return redirectMsg(c, `/pay/${code}${q}`, { err: 'Payment failed. Please try again.' })
  }
  await markPaid(c.env, f.order, `sim_pay_${crypto.randomUUID().slice(0, 10)}`)
  return c.redirect(`/booking/${code}/confirmed${q}`, 303)
})

// Razorpay webhook: confirms payments even if the guest closes the browser.
paymentRoutes.post('/webhooks/razorpay', async (c) => {
  const body = await c.req.text()
  if (!(await verifyRazorpayWebhook(c.env, body, c.req.header('x-razorpay-signature')))) return c.text('bad signature', 401)
  const ev = JSON.parse(body) as { event: string; payload: { payment?: { entity: { id: string; order_id: string; error_description?: string } } } }
  const p = ev.payload.payment?.entity
  if (p && (ev.event === 'payment.captured' || ev.event === 'order.paid')) await markPaid(c.env, p.order_id, p.id)
  if (p && ev.event === 'payment.failed') await markPaymentFailed(c.env, p.order_id, p.error_description ?? 'Payment failed')
  return c.text('ok')
})

// ---------- 6. Booking confirmation ----------
paymentRoutes.get('/booking/:code/confirmed', async (c) => {
  const b = await first<BookingRow & { property_name: string; destination: string; checkin_time: string }>(
    c.env,
    'SELECT b.*, p.name AS property_name, p.destination, p.checkin_time FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.code = ?',
    c.req.param('code'),
  )
  if (!b || !(await canAccess(c, b))) return c.notFound()
  if (!b.invoice_key && b.amount_paid > 0) await storeInvoice(c.env, b.id)
  const t = c.req.query('t')
  const q = t ? `?t=${encodeURIComponent(t)}` : ''
  return page(c, { title: 'Booking confirmed', noindex: true }, (
    <div class="wrap narrow section">
      <div class="center">
        <div class="big-check">✓</div>
        <h1>{b.status === 'confirmed' ? 'Your booking is confirmed!' : 'Booking received'}</h1>
        <p>Booking ID <strong class="code">{b.code}</strong></p>
      </div>
      <div class="card">
        <table class="breakdown">
          <tr><td>Property</td><td>{b.property_name}, {b.destination}</td></tr>
          <tr><td>Dates</td><td>{fmtDate(b.check_in)} → {fmtDate(b.check_out)} ({b.nights} nights)</td></tr>
          <tr><td>Guests</td><td>{b.adults} adults{b.children ? `, ${b.children} children` : ''}</td></tr>
          <tr><td>Amount paid</td><td>{money(b.amount_paid)}{b.amount_paid < b.total ? ` of ${money(b.total)}` : ''}</td></tr>
        </table>
        <div class="row wrap-row">
          <a class="btn btn-outline" href={`/invoice/${b.code}${q}`} target="_blank">Download invoice</a>
          <a class="btn btn-outline" href={`/booking/${b.code}/calendar.ics${q}`}>Add to calendar</a>
        </div>
      </div>
      <div class="card">
        <h3>What happens next</h3>
        <ol>
          <li>A confirmation has been sent to your WhatsApp{b.guest_email ? ' and email' : ''}.</li>
          <li>One day before check-in, we'll send check-in details, directions and the property contact on WhatsApp.</li>
          <li>Check-in from {b.checkin_time} on {fmtDate(b.check_in)}. Please carry a photo ID.</li>
        </ol>
      </div>
      <p class="center"><a class="btn btn-lg" href="/my">Go to My Trips</a></p>
    </div>
  ))
})

paymentRoutes.get('/invoice/:code', async (c) => {
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE code = ?', c.req.param('code'))
  if (!b || !(await canAccess(c, b))) return c.notFound()
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', b.property_id)
  await logActivity(c.env, c.get('user')?.id ?? null, 'invoice.viewed', 'booking', b.id)
  return c.html(await invoiceHtml(c.env, b, p!))
})

paymentRoutes.get('/booking/:code/calendar.ics', async (c) => {
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE code = ?', c.req.param('code'))
  if (!b || !(await canAccess(c, b))) return c.notFound()
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', b.property_id)
  return new Response(icsFor(b, p!, c.env.SITE_URL), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${b.code}.ics"` },
  })
})
