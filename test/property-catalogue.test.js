// Integration tests use real SQLite, D1-shaped adapters, real route handlers and session middleware.
// Requires Node >=22.13 (node:sqlite); no network or production resources.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { generate } from '../scripts/generate-golden-munnar.mjs'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { catalogueRoutes } from '../src/routes/property-catalogue'
import { publicRoutes } from '../src/routes/public'
import { staffRoomRoutes } from '../src/routes/staff-rooms'
import { propertyEditorRoutes } from '../src/routes/admin-properties'
import { rateSheetRoutes } from '../src/routes/admin-ratesheet'
import { catalogueLegacyGuard } from '../src/routes/catalogue-guard'
import { sessionMiddleware } from '../src/lib/auth'
import { catalogueDocument, catalogueRate, chargesOn, loadCatalogue } from '../src/lib/property-catalogue'
import { loadPricing } from '../src/lib/db'
import { cardsByIds, propertyDoc, searchProperties } from '../src/lib/properties'
import { propertyInfo } from '../src/lib/assistant'
import { createBooking } from '../src/lib/bookings'
import { guardSql } from '../src/lib/sqlguard'
import { sha256Hex } from '../src/lib/util'

// Exact private client data is tested locally when present. Public CI validates the same
// access and boundary behaviour with clearly synthetic internal figures, never client prices.
const privateSource=new URL('../data/golden-munnar-palace.json',import.meta.url)
const source=process.env.CATALOGUE_SYNTHETIC_TESTS==='1'||!existsSync(privateSource)
  ?new URL('./fixtures/catalogue.synthetic.json',import.meta.url):privateSource
const data=JSON.parse(readFileSync(source,'utf8'))
const sql=generate(data)
const april=data.rooms[0].periods[0],may=data.rooms[0].periods[1],summer=data.rooms[0].periods[2],winter=data.rooms[0].periods[3]
let db,env,web,id,rooms,queries,kv,legacy,media
const read=(f)=>readFileSync(new URL('../'+f,import.meta.url),'utf8')
const snapshot=()=>Object.fromEntries(['properties','rooms','property_photos','season_rates','bookings','quotation_options'].map((t)=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r)=>Object.fromEntries(Object.entries(r).sort()))]))
const get=(sql,...v)=>db.prepare(sql).get(...v)
const rows=(sql,...v)=>db.prepare(sql).all(...v)
beforeEach(()=>{
  db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON')
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort().filter((f)=>f.endsWith('.sql')&&!f.startsWith('0008')))db.exec(read('migrations/'+f))
  db.exec(read('seed/seed.sql'))
  legacy=snapshot()
  db.exec(read('migrations/0008_property_catalogue.sql'))
  queries=[]
  const DB={prepare(sql){queries.push(sql);let values=[];const statement={bind(...v){values=v;return statement},async all(){return {results:rows(sql,...values)}},async first(){return get(sql,...values)??null},async run(){const r=db.prepare(sql).run(...values);return {success:true,meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}}};return statement}}
  kv=new Map();media=new Map()
  env={DB,KV:{async get(k,type){const v=kv.get(k)??null;return type==='json'&&typeof v==='string'?JSON.parse(v):v},async put(k,v){kv.set(k,v)},async delete(k){kv.delete(k)}},MEDIA:{async put(key,stream){media.set(key,await new Response(stream).arrayBuffer())},async delete(key){media.delete(key)}},JOBS:{async send(){}},KB:{async put(){},async delete(){}},ENVIRONMENT:'development',SITE_URL:'http://localhost',TURNSTILE_SITE_KEY:''}
  db.exec(sql)
  id=get('SELECT id FROM properties WHERE slug=?',data.property.slug).id
  rooms=rows('SELECT * FROM rooms WHERE property_id=? ORDER BY id',id)
  web=new Hono().use('*',csrf()).use('*',sessionMiddleware).use('*',catalogueLegacyGuard)
    .route('/',catalogueRoutes).route('/',staffRoomRoutes).route('/',rateSheetRoutes).route('/',propertyEditorRoutes).route('/',publicRoutes)
})
afterEach(()=>db.close())
async function request(path,role=null,body=null){
  const headers={}
  if(role){
    db.prepare('INSERT OR IGNORE INTO users(role,name,email) VALUES (?,?,?)').run(role,role,role+'@test.invalid')
    const user=get('SELECT id FROM users WHERE email=?',role+'@test.invalid')
    kv.set('sess:'+await sha256Hex(role),JSON.stringify({userId:user.id}))
    headers.cookie='gs_session='+role
  }
  if(body){headers['content-type']='application/x-www-form-urlencoded';headers.origin='http://localhost'}
  return web.request('http://localhost'+path,{method:body?'POST':'GET',headers,...(body?{body:new URLSearchParams(body).toString()}:{})},env)
}

describe('Golden Munnar Palace data and migration',()=>{
  it('preserves every existing row and foreign key while enabling NULL details',()=>{
    const after=snapshot()
    for(const [table,records] of Object.entries(legacy))for(const old of records){
      const current=after[table].find((r)=>r.id===old.id)
      for(const [key,value] of Object.entries(old))expect(current[key],table+'.'+key).toEqual(value)
    }
    expect(rows('PRAGMA foreign_key_check')).toEqual([])
    db.prepare("INSERT INTO properties(slug,name,type,destination) VALUES ('legacy-default-test','Legacy','resort','Munnar')").run()
    const p=get("SELECT * FROM properties WHERE slug='legacy-default-test'")
    expect(p.checkin_time).toBe('14:00');expect(p.checkout_time).toBe('11:00')
    db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES (?,'Legacy room',100)").run(p.id)
    expect(get('SELECT capacity FROM rooms WHERE property_id=?',p.id).capacity).toBe(2)
  })
  it('is repeatable, retains manual edits/photos and does not change unrelated rows',()=>{
    db.prepare("UPDATE properties SET description='Edited' WHERE id=?").run(id)
    db.prepare("INSERT INTO property_photos(property_id,r2_key,category,room_id) VALUES (?,'approved-test-key','room',?)").run(id,rooms[0].id)
    const before=snapshot();db.exec(sql);expect(snapshot()).toEqual(before)
    expect(rows('SELECT * FROM catalogue_rate_periods')).toHaveLength(16)
    expect(rows('SELECT * FROM property_charges')).toHaveLength(16)
  })
  it('aborts on a conflicting existing name/slug rather than inserting a duplicate',()=>{
    db.prepare("UPDATE properties SET slug='different-slug' WHERE id=?").run(id)
    expect(()=>db.exec(sql)).toThrow(/name\/slug conflict/)
    expect(rows('SELECT * FROM properties WHERE name=?',data.property.name)).toHaveLength(1)
  })
  it('preserves exact inventories, rack figures and unknown details without markup',async()=>{
    const c=await loadCatalogue(env,id)
    expect(c.rooms.map((r)=>r.units)).toEqual([68,17,10,3])
    expect(c.rooms.map((r)=>r.rack_rate)).toEqual([7000,11000,15000,19000])
    expect(c.rooms.map((r)=>r.capacity)).toEqual([null,null,null,4])
    expect(c.rooms.map((r)=>r.rack_basis)).toEqual(['+ GST','+ GST','+ GST','+ GST'])
    for(const r of rooms){
      expect(r.base_rate).toBe(r.rack_rate)
      for(const k of ['base_guests','bed_type','size_sqft','room_view','staff_rate','net_rate','min_nights','extra_bed'])expect(r[k],k).toBeNull()
    }
    const p=get('SELECT * FROM properties WHERE id=?',id)
    for(const k of ['address','lat','lng','checkin_time','checkout_time','id_required','family_friendly','pet_friendly','star_category'])expect(p[k],k).toBeNull()
    expect(p.classification).toBe('5-Star facility hotel')
    expect(p.cancellation_policy).toBe(data.property.cancellation_policy)
  })
  it.each(data.rooms.map((r,i)=>[r.name,i]))('preserves every supplied tariff for %s',async(_,i)=>{
    const c=await loadCatalogue(env,id,'admin'),periods=c.periods.filter((p)=>p.room_id===rooms[i].id)
    expect(periods.map(({start_date,end_date,staff_rate,net_rate,staff_basis,net_basis})=>({start_date,end_date,staff_rate,net_rate,staff_basis,net_basis}))).toEqual(data.rooms[i].periods)
  })
  it.each([
    ['2026-03-31',null,null],['2026-04-01',april.staff_rate,april.net_rate],['2026-04-30',april.staff_rate,april.net_rate],
    ['2026-05-01',null,may.net_rate],['2026-05-31',null,may.net_rate],['2026-06-01',summer.staff_rate,summer.net_rate],
    ['2026-09-30',summer.staff_rate,summer.net_rate],['2026-10-01',winter.staff_rate,winter.net_rate],['2027-03-31',winter.staff_rate,winter.net_rate],['2027-04-01',null,null],
  ])('has inclusive supplied boundaries and no fallback on %s',async(date,staff,net)=>{
    const c=await loadCatalogue(env,id,'admin')
    expect(catalogueRate(c.periods,rooms[0].id,date,'staff')).toBe(staff)
    expect(catalogueRate(c.periods,rooms[0].id,date,'net')).toBe(net)
  })
  it('ignores global seasons and keeps all May Staff Rates NULL',async()=>{
    db.exec("INSERT INTO season_rates(name,start_date,end_date,rate,staff_rate,net_rate) VALUES ('Global May','2026-05-01','2026-05-31',123,456,789)")
    const c=await loadCatalogue(env,id,'admin')
    for(const r of rooms)expect(catalogueRate(c.periods,r.id,'2026-05-15','staff')).toBeNull()
    db.prepare('UPDATE catalogue_rate_periods SET net_rate=NULL WHERE room_id=? AND start_date=?').run(rooms[0].id,'2026-06-01')
    expect(catalogueRate((await loadCatalogue(env,id,'admin')).periods,rooms[0].id,'2026-06-01','net')).toBeNull()
  })
})

describe('Server-side pricing visibility',()=>{
  it.each([null,'guest','accounts'])('returns Rack and public charges only for %s',async(role)=>{
    queries.length=0
    const c=await loadCatalogue(env,id,role)
    expect(c.periods).toEqual([])
    expect(JSON.stringify(c)).not.toMatch(/staff_rate|net_rate|net_basis/)
    expect(queries.some((q)=>q.includes('catalogue_rate_periods'))).toBe(false)
  })
  it.each(['manager','sales'])('returns Staff but does not even select B2B for %s',async(role)=>{
    queries.length=0
    const c=await loadCatalogue(env,id,role)
    expect(c.periods).toHaveLength(16)
    expect(c.periods[0].staff_rate).toBe(april.staff_rate)
    expect(c.periods.every((p)=>!Object.hasOwn(p,'net_rate')&&!Object.hasOwn(p,'net_basis'))).toBe(true)
    const query=queries.find((q)=>q.includes('catalogue_rate_periods'))
    expect(query).not.toContain('net_rate');expect(query).not.toContain('net_basis')
    const info=await propertyInfo(env,data.property.name,true,true,role) // Existing net permission cannot override role.
    expect(JSON.stringify(info)).not.toContain('net_rate')
  })
  it('returns all three rate tiers to Admin',async()=>{
    const c=await loadCatalogue(env,id,'admin')
    expect(c.rooms[0].rack_rate).toBe(7000)
    expect(c.periods[0]).toMatchObject({staff_rate:april.staff_rate,net_rate:april.net_rate,net_basis:'CPAI'})
  })
  it.each([null,'guest','manager','sales','admin'])('public property and room URLs expose Rack only even when signed in as %s',async(role)=>{
    db.prepare('UPDATE catalogue_rate_periods SET staff_rate=271828,net_rate=314159').run()
    for(const path of [`/stay/${data.property.slug}`,`/stay/${data.property.slug}/room/${rooms[0].id}`]){
      const response=await request(path,role);expect(response.status).toBe(200)
      const html=await response.text()
      expect(html).toContain('Rack Rate');expect(html).not.toMatch(/Staff Rate|B2B|271,828|314,159|271828|314159|placeholder|\/demo\//)
      expect(html).not.toMatch(/Check-in:|Check-out:|Up to 2|sleeps up to/)
      expect(html).not.toMatch(/Book now|Checkout|Pay now/)
    }
  })
  it.each([null,'guest','manager','sales','admin'])('the public price endpoint returns supplied Rack only for %s',async(role)=>{
    const response=await request(`/stay/${data.property.slug}/price`,role,{checkIn:'2026-05-15',checkOut:'2026-05-16'})
    expect(response.status).toBe(200)
    const payload=await response.json()
    expect(payload.rooms.map((r)=>r.rack_rate)).toEqual([7000,11000,15000,19000])
    expect(JSON.stringify(payload)).not.toMatch(/staff_rate|net_rate|staff_basis|net_basis|subtotal|taxes|total/)
    expect(payload.charges).toEqual((await loadCatalogue(env,id)).charges)
  })
  it.each(['manager','sales'])('staff HTML contains Staff, May absence and no B2B for %s',async(role)=>{
    db.prepare('UPDATE catalogue_rate_periods SET net_rate=314159').run()
    const response=await request(`/staff/catalogue/${id}`,role)
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store')
    const html=await response.text();expect(html).toContain('Staff Rate');expect(html).toContain('Not supplied')
    expect(html).not.toMatch(/B2B|net_rate|314,159|314159/)
  })
  it('Admin HTML includes B2B CPAI and May Not supplied',async()=>{
    const response=await request(`/admin/properties/${id}`,'admin'),html=await response.text()
    expect(response.status).toBe(200);expect(html).toContain('B2B / Special Rate');expect(html).toContain('CPAI');expect(html).toContain('Not supplied')
  })
  it.each([null,'guest','accounts'])('denies catalogue management to %s',async(role)=>{
    expect((await request(`/staff/catalogue/${id}`,role)).status).toBe(403)
  })
  it.each(['manager','sales'])('rejects tampered B2B writes and preserves Admin values for %s',async(role)=>{
    const period=get('SELECT id,net_rate FROM catalogue_rate_periods WHERE room_id=? LIMIT 1',rooms[0].id)
    expect((await request(`/staff/catalogue/${id}/periods/${period.id}`,role,{staff_rate:'99999',net_rate:'1'})).status).toBe(403)
    expect(get('SELECT net_rate FROM catalogue_rate_periods WHERE id=?',period.id).net_rate).toBe(period.net_rate)
    expect((await request(`/staff/catalogue/${id}/periods/${period.id}`,role,{staff_rate:''})).status).toBe(303)
    expect(get('SELECT staff_rate,net_rate FROM catalogue_rate_periods WHERE id=?',period.id)).toMatchObject({staff_rate:null,net_rate:period.net_rate})
  })
  it('supports Admin editing of both internal tiers',async()=>{
    const period=get('SELECT id FROM catalogue_rate_periods LIMIT 1')
    expect((await request(`/staff/catalogue/${id}/periods/${period.id}`,'admin',{staff_rate:String(april.staff_rate),net_rate:String(april.net_rate)})).status).toBe(303)
    expect(get('SELECT staff_rate,net_rate FROM catalogue_rate_periods WHERE id=?',period.id)).toMatchObject({staff_rate:april.staff_rate,net_rate:april.net_rate})
  })
  it('keeps B2B out of legacy exports/AI tables and shared knowledge documents',async()=>{
    const c=await loadCatalogue(env,id),doc=catalogueDocument(c)
    expect(doc).not.toMatch(/staff_rate|net_rate|14:00|11:00|sleeps up to|room only|standard/)
    expect(await propertyDoc(env,get('SELECT * FROM properties WHERE id=?',id))).toBe(doc)
    expect(guardSql('SELECT * FROM catalogue_rate_periods').ok).toBe(false)
    expect(()=>db.prepare('UPDATE rooms SET staff_rate=10,net_rate=5 WHERE id=?').run(rooms[0].id)).toThrow(/role-projected/)
  })
})

describe('Public charges and catalogue management',()=>{
  it('returns identical charges and exact supplied prices for all tiers',async()=>{
    const publicData=await loadCatalogue(env,id)
    for(const role of ['guest','manager','sales','admin'])expect((await loadCatalogue(env,id,role)).charges).toEqual(publicData.charges)
    expect(publicData.charges.map(({charge_key,name,amount,child_amount,basis,rate_basis,start_date,end_date,mandatory,options,notes})=>({charge_key,name,amount,child_amount,basis,rate_basis,start_date,end_date,mandatory,options:JSON.parse(options),notes}))).toEqual(data.charges)
    expect(publicData.charges.find((c)=>c.charge_key==='ac').basis).toBe('per room/night')
    expect(publicData.charges.find((c)=>c.charge_key==='candle-light-dinner').basis).toBeNull()
  })
  it.each([
    ['2026-11-04',[]],['2026-11-05',['diwali']],['2026-11-15',['diwali']],['2026-11-16',[]],
    ['2026-12-19',[]],['2026-12-20',['christmas']],['2026-12-24',['christmas','christmas-gala']],
    ['2026-12-31',['christmas','new-year']],['2027-01-05',['christmas']],['2027-01-06',[]],
  ])('preserves dated supplement/mandatory boundaries on %s',async(date,keys)=>{
    const c=await loadCatalogue(env,id)
    expect(chargesOn(c.charges,date).filter((ch)=>ch.start_date).map((ch)=>ch.charge_key)).toEqual(keys)
  })
  it('keeps Christmas and New Year adult/child charges separate from room supplements',async()=>{
    const c=await loadCatalogue(env,id)
    expect(c.charges.find((ch)=>ch.charge_key==='christmas-gala')).toMatchObject({amount:2500,child_amount:1250,basis:'per person / per child',mandatory:1,start_date:'2026-12-24',end_date:'2026-12-24'})
    expect(c.charges.find((ch)=>ch.charge_key==='new-year')).toMatchObject({amount:3000,child_amount:1500,basis:'per person / per child',mandatory:1,start_date:'2026-12-31',end_date:'2026-12-31'})
    expect(c.charges.find((ch)=>ch.charge_key==='christmas')).toMatchObject({amount:2000,child_amount:null,basis:'per room/night',mandatory:0})
    expect(c.rooms.map((r)=>r.rack_rate)).toEqual([7000,11000,15000,19000])
  })
  it.each(['manager','sales'])('can manage known room details without inventing unknown occupancy as %s',async(role)=>{
    expect((await request(`/staff/catalogue/${id}/rooms/${rooms[0].id}`,role,{description:'',units:'68',capacity:'',rack_rate:'7000'})).status).toBe(303)
    expect(get('SELECT capacity,base_guests,bed_type,size_sqft FROM rooms WHERE id=?',rooms[0].id)).toMatchObject({capacity:null,base_guests:null,bed_type:null,size_sqft:null})
    expect((await request(`/staff/catalogue/${id}`,role,{description:data.property.description,address:'',checkin_time:'',checkout_time:''})).status).toBe(303)
    expect(get('SELECT address,checkin_time,checkout_time FROM properties WHERE id=?',id)).toMatchObject({address:null,checkin_time:null,checkout_time:null})
  })
  it('blocks legacy updates/imports/duplicates and quote pricing without affecting other properties',async()=>{
    for(const path of [`/admin/properties/${id}`,`/admin/properties/${id}/ratesheet`,`/admin/properties/${id}/duplicate`,`/admin/rooms/${rooms[0].id}`])expect((await request(path,'admin',{staff_markup:'15',guest_markup:'35',capacity:'2'})).status).toBe(409)
    expect(await loadPricing(env,rooms[0].id)).toBeNull()
    expect(await createBooking(env,{roomId:rooms[3].id})).toMatchObject({error:'Room not found.'})
    expect(await loadPricing(env,legacy.rooms[0].id)).not.toBeNull()
  })
  it('search cards use rack and no property placeholder/availability claim',async()=>{
    db.prepare('UPDATE rooms SET base_rate=999999 WHERE property_id=?').run(id)
    const [card]=await cardsByIds(env,[id]);expect(card.from_price).toBe(7000)
    const results=await searchProperties(env,{destination:data.property.destination,checkIn:'2026-12-24',checkOut:'2026-12-25'})
    expect(results[0].from_price).toBe(7000);expect(results[0].stay_total).toBeUndefined();expect(results[0].available).toBeUndefined()
    expect((await request('/search?destination='+encodeURIComponent(data.property.destination))).status).toBe(200)
  })
  it.each(['manager','sales'])('uploads only to a room in this property and reuses R2 storage as %s',async(role)=>{
    await request(`/staff/catalogue/${id}`,role)
    const upload=new FormData()
    upload.set('category','room');upload.set('room_id',String(rooms[0].id));upload.set('caption','Approved Executive')
    upload.append('files',new File([new Uint8Array([255,216,255,217])],'approved-executive.jpg',{type:'image/jpeg'}))
    const response=await web.request('http://localhost/staff/catalogue/'+id+'/media',{method:'POST',headers:{cookie:'gs_session='+role,origin:'http://localhost'},body:upload},env)
    expect(response.status).toBe(303)
    const photo=get('SELECT * FROM property_photos WHERE property_id=?',id)
    expect(photo).toMatchObject({room_id:rooms[0].id,category:'room',caption:'Approved Executive'})
    expect(photo.r2_key).toMatch(new RegExp('^properties/'+id+'/room/.*\\.jpeg$'))
    expect(media.has(photo.r2_key)).toBe(true)
    expect((await request(`/staff/catalogue/${id}/photos/${photo.id}`,role,{delete:'1'})).status).toBe(303)
    expect(media.has(photo.r2_key)).toBe(false)
    expect(get('SELECT * FROM property_photos WHERE id=?',photo.id)).toBeUndefined()
  })
  it('the database rejects a quote using a catalogue room under a different property',()=>{
    const quoteId=legacy.quotation_options[0].quotation_id
    expect(()=>db.prepare('INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out) VALUES (?,?,?,?,?)').run(quoteId,legacy.properties[0].id,rooms[0].id,'2026-12-24','2026-12-25')).toThrow(/cannot be quoted/)
  })
  it('renders no photo placeholder and allows safe later room association',async()=>{
    expect(rows('SELECT * FROM property_photos WHERE property_id=?',id)).toEqual([])
    db.prepare("INSERT INTO property_photos(property_id,r2_key,category) VALUES (?,'approved-test-key','common')").run(id)
    const ph=get('SELECT id FROM property_photos WHERE property_id=?',id)
    expect((await request(`/staff/catalogue/${id}/photos/${ph.id}`,'sales',{category:'room',room_id:String(legacy.rooms[0].id),caption:'Approved'})).status).toBe(400)
    expect((await request(`/staff/catalogue/${id}/photos/${ph.id}`,'sales',{category:'room',room_id:String(rooms[0].id),caption:'Approved Executive'})).status).toBe(303)
    expect(get('SELECT room_id FROM property_photos WHERE id=?',ph.id).room_id).toBe(rooms[0].id)
    expect(await (await request(`/stay/${data.property.slug}/room/${rooms[0].id}`)).text()).toContain('approved-test-key')
  })
})
