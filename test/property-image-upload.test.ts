// @ts-expect-error Local Node SQLite fixture only.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture only.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { propertyImageType, PROPERTY_IMAGE_ACCEPT } from '../src/lib/property-images'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { propertyEditorRoutes } from '../src/routes/admin-properties'
import { publicRoutes } from '../src/routes/public'
import { mediaUrl } from '../src/lib/integrations'

// A real 8×8 AVIF, encoded locally; no external fixture or production uploads.
const avif = Uint8Array.from(atob('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAKAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAACAAAAAgAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAMG1kYXQSAAoIGAi/aICGg0IyGhTHh4ZlAgggnlAAAABIWtlc1jGHWYKTcyLA'), c => c.charCodeAt(0))
function fixture(role = 'admin') {
  const db = new DatabaseSync(':memory:')
  for (const name of readdirSync('migrations').filter((n:string)=>n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+name,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const user = db.prepare('SELECT * FROM users WHERE role=? LIMIT 1').get(role)
  const room = db.prepare('SELECT id,property_id FROM rooms ORDER BY id LIMIT 1').get() as any
  const DB = {prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const stored = new Map<string,{bytes:ArrayBuffer;type:string}>()
  const put = vi.fn(async(key:string,stream:any,options:any)=>{stored.set(key,{bytes:await new Response(stream).arrayBuffer(),type:options.httpMetadata.contentType})})
  const env:any={DB,MEDIA:{put,async get(key:string){const data=stored.get(key);return data?{body:new Response(data.bytes).body,httpEtag:'"test"',writeHttpMetadata(headers:Headers){headers.set('content-type',data.type)}}:null}},KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const app = new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes).route('/',propertyEditorRoutes).route('/',publicRoutes)
  const send=(path:string,fields:Record<string,string|File>)=>{const body=new FormData();for(const [k,v]of Object.entries(fields))body.append(k,v);return app.request('http://localhost'+path,{method:'POST',body},env)}
  return {db,env,app,room,put,stored,send}
}

describe('property image format support',()=>{
 it('serves AVIF/BMP originals without unsupported resizing while retaining JPEG optimization',()=>{
  expect(mediaUrl('properties/1/common/photo.avif',300,true)).toBe('/media/properties/1/common/photo.avif')
  expect(mediaUrl('properties/1/common/photo.bmp',300,true)).toBe('/media/properties/1/common/photo.bmp')
  expect(mediaUrl('properties/1/common/photo.jpg',300,true)).toBe('/cdn-cgi/image/width=300,quality=75,format=auto/media/properties/1/common/photo.jpg')
 })

 it.each(['image/jpeg','image/png','image/webp','image/avif','image/gif','image/bmp','image/apng'])('accepts the declared supported format %s',async mime=>{
  expect(await propertyImageType(new File(['fixture'],'photo',{type:mime}))).toMatchObject({contentType:mime})
  expect(PROPERTY_IMAGE_ACCEPT).toContain(mime)
 })
 it.each(['','application/octet-stream','binary/octet-stream'])('recognizes real AVIF bytes when browser reports %s',async mime=>{
  expect(await propertyImageType(new File([avif],'PHOTO.AVIF',{type:mime}))).toEqual({contentType:'image/avif',extension:'avif'})
 })
 it('normalizes common browser MIME aliases',async()=>{
  expect(await propertyImageType(new File(['photo'],'x.jpg',{type:'image/jpg'}))).toEqual({contentType:'image/jpeg',extension:'jpg'})
  expect(await propertyImageType(new File([avif],'x.avif',{type:'image/x-avif'}))).toEqual({contentType:'image/avif',extension:'avif'})
 })
 it('accepts AVIF compatible brands but never mistakes the minor version for one',async()=>{
  const compatible=avif.slice();compatible.set([109,105,102,49],8)
  expect(await propertyImageType(new File([compatible],'x.avif'))).toMatchObject({contentType:'image/avif'})
  const falseBrand=new Uint8Array([0,0,0,16,102,116,121,112,109,105,102,49,97,118,105,102])
  expect(await propertyImageType(new File([falseBrand],'x.avif'))).toBeNull()
 })
 it.each(['<svg onload="alert(1)"></svg>','<html>not a photo</html>','fake avif'])('rejects a renamed non-image without a supported MIME type',async body=>{
  expect(await propertyImageType(new File([body],'photo.avif',{type:'application/octet-stream'}))).toBeNull()
 })
 it.each(['image/svg+xml','text/html','image/heic','image/heif','image/tiff'])('rejects unsupported/active declared type %s',async mime=>{
  expect(await propertyImageType(new File(['photo'],'photo.avif',{type:mime}))).toBeNull()
 })
 it.each(['common','room','thumbnail','legacy-common','legacy-room'])('persists and serves AVIF correctly through %s upload',async target=>{
  const f=fixture();try{
   const before=JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
   const file=new File([avif],'Room.AVIF',{type:'application/octet-stream'})
   const id=f.room.property_id
   const response=target==='common'?await f.send(`/admin/properties/${id}/common-photos`,{photo:file,upload_key:crypto.randomUUID()}):target==='thumbnail'?await f.send(`/admin/properties/${id}/setup/6`,{thumb_file:file}):target==='room'?await f.send(`/admin/properties/${id}/setup/6`,{ib0_room:String(f.room.id),ib0_files:file}):await f.send(`/admin/properties/${id}/media`,{category:target==='legacy-room'?'room':'common',room_id:String(f.room.id),files:file})
   expect([200,303]).toContain(response.status);expect(f.put).toHaveBeenCalledTimes(1)
   const [key,data]=[...f.stored][0];expect(key).toMatch(/\.avif$/);expect(data.type).toBe('image/avif');expect(new Uint8Array(data.bytes)).toEqual(avif)
   const photo=f.db.prepare('SELECT * FROM property_photos WHERE r2_key=?').get(key) as any
   expect(photo.property_id).toBe(id);expect(photo.media_type).toBe('image');expect(photo.room_id).toBe(target==='room'||target==='legacy-room'?f.room.id:null)
   const served=await f.app.request('http://localhost/media/'+key,{},f.env);expect(served.status).toBe(200);expect(served.headers.get('content-type')).toBe('image/avif');expect(new Uint8Array(await served.arrayBuffer())).toEqual(avif)
   if(target==='thumbnail')expect((f.db.prepare('SELECT thumbnail_photo_id FROM properties WHERE id=?').get(id) as any).thumbnail_photo_id).toBe(photo.id)
   else expect(JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))).toBe(before)
  }finally{f.db.close()}
 })
 it('renders consistent file pickers for common photos, room photos, thumbnails and the legacy editor',async()=>{
  const f=fixture();try{
   for(const path of [`/admin/properties/${f.room.property_id}/setup/1`,`/admin/properties/${f.room.property_id}/setup/6`,`/admin/properties/${f.room.property_id}`]){
    const response=await f.app.request('http://localhost'+path,{},f.env);expect(response.status).toBe(200)
    const html=await response.text();expect(html).toContain(PROPERTY_IMAGE_ACCEPT)
    expect(html).toContain('image/avif');expect(html).toContain('image/gif');expect(html).toContain('image/bmp')
   }
  }finally{f.db.close()}
 })
 it('keeps upload limits, rejects unsupported bytes and requires existing property permissions',async()=>{
  const f=fixture();try{
   for(const file of [new File(['<svg/>'],'renamed.avif',{type:'application/octet-stream'}),new File([new Uint8Array(10*1024*1024+1)],'large.avif',{type:'image/avif'})]){
    const response=await f.send(`/admin/properties/${f.room.property_id}/common-photos`,{photo:file,upload_key:crypto.randomUUID()});expect(response.status).toBe(400)
   }
   expect(f.put).not.toHaveBeenCalled()
  }finally{f.db.close()}
  const guest=fixture('guest');try{expect((await guest.send(`/admin/properties/${guest.room.property_id}/common-photos`,{photo:new File([avif],'x.avif',{type:'image/avif'}),upload_key:crypto.randomUUID()})).status).toBe(403);expect(guest.put).not.toHaveBeenCalled()}finally{guest.db.close()}
 })
})
