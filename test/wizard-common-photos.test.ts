// @ts-expect-error Local Node fixture only.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node fixture only.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local Node fixture only.
import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'

function fixture() {
  const db=new DatabaseSync(':memory:')
  for(const f of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+f,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const put=vi.fn(async()=>{}),user=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const env:any={DB,MEDIA:{put},KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes)
  const upload=async(id:number,file=new File(['image'],'photo.jpg',{type:'image/jpeg'}),token=crypto.randomUUID())=>{const body=new FormData();body.append('photo',file);body.append('upload_key',token);return app.request(`http://localhost/admin/properties/${id}/common-photos`,{method:'POST',body},env)}
  return {db,env,app,upload,put}
}

// Exercise the shipped preview/upload controller against the real route and local SQLite/R2 doubles.
function ui(f:ReturnType<typeof fixture>,id?:number) {
  const node=(tag='span'):any=>({tag,children:[] as any[],dataset:{} as Record<string,string>,listeners:{} as Record<string,Function[]>,textContent:'',hidden:false,disabled:false,
    addEventListener(k:string,fn:Function){(this.listeners[k]??=[]).push(fn)},async fire(k:string,event:any={}){await Promise.all((this.listeners[k]??[]).map((fn:Function)=>fn(event)))},
    append(...c:any[]){c.forEach(x=>this.appendChild(x))},appendChild(c:any){this.children.push(c);c.parent=this},remove(){this.parent.children=this.parent.children.filter((c:any)=>c!==this)},setAttribute(k:string,v:string){this[k]=v},getAttribute(k:string){return this[k]??null},closest(){return this.parent}})
  const input=node('input');input.files=[];input.value=''
  const thumbs=node(),status=node(),form=node('form'),area=node();area.dataset.uploadUrl=id?`/admin/properties/${id}/common-photos`:'';area.closest=()=>form
  form.action=id?`http://localhost/admin/properties/${id}/setup/1`:'http://localhost/admin/properties/new';form.reportValidity=()=>true;form.requestSubmit=vi.fn()
  const requests:Promise<void>[]=[], revokes:string[]=[]
  class XHR {
    upload:any={};status=0;responseText='';responseURL='';onload=()=>{};onerror=()=>{};url=''
    open(_method:string,url:string){this.url=url}
    send(body:FormData){const task=(async()=>{try{this.upload.onprogress?.({lengthComputable:true,loaded:5,total:5});let response=await f.app.request(new URL(this.url,'http://localhost').href,{method:'POST',body},f.env);this.status=response.status;this.responseURL=this.url;if(response.status===303){this.responseURL=new URL(response.headers.get('location')!,'http://localhost').href;response=await f.app.request(this.responseURL,{},f.env);this.status=response.status}this.responseText=await response.text();this.onload()}catch{this.onerror()}})();requests.push(task)}
  }
  class Data extends FormData {constructor(source?:any){super();if(source){for(const [k,v] of Object.entries({name:'New photo property',destination:'Munnar',type:'resort',best_for:'family',facilities:'pool',highlights:'Manual highlight'})) this.append(k,v)}}}
  const URLDouble:any=URL; // URL parsing remains real; object previews are local fixture URLs.
  const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL
  URLDouble.createObjectURL=()=> 'blob:preview-'+Math.random();URLDouble.revokeObjectURL=(url:string)=>revokes.push(url)
  const document=node();document.createElement=(tag:string)=>node(tag)
  const history={replaceState:vi.fn()},window=node()
  const source=readFileSync('public/app.js','utf8') as string
  const selectCover=vi.fn((url:string,options:any)=>f.app.request(new URL(url,'http://localhost').href,options,f.env))
  const scope={document,window,history,location:{href:'http://localhost/admin/properties/new'},URL:URLDouble,URLSearchParams,FormData:Data,XMLHttpRequest:XHR,crypto,confirm:()=>true,fetch:selectCover,
    $:(s:string)=>s==='[data-common-photo-input]'?input:s==='[data-common-photo-thumbs]'?thumbs:status,$$:(s:string)=>s==='[data-common-photos]'?[area]:s==='[data-select-common-thumbnail]'?thumbs.children.flatMap((card:any)=>card.children.filter((child:any)=>child.dataset.selectCommonThumbnail)):[]}
  runInNewContext(source.slice(source.indexOf('  // Common-image covers:'),source.indexOf('  // Common photos:')),scope)
  runInNewContext(source.slice(source.indexOf('  // Common photos:'),source.indexOf('  // Best For:')),scope)
  const settle=async()=>{for(let i=0;i<8;i++){await Promise.all(requests);await new Promise(r=>setTimeout(r,0))}}
  return {input,thumbs,status,form,area,history,requests,revokes,settle,selectCover,async choose(card:any){const button=card.children.find((c:any)=>c.dataset.selectCommonThumbnail);button.closest=(s:string)=>s==='[data-select-common-thumbnail]'?button:area;await document.fire('click',{target:button,preventDefault(){}})},async select(files:File[]){input.files=files;await input.fire('change')},close(){URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke}}
}

const photo=(name:string)=>new File(['image'],name,{type:'image/jpeg'})
describe('wizard common photos',()=>{
  it.each(['image/avif','image/gif','image/bmp','image/apng'])('previews and uploads %s without the old JPG/PNG/WebP-only rejection',async type=>{
    const f=fixture(),controller=ui(f,1)
    try{
      const file=new File(['image'],'common.'+type.split('/')[1],{type})
      await controller.select([file]);await controller.settle()
      expect(controller.thumbs.children).toHaveLength(1)
      expect(controller.thumbs.children[0].children[2].textContent).toBe('Saved')
      expect(f.put).toHaveBeenCalledTimes(1)
      expect(f.put.mock.calls[0]).toBeDefined()
    }finally{controller.close();f.db.close()}
  })

  it.each(['','application/octet-stream'])('uploads AVIF without a recognized browser MIME type (%s)',async type=>{
    const f=fixture(),controller=ui(f,1)
    try{
      const header=new Uint8Array([0,0,0,20,102,116,121,112,97,118,105,102,0,0,0,0,97,118,105,102])
      await controller.select([new File([header],'COMMON.AVIF',{type})]);await controller.settle()
      expect(controller.thumbs.children).toHaveLength(1)
      expect(controller.thumbs.children[0].children[2].textContent).toBe('Saved')
      expect(f.put).toHaveBeenCalledTimes(1)
    }finally{controller.close();f.db.close()}
  })
  it('selection immediately previews multiple files, then persists thumbnails for navigation/reopening without duplicates',async()=>{
    const f=fixture(),controller=ui(f,1)
    try {
      const before=f.db.prepare('SELECT COUNT(*) n FROM property_photos').get() as any
      const dataBefore=JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
      await controller.select([photo('one.jpg'),photo('two.jpg')])
      expect(controller.thumbs.children).toHaveLength(2)
      expect(controller.thumbs.children[0].children[0].alt).toBe('one.jpg')
      await controller.settle()
      expect(controller.thumbs.children.map((c:any)=>c.children[2].textContent)).toEqual(['Saved','Saved'])
      expect(controller.input.value).toBe('')
      const ids=controller.thumbs.children.map((c:any)=>Number(c.dataset.photoId))
      expect(ids[0]).not.toBe(ids[1])
      for(const id of ids) expect(f.db.prepare('SELECT property_id,room_id,category,media_type FROM property_photos WHERE id=?').get(id)).toMatchObject({property_id:1,room_id:null,category:'common',media_type:'image'})
      await f.app.request('http://localhost/admin/properties/1/setup/2',{},f.env)
      for(let i=0;i<2;i++){
        const html=await (await f.app.request('http://localhost/admin/properties/1/setup/1',{},f.env)).text()
        for(const id of ids) expect(html).toContain(`data-photo-id="${id}"`)
      }
      expect((f.db.prepare('SELECT COUNT(*) n FROM property_photos').get() as any).n).toBe(before.n+2)
      expect(f.put).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))).toBe(dataBefore)
      const roomHtml=await (await f.app.request('http://localhost/admin/properties/1/setup/6',{},f.env)).text()
      for(const id of ids) expect(roomHtml).not.toContain(`value="${id}" formnovalidate`)
      await controller.thumbs.children[0].children[1].fire('click');await controller.settle()
      expect(controller.thumbs.children).toHaveLength(1)
      expect(f.db.prepare('SELECT id FROM property_photos WHERE id=?').get(ids[0])).toBeUndefined()
      expect(f.db.prepare('SELECT id FROM property_photos WHERE id=?').get(ids[1])).toBeTruthy()
    }finally{controller.close();f.db.close()}
  })
  it('new-property pending previews survive the first save and attach to its new ID',async()=>{
    const f=fixture(),controller=ui(f)
    try{
      await controller.select([photo('new-one.jpg'),photo('new-two.jpg')])
      expect(controller.thumbs.children).toHaveLength(2);expect(f.put).not.toHaveBeenCalled()
      expect(controller.thumbs.children[0].children[2].textContent).toContain('Save & Continue')
      await controller.form.fire('submit',{preventDefault(){}});await controller.settle()
      const p=f.db.prepare("SELECT id FROM properties WHERE name='New photo property'").get() as any
      expect(p.id).toBeGreaterThan(0)
      expect(f.db.prepare('SELECT room_id,category FROM property_photos WHERE property_id=?').all(p.id)).toHaveLength(2)
      expect(controller.thumbs.children.map((c:any)=>c.children[2].textContent)).toEqual(['Saved','Saved'])
      expect(controller.form.requestSubmit).toHaveBeenCalledTimes(1)
      const html=await (await f.app.request(`http://localhost/admin/properties/${p.id}/setup/1`,{},f.env)).text()
      for(const card of controller.thumbs.children) expect(html).toContain(`data-photo-id="${card.dataset.photoId}"`)
    }finally{controller.close();f.db.close()}
  })
  it('shows failed upload state; retry restores saved preview without duplicate records',async()=>{
    const f=fixture(),controller=ui(f,1)
    try{
      f.put.mockRejectedValueOnce(new Error('R2 unavailable'))
      await controller.select([photo('retry.jpg')]);await controller.settle()
      const card=controller.thumbs.children[0]
      expect(card.children[2].textContent).toContain('retry')
      expect(card.children[4].hidden).toBe(false)
      expect(card.dataset.photoId).toBeUndefined()
      await card.children[4].fire('click');await controller.settle()
      expect(card.children[2].textContent).toBe('Saved')
      const token=(f.put.mock.calls[1] as any)[0].match(/common\/(.*)\.jpeg$/)?.[1]??(f.put.mock.calls[1] as any)[0].match(/common\/(.*)\.jpg$/)[1]
      const id=card.dataset.photoId
      const repeat=await f.upload(1,photo('retry.jpg'),token)
      expect((await repeat.json() as any).id).toBe(Number(id))
      expect(f.db.prepare('SELECT * FROM property_photos WHERE id=?').all(Number(id))).toHaveLength(1)
      expect(f.put).toHaveBeenCalledTimes(2)
    }finally{controller.close();f.db.close()}
  })
  it('removes only one explicit common-photo record; rejects room/cross-property removal and invalid uploads',async()=>{
    const f=fixture()
    try{
      const one=await (await f.upload(1,photo('one.jpg'))).json() as any,two=await (await f.upload(1,photo('two.jpg'))).json() as any
      const before=JSON.stringify(f.db.prepare('SELECT * FROM property_photos WHERE id != ? ORDER BY id').all(one.id))
      const remove=(pid:number,id:number)=>f.app.request(`http://localhost/admin/properties/${pid}/common-photos/${id}/remove`,{method:'POST'},f.env)
      expect((await remove(2,one.id)).status).toBe(404)
      const room=f.db.prepare('SELECT id FROM property_photos WHERE room_id IS NOT NULL LIMIT 1').get() as any
      expect((await remove(1,room.id)).status).toBe(404)
      expect((await remove(1,one.id)).status).toBe(200)
      expect(JSON.stringify(f.db.prepare('SELECT * FROM property_photos ORDER BY id').all())).toBe(before)
      expect(f.db.prepare('SELECT id FROM property_photos WHERE id=?').get(two.id)).toBeTruthy()
      expect((await f.upload(1,new File(['bad'],'bad.txt',{type:'text/plain'}))).status).toBe(400)
    }finally{f.db.close()}
  })
  it('removes a pending selection locally without touching any saved photo',async()=>{
    const f=fixture(),controller=ui(f)
    try{
      const before=JSON.stringify(f.db.prepare('SELECT * FROM property_photos ORDER BY id').all())
      await controller.select([photo('pending-one.jpg'),photo('pending-two.jpg')])
      await controller.thumbs.children[0].children[1].fire('click')
      expect(controller.thumbs.children).toHaveLength(1)
      expect(controller.thumbs.children[0].children[0].alt).toBe('pending-two.jpg')
      expect(f.put).not.toHaveBeenCalled()
      expect(JSON.stringify(f.db.prepare('SELECT * FROM property_photos ORDER BY id').all())).toBe(before)
    }finally{controller.close();f.db.close()}
  })
  it('preserves the existing multipart Save & Continue upload fallback',async()=>{
    const f=fixture()
    try{
      const body=new FormData()
      for(const [k,v] of Object.entries({name:'Native upload property',destination:'Munnar',type:'resort',best_for:'family',facilities:'pool',highlights:'Keep manual highlight'})) body.append(k,v)
      body.append('photos',photo('fallback-one.jpg'));body.append('photos',photo('fallback-two.jpg'))
      const response=await f.app.request('http://localhost/admin/properties/new',{method:'POST',body},f.env)
      expect(response.status).toBe(303)
      const id=Number(response.headers.get('location')!.match(/properties\/(\d+)/)![1])
      const photos=f.db.prepare('SELECT * FROM property_photos WHERE property_id=?').all(id) as any[]
      expect(photos).toHaveLength(2)
      const html=await (await f.app.request(`http://localhost/admin/properties/${id}/setup/1`,{},f.env)).text()
      for(const photo of photos) expect(html).toContain(`data-photo-id="${photo.id}"`)
      expect(f.put).toHaveBeenCalledTimes(2)
    }finally{f.db.close()}
  })

})


describe('common-photo thumbnail interaction',()=>{
 it('offers cover selection immediately after upload and updates the visible selected indicator when changing images',async()=>{
  const f=fixture(),u=ui(f,1);try{
   await u.select([photo('cover-one.jpg'),photo('cover-two.jpg')]);await u.settle()
   const buttons=u.thumbs.children.map((card:any)=>card.children.find((child:any)=>child.dataset.selectCommonThumbnail))
   expect(buttons.map((b:any)=>b.textContent)).toEqual(['Use as Thumbnail','Use as Thumbnail'])
   await u.choose(u.thumbs.children[0]);expect(buttons[0].textContent).toBe('Selected Thumbnail');expect(buttons[0].disabled).toBe(true);expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
   await u.choose(u.thumbs.children[1]);expect(buttons[0].textContent).toBe('Use as Thumbnail');expect(buttons[0].disabled).toBe(false);expect(buttons[1].textContent).toBe('Selected Thumbnail')
   expect(f.db.prepare('SELECT thumbnail_photo_id FROM properties WHERE id=1').get()).toEqual({thumbnail_photo_id:Number(u.thumbs.children[1].dataset.photoId)})
   expect(f.put).toHaveBeenCalledTimes(2);expect(u.thumbs.children).toHaveLength(2)
  }finally{u.close();f.db.close()}
 })
 it('keeps thumbnails and the old selection after a failed request and permits retry',async()=>{
  const f=fixture(),u=ui(f,1);try{
   await u.select([photo('cover.jpg')]);await u.settle();const card=u.thumbs.children[0],button=card.children.find((c:any)=>c.dataset.selectCommonThumbnail)
   u.selectCover.mockRejectedValueOnce(new Error('Network interruption'));await u.choose(card)
   expect(u.status.textContent).toBe('Network interruption');expect(button.disabled).toBe(false);expect(button.textContent).toBe('Use as Thumbnail');expect(u.thumbs.children).toHaveLength(1)
   await u.choose(card);expect(button.textContent).toBe('Selected Thumbnail');expect(f.put).toHaveBeenCalledTimes(1)
  }finally{u.close();f.db.close()}
 })
})
