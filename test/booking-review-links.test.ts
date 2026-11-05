// @ts-expect-error Node SQLite test database.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem migration fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import type { AppEnv } from '../src/env'
import { csrf } from 'hono/csrf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bookingReviewRoutes } from '../src/routes/booking-reviews'
import { admin2Routes } from '../src/routes/admin2'
import { publicRoutes } from '../src/routes/public'
import { sha256Hex, todayIST } from '../src/lib/util'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((name: string) => name.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const property = Number(db.prepare("INSERT INTO properties(name,slug,destination,type,status) VALUES('Review Lodge','review-lodge','Munnar','resort','live')").run().lastInsertRowid)
  const room = Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate) VALUES(?,'Cottage',9000)").run(property).lastInsertRowid)
  const admin = Number(db.prepare("SELECT id FROM users WHERE role='admin'").get().id)
  const phone = '+919876543210'
  const id = Number(db.prepare(`INSERT INTO bookings(code,property_id,room_id,check_in,check_out,nights,subtotal,total,status,source,guest_name,guest_phone,staff_id)
    VALUES('PRIVATE-CODE',?,?,?,?,1,98765,98765,'completed','staff','Private Guest',?,?)`).run(property,room,todayIST(-2),todayIST(-1),phone,admin).lastInsertRowid)
  const kv = new Map<string,string>(), jobs: unknown[] = [], media = new Map<string,{body:Uint8Array,type:string}>()
  let user: any = { id: admin, role: 'admin', name:'Admin' }
  const send = vi.fn(async () => { throw new Error('Unexpected external request') })
  vi.stubGlobal('fetch',send)
  const env:any = { SITE_URL:'http://localhost', ENVIRONMENT:'development',
    KV:{async get(k:string,type?:string){const v=kv.get(k);return v==null?null:type==='json'?JSON.parse(v):v},async put(k:string,v:string){kv.set(k,v)},async delete(k:string){kv.delete(k)}},
    JOBS:{async send(j:unknown){jobs.push(j)}},
    MEDIA:{async put(k:string,b:ReadableStream,options:any){media.set(k,{body:new Uint8Array(await new Response(b).arrayBuffer()),type:options.httpMetadata.contentType})},
      async get(k:string){const f=media.get(k);return f&&{body:f.body,writeHttpMetadata(h:Headers){h.set('content-type',f.type)}}},
      async delete(keys:string[]){keys.forEach(k=>media.delete(k))}},
    DB:{prepare(sql:string){let args:any[]=[]; const stmt={bind(...v:any[]){args=v;return stmt},async first(){return db.prepare(sql).get(...args)??null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return {meta:{last_row_id:Number(db.prepare(sql).run(...args).lastInsertRowid)}}}};return stmt}}
  }
  const app = new Hono<AppEnv>().use('*',csrf()).use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',bookingReviewRoutes).route('/',admin2Routes).route('/',publicRoutes)
  const request = (path:string, init?:RequestInit)=>app.request('http://localhost'+path,{...init,headers:{Origin:'http://localhost',...init?.headers}},env)
  const manage = (action='issue')=>request(`/staff/bookings/${id}/review-link`,{method:'POST',body:new URLSearchParams({action})})
  const issue=async()=>{const res=await manage();expect(res.status).toBe(200);const html=await res.text();expect(html).toContain('Copy Review Link');expect(html).toContain('Share via WhatsApp');return html.match(/\/review-stay#[\w-]{43}/)![0]}
  const rows=()=>db.prepare('SELECT * FROM reviews WHERE booking_id=?').all(id)
  const open=(link:string)=>request('/review-stay/open',{method:'POST',body:new URLSearchParams({token:link.split('#')[1]})})
  const cookie=(link:string)=>({Cookie:'gs_review_invite='+link.split('#')[1]})
  const get=(link:string)=>request('/review-stay',{headers:cookie(link)})
  const submit=async(path:string, overrides: Record<string,string>={})=>request('/review-stay',{method:'POST',headers:cookie(path),body:new URLSearchParams({invite:await sha256Hex(path.split('#')[1]),guest_name:'Review Guest',rating:'5',body:'A quiet and comfortable stay.',...overrides})})
  return {db,env,media,admin,phone,id,property,jobs,request,manage,issue,rows,open,get,submit,as:(u:any)=>{user=u},send}
}

afterEach(()=>vi.unstubAllGlobals())

describe('booking-linked review invitations',()=>{
  it('issues an opaque link, keeps booking information private and accepts one review without login or OTP',async()=>{
    const f=fixture();try {
      const path=await f.issue(), token=path.split('#')[1]
      expect(f.db.prepare('SELECT token_hash FROM booking_review_links').get().token_hash).toBe(await sha256Hex(token))
      expect(f.send).not.toHaveBeenCalled()
      expect((await f.get(path)).status).toBe(403)
      expect((await f.submit(path)).status).toBe(403)
      f.as(null)
      const exchange=await f.open(path);expect(exchange.status).toBe(303);expect(exchange.headers.get('Set-Cookie')).toMatch(/HttpOnly; SameSite=Strict/);expect(exchange.headers.get('Location')).toBe('/review-stay')
      const page=await f.get(path);const html=await page.text()
      expect(page.headers.get('Cache-Control')).toContain('no-store')
      expect(page.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(html).toContain('Review Lodge')
      expect(html).not.toMatch(/Private Guest|PRIVATE-CODE|98765|919876543210/)
      const form=await(await f.get(path)).text()
      expect(form).toContain('multipart/form-data')
      expect(form).not.toContain('one-time-code')
      expect(form).toContain('name="guest_name"')
      expect((await f.submit(path,{invite:'stale-tab'})).status).toBe(404)
      const responses=await Promise.all([f.submit(path,{property_id:'999',booking_id:'999'}),f.submit(path)])
      expect(responses.map(r=>r.status).sort()).toEqual([303,404])
      expect(f.rows()).toEqual([expect.objectContaining({booking_id:f.id,property_id:f.property,user_id:null,guest_name:'Review Guest',status:'pending',rating:5})])
      expect(f.jobs).toHaveLength(2)
      expect(f.send).not.toHaveBeenCalled()
      expect((await f.request('/review-stay/thanks')).status).toBe(200)
      expect(await(await f.request('/stay/review-lodge')).text()).not.toContain('A quiet and comfortable stay.')
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect(await(await f.request('/admin/reviews')).text()).toContain('A quiet and comfortable stay.')
      expect((await f.request('/admin/reviews/'+f.rows()[0].id,{method:'POST',body:new URLSearchParams({action:'approve'})})).status).toBe(303)
      f.as(null)
      expect(await(await f.request('/stay/review-lodge')).text()).toContain('A quiet and comfortable stay.')
    }finally{f.db.close()}
  })
  it('rejects incomplete, same-day, cancelled and unauthorized bookings',async()=>{
    const f=fixture();try{
      for(const [status,date] of [['confirmed',todayIST(-1)],['cancelled',todayIST(-1)],['completed',todayIST()],['completed',todayIST(1)]]){
        f.db.prepare('UPDATE bookings SET status=?,check_out=? WHERE id=?').run(status,date,f.id)
        expect((await f.manage()).status).toBe(409)
      }
      f.db.prepare("UPDATE bookings SET status='completed',check_out=? WHERE id=?").run(todayIST(-1),f.id)
      f.as({id:999,role:'sales',name:'Other staff'})
      expect((await f.manage()).status).toBeGreaterThanOrEqual(400)
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect((await f.request(`/staff/bookings/${f.id}/review-link`,{method:'POST',headers:{Origin:'https://other.test'},body:new URLSearchParams({action:'issue'})})).status).toBe(403)
      expect(f.db.prepare('SELECT count(*) AS n FROM booking_review_links').get().n).toBe(0)
    }finally{f.db.close()}
  })
  it('allows assigned staff to issue without requiring a guest phone',async()=>{
    const f=fixture();try{
      const staffId=Number(f.db.prepare("INSERT INTO users(name,role,phone) VALUES('Assigned staff','sales','+919800000001')").run().lastInsertRowid)
      f.db.prepare('UPDATE bookings SET staff_id=? WHERE id=?').run(staffId,f.id)
      f.as({id:staffId,role:'sales',name:'Assigned staff'})
      f.db.prepare("UPDATE bookings SET guest_phone='' WHERE id=?").run(f.id)
      const path=await f.issue()
      f.as(null)
      expect((await f.open(path)).status).toBe(303)
      expect(f.send).not.toHaveBeenCalled()
    }finally{f.db.close()}
  })
  it('revokes, rotates and expires links and rejects a mismatched booking property',async()=>{
    const f=fixture();try{
      const old=await f.issue(), path=await f.issue()
      f.as(null);expect((await f.open(old)).status).toBe(404)
      const other=Number(f.db.prepare("SELECT id FROM properties WHERE id != ? LIMIT 1").get(f.property).id)
      f.db.prepare('UPDATE booking_review_links SET property_id=?').run(other)
      expect((await f.open(path)).status).toBe(404)
      f.db.prepare('UPDATE booking_review_links SET property_id=?,expires_at=?').run(f.property,'2000-01-01')
      expect((await f.open(path)).status).toBe(404)
      f.as({id:f.admin,role:'admin',name:'Admin'})
      const fresh=await f.issue();expect((await f.manage('revoke')).status).toBe(303)
      f.as(null);expect((await f.open(fresh)).status).toBe(404)
    }finally{f.db.close()}
  })
  it('rejects spam traps, invalid inputs and cross-origin submissions',async()=>{
    const f=fixture();try{
      const path=await f.issue();f.as(null)
      for (const invalid of [{website:'spam'}, {guest_name:' '}, {guest_name:'a'.repeat(81)}, {rating:'6'}, {body:''}] as Record<string,string>[]) {
        expect((await f.submit(path,invalid)).status).toBe(400)
      }
      const crossOrigin=await f.request('/review-stay',{method:'POST',headers:{Origin:'https://other.example'},body:new URLSearchParams()})
      expect(crossOrigin.status).toBe(403)
      expect(f.rows()).toEqual([])
    }finally{f.db.close()}
  })
  it('rejects disguised uploads and restricts submitted photos to moderators until approval',async()=>{
    const f=fixture();try{
      const path=await f.issue();f.as(null)
      const sendPhoto=async(file:File)=>{const body=new FormData();body.set('invite',await sha256Hex(path.split('#')[1]));body.set('guest_name','Photo Guest');body.set('rating','4');body.set('body','Our photos');body.set('photos',file);return f.request('/review-stay',{method:'POST',headers:{Cookie:'gs_review_invite='+path.split('#')[1]},body})}
      expect((await sendPhoto(new File(['<svg onload="alert(1)">'],'fake.png',{type:'image/png'}))).status).toBe(400)
      expect(f.media.size).toBe(0)
      expect((await sendPhoto(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'photo.png',{type:'image/png'}))).status).toBe(303)
      const [key]=JSON.parse(f.rows()[0].photos)
      expect((await f.request('/media/'+key)).status).toBe(404)
      expect((await f.request('/media/'+key.replace('/','%2F'))).status).toBe(404)
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect((await f.request('/media/'+key)).status).toBe(200)
      f.as(null)
      f.db.prepare("UPDATE reviews SET status='approved' WHERE booking_id=?").run(f.id)
      expect((await f.request('/media/'+key)).status).toBe(200)
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect((await f.request('/admin/reviews/'+f.rows()[0].id,{method:'POST',body:new URLSearchParams({action:'hide'})})).status).toBe(303)
      f.as(null)
      expect((await f.request('/media/'+key)).status).toBe(404)
      expect(await(await f.request('/stay/review-lodge')).text()).not.toContain('Our photos')
    }finally{f.db.close()}
  })
  it('does not issue another invite for a review from the existing account flow',async()=>{
    const f=fixture();try{
      f.db.prepare("INSERT INTO reviews(booking_id,property_id,user_id,rating,body,status) VALUES(?,?,?,?,?,'approved')").run(f.id,f.property,f.admin,4,'Existing review')
      expect((await f.manage()).status).toBe(409)
      expect(f.rows()).toEqual([expect.objectContaining({body:'Existing review',status:'approved'})])
    }finally{f.db.close()}
  })
})


describe('review migration sequence and compatibility', () => {
  it('upgrades the Photo AI schema without rewriting existing records or reusing a migration number', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys=ON')
      const files = readdirSync('migrations').filter((name: string) => name.endsWith('.sql')).sort()
      expect(new Set(files.map((name: string) => name.split('_')[0])).size).toBe(files.length)
      expect(files.at(-2)).toBe('0024_photo_ai.sql')
      expect(files.at(-1)).toBe('0025_booking_review_links.sql')
      for (const file of files.slice(0,-1)) db.exec(readFileSync('migrations/'+file, 'utf8'))
      db.exec(readFileSync('seed/seed.sql','utf8'))
      const tables = ['properties','property_photos','bookings','reviews','payments']
      const before = tables.map(table => db.prepare('SELECT * FROM '+table+' ORDER BY id').all())
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='property_photos'").get().sql
      db.exec(readFileSync('migrations/0025_booking_review_links.sql','utf8'))
      expect(tables.map(table => db.prepare('SELECT * FROM '+table+' ORDER BY id').all())).toEqual(before)
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='property_photos'").get().sql).toBe(schema)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  })
})
