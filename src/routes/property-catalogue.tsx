import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { all, first, logActivity, run } from '../lib/db'
import { catalogueAdmin, catalogueStaff, loadCatalogue, type Catalogue } from '../lib/property-catalogue'
import { PHOTO_CATEGORIES } from '../lib/catalog'
import { FACILITIES } from '../lib/search'
import { mediaUrl } from '../lib/integrations'
import type { PhotoRow } from '../lib/types'
import { int, money, nowIso, parseJson, str } from '../lib/util'
import { page } from '../views/layout'
import { Field, Select } from '../views/components'
import { afterPropertySave, storeMedia } from './admin-properties'
import { form } from './helpers'

export const catalogueRoutes = new Hono<AppEnv>()
const priceText = (v?: number | null) => v == null ? 'Not supplied' : money(v)

// This component only receives a role-projected DTO, never raw internal rows.
export function CatalogueContent({ data, photos = [], manage = false, admin = false, roomId }: {
  data: Catalogue; photos?: PhotoRow[]; manage?: boolean; admin?: boolean; roomId?: number
}) {
  const p = data.property
  const rooms = roomId ? data.rooms.filter((r) => r.id === roomId) : data.rooms
  const root = `/staff/catalogue/${p.id}`
  return <div class="wrap section stack-lg">
    <div><h1>{p.name}</h1><p>{p.classification} · {p.destination}</p><p>{p.description}</p></div>
    <div class="chips">{parseJson<string[]>(p.facilities, []).map((f) => <span class="chip">{FACILITIES[f] ?? f}</span>)}</div>
    {photos.filter((ph) => ph.media_type === 'image' && ph.r2_key && (!roomId || ph.room_id === roomId)).length > 0 &&
      <div class="grid grid-3">{photos.filter((ph) => ph.media_type === 'image' && ph.r2_key && (!roomId || ph.room_id === roomId)).map((ph) =>
        <a href={mediaUrl(ph.r2_key)}><img src={mediaUrl(ph.r2_key, 600)} alt={ph.caption ?? p.name} loading="lazy" /></a>)}</div>}
    <section class="stack" id="rooms"><h2>Room categories · {data.rooms.reduce((n,r) => n+r.units,0)} rooms</h2>
      {rooms.map((r) => <article class="card stack">
        <h3><a href={`/stay/${p.slug}/room/${r.id}`}>{r.name}</a></h3>
        <p>{r.units} rooms{r.capacity == null ? '' : ` · ${r.capacity} Pax`}</p>
        {r.description && <p>{r.description}</p>}
        <p class="price">Rack Rate: {money(r.rack_rate)} <span class="small">{r.rack_basis}</span></p>
        {data.periods.filter((s) => s.room_id === r.id).length > 0 && <div class="table-scroll"><table>
          <thead><tr><th>Period</th><th>Staff Rate</th>{admin && <th>B2B / Special Rate</th>}</tr></thead>
          <tbody>{data.periods.filter((s) => s.room_id === r.id).map((s) => <tr>
            <td>{s.start_date} – {s.end_date}</td><td>{priceText(s.staff_rate)}{s.staff_basis ? ` ${s.staff_basis}` : ''}</td>
            {admin && <td>{priceText(s.net_rate)}{s.net_basis ? ` ${s.net_basis}` : ''}</td>}
          </tr>)}</tbody>
        </table></div>}
        {manage && <details><summary>Edit room details and Rack Rate</summary><form method="post" action={`${root}/rooms/${r.id}`} class="stack">
          <Field label="Description"><textarea name="description">{r.description}</textarea></Field>
          <Field label="Inventory"><input name="units" type="number" min="0" value={r.units} required /></Field>
          <Field label="Occupancy (leave blank if unknown)"><input name="capacity" type="number" min="1" value={r.capacity ?? ''} /></Field>
          <Field label="Rack Rate (+ GST)"><input name="rack_rate" type="number" min="0" value={r.rack_rate} required /></Field>
          <button class="btn btn-sm">Save room</button>
        </form></details>}
        {manage && data.periods.filter((s) => s.room_id === r.id).map((s) => <details><summary>Edit rates: {s.start_date} – {s.end_date}</summary>
          <form method="post" action={`${root}/periods/${s.id}`} class="stack">
            <Field label="Staff Rate (blank = Not supplied)"><input name="staff_rate" type="number" min="0" value={s.staff_rate ?? ''} /></Field>
            {admin && <Field label="B2B / Special Rate (CPAI)"><input name="net_rate" type="number" min="0" value={s.net_rate ?? ''} /></Field>}
            <button class="btn btn-sm">Save rates</button>
          </form></details>)}
      </article>)}
    </section>
    <section class="stack"><h2>Additional charges and arrangements</h2>
      {data.charges.map((ch) => <div class="card stack-sm">
        <strong>{ch.name}{ch.mandatory ? ' · Mandatory' : ''}</strong>
        {ch.start_date && <div>{ch.start_date}{ch.end_date !== ch.start_date ? ` – ${ch.end_date}` : ''}</div>}
        <div>{money(ch.amount)}{ch.child_amount != null ? ` / ${money(ch.child_amount)} per child` : ''}{ch.basis ? ` · ${ch.basis}` : ''}{ch.rate_basis ? ` · ${ch.rate_basis}` : ''}</div>
        {ch.options !== '[]' && <div>Available at: {parseJson<string[]>(ch.options, []).join(', ')}</div>}
        {ch.notes && <div>{ch.notes}</div>}
        {manage && <details><summary>Edit supplied charge</summary><form method="post" action={`${root}/charges/${ch.id}`} class="stack">
          <Field label="Price"><input type="number" min="0" name="amount" value={ch.amount} required /></Field>
          {ch.child_amount != null && <Field label="Child price"><input type="number" min="0" name="child_amount" value={ch.child_amount} required /></Field>}
          <button class="btn btn-sm">Save charge</button>
        </form></details>}
      </div>)}
    </section>
    <section class="stack"><h2>Policies</h2>
      <p>{parseJson<{child?: string}>(p.policies, {}).child}</p>
      {p.address && <p>Address: {p.address}</p>}
      {p.checkin_time && <p>Check-in: {p.checkin_time}</p>}{p.checkout_time && <p>Check-out: {p.checkout_time}</p>}
      <h3>Cancellation policy</h3><p class="pre-line">{p.cancellation_policy}</p>
    </section>
    {manage && <>
      <details class="card"><summary>Edit property details</summary><form method="post" action={root} class="stack">
        <Field label="Description"><textarea name="description">{p.description}</textarea></Field>
        <Field label="Exact address (blank = unknown)"><textarea name="address">{p.address ?? ''}</textarea></Field>
        <Field label="Check-in (blank = unknown)"><input name="checkin_time" type="time" value={p.checkin_time ?? ''} /></Field>
        <Field label="Check-out (blank = unknown)"><input name="checkout_time" type="time" value={p.checkout_time ?? ''} /></Field>
        <button class="btn btn-sm">Save details</button>
      </form></details>
      <section class="card stack" id="media"><h2>Property and room photos</h2>
        <form method="post" action={`${root}/media`} enctype="multipart/form-data" class="stack">
          <Field label="Section"><Select name="category" options={Object.entries(PHOTO_CATEGORIES)} /></Field>
          <Field label="Room category (required for room photos)"><Select name="room_id" options={[[ '', 'Property-level'], ...data.rooms.map((r): [number,string] => [r.id,r.name])]} /></Field>
          <input type="file" name="files" accept="image/*" multiple required /><Field label="Caption"><input name="caption" /></Field>
          <button class="btn btn-sm">Upload approved photos</button>
        </form>
        {photos.map((ph) => <form method="post" action={`${root}/photos/${ph.id}`} class="row wrap-row">
          <span>{ph.caption ?? ph.r2_key}</span><Select name="category" value={ph.category} options={Object.entries(PHOTO_CATEGORIES)} />
          <Select name="room_id" value={ph.room_id} options={[[ '', 'Property-level'], ...data.rooms.map((r): [number,string] => [r.id,r.name])]} />
          <input name="caption" value={ph.caption ?? ''} aria-label="Caption" /><button class="btn btn-sm">Save mapping</button>
          <button class="btn btn-sm btn-danger" name="delete" value="1">Delete photo</button>
        </form>)}
      </section>
    </>}
  </div>
}
export async function cataloguePage(c: Context<AppEnv>, id: number, manage = false, roomId?: number) {
  const role = manage ? c.get('user')?.role ?? null : null // Public share URLs always contain Rack only.
  const data = await loadCatalogue(c.env, id, role)
  if (!data || (!manage && data.property.status !== 'live') || (roomId && !data.rooms.some((r) => r.id === roomId))) return c.notFound()
  const photos = await all<PhotoRow>(c.env, 'SELECT * FROM property_photos WHERE property_id = ? ORDER BY sort,id', id)
  if (manage) c.header('Cache-Control', 'private, no-store')
  return page(c, { title: data.property.name, ...(manage ? { area: 'staff' as const, active: 'rooms', noindex: true } : {}) },
    <CatalogueContent data={data} photos={photos} manage={manage} admin={catalogueAdmin(role)} roomId={roomId} />)
}

catalogueRoutes.use('/staff/catalogue/*', async (c, next) => {
  if (!catalogueStaff(c.get('user')?.role)) return c.text('Staff only', 403)
  const p = await first<{id:number}>(c.env, 'SELECT id FROM properties WHERE id=? AND catalogue_only=1', int(c.req.path.split('/')[3]))
  if (!p) return c.notFound()
  c.header('Cache-Control', 'private, no-store')
  return next()
})
catalogueRoutes.get('/staff/catalogue/:id', (c) => cataloguePage(c, int(c.req.param('id')), true))
const nullable = (value: string | undefined) => value?.trim() || null
function amount(value: string | undefined): number | null {
  if (!value?.trim()) return null
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN
}
async function saved(c: Context<AppEnv>, id: number, action: string) {
  // Never copy internal prices to audit records or shared KB documents.
  await run(c.env, 'UPDATE properties SET updated_at=? WHERE id=?', nowIso(), id)
  await logActivity(c.env, c.get('user')!.id, action, 'property', id)
  await afterPropertySave(c, id)
  return c.redirect(`/staff/catalogue/${id}`, 303)
}
catalogueRoutes.post('/staff/catalogue/:id', async (c) => {
  const f = await form(c), id = int(c.req.param('id'))
  for (const key of ['checkin_time','checkout_time']) if (f[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f[key])) return c.text('Invalid time', 400)
  await run(c.env, 'UPDATE properties SET description=?,address=?,checkin_time=?,checkout_time=? WHERE id=?', str(f.description,12000), nullable(f.address), nullable(f.checkin_time), nullable(f.checkout_time),id)
  return saved(c,id,'catalogue.details_updated')
})
catalogueRoutes.post('/staff/catalogue/:id/rooms/:roomId', async (c) => {
  const f=await form(c), id=int(c.req.param('id')), roomId=int(c.req.param('roomId'))
  const units=amount(f.units), rack=amount(f.rack_rate), capacity=amount(f.capacity)
  if (units == null || rack == null || [units,rack,capacity].some((v) => v != null && (!Number.isFinite(v) || v > 10000000)) || capacity === 0) return c.text('Invalid room details',400)
  if (!await first(c.env,'SELECT id FROM rooms WHERE id=? AND property_id=?',roomId,id)) return c.notFound()
  await run(c.env,'UPDATE rooms SET description=?,units=?,capacity=?,rack_rate=?,base_rate=? WHERE id=? AND property_id=?',str(f.description,8000),units,capacity,rack,rack,roomId,id)
  return saved(c,id,'catalogue.room_updated')
})
catalogueRoutes.post('/staff/catalogue/:id/periods/:periodId',async(c)=>{
  const f=await form(c),id=int(c.req.param('id')),periodId=int(c.req.param('periodId')),admin=catalogueAdmin(c.get('user')?.role)
  if (!admin && Object.keys(f).some((k)=>/net|b2b/i.test(k))) return c.text('Admin only',403)
  const row=await first(c.env,'SELECT t.id FROM catalogue_rate_periods t JOIN rooms r ON r.id=t.room_id WHERE t.id=? AND r.property_id=?',periodId,id)
  if(!row)return c.notFound()
  const staff=amount(f.staff_rate),net=admin?amount(f.net_rate):null
  if([staff,net].some((v)=>v!=null&&!Number.isFinite(v)))return c.text('Invalid price',400)
  await run(c.env,`UPDATE catalogue_rate_periods SET staff_rate=?${admin?',net_rate=?':''} WHERE id=?`,staff,...(admin?[net]:[]),periodId)
  return saved(c,id,'catalogue.period_updated')
})
catalogueRoutes.post('/staff/catalogue/:id/charges/:chargeId',async(c)=>{
  const f=await form(c),id=int(c.req.param('id')),chargeId=int(c.req.param('chargeId'))
  const before=await first<{child_amount:number|null}>(c.env,'SELECT child_amount FROM property_charges WHERE property_id=? AND id=?',id,chargeId)
  if(!before)return c.notFound()
  const price=amount(f.amount),child=before.child_amount==null?null:amount(f.child_amount)
  if(price==null||!Number.isFinite(price)||(before.child_amount!=null&&(child==null||!Number.isFinite(child))))return c.text('Invalid price',400)
  await run(c.env,'UPDATE property_charges SET amount=?,child_amount=? WHERE property_id=? AND id=?',price,child,id,chargeId)
  return saved(c,id,'catalogue.charge_updated')
})
async function mediaMapping(c: Context<AppEnv>,id:number,category:string,roomId:number|null){
  if(!(category in PHOTO_CATEGORIES))return false
  return category!=='room' || !!(roomId && await first(c.env,'SELECT id FROM rooms WHERE id=? AND property_id=?',roomId,id))
}
catalogueRoutes.post('/staff/catalogue/:id/media',async(c)=>{
  const id=int(c.req.param('id')),body=await c.req.parseBody({all:true}),category=String(body.category??'common'),roomId=int(String(body.room_id??''))||null
  if(!await mediaMapping(c,id,category,roomId))return c.text('Select a room belonging to this property',400)
  const files=(Array.isArray(body.files)?body.files:[body.files]).filter((f):f is File=>f instanceof File&&f.size>0)
  const result=await storeMedia(c,id,files,category,category==='room'?roomId:null,str(String(body.caption??''),120)||null)
  if(result.skipped.length)return c.text(`Some files were skipped: ${result.skipped.join(', ')}`,400)
  return saved(c,id,'catalogue.media_updated')
})
catalogueRoutes.post('/staff/catalogue/:id/photos/:photoId',async(c)=>{
  const id=int(c.req.param('id')),photoId=int(c.req.param('photoId')),f=await form(c),roomId=int(f.room_id)||null
  const photo=await first<{r2_key:string}>(c.env,'SELECT r2_key FROM property_photos WHERE id=? AND property_id=?',photoId,id)
  if(!photo)return c.notFound()
  if(f.delete){
    if(photo.r2_key && !photo.r2_key.startsWith('http') && !photo.r2_key.startsWith('/')) await c.env.MEDIA.delete(photo.r2_key)
    await run(c.env,'DELETE FROM property_photos WHERE id=? AND property_id=?',photoId,id)
    return saved(c,id,'catalogue.photo_deleted')
  }
  if(!await mediaMapping(c,id,f.category,roomId))return c.text('Invalid media mapping',400)
  await run(c.env,'UPDATE property_photos SET category=?,room_id=?,caption=? WHERE id=? AND property_id=?',f.category,f.category==='room'?roomId:null,str(f.caption,120)||null,photoId,id)
  return saved(c,id,'catalogue.media_updated')
})
