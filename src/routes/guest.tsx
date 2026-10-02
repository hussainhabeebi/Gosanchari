// Guest pages (10–18): My trips, bookings, enquiries & quotes, saved, reviews, profile, help chat.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Pill, PropertyCard, Select, Tabs } from '../views/components'
import { requireUser } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, run } from '../lib/db'
import { cardsByIds } from '../lib/properties'
import { getContent, getSettings } from '../lib/settings'
import { mediaUrl } from '../lib/integrations'
import type { BookingRow, EnquiryRow, MessageRow, QuotationRow } from '../lib/types'
import { fmtDate, fmtDateTime, int, money, nowIso, parseJson, str, todayIST } from '../lib/util'
import { form, redirectMsg } from './helpers'

export const guestRoutes = new Hono<AppEnv>()
guestRoutes.use('/my', requireUser)
guestRoutes.use('/my/*', requireUser)

type BookingView = BookingRow & { property_name: string; slug: string; destination: string; photo: string | null; checkin_time: string; lat: number | null; lng: number | null; owner_phone: string | null; address: string | null }

const BOOKING_SELECT = `SELECT b.*, p.name AS property_name, p.slug, p.destination, p.checkin_time, p.lat, p.lng, p.address, p.owner_phone,
  (SELECT r2_key FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort LIMIT 1) AS photo
  FROM bookings b JOIN properties p ON p.id = b.property_id`

function mapsLink(b: { lat: number | null; lng: number | null; property_name: string; destination: string }) {
  return b.lat && b.lng ? `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}` : `https://www.google.com/maps/search/${encodeURIComponent(b.property_name + ' ' + b.destination)}`
}

// ---------- 10. Guest dashboard ----------
guestRoutes.get('/my', async (c) => {
  const u = c.get('user')!
  if (u.role !== 'guest') return c.redirect(u.role === 'sales' ? '/staff' : '/admin')
  const s = await getSettings(c.env)
  const [upcoming, quotes, enquiries] = await Promise.all([
    all<BookingView>(c.env, `${BOOKING_SELECT} WHERE b.user_id = ? AND b.status IN ('confirmed','checked_in') AND b.check_out >= ? ORDER BY b.check_in LIMIT 3`, u.id, todayIST()),
    all<QuotationRow & { total: number }>(c.env, "SELECT q.*, (SELECT MIN(total) FROM quotation_options o WHERE o.quotation_id = q.id) AS total FROM quotations q WHERE (q.user_id = ? OR q.phone = ?) AND q.status IN ('sent','viewed','changes_requested') AND (q.valid_till IS NULL OR q.valid_till >= ?) ORDER BY q.id DESC", u.id, u.phone ?? '-', todayIST()),
    all<EnquiryRow>(c.env, "SELECT * FROM enquiries WHERE user_id = ? AND status IN ('new','in_progress','quoted') ORDER BY id DESC LIMIT 5", u.id),
  ])
  const next = upcoming[0]
  return page(c, { title: 'My trips', area: 'guest', active: 'trips' }, (
    <div class="stack-lg">
      <h1>Hello{u.name && u.name !== 'Guest' ? `, ${u.name.split(' ')[0]}` : ''}!</h1>
      {next ? (
        <div class="card trip-card">
          <img src={mediaUrl(next.photo, 500)} alt="" />
          <div>
            <span class="muted small">Your next trip</span>
            <h2>{next.property_name}</h2>
            <p>{fmtDate(next.check_in)} → {fmtDate(next.check_out)} · check-in from {next.checkin_time}</p>
            <div class="row wrap-row">
              <a class="btn btn-sm" href={mapsLink(next)} target="_blank" rel="noopener">Directions</a>
              <a class="btn btn-sm btn-outline" href={`/my/bookings/${next.id}`}>Booking details</a>
              <a class="btn btn-sm btn-outline" href={`https://wa.me/${s.business.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hi, about my booking ' + next.code)}`}>Contact us</a>
            </div>
          </div>
        </div>
      ) : (
        <div class="card"><p>No upcoming trips yet.</p><a class="btn" href="/search">Find a stay</a></div>
      )}
      {quotes.length > 0 && (
        <section>
          <h2>Quotes waiting for your reply</h2>
          {quotes.map((q) => (
            <a class="card list-item" href={`/q/${q.token}`}>
              <div><strong>{q.code}</strong> <Pill s={q.status} /><div class="muted small">{q.valid_till ? `Valid till ${fmtDate(q.valid_till)}` : ''}</div></div>
              <div class="price">{money(q.total)}</div>
            </a>
          ))}
        </section>
      )}
      {enquiries.length > 0 && (
        <section>
          <h2>Open enquiries</h2>
          {enquiries.map((e) => (
            <div class="card list-item"><div><strong>{e.code}</strong> · {e.destination ?? 'Any destination'}<div class="muted small">{fmtDate(e.check_in)} · sent {fmtDateTime(e.created_at)}</div></div><Pill s={e.status} /></div>
          ))}
        </section>
      )}
      <div class="quick-actions">
        <a class="btn" href="/search">New search</a>
        <a class="btn btn-outline" href="/enquiry">Send enquiry</a>
        <a class="btn btn-outline" href="/help">Chat with us</a>
      </div>
    </div>
  ))
})

// ---------- 11. My bookings ----------
guestRoutes.get('/my/bookings', async (c) => {
  const u = c.get('user')!
  const tab = c.req.query('tab') ?? 'upcoming'
  const where = tab === 'completed' ? "b.status = 'completed' OR (b.status IN ('confirmed','checked_in') AND b.check_out < ?)"
    : tab === 'cancelled' ? "b.status = 'cancelled' AND b.amount_paid >= 0 AND ? IS NOT NULL"
    : "b.status IN ('confirmed','checked_in','pending') AND b.check_out >= ?"
  const rows = await all<BookingView & { reviewed: number }>(
    c.env,
    `SELECT * FROM (${BOOKING_SELECT.replace('SELECT b.*', 'SELECT b.*, (SELECT COUNT(*) FROM reviews r WHERE r.booking_id = b.id) AS reviewed')} WHERE b.user_id = ? AND (${where})) ORDER BY check_in ${tab === 'upcoming' ? 'ASC' : 'DESC'} LIMIT 100`,
    u.id, todayIST(),
  )
  const today = todayIST()
  return page(c, { title: 'My bookings', area: 'guest', active: 'bookings' }, (
    <>
      <h1>My bookings</h1>
      <Tabs base="/my/bookings" active={tab} items={[['upcoming', 'Upcoming'], ['completed', 'Completed'], ['cancelled', 'Cancelled']]} />
      {rows.length === 0 && <Empty>No {tab} bookings.</Empty>}
      {rows.filter((b) => !(b.status === 'pending' && b.hold_expires_at && b.hold_expires_at < nowIso())).map((b) => (
        <div class="card booking-row">
          <img src={mediaUrl(b.photo, 300)} alt="" />
          <div class="grow">
            <h3>{b.property_name}</h3>
            <div class="muted small">{b.code} · {fmtDate(b.check_in)} → {fmtDate(b.check_out)}</div>
            <div>{money(b.total)} <Pill s={b.status} /> <Pill s={b.payment_status} /></div>
          </div>
          <div class="row wrap-row">
            <a class="btn btn-sm" href={`/my/bookings/${b.id}`}>View</a>
            {b.status === 'pending' && <a class="btn btn-sm" href={`/pay/${b.code}`}>Pay now</a>}
            {b.amount_paid > 0 && <a class="btn btn-sm btn-outline" href={`/invoice/${b.code}`} target="_blank">Invoice</a>}
            {b.check_out <= today && ['confirmed', 'checked_in', 'completed'].includes(b.status) && !b.reviewed && <a class="btn btn-sm btn-outline" href={`/my/review/${b.id}`}>Write review</a>}
          </div>
        </div>
      ))}
    </>
  ))
})

// ---------- 12. Booking detail ----------
guestRoutes.get('/my/bookings/:id', async (c) => {
  const u = c.get('user')!
  const b = await first<BookingView & { room_name: string }>(c.env, `${BOOKING_SELECT.replace('SELECT b.*', 'SELECT b.*, (SELECT name FROM rooms WHERE id = b.room_id) AS room_name')} WHERE b.id = ? AND b.user_id = ?`, int(c.req.param('id')), u.id)
  if (!b) return c.notFound()
  const [msgs, payments] = await Promise.all([
    all<MessageRow>(c.env, "SELECT * FROM messages WHERE (booking_id = ? OR (enquiry_id = ? AND enquiry_id IS NOT NULL)) AND channel != 'note' ORDER BY id", b.id, b.enquiry_id ?? -1),
    all<{ amount: number; status: string; created_at: string; gateway_payment_id: string | null }>(c.env, 'SELECT amount, status, created_at, gateway_payment_id FROM payments WHERE booking_id = ? ORDER BY id', b.id),
  ])
  const canChange = ['confirmed', 'pending'].includes(b.status) && b.check_in > todayIST()
  return page(c, { title: `Booking ${b.code}`, area: 'guest', active: 'bookings' }, (
    <div class="stack-lg">
      <a href="/my/bookings" class="small">← All bookings</a>
      <div class="row-between"><h1>{b.property_name}</h1><Pill s={b.status} /></div>
      <div class="grid grid-2">
        <div class="card">
          <table class="breakdown">
            <tr><td>Booking ID</td><td>{b.code}</td></tr>
            <tr><td>Room</td><td>{b.room_name} × {b.rooms_count}</td></tr>
            <tr><td>Dates</td><td>{fmtDate(b.check_in)} → {fmtDate(b.check_out)} ({b.nights} nights)</td></tr>
            <tr><td>Guests</td><td>{b.adults} adults{b.children ? `, ${b.children} children` : ''}</td></tr>
            <tr><td>Room charges</td><td>{money(b.subtotal)}</td></tr>
            {b.discount > 0 && <tr><td>Discount</td><td>− {money(b.discount)}</td></tr>}
            <tr><td>GST</td><td>{money(b.taxes)}</td></tr>
            <tr class="total"><td>Total</td><td>{money(b.total)}</td></tr>
            <tr><td>Paid</td><td>{money(b.amount_paid)} <Pill s={b.payment_status} /></td></tr>
          </table>
          {payments.filter((p) => p.status === 'paid').map((p) => <div class="muted small">Receipt: {money(p.amount)} on {fmtDateTime(p.created_at)} (ref {p.gateway_payment_id})</div>)}
          <div class="row wrap-row mt-sm">
            {b.amount_paid > 0 && <a class="btn btn-sm btn-outline" href={`/invoice/${b.code}`} target="_blank">Download invoice</a>}
            {b.status === 'pending' || (b.amount_paid < b.total && b.status === 'confirmed') ? <a class="btn btn-sm" href={`/pay/${b.code}`}>Pay {money(b.total - b.amount_paid)}</a> : null}
            <a class="btn btn-sm btn-outline" href={`/booking/${b.code}/calendar.ics`}>Add to calendar</a>
          </div>
        </div>
        <div class="card">
          <h3>Getting there</h3>
          <p>{b.address ?? b.destination}</p>
          <a class="btn btn-sm" href={mapsLink(b)} target="_blank" rel="noopener">Open in Maps</a>
          <p class="muted small mt-sm">Property contact details are shared on WhatsApp one day before check-in.</p>
          {b.check_in <= new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) && b.owner_phone && b.status === 'confirmed' && <p>Property contact: <a href={`tel:${b.owner_phone}`}>{b.owner_phone}</a></p>}
        </div>
      </div>
      {canChange && (
        <form method="post" action={`/my/bookings/${b.id}/change`} class="card stack">
          <h3>Need to cancel or change?</h3>
          {b.change_status === 'requested' ? <p class="flash">Your request has been sent to our team: “{b.change_request}”.</p> : (
            <>
              <Select name="kind" options={[['cancel', 'Cancel this booking'], ['change', 'Change dates / guests']]} />
              <textarea name="message" rows={2} required maxlength={500} placeholder="Tell us what you need"></textarea>
              <button class="btn btn-outline">Send request to our team</button>
              <p class="muted small">Refunds follow the <a href="/policies/cancellation">cancellation policy</a> and are approved by our team.</p>
            </>
          )}
        </form>
      )}
      <section class="card">
        <h3>Messages about this booking</h3>
        <div class="thread">
          {msgs.length === 0 && <p class="muted">No messages yet.</p>}
          {msgs.map((m) => <div class={`msg msg-${m.sender}`}><div>{m.body}</div><div class="muted small">{m.sender === 'guest' ? 'You' : 'Go Sanchari'} · {fmtDateTime(m.created_at)}</div></div>)}
        </div>
        <form method="post" action={`/my/bookings/${b.id}/message`} class="row">
          <input name="body" required maxlength={1000} placeholder="Write a message…" />
          <button class="btn">Send</button>
        </form>
      </section>
    </div>
  ))
})

guestRoutes.post('/my/bookings/:id/change', async (c) => {
  const u = c.get('user')!
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE id = ? AND user_id = ?', int(c.req.param('id')), u.id)
  if (!b) return c.notFound()
  const f = await form(c)
  const req = `${f.kind === 'cancel' ? 'CANCEL' : 'CHANGE'}: ${str(f.message, 500)}`
  await run(c.env, "UPDATE bookings SET change_request = ?, change_status = 'requested', updated_at = ? WHERE id = ?", req, nowIso(), b.id)
  await run(c.env, "INSERT INTO messages (booking_id, sender, user_id, channel, body) VALUES (?, 'guest', ?, 'website', ?)", b.id, u.id, req)
  await run(c.env, 'INSERT INTO tasks (assigned_to, booking_id, guest_user_id, guest_name, phone, reason, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)', b.staff_id, b.id, u.id, b.guest_name, b.guest_phone, `Booking ${b.code}: ${req}`.slice(0, 300), nowIso())
  await logActivity(c.env, u.id, 'booking.change_requested', 'booking', b.id, { request: req })
  return redirectMsg(c, `/my/bookings/${b.id}`, { ok: 'Request sent. Our team will reply soon.' })
})

guestRoutes.post('/my/bookings/:id/message', async (c) => {
  const u = c.get('user')!
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE id = ? AND user_id = ?', int(c.req.param('id')), u.id)
  if (!b) return c.notFound()
  const f = await form(c)
  const body = str(f.body, 1000)
  if (body) await run(c.env, "INSERT INTO messages (booking_id, enquiry_id, sender, user_id, channel, body) VALUES (?, ?, 'guest', ?, 'website', ?)", b.id, b.enquiry_id, u.id, body)
  if (b.enquiry_id) await run(c.env, "UPDATE enquiries SET waiting_on = 'us', last_guest_msg_at = ? WHERE id = ?", nowIso(), b.enquiry_id)
  return c.redirect(`/my/bookings/${b.id}`, 303)
})

// ---------- 13. Enquiries and quotations ----------
guestRoutes.get('/my/enquiries', async (c) => {
  const u = c.get('user')!
  const [enqs, quotes] = await Promise.all([
    all<EnquiryRow>(c.env, 'SELECT * FROM enquiries WHERE user_id = ? OR (phone = ? AND phone IS NOT NULL) ORDER BY id DESC LIMIT 50', u.id, u.phone ?? '-'),
    all<QuotationRow & { total: number; property_name: string }>(
      c.env,
      `SELECT q.*, (SELECT MIN(total) FROM quotation_options o WHERE o.quotation_id = q.id) AS total,
        (SELECT p.name FROM quotation_options o JOIN properties p ON p.id = o.property_id WHERE o.quotation_id = q.id LIMIT 1) AS property_name
       FROM quotations q WHERE (q.user_id = ? OR q.phone = ?) AND q.status NOT IN ('draft','pending_approval') ORDER BY q.id DESC`,
      u.id, u.phone ?? '-',
    ),
  ])
  const label: Record<string, string> = { new: 'New', in_progress: 'In progress', quoted: 'Quoted', booked: 'Booked', closed: 'Closed', lost: 'Closed' }
  return page(c, { title: 'My enquiries', area: 'guest', active: 'enquiries' }, (
    <>
      <h1>Enquiries and quotations</h1>
      {enqs.length === 0 && <Empty>No enquiries yet. <a href="/enquiry">Send one</a> and our team will help.</Empty>}
      {enqs.map((e) => {
        const qs = quotes.filter((q) => q.enquiry_id === e.id)
        return (
          <div class="card">
            <div class="row-between"><div><strong>{e.code}</strong> · {e.destination ?? 'Any destination'}</div><span class={`pill pill-${e.status}`}>{label[e.status]}</span></div>
            <div class="muted small">{e.check_in ? `${fmtDate(e.check_in)} → ${fmtDate(e.check_out)}` : 'Dates flexible'} · {e.adults} adults{e.children ? `, ${e.children} children` : ''} · sent {fmtDateTime(e.created_at)}</div>
            {qs.map((q) => (
              <a class="list-item sub" href={`/q/${q.token}`}>
                <span>Quote {q.code}: {q.property_name} <Pill s={q.status} /></span>
                <span><strong>{money(q.total)}</strong> → Open</span>
              </a>
            ))}
          </div>
        )
      })}
      {quotes.filter((q) => !q.enquiry_id).map((q) => (
        <a class="card list-item" href={`/q/${q.token}`}><span>Quote {q.code}: {q.property_name} <Pill s={q.status} /></span><strong>{money(q.total)}</strong></a>
      ))}
    </>
  ))
})

// ---------- 15. Saved properties ----------
guestRoutes.get('/my/saved', async (c) => {
  const u = c.get('user')!
  const saved = await all<{ property_id: number; saved_price: number | null }>(c.env, 'SELECT property_id, saved_price FROM wishlist WHERE user_id = ? ORDER BY created_at DESC', u.id)
  const cards = await cardsByIds(c.env, saved.map((s) => s.property_id))
  const offers = await all<{ property_ids: string | null }>(c.env, 'SELECT property_ids FROM coupons WHERE active = 1 AND public = 1 AND valid_from <= ? AND valid_to >= ?', todayIST(), todayIST())
  const globalOffer = offers.some((o) => !parseJson<number[] | null>(o.property_ids, null)?.length)
  const offerIds = new Set(offers.flatMap((o) => parseJson<number[] | null>(o.property_ids, null) ?? []))
  return page(c, { title: 'Saved properties', area: 'guest', active: 'saved' }, (
    <>
      <h1>Saved properties</h1>
      {cards.length === 0 && <Empty>Tap the ♡ on any property to save it here.</Empty>}
      <div class="grid grid-3">
        {cards.map((p) => {
          const s = saved.find((x) => x.property_id === p.id)
          const drop = s?.saved_price && p.from_price < s.saved_price
          return (
            <div class="tagged">
              {drop && <span class="tag tag-green">Price dropped {money(s!.saved_price! - p.from_price)}</span>}
              {(globalOffer || offerIds.has(p.id)) && <span class="tag tag-amber">Offer available</span>}
              <PropertyCard p={p} saved />
            </div>
          )
        })}
      </div>
    </>
  ))
})

// ---------- 16. Write a review ----------
guestRoutes.get('/my/review/:bookingId', async (c) => {
  const u = c.get('user')!
  const b = await first<BookingView>(c.env, `${BOOKING_SELECT} WHERE b.id = ? AND b.user_id = ?`, int(c.req.param('bookingId')), u.id)
  if (!b || b.check_out > todayIST() || !['confirmed', 'checked_in', 'completed'].includes(b.status)) return redirectMsg(c, '/my/bookings', { err: 'You can review a stay after your check-out date.' })
  if (await first(c.env, 'SELECT 1 FROM reviews WHERE booking_id = ?', b.id)) return redirectMsg(c, '/my/bookings?tab=completed', { ok: 'You already reviewed this stay. Thank you!' })
  return page(c, { title: 'Write a review', area: 'guest', active: 'bookings' }, (
    <form method="post" action={`/my/review/${b.id}`} enctype="multipart/form-data" class="card stack narrow">
      <h1>How was {b.property_name}?</h1>
      <div class="star-input" role="radiogroup" aria-label="Rating">
        {[5, 4, 3, 2, 1].map((n) => <><input type="radio" name="rating" id={`r${n}`} value={n} required /><label for={`r${n}`} title={`${n} stars`}>★</label></>)}
      </div>
      <Field label="Your review"><textarea name="body" rows={5} maxlength={2000} placeholder="What did you like? Anything we should improve?"></textarea></Field>
      <Field label="Photos (optional, up to 4)"><input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple /></Field>
      <button class="btn btn-lg">Submit review</button>
      <p class="muted small">Reviews are checked by our team before they appear.</p>
    </form>
  ))
})

guestRoutes.post('/my/review/:bookingId', async (c) => {
  const u = c.get('user')!
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE id = ? AND user_id = ?', int(c.req.param('bookingId')), u.id)
  if (!b || b.check_out > todayIST() || !['confirmed', 'checked_in', 'completed'].includes(b.status)) return c.redirect('/my/bookings', 303)
  const body = await c.req.parseBody({ all: true })
  const rating = Math.min(5, Math.max(1, int(body.rating as string, 5)))
  const files = (Array.isArray(body.photos) ? body.photos : [body.photos]).filter((f): f is File => f instanceof File && f.size > 0).slice(0, 4)
  const keys: string[] = []
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(f.type)) continue
    const key = `reviews/${b.id}/${crypto.randomUUID()}.${f.type.split('/')[1]}`
    await c.env.MEDIA.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } })
    keys.push(key)
  }
  try {
    const id = await insertId(c.env, 'INSERT INTO reviews (booking_id, user_id, property_id, guest_name, rating, body, photos) VALUES (?, ?, ?, ?, ?, ?, ?)', b.id, u.id, b.property_id, u.name || b.guest_name, rating, str(body.body as string, 2000), JSON.stringify(keys))
    await enqueue(c.env, { type: 'review_check', reviewId: id })
    await enqueue(c.env, { type: 'review_reply_draft', reviewId: id })
  } catch {
    return redirectMsg(c, '/my/bookings?tab=completed', { err: 'You already reviewed this stay.' })
  }
  return redirectMsg(c, '/my/bookings?tab=completed', { ok: 'Thank you! Your review will appear after a quick check.' })
})

// ---------- 17. Profile ----------
guestRoutes.get('/my/profile', async (c) => {
  const u = c.get('user')!
  const full = await first<{ name: string; email: string | null; phone: string | null; language: string; whatsapp_updates: number }>(c.env, 'SELECT name, email, phone, language, whatsapp_updates FROM users WHERE id = ?', u.id)
  const travellers = await all<{ id: number; name: string; age: number | null; relation: string | null }>(c.env, 'SELECT * FROM travellers WHERE user_id = ? ORDER BY id', u.id)
  return page(c, { title: 'Profile', area: 'guest', active: 'profile' }, (
    <div class="stack-lg narrow">
      <h1>Profile</h1>
      <form method="post" action="/my/profile" class="card stack">
        <Field label="Name"><input name="name" value={full?.name} maxlength={80} required /></Field>
        <Field label="Phone" hint="To change your phone number, contact us."><input value={full?.phone ?? ''} disabled /></Field>
        <Field label="Email"><input type="email" name="email" value={full?.email ?? ''} maxlength={120} /></Field>
        <Field label="Language preference">
          <Select name="language" value={full?.language} options={[['en', 'English'], ['ml', 'മലയാളം (Malayalam)']]} />
        </Field>
        <label class="check"><input type="checkbox" name="whatsapp_updates" value="1" checked={!!full?.whatsapp_updates} /> WhatsApp updates on</label>
        <button class="btn">Save</button>
      </form>
      <section class="card">
        <h2>Saved travellers</h2>
        {travellers.length === 0 && <p class="muted">Add family members to speed up bookings.</p>}
        {travellers.map((t) => (
          <form method="post" action={`/my/travellers/${t.id}/delete`} class="list-item">
            <span>{t.name}{t.age ? `, ${t.age}` : ''}{t.relation ? ` (${t.relation})` : ''}</span>
            <button class="linklike">Remove</button>
          </form>
        ))}
        <form method="post" action="/my/travellers" class="row">
          <input name="name" placeholder="Name" required maxlength={80} />
          <input name="age" type="number" placeholder="Age" min="0" max="120" />
          <input name="relation" placeholder="Relation" maxlength={30} />
          <button class="btn btn-sm">Add</button>
        </form>
      </section>
    </div>
  ))
})

guestRoutes.post('/my/profile', async (c) => {
  const u = c.get('user')!
  const f = await form(c)
  const email = str(f.email, 120).toLowerCase() || null
  if (email && (await first(c.env, 'SELECT 1 FROM users WHERE email = ? AND id != ?', email, u.id))) return redirectMsg(c, '/my/profile', { err: 'That email is used by another account.' })
  await run(c.env, 'UPDATE users SET name = ?, email = ?, language = ?, whatsapp_updates = ? WHERE id = ?', str(f.name, 80), email, f.language === 'ml' ? 'ml' : 'en', f.whatsapp_updates ? 1 : 0, u.id)
  return redirectMsg(c, u.role === 'guest' ? '/my/profile' : '/staff/profile', { ok: 'Saved.' })
})

guestRoutes.post('/my/travellers', async (c) => {
  const u = c.get('user')!
  const f = await form(c)
  if (str(f.name)) await run(c.env, 'INSERT INTO travellers (user_id, name, age, relation) VALUES (?, ?, ?, ?)', u.id, str(f.name, 80), int(f.age) || null, str(f.relation, 30) || null)
  return c.redirect('/my/profile', 303)
})

guestRoutes.post('/my/travellers/:id/delete', async (c) => {
  await run(c.env, 'DELETE FROM travellers WHERE id = ? AND user_id = ?', int(c.req.param('id')), c.get('user')!.id)
  return c.redirect('/my/profile', 303)
})

// ---------- 18. Help / chat ----------
guestRoutes.get('/help', async (c) => {
  const [content, s] = await Promise.all([getContent(c.env), getSettings(c.env)])
  const u = c.get('user')
  return page(c, { title: 'Help & chat', area: u?.role === 'guest' ? 'guest' : 'public', active: 'help', description: 'Chat with the Go Sanchari assistant or talk to a person.' }, (
    <div class={u?.role === 'guest' ? 'stack-lg' : 'wrap section stack-lg'}>
      <h1>Help & chat</h1>
      <div class="chat card" data-chat data-lang={u?.language ?? 'en'} data-name={u?.name ?? ''} data-phone={u?.phone ?? ''}>
        <div class="chat-head">
          <strong>Go Sanchari assistant</strong>
          <button class="btn btn-sm btn-outline" data-handoff>Talk to a person</button>
        </div>
        <div class="chat-log" aria-live="polite">
          <div class="msg msg-ai">{s.ai.assistant_welcome}</div>
        </div>
        <form class="chat-form">
          <input name="text" placeholder="Type your question (English or മലയാളം)…" maxlength={600} required autocomplete="off" />
          <button class="btn">Send</button>
        </form>
        <form class="chat-contact card" hidden>
          <p><strong>Connect with our team.</strong> Share your number so we can reply on WhatsApp too.</p>
          <div class="row">
            <input name="name" placeholder="Your name" value={u?.name ?? ''} required />
            <input name="phone" placeholder="WhatsApp number" value={u?.phone ?? ''} required inputmode="tel" />
          </div>
          <button class="btn btn-sm">Connect me</button>
        </form>
      </div>
      {content.faqs.length > 0 && (
        <section>
          <h2>Frequently asked questions</h2>
          {content.faqs.map((f) => <details class="faq"><summary>{f.q}</summary><p>{f.a}</p></details>)}
        </section>
      )}
      <p class="muted">Prefer WhatsApp? <a href={`https://wa.me/${s.business.whatsapp.replace(/\D/g, '')}`}>Message us directly</a>.</p>
    </div>
  ))
})

