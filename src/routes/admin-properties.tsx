// Admin → Add / edit property (page 33), organised in sections:
// basics, location, description, dining, facilities, policies, contact & direct booking (internal), nearby, SEO, remarks,
// then (once saved) room categories, photos & videos by section, and tariff by season.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, Field, LeafletHead, Pill, Select } from '../views/components'
import { permissionsFor, requirePerm } from '../lib/auth'
import { all, enqueue, first, insertId, logActivity, placeholders, run } from '../lib/db'
import { seoSuggest, writeDescription } from '../lib/assist'
import { mediaUrl } from '../lib/integrations'
import { FACILITIES, MEAL_PLANS } from '../lib/search'
import {
  CONTACT_FIELDS, contact as readContact, CUISINES, dining as readDining, latLngFromMapUrl, legacyType, MENU_TYPES, PHOTO_CATEGORIES,
  POLICY_FIELDS, policies as readPolicies, ROOM_AMENITIES, ROOM_CATEGORY_NAMES, guestsText, ROOM_VIEWS, STAY_TYPES, stayType, THEMES, videoEmbedUrl, type Contact, type Dining, type Policies,
} from '../lib/catalog'
import type { NearbyPlace, PhotoRow, PropertyRow, RoomRow } from '../lib/types'
import { fmtDate, fmtDateTime, int, isDate, money, nowIso, parseJson, slugify, str } from '../lib/util'
import { form, redirectMsg, type Form } from './helpers'
import { destinations } from '../lib/properties'
import { SEASON_KINDS, seasonKindLabel, type SeasonRate } from '../lib/pricing'
import { extractProperty, type ExtractedRoom, type ExtractedSeason } from '../lib/propextract'

export const propertyEditorRoutes = new Hono<AppEnv>()

const SECTIONS: [string, string][] = [
  ['basics', 'Basics'], ['location', 'Location'], ['description', 'Description'], ['dining', 'Dining'], ['facilities', 'Facilities'],
  ['policies', 'Policies'], ['contact', 'Contact details'], ['nearby', 'Nearby'], ['seo', 'SEO'], ['remarks', 'Remarks'],
  ['rooms', 'Room categories'], ['media', 'Photos & videos'], ['tariff', 'Tariff & seasons'],
]

const Checks = ({ name, options, selected }: { name: string; options: [string, string][]; selected: string[] }) => (
  <div class="facility-grid">{options.map(([v, l]) => <label class="check"><input type="checkbox" name={name} value={v} checked={selected.includes(v)} /> {l}</label>)}</div>
)

interface SeasonGroup {
  key: string
  name: string
  start_date: string
  end_date: string
  min_nights: number | null
  kind: string
  rates: Record<number, number>
  staff: Record<number, number>
  net: Record<number, number>
}

function groupSeasons(rows: (SeasonRate & { id: number })[]): SeasonGroup[] {
  const map = new Map<string, SeasonGroup>()
  for (const r of rows) {
    const key = `${r.name}|${r.start_date}|${r.end_date}`
    const g = map.get(key) ?? { key, name: r.name, start_date: r.start_date, end_date: r.end_date, min_nights: r.min_nights, kind: r.kind ?? 'season', rates: {}, staff: {}, net: {} }
    if (r.room_id && r.rate) g.rates[r.room_id] = r.rate
    if (r.room_id && r.staff_rate) g.staff[r.room_id] = r.staff_rate
    if (r.room_id && r.net_rate) g.net[r.room_id] = r.net_rate
    if (r.min_nights) g.min_nights = r.min_nights
    map.set(key, g)
  }
  return [...map.values()].sort((a, b) => a.start_date.localeCompare(b.start_date))
}

const RoomFields = ({ r, pf = '', optional, showNet }: { r?: Partial<RoomRow>; pf?: string; optional?: boolean; showNet: boolean }) => {
  const am = parseJson<string[]>(r?.facilities, [])
  const req = !optional
  return (
    <>
      <div class="row wrap-row">
        <Field label="Room category name" class="grow"><input name={`${pf}name`} value={r?.name ?? ''} required={req} maxlength={80} list="room-cat-names" placeholder="Standard / Deluxe / Suite…" /></Field>
        <Field label="Inventory (rooms of this type)"><input type="number" name={`${pf}units`} value={r?.units ?? 1} min="0" max="500" class="w-sm" /></Field>
      </div>
      <div class="occupancy stack-sm">
        <strong class="small">Guests per room</strong>
        <div class="row wrap-row">
          <Field label="Guests included in rate" hint="e.g. 2 for a double, 8 for a big cottage"><input type="number" name={`${pf}base_guests`} value={r?.base_guests ?? r?.capacity ?? 2} min="1" max="60" class="w-sm" /></Field>
          <Field label="Max guests" hint="Including extra guests"><input type="number" name={`${pf}capacity`} value={r?.capacity ?? 2} min="1" max="60" class="w-sm" /></Field>
          <Field label="Extra adult ₹/night" hint="Each guest above the included number"><input type="number" name={`${pf}extra_adult_rate`} value={r?.extra_adult_rate ?? r?.extra_bed_rate ?? ''} min="0" class="w-md" /></Field>
          <Field label="Extra child ₹/night" hint="Blank = same as adult"><input type="number" name={`${pf}extra_child_rate`} value={r?.extra_child_rate ?? ''} min="0" class="w-md" /></Field>
          <Field label="Max adults" hint="Optional"><input type="number" name={`${pf}max_adults`} value={r?.max_adults ?? ''} min="1" max="60" class="w-sm" /></Field>
          <Field label="Max children" hint="Optional"><input type="number" name={`${pf}max_children`} value={r?.max_children ?? ''} min="0" max="30" class="w-sm" /></Field>
        </div>
      </div>
      <div class="row wrap-row">
        <Field label="Bed type"><input name={`${pf}bed_type`} value={r?.bed_type ?? ''} placeholder="King / 2 singles" class="w-md" /></Field>
        <Field label="Room size (sq ft)"><input type="number" name={`${pf}size_sqft`} value={r?.size_sqft ?? ''} min="0" class="w-sm" /></Field>
        <Field label="View"><Select name={`${pf}room_view`} value={r?.room_view ?? ''} options={[['', '—'], ...ROOM_VIEWS.map((v) => [v, v] as [string, string])]} /></Field>
        <Field label="Min nights"><input type="number" name={`${pf}min_nights`} value={r?.min_nights ?? 1} min="1" class="w-sm" /></Field>
      </div>
      <div class="rate-tiers stack-sm">
        <strong class="small">Rates per room per night</strong>
        <div class="row wrap-row">
          {showNet && <Field label="B2B / Net rate ₹" class="internal" hint="Cost from the resort. Management only — never shown to staff."><input type="number" name={`${pf}net_rate`} value={r?.net_rate ?? ''} min="0" class="w-md" /></Field>}
          <Field label="Internal staff rate ₹" hint="Benchmark for staff. Quoting below it needs approval."><input type="number" name={`${pf}staff_rate`} value={r?.staff_rate ?? ''} min="0" class="w-md" /></Field>
          <Field label="Guest rate ₹ (weekdays)" hint="Selling price shown on the website."><input type="number" name={`${pf}base_rate`} value={r?.base_rate ?? ''} min="0" required={req} class="w-md" /></Field>
          <Field label="Guest rate ₹ (Fri / Sat)" hint="Leave blank to use the weekday rate."><input type="number" name={`${pf}weekend_rate`} value={r?.weekend_rate ?? ''} min="0" class="w-md" /></Field>
        </div>
      </div>
      <div class="row wrap-row">
        <Field label="Includes" class="grow"><input name={`${pf}inclusions`} value={r?.inclusions ?? ''} placeholder="Breakfast, welcome drink" /></Field>
      </div>
      <Field label="Room description"><textarea name={`${pf}description`} rows={2} maxlength={1500}>{r?.description ?? ''}</textarea></Field>
      <Field label="Room amenities"><Checks name={`${pf}amenities`} options={Object.entries(ROOM_AMENITIES)} selected={am} /></Field>
    </>
  )
}

const RateSub = ({ staff, net }: { staff?: number | null; net?: number | null }) => (
  (staff || net) ? <div class="muted small">{staff ? `staff ${money(staff)}` : ''}{staff && net ? ' · ' : ''}{net ? `net ${money(net)}` : ''}</div> : <></>
)

/** A room category block inside the new-property form (fields prefixed nr<idx>_; empty blocks are skipped). */
const NewRoomBlock = ({ idx, showNet }: { idx: string; showNet: boolean }) => (
  <fieldset class="room-edit stack new-room" data-idx={idx}>
    <legend><strong>Room category</strong></legend>
    <RoomFields pf={`nr${idx}_`} optional showNet={showNet} />
    <Field label="Photos of this room category" hint="JPG / PNG / WebP, up to 15 MB each."><input type="file" name={`nr${idx}_photos`} accept="image/jpeg,image/png,image/webp" multiple /></Field>
  </fieldset>
)

const COMMON_SECTIONS = Object.entries(PHOTO_CATEGORIES).filter(([k]) => k !== 'room')

function propertyForm(
  c: Context<AppEnv>,
  p: Partial<PropertyRow> & { id?: number },
  rooms: RoomRow[],
  media: PhotoRow[],
  seasons: (SeasonRate & { id: number })[],
  otherSeasons: (SeasonRate & { id: number })[],
  dests: string[],
  showContact: boolean,
  showNet: boolean,
) {
  const fac = parseJson<string[]>(p.facilities, [])
  const meals = parseJson<string[]>(p.meal_plans, [])
  const nearby = parseJson<NearbyPlace[]>(p.nearby, [])
  const d = readDining(p.dining)
  const pol = readPolicies(p.policies)
  const con = readContact(p.contact)
  const isNew = !p.id
  const suggestedTags = [...new Set(media.filter((ph) => !ph.tags_confirmed).flatMap((ph) => parseJson<string[]>(ph.ai_tags, [])))].filter((t) => !fac.includes(t) && t in FACILITIES)
  const groups = groupSeasons(seasons)
  const byCat = Object.keys(PHOTO_CATEGORIES).map((k) => [k, media.filter((m) => m.category === k)] as const).filter(([, list]) => list.length)
  const roomOpts: [string | number, string][] = [['', '— room category —'], ...rooms.map((r) => [r.id, r.name] as [number, string])]
  const visible = SECTIONS.filter(([k]) => (showContact || k !== 'contact') && (!isNew || k !== 'tariff'))
  const num = (k: string) => visible.findIndex(([x]) => x === k) + 1

  return page(c, { title: isNew ? 'Add property' : `Edit ${p.name}`, area: 'admin', active: 'properties', head: <LeafletHead /> }, (
    <div class="stack-lg prop-editor">
      <a href="/admin/properties" class="small">← Properties</a>
      <div class="row-between">
        <h1>{isNew ? 'Add property' : p.name}</h1>
        {!isNew && <div class="row wrap-row"><Pill s={p.status ?? 'draft'} /><a class="btn btn-sm btn-outline" href={`/stay/${p.slug}`} target="_blank">Preview</a></div>}
      </div>
      <datalist id="room-cat-names">{ROOM_CATEGORY_NAMES.map((n) => <option value={n} />)}</datalist>
      <nav class="section-nav">
        {visible.map(([k, l], i) => <a href={`#${k}`}>{i + 1}. {l}</a>)}
      </nav>
      {isNew && <p class="flash">Fill in the details, room categories and photos, then save. Seasonal tariffs and videos can be added after the first save.</p>}

      <details class="card ai-box quick-fill" open={isNew}>
        <summary><span class="ai-badge">AI</span> <strong>Quick fill — paste all details in one paragraph</strong></summary>
        <p class="muted small">Paste everything you have — owner's WhatsApp message, brochure text, your notes (English or Malayalam). AI puts each detail into the right field below, plus room categories and seasonal rates. Nothing is saved until you check and press Save.</p>
        <textarea id="qf-text" rows={8} maxlength={12000} placeholder={'e.g. Misty Hills Resort, Chithirapuram, Munnar. 3 star resort built 2018. 12 rooms: 8 Deluxe Valley View (king bed, AC, balcony, kettle) ₹4,500 weekdays ₹5,500 weekends, 4 Family Suites for 4 guests ₹7,000. Christmas–New Year 20 Dec–5 Jan Deluxe 7,500, Suite 10,000, min 2 nights. Pool, parking, free Wi-Fi, restaurant (Kerala, North Indian) breakfast 7:30–10. Check-in 2 pm, check-out 11 am. No pets. 50% advance. 30% refund if cancelled 7 days before. Owner Joseph 98470 12345. 18 km from Mattupetty Dam…'}></textarea>
        <Field label="Or attach a fact sheet / brochure (PDF or Word)"><input type="file" id="qf-doc" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /></Field>
        <div class="row wrap-row">
          <button type="button" class="btn btn-sm" data-ai-extract="/admin/ai/extract-property">Fill the form with AI</button>
          <span class="muted small" id="qf-status"></span>
        </div>
        <div id="qf-extra" class="stack" hidden>
          <div id="qf-extra-list" class="small"></div>
          <label class="check"><input type="checkbox" name="ai_apply_extra" value="1" form="prop-form" checked /> Also add these room categories and seasons when I save</label>
        </div>
      </details>

      <form method="post" action={isNew ? '/admin/properties/new' : `/admin/properties/${p.id}`} class="stack-lg" id="prop-form" enctype={isNew ? 'multipart/form-data' : undefined}>
        <input type="hidden" name="ai_rooms" id="qf-rooms" value="" />
        <input type="hidden" name="ai_seasons" id="qf-seasons" value="" />
        <section class="card stack" id="basics">
          <h2>{num('basics')}. Basics</h2>
          <div class="row wrap-row">
            <Field label="Property name"><input name="name" value={p.name ?? ''} required maxlength={100} /></Field>
            <Field label="Property type"><Select name="type" value={p.id ? stayType(p as PropertyRow) : 'homestay'} options={Object.entries(STAY_TYPES)} /></Field>
            <Field label="Destination"><input name="destination" value={p.destination ?? ''} list="dests" required /><datalist id="dests">{dests.map((x) => <option value={x} />)}</datalist></Field>
          </div>
          <div class="row wrap-row">
            <Field label="Star category"><Select name="star_category" value={p.star_category ?? ''} options={[['', 'Not rated'], [1, '1★'], [2, '2★'], [3, '3★'], [4, '4★'], [5, '5★']]} /></Field>
            <Field label="Built / renovated (year)"><input type="number" name="built_year" value={p.built_year ?? ''} min="1800" max="2100" class="w-md" /></Field>
          </div>
          <Field label="Best for"><Checks name="themes" options={Object.entries(THEMES)} selected={parseJson<string[]>(p.themes, [])} /></Field>
          <Field label="Highlights (one per line, shown as bullet points)"><textarea name="highlights" rows={3}>{parseJson<string[]>(p.highlights, []).join('\n')}</textarea></Field>
        </section>

        <section class="card stack" id="location">
          <h2>{num('location')}. Location</h2>
          <Field label="Complete address"><textarea name="address" rows={2}>{p.address ?? ''}</textarea></Field>
          <Field label="Google Maps link" hint="Paste the share link from Google Maps — the map pin is filled in automatically."><input name="map_url" id="map-url" value={p.map_url ?? ''} placeholder="https://maps.app.goo.gl/… or https://www.google.com/maps/@10.08,77.05,15z" /></Field>
          <div class="row">
            <Field label="Latitude"><input name="lat" id="lat" value={p.lat ?? ''} inputmode="decimal" /></Field>
            <Field label="Longitude"><input name="lng" id="lng" value={p.lng ?? ''} inputmode="decimal" /></Field>
          </div>
          <div id="pin-map" class="map" data-lat={p.lat ?? 10.0889} data-lng={p.lng ?? 77.0595}></div>
          <p class="muted small">Click the map to place the pin exactly (short links like maps.app.goo.gl can't be read automatically).</p>
          <Field label="How to reach"><textarea name="how_to_reach" rows={3} placeholder="From Aluva station: 3.5 hrs by taxi via Kothamangalam. Last 2 km is a steep estate road — 4x4 pickup available.">{p.how_to_reach ?? ''}</textarea></Field>
        </section>

        <section class="card stack" id="description">
          <h2>{num('description')}. Description</h2>
          <details class="ai-box">
            <summary><span class="ai-badge">AI</span> Write description from points</summary>
            <textarea id="desc-points" rows={3} placeholder="e.g. 3 bedrooms, tea estate views, home-cooked Kerala food, 20 min from Munnar town"></textarea>
            <button type="button" class="btn btn-sm" data-ai-desc="/admin/ai/description">Write in English & Malayalam</button>
          </details>
          <Field label="Description (English)"><textarea name="description" id="desc-en" rows={6}>{p.description ?? ''}</textarea></Field>
          <Field label="Description (Malayalam)"><textarea name="description_ml" id="desc-ml" rows={5}>{p.description_ml ?? ''}</textarea></Field>
          <Field label="Good to know (shown to guests)" hint="Honest notes: steep road, no lift, limited mobile signal, etc."><textarea name="good_to_know" rows={2}>{p.good_to_know ?? ''}</textarea></Field>
        </section>

        <section class="card stack" id="dining">
          <h2>{num('dining')}. Dining & restaurant</h2>
          <div class="row wrap-row">
            <Field label="Restaurant name"><input name="d_restaurant_name" value={d.restaurant_name ?? ''} /></Field>
            <Field label="Breakfast"><input name="d_breakfast" value={d.breakfast ?? ''} placeholder="7:30 – 10:00" class="w-md" /></Field>
            <Field label="Lunch"><input name="d_lunch" value={d.lunch ?? ''} placeholder="12:30 – 3:00" class="w-md" /></Field>
            <Field label="Dinner"><input name="d_dinner" value={d.dinner ?? ''} placeholder="7:30 – 10:30" class="w-md" /></Field>
          </div>
          <Field label="Cuisines"><Checks name="d_cuisines" options={CUISINES.map((x) => [x, x])} selected={d.cuisines ?? []} /></Field>
          <Field label="Menu types"><Checks name="d_menu_types" options={MENU_TYPES.map((x) => [x, x])} selected={d.menu_types ?? []} /></Field>
          <div class="row wrap-row">
            <label class="check"><input type="checkbox" name="d_in_room_dining" value="1" checked={!!d.in_room_dining} /> In-room dining</label>
            <label class="check"><input type="checkbox" name="d_bar" value="1" checked={!!d.bar} /> Bar</label>
            <label class="check"><input type="checkbox" name="d_outside_food" value="1" checked={!!d.outside_food} /> Outside food allowed</label>
          </div>
          <Field label="Meal plans offered"><Checks name="meal_plans" options={Object.entries(MEAL_PLANS)} selected={meals} /></Field>
          <div class="row wrap-row">
            <Field label="Breakfast (CP) ₹/person/night"><input type="number" name="d_price_cp" value={d.price_cp ?? ''} min="0" class="w-md" /></Field>
            <Field label="Half board (MAP) ₹/person/night"><input type="number" name="d_price_map" value={d.price_map ?? ''} min="0" class="w-md" /></Field>
            <Field label="Full board (AP) ₹/person/night"><input type="number" name="d_price_ap" value={d.price_ap ?? ''} min="0" class="w-md" /></Field>
          </div>
          <Field label="Children's meals"><input name="d_child_meal_note" value={d.child_meal_note ?? ''} placeholder="Below 5 free; 5–12 years half price" /></Field>
          <Field label="Dining notes"><textarea name="d_notes" rows={2} placeholder="Kerala sadya on request, candle-light dinner ₹2,500 for two…">{d.notes ?? ''}</textarea></Field>
        </section>

        <section class="card stack" id="facilities">
          <h2>{num('facilities')}. Property facilities</h2>
          {suggestedTags.length > 0 && (
            <AiNote label="From your photos">
              Suggested: {suggestedTags.map((t) => <label class="check inline-check"><input type="checkbox" name="facilities" value={t} /> {FACILITIES[t] ?? t}</label>)}
              <span class="muted small"> — tick to confirm</span>
            </AiNote>
          )}
          <Checks name="facilities" options={Object.entries(FACILITIES)} selected={fac} />
          <div class="row wrap-row">
            <label class="check"><input type="checkbox" name="pet_friendly" value="1" checked={!!p.pet_friendly} /> Pet-friendly</label>
            <label class="check"><input type="checkbox" name="family_friendly" value="1" checked={p.family_friendly == null ? true : !!p.family_friendly} /> Family-friendly</label>
          </div>
        </section>

        <section class="card stack" id="policies">
          <h2>{num('policies')}. Policies</h2>
          <div class="row wrap-row">
            <Field label="Check-in from"><input type="time" name="checkin_time" value={p.checkin_time ?? '14:00'} /></Field>
            <Field label="Check-out by"><input type="time" name="checkout_time" value={p.checkout_time ?? '11:00'} /></Field>
            <label class="check"><input type="checkbox" name="id_required" value="1" checked={p.id_required == null ? true : !!p.id_required} /> Photo ID required</label>
          </div>
          <Field label="Cancellation policy"><textarea name="cancellation_policy" rows={2}>{p.cancellation_policy ?? ''}</textarea></Field>
          <div class="grid grid-2">
            {POLICY_FIELDS.map(([k, label, ph]) => <Field label={label}><input name={`pol_${k}`} value={pol[k] ?? ''} placeholder={ph} /></Field>)}
          </div>
          <Field label="Other house rules (one per line)"><textarea name="house_rules" rows={3}>{p.house_rules ?? ''}</textarea></Field>
        </section>

        {showContact && (
          <section class="card stack internal" id="contact">
            <h2>{num('contact')}. Contact details <span class="muted small">(private — only people allowed to see property contacts)</span></h2>
            <div class="grid grid-2">
              {CONTACT_FIELDS.map(([k, label]) => (
                k === 'bank_details'
                  ? <Field label={label}><textarea name={`con_${k}`} rows={3} placeholder="Account name, number, IFSC, bank / UPI ID">{con[k] ?? ''}</textarea></Field>
                  : <Field label={label}><input name={`con_${k}`} value={con[k] ?? (k === 'person' ? p.owner_name : k === 'phone' ? p.owner_phone : k === 'email' ? p.owner_email : '') ?? ''} type={k.startsWith('email') ? 'email' : k.startsWith('phone') ? 'tel' : 'text'} /></Field>
              ))}
            </div>
          </section>
        )}

        <section class="card stack" id="nearby">
          <h2>{num('nearby')}. Nearby attractions</h2>
          <Field label="One per line: Name | type | km | travel time" hint="Types: attraction, railway, airport, bus, hospital, atm, shopping, restaurant, beach, waterfall, viewpoint">
            <textarea name="nearby" rows={6} placeholder={'Mattupetty Dam | attraction | 18 | 35 min\nAluva railway station | railway | 110 | 3.5 hrs'}>{nearby.map((n) => [n.name, n.kind, n.km, n.time ?? ''].join(' | ').replace(/ \| $/, '')).join('\n')}</textarea>
          </Field>
        </section>

        <section class="card stack" id="seo">
          <div class="row-between"><h2>{num('seo')}. SEO</h2><button type="button" class="btn btn-sm btn-outline" data-ai-seo="/admin/ai/seo"><span class="ai-badge sm">AI</span> Suggest</button></div>
          <Field label="Page title"><input name="seo_title" id="seo-title" value={p.seo_title ?? ''} maxlength={70} /></Field>
          <Field label="Meta description"><textarea name="seo_description" id="seo-desc" rows={2} maxlength={170}>{p.seo_description ?? ''}</textarea></Field>
        </section>

        <section class="card stack internal" id="remarks">
          <h2>{num('remarks')}. Remarks <span class="muted small">(internal)</span></h2>
          <Field label="Remarks for staff"><textarea name="internal_notes" rows={4} placeholder="Agreement details, owner preferences, known issues…">{p.internal_notes ?? ''}</textarea></Field>
        </section>

        {isNew && (
          <>
            <section class="card stack" id="rooms">
              <h2>{num('rooms')}. Room categories & inventory</h2>
              <p class="muted small">Add each room category with its inventory and rates. Blank ones are skipped. You can edit them and add seasonal rates after saving.</p>
              <div id="new-rooms" class="stack"><NewRoomBlock idx="0" showNet={showNet} /></div>
              <template id="new-room-tpl"><NewRoomBlock idx="__IDX__" showNet={showNet} /></template>
              <button type="button" class="btn btn-sm btn-outline" data-add-room>+ Add another room category</button>
            </section>
            <section class="card stack" id="media">
              <h2>{num('media')}. Photos</h2>
              <p class="muted small">Room photos go with each room category above. Add common area, exterior, pool, view and restaurant photos here. Videos can be added after saving.</p>
              <div class="upload-box stack">
                <h3>Common photos</h3>
                <Field label="Section"><Select name="new_photos_category" options={COMMON_SECTIONS} /></Field>
                <Field label="Photos" hint="JPG / PNG / WebP, up to 15 MB each."><input type="file" name="new_photos" accept="image/jpeg,image/png,image/webp" multiple /></Field>
              </div>
            </section>
          </>
        )}

        <div class="row wrap-row sticky-actions">
          <Select name="status" value={p.status ?? 'draft'} options={[['draft', 'Draft'], ['live', 'Live (published)'], ['hidden', 'Hidden']]} />
          <label class="check"><input type="checkbox" name="featured" value="1" checked={!!p.featured} /> Featured on home page</label>
          <button class="btn">{isNew ? 'Save and continue' : 'Save details'}</button>
          {!isNew && p.updated_at && <span class="muted small">Last saved {fmtDateTime(p.updated_at)}</span>}
        </div>
      </form>

      {!isNew && (
        <>
          <section class="card stack" id="rooms">
            <h2>{num('rooms')}. Room categories & inventory</h2>
            {rooms.map((r) => (
              <details class="room-edit" open={rooms.length <= 2}>
                <summary><strong>{r.name}</strong> · {r.units} room{r.units === 1 ? '' : 's'} · {guestsText(r)} · {money(r.base_rate)}{r.weekend_rate ? ` / ${money(r.weekend_rate)} wknd` : ''} {!r.active && <span class="pill pill-hidden">inactive</span>}</summary>
                <form method="post" action={`/admin/rooms/${r.id}`} class="stack">
                  <RoomFields r={r} showNet={showNet} />
                  <div class="row wrap-row">
                    <label class="check"><input type="checkbox" name="active" value="1" checked={!!r.active} /> Active (bookable / quotable)</label>
                    <button class="btn btn-sm">Save room</button>
                  </div>
                </form>
              </details>
            ))}
            <details class="room-edit" open={rooms.length === 0}>
              <summary><strong>+ Add a room category</strong></summary>
              <form method="post" action={`/admin/properties/${p.id}/rooms`} class="stack">
                <RoomFields showNet={showNet} />
                <button class="btn btn-sm">Add room category</button>
              </form>
            </details>
          </section>

          <section class="card stack" id="media">
            <h2>{num('media')}. Photos & videos</h2>
            <div class="grid grid-2">
              <form method="post" action={`/admin/properties/${p.id}/media`} enctype="multipart/form-data" class="upload-box stack">
                <h3>Room photos</h3>
                <input type="hidden" name="category" value="room" />
                {rooms.length
                  ? <Field label="Room category"><Select name="room_id" options={roomOpts} required /></Field>
                  : <p class="muted small">Add a room category first (section above).</p>}
                <Field label="Caption (optional)"><input name="caption" maxlength={120} /></Field>
                <Field label="Photos or videos" hint="Photos up to 15 MB each (20 at a time). Videos MP4/WebM up to 90 MB."><input type="file" name="files" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" multiple required /></Field>
                <button class="btn btn-sm" disabled={!rooms.length}>Upload room photos</button>
              </form>
              <form method="post" action={`/admin/properties/${p.id}/media`} enctype="multipart/form-data" class="upload-box stack">
                <h3>Common photos</h3>
                <Field label="Section"><Select name="category" options={COMMON_SECTIONS} /></Field>
                <Field label="Caption (optional)"><input name="caption" maxlength={120} /></Field>
                <Field label="Photos or videos" hint="Common areas, exterior, pool, views, restaurant, activities."><input type="file" name="files" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" multiple required /></Field>
                <button class="btn btn-sm">Upload common photos</button>
              </form>
            </div>
            <form method="post" action={`/admin/properties/${p.id}/video-link`} class="row wrap-row">
              <Field label="Or add a YouTube / Vimeo video link"><input name="url" type="url" placeholder="https://youtu.be/…" required /></Field>
              <Field label="Section"><Select name="category" options={Object.entries(PHOTO_CATEGORIES)} /></Field>
              <Select name="room_id" options={roomOpts} />
              <input name="caption" placeholder="Caption" maxlength={120} />
              <button class="btn btn-sm btn-outline">Add video link</button>
            </form>
            {media.length === 0 && <p class="muted">No photos yet. Upload common areas, facade, every room category, pool, views, restaurant and activities.</p>}
            {byCat.map(([cat, list]) => (
              <div>
                <h3>{PHOTO_CATEGORIES[cat]} <span class="muted small">({list.length})</span></h3>
                <div class="photo-grid">
                  {list.map((ph) => (
                    <form method="post" action={`/admin/photos/${ph.id}`} class="photo-tile">
                      {ph.media_type === 'video'
                        ? ph.video_url ? <div class="video-thumb">▶ <a href={ph.video_url} target="_blank" rel="noopener">Video link</a></div> : <video src={mediaUrl(ph.r2_key)} preload="metadata" muted controls></video>
                        : <img src={mediaUrl(ph.r2_key, 300)} alt="" loading="lazy" />}
                      <Select name="category" value={ph.category} options={Object.entries(PHOTO_CATEGORIES)} />
                      {(ph.category === 'room' || ph.room_id) && <Select name="room_id" value={ph.room_id ?? ''} options={roomOpts} />}
                      <input name="caption" value={ph.caption ?? ''} placeholder="Caption" />
                      <div class="row"><input type="number" name="sort" value={ph.sort} class="w-sm" title="Order" /><button class="btn btn-sm btn-outline">Save</button><button class="btn btn-sm btn-danger" name="delete" value="1">Delete</button></div>
                      {parseJson<string[]>(ph.ai_tags, []).length > 0 && <div class="small"><span class="ai-badge sm">AI</span> {parseJson<string[]>(ph.ai_tags, []).map((t) => FACILITIES[t] ?? t).join(', ')}</div>}
                    </form>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section class="card stack" id="tariff">
            <h2>{num('tariff')}. Tariff & seasonal rates</h2>
            <p class="muted small">Rates per room per night. Regular rates come from each room category; a season overrides them on its dates. Types: <strong>Peak season</strong>, <strong>Off-season</strong> and <strong>Special / holiday</strong> (Christmas, New Year, Onam…). When dates overlap, special wins over season, and season over off-season. Leave a room blank to keep its regular rate.</p>
            {showNet && (
              <form method="post" action={`/admin/properties/${p.id}/ratesheet`} enctype="multipart/form-data" class="upload-box stack" id="ratesheet">
                <h3><span class="ai-badge">AI</span> Import a B2B rate sheet (PDF or Word)</h3>
                <p class="small muted">Attach the resort's rate sheet. AI reads the room categories, seasons and net rates; you check everything on the next screen before it is saved.</p>
                <div class="row wrap-row">
                  <Field label="Rate sheet"><input type="file" name="sheet" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required /></Field>
                  <Field label="Staff rate = net +" hint="% markup"><input type="number" name="staff_markup" value="15" min="0" max="300" step="0.5" class="w-sm" /></Field>
                  <Field label="Guest rate = net +" hint="% markup"><input type="number" name="guest_markup" value="35" min="0" max="500" step="0.5" class="w-sm" /></Field>
                </div>
                <button class="btn btn-sm">Read rate sheet</button>
              </form>
            )}
            <div class="table-wrap">
              <table class="table tariff-table">
                <thead><tr><th>Season</th><th>Type</th><th>Dates</th><th>Min nights</th>{rooms.map((r) => <th>{r.name}</th>)}</tr></thead>
                <tbody>
                  <tr class="muted"><td>Regular (weekday)</td><td>—</td><td>All year</td><td>—</td>{rooms.map((r) => <td>{money(r.base_rate)}<RateSub staff={r.staff_rate} net={showNet ? r.net_rate : null} /></td>)}</tr>
                  <tr class="muted"><td>Regular (Fri & Sat)</td><td>—</td><td>All year</td><td>—</td>{rooms.map((r) => <td>{money(r.weekend_rate ?? r.base_rate)}</td>)}</tr>
                  {groups.map((g) => <tr><td><strong>{g.name}</strong></td><td><span class={`pill pill-kind-${g.kind}`}>{seasonKindLabel(g.kind)}</span></td><td class="nowrap">{fmtDate(g.start_date)} – {fmtDate(g.end_date)}</td><td>{g.min_nights ?? '—'}</td>{rooms.map((r) => <td>{g.rates[r.id] ? <>{money(g.rates[r.id])}<RateSub staff={g.staff[r.id]} net={showNet ? g.net[r.id] : null} /></> : <span class="muted">regular</span>}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
            {[...groups, null].map((g) => (
              <details class="season-edit" open={!g && groups.length === 0}>
                <summary>{g ? <>Edit <strong>{g.name}</strong> ({fmtDate(g.start_date)} – {fmtDate(g.end_date)})</> : <strong>+ Add a season</strong>}</summary>
                <form method="post" action={`/admin/properties/${p.id}/seasons`} class="stack">
                  {g && <input type="hidden" name="orig_key" value={g.key} />}
                  <div class="row wrap-row">
                    <Field label="Season name" class="grow"><input name="name" value={g?.name ?? ''} required placeholder="Onam / Christmas & New Year / Summer / Monsoon" /></Field>
                    <Field label="Type"><Select name="kind" value={g?.kind ?? 'season'} options={Object.entries(SEASON_KINDS)} /></Field>
                    <Field label="From"><input type="date" name="start_date" value={g?.start_date ?? ''} required /></Field>
                    <Field label="To (last night)"><input type="date" name="end_date" value={g?.end_date ?? ''} required /></Field>
                    <Field label="Min nights"><input type="number" name="min_nights" value={g?.min_nights ?? ''} min="1" class="w-sm" /></Field>
                  </div>
                  {rooms.map((r) => (
                    <div class="row wrap-row season-room">
                      <strong class="small season-room-name">{r.name}</strong>
                      {showNet && <Field label="B2B / Net ₹" class="internal"><input type="number" name={`net_${r.id}`} value={g?.net[r.id] ?? ''} min="0" class="w-md" /></Field>}
                      <Field label="Staff rate ₹"><input type="number" name={`staff_${r.id}`} value={g?.staff[r.id] ?? ''} min="0" class="w-md" placeholder={r.staff_rate ? String(r.staff_rate) : ''} /></Field>
                      <Field label="Guest rate ₹"><input type="number" name={`rate_${r.id}`} value={g?.rates[r.id] ?? ''} min="0" class="w-md" placeholder={String(r.base_rate)} /></Field>
                    </div>
                  ))}
                  <div class="row">
                    <button class="btn btn-sm">{g ? 'Save season' : 'Add season'}</button>
                    {g && <button class="btn btn-sm btn-danger" formaction={`/admin/properties/${p.id}/seasons/delete`} formnovalidate>Delete season</button>}
                  </div>
                </form>
              </details>
            ))}
            {otherSeasons.length > 0 && (
              <p class="small muted">Also applying: {otherSeasons.map((s) => `${s.name} (${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}, ${s.rate ? money(s.rate) : `${(s.pct_adjust ?? 0) > 0 ? '+' : ''}${s.pct_adjust}%`}${s.property_id ? '' : ', all properties'})`).join('; ')}. <a href={`/admin/rates?property=${p.id}`}>Manage on Rates page →</a></p>
            )}
          </section>
        </>
      )}
    </div>
  ))
}

/** Property contact details are private: only users allowed to see them (admins by default) can view or change them. */
async function canSeeContacts(c: Context<AppEnv>) {
  return (await permissionsFor(c.env, c.get('user')!.role)).view_property_contacts
}

/** B2B / net rates from the resort are for management only (permission "view_net_rates"). */
async function canSeeNet(c: Context<AppEnv>) {
  return (await permissionsFor(c.env, c.get('user')!.role)).view_net_rates
}

async function loadEditor(c: Context<AppEnv>, id: number) {
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', id)
  if (!p) return null
  const [rooms, media, seasonRows, dests] = await Promise.all([
    all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? ORDER BY active DESC, base_rate', p.id),
    all<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE property_id = ? ORDER BY category, sort, id', p.id),
    all<SeasonRate & { id: number }>(c.env, 'SELECT * FROM season_rates WHERE property_id = ? OR property_id IS NULL ORDER BY start_date', p.id),
    destinations(c.env),
  ])
  // Per-room fixed-rate seasons are edited here; percentage and all-property seasons stay on the Rates page.
  const mine = seasonRows.filter((s) => s.property_id === p.id && s.room_id != null && s.rate != null)
  const others = seasonRows.filter((s) => !mine.includes(s))
  return propertyForm(c, p, rooms, media, mine, others, dests, await canSeeContacts(c), await canSeeNet(c))
}

propertyEditorRoutes.get('/admin/properties/new', requirePerm('manage_properties'), async (c) => propertyForm(c, {}, [], [], [], [], await destinations(c.env), await canSeeContacts(c), await canSeeNet(c)))

propertyEditorRoutes.get('/admin/properties/:id', requirePerm('manage_properties'), async (c) => {
  const r = await loadEditor(c, int(c.req.param('id')))
  return r ?? c.notFound()
})

function lines(s: string | undefined) {
  return (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
}

function propertyValues(f: Form, withContact: boolean) {
  const nearby: NearbyPlace[] = lines(f.nearby)
    .map((l) => l.split('|').map((x) => x.trim()))
    .filter((x) => x[0])
    .map(([name, kind, km, time]) => ({ name, kind: (kind || 'attraction').toLowerCase(), km: parseFloat(km) || 0, ...(time ? { time } : {}) }))
  let lat: number | null = parseFloat(f.lat)
  let lng: number | null = parseFloat(f.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const ll = latLngFromMapUrl(f.map_url)
    lat = ll?.lat ?? null
    lng = ll?.lng ?? null
  }
  const pick = (k: string) => f.__all[k] ?? []
  const num = (v: string | undefined) => (v && Number.isFinite(parseInt(v, 10)) ? Math.max(0, parseInt(v, 10)) : undefined)
  const dining: Dining = {
    restaurant_name: str(f.d_restaurant_name, 100) || undefined,
    cuisines: pick('d_cuisines').filter((x) => CUISINES.includes(x)),
    menu_types: pick('d_menu_types').filter((x) => MENU_TYPES.includes(x)),
    breakfast: str(f.d_breakfast, 40) || undefined,
    lunch: str(f.d_lunch, 40) || undefined,
    dinner: str(f.d_dinner, 40) || undefined,
    in_room_dining: !!f.d_in_room_dining,
    bar: !!f.d_bar,
    outside_food: !!f.d_outside_food,
    price_cp: num(f.d_price_cp),
    price_map: num(f.d_price_map),
    price_ap: num(f.d_price_ap),
    child_meal_note: str(f.d_child_meal_note, 200) || undefined,
    notes: str(f.d_notes, 1000) || undefined,
  }
  const policies: Policies = {}
  for (const [k] of POLICY_FIELDS) if (str(f[`pol_${k}`])) policies[k] = str(f[`pol_${k}`], 300)
  const contact: Contact = {}
  for (const [k] of CONTACT_FIELDS) if (str(f[`con_${k}`])) contact[k] = str(f[`con_${k}`], k === 'bank_details' ? 800 : k.startsWith('email') ? 120 : 40)
  // Contact columns are only written by people allowed to see them, so others can't wipe them.
  const contactCols = withContact
    ? { contact: JSON.stringify(contact), owner_name: contact.person ?? null, owner_phone: contact.phone ?? null, owner_email: contact.email ?? null }
    : {}
  const st = f.type in STAY_TYPES ? f.type : 'homestay'
  const star = parseInt(f.star_category, 10)
  const year = parseInt(f.built_year, 10)
  return {
    name: str(f.name, 100), stay_type: st, type: legacyType(st), destination: str(f.destination, 60),
    address: str(f.address, 500) || null, map_url: str(f.map_url, 500) || null, lat, lng,
    star_category: star >= 1 && star <= 5 ? star : null, built_year: year > 1800 && year < 2100 ? year : null,
    themes: JSON.stringify(pick('themes').filter((x) => x in THEMES)),
    how_to_reach: str(f.how_to_reach, 2000), good_to_know: str(f.good_to_know, 1500),
    ...contactCols,
    highlights: JSON.stringify(lines(f.highlights).slice(0, 10)),
    description: str(f.description, 8000), description_ml: str(f.description_ml, 12000),
    facilities: JSON.stringify([...new Set(pick('facilities').filter((x) => x in FACILITIES))]),
    meal_plans: JSON.stringify(pick('meal_plans').filter((x) => x in MEAL_PLANS)),
    dining: JSON.stringify(dining), policies: JSON.stringify(policies),
    checkin_time: /^\d{2}:\d{2}$/.test(f.checkin_time) ? f.checkin_time : '14:00', checkout_time: /^\d{2}:\d{2}$/.test(f.checkout_time) ? f.checkout_time : '11:00',
    cancellation_policy: str(f.cancellation_policy, 2000), house_rules: str(f.house_rules, 2000), id_required: f.id_required ? 1 : 0,
    nearby: JSON.stringify(nearby), pet_friendly: f.pet_friendly ? 1 : 0, family_friendly: f.family_friendly ? 1 : 0,
    internal_notes: str(f.internal_notes, 4000),
    seo_title: str(f.seo_title, 70) || null, seo_description: str(f.seo_description, 170) || null,
    status: ['draft', 'live', 'hidden'].includes(f.status) ? f.status : 'draft', featured: f.featured ? 1 : 0,
  }
}

export async function afterPropertySave(c: Context<AppEnv>, id: number) {
  // Embedding + knowledge base refresh run in the background, only when a property changes.
  await enqueue(c.env, { type: 'embed_property', propertyId: id })
  await enqueue(c.env, { type: 'sync_kb', what: 'property', id })
  await c.env.KV.delete(`similar:${id}`)
}

propertyEditorRoutes.post('/admin/properties/new', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  const v = propertyValues(f, await canSeeContacts(c))
  if (!v.name || !v.destination) return redirectMsg(c, '/admin/properties/new', { err: 'Name and destination are required.' })
  let slug = slugify(`${v.name} ${v.destination}`)
  if (await first(c.env, 'SELECT 1 FROM properties WHERE slug = ?', slug)) slug += '-' + Date.now().toString(36)
  const cols = Object.keys(v)
  const id = await insertId(c.env, `INSERT INTO properties (slug, ${cols.join(', ')}) VALUES (?, ${placeholders(cols.length)})`, slug, ...(Object.values(v) as (string | number | null)[]))
  await run(c.env, 'INSERT OR IGNORE INTO destinations (name, slug) VALUES (?, ?)', v.destination, slugify(v.destination))
  const added = await addNewRooms(c, id, f)
  const extra = await applyExtracted(c, id, f)
  const photos = await uploadNewPropertyPhotos(c, id, added)
  await afterPropertySave(c, id)
  await logActivity(c.env, c.get('user')!.id, 'property.created', 'property', id, { name: v.name, rooms: added.size, photos: photos.n })
  const parts = [added.size && `${added.size} room categor${added.size === 1 ? 'y' : 'ies'}`, photos.n && `${photos.n} photo${photos.n === 1 ? '' : 's'}`].filter(Boolean)
  const msg = `Property created${parts.length ? ` with ${parts.join(' and ')}` : ''}.${extra} Add seasonal rates and videos below.`
  return redirectMsg(c, `/admin/properties/${id}#rooms`, photos.skipped.length ? { ok: msg, err: `Skipped (wrong type or too large): ${photos.skipped.join(', ').slice(0, 150)}` } : { ok: msg })
})

propertyEditorRoutes.post('/admin/properties/:id', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  const before = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', id)
  if (!before) return c.notFound()
  const f = await form(c)
  const v = propertyValues(f, await canSeeContacts(c))
  const cols = Object.keys(v)
  await run(c.env, `UPDATE properties SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...(Object.values(v) as (string | number | null)[]), nowIso(), id)
  await run(c.env, 'UPDATE property_photos SET tags_confirmed = 1 WHERE property_id = ?', id)
  await run(c.env, 'INSERT OR IGNORE INTO destinations (name, slug) VALUES (?, ?)', v.destination, slugify(v.destination))
  const extra = await applyExtracted(c, id, f)
  await afterPropertySave(c, id)
  const changed = cols.filter((k) => String((before as unknown as Record<string, unknown>)[k] ?? '') !== String((v as Record<string, unknown>)[k] ?? ''))
  await logActivity(c.env, c.get('user')!.id, 'property.updated', 'property', id, { changed })
  return redirectMsg(c, `/admin/properties/${id}`, { ok: `Saved.${extra}` })
})

// ---- Room categories ----
function roomValues(f: Form, withNet: boolean) {
  const optInt = (v: string | undefined) => (v && Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : null)
  return {
    name: str(f.name, 80), capacity: Math.max(1, int(f.capacity, 2), int(f.base_guests)),
    // Guests included in the rate can't be more than the maximum.
    base_guests: Math.max(1, Math.min(int(f.base_guests) || int(f.capacity, 2), Math.max(1, int(f.capacity, 2), int(f.base_guests)))),
    extra_adult_rate: optInt(f.extra_adult_rate) || null, extra_child_rate: f.extra_child_rate === '' || f.extra_child_rate == null ? null : optInt(f.extra_child_rate), bed_type: str(f.bed_type, 60) || null, units: Math.max(0, int(f.units, 1)),
    base_rate: Math.max(0, int(f.base_rate)), weekend_rate: optInt(f.weekend_rate) || null, staff_rate: optInt(f.staff_rate) || null,
    // Only management may set the net rate; others leave it unchanged.
    ...(withNet ? { net_rate: optInt(f.net_rate) || null } : {}),
    min_nights: Math.max(1, int(f.min_nights, 1)), inclusions: str(f.inclusions, 200), description: str(f.description, 1500),
    facilities: JSON.stringify((f.__all.amenities ?? []).filter((x) => x in ROOM_AMENITIES)),
    size_sqft: optInt(f.size_sqft), room_view: str(f.room_view, 40) || null, max_adults: optInt(f.max_adults), max_children: optInt(f.max_children),
    // Kept in step for older screens: an extra-person charge means an extra bed / mattress is possible.
    extra_bed: optInt(f.extra_adult_rate) ? 1 : 0, extra_bed_rate: optInt(f.extra_adult_rate),
  }
}

propertyEditorRoutes.post('/admin/properties/:id/rooms', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  if (!(await first(c.env, 'SELECT 1 FROM properties WHERE id = ?', id))) return c.notFound()
  const v = roomValues(await form(c), await canSeeNet(c))
  if (!v.name) return redirectMsg(c, `/admin/properties/${id}#rooms`, { err: 'Room category name is required.' })
  const cols = Object.keys(v)
  await insertId(c.env, `INSERT INTO rooms (property_id, ${cols.join(', ')}) VALUES (?, ${placeholders(cols.length)})`, id, ...(Object.values(v) as (string | number | null)[]))
  await afterPropertySave(c, id)
  await logActivity(c.env, c.get('user')!.id, 'room.created', 'property', id, { name: v.name, base: v.base_rate, units: v.units })
  return redirectMsg(c, `/admin/properties/${id}#rooms`, { ok: `Room category “${v.name}” added.` })
})

propertyEditorRoutes.post('/admin/rooms/:id', requirePerm('manage_properties'), async (c) => {
  const r = await first<RoomRow>(c.env, 'SELECT * FROM rooms WHERE id = ?', int(c.req.param('id')))
  if (!r) return c.notFound()
  const f = await form(c)
  const v = { ...roomValues(f, await canSeeNet(c)), active: f.active ? 1 : 0 }
  const cols = Object.keys(v)
  await run(c.env, `UPDATE rooms SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...(Object.values(v) as (string | number | null)[]), r.id)
  const net = 'net_rate' in v ? v.net_rate : r.net_rate
  if (r.base_rate !== v.base_rate || r.weekend_rate !== v.weekend_rate || r.net_rate !== net || r.staff_rate !== v.staff_rate) {
    await logActivity(c.env, c.get('user')!.id, 'price.changed', 'room', r.id, { from: { guest: r.base_rate, weekend: r.weekend_rate, staff: r.staff_rate, net: r.net_rate }, to: { guest: v.base_rate, weekend: v.weekend_rate, staff: v.staff_rate, net } })
  }
  if (r.units !== v.units) await logActivity(c.env, c.get('user')!.id, 'inventory.changed', 'room', r.id, { from: r.units, to: v.units })
  await afterPropertySave(c, r.property_id)
  return redirectMsg(c, `/admin/properties/${r.property_id}#rooms`, { ok: `Saved “${v.name}”.` })
})

/** Rooms and seasons that "Quick fill" found, added on save when staff leave the box ticked. Returns a message part. */
async function applyExtracted(c: Context<AppEnv>, propertyId: number, f: Form): Promise<string> {
  const withNet = await canSeeNet(c)
  if (!f.ai_apply_extra) return ''
  const rooms = parseJson<ExtractedRoom[]>(f.ai_rooms, [])
  const seasons = parseJson<ExtractedSeason[]>(f.ai_seasons, [])
  if (!Array.isArray(rooms) || !Array.isArray(seasons) || (!rooms.length && !seasons.length)) return ''
  const existing = await all<{ id: number; name: string }>(c.env, 'SELECT id, name FROM rooms WHERE property_id = ?', propertyId)
  const byName = new Map(existing.map((r) => [r.name.trim().toLowerCase(), r.id]))
  let addedRooms = 0
  for (const r of rooms.slice(0, 20)) {
    const fake = Object.assign(
      Object.fromEntries(Object.entries(r).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '') : String(v)])),
      { __all: { amenities: Array.isArray(r.amenities) ? r.amenities.map(String) : [] } },
    ) as Form
    const v = roomValues(fake, withNet)
    if (!v.name || byName.has(v.name.toLowerCase())) continue
    const cols = Object.keys(v)
    const rid = await insertId(c.env, `INSERT INTO rooms (property_id, ${cols.join(', ')}) VALUES (?, ${placeholders(cols.length)})`, propertyId, ...(Object.values(v) as (string | number | null)[]))
    byName.set(v.name.toLowerCase(), rid)
    addedRooms++
  }
  let addedSeasons = 0
  const stmts: D1PreparedStatement[] = []
  for (const s of seasons.slice(0, 20)) {
    const name = str(s.name, 60)
    if (!name || !isDate(s.start_date) || !isDate(s.end_date) || s.end_date < s.start_date) continue
    let n = 0
    for (const [room, rate] of Object.entries(s.rates ?? {})) {
      const rid = byName.get(room.trim().toLowerCase())
      const amount = Math.round(Number(rate))
      if (!rid || !(amount > 0)) continue
      stmts.push(c.env.DB.prepare('INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, min_nights, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(propertyId, rid, name, s.start_date, s.end_date, amount, int(String(s.min_nights ?? '')) || null, c.get('user')!.id))
      n++
    }
    if (n) addedSeasons++
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  if (addedRooms || addedSeasons) await logActivity(c.env, c.get('user')!.id, 'property.quick_fill', 'property', propertyId, { rooms: addedRooms, seasons: addedSeasons })
  const parts = [addedRooms && `${addedRooms} room categor${addedRooms === 1 ? 'y' : 'ies'}`, addedSeasons && `${addedSeasons} season${addedSeasons === 1 ? '' : 's'}`].filter(Boolean)
  return parts.length ? ` Added ${parts.join(' and ')} from quick fill — please check them.` : ''
}

/** Room category blocks on the new-property form (nr0_…, nr1_…). Returns block index → new room id. */
async function addNewRooms(c: Context<AppEnv>, propertyId: number, f: Form): Promise<Map<string, number>> {
  const withNet = await canSeeNet(c)
  const out = new Map<string, number>()
  const idxs = [...new Set(Object.keys(f).map((k) => k.match(/^nr(\d{1,2})_name$/)?.[1]).filter((x): x is string => !!x))]
  for (const idx of idxs.slice(0, 30)) {
    const pf = `nr${idx}_`
    const fake = Object.assign(
      Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith(pf)).map(([k, v]) => [k.slice(pf.length), v])),
      { __all: { amenities: f.__all[`${pf}amenities`] ?? [] } },
    ) as Form
    const v = roomValues(fake, withNet)
    if (!v.name) continue
    const cols = Object.keys(v)
    out.set(idx, await insertId(c.env, `INSERT INTO rooms (property_id, ${cols.join(', ')}) VALUES (?, ${placeholders(cols.length)})`, propertyId, ...(Object.values(v) as (string | number | null)[])))
  }
  return out
}

async function uploadNewPropertyPhotos(c: Context<AppEnv>, propertyId: number, rooms: Map<string, number>) {
  const body = await c.req.parseBody({ all: true })
  const filesOf = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]) : [body[k]]).filter((x): x is File => x instanceof File && x.size > 0)
  const cat = String(body.new_photos_category ?? 'common')
  const common = await storeMedia(c, propertyId, filesOf('new_photos'), cat in PHOTO_CATEGORIES && cat !== 'room' ? cat : 'common', null, null)
  let n = common.n
  const skipped = [...common.skipped]
  for (const [idx, roomId] of rooms) {
    const r = await storeMedia(c, propertyId, filesOf(`nr${idx}_photos`), 'room', roomId, null)
    n += r.n
    skipped.push(...r.skipped)
  }
  return { n, skipped }
}

// ---- Photos & videos ----
const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime)$/

/** Save uploaded photos/videos to R2 and the gallery. Images get AI tag suggestions in the background. */
async function storeMedia(c: Context<AppEnv>, propertyId: number, files: File[], category: string, roomId: number | null, caption: string | null) {
  const maxSort = (await first<{ m: number }>(c.env, 'SELECT COALESCE(MAX(sort), 0) AS m FROM property_photos WHERE property_id = ?', propertyId))?.m ?? 0
  let n = 0
  const skipped: string[] = []
  for (const f of files.slice(0, 20)) {
    const isImage = IMAGE_TYPES.test(f.type)
    const isVideo = VIDEO_TYPES.test(f.type)
    if ((!isImage && !isVideo) || (isImage && f.size > 15 * 1024 * 1024) || (isVideo && f.size > 90 * 1024 * 1024)) {
      skipped.push(f.name)
      continue
    }
    const ext = f.type === 'video/quicktime' ? 'mov' : f.type.split('/')[1]
    const key = `properties/${propertyId}/${category}/${crypto.randomUUID()}.${ext}`
    await c.env.MEDIA.put(key, f.stream(), { httpMetadata: { contentType: f.type } })
    const pid = await insertId(
      c.env,
      'INSERT INTO property_photos (property_id, r2_key, caption, sort, category, room_id, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      propertyId, key, caption, maxSort + ++n, category, category === 'room' ? roomId : null, isVideo ? 'video' : 'image',
    )
    if (isImage) await enqueue(c.env, { type: 'photo_tags', photoId: pid })
  }
  if (n) await logActivity(c.env, c.get('user')!.id, 'media.uploaded', 'property', propertyId, { count: n, category })
  return { n, skipped }
}

propertyEditorRoutes.post('/admin/properties/:id/media', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  if (!(await first(c.env, 'SELECT 1 FROM properties WHERE id = ?', id))) return c.notFound()
  const body = await c.req.parseBody({ all: true })
  const files = (Array.isArray(body.files) ? body.files : [body.files]).filter((f): f is File => f instanceof File && f.size > 0)
  const category = String(body.category ?? 'common') in PHOTO_CATEGORIES ? String(body.category) : 'common'
  const roomId = int(body.room_id as string) || null
  const { n, skipped } = await storeMedia(c, id, files, category, roomId, str(body.caption as string, 120) || null)
  await afterPropertySave(c, id)
  if (category === 'room' && !roomId && n) return redirectMsg(c, `/admin/properties/${id}#media`, { err: `${n} file(s) uploaded, but no room category was chosen — pick one on each photo below.` })
  return redirectMsg(c, `/admin/properties/${id}#media`, skipped.length ? { err: `${n} uploaded; skipped (wrong type or too large): ${skipped.join(', ').slice(0, 150)}` } : { ok: `${n} file(s) added to ${PHOTO_CATEGORIES[category]}.` })
})

propertyEditorRoutes.post('/admin/properties/:id/video-link', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  const f = await form(c)
  const url = str(f.url, 300)
  if (!videoEmbedUrl(url)) return redirectMsg(c, `/admin/properties/${id}#media`, { err: 'Please paste a YouTube or Vimeo link.' })
  const category = f.category in PHOTO_CATEGORIES ? f.category : 'common'
  await run(
    c.env,
    "INSERT INTO property_photos (property_id, r2_key, caption, sort, category, room_id, media_type, video_url) VALUES (?, '', ?, 999, ?, ?, 'video', ?)",
    id, str(f.caption, 120) || null, category, category === 'room' ? int(f.room_id) || null : null, url,
  )
  await logActivity(c.env, c.get('user')!.id, 'media.video_link', 'property', id, { url })
  return redirectMsg(c, `/admin/properties/${id}#media`, { ok: 'Video added.' })
})

propertyEditorRoutes.post('/admin/photos/:id', requirePerm('manage_properties'), async (c) => {
  const ph = await first<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE id = ?', int(c.req.param('id')))
  if (!ph) return c.notFound()
  const f = await form(c)
  if (f.delete) {
    await run(c.env, 'DELETE FROM property_photos WHERE id = ?', ph.id)
    if (ph.r2_key && !ph.r2_key.startsWith('http') && !ph.r2_key.startsWith('/')) await c.env.MEDIA.delete(ph.r2_key)
    await logActivity(c.env, c.get('user')!.id, 'photo.deleted', 'property', ph.property_id, { category: ph.category })
  } else {
    const category = f.category in PHOTO_CATEGORIES ? f.category : ph.category
    await run(c.env, 'UPDATE property_photos SET caption = ?, sort = ?, category = ?, room_id = ? WHERE id = ?', str(f.caption, 120) || null, int(f.sort), category, category === 'room' ? int(f.room_id) || ph.room_id : null, ph.id)
  }
  await afterPropertySave(c, ph.property_id)
  return c.redirect(`/admin/properties/${ph.property_id}#media`, 303)
})

// ---- Seasons (fixed rate per room category) ----
propertyEditorRoutes.post('/admin/properties/:id/seasons', requirePerm('manage_properties', 'manage_rates'), async (c) => {
  const id = int(c.req.param('id'))
  const f = await form(c)
  const name = str(f.name, 60)
  if (!name || !isDate(f.start_date) || !isDate(f.end_date) || f.end_date < f.start_date) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Enter a season name and valid dates.' })
  const rooms = await all<RoomRow>(c.env, 'SELECT id, name FROM rooms WHERE property_id = ?', id)
  const minNights = int(f.min_nights) || null
  const kind = f.kind in SEASON_KINDS ? f.kind : 'season'
  const withNet = await canSeeNet(c)
  const stmts: D1PreparedStatement[] = []
  // Net rates are only edited by management; keep the old ones when someone else saves the season.
  const keptNet = new Map<number, number | null>()
  if (f.orig_key) {
    const [on, os, oe] = f.orig_key.split('|')
    if (!withNet) {
      for (const r of await all<{ room_id: number; net_rate: number | null }>(c.env, 'SELECT room_id, net_rate FROM season_rates WHERE property_id = ? AND room_id IS NOT NULL AND name = ? AND start_date = ? AND end_date = ?', id, on, os, oe)) keptNet.set(r.room_id, r.net_rate)
    }
    stmts.push(c.env.DB.prepare('DELETE FROM season_rates WHERE property_id = ? AND room_id IS NOT NULL AND rate IS NOT NULL AND name = ? AND start_date = ? AND end_date = ?').bind(id, on, os, oe))
  }
  let n = 0
  for (const r of rooms) {
    const rate = int(f[`rate_${r.id}`])
    if (rate > 0) {
      const staff = int(f[`staff_${r.id}`]) || null
      const net = withNet ? int(f[`net_${r.id}`]) || null : keptNet.get(r.id) ?? null
      stmts.push(c.env.DB.prepare('INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, min_nights, created_by, kind, staff_rate, net_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, r.id, name, f.start_date, f.end_date, rate, minNights, c.get('user')!.id, kind, staff, net))
      n++
    }
  }
  if (!n) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Enter a rate for at least one room category.' })
  await c.env.DB.batch(stmts)
  await logActivity(c.env, c.get('user')!.id, f.orig_key ? 'price.season_updated' : 'price.season_added', 'property', id, { name, from: f.start_date, to: f.end_date, rooms: n })
  await afterPropertySave(c, id)
  return redirectMsg(c, `/admin/properties/${id}#tariff`, { ok: `Season “${name}” saved.` })
})

propertyEditorRoutes.post('/admin/properties/:id/seasons/delete', requirePerm('manage_properties', 'manage_rates'), async (c) => {
  const id = int(c.req.param('id'))
  const f = await form(c)
  const [on, os, oe] = (f.orig_key ?? '').split('|')
  await run(c.env, 'DELETE FROM season_rates WHERE property_id = ? AND room_id IS NOT NULL AND rate IS NOT NULL AND name = ? AND start_date = ? AND end_date = ?', id, on ?? '', os ?? '', oe ?? '')
  await logActivity(c.env, c.get('user')!.id, 'price.season_deleted', 'property', id, { name: on, from: os, to: oe })
  return redirectMsg(c, `/admin/properties/${id}#tariff`, { ok: 'Season deleted.' })
})

// ---- AI helpers ----
propertyEditorRoutes.post('/admin/ai/description', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  const r = await writeDescription(c.env, str(f.name, 100), STAY_TYPES[f.type] ?? str(f.type, 20), str(f.destination, 60), str(f.points, 1500))
  return c.json(r ?? { error: 'AI description writer is off or unavailable.' })
})

propertyEditorRoutes.post('/admin/ai/seo', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  const r = await seoSuggest(c.env, { name: str(f.name, 100), type: STAY_TYPES[f.type] ?? str(f.type, 20), destination: str(f.destination, 60), description: str(f.description, 3000) })
  return c.json(r ?? { error: 'AI SEO suggestions are off or unavailable.' })
})

propertyEditorRoutes.post('/admin/ai/extract-property', requirePerm('manage_properties'), async (c) => {
  const f = await form(c)
  const text = str(f.text, 12000)
  const body = await c.req.parseBody()
  const file = body.doc instanceof File && body.doc.size > 0 ? body.doc : null
  if (text.length < 20 && !file) return c.json({ error: 'Paste a few lines about the property, or attach a PDF / Word file.' })
  const doc = file ? { name: file.name, type: file.type, data: await file.arrayBuffer() } : null
  return c.json(await extractProperty(c.env, text, doc))
})
