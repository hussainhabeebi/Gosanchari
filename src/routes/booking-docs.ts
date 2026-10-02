// Booking documents: invoice (printable HTML) and calendar file, for the guest who owns the booking and for staff.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { first, logActivity } from '../lib/db'
import { icsFor, invoiceHtml } from '../lib/bookings'
import { isStaff } from '../lib/permissions'
import type { BookingRow, PropertyRow } from '../lib/types'

export const bookingDocRoutes = new Hono<AppEnv>()

function canAccess(c: Context<AppEnv>, b: BookingRow): boolean {
  const u = c.get('user')
  return !!u && (u.id === b.user_id || isStaff(u.role))
}

bookingDocRoutes.get('/invoice/:code', async (c) => {
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE code = ?', c.req.param('code'))
  if (!b || !canAccess(c, b)) return c.notFound()
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', b.property_id)
  await logActivity(c.env, c.get('user')?.id ?? null, 'invoice.viewed', 'booking', b.id)
  return c.html(await invoiceHtml(c.env, b, p!))
})

bookingDocRoutes.get('/booking/:code/calendar.ics', async (c) => {
  const b = await first<BookingRow>(c.env, 'SELECT * FROM bookings WHERE code = ?', c.req.param('code'))
  if (!b || !canAccess(c, b)) return c.notFound()
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', b.property_id)
  return new Response(icsFor(b, p!, c.env.SITE_URL), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${b.code}.ics"` },
  })
})
