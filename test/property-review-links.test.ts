// @ts-expect-error Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node migration fixtures.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../src/env'
import { propertyReviewLinkRoutes } from '../src/routes/property-review-links'
import { bookingReviewRoutes } from '../src/routes/booking-reviews'
import { admin2Routes } from '../src/routes/admin2'
import { publicRoutes } from '../src/routes/public'
import { sha256Hex } from '../src/lib/util'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for(const file of readdirSync('migrations').filter((s:string)=>s.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const property=Number(db.prepare("INSERT INTO properties(name,slug,destination,type,status) VALUES('Link Lodge','link-lodge','Vagamon','resort','live')").run().lastInsertRowid)
  const admin=Number(db.prepare("SELECT id FROM users WHERE role='admin'").get().id)
  const staff=Number(db.prepare("INSERT INTO users(name,role,phone) VALUES('Link Staff','sales','+919800000008')").run().lastInsertRowid)
  const other=Number(db.prepare("INSERT INTO users(name,role,phone) VALUES('Other Staff','sales','+919800000009')").run().lastInsertRowid)
  const kv=new Map<string,string>(),media=new Map<string,{body:Uint8Array,type:string}>(),jobs:unknown[]=[]
  const send=vi.fn(async()=>{throw new Error('Unexpected external request')});vi.stubGlobal('fetch',send)
  let user:any={id:staff,role:'sales',name:'Link Staff'}
  const env:any={SITE_URL:'http://localhost',ENVIRONMENT:'development',KV:{async get(k:string,t?:string){const v=kv.get(k);return v==null?null:t==='json'?JSON.parse(v):v},async put(k:string,v:string){kv.set(k,v)},async delete(k:string){kv.delete(k)}},
    MEDIA:{async put(k:string,b:ReadableStream,o:any){media.set(k,{body:new Uint8Array(await new Response(b).arrayBuffer()),type:o.httpMetadata.contentType})},async get(k:string){const f=media.get(k);return f&&{body:f.body,writeHttpMetadata(h:Headers){h.set('content-type',f.type)}}},async delete(keys:string[]){keys.forEach(k=>media.delete(k))}},
    JOBS:{async send(j:unknown){jobs.push(j)}},DB:{prepare(sql:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v;return stmt},async first(){return db.prepare(sql).get(...args)??null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return {meta:{last_row_id:Number(db.prepare(sql).run(...args).lastInsertRowid)}}}};return stmt}}}
  const app=new Hono<AppEnv>().use('*',csrf()).use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',propertyReviewLinkRoutes).route('/',bookingReviewRoutes).route('/',admin2Routes).route('/',publicRoutes)
  const request=(path:string,init?:RequestInit)=>app.request('http://localhost'+path,{...init,headers:{Origin:'http://localhost',...init?.headers}},env)
  const issueRequest=(id=property)=>request('/staff/review-links',{method:'POST',body:new URLSearchParams({property_id:String(id)})})
  const issue=async()=>{const r=await issueRequest();expect(r.status).toBe(200);const text=await r.text();expect(text).toContain('Copy Link');expect(text).toContain('Share via WhatsApp');return text.match(/\/review-stay#[\w-]{43}/)![0]}
  const cookie=(path:string)=>({Cookie:'gs_review_invite='+path.split('#')[1]})
  const open=(path:string)=>request('/review-stay/open',{method:'POST',body:new URLSearchParams({token:path.split('#')[1]})})
  const submit=async(path:string,fields:Record<string,string>={})=>request('/review-stay',{method:'POST',headers:cookie(path),body:new URLSearchParams({invite:await sha256Hex(path.split('#')[1]),guest_name:'Real guest name',rating:'5',body:'Property link feedback',...fields})})
  const rows=()=>db.prepare('SELECT * FROM reviews WHERE property_review_link_id IS NOT NULL').all()
  return {db,admin,staff,other,property,kv,media,jobs,send,request,issueRequest,issue,cookie,open,submit,rows,as:(u:any)=>{user=u}}
}
afterEach(()=>vi.unstubAllGlobals())

describe('property-only guest review links',()=>{
  it('allows staff to select Live properties, issue hash-only invitations and receive a guest review without a booking, login or OTP',async()=>{
    const f=fixture();try{
      const before=f.db.prepare('SELECT * FROM bookings').all()
      const list=await(await f.request('/staff/review-links?q=Link')).text()
      expect(list).toContain('Link Lodge — Vagamon');expect(list).toContain('Generate Review Link')
      expect(list).not.toContain('PRIVATE-CODE')
      const path=await f.issue(),token=path.split('#')[1]
      const invitation=f.db.prepare('SELECT * FROM property_review_links').get()
      expect(invitation.token_hash).toBe(await sha256Hex(token));expect(JSON.stringify(invitation)).not.toContain(token)
      expect(f.db.prepare("SELECT action FROM activity_log WHERE entity='property_review_link'").all()).toEqual([{action:'property_review_link.issued'}])
      f.as(null);expect((await f.open(path)).status).toBe(303)
      const form=await f.request('/review-stay',{headers:f.cookie(path)});const html=await form.text()
      expect(form.headers.get('Cache-Control')).toContain('no-store');expect(html).toContain('How was Link Lodge?')
      expect(html).not.toMatch(/one-time-code|98765|verified guest|name="property_id"/i)
      expect((await f.submit(path,{property_id:'999',booking_id:'999'})).status).toBe(303)
      expect(f.rows()).toEqual([expect.objectContaining({property_id:f.property,booking_id:null,user_id:null,guest_name:'Real guest name',status:'pending',property_review_link_id:invitation.id})])
      expect(f.db.prepare('SELECT * FROM bookings').all()).toEqual(before)
      expect(f.db.prepare("SELECT action FROM activity_log WHERE action='property_review_link.submitted'").all()).toHaveLength(1)
      expect(f.jobs).toHaveLength(2);expect(f.send).not.toHaveBeenCalled()
      expect(await(await f.request('/stay/link-lodge')).text()).not.toContain('Property link feedback')
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect(await(await f.request('/admin/reviews')).text()).toContain('Property link feedback')
      expect((await f.request('/admin/reviews/'+f.rows()[0].id,{method:'POST',body:new URLSearchParams({action:'approve'})})).status).toBe(303)
      f.as(null);expect(await(await f.request('/stay/link-lodge')).text()).toContain('Property link feedback')
      f.as({id:f.admin,role:'admin',name:'Admin'})
      await f.request('/admin/reviews/'+f.rows()[0].id,{method:'POST',body:new URLSearchParams({action:'hide'})})
      f.as(null);expect(await(await f.request('/stay/link-lodge')).text()).not.toContain('Property link feedback')
      expect((await f.open(path)).status).toBe(404)
    }finally{f.db.close()}
  })
  it('offers Copy Link and manual WhatsApp sharing with the selected resort and identical private link for staff and Admin',async()=>{
    const f=fixture();try{
      const name='Lake & Hills / Munnar 🌿'
      f.db.prepare('UPDATE properties SET name=? WHERE id=?').run(name,f.property)
      for(const user of [{id:f.staff,role:'sales',name:'Staff'},{id:f.admin,role:'admin',name:'Admin'}]){
        f.as(user)
        const response=await f.issueRequest();expect(response.status).toBe(200)
        const html=await response.text()
        expect(html).toContain('>Copy Link</button>');expect(html).toContain('>Share via WhatsApp</a>')
        const copy=html.match(/data-copy-review-link="([^"]+)"/)![1]
        const href=html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)![1]
        const share=new URL(href)
        expect(share.origin).toBe('https://wa.me');expect(share.pathname).toBe('/')
        expect([...share.searchParams.keys()]).toEqual(['text'])
        expect(share.searchParams.get('text')).toBe(`Hi! Thank you for choosing Go Sanchari. How was your stay at ${name}? Please share your feedback here: ${copy}`)
        expect(copy).toMatch(/^http:\/\/localhost\/review-stay#[A-Za-z0-9_-]{43}$/)
        expect(html).toMatch(/target="_blank" rel="noopener noreferrer">Share via WhatsApp/)
      }
      expect(f.send).not.toHaveBeenCalled();expect(f.rows()).toHaveLength(0)
    }finally{f.db.close()}
  })
  it('enforces one submission atomically, including concurrent attempts, and allows distinct guests for the same property',async()=>{
    const f=fixture();try{
      const path=await f.issue(),second=await f.issue();f.as(null)
      expect((await Promise.all([f.submit(path),f.submit(path)])).map(r=>r.status).sort()).toEqual([303,404])
      expect((await f.submit(second)).status).toBe(303);expect(f.rows()).toHaveLength(2)
      expect((await f.submit(path)).status).toBe(404)
    }finally{f.db.close()}
  })
  it('rejects revoked, expired, hidden-property and malformed links, including a form opened before revocation',async()=>{
    const f=fixture();try{
      const path=await f.issue();f.as(null);expect((await f.open(path)).status).toBe(303)
      f.as({id:f.staff,role:'sales',name:'Staff'})
      expect((await f.request('/staff/review-links/1/revoke',{method:'POST'})).status).toBe(303)
      expect((await f.request('/staff/review-links/1/revoke',{method:'POST'})).status).toBe(409)
      f.as(null);expect((await f.submit(path)).status).toBe(404)
      expect((await f.open('/review-stay#not-a-token')).status).toBe(404)
      f.as({id:f.staff,role:'sales',name:'Staff'});const expired=await f.issue()
      f.db.prepare("UPDATE property_review_links SET expires_at='2000-01-01' WHERE id=2").run()
      f.as(null);expect((await f.open(expired)).status).toBe(404)
      f.as({id:f.staff,role:'sales',name:'Staff'});const hidden=await f.issue()
      f.db.prepare("UPDATE properties SET status='draft' WHERE id=?").run(f.property)
      f.as(null);expect((await f.open(hidden)).status).toBe(404);expect((await f.submit(hidden)).status).toBe(404)
      expect(f.rows()).toHaveLength(0)
    }finally{f.db.close()}
  })
  it('preserves permissions, owner scope and CSRF; staff can open guest links but cannot moderate',async()=>{
    const f=fixture();try{
      const path=await f.issue();expect((await f.open(path)).status).toBe(303)
      f.as({id:f.other,role:'sales',name:'Other Staff'})
      expect(await(await f.request('/staff/review-links')).text()).not.toContain('Link Staff</td>')
      expect((await f.request('/staff/review-links/1/revoke',{method:'POST'})).status).toBe(409)
      expect((await f.request('/admin/reviews')).status).toBe(403)
      const forbidden=await f.request('/staff/review-links',{method:'POST',headers:{Origin:'https://evil.test'},body:new URLSearchParams({property_id:String(f.property)})})
      expect(forbidden.status).toBe(403)
      f.as(null);expect((await f.issueRequest()).status).toBe(302)
      f.as({id:f.other,role:'guest',name:'Guest'});expect((await f.issueRequest()).status).toBe(403)
      f.as({id:f.admin,role:'admin',name:'Admin'})
      expect(await(await f.request('/staff/review-links')).text()).toContain('Link Staff</td>')
      expect((await f.request('/staff/review-links/1/revoke',{method:'POST'})).status).toBe(303)
      expect(f.db.prepare('SELECT revoked_by FROM property_review_links').get().revoked_by).toBe(f.admin)
    }finally{f.db.close()}
  })
  it('rejects invalid selections and spam; applies issuance, opening and submission rate limits',async()=>{
    const f=fixture();try{
      expect((await f.issueRequest(-1)).status).toBe(400);expect((await f.issueRequest(999999)).status).toBe(409)
      f.db.prepare("UPDATE properties SET status='draft' WHERE id=?").run(f.property)
      expect((await f.issueRequest()).status).toBe(409)
      f.db.prepare("UPDATE properties SET status='live' WHERE id=?").run(f.property)
      const path=await f.issue();f.as(null)
      for(const fields of [{website:'spam'},{rating:'0'},{rating:'6'},{guest_name:''},{body:''},{body:'x'.repeat(2001)},{invite:'stale-tab'}] as Record<string,string>[]){
        expect((await f.submit(path,fields)).status).toBe(fields.invite?404:400)
      }
      f.kv.set('rl:review-submit-ip:unknown:'+Math.floor(Date.now()/1000/3600),'30')
      expect((await f.submit(path)).status).toBe(429)
      f.kv.set('rl:review-open-ip:unknown:'+Math.floor(Date.now()/1000/3600),'60');expect((await f.open(path)).status).toBe(429)
      f.as({id:f.staff,role:'sales',name:'Staff'});f.kv.set('rl:property-review-issue:'+f.staff+':'+Math.floor(Date.now()/1000/3600),'40')
      expect((await f.issueRequest()).status).toBe(429);expect(f.rows()).toHaveLength(0)
    }finally{f.db.close()}
  })
  it('validates optional photos and keeps them private until moderation approval',async()=>{
    const f=fixture();try{
      const path=await f.issue();f.as(null)
      const upload=async(file:File)=>{const b=new FormData();b.set('invite',await sha256Hex(path.split('#')[1]));b.set('guest_name','Photo Guest');b.set('rating','4');b.set('body','Property photo feedback');b.set('photos',file);return f.request('/review-stay',{method:'POST',headers:f.cookie(path),body:b})}
      expect((await upload(new File(['<svg onload=alert(1)>'],'fake.png',{type:'image/png'}))).status).toBe(400)
      expect((await upload(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'valid.png',{type:'image/png'}))).status).toBe(303)
      const key=JSON.parse(f.rows()[0].photos)[0]
      expect((await f.request('/media/'+key)).status).toBe(404)
      f.db.prepare("UPDATE reviews SET status='approved' WHERE property_review_link_id=1").run()
      expect((await f.request('/media/'+key)).status).toBe(200)
      f.db.prepare("UPDATE reviews SET status='hidden' WHERE property_review_link_id=1").run()
      expect((await f.request('/media/'+key)).status).toBe(404)
    }finally{f.db.close()}
  })
  it('preserves existing records when upgrading 0025 and enforces nullable unique invitations without affecting old reviews',()=>{
    const db=new DatabaseSync(':memory:');try{
      db.exec('PRAGMA foreign_keys=ON')
      const files=readdirSync('migrations').filter((s:string)=>s.endsWith('.sql')&&s<='0026_property_review_links.sql').sort()
      expect(new Set(files.map((s:string)=>s.split('_')[0])).size).toBe(files.length)
      expect(files.at(-1)).toBe('0026_property_review_links.sql')
      for(const file of files.slice(0,-1))db.exec(readFileSync('migrations/'+file,'utf8'))
      db.exec(readFileSync('seed/seed.sql','utf8'))
      db.exec("INSERT INTO booking_review_links(booking_id,property_id,token_hash,expires_at) SELECT id,property_id,'existing-booking-invitation','2099-01-01' FROM bookings WHERE id=2")
      const tables=['bookings','booking_review_links','reviews','payments','properties','property_photos']
      const before=tables.map(t=>db.prepare('SELECT * FROM '+t).all())
      db.exec(readFileSync('migrations/0026_property_review_links.sql','utf8'))
      expect(tables.map(t=>db.prepare('SELECT * FROM '+t).all().map((r:any)=>{const {property_review_link_id:_,...rest}=r;return rest}))).toEqual(before)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok')
    }finally{db.close()}
  })
})
