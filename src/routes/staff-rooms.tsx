// Staff → Rooms & photos: every room category with its photos and prices, and one-tap sharing of a room's
// photo page with a guest (WhatsApp, the phone's share sheet, or a copied link).

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field } from '../views/components'
import { permissionsFor, requireStaff } from '../lib/auth'
import { all, first } from '../lib/db'
import { mediaUrl } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import { ADDON_PER, addons as readAddons, guestsText, ROOM_AMENITIES, stayTypeLabel } from '../lib/catalog'
import { MEAL_PLANS } from '../lib/search'
import { weekendLabel } from '../lib/pricing'
import type { EnquiryRow, PhotoRow, PropertyRow, RoomRow } from '../lib/types'
import { fmtDate, int, money, normalizePhone, parseJson, str } from '../lib/util'
import { canSeeEnquiry } from './staff'

export const staffRoomRoutes = new Hono<AppEnv>()
staffRoomRoutes.use('/staff/rooms', requireStaff)
staffRoomRoutes.use('/staff/rooms/*', requireStaff)

/** Optional enquiry the staff member is working on: WhatsApp links then open that guest's chat. */
async function enquiryGuest(c: Context<AppEnv>) {
  const id = int(c.req.query('enquiry'))
  if (!id) return null
  const e = await first<Pick<EnquiryRow, 'id' | 'guest_name' | 'phone' | 'assigned_to'>>(c.env, 'SELECT id, guest_name, phone, assigned_to FROM enquiries WHERE id = ?', id)
  if (!e) return null
  const u = c.get('user')!
  if (!canSeeEnquiry(u, await permissionsFor(c.env, u.role), e)) return null
  return { id: e.id, name: e.guest_name, wa: normalizePhone(e.phone)?.replace(/\D/g, '') ?? '' }
}

staffRoomRoutes.get('/staff/rooms', async (c) => {
  const q = str(c.req.query('q'), 60)
  const guest = await enquiryGuest(c)
  const like = `%${q}%`
  const props = await all<Pick<PropertyRow, 'id' | 'name' | 'destination' | 'type' | 'stay_type' | 'status'> & { rooms: number; photos: number }>(
    c.env,
    `SELECT p.id, p.name, p.destination, p.type, p.stay_type, p.status,
       (SELECT COUNT(*) FROM rooms r WHERE r.property_id = p.id AND r.active = 1) AS rooms,
       (SELECT COUNT(*) FROM property_photos ph WHERE ph.property_id = p.id AND ph.room_id IS NOT NULL) AS photos
     FROM properties p WHERE p.status != 'hidden' ${q ? 'AND (p.name LIKE ? OR p.destination LIKE ?)' : ''} ORDER BY p.status = 'live' DESC, p.name LIMIT 200`,
    ...(q ? [like, like] : []),
  )
  const keep = guest ? `?enquiry=${guest.id}` : ''
  return page(c, { title: 'Rooms & photos', area: 'staff', active: 'rooms' }, (
    <div class="stack-lg">
      <div class="row-between">
        <h1>Rooms & photos</h1>
        {guest && <span class="pill">Sharing with {guest.name}</span>}
      </div>
      <p class="muted">Pick a property to see every room category with its photos and prices, and share a room's photos with a guest.</p>
      <form method="get" class="row wrap-row filters-inline">
        {guest && <input type="hidden" name="enquiry" value={guest.id} />}
        <Field label="Search"><input name="q" value={q} placeholder="Property or destination" /></Field>
        <button class="btn btn-sm">Search</button>
      </form>
      {props.length === 0 && <Empty>No properties found.</Empty>}
      <div class="grid grid-3">
        {props.map((p) => (
          <a class="card stack-sm" href={`/staff/rooms/${p.id}${keep}`}>
            <strong>{p.name}</strong>
            <span class="muted small">{stayTypeLabel(p)} · {p.destination}{p.status !== 'live' ? ' · draft' : ''}</span>
            <span class="small">{p.rooms} room categor{p.rooms === 1 ? 'y' : 'ies'} · {p.photos} room photo{p.photos === 1 ? '' : 's'}</span>
          </a>
        ))}
      </div>
    </div>
  ))
})

staffRoomRoutes.get('/staff/rooms/:id', async (c) => {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', int(c.req.param('id')))
  if (!p) return c.notFound()
  const u = c.get('user')!
  const [perms, settings, guest] = await Promise.all([permissionsFor(c.env, u.role), getSettings(c.env), enquiryGuest(c)])
  const [rooms, photos] = await Promise.all([
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', p.id),
    all<PhotoRow>(c.env, "SELECT * FROM property_photos WHERE property_id = ? AND media_type = 'image' AND r2_key != '' ORDER BY sort, id", p.id),
  ])
  const addonList = readAddons(p.addons)
  const t = settings.images_transform
  const abs = (path: string) => new URL(path, c.req.url).toString()
  const wa = (text: string) => `https://wa.me/${guest?.wa ?? ''}?text=${encodeURIComponent(text)}`
  const hi = guest ? `Hi ${guest.name.split(' ')[0]}, ` : ''
  const propertyUrl = abs(`/stay/${p.slug}`)
  const common = photos.filter((m) => m.room_id == null)
  return page(c, { title: `Rooms · ${p.name}`, area: 'staff', active: 'rooms' }, (
    <div class="stack-lg">
      <a href={`/staff/rooms${guest ? `?enquiry=${guest.id}` : ''}`} class="small">← All properties</a>
      <div class="row-between">
        <div>
          <h1>{p.name}</h1>
          <div class="muted">{stayTypeLabel(p)} · 📍 {p.destination}{p.status !== 'live' ? ' · not live yet (guests can\'t open links)' : ''}</div>
        </div>
        <div class="row wrap-row">
          {guest && <a class="btn btn-sm btn-outline" href={`/staff/enquiries/${guest.id}`}>← Back to {guest.name}</a>}
          <a class="btn btn-sm" href={wa(`${hi}here are the rooms and photos of ${p.name}, ${p.destination}:\n${propertyUrl}`)} target="_blank" rel="noopener">WhatsApp whole property</a>
          <button type="button" class="btn btn-sm btn-outline" data-share={propertyUrl} data-share-title={p.name}>Share / copy link</button>
        </div>
      </div>

      <div class="card small stack-sm rate-basics">
        <div>
          {p.rate_meal_plan && <span>🍽 Rates include <strong>{p.rate_meal_plan} – {MEAL_PLANS[p.rate_meal_plan] ?? ''}</strong> · </span>}
          <span>📅 Weekend: <strong>{weekendLabel(p.weekend_nights)}</strong></span>
          {(p.child_free_below != null || p.child_age_to != null) && <span> · 🧒 Children{p.child_free_below != null ? ` free below ${p.child_free_below}` : ''}{p.child_age_to != null ? `, child rate up to ${p.child_age_to} (older = adult)` : ''}</span>}
        </div>
        {addonList.length > 0 && <div>✨ Add-ons: {addonList.map((a, i) => <>{i ? ' · ' : ''}{a.name} <strong>{money(a.price)}</strong>{a.per && a.per !== 'stay' ? ` ${ADDON_PER[a.per]}` : ''}{perms.view_net_rates && a.net ? <span class="internal"> (net {money(a.net)})</span> : null}</>)}</div>}
        {perms.view_net_rates && (p.b2b_valid_from || p.b2b_valid_to || p.b2b_terms) && <div class="internal">📄 B2B contract{p.b2b_valid_from || p.b2b_valid_to ? ` valid ${p.b2b_valid_from ? fmtDate(p.b2b_valid_from) : '…'} – ${p.b2b_valid_to ? fmtDate(p.b2b_valid_to) : '…'}` : ''}{p.b2b_terms ? <div class="pre-line">{p.b2b_terms}</div> : null}</div>}
        {p.cancellation_policy && <div>↩ Cancellation: {p.cancellation_policy}</div>}
      </div>
      {rooms.length === 0 && <Empty>No room categories yet. {perms.manage_properties && <a href={`/admin/properties/${p.id}/setup/2`}>Add room categories</a>}</Empty>}
      {rooms.map((r) => {
        const rp = photos.filter((m) => m.room_id === r.id)
        const url = abs(`/stay/${p.slug}/room/${r.id}`)
        const am = parseJson<string[]>(r.facilities, [])
        const text = `${hi}${r.name} at ${p.name}, ${p.destination} — up to ${r.capacity} guests, from ${money(r.base_rate)}/night.\nPhotos: ${url}`
        return (
          <section class="share-room stack" id={`room-${r.id}`}>
            <div class="row-between">
              <h2>{r.name}</h2>
              <span class="muted small">{r.units} room{r.units === 1 ? '' : 's'} · {guestsText(r)}{r.bed_type ? ` · ${r.bed_type}` : ''}{r.room_view ? ` · ${r.room_view} view` : ''}</span>
            </div>
            {rp.length > 0
              ? <div class="share-thumbs" data-gallery>{rp.map((m) => <a href={mediaUrl(m.r2_key, 1600, t)} data-full><img src={mediaUrl(m.r2_key, 300, t)} alt={m.caption ?? r.name} loading="lazy" /></a>)}</div>
              : <p class="muted small">No photos for this room category yet.{perms.manage_properties && <> <a href={`/admin/properties/${p.id}/setup/6`}>Add room photos</a></>}</p>}
            <div class="grid grid-2">
              <div>
                <h3 class="small">Prices per night</h3>
                <ul class="rate-list small">
                  {perms.view_net_rates && r.net_rate && <li class="internal">B2B / Net rate (management only): {money(r.net_rate)}</li>}
                  {r.rack_rate && <li>Rack rate (EP): {money(r.rack_rate)}</li>}
                  <li class="internal">Internal staff rate: <strong>{r.staff_rate ? money(r.staff_rate) : 'not set'}</strong></li>
                  <li>Guest rate, weekdays: <strong>{money(r.base_rate)}</strong></li>
                  {r.weekend_rate && r.weekend_rate !== r.base_rate && <li>Guest rate, Fri & Sat: <strong>{money(r.weekend_rate)}</strong></li>}
                  {(r.base_guests ?? r.capacity) < r.capacity && <li>Rate covers <strong>{r.base_guests}</strong> guests, max {r.capacity}. Extra adult: <strong>{r.extra_adult_rate ? money(r.extra_adult_rate) : 'not set'}</strong>{r.extra_child_rate != null && r.extra_child_rate !== r.extra_adult_rate ? <>, extra child: <strong>{r.extra_child_rate ? money(r.extra_child_rate) : 'free'}</strong></> : null} per night</li>}
                  {r.min_nights > 1 && <li>Minimum {r.min_nights} nights</li>}
                </ul>
                {r.inclusions && <div class="small">Includes: {r.inclusions}</div>}
              </div>
              <div class="small">
                {am.length > 0 && <><h3 class="small">Amenities</h3>{am.map((a) => ROOM_AMENITIES[a] ?? a).join(' · ')}</>}
              </div>
            </div>
            <div class="row wrap-row">
              <a class="btn btn-sm" href={wa(text)} target="_blank" rel="noopener">Send on WhatsApp{guest ? ` to ${guest.name.split(' ')[0]}` : ''}</a>
              <button type="button" class="btn btn-sm btn-outline" data-share={url} data-share-title={`${r.name} · ${p.name}`} data-share-text={text}>Share / copy link</button>
              <a class="btn btn-sm btn-outline" href={url} target="_blank" rel="noopener">Open guest page</a>
            </div>
          </section>
        )
      })}

      {common.length > 0 && (
        <section class="share-room stack">
          <h2>Common area photos</h2>
          <div class="share-thumbs" data-gallery>{common.map((m) => <a href={mediaUrl(m.r2_key, 1600, t)} data-full><img src={mediaUrl(m.r2_key, 300, t)} alt={m.caption ?? p.name} loading="lazy" /></a>)}</div>
          <div class="row wrap-row">
            <a class="btn btn-sm" href={wa(`${hi}photos of ${p.name}, ${p.destination}:\n${propertyUrl}#photos`)} target="_blank" rel="noopener">Send on WhatsApp</a>
          </div>
        </section>
      )}
    </div>
  ))
})
