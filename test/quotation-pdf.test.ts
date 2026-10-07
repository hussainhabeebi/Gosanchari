// @ts-expect-error Local SQLite fixture only.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local filesystem fixture only.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { opsRoutes } from '../src/routes/staff-ops'
import { quotationPdfFilename } from '../src/lib/quotation-pdf'

// Workers loads these assets as ArrayBuffers; reproduce that binding in Vitest.
// @ts-expect-error Node font assets fixture only.
vi.mock('../src/assets/quotation-sans.ttf', async()=>{const fs=await import('node:fs');const bytes=fs.readFileSync('src/assets/quotation-sans.ttf');return {default:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}})
// @ts-expect-error Node font assets fixture only.
vi.mock('../src/assets/quotation-sans-bold.ttf', async()=>{const fs=await import('node:fs');const bytes=fs.readFileSync('src/assets/quotation-sans-bold.ttf');return {default:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}})

function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const pid=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES ('pdf-fixture','PDF Test Resort','resort','Munnar','live')").run().lastInsertRowid)
  const rid=Number(db.prepare("INSERT INTO rooms(property_id,name,base_rate,capacity) VALUES (?,'King Suite With Balcony',5000,4)").run(pid).lastInsertRowid)
  const qid=Number(db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,valid_till,inclusions,exclusions,payment_terms,apply_gst) VALUES ('GS-QT-123456','pdf-token',1,'PDF Guest','2030-12-31','Breakfast included','Travel excluded','Pay on confirmation',1)").run().lastInsertRowid)
  db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,rooms_count,adults,children,meal_plan,subtotal,discount,extra_charges,taxes,total,addons) VALUES (?,?,?,'2030-11-01','2030-11-03',2,2,1,'CP',20000,500,900,1020,21420,'[{\"kind\":\"kids\",\"name\":\"Kids Amount\",\"price\":900,\"qty\":1,\"total\":900}]')").run(qid,pid,rid)
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null}};return st}}
  const env:any={DB,KV:{async get(){return null},async put(){}},SITE_URL:'https://gosanchari.com',ENVIRONMENT:'development'}
  const app=(user:any={id:1,role:'sales',language:'en'})=>new Hono<any>().use('*',async(c,next)=>{if(user)c.set('user',user);await next()}).route('/',opsRoutes)
  return {db,env,qid,app,url:'http://localhost/staff/quotes/'+qid}
}

async function extractedText(bytes:Uint8Array){
  const doc=await PDFDocument.load(bytes), text:string[]=[]
  for(const page of doc.getPages()){
    const fonts=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),maps=new Map<string,Map<string,string>>()
    for(const [name,ref] of fonts.entries()){
      const font=doc.context.lookup(ref,PDFDict),stream=font.lookup(PDFName.of('ToUnicode')) as PDFRawStream
      const cmap=new TextDecoder().decode(decodePDFRawStream(stream).decode()),map=new Map<string,string>()
      for(const m of cmap.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>/g)){
        const units=m[2].match(/.{4}/g)??[];map.set(m[1].toUpperCase(),String.fromCharCode(...units.map(x=>parseInt(x,16))))
      }
      maps.set(name.asString().slice(1),map)
    }
    let fontName=''
    for(const ref of (page.node.Contents()! as PDFArray).asArray()){
      const content=new TextDecoder().decode(decodePDFRawStream((doc.context.lookup(ref) as PDFRawStream)).decode())
      for(const m of content.matchAll(/\/([^\s]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s+Tj/g)){
        if(m[1])fontName=m[1];else text.push((m[2].match(/.{4}/g)??[]).map(x=>maps.get(fontName)?.get(x.toUpperCase())??'').join(''))
      }
    }
  }
  return {doc,text:text.join('\n')}
}

describe('Direct authenticated quotation PDF',()=>{
  it.each(['Desktop Chrome','Android Chrome','iPhone Safari'])('returns a real non-empty PDF with native-viewer headers for %s',async(agent)=>{
    const f=fixture()
    try{
      const before=JSON.stringify(f.db.prepare('SELECT * FROM quotation_options WHERE quotation_id=?').all(f.qid))
      const r=await f.app().request(f.url+'/pdf',{headers:{'User-Agent':agent}},f.env)
      expect(r.status).toBe(200);expect(r.headers.get('content-type')).toBe('application/pdf')
      expect(r.headers.get('content-disposition')).toBe('inline; filename="Quotation-GS-QT-123456.pdf"')
      expect(r.headers.get('cache-control')).toBe('private, no-store')
      const bytes=new Uint8Array(await r.arrayBuffer());expect(new TextDecoder().decode(bytes.slice(0,4))).toBe('%PDF');expect(bytes.length).toBeGreaterThan(1000)
      const {doc,text}=await extractedText(bytes)
      expect(doc.getTitle()).toBe('Quotation GS-QT-123456');expect(doc.getPageCount()).toBeGreaterThan(0)
      for(const value of ['PDF Guest','PDF Test Resort','King Suite With Balcony','Munnar','₹20,000','− ₹500','Kids Amount (₹900)','₹1,020','₹21,420','Breakfast included','Travel excluded','Pay on confirmation','https://gosanchari.com/q/pdf-token'])expect(text).toContain(value)
      expect(JSON.stringify(f.db.prepare('SELECT * FROM quotation_options WHERE quotation_id=?').all(f.qid))).toBe(before)
      const html=await (await f.app().request(f.url,{},f.env)).text()
      expect(html).toContain('href="/staff/quotes/'+f.qid+'/pdf">PDF')
      expect(html).not.toContain('href="/staff/quotes/'+f.qid+'/print" target="_blank">PDF')
      const print=await f.app().request(f.url+'/print',{},f.env)
      expect(print.headers.get('content-type')).toContain('text/html');expect(await print.text()).toContain('Print / Save as PDF')
    }finally{f.db.close()}
  })
  it('enforces staff permissions and existing restricted-quotation 404 behavior',async()=>{
    const f=fixture()
    try{
      expect((await f.app(null).request(f.url+'/pdf',{},f.env)).status).toBe(302)
      expect((await f.app({id:1,role:'guest'}).request(f.url+'/pdf',{},f.env)).status).toBe(403)
      expect((await f.app({id:999,role:'sales'}).request(f.url+'/pdf',{},f.env)).status).toBe(404)
      expect((await f.app({id:999,role:'admin'}).request(f.url+'/pdf',{},f.env)).status).toBe(200)
      expect((await f.app().request('http://localhost/staff/quotes/999999/pdf',{},f.env)).status).toBe(404)
    }finally{f.db.close()}
  })
  it('sanitizes filename content and paginates long saved text',async()=>{
    expect(quotationPdfFilename('GS-QT-123456\r\n"/')).toBe('Quotation-GS-QT-123456____.pdf')
    const f=fixture()
    try{
      f.db.prepare('UPDATE quotations SET exclusions=? WHERE id=?').run('Long saved policy line\n'.repeat(150),f.qid)
      const r=await f.app().request(f.url+'/pdf',{},f.env)
      const {doc,text}=await extractedText(new Uint8Array(await r.arrayBuffer()))
      expect(doc.getPageCount()).toBeGreaterThan(1);expect(text).toContain('Pay on confirmation')
    }finally{f.db.close()}
  })
})
