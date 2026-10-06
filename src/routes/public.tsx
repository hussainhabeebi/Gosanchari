// Public pages (1–9) and the public quotation link (14).

import { Hono, type Context } from 'hono'
import { extrasLabel, COVER_ORDER, COVER_PHOTO_SQL, dining as readDining, PHOTO_CATEGORIES, POLICY_FIELDS, policies as readPolicies, ROOM_AMENITIES, STAY_TYPES, stayTypeLabel, THEMES, videoEmbedUrl } from '../lib/catalog'
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
import { addDays, eachNight, fmtDate, fmtShortDate, int, isDate, money, nightsBetween, normalizePhone, nowIso, parseJson, refCode, str, todayIST } from '../lib/util'
import { clientIp, form, redirectMsg } from './helpers'

export const publicRoutes = new Hono<AppEnv>()

const NEARBY_ICONS: Record<string, string> = { railway: '🚆', airport: '✈️', bus: '🚌', hospital: '🏥', atm: '🏧', shopping: '🛍', restaurant: '🍽', beach: '🏖', waterfall: '💧', viewpoint: '🌄', attraction: '📍' }

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
      <section class="hero reference-hero">
        <div class="wrap">
          <div class="hero-copy"><span class="eyebrow">EXPLORE · STAY · UNWIND</span><h1>Discover Kerala,<em>Your Way</em></h1><p>Handpicked stays, scenic destinations and unforgettable<br /> experiences across Kerala.</p></div>
          <form class="searchbox reference-search" method="get" action="/search" data-stay-search>
            <Field label="⌖ Destination"><Select name="destination" value={destNames.includes('Munnar') ? 'Munnar' : ''} options={[['', 'Anywhere in Kerala'], ...destNames.map((d) => [d, d] as [string, string])]} /></Field>
            <Field label="▣ Check-in"><input type="date" name="checkIn" min={today} /></Field>
            <Field label="▣ Check-out"><input type="date" name="checkOut" min={today} /></Field>
            <details class="guest-picker"><summary><span class="field-label">♙ Guests</span><strong data-guest-summary>2 Adults, 0 Kids</strong></summary><div class="guest-panel"><Field label="Adults"><input name="guests" type="number" min="1" max="40" value="2" /></Field><Field label="Children"><input name="children" type="number" min="0" max="20" value="0" /></Field></div></details>
            <button class="btn find-stay">⌕ &nbsp; Find My Stay</button>
          </form>
          <div class="trust-strip"><span>✦ <strong>Best Price Guarantee</strong><small>Unbeatable Deals</small></span><span>♧ <strong>24/7 Support</strong><small>We're always here</small></span><span>◇ <strong>Trusted Partner</strong><small>Verified Resorts</small></span><span>★ <strong>Curated Experiences</strong><small>Handpicked Stays</small></span></div>
        </div>
      </section>
      <section class="wrap section popular-stays">
        <div class="row-between"><div><h2>Popular <span>Stays</span></h2><p class="muted">Handpicked stays for your perfect getaway</p></div><a class="btn btn-outline" href="/search">View All Stays →</a></div>
        <div class="stay-carousel"><button type="button" class="carousel-arrow" data-carousel="-1" aria-label="Previous stays">←</button><div class="grid grid-4" data-stay-track>{featured.map((p) => <PropertyCard p={p} saved={saved.has(p.id)} transform={settings.images_transform} />)}</div><button type="button" class="carousel-arrow" data-carousel="1" aria-label="Next stays">→</button></div>
      </section>
      <section class="wrap section" id="destinations"><h2>Popular destinations</h2><div class="grid grid-4">{dests.map((d) => <a class="dest" href={`/search?destination=${encodeURIComponent(d.name)}`}><img src={mediaUrl(d.image, 500, settings.images_transform)} alt={d.name} loading="lazy" /><div class="dest-label"><strong>{d.name}</strong><span>{d.n} stays</span></div></a>)}</div></section>

      {(offers.length > 0 || content.banners.length > 0) && (
        <section class="wrap section">
          <div class="offer-strip">
            {content.banners.map((b) => (
              <a class="offer" href={b.link}><strong>{b.title}</strong><span>{b.text}</span></a>
            ))}
            {offers.map((o) => (
              <a class="offer" href="/offers">
                <strong>{o.title || (o.discount_type === 'pct' ? `${o.discount_value}% off` : `${money(o.discount_value)} off`)}</strong>
                <span>Mention <code>{o.code}</code> in your enquiry · till {fmtDate(o.valid_to)}</span>
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
  if (c.req.query('children')) qs.set('children', String(Math.max(0, Math.min(20, int(c.req.query('children'))))))
  const view = c.req.query('view') === 'map' ? 'map' : 'list'
  const baseParams = filtersToParams(f)
  const mapParams = new URLSearchParams(baseParams); mapParams.set('view', view === 'map' ? 'list' : 'map')
  // Each understood filter as a chip; tapping it removes just that filter.
  const without = (drop: (k: string, v: string) => boolean) => {
    const p = new URLSearchParams([...baseParams.entries()].filter(([k, v]) => !drop(k, v)))
    if (understood) p.set('understood', understood)
    return `/search?${p}`
  }
  const chips: [string, string][] = [
    ...(f.destination ? [[`📍 ${f.destination}`, without((k) => k === 'destination')] as [string, string]] : []),
    ...(f.checkIn && f.checkOut ? [[`📅 ${fmtShortDate(f.checkIn)} – ${fmtShortDate(f.checkOut)}`, without((k) => k === 'checkIn' || k === 'checkOut')] as [string, string]] : []),
    ...(f.guests ? [[`👥 ${f.guests} guest${f.guests === 1 ? '' : 's'}`, without((k) => k === 'guests')] as [string, string]] : []),
    ...(f.priceMax ? [[`Under ${money(f.priceMax)}/night`, without((k) => k === 'priceMax')] as [string, string]] : []),
    ...(f.types ?? []).map((t) => [STAY_TYPES[t] ?? t, without((k, v) => k === 'type' && v === t)] as [string, string]),
    ...(f.facilities ?? []).map((x) => [FACILITIES[x] ?? x, without((k, v) => k === 'facility' && v === x)] as [string, string]),
    ...(f.mealPlan ? [[MEAL_PLANS[f.mealPlan] ?? f.mealPlan, without((k) => k === 'meal')] as [string, string]] : []),
    ...(f.family ? [['Family-friendly', without((k) => k === 'family')] as [string, string]] : []),
    ...(f.pet ? [['Pet-friendly', without((k) => k === 'pet')] as [string, string]] : []),
    // The free-text "vibe" only re-orders results; hide it when it just repeats a filter (e.g. "family").
    ...(f.q && !/^(?:(?:famil\w*|kids?|pool|budget)\s*)+$/i.test(f.q) ? [[`“${f.q}”`, without((k) => k === 'q')] as [string, string]] : []),
  ]
  // Nothing found: show which single filter to drop and how many stays that gives.
  const relax = results.length ? [] : (await Promise.all(chips.slice(0, 6).map(async ([label, href]) => {
    const p = new URL(href, 'http://x').searchParams
    const ff: Record<string, string | string[]> = {}
    for (const k of new Set(p.keys())) { const v = p.getAll(k); ff[k] = v.length > 1 ? v : v[0] }
    const n = (await searchProperties(c.env, filtersFromQuery(ff), 30)).length
    return [label, href, n] as [string, string, number]
  }))).filter(([, , n]) => n > 0).sort((a, b) => b[2] - a[2]).slice(0, 3)
  const reasonsFor = (p: (typeof results)[number]) => {
    const fac = parseJson<string[]>(p.facilities, [])
    const price = p.stay_price ?? p.from_price
    return [
      ...(f.facilities ?? []).filter((x) => fac.includes(x)).map((x) => FACILITIES[x] ?? x),
      ...(f.types?.length && f.types.includes(p.type) ? [STAY_TYPES[p.type] ?? p.type] : []),
      ...(f.priceMax && price && price <= f.priceMax ? [`Under ${money(f.priceMax)}`] : []),
      ...(f.checkIn && p.stay_price ? ['Free on your dates'] : []),
      ...(p.rating_avg >= 4.5 ? [`Rated ${p.rating_avg.toFixed(1)}★`] : []),
    ].slice(0, 4)
  }

  return page(c, { title: f.destination ? `Stays in ${f.destination}` : 'Find a stay', description: `Homestays, villas, resorts and houseboats${f.destination ? ' in ' + f.destination : ' in Kerala'}.`, head: view === 'map' ? <LeafletHead /> : undefined }, (
    <><section class="destination-hero"><div class="wrap"><span class="eyebrow">DESTINATION</span><h1>{f.destination || 'Kerala'}</h1><p>MISTY MOUNTAINS, ENDLESS MEMORIES</p></div></section><div class="wrap search-page">
      <input type="checkbox" id="filters-toggle" class="nav-toggle" />
      <aside class="filters">
        <label for="filters-toggle" class="filters-close">✕ Close</label>
        <form method="get" action="/search" class="stack">
          <h3>Filter by</h3>
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
            {PROPERTY_TYPES.map((t) => <label class="check"><input type="checkbox" name="type" value={t} checked={f.types?.includes(t)} /> {STAY_TYPES[t]}</label>)}
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
        <form class="ai-search search-top" method="get" action="/search" role="search">
          <span class="ai-badge">AI</span>
          <input name="ai" maxlength={200} value={understood ?? ''} placeholder="Describe your stay — place, dates, guests, budget, must-haves" aria-label="Describe your stay" required />
          <button class="btn btn-sm">Search</button>
        </form>
        {chips.length > 0 && (
          <div class="filter-chips" aria-label="Your search">
            {understood && <span class="muted small">We understood:</span>}
            {chips.map(([label, href]) => <a class="chip chip-x" href={href} title="Remove">{label} <span aria-hidden="true">✕</span></a>)}
            <a class="small" href="/search">Clear all</a>
          </div>
        )}
        {!f.checkIn && results.length > 0 && (
          <form method="get" action="/search" class="add-dates">
            {[...baseParams.entries()].filter(([k]) => k !== 'checkIn' && k !== 'checkOut').map(([k, v]) => <input type="hidden" name={k} value={v} />)}
            <span class="small"><strong>Add your dates</strong> to see exact prices and free rooms:</span>
            <input type="date" name="checkIn" min={todayIST()} required aria-label="Check-in" />
            <input type="date" name="checkOut" min={todayIST()} required aria-label="Check-out" />
            <button class="btn btn-sm">Show prices</button>
          </form>
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
          <div class="grid grid-3">{results.map((p) => <PropertyCard p={p} saved={saved.has(p.id)} qs={qs.toString()} transform={settings.images_transform} reasons={reasonsFor(p)} />)}</div>
        ) : (
          <Empty>
            <h3>No stays match all your filters</h3>
            {relax.length > 0 && (
              <div class="relax">
                <p>Try without one of these:</p>
                {relax.map(([label, href, n]) => <a class="btn btn-sm btn-outline" href={href}>Remove {label.replace(/^[^\w“₹]+/u, '')} → {n} stay{n === 1 ? '' : 's'}</a>)}
              </div>
            )}
            <p>Or send us an enquiry and our team will find one for you.</p>
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
    </div></>
  ))
})

// ---------- 3. Property details ----------
publicRoutes.get('/stay/:slug', async (c) => {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE slug = ?', c.req.param('slug'))
  const user = c.get('user')
  const isStaffUser = !!user && user.role !== 'guest'
  if (!p || (p.status !== 'live' && !isStaffUser)) return page(c, { title: 'Not found' }, <div class="wrap section"><Empty><h2>This stay is not available</h2><a href="/search">Browse stays</a></Empty></div>, 404)
  const settings = await getSettings(c.env)
  const [media, rooms, reviews, similar, saved] = await Promise.all([
    all<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort, id', p.id),
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? AND active = 1 ORDER BY base_rate', p.id),
    all<ReviewRow>(c.env, "SELECT * FROM reviews WHERE property_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 20", p.id),
    similarProperties(c.env, p.id, 4),
    savedIds(c),
  ])
  const photos = media.filter((m) => m.media_type !== 'video' && m.r2_key).sort((a, b) => COVER_ORDER.indexOf(a.category) - COVER_ORDER.indexOf(b.category) || a.sort - b.sort)
  // Promote the existing exterior cover once; retain all other photo ordering.
  const facadeIndex = photos.findIndex((photo) => photo.category === 'facade')
  if (facadeIndex > 0) photos.unshift(...photos.splice(facadeIndex, 1))
  const videos = media.filter((m) => m.media_type === 'video')
  const mediaGroups = Object.keys(PHOTO_CATEGORIES).map((k) => [k, photos.filter((m) => m.category === k)] as const).filter(([k, list]) => list.length && k !== 'room')
  const din = readDining(p.dining)
  const pol = readPolicies(p.policies)
  const themes = parseJson<string[]>(p.themes, [])
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
    hideJourneyBanner: true,
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
        {(photos.length > 5 || videos.length > 0) && <a class="btn btn-sm g-all" href="#photos">See all {photos.length} photos{videos.length ? ` & ${videos.length} video${videos.length > 1 ? 's' : ''}` : ''}</a>}
      </div>

      <h1 class="property-title">{p.name}</h1>
      <div class="prop-layout">
        <div class="prop-main">
          <div class="property-summary">
            <div class="muted">📍 {p.destination}, Kerala · {stayTypeLabel(p)}{p.star_category ? ` · ${'★'.repeat(p.star_category)}` : ''} · <Stars value={p.rating_avg} count={p.rating_count} /></div>
            {themes.length > 0 && <div class="chips mt-sm">{themes.map((t) => <span class="chip">{THEMES[t] ?? t}</span>)}</div>}
          </div>

          <section class="section-sm">
            <h2>About this property</h2>
            {p.review_summary && <AiNote label="Guests say">{p.review_summary}</AiNote>}
            {highlights.length > 0 && <ul class="highlights">{highlights.map((h) => <li>{h}</li>)}</ul>}
            {description.split(/\n{2,}/).map((para) => <p>{para}</p>)}
            {p.built_year && (
              <dl class="info-list">
                <dt>Built / renovated</dt><dd>{p.built_year}</dd>
              </dl>
            )}
            {p.good_to_know && <div class="flash mt-sm"><strong>Good to know:</strong> {p.good_to_know}</div>}
          </section>

          <section class="section-sm" id="rooms">
            <h2>Room categories</h2>
            <div class="rooms">
              {rooms.map((r) => {
                const rp = photos.filter((m) => m.room_id === r.id)
                const am = parseJson<string[]>(r.facilities, [])
                return (
                  <div class="room card">
                    <div class="grow">
                      <h3>{r.name}</h3>
                      {rp.length > 0 && <div class="room-photos" data-gallery>{rp.map((m) => <a href={mediaUrl(m.r2_key, 1600, settings.images_transform)} data-full><img src={mediaUrl(m.r2_key, 300, settings.images_transform)} alt={m.caption ?? r.name} loading="lazy" /></a>)}</div>}
                      <div class="room-meta">
                        <span>👥 {(r.base_guests ?? r.capacity) < r.capacity ? `Rate for ${r.base_guests} guests · up to ${r.capacity}` : `Up to ${r.capacity} guests`}{r.max_adults ? ` (max ${r.max_adults} adults` + (r.max_children != null ? `, ${r.max_children} children)` : ')') : ''}</span>
                        {r.bed_type && <span>🛏 {r.bed_type}</span>}
                        {r.size_sqft && <span>📐 {r.size_sqft} sq ft</span>}
                        {r.room_view && <span>🪟 {r.room_view} view</span>}
                        <span>🏠 {r.units} room{r.units === 1 ? '' : 's'} of this type</span>
                      </div>
                      {r.description && <p class="small mt-sm">{r.description}</p>}
                      {r.inclusions && <div class="small">Includes: {r.inclusions}</div>}
                      {(r.base_guests ?? r.capacity) < r.capacity && r.extra_adult_rate ? <div class="small">Extra guest: {money(r.extra_adult_rate)}/adult{r.extra_child_rate != null && r.extra_child_rate !== r.extra_adult_rate ? `, ${r.extra_child_rate ? money(r.extra_child_rate) : 'free'}/child` : ''} per night (above {r.base_guests} guests)</div> : null}
                      <div class="chips">{am.map((f) => <span class="chip">{FACILITY_ICONS[f] ?? '•'} {ROOM_AMENITIES[f] ?? FACILITIES[f] ?? f}</span>)}</div>
                    </div>
                    <div class="room-price">
                      <div class="price">{money(r.base_rate)}</div>
                      <div class="muted small">per night{r.weekend_rate && r.weekend_rate !== r.base_rate ? ` · weekends ${money(r.weekend_rate)}` : ''}</div>
                      <button class="btn btn-sm" data-pick-room={r.id}>Book</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {(mediaGroups.length > 0 || videos.length > 0) && (
            <section class="section-sm" id="photos">
              <h2>Photos & videos</h2>
              <nav class="media-tabs">
                {mediaGroups.map(([k, list]) => <a href={`#ph-${k}`}>{PHOTO_CATEGORIES[k]} ({list.length})</a>)}
                {rooms.some((r) => photos.some((m) => m.room_id === r.id)) && <a href="#rooms">Rooms</a>}
                {videos.length > 0 && <a href="#ph-videos">Videos ({videos.length})</a>}
              </nav>
              {mediaGroups.map(([k, list]) => (
                <div class="media-group" id={`ph-${k}`}>
                  <h3>{PHOTO_CATEGORIES[k]}</h3>
                  <div class="media-strip" data-gallery>
                    {list.map((m) => <a href={mediaUrl(m.r2_key, 1600, settings.images_transform)} data-full><img src={mediaUrl(m.r2_key, 400, settings.images_transform)} alt={m.caption ?? PHOTO_CATEGORIES[k]} loading="lazy" /></a>)}
                  </div>
                </div>
              ))}
              {videos.length > 0 && (
                <div class="media-group" id="ph-videos">
                  <h3>Videos</h3>
                  <div class="grid grid-2">
                    {videos.map((v) => {
                      const embed = videoEmbedUrl(v.video_url)
                      return (
                        <div>
                          {embed
                            ? <iframe class="video-embed" src={embed} title={v.caption ?? p.name} loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe>
                            : <video class="video-embed" src={mediaUrl(v.r2_key)} controls preload="metadata"></video>}
                          {v.caption && <div class="muted small">{v.caption}</div>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>
          )}

          {(din.restaurant_name || din.cuisines?.length || din.breakfast || din.notes || meals.length > 0) && (
            <section class="section-sm" id="dining">
              <h2>Dining{din.restaurant_name ? ` · ${din.restaurant_name}` : ''}</h2>
              <dl class="info-list">
                {din.cuisines?.length ? <><dt>Cuisines</dt><dd>{din.cuisines.join(', ')}</dd></> : null}
                {din.menu_types?.length ? <><dt>Menu</dt><dd>{din.menu_types.join(', ')}</dd></> : null}
                {din.breakfast && <><dt>Breakfast</dt><dd>{din.breakfast}</dd></>}
                {din.lunch && <><dt>Lunch</dt><dd>{din.lunch}</dd></>}
                {din.dinner && <><dt>Dinner</dt><dd>{din.dinner}</dd></>}
                {meals.length > 0 && <><dt>Meal plans</dt><dd>{meals.map((m) => {
                  const price = m === 'CP' ? din.price_cp : m === 'MAP' ? din.price_map : m === 'AP' ? din.price_ap : undefined
                  return `${MEAL_PLANS[m] ?? m}${price ? ` (+${money(price)}/person/night)` : ''}`
                }).join(' · ')}</dd></>}
                {din.child_meal_note && <><dt>Children's meals</dt><dd>{din.child_meal_note}</dd></>}
                <dt>Also</dt><dd>{[din.in_room_dining ? 'In-room dining' : null, din.bar ? 'Bar' : null, din.outside_food ? 'Outside food allowed' : 'No outside food'].filter(Boolean).join(' · ')}</dd>
              </dl>
              {din.notes && <p class="small mt-sm">{din.notes}</p>}
            </section>
          )}

          <section class="section-sm" id="facilities">
            <h2>Facilities</h2>
            <div class="facility-grid">{facilities.map((f) => <div>{FACILITY_ICONS[f] ?? '•'} {FACILITIES[f] ?? f}</div>)}</div>
          </section>

          <section class="section-sm" id="policies">
            <h2>Policies</h2>
            <dl class="info-list">
              <dt>Check-in / out</dt><dd>From <strong>{p.checkin_time}</strong> · by <strong>{p.checkout_time}</strong></dd>
              <dt>ID</dt><dd>{pol.id_documents || (p.id_required ? 'Government photo ID required for all adults' : 'Not required')}</dd>
              <dt>Pets</dt><dd>{pol.pet || (p.pet_friendly ? 'Pets allowed' : 'No pets')}</dd>
              <dt>Children</dt><dd>{pol.child || (p.family_friendly ? 'Children welcome' : 'Best suited to adults')}</dd>
              {POLICY_FIELDS.filter(([k]) => !['pet', 'child', 'id_documents', 'payment'].includes(k) && pol[k]).map(([k, label]) => <><dt>{label}</dt><dd>{pol[k]}</dd></>)}
              <dt>Cancellation</dt><dd>{p.cancellation_policy || 'Standard policy'} <a href="/policies/cancellation">Full policy</a></dd>
            </dl>
            {p.house_rules && <ul class="rules mt-sm">{p.house_rules.split('\n').filter(Boolean).map((l) => <li>{l.replace(/^-\s*/, '')}</li>)}</ul>}
          </section>

          <section class="section-sm" id="location">
            <h2>Location</h2>
            {p.address && <p>📍 {p.address}</p>}
            {p.lat && p.lng && <div id="prop-map" class="map" data-lat={p.lat} data-lng={p.lng} data-name={p.name}></div>}
            {(p.map_url || (p.lat && p.lng)) && <p><a class="btn btn-sm btn-outline" target="_blank" rel="noopener" href={p.map_url || `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`}>Open in Google Maps</a></p>}
            {p.how_to_reach && <><h3>How to reach</h3><p style="white-space:pre-line">{p.how_to_reach}</p></>}
            {nearby.length > 0 && (
              <>
                <h3>Nearby</h3>
                <ul class="nearby">{nearby.map((n) => <li><span>{NEARBY_ICONS[n.kind] ?? '📍'} {n.name}</span><span class="muted">{n.km} km{n.time ? ` · ${n.time}` : ''}</span></li>)}</ul>
              </>
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

          <section class="section-sm" id="reviews">
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
          <span class="eyebrow">CHAT WITH YOUR</span><h3>Personal <span class="advisor-green">Advisor</span></h3>
          <p class="muted small">Tell us your dates — our team will confirm availability and send you a quote on WhatsApp.</p>
          <form method="post" action="/enquiry" class="stack" data-price-url={`/stay/${p.slug}/price`}>
            <input type="hidden" name="property_id" value={p.id} />
            <div class="row">
              <Field label="Your name"><input name="guest_name" required maxlength={80} value={user?.name && user.name !== 'Guest' ? user.name : ''} autocomplete="name" /></Field>
              <Field label="WhatsApp number"><input name="phone" required inputmode="tel" maxlength={20} value={user?.phone ?? ''} autocomplete="tel" /></Field>
            </div>
            <Field label="Room (optional)">
              <Select name="room" id="room-select" value={rooms[0]?.id} options={[['', 'Any room'], ...rooms.map((r) => [r.id, `${r.name} (${(r.base_guests ?? r.capacity) < r.capacity ? `${r.base_guests} incl., max ${r.capacity}` : `sleeps ${r.capacity}`})`] as [number, string])]} />
            </Field>
            <div class="row">
              <Field label="Check-in"><input type="date" name="check_in" value={checkIn} min={todayIST()} /></Field>
              <Field label="Check-out"><input type="date" name="check_out" value={checkOut} min={todayIST()} /></Field>
            </div>
            <div class="row">
              <Field label="Adults"><input type="number" name="adults" min="1" max="40" value={Math.max(1, guests)} /></Field>
              <Field label="Children"><input type="number" name="children" min="0" max="20" value={Math.max(0, Math.min(20, int(c.req.query('children'))))} /></Field>
              <Field label="Rooms"><input type="number" name="rooms" min="1" max="20" value="1" /></Field>
            </div>
            <div class="price-box" aria-live="polite"><span class="muted small">Pick dates to see an estimated price.</span></div>
            <Field label="Message (optional)"><textarea name="message" rows={2} maxlength={2000} placeholder="Special requests, questions…"></textarea></Field>
            <input type="hidden" name="whatsapp_optin" value="1" />
            <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
            <button type="button" class="btn btn-lg" data-trip-quote>Get Quote →</button><button class="btn btn-outline">Send Enquiry</button>
            <p class="muted small">No payment now. Final price is confirmed in your quote.</p>
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
        <a class="btn" href="#book">Enquire</a>
      </div>
      {jsonScript('ld', ld)}
    </div>
  ))
})

// Estimated price for the enquiry box (rule-based; the quote confirms the final price).
publicRoutes.post('/stay/:slug/price', async (c) => {
  const f = await form(c)
  if (!isDate(f.checkIn) || !isDate(f.checkOut)) return c.json({ errors: ['Pick your dates'] })
  let roomId = int(f.room)
  if (!roomId) {
    const r = await first<{ id: number }>(c.env, "SELECT r.id FROM rooms r JOIN properties p ON p.id = r.property_id WHERE p.slug = ? AND r.active = 1 ORDER BY r.base_rate LIMIT 1", c.req.param('slug'))
    roomId = r?.id ?? 0
  }
  const p = await priceStay(c.env, roomId, f.checkIn, f.checkOut, Math.max(1, int(f.rooms, 1)), null, { adults: Math.max(1, int(f.adults, 2)), children: Math.max(0, int(f.children)) })
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
        <Field label="Offer code (optional)"><input name="offer" maxlength={30} value={c.req.query('offer') ?? ''} /></Field>
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
  let message = str(f.message, 2000)
  // From the property page: note which room and how many the guest is interested in.
  const room = propertyId && int(f.room) ? await first<{ name: string }>(c.env, 'SELECT name FROM rooms WHERE id = ? AND property_id = ?', int(f.room), propertyId) : null
  if (str(f.offer)) message = `Offer code: ${str(f.offer, 30).toUpperCase()}${message ? '\n' + message : ''}`
  if (room) message = `Interested in: ${room.name} × ${Math.max(1, int(f.rooms, 1))}${message ? '\n' + message : ''}`
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
              <p>Code: <code class="code">{o.code}</code> — mention it in your enquiry and we'll apply it to your quote.</p>
              <a class="btn btn-sm" href={`/enquiry?offer=${encodeURIComponent(o.code)}`}>Enquire with this offer</a>
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
      <img src="/brand/logo-wide.webp" alt={s.business.name} width="302" height="80" style="display:block;margin:0 auto 16px;height:auto;max-width:100%" />
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
       ${COVER_PHOTO_SQL} AS photo
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
  const photos = await all<{ property_id: number; r2_key: string }>(c.env, `SELECT property_id, r2_key FROM property_photos WHERE media_type = 'image' AND r2_key != '' AND property_id IN (${options.map(() => '?').join(',') || 'NULL'}) ORDER BY (category = 'facade') DESC, sort LIMIT 30`, ...options.map((o) => o.property_id))

  return page(c, { title: `Your quote ${q.code}`, noindex: true }, (
    <div class="wrap narrow section">
      <p class="muted small">Quote {q.code} for {q.guest_name}</p>
      <h1>Your stay quote</h1>
      {q.explainer && <AiNote label="In short">{q.explainer}</AiNote>}
      {q.valid_till && <p class={expired ? 'error' : 'muted'}>{expired ? 'This quote has expired' : `Valid till ${fmtDate(q.valid_till)}`}</p>}
      {q.status === 'accepted' && <div class="flash flash-ok">Thank you — you accepted this quote. Our team will confirm your booking and share payment details on WhatsApp.</div>}
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
            {o.extra_charges > 0 && <tr><td>{extrasLabel(o)}</td><td>{money(o.extra_charges)}</td></tr>}
            <tr><td>GST</td><td>{money(o.taxes)}</td></tr>
            <tr class="total"><td>Total</td><td>{money(o.total)}</td></tr>
          </table>
          <a href={`/stay/${o.slug}`} target="_blank" class="small">View property details →</a>
          {!closed && (
            <form method="post" action={`/q/${q.token}/accept`} class="mt-sm">
              <input type="hidden" name="option" value={o.id} />
              <button class="btn btn-lg">Accept this option ({money(o.total)})</button>
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
  // No online booking: the guest's acceptance goes to the team, who confirm the booking and collect payment.
  await run(c.env, "UPDATE quotations SET status = 'accepted', accepted_option_id = ?, updated_at = ? WHERE id = ?", o.id, nowIso(), q.id)
  const note = `Accepted quote ${q.code}: ${o.property_name}, ${fmtDate(o.check_in)} – ${fmtDate(o.check_out)}, ${money(o.total)}`
  if (q.enquiry_id) {
    await run(c.env, "INSERT INTO messages (enquiry_id, sender, channel, body) VALUES (?, 'guest', 'website', ?)", q.enquiry_id, note)
    await run(c.env, "UPDATE enquiries SET waiting_on = 'us', urgent = 1, last_guest_msg_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), q.enquiry_id)
  }
  await run(c.env, "UPDATE tasks SET status = 'done' WHERE quotation_id = ? AND status = 'open'", q.id)
  await run(c.env, 'INSERT INTO tasks (assigned_to, enquiry_id, quotation_id, guest_name, phone, reason, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)', q.staff_id, q.enquiry_id, q.id, q.guest_name, q.phone, `${q.guest_name} accepted ${q.code} — confirm the booking and share payment details`, nowIso())
  await notifyStaff(c.env, 'quote_accepted', `${q.guest_name} ${note}. Convert it to a booking.`)
  await logActivity(c.env, null, 'quote.accepted', 'quotation', q.id, { option: o.id, total: o.total })
  return redirectMsg(c, `/q/${token}`, { ok: 'Thank you! Our team will confirm your booking shortly.' })
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
  // Byte ranges let browsers seek in uploaded videos.
  const m = (c.req.header('range') ?? '').match(/^bytes=(\d*)-(\d*)$/)
  let range: R2Range | undefined
  if (m && (m[1] || m[2])) range = m[1] ? { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) } : { suffix: Number(m[2]) }
  const obj = await c.env.MEDIA.get(key, range ? { range } : undefined)
  if (!obj) return c.notFound()
  const h = new Headers()
  obj.writeHttpMetadata(h)
  h.set('etag', obj.httpEtag)
  h.set('accept-ranges', 'bytes')
  h.set('cache-control', 'public, max-age=31536000, immutable')
  if (range && 'body' in obj) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined
    const offset = r?.suffix != null ? Math.max(0, obj.size - r.suffix) : r?.offset ?? 0
    const length = r?.length ?? obj.size - offset
    h.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
    h.set('content-length', String(length))
    return new Response(obj.body, { status: 206, headers: h })
  }
  return new Response((obj as R2ObjectBody).body, { headers: h })
})


// ---------- Room category page (shareable link: staff send it to guests on WhatsApp) ----------
publicRoutes.get('/stay/:slug/room/:roomId', async (c) => {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE slug = ?', c.req.param('slug'))
  const user = c.get('user')
  const isStaffUser = !!user && user.role !== 'guest'
  const r = p ? await first<RoomRow>(c.env, 'SELECT * FROM rooms WHERE id = ? AND property_id = ?', int(c.req.param('roomId')), p.id) : null
  if (!p || !r || ((p.status !== 'live' || !r.active) && !isStaffUser)) return page(c, { title: 'Not found' }, <div class="wrap section"><Empty><h2>This room is not available</h2><a href="/search">Browse stays</a></Empty></div>, 404)
  const settings = await getSettings(c.env)
  const photos = await all<PhotoRow>(c.env, "SELECT * FROM property_photos WHERE property_id = ? AND room_id = ? AND media_type = 'image' AND r2_key != '' ORDER BY sort, id", p.id, r.id)
  const am = parseJson<string[]>(r.facilities, [])
  const t = settings.images_transform
  return page(c, {
    title: `${r.name} · ${p.name}`,
    description: `${r.name} at ${p.name}, ${p.destination}. Up to ${r.capacity} guests${r.bed_type ? `, ${r.bed_type}` : ''}. Photos, amenities and rates.`,
    image: photos[0] ? new URL(mediaUrl(photos[0].r2_key, 1200, t), c.req.url).toString() : undefined,
  }, (
    <div class="section"><div class="wrap stack">
      <a href={`/stay/${p.slug}#rooms`} class="small">← {p.name}</a>
      <div class="row-between">
        <div>
          <h1>{r.name}</h1>
          <div class="muted">{p.name} · 📍 {p.destination}</div>
        </div>
        <div class="room-price">
          <div class="price">{money(r.base_rate)}</div>
          <div class="muted small">per night{r.weekend_rate && r.weekend_rate !== r.base_rate ? ` · weekends ${money(r.weekend_rate)}` : ''}</div>
        </div>
      </div>
      {photos.length > 0
        ? <div class="room-gallery" data-gallery>{photos.map((m) => <a href={mediaUrl(m.r2_key, 1600, t)} data-full><img src={mediaUrl(m.r2_key, 800, t)} alt={m.caption ?? r.name} loading="lazy" />{m.caption && <span class="cap">{m.caption}</span>}</a>)}</div>
        : <p class="muted">Photos of this room are coming soon.</p>}
      <div class="card stack">
        <div class="room-meta">
          <span>👥 {(r.base_guests ?? r.capacity) < r.capacity ? `Rate for ${r.base_guests} guests · up to ${r.capacity}` : `Up to ${r.capacity} guests`}{r.max_adults ? ` (max ${r.max_adults} adults` + (r.max_children != null ? `, ${r.max_children} children)` : ')') : ''}</span>
          {r.bed_type && <span>🛏 {r.bed_type}</span>}
          {r.size_sqft && <span>📐 {r.size_sqft} sq ft</span>}
          {r.room_view && <span>🪟 {r.room_view} view</span>}
        </div>
        {r.description && <p>{r.description}</p>}
        {r.inclusions && <div class="small">Includes: {r.inclusions}</div>}
        {(r.base_guests ?? r.capacity) < r.capacity && r.extra_adult_rate ? <div class="small">Extra guest: {money(r.extra_adult_rate)}/adult{r.extra_child_rate != null && r.extra_child_rate !== r.extra_adult_rate ? `, ${r.extra_child_rate ? money(r.extra_child_rate) : 'free'}/child` : ''} per night (above {r.base_guests} guests)</div> : null}
        {am.length > 0 && <div class="chips">{am.map((f) => <span class="chip">{FACILITY_ICONS[f] ?? '•'} {ROOM_AMENITIES[f] ?? FACILITIES[f] ?? f}</span>)}</div>}
        <div class="row wrap-row">
          <a class="btn" href={`/stay/${p.slug}?room=${r.id}`}>Enquire about this room</a>
          <a class="btn btn-outline" href={`/stay/${p.slug}`}>See the whole property</a>
        </div>
      </div>
    </div></div>
  ))
})
