// Public pages (1–9) and the public quotation link (14).

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, Empty, FACILITY_ICONS, Field, jsonScript, LeafletHead, PropertyCard, Select, Stars, Turnstile } from '../views/components'
import { all, enqueue, findOrCreateGuest, first, insertId, logActivity, monthOccupancy, notifyStaff, run } from '../lib/db'
import { closeMatches, destinations, featuredCards, searchProperties, similarProperties, smartSearch } from '../lib/properties'
import { FACILITIES, filtersFromQuery, filtersToParams, MEAL_PLANS, PROPERTY_TYPES, type SearchFilters } from '../lib/search'
import { getContent, getSettings } from '../lib/settings'
import { propertyQA } from '../lib/assist'
import { mediaUrl, verifyTurnstile } from '../lib/integrations'
import { rateLimit } from '../lib/auth'
import { priceStay } from '../lib/bookings'
import type { NearbyPlace, PhotoRow, PropertyRow, QuotationRow, QuoteOptionRow, ReviewRow, RoomRow } from '../lib/types'
import { addDays, eachNight, fmtDate, int, isDate, money, nightsBetween, normalizePhone, nowIso, parseJson, refCode, str, todayIST } from '../lib/util'
import { clientIp, form, redirectMsg } from './helpers'
import { createBooking } from '../lib/bookings'

export const publicRoutes = new Hono<AppEnv>()

async function savedIds(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }): Promise<Set<number>> {
  const u = c.get('user')
  if (!u) return new Set()
  const rows = await all<{ property_id: number }>(c.env, 'SELECT property_id FROM wishlist WHERE user_id = ?', u.id)
  return new Set(rows.map((r) => r.property_id))
}

// ---------- 1. Home ----------
publicRoutes.get('/', async (c) => {
  const [content, settings, dests, featured, offers, saved] = await Promise.all([
    getContent(c.env),
    getSettings(c.env),
    all<{ name: string; slug: string; image: string | null; blurb: string | null; n: number }>(
      c.env,
      "SELECT d.name, d.slug, d.image, d.blurb, (SELECT COUNT(*) FROM properties p WHERE p.destination = d.name AND p.status = 'live') AS n FROM destinations d WHERE d.popular = 1 ORDER BY d.sort, d.name LIMIT 8",
    ),
    featuredCards(c.env, 8),
    all<{ code: string; title: string; description: string; discount_type: string; discount_value: number; valid_to: string }>(
      c.env,
      'SELECT code, title, description, discount_type, discount_value, valid_to FROM coupons WHERE active = 1 AND public = 1 AND valid_to >= ? AND valid_from <= ? ORDER BY valid_to LIMIT 3',
      todayIST(), todayIST(),
    ),
    savedIds(c),
  ])
  const reviewIds = content.featured_review_ids
  const reviews = reviewIds.length
    ? await all<ReviewRow & { property_name: string; slug: string }>(c.env, `SELECT r.*, p.name AS property_name, p.slug FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.status = 'approved' AND r.id IN (${reviewIds.map(() => '?').join(',')})`, ...reviewIds)
    : await all<ReviewRow & { property_name: string; slug: string }>(c.env, "SELECT r.*, p.name AS property_name, p.slug FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.status = 'approved' AND r.rating >= 4 AND length(r.body) > 40 ORDER BY r.id DESC LIMIT 4")
  const destNames = await destinations(c.env)
  const today = todayIST()

  return page(c, { title: settings.business.name, description: content.hero.subtitle, canonical: c.env.SITE_URL + '/' }, (
    <>
      <section class="hero" style={`background-image:linear-gradient(rgba(5,40,37,.55),rgba(5,40,37,.55)),url('${content.hero.image}')`}>
        <div class="wrap">
          <h1>{content.hero.title}</h1>
          <p class="hero-sub">{content.hero.subtitle}</p>
          <form class="searchbox" method="get" action="/search">
            <Field label="Location">
              <input name="destination" list="dest-list" placeholder="Munnar, Wayanad…" />
              <datalist id="dest-list">{destNames.map((d) => <option value={d} />)}</datalist>
            </Field>
            <Field label="Check-in"><input type="date" name="checkIn" min={today} /></Field>
            <Field label="Check-out"><input type="date" name="checkOut" min={today} /></Field>
            <Field label="Guests"><input type="number" name="guests" min="1" max="40" value="2" /></Field>
            <button class="btn btn-lg">Search</button>
          </form>
          <form class="ai-search" method="get" action="/search">
            <span class="ai-badge">AI</span>
            <input name="ai" maxlength={200} placeholder="Try: Quiet homestay in Wayanad for 4, under ₹8,000" aria-label="Describe your stay" />
            <button class="btn">Find</button>
          </form>
        </div>
      </section>

      <section class="wrap section">
        <h2>Popular destinations</h2>
        <div class="grid grid-4">
          {dests.map((d) => (
            <a class="dest" href={`/search?destination=${encodeURIComponent(d.name)}`}>
              <img src={mediaUrl(d.image, 500, settings.images_transform)} alt={d.name} loading="lazy" />
              <div class="dest-label"><strong>{d.name}</strong><span>{d.n} stays</span></div>
            </a>
          ))}
        </div>
      </section>

      {featured.length > 0 && (
        <section class="wrap section">
          <div class="row-between"><h2>Featured stays</h2><a href="/search">See all →</a></div>
          <div class="grid grid-4">{featured.map((p) => <PropertyCard p={p} saved={saved.has(p.id)} transform={settings.images_transform} />)}</div>
        </section>
      )}

      {(offers.length > 0 || content.banners.length > 0) && (
        <section class="wrap section">
          <div class="offer-strip">
            {content.banners.map((b) => (
              <a class="offer" href={b.link}><strong>{b.title}</strong><span>{b.text}</span></a>
            ))}
            {offers.map((o) => (
              <a class="offer" href="/offers">
                <strong>{o.title || (o.discount_type === 'pct' ? `${o.discount_value}% off` : `${money(o.discount_value)} off`)}</strong>
                <span>Use code <code>{o.code}</code> · till {fmtDate(o.valid_to)}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section class="wrap section">
        <h2>Why book with us</h2>
        <div class="grid grid-4">
          {content.why_us.map((w) => (
            <div class="why"><div class="why-icon">{w.icon}</div><strong>{w.title}</strong><p class="muted">{w.text}</p></div>
          ))}
        </div>
      </section>

      {reviews.length > 0 && (
        <section class="wrap section">
          <h2>What guests say</h2>
          <div class="grid grid-4">
            {reviews.slice(0, 4).map((r) => (
              <blockquote class="card review-card">
                <div class="stars">{'★'.repeat(r.rating)}</div>
                <p>“{r.body.slice(0, 220)}{r.body.length > 220 ? '…' : ''}”</p>
                <footer class="muted small">— {r.guest_name}, <a href={`/stay/${r.slug}`}>{r.property_name}</a></footer>
              </blockquote>
            ))}
          </div>
        </section>
      )}
    </>
  ))
})

// ---------- 2. Search results ----------
publicRoutes.get('/search', async (c) => {
  const aiText = c.req.query('ai')?.trim().slice(0, 200)
  if (aiText) {
    if (!(await rateLimit(c.env, `ai-search:${clientIp(c)}`, 30, 3600))) return redirectMsg(c, '/search', { err: 'Too many searches, please use the filters.' })
    const { filters, usedAi } = await smartSearch(c.env, aiText)
    const p = filtersToParams(filters)
    p.set('understood', aiText)
    if (usedAi) p.set('ai', '0')
    return c.redirect('/search?' + p.toString())
  }
  const settings = await getSettings(c.env)
  const q = c.req.queries()
  const flat: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(q)) flat[k] = v.length > 1 ? v : v[0]
  const f: SearchFilters = filtersFromQuery(flat)
  f.sort ??= 'recommended'
  const [results, dests, saved] = await Promise.all([searchProperties(c.env, f), destinations(c.env), savedIds(c)])
  const fewer = results.length < 3 ? await closeMatches(c.env, f, results.map((r) => r.id), 4) : []
  const understood = c.req.query('understood')
  const qs = new URLSearchParams()
  if (f.checkIn) qs.set('checkIn', f.checkIn)
  if (f.checkOut) qs.set('checkOut', f.checkOut)
  if (f.guests) qs.set('guests', String(f.guests))
  const view = c.req.query('view') === 'map' ? 'map' : 'list'
  const baseParams = filtersToParams(f)
  const mapParams = new URLSearchParams(baseParams); mapParams.set('view', view === 'map' ? 'list' : 'map')
  const summaryBits = [
    f.destination, f.checkIn && f.checkOut ? `${fmtDate(f.checkIn)} – ${fmtDate(f.checkOut)}` : null, f.guests ? `${f.guests} guests` : null,
    f.priceMax ? `under ${money(f.priceMax)}/night` : null, ...(f.types ?? []), ...(f.facilities ?? []).map((x) => FACILITIES[x]),
    f.family ? 'family-friendly' : null, f.pet ? 'pet-friendly' : null, f.q ? `“${f.q}”` : null,
  ].filter(Boolean)

  return page(c, { title: f.destination ? `Stays in ${f.destination}` : 'Find a stay', description: `Homestays, villas, resorts and houseboats${f.destination ? ' in ' + f.destination : ' in Kerala'}.`, head: view === 'map' ? <LeafletHead /> : undefined }, (
    <div class="wrap search-page">
      <input type="checkbox" id="filters-toggle" class="nav-toggle" />
      <aside class="filters">
        <label for="filters-toggle" class="filters-close">✕ Close</label>
        <form method="get" action="/search" class="stack">
          <h3>Filters</h3>
          <Field label="Location">
            <Select name="destination" value={f.destination} options={[['', 'Anywhere in Kerala'], ...dests.map((d) => [d, d] as [string, string])]} />
          </Field>
          <div class="row">
            <Field label="Check-in"><input type="date" name="checkIn" value={f.checkIn} min={todayIST()} /></Field>
            <Field label="Check-out"><input type="date" name="checkOut" value={f.checkOut} min={todayIST()} /></Field>
          </div>
          <div class="row">
            <Field label="Guests"><input type="number" name="guests" min="1" max="40" value={f.guests ?? ''} /></Field>
            <Field label="Rooms"><input type="number" name="rooms" min="1" max="20" value={f.rooms ?? ''} /></Field>
          </div>
          <div class="row">
            <Field label="Min ₹/night"><input type="number" name="priceMin" min="0" step="500" value={f.priceMin ?? ''} /></Field>
            <Field label="Max ₹/night"><input type="number" name="priceMax" min="0" step="500" value={f.priceMax ?? ''} /></Field>
          </div>
          <fieldset><legend>Property type</legend>
            {PROPERTY_TYPES.map((t) => <label class="check"><input type="checkbox" name="type" value={t} checked={f.types?.includes(t)} /> {t}</label>)}
          </fieldset>
          <fieldset><legend>Facilities</legend>
            {['pool', 'wifi', 'parking', 'ac', 'kitchen', 'ground_floor'].map((k) => <label class="check"><input type="checkbox" name="facility" value={k} checked={f.facilities?.includes(k)} /> {FACILITIES[k]}</label>)}
          </fieldset>
          <Field label="Meal plan"><Select name="meal" value={f.mealPlan} options={[['', 'Any'], ...Object.entries(MEAL_PLANS)]} /></Field>
          <Field label="Rating"><Select name="rating" value={f.rating} options={[['', 'Any'], [4, '4★ & above'], [3, '3★ & above']]} /></Field>
          <label class="check"><input type="checkbox" name="pet" value="1" checked={f.pet} /> Pet-friendly</label>
          <label class="check"><input type="checkbox" name="family" value="1" checked={f.family} /> Family-friendly</label>
          {f.q && <input type="hidden" name="q" value={f.q} />}
          <input type="hidden" name="sort" value={f.sort} />
          <button class="btn">Apply filters</button>
          <a href="/search" class="muted small">Clear all</a>
        </form>
      </aside>

      <section class="results">
        {understood && (
          <AiNote label="We understood">{summaryBits.join(' · ') || 'Showing all stays'} <span class="muted small">(from “{understood}”)</span></AiNote>
        )}
        <div class="results-bar">
          <label for="filters-toggle" class="btn btn-sm btn-outline filters-open">Filters</label>
          <span class="muted">{results.length} stay{results.length === 1 ? '' : 's'}</span>
          <form method="get" action="/search" class="inline sort-form">
            {[...baseParams.entries()].filter(([k]) => k !== 'sort').map(([k, v]) => <input type="hidden" name={k} value={v} />)}
            <Select name="sort" value={f.sort} class="autosubmit" options={[['recommended', 'Recommended'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Rating'], ['newest', 'Newest']]} />
          </form>
          <a class="btn btn-sm btn-outline" href={`/search?${mapParams}`}>{view === 'map' ? 'List view' : 'Map view'}</a>
        </div>

        {view === 'map' && (
          <>
            <div id="results-map" class="map map-lg"></div>
            {jsonScript('map-data', results.filter((r) => r.lat && r.lng).map((r) => ({ lat: r.lat, lng: r.lng, name: r.name, href: `/stay/${r.slug}?${qs}`, price: money(r.stay_price ?? r.from_price) })))}
          </>
        )}

        {results.length > 0 ? (
          <div class="grid grid-3">{results.map((p) => <PropertyCard p={p} saved={saved.has(p.id)} qs={qs.toString()} transform={settings.images_transform} />)}</div>
        ) : (
          <Empty>
            <h3>No stays match all your filters</h3>
            <p>Send us an enquiry and our team will find one for you.</p>
            <a class="btn" href={`/enquiry?${new URLSearchParams({ destination: f.destination ?? '', checkIn: f.checkIn ?? '', checkOut: f.checkOut ?? '', adults: String(f.guests ?? 2) })}`}>Send us an enquiry</a>
          </Empty>
        )}
        {results.length > 0 && results.length < 3 && (
          <p class="center"><a class="btn btn-outline" href={`/enquiry?destination=${encodeURIComponent(f.destination ?? '')}`}>Not quite right? Send us an enquiry</a></p>
        )}
        {fewer.length > 0 && (
          <>
            <h3 class="mt">You might also like</h3>
            <div class="grid grid-4">{fewer.map((p) => <PropertyCard p={p} saved={saved.has(p.id)} transform={settings.images_transform} />)}</div>
          </>
        )}
      </section>
    </div>
  ))
})

// ---------- 3. Property details ----------
publicRoutes.get('/stay/:slug', async (c) => {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE slug = ?', c.req.param('slug'))
  const user = c.get('user')
  const isStaffUser = !!user && user.role !== 'guest'
  if (!p || (p.status !== 'live' && !isStaffUser)) return page(c, { title: 'Not found' }, <div class="wrap section"><Empty><h2>This stay is not available</h2><a href="/search">Browse stays</a></Empty></div>, 404)
  const settings = await getSettings(c.env)
  const [photos, rooms, reviews, similar, saved] = await Promise.all([
    all<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id),
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', p.id),
    all<ReviewRow>(c.env, "SELECT * FROM reviews WHERE property_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 20", p.id),
    similarProperties(c.env, p.id, 4),
    savedIds(c),
  ])
  // Availability calendar: next ~2 months, a date is greyed out when every room is full.
  const from = todayIST()
  const to = addDays(from, 62)
  const occ = await monthOccupancy(c.env, p.id, from, to)
  const fullDates: string[] = []
  for (const d of eachNight(from, to)) {
    const anyFree = rooms.some((r) => {
      const used = occ.bookings.filter((b) => b.room_id === r.id && b.check_in <= d && d < b.check_out).reduce((a, b) => a + b.rooms_count, 0)
      const blocked = occ.blocks.some((b) => b.room_id == null && b.date === d) ? r.units : occ.blocks.filter((b) => b.room_id === r.id && b.date === d).length
      return used + blocked < r.units
    })
    if (!anyFree) fullDates.push(d)
  }
  const facilities = parseJson<string[]>(p.facilities, [])
  const meals = parseJson<string[]>(p.meal_plans, [])
  const nearby = parseJson<NearbyPlace[]>(p.nearby, [])
  const highlights = parseJson<string[]>(p.highlights, [])
  const checkIn = isDate(c.req.query('checkIn')) ? c.req.query('checkIn')! : ''
  const checkOut = isDate(c.req.query('checkOut')) ? c.req.query('checkOut')! : ''
  const guests = int(c.req.query('guests'), 2)
  const lang = user?.language ?? 'en'
  const description = lang === 'ml' && p.description_ml ? p.description_ml : p.description
  const gallery = photos.length ? photos : [{ id: 0, r2_key: '', caption: p.name } as PhotoRow]
  const ld = {
    '@context': 'https://schema.org', '@type': 'LodgingBusiness', name: p.name, description: p.seo_description ?? p.description.slice(0, 200),
    address: { '@type': 'PostalAddress', addressLocality: p.destination, addressRegion: 'Kerala', addressCountry: 'IN' },
    ...(p.rating_count ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating_avg.toFixed(1), reviewCount: p.rating_count } } : {}),
    image: photos.slice(0, 3).map((ph) => c.env.SITE_URL + mediaUrl(ph.r2_key, 1200)),
  }

  return page(c, {
    title: p.seo_title || `${p.name}, ${p.destination}`,
    description: p.seo_description || p.description.slice(0, 155),
    image: photos[0] ? (photos[0].r2_key.startsWith('http') ? photos[0].r2_key : c.env.SITE_URL + mediaUrl(photos[0].r2_key, 1200)) : undefined,
    canonical: `${c.env.SITE_URL}/stay/${p.slug}`,
    head: <LeafletHead />,
  }, (
    <div class="wrap property-page">
      {p.status !== 'live' && <div class="flash flash-err">Preview — this property is {p.status} and not visible to guests.</div>}
      <div class="gallery" data-gallery>
        {gallery.slice(0, 5).map((ph, i) => (
          <a href={mediaUrl(ph.r2_key, 1600, settings.images_transform)} class={`g-item g-${i}`} data-full>
            <img src={mediaUrl(ph.r2_key, i === 0 ? 1200 : 600, settings.images_transform)} alt={ph.caption ?? p.name} loading={i ? 'lazy' : 'eager'} />
          </a>
        ))}
        {gallery.slice(5).map((ph) => <a href={mediaUrl(ph.r2_key, 1600, settings.images_transform)} data-full hidden></a>)}
        {photos.length > 5 && <button class="btn btn-sm g-all" data-open-gallery>Show all {photos.length} photos</button>}
      </div>

      <div class="prop-layout">
        <div class="prop-main">
          <div class="row-between">
            <div>
              <h1>{p.name}</h1>
              <div class="muted">📍 {p.destination}, Kerala · <span class="cap">{p.type}</span> · <Stars value={p.rating_avg} count={p.rating_count} /></div>
            </div>
            <form method="post" action={`/saved/${p.id}`}><button class="btn btn-outline btn-sm">{saved.has(p.id) ? '♥ Saved' : '♡ Save'}</button></form>
          </div>
          {p.review_summary && <AiNote label="Guests say">{p.review_summary}</AiNote>}
          {highlights.length > 0 && <ul class="highlights">{highlights.map((h) => <li>{h}</li>)}</ul>}

          <section class="section-sm">
            <h2>About this property</h2>
            {description.split(/\n{2,}/).map((para) => <p>{para}</p>)}
          </section>

          <section class="section-sm">
            <h2>Rooms and rates</h2>
            <div class="rooms">
              {rooms.map((r) => (
                <div class="room card">
                  <div>
                    <h3>{r.name}</h3>
                    <div class="muted small">Sleeps {r.capacity}{r.bed_type ? ` · ${r.bed_type}` : ''}</div>
                    {r.inclusions && <div class="small">Includes: {r.inclusions}</div>}
                    <div class="chips">{parseJson<string[]>(r.facilities, []).map((f) => <span class="chip">{FACILITY_ICONS[f] ?? '•'} {FACILITIES[f] ?? f}</span>)}</div>
                  </div>
                  <div class="room-price">
                    <div class="price">{money(r.base_rate)}</div>
                    <div class="muted small">per night{r.weekend_rate && r.weekend_rate !== r.base_rate ? ` · weekends ${money(r.weekend_rate)}` : ''}</div>
                    <button class="btn btn-sm" data-pick-room={r.id}>Select</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section class="section-sm">
            <h2>Facilities</h2>
            <div class="facility-grid">{facilities.map((f) => <div>{FACILITY_ICONS[f] ?? '•'} {FACILITIES[f] ?? f}</div>)}</div>
            {meals.length > 0 && <p class="mt-sm"><strong>Meal plans:</strong> {meals.map((m) => MEAL_PLANS[m] ?? m).join(', ')}</p>}
          </section>

          <section class="section-sm">
            <h2>House rules</h2>
            <ul class="rules">
              <li>Check-in from <strong>{p.checkin_time}</strong>, check-out by <strong>{p.checkout_time}</strong></li>
              <li>{p.id_required ? 'Government photo ID required for all adults' : 'ID not required'}</li>
              <li>{p.pet_friendly ? 'Pets allowed' : 'No pets'} · {p.family_friendly ? 'Family-friendly' : 'Best for adults'}</li>
              {p.house_rules.split('\n').filter(Boolean).map((l) => <li>{l.replace(/^-\s*/, '')}</li>)}
            </ul>
            <h3>Cancellation policy</h3>
            <p>{p.cancellation_policy || 'Standard policy — see our cancellation page.'} <a href="/policies/cancellation">Full policy</a></p>
          </section>

          <section class="section-sm">
            <h2>Location</h2>
            {p.lat && p.lng && <div id="prop-map" class="map" data-lat={p.lat} data-lng={p.lng} data-name={p.name}></div>}
            {nearby.length > 0 && (
              <ul class="nearby">{nearby.map((n) => <li><span>{n.kind === 'railway' ? '🚆' : n.kind === 'airport' ? '✈️' : n.kind === 'bus' ? '🚌' : '📍'} {n.name}</span><span class="muted">{n.km} km</span></li>)}</ul>
            )}
          </section>

          <section class="section-sm">
            <h2>Availability</h2>
            <p class="muted small">Greyed-out dates are fully booked.</p>
            <div class="avail-cal" data-from={from} data-months="2"></div>
            {jsonScript('full-dates', fullDates)}
          </section>

          <section class="section-sm" id="ask">
            <h2>Ask about this property</h2>
            <div class="qa" data-qa={`/stay/${p.slug}/ask`}>
              <div class="qa-log" aria-live="polite">
                <div class="msg msg-ai">Hi! Ask me anything about {p.name} — breakfast, kids, parking, check-in…</div>
              </div>
              <form class="qa-form">
                <input name="q" maxlength={300} placeholder="Is breakfast included?" required autocomplete="off" />
                <button class="btn">Ask</button>
              </form>
              <form class="qa-handoff card" method="post" action="/enquiry" hidden>
                <p><strong>Let our team answer this.</strong> Leave your number and we'll reply on WhatsApp.</p>
                <input type="hidden" name="property_id" value={p.id} />
                <input type="hidden" name="message" value="" />
                <input type="hidden" name="source" value="chat" />
                <div class="row">
                  <input name="guest_name" placeholder="Your name" required />
                  <input name="phone" placeholder="WhatsApp number" required inputmode="tel" />
                </div>
                <input type="hidden" name="whatsapp_optin" value="1" />
                <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
                <button class="btn btn-sm">Send to team</button>
              </form>
            </div>
          </section>

          <section class="section-sm">
            <h2>Reviews {p.rating_count > 0 && <Stars value={p.rating_avg} count={p.rating_count} />}</h2>
            {reviews.length === 0 && <p class="muted">No reviews yet.</p>}
            {reviews.map((r) => (
              <div class="review">
                <div class="row-between"><strong>{r.guest_name}</strong><span class="stars">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span></div>
                <p>{r.body}</p>
                {parseJson<string[]>(r.photos, []).length > 0 && <div class="review-photos">{parseJson<string[]>(r.photos, []).map((k) => <img src={mediaUrl(k, 200)} alt="Guest photo" loading="lazy" />)}</div>}
                {r.reply && <div class="reply"><strong>Reply from Go Sanchari:</strong> {r.reply}</div>}
                <div class="muted small">{fmtDate(r.created_at)}</div>
              </div>
            ))}
          </section>
        </div>

        <aside class="booking-box card" id="book">
          <div class="price-line"><span class="price">{money(rooms[0]?.base_rate ?? 0)}</span> <span class="muted">/ night onwards</span></div>
          <form method="get" action="/book" class="stack" data-price-url={`/stay/${p.slug}/price`}>
            <Field label="Room">
              <Select name="room" id="room-select" value={rooms[0]?.id} options={rooms.map((r) => [r.id, `${r.name} (sleeps ${r.capacity})`])} />
            </Field>
            <div class="row">
              <Field label="Check-in"><input type="date" name="checkIn" value={checkIn} min={todayIST()} required /></Field>
              <Field label="Check-out"><input type="date" name="checkOut" value={checkOut} min={todayIST()} required /></Field>
            </div>
            <div class="row">
              <Field label="Adults"><input type="number" name="adults" min="1" max="40" value={Math.max(1, guests)} /></Field>
              <Field label="Children"><input type="number" name="children" min="0" max="20" value="0" /></Field>
              <Field label="Rooms"><input type="number" name="rooms" min="1" max="20" value="1" /></Field>
            </div>
            <div class="price-box" aria-live="polite"><span class="muted small">Pick dates to see the total.</span></div>
            <button class="btn btn-lg">Book Now</button>
            <a class="btn btn-outline" href={`/enquiry?property=${p.id}`} data-enquiry-link>Send Enquiry</a>
          </form>
        </aside>
      </div>

      {similar.length > 0 && (
        <section class="section">
          <h2>Similar properties</h2>
          <div class="grid grid-4">{similar.map((s) => <PropertyCard p={s} saved={saved.has(s.id)} transform={settings.images_transform} />)}</div>
        </section>
      )}
      <div class="mobile-book-bar">
        <div><span class="price">{money(rooms[0]?.base_rate ?? 0)}</span><span class="muted small"> /night</span></div>
        <a class="btn" href="#book">Book Now</a>
      </div>
      {jsonScript('ld', ld)}
    </div>
  ))
})

// Live price for the booking box (rule-based).
publicRoutes.post('/stay/:slug/price', async (c) => {
  const f = await form(c)
  if (!isDate(f.checkIn) || !isDate(f.checkOut)) return c.json({ errors: ['Pick your dates'] })
  const p = await priceStay(c.env, int(f.room), f.checkIn, f.checkOut, Math.max(1, int(f.rooms, 1)), f.coupon || null)
  return c.json(p)
})

// Property Q&A chat (AI Search over this property only).
publicRoutes.post('/stay/:slug/ask', async (c) => {
  if (!(await rateLimit(c.env, `qa:${clientIp(c)}`, 40, 3600))) return c.json({ answer: 'You have asked a lot of questions — please send us an enquiry and our team will help.', handoff: true })
  const p = await first<PropertyRow>(c.env, "SELECT * FROM properties WHERE slug = ? AND status = 'live'", c.req.param('slug'))
  if (!p) return c.json({ error: 'not found' }, 404)
  const f = await form(c)
  const q = str(f.q, 300)
  if (!q) return c.json({ error: 'empty' }, 400)
  return c.json(await propertyQA(c.env, p, q))
})

// ---------- 4. Enquiry ----------
publicRoutes.get('/enquiry', async (c) => {
  const user = c.get('user')
  const dests = await destinations(c.env)
  const props = await all<{ id: number; name: string; destination: string }>(c.env, "SELECT id, name, destination FROM properties WHERE status = 'live' ORDER BY destination, name")
  const pre = {
    destination: c.req.query('destination') ?? '',
    property: c.req.query('property') ?? '',
    checkIn: isDate(c.req.query('checkIn')) ? c.req.query('checkIn')! : '',
    checkOut: isDate(c.req.query('checkOut')) ? c.req.query('checkOut')! : '',
    adults: int(c.req.query('adults'), 2),
  }
  return page(c, { title: 'Send an enquiry', description: 'Tell us what you need and our team will find the right stay.' }, (
    <div class="wrap narrow section">
      <h1>Tell us what you're looking for</h1>
      <p class="muted">Our team replies on WhatsApp, usually within an hour (9am–9pm).</p>
      <form method="post" action="/enquiry" class="card stack">
        <div class="row">
          <Field label="Your name"><input name="guest_name" required maxlength={80} value={user?.name ?? ''} /></Field>
          <Field label="Phone (WhatsApp)"><input name="phone" required inputmode="tel" maxlength={20} value={user?.phone ?? ''} /></Field>
        </div>
        <Field label="Email (optional)"><input type="email" name="email" maxlength={120} value={user?.email ?? ''} /></Field>
        <div class="row">
          <Field label="Destination">
            <Select name="destination" value={pre.destination} options={[['', 'Not sure yet'], ...dests.map((d) => [d, d] as [string, string])]} />
          </Field>
          <Field label="Or a specific property">
            <Select name="property_id" value={pre.property} options={[['', '—'], ...props.map((p) => [p.id, `${p.name} (${p.destination})`] as [number, string])]} />
          </Field>
        </div>
        <div class="row">
          <Field label="Check-in"><input type="date" name="check_in" value={pre.checkIn} min={todayIST()} /></Field>
          <Field label="Check-out"><input type="date" name="check_out" value={pre.checkOut} min={todayIST()} /></Field>
        </div>
        <div class="row">
          <Field label="Adults"><input type="number" name="adults" min="1" max="60" value={pre.adults} /></Field>
          <Field label="Children"><input type="number" name="children" min="0" max="30" value="0" /></Field>
          <Field label="Total budget (₹)"><input type="number" name="budget" min="0" step="500" /></Field>
        </div>
        <Field label="Special requests"><textarea name="message" rows={4} maxlength={2000} placeholder="E.g. ground-floor room for elderly parents, vegetarian food, pickup from Aluva station…"></textarea></Field>
        <label class="check"><input type="checkbox" name="whatsapp_optin" value="1" checked /> Send me updates on WhatsApp</label>
        <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
        <button class="btn btn-lg">Send enquiry</button>
      </form>
    </div>
  ))
})

publicRoutes.post('/enquiry', async (c) => {
  const f = await form(c)
  const back = c.req.header('referer')?.includes('/stay/') ? new URL(c.req.header('referer')!).pathname : '/enquiry'
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, back, { err: 'Please complete the bot check and try again.' })
  if (!(await rateLimit(c.env, `enq:${clientIp(c)}`, 10, 3600))) return redirectMsg(c, back, { err: 'Too many enquiries from this connection. Please WhatsApp us instead.' })
  const phone = normalizePhone(f.phone)
  const name = str(f.guest_name, 80)
  if (!name || !phone) return redirectMsg(c, back, { err: 'Please enter your name and a valid phone number.' })
  const user = c.get('user')
  const email = str(f.email, 120) || null
  const userId = user && user.role === 'guest' ? user.id : await findOrCreateGuest(c.env, phone, name, email)
  const propertyId = int(f.property_id) || null
  let destination = str(f.destination, 60) || null
  if (propertyId && !destination) destination = (await first<{ destination: string }>(c.env, 'SELECT destination FROM properties WHERE id = ?', propertyId))?.destination ?? null
  const checkIn = isDate(f.check_in) ? f.check_in : null
  const checkOut = isDate(f.check_out) && checkIn && f.check_out > checkIn ? f.check_out : null
  const code = refCode('ENQ')
  const source = ['chat', 'website'].includes(f.source) ? f.source : 'website'
  const message = str(f.message, 2000)
  // Rule-based auto-assign: staff covering the destination with the fewest open enquiries.
  const assignee = await first<{ id: number }>(
    c.env,
    `SELECT u.id FROM users u LEFT JOIN staff_destinations sd ON sd.user_id = u.id
     WHERE u.role IN ('sales','manager') AND u.active = 1 AND (sd.destination = ? OR ? IS NULL)
     ORDER BY (SELECT COUNT(*) FROM enquiries e WHERE e.assigned_to = u.id AND e.status IN ('new','in_progress','quoted')) ASC LIMIT 1`,
    destination, destination,
  )
  const id = await insertId(
    c.env,
    `INSERT INTO enquiries (code, user_id, guest_name, phone, email, destination, property_id, check_in, check_out, adults, children, budget, message, source, whatsapp_optin, assigned_to, last_guest_msg_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, userId, name, phone, email, destination, propertyId, checkIn, checkOut, Math.max(1, int(f.adults, 2)), Math.max(0, int(f.children)),
    int(f.budget) || null, message, source, f.whatsapp_optin ? 1 : 0, assignee?.id ?? null, nowIso(),
  )
  if (message) await run(c.env, "INSERT INTO messages (enquiry_id, sender, user_id, channel, body) VALUES (?, 'guest', ?, 'website', ?)", id, userId, message)
  // AI tags + summary happen in the background so the guest never waits.
  await enqueue(c.env, { type: 'enquiry_ai', enquiryId: id })
  await notifyStaff(c.env, 'new_enquiry', `New enquiry ${code} from ${name}${destination ? ` for ${destination}` : ''}.`)
  if (c.req.header('accept')?.includes('application/json')) return c.json({ ok: true, code })
  return c.redirect(`/enquiry/thanks/${code}`, 303)
})

publicRoutes.get('/enquiry/thanks/:code', async (c) => {
  const s = await getSettings(c.env)
  return page(c, { title: 'Enquiry sent', noindex: true }, (
    <div class="wrap narrow section center">
      <div class="big-check">✓</div>
      <h1>Thank you! We've got your enquiry.</h1>
      <p>Your enquiry number is <strong class="code">{c.req.param('code')}</strong>.</p>
      <p class="muted">Our team will reply on WhatsApp soon. Need us faster? <a href={`https://wa.me/${s.business.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent('Hi, my enquiry number is ' + c.req.param('code'))}`}>Message us on WhatsApp</a>.</p>
      <a class="btn" href="/search">Keep browsing</a>
    </div>
  ))
})

// ---------- 5. Checkout ----------
publicRoutes.get('/book', async (c) => {
  const user = c.get('user')
  const url = new URL(c.req.url)
  if (!user) return redirectMsg(c, '/login?next=' + encodeURIComponent(url.pathname + url.search), { ok: 'Log in with your phone number to complete your booking.' })
  const roomId = int(c.req.query('room'))
  const checkIn = c.req.query('checkIn') ?? ''
  const checkOut = c.req.query('checkOut') ?? ''
  const adults = Math.max(1, int(c.req.query('adults'), 2))
  const children = Math.max(0, int(c.req.query('children')))
  const roomsCount = Math.max(1, int(c.req.query('rooms'), 1))
  const coupon = str(c.req.query('coupon'), 30).toUpperCase()
  const room = await first<RoomRow & { slug: string; property_name: string; destination: string; cancellation_policy: string; photo: string | null }>(
    c.env,
    `SELECT r.*, p.slug, p.name AS property_name, p.destination, p.cancellation_policy,
       (SELECT r2_key FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort LIMIT 1) AS photo
     FROM rooms r JOIN properties p ON p.id = r.property_id WHERE r.id = ? AND p.status = 'live'`,
    roomId,
  )
  if (!room || !isDate(checkIn) || !isDate(checkOut)) return redirectMsg(c, room ? `/stay/${room.slug}#book` : '/search', { err: 'Please choose a room and dates.' })
  const price = await priceStay(c.env, roomId, checkIn, checkOut, roomsCount, coupon || null)
  const blocking = price.errors.filter((e) => !e.toLowerCase().includes('coupon'))
  if (blocking.length) return redirectMsg(c, `/stay/${room.slug}?checkIn=${checkIn}&checkOut=${checkOut}#book`, { err: blocking[0] })
  if (adults + children > room.capacity * roomsCount) return redirectMsg(c, `/stay/${room.slug}?checkIn=${checkIn}&checkOut=${checkOut}#book`, { err: `${room.name} sleeps ${room.capacity} per room — add rooms for ${adults + children} guests.` })
  const pr = price
  const couponErr = price.errors.find((e) => e.toLowerCase().includes('coupon'))
  const qp = new URLSearchParams({ room: String(roomId), checkIn, checkOut, adults: String(adults), children: String(children), rooms: String(roomsCount) })

  return page(c, { title: 'Checkout', noindex: true }, (
    <div class="wrap section checkout">
      <h1>Confirm and pay</h1>
      <div class="prop-layout">
        <form method="post" action="/book" class="card stack prop-main">
          <h2>Guest details</h2>
          <div class="row">
            <Field label="Full name"><input name="guest_name" required maxlength={80} value={user.name} /></Field>
            <Field label="Phone"><input name="guest_phone" required inputmode="tel" value={user.phone ?? ''} /></Field>
          </div>
          <div class="row">
            <Field label="Email"><input type="email" name="guest_email" value={user.email ?? ''} /></Field>
            <Field label="ID type (optional)"><Select name="id_type" options={[['', 'Choose later'], ['aadhaar', 'Aadhaar'], ['passport', 'Passport'], ['driving_licence', 'Driving licence'], ['voter_id', 'Voter ID']]} /></Field>
          </div>
          <Field label="Special requests"><textarea name="special_requests" rows={3} maxlength={1000}></textarea></Field>
          <h3>Cancellation policy</h3>
          <p class="small">{room.cancellation_policy || 'Free cancellation up to 7 days before check-in. 50% refund 3–7 days before. No refund within 3 days.'} <a href="/policies/cancellation" target="_blank">Full policy</a></p>
          <label class="check"><input type="checkbox" name="agree" value="1" required /> I agree to the <a href="/policies/terms" target="_blank">terms</a> and cancellation policy</label>
          {[...qp.entries()].map(([k, v]) => <input type="hidden" name={k} value={v} />)}
          <input type="hidden" name="coupon" value={couponErr ? '' : coupon} />
          <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
          <button class="btn btn-lg">Pay Now {money(pr.total)}</button>
          <p class="muted small">Secure payment by UPI, card or net banking. Your room is held for a few minutes while you pay.</p>
        </form>
        <aside class="card booking-box">
          <img class="summary-img" src={mediaUrl(room.photo, 500)} alt="" />
          <h3>{room.property_name}</h3>
          <p class="muted small">{room.destination} · {room.name} × {roomsCount}</p>
          <p>{fmtDate(checkIn)} → {fmtDate(checkOut)}<br />{pr.nights} night{pr.nights > 1 ? 's' : ''} · {adults} adult{adults > 1 ? 's' : ''}{children ? `, ${children} child${children > 1 ? 'ren' : ''}` : ''}</p>
          <table class="breakdown">
            <tr><td>Room charges</td><td>{money(pr.subtotal)}</td></tr>
            {pr.discount > 0 && <tr><td>{pr.discountLabel}</td><td>− {money(pr.discount)}</td></tr>}
            <tr><td>GST ({pr.taxRate}%)</td><td>{money(pr.taxes)}</td></tr>
            <tr class="total"><td>Total</td><td>{money(pr.total)}</td></tr>
          </table>
          <form method="get" action="/book" class="row coupon-form">
            {[...qp.entries()].map(([k, v]) => <input type="hidden" name={k} value={v} />)}
            <input name="coupon" placeholder="Coupon code" value={coupon} maxlength={30} />
            <button class="btn btn-sm btn-outline">Apply</button>
          </form>
          {couponErr && <p class="error small">{couponErr}</p>}
          {coupon && !couponErr && pr.discount > 0 && <p class="ok small">Coupon applied.</p>}
        </aside>
      </div>
    </div>
  ))
})

publicRoutes.post('/book', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login', 303)
  const f = await form(c)
  const back = `/book?${new URLSearchParams({ room: f.room, checkIn: f.checkIn, checkOut: f.checkOut, adults: f.adults, children: f.children, rooms: f.rooms })}`
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, back, { err: 'Please complete the bot check.' })
  if (!f.agree) return redirectMsg(c, back, { err: 'Please accept the terms.' })
  const phone = normalizePhone(f.guest_phone)
  if (!phone || !str(f.guest_name)) return redirectMsg(c, back, { err: 'Please enter the guest name and a valid phone.' })
  if (!isDate(f.checkIn) || !isDate(f.checkOut)) return redirectMsg(c, back, { err: 'Invalid dates.' })
  const r = await createBooking(c.env, {
    roomId: int(f.room), checkIn: f.checkIn, checkOut: f.checkOut, adults: Math.max(1, int(f.adults, 1)), children: Math.max(0, int(f.children)),
    roomsCount: Math.max(1, int(f.rooms, 1)), couponCode: f.coupon || null, guestName: str(f.guest_name, 80), guestPhone: phone,
    guestEmail: str(f.guest_email, 120) || null, idType: f.id_type || null, specialRequests: str(f.special_requests, 1000), userId: user.id,
  })
  if ('error' in r) return redirectMsg(c, back, { err: r.error })
  return c.redirect(`/pay/${r.code}`, 303)
})

// ---------- 8. Offers ----------
publicRoutes.get('/offers', async (c) => {
  const offers = await all<{ code: string; title: string; description: string; discount_type: string; discount_value: number; max_discount: number | null; min_amount: number; valid_from: string; valid_to: string; property_ids: string | null }>(
    c.env,
    'SELECT * FROM coupons WHERE active = 1 AND public = 1 AND valid_to >= ? AND (usage_limit IS NULL OR used_count < usage_limit) ORDER BY valid_to',
    todayIST(),
  )
  const props = await all<{ id: number; name: string; slug: string }>(c.env, "SELECT id, name, slug FROM properties WHERE status = 'live'")
  const byId = new Map(props.map((p) => [p.id, p]))
  return page(c, { title: 'Offers', description: 'Current offers and coupon codes for Kerala stays.' }, (
    <div class="wrap section">
      <h1>Current offers</h1>
      {offers.length === 0 && <Empty>No offers right now — check back soon, or <a href="/enquiry">ask us for a deal</a>.</Empty>}
      <div class="grid grid-3">
        {offers.map((o) => {
          const ids = parseJson<number[] | null>(o.property_ids, null)
          return (
            <div class="card offer-card">
              <div class="offer-amt">{o.discount_type === 'pct' ? `${o.discount_value}% off` : `${money(o.discount_value)} off`}</div>
              <h3>{o.title || o.code}</h3>
              <p>{o.description}</p>
              <p>Code: <code class="code">{o.code}</code></p>
              <p class="muted small">Valid {fmtDate(o.valid_from)} – {fmtDate(o.valid_to)}{o.min_amount ? ` · min booking ${money(o.min_amount)}` : ''}{o.max_discount ? ` · up to ${money(o.max_discount)}` : ''}</p>
              <p class="small">Applies to: {ids?.length ? ids.map((id) => byId.get(id)).filter(Boolean).map((p, i) => <>{i > 0 && ', '}<a href={`/stay/${p!.slug}`}>{p!.name}</a></>) : 'all properties'}</p>
            </div>
          )
        })}
      </div>
    </div>
  ))
})

// ---------- 9. About / Contact / Policies ----------
publicRoutes.get('/about', async (c) => {
  const [content, s] = await Promise.all([getContent(c.env), getSettings(c.env)])
  return page(c, { title: 'About us', description: `About ${s.business.name}` }, (
    <div class="wrap narrow section prose">
      <h1>About {s.business.name}</h1>
      {(content.about || 'We are a Kerala-based team that personally checks every stay we list.').split(/\n{2,}/).map((p) => <p>{p}</p>)}
      <p><a class="btn" href="/contact">Contact us</a></p>
    </div>
  ))
})

publicRoutes.get('/contact', async (c) => {
  const s = await getSettings(c.env)
  const content = await getContent(c.env)
  return page(c, { title: 'Contact', description: `Contact ${s.business.name}` }, (
    <div class="wrap narrow section">
      <h1>Contact us</h1>
      <div class="grid grid-2">
        <div class="card">
          <h3>Talk to us</h3>
          <p>📞 <a href={`tel:${s.business.phone.replace(/\s/g, '')}`}>{s.business.phone}</a></p>
          <p>💬 <a href={`https://wa.me/${s.business.whatsapp.replace(/\D/g, '')}`}>WhatsApp us</a></p>
          <p>✉️ <a href={`mailto:${s.business.email}`}>{s.business.email}</a></p>
          <p>🏢 {s.business.address}</p>
        </div>
        <div class="card">
          <h3>Need help with a stay?</h3>
          <p>Send an enquiry and our team will find the right place.</p>
          <a class="btn" href="/enquiry">Send enquiry</a>
          <p class="mt-sm"><a href="/help">Chat with our assistant</a></p>
        </div>
      </div>
      {content.faqs.length > 0 && (
        <section class="section-sm">
          <h2>FAQs</h2>
          {content.faqs.map((f) => <details class="faq"><summary>{f.q}</summary><p>{f.a}</p></details>)}
        </section>
      )}
    </div>
  ))
})

publicRoutes.get('/policies/:kind', async (c) => {
  const kind = c.req.param('kind') as 'privacy' | 'cancellation' | 'terms'
  const titles = { privacy: 'Privacy policy', cancellation: 'Cancellation and refund policy', terms: 'Terms and conditions' }
  if (!(kind in titles)) return c.notFound()
  const content = await getContent(c.env)
  const text = content.policies[kind] || 'This policy is being updated. Please contact us for details.'
  return page(c, { title: titles[kind] }, (
    <div class="wrap narrow section prose">
      <h1>{titles[kind]}</h1>
      {text.split(/\n{2,}/).map((p) => (p.startsWith('## ') ? <h2>{p.slice(3)}</h2> : <p>{p}</p>))}
    </div>
  ))
})

// ---------- Wishlist toggle ----------
publicRoutes.post('/saved/:id', async (c) => {
  const user = c.get('user')
  const back = c.req.header('referer') ? new URL(c.req.header('referer')!).pathname + new URL(c.req.header('referer')!).search : '/my/saved'
  if (!user) return redirectMsg(c, '/login?next=' + encodeURIComponent(back), { ok: 'Log in to save properties.' })
  const pid = int(c.req.param('id'))
  const existing = await first(c.env, 'SELECT 1 FROM wishlist WHERE user_id = ? AND property_id = ?', user.id, pid)
  if (existing) await run(c.env, 'DELETE FROM wishlist WHERE user_id = ? AND property_id = ?', user.id, pid)
  else {
    const price = await first<{ p: number }>(c.env, 'SELECT MIN(base_rate) AS p FROM rooms WHERE property_id = ? AND active = 1', pid)
    await run(c.env, 'INSERT OR IGNORE INTO wishlist (user_id, property_id, saved_price) VALUES (?, ?, ?)', user.id, pid, price?.p ?? null)
  }
  return c.redirect(back, 303)
})

// ---------- 14. Quotation view (public link from WhatsApp) ----------
async function loadQuote(env: AppEnv['Bindings'], token: string) {
  const q = await first<QuotationRow>(env, 'SELECT * FROM quotations WHERE token = ?', token)
  if (!q) return null
  const options = await all<QuoteOptionRow & { property_name: string; slug: string; destination: string; room_name: string; photo: string | null; description: string }>(
    env,
    `SELECT o.*, p.name AS property_name, p.slug, p.destination, p.description, r.name AS room_name,
       (SELECT r2_key FROM property_photos ph WHERE ph.property_id = p.id ORDER BY sort LIMIT 1) AS photo
     FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE o.quotation_id = ? ORDER BY o.id`,
    q.id,
  )
  return { q, options }
}

publicRoutes.get('/q/:token', async (c) => {
  const data = await loadQuote(c.env, c.req.param('token'))
  if (!data || data.q.status === 'draft' || data.q.status === 'pending_approval') return page(c, { title: 'Quote not found', noindex: true }, <div class="wrap section"><Empty><h2>This quote link is not valid.</h2></Empty></div>, 404)
  const { q, options } = data
  const user = c.get('user')
  const viewerIsStaff = user && user.role !== 'guest'
  if (!viewerIsStaff) {
    await run(c.env, "UPDATE quotations SET view_count = view_count + 1, last_viewed_at = ?, status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ?", nowIso(), q.id)
  }
  const expired = q.status === 'expired' || (q.valid_till != null && q.valid_till < todayIST())
  const closed = expired || ['accepted', 'declined'].includes(q.status)
  const photos = await all<{ property_id: number; r2_key: string }>(c.env, `SELECT property_id, r2_key FROM property_photos WHERE property_id IN (${options.map(() => '?').join(',') || 'NULL'}) ORDER BY sort LIMIT 30`, ...options.map((o) => o.property_id))

  return page(c, { title: `Your quote ${q.code}`, noindex: true }, (
    <div class="wrap narrow section">
      <p class="muted small">Quote {q.code} for {q.guest_name}</p>
      <h1>Your stay quote</h1>
      {q.explainer && <AiNote label="In short">{q.explainer}</AiNote>}
      {q.valid_till && <p class={expired ? 'error' : 'muted'}>{expired ? 'This quote has expired' : `Valid till ${fmtDate(q.valid_till)}`}</p>}
      {q.status === 'accepted' && <div class="flash flash-ok">You accepted this quote. See <a href="/my/bookings">your bookings</a>.</div>}
      {q.message && <div class="card"><p style="white-space:pre-line">{q.message}</p></div>}
      {options.map((o, i) => (
        <div class="card quote-option">
          <div class="quote-photos">{photos.filter((ph) => ph.property_id === o.property_id).slice(0, 3).map((ph) => <img src={mediaUrl(ph.r2_key, 400)} alt="" loading="lazy" />)}</div>
          <h2>{options.length > 1 && `Option ${i + 1}: `}{o.property_name}</h2>
          <p class="muted">{o.destination} · {o.room_name} × {o.rooms_count} · {o.meal_plan ? MEAL_PLANS[o.meal_plan] ?? o.meal_plan : 'Room only'}</p>
          <p>{fmtDate(o.check_in)} → {fmtDate(o.check_out)} · {nightsBetween(o.check_in, o.check_out)} nights · {o.adults} adults{o.children ? `, ${o.children} children` : ''}</p>
          <table class="breakdown">
            <tr><td>Room charges</td><td>{money(o.subtotal)}</td></tr>
            {o.discount > 0 && <tr><td>Discount</td><td>− {money(o.discount)}</td></tr>}
            {o.extra_charges > 0 && <tr><td>{o.extra_label || 'Extras'}</td><td>{money(o.extra_charges)}</td></tr>}
            <tr><td>GST</td><td>{money(o.taxes)}</td></tr>
            <tr class="total"><td>Total</td><td>{money(o.total)}</td></tr>
          </table>
          <a href={`/stay/${o.slug}`} target="_blank" class="small">View property details →</a>
          {!closed && (
            <form method="post" action={`/q/${q.token}/accept`} class="mt-sm">
              <input type="hidden" name="option" value={o.id} />
              <button class="btn btn-lg">Accept and Pay {money(o.total)}</button>
            </form>
          )}
        </div>
      ))}
      {(q.inclusions || q.exclusions || q.payment_terms) && (
        <div class="card">
          {q.inclusions && <><h3>Included</h3><p style="white-space:pre-line">{q.inclusions}</p></>}
          {q.exclusions && <><h3>Not included</h3><p style="white-space:pre-line">{q.exclusions}</p></>}
          {q.payment_terms && <><h3>Payment terms</h3><p style="white-space:pre-line">{q.payment_terms}</p></>}
        </div>
      )}
      {!closed && (
        <div class="grid grid-2">
          <form method="post" action={`/q/${q.token}/feedback`} class="card stack">
            <h3>Ask a question or request changes</h3>
            <textarea name="message" rows={3} required maxlength={1000} placeholder="E.g. Can we check in a day later?"></textarea>
            <button class="btn btn-outline">Send to our team</button>
          </form>
          <form method="post" action={`/q/${q.token}/decline`} class="card stack">
            <h3>Not interested?</h3>
            <textarea name="message" rows={2} maxlength={500} placeholder="Optional: tell us why"></textarea>
            <button class="btn btn-outline btn-danger">Decline quote</button>
          </form>
        </div>
      )}
    </div>
  ))
})

publicRoutes.post('/q/:token/accept', async (c) => {
  const token = c.req.param('token')
  const data = await loadQuote(c.env, token)
  if (!data) return c.notFound()
  const { q, options } = data
  if (['accepted', 'declined', 'expired', 'draft', 'pending_approval'].includes(q.status) || (q.valid_till && q.valid_till < todayIST())) return redirectMsg(c, `/q/${token}`, { err: 'This quote can no longer be accepted.' })
  const f = await form(c)
  const o = options.find((x) => x.id === int(f.option))
  if (!o) return redirectMsg(c, `/q/${token}`, { err: 'Choose an option.' })
  // Re-use an unpaid booking for this quote option if the guest comes back.
  const existing = await first<{ code: string }>(c.env, "SELECT code FROM bookings WHERE quotation_id = ? AND room_id = ? AND status = 'pending' AND hold_expires_at > ?", q.id, o.room_id, nowIso())
  if (existing) return c.redirect(`/pay/${existing.code}?t=${token}`, 303)
  const userId = q.user_id ?? (await findOrCreateGuest(c.env, q.phone, q.guest_name, q.email))
  const r = await createBooking(c.env, {
    roomId: o.room_id, checkIn: o.check_in, checkOut: o.check_out, adults: o.adults, children: o.children, roomsCount: o.rooms_count,
    guestName: q.guest_name, guestPhone: q.phone ?? '', guestEmail: q.email, userId, source: 'quotation', mealPlan: o.meal_plan,
    quotationId: q.id, enquiryId: q.enquiry_id, staffId: q.staff_id,
    fixedPrice: { subtotal: o.subtotal, discount: o.discount, extraCharges: o.extra_charges, taxes: o.taxes, total: o.total },
  })
  if ('error' in r) return redirectMsg(c, `/q/${token}`, { err: r.error + ' Please ask our team for another option.' })
  await run(c.env, 'UPDATE quotations SET accepted_option_id = ? WHERE id = ?', o.id, q.id)
  return c.redirect(`/pay/${r.code}?t=${token}`, 303)
})

async function quoteFeedback(c: Context<AppEnv>, status: 'changes_requested' | 'declined') {
  const token = c.req.param('token')!
  const q = await first<QuotationRow>(c.env, 'SELECT * FROM quotations WHERE token = ?', token)
  if (!q) return c.notFound()
  const f = await form(c)
  const msg = str(f.message, 1000)
  await run(c.env, 'UPDATE quotations SET status = ?, guest_feedback = ?, updated_at = ? WHERE id = ?', status, msg || null, nowIso(), q.id)
  if (q.enquiry_id) {
    await run(c.env, "INSERT INTO messages (enquiry_id, sender, channel, body) VALUES (?, 'guest', 'website', ?)", q.enquiry_id, `${status === 'declined' ? 'Declined quote' : 'Asked for changes on quote'} ${q.code}${msg ? ': ' + msg : ''}`)
    await run(c.env, "UPDATE enquiries SET waiting_on = 'us', last_guest_msg_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), q.enquiry_id)
  }
  if (q.staff_id) {
    await run(c.env, "INSERT INTO tasks (assigned_to, enquiry_id, quotation_id, guest_name, phone, reason, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)", q.staff_id, q.enquiry_id, q.id, q.guest_name, q.phone, status === 'declined' ? `Quote ${q.code} declined — ask why / offer alternative` : `Guest asked for changes on ${q.code}`, nowIso())
  }
  await logActivity(c.env, null, `quote.${status}`, 'quotation', q.id, { message: msg })
  return redirectMsg(c, `/q/${token}`, { ok: status === 'declined' ? 'Thanks for letting us know.' : 'Sent! Our team will get back to you shortly.' })
}
publicRoutes.post('/q/:token/feedback', (c) => quoteFeedback(c, 'changes_requested'))
publicRoutes.post('/q/:token/decline', (c) => quoteFeedback(c, 'declined'))

// ---------- Media from R2 ----------
publicRoutes.get('/media/*', async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^\/media\//, ''))
  if (!key || key.includes('..') || key.startsWith('invoices/') || key.startsWith('voice/') || key.startsWith('private/')) return c.notFound()
  const obj = await c.env.MEDIA.get(key)
  if (!obj) return c.notFound()
  const h = new Headers()
  obj.writeHttpMetadata(h)
  h.set('etag', obj.httpEtag)
  h.set('cache-control', 'public, max-age=31536000, immutable')
  return new Response(obj.body, { headers: h })
})

