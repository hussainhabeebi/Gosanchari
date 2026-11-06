// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { adminRoutes } from '../src/routes/admin'
import { opsRoutes } from '../src/routes/staff-ops'
import { publicRoutes } from '../src/routes/public'
import { combinedQuotationPrice, quotationPrice, splitGuests } from '../src/lib/quotation-pricing'
import { cancelBooking } from '../src/lib/bookings'
import { roomAvailability } from '../src/lib/db'
import type { RoomRates } from '../src/lib/pricing'

const nonAc: RoomRates = { id: 1, property_id: 9, base_rate: 3000, weekend_rate: null, staff_rate: 2500, min_nights: 1, capacity: 2, units: 4 }
const ac: RoomRates = { id: 2, property_id: 9, base_rate: 4000, weekend_rate: null, staff_rate: 3200, min_nights: 1, capacity: 2, units: 4 }
const line = (room: RoomRates, roomsCount: number, adults = 0) => ({ room, seasons: [], checkIn: '2030-11-04', checkOut: '2030-11-06', roomsCount, adults, children: 0 })

describe('combined room categories: pricing', () => {
  it('one category prices exactly as before', () => {
    const one = combinedQuotationPrice([line(nonAc, 4, 8)], { discountAmount: 1000, extraCharges: 500 })
    const before = quotationPrice({ ...line(nonAc, 4, 8), discountAmount: 1000, extraCharges: 500 })
    const { parts, ...rest } = one
    expect(rest).toEqual(before)
    expect(parts).toHaveLength(1)
  })

  it('adds the categories: 4 Non-AC + 2 AC for 2 nights', () => {
    const p = combinedQuotationPrice([line(nonAc, 4, 8), line(ac, 2, 4)], { discountAmount: 0, extraCharges: 0 })
    expect(p.errors).toEqual([])
    expect(p.roomsCount).toBe(6)
    expect(p.parts.map((x) => x.roomCharges)).toEqual([3000 * 4 * 2, 4000 * 2 * 2])
    expect(p.roomCharges).toBe(40000)
    expect(p.taxes).toBe(2000) // both under ₹7,500 / night: 5%
    expect(p.total).toBe(42000)
    expect(p.staffAccommodation).toBe(2500 * 4 * 2 + 3200 * 2 * 2)
    expect(p.maximumDiscount).toBe(40000 - 32800)
  })

  it('checks the discount against the combined Staff floor and keeps every category above its own floor', () => {
    const lines = [line(nonAc, 4), line(ac, 2)]
    const ok = combinedQuotationPrice(lines, { discountAmount: 7200 })
    expect(ok.errors).toEqual([])
    expect(ok.discount).toBe(7200)
    ok.parts.forEach((part) => expect(part.roomCharges - part.discount).toBeGreaterThanOrEqual(part.staffAccommodation!))
    const over = combinedQuotationPrice(lines, { discountAmount: 7201 })
    expect(over.errors.join(' ')).toContain('below the Staff Rate')
  })

  it('uses each category’s own GST slab', () => {
    const lux: RoomRates = { ...ac, id: 3, base_rate: 9000, staff_rate: 8000 }
    const p = combinedQuotationPrice([line(nonAc, 1), line(lux, 1)], { discountAmount: 0 })
    expect(p.parts.map((x) => x.taxes)).toEqual([300, 3240]) // 5% of 6,000 and 18% of 18,000
    expect(p.taxes).toBe(3540)
  })

  it('shares guests across categories before charging or rejecting', () => {
    expect(splitGuests([{ capacity: 2, rooms: 4 }, { capacity: 2, rooms: 2 }], 11, 1)).toEqual([{ adults: 8, children: 0 }, { adults: 3, children: 1 }])
    expect(splitGuests([{ capacity: 3, base_guests: 2, rooms: 1 }, { capacity: 2, rooms: 1 }], 5, 0)).toEqual([{ adults: 3, children: 0 }, { adults: 2, children: 0 }])
    const p = combinedQuotationPrice([line(nonAc, 4, 8), line(ac, 2, 4)], { discountAmount: 0 })
    expect(p.errors).toEqual([])
    expect(p.extraGuests?.max).toBe(12)
  })
})

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const pid = Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status,meal_plans) VALUES('ice-hills','Ice Hills Resort','resort','Munnar','live','[\"CP\"]')").run().lastInsertRowid)
  const room = (name: string, rate: number, staff: number) => Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate,capacity,units) VALUES(?,?,?,?,?,2,4)').run(pid, name, rate, staff, staff - 500).lastInsertRowid)
  const nonAcId = room('Standard Non-AC', 3000, 2500), acId = room('Standard AC', 4000, 3200)
  const qid = Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,phone,email,valid_till,status) VALUES('QT-ICE','ice-token',1,'Guest','919999999999','guest@example.test','2030-12-31','draft')").run().lastInsertRowid)
  const oid = Number(db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan,subtotal,taxes,total) VALUES(?,?,?,'2030-11-04','2030-11-06',2,1,'CP',6000,300,6300)").run(qid, pid, nonAcId).lastInsertRowid)
  const DB = { prepare(sql: string) { let args: any[] = []; const st = { bind(...v: any[]) { args = v; return st }, async all() { return { results: db.prepare(sql).all(...args) } }, async first() { return db.prepare(sql).get(...args) ?? null }, async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } } } }; return st }, async batch(statements:any[]){db.exec('BEGIN');try{const results=[];for(const st of statements)results.push(await st.all());db.exec('COMMIT');return results}catch(error){db.exec('ROLLBACK');throw error}} }
  const env: any = { DB, KV: { async get() { return null }, async put() {}, async delete() {} }, JOBS: { async send() {} }, MEDIA: { put: vi.fn(async () => {}) }, SITE_URL: 'http://localhost', ENVIRONMENT: 'development' }
  const app = new Hono<any>().use('*', async (c, next) => { c.set('user', { id: 1, name: 'Admin', role: 'admin', language: 'en' }); await next() }).route('/', opsRoutes).route('/', adminRoutes)
  const publicApp = new Hono<any>().use('*', async (c, next) => { c.set('user', null); await next() }).route('/', publicRoutes)
  const url = 'http://localhost/staff/quotes/' + qid
  const form = (extra: [number, number, string?][] = [[acId, 2]]) => {
    const b = new URLSearchParams({ opt_id: String(oid), guest_name: 'Guest', phone: '919999999999', email: 'guest@example.test', valid_till: '2030-12-31', gst_control: '1', apply_gst: '1',
      [`room_${oid}`]: String(nonAcId), [`in_${oid}`]: '2030-11-04', [`out_${oid}`]: '2030-11-06', [`rooms_${oid}`]: '4', [`adults_${oid}`]: '12', [`children_${oid}`]: '0', [`meal_${oid}`]: 'CP', [`discount_${oid}`]: '0' })
    for (const [id, n, rate] of extra) { b.append(`xroom_${oid}`, String(id)); b.append(`xrooms_${oid}`, String(n)); b.append(`xgrate_${oid}`, rate ?? '') }
    return b
  }
  // Historical final confirmation fixture; conversion must never replace final Admin verification.
  const approve = () => db.prepare(`INSERT INTO quotation_confirmation_requests(code,quotation_id,option_id,requested_by,submission_key,details,status,payment_verified,availability_verified,decided_by,decided_at)
    VALUES('VC-FINAL',?,?,1,'historical-final-approval','{}','approved',1,1,1,'2030-10-01')`).run(qid,oid)
  const read = () => db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
  return { db, env, app, publicApp, url, pid, nonAcId, acId, qid, oid, form, read, approve }
}

describe('combined room categories: quotation builder', () => {
  it('saves 4 Standard Non-AC + 2 Standard AC in one option, and the live preview matches the save', async () => {
    const f = fixture()
    const preview = (await (await f.app.request(f.url + '/recalculate', { method: 'POST', body: f.form() }, f.env)).json() as any).options[0]
    expect(preview.errors).toEqual([])
    expect(preview.rows.map((r: string[]) => r[0]).slice(0, 2)).toEqual(['Standard Non-AC (2 nights × 4 rooms)', 'Standard AC (2 nights × 2 rooms)'])
    const res = await f.app.request(f.url, { method: 'POST', body: f.form() }, f.env)
    expect(res.headers.get('location')).not.toContain('err=')
    const saved = f.read()
    expect(JSON.parse(saved.extra_rooms)).toEqual([{ room_id: f.acId, rooms_count: 2, guest_rate: null }])
    expect(saved.subtotal).toBe(3000 * 4 * 2 + 4000 * 2 * 2)
    expect([preview.subtotal, preview.taxes, preview.total]).toEqual([saved.subtotal, saved.taxes, saved.total])

    const html = await (await f.app.request(f.url, {}, f.env)).text()
    expect(html).toContain('Combined: Standard Non-AC × 4 + Standard AC × 2 = 6 rooms')
    expect(html).toContain('+ Add another room category')
    expect(html).toMatch(new RegExp(`name="xroom_${f.oid}"[^>]*>[\\s\\S]*?<option value="${f.acId}" selected`))
  })

  it('needs the second category for 12 guests in 2-guest rooms, and removing it clears the list', async () => {
    const f = fixture()
    const alone = (await (await f.app.request(f.url + '/recalculate', { method: 'POST', body: f.form([]) }, f.env)).json() as any).options[0]
    expect(alone.errors.join(' ')).toContain('sleep at most 8 guests')
    await f.app.request(f.url, { method: 'POST', body: f.form() }, f.env)
    const b = f.form([]); b.set(`adults_${f.oid}`, '8')
    await f.app.request(f.url, { method: 'POST', body: b }, f.env)
    expect(f.read()).toMatchObject({ extra_rooms: '[]', subtotal: 24000 })
  })

  it('ignores a room category from another property', async () => {
    const f = fixture()
    const other = Number(f.db.prepare("SELECT id FROM rooms WHERE property_id != ? LIMIT 1").get(f.pid).id)
    await f.app.request(f.url, { method: 'POST', body: f.form([[f.acId, 2], [other, 3]]) }, f.env)
    expect(JSON.parse(f.read().extra_rooms)).toEqual([{ room_id: f.acId, rooms_count: 2, guest_rate: null }])
  })

  it('shows every category on the guest link and the PDF', async () => {
    const f = fixture()
    await f.app.request(f.url, { method: 'POST', body: f.form() }, f.env)
    f.db.prepare("UPDATE quotations SET status='sent' WHERE id=?").run(f.qid)
    const guest = await (await f.publicApp.request('http://localhost/q/ice-token', {}, f.env)).text()
    expect(guest).toContain('Standard Non-AC × 4 + Standard AC × 2 (6 rooms)')
    const pdf = await (await f.app.request(f.url + '/print', {}, f.env)).text()
    expect(pdf).toContain('<strong>Standard AC</strong> · 2 rooms')
    expect(pdf).toContain('Total: 6 rooms')
  })

  it('converts to one booking that reserves the AC rooms too, and cancelling releases them', async () => {
    const f = fixture()
    await f.app.request(f.url, { method: 'POST', body: f.form() }, f.env)
    f.db.prepare("UPDATE quotations SET status='accepted' WHERE id=?").run(f.qid)
    f.approve()
    const res = await f.app.request(f.url + '/convert', { method: 'POST', body: new URLSearchParams() }, f.env)
    expect(res.headers.get('location')).toMatch(/\/staff\/bookings\/\d+/)
    const b = f.db.prepare('SELECT * FROM bookings WHERE quotation_id=?').get(f.qid) as any
    expect(b).toMatchObject({ room_id: f.nonAcId, rooms_count: 4, status: 'confirmed', total: f.read().total })
    expect(JSON.parse(b.extra_rooms)).toEqual([{ room_id: f.acId, rooms_count: 2, guest_rate: null }])
    const avail = await roomAvailability(f.env, [f.pid], '2030-11-04', '2030-11-06')
    expect([avail.get(f.nonAcId)!.free, avail.get(f.acId)!.free]).toEqual([0, 2])

    const detail = await (await f.app.request(`http://localhost/staff/bookings/${b.id}`, {}, f.env)).text()
    expect(detail).toContain('Standard Non-AC × 4 + Standard AC × 2')
    const change = await f.app.request(`http://localhost/staff/bookings/${b.id}/change`, { method: 'POST', body: new URLSearchParams({ check_in: '2030-11-10', check_out: '2030-11-12', room_id: String(f.nonAcId) }) }, f.env)
    expect(decodeURIComponent((change.headers.get('location') ?? '').replace(/\+/g, ' '))).toContain('combines room categories')

    await cancelBooking(f.env, b.id, 1, 'test', null)
    const after = await roomAvailability(f.env, [f.pid], '2030-11-04', '2030-11-06')
    expect([after.get(f.nonAcId)!.free, after.get(f.acId)!.free]).toEqual([4, 4])
  })

  it('refuses to convert when the extra category is no longer free', async () => {
    const f = fixture()
    await f.app.request(f.url, { method: 'POST', body: f.form() }, f.env)
    for (let k = 0; k < 3; k++) f.db.prepare("INSERT INTO blocked_dates(property_id,room_id,date,reason) VALUES(?,?,'2030-11-05','Owner use')").run(f.pid, f.acId)
    f.approve()
    const res = await f.app.request(f.url + '/convert', { method: 'POST', body: new URLSearchParams() }, f.env)
    expect(decodeURIComponent((res.headers.get('location') ?? '').replace(/\+/g, ' '))).toContain('Standard AC is no longer available for 2 rooms')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE quotation_id=?').get(f.qid)).toMatchObject({ n: 0 })
  })
})

describe('unique automatically priced room categories', () => {
  it('rejects duplicate categories on preview and Save without writing', async () => {
    const f=fixture(), before=JSON.stringify(f.read());
    for(const extra of [[[f.nonAcId,2]],[[f.acId,1],[f.acId,1]]] as [number,number][][]){
      const preview=await f.app.request(f.url+'/recalculate',{method:'POST',body:f.form(extra)},f.env)
      expect(preview.status).toBe(422);expect(await preview.text()).toContain('only once')
      expect((await f.app.request(f.url,{method:'POST',body:f.form(extra)},f.env)).status).toBe(422)
      expect(JSON.stringify(f.read())).toBe(before)
    }
  })
  it('ignores forged manual rates for added categories and resolves the configured rate',async()=>{
    const f=fixture(), body=f.form([[f.acId,2,'1']]);
    const preview=await(await f.app.request(f.url+'/recalculate',{method:'POST',body},f.env)).json() as any
    expect(preview.options[0].rateLines[0]).toMatchObject({roomId:f.acId,label:'₹4,000'})
    await f.app.request(f.url,{method:'POST',body},f.env)
    expect(f.read().subtotal).toBe(40000);expect(JSON.parse(f.read().extra_rooms)[0].guest_rate).toBeNull()
    expect(preview.options[0].total).toBe(f.read().total)
    const html=await(await f.app.request(f.url,{},f.env)).text()
    expect(html).toContain('data-extra-room-rate');expect(html).not.toContain(`name="xgrate_${f.oid}"`)
  })
  it('validates combined capacity for 4 + 3 rooms and 21 guests',async()=>{
    const f=fixture();f.db.prepare('UPDATE rooms SET capacity=3 WHERE property_id=?').run(f.pid)
    const body=f.form([[f.acId,3]]);body.set(`adults_${f.oid}`,'21')
    const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body},f.env)).json() as any).options[0]
    expect(p.errors).toEqual([]);expect(p.rows[0][0]).toContain('4 rooms');expect(p.rows[1][0]).toContain('3 rooms')
    body.set(`adults_${f.oid}`,'22')
    const over=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body},f.env)).json() as any).options[0]
    expect(over.errors.join(' ')).toContain('21 guests')
  })
  it('blocks Save when an added category has no rate, without inventing a fallback',async()=>{
    const f=fixture(),before=JSON.stringify(f.read());f.db.prepare('UPDATE rooms SET base_rate=0,staff_rate=NULL WHERE id=?').run(f.acId)
    const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body:f.form()},f.env)).json() as any).options[0]
    expect(p.errors.length).toBeGreaterThan(0);expect(p.rateLines[0].label).toContain('could not be resolved')
    const r=await f.app.request(f.url,{method:'POST',body:f.form()},f.env);expect(r.headers.get('location')).toContain('err=')
    expect(JSON.stringify(f.read())).toBe(before)
  })
})


describe('quotation submission is not booking confirmation',()=>{
 it('shows direct quotation actions and preserves standalone edit controls',async()=>{
  const f=fixture(),html=await(await f.app.request(f.url,{},f.env)).text()
  const actions=html.split('sticky-actions')[1].split('</div>')[0]
  for(const label of ['Save Draft','Generate / Download Quotation','Share Quotation','Record Advance Payment','Request Booking Confirmation'])expect(actions).toContain(label)
  expect(actions).not.toContain('Save & send');expect(actions).not.toContain('Save & email')
 })
 it('issues a quotation directly without creating any confirmation or payment',async()=>{
  const f=fixture();const tables=['bookings','payments','booking_vouchers','quotation_confirmation_requests']
  const counts=()=>tables.map(t=>f.db.prepare('SELECT COUNT(*) AS n FROM '+t).get().n)
  const before=counts();await f.app.request(f.url+'/share',{method:'POST',body:f.form()},f.env)
  expect(f.db.prepare('SELECT status FROM quotations WHERE id=?').get(f.qid).status).toBe('sent')
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='quote.approval_requested'").get().n).toBe(0)
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='quote.issued'").get().n).toBe(1)
  expect(counts()).toEqual(before)
 })
 it('Download saves edited amounts as draft and opens the existing quotation PDF, never a voucher',async()=>{
  const f=fixture(),body=f.form();body.set(`kids_${f.oid}`,'400')
  const response=await f.app.request(f.url+'/download',{method:'POST',body},f.env)
  expect(response.headers.get('location')).toBe(`/staff/quotes/${f.qid}/print?download=1`)
  expect(f.db.prepare('SELECT status FROM quotations WHERE id=?').get(f.qid).status).toBe('draft')
  const html=await(await f.app.request(f.url+'/print?download=1',{},f.env)).text()
  expect(html).toContain('data-auto-download="1"');expect(html).toContain('Please note this is not a confirmation voucher')
  expect(html).toContain('Balance amount to be paid at the hotel at check-in time.');expect(html).not.toContain('BOOKING CONFIRMED')
 })
 it('resolves the added category’s season, weekend and peak rates and keeps categories independent',async()=>{
  const f=fixture();f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,kind,start_date,end_date,rate,weekend_rate,staff_rate,staff_weekend_rate,meal_plan) VALUES(?,?,'Season','season','2030-11-01','2030-11-30',7000,8000,3500,4000,'CP')").run(f.pid,f.acId)
  f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,kind,start_date,end_date,supplement) VALUES(?,NULL,'Peak','special','2030-11-02','2030-11-02',1000)").run(f.pid)
  const body=f.form();body.set(`in_${f.oid}`,'2030-11-01');body.set(`out_${f.oid}`,'2030-11-04')
  const p=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body},f.env)).json() as any).options[0]
  expect(p.errors).toEqual([]);expect(p.rateLines[0].label).not.toContain('could not')
  await f.app.request(f.url,{method:'POST',body},f.env);expect(p.total).toBe(f.read().total)
  body.set(`in_${f.oid}`,'2030-12-04');body.set(`out_${f.oid}`,'2030-12-06')
  const base=(await(await f.app.request(f.url+'/recalculate',{method:'POST',body},f.env)).json() as any).options[0]
  expect(base.rateLines[0].label).toBe('₹4,000')
 })
})

it('permits the same categories in separate alternatives without leaking B2B rates to Staff',async()=>{
 const f=fixture();const second=Number(f.db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan) SELECT quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count,meal_plan FROM quotation_options WHERE id=?').run(f.oid).lastInsertRowid)
 const body=f.form();body.append('opt_id',String(second));for(const [key,value] of f.form()){if(key.endsWith('_'+f.oid))body.append(key.slice(0,-String(f.oid).length)+second,value)}
 const staff=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Staff',role:'sales',language:'en'});await next()}).route('/',opsRoutes)
 const response=await staff.request(f.url+'/recalculate',{method:'POST',body},f.env);expect(response.status).toBe(200)
 const data=await response.json() as any;expect(data.options).toHaveLength(2);expect(JSON.stringify(data)).not.toMatch(/B2B|Net for|internal|net_rate/)
 expect(data.options[0].rateLines).toEqual(data.options[1].rateLines)
})

it('retired preliminary approval cannot alter a directly editable legacy quotation',async()=>{
 const f=fixture();f.db.prepare("UPDATE quotations SET status='pending_approval' WHERE id=?").run(f.qid)
 const edit=f.form();edit.set(`kids_${f.oid}`,'500');await f.app.request(f.url,{method:'POST',body:edit},f.env)
 const before=JSON.stringify(f.read())
 await f.app.request('http://localhost/admin/quotes/'+f.qid+'/approve',{method:'POST',body:new URLSearchParams()},f.env)
 expect(f.db.prepare('SELECT status FROM quotations WHERE id=?').get(f.qid).status).toBe('draft')
 expect(JSON.stringify(f.read())).toBe(before)
 expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action='quote.discount_approved'").get().n).toBe(0)
})
