// @ts-expect-error Local Node fixture only.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node fixture only.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local Node fixture only.
import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { searchProperties } from '../src/lib/properties'
import { publicRoutes } from '../src/routes/public'
import { THEMES } from '../src/lib/catalog'

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const DB = {prepare(sql: string) {
    let args: any[] = []
    const statement = {bind(...v: any[]) {args=v;return statement},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}}
    return statement
  }}
  const env: any = {DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const user = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const app = new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes)
  return {db,env,app}
}

function dropdown(selected: string[]) {
  const events = (o: any) => Object.assign(o,{listeners:{} as Record<string,Function>,addEventListener(k:string,f:Function){this.listeners[k]=f},fire(k:string,event:any={}){this.listeners[k]?.(event)}})
  const doc: any = events({activeElement:null,createElement(){return events({children:[] as any[],appendChild(c:any){this.children.push(c)},setAttribute(k:string,v:string){this[k]=v}})},createTextNode(text:string){return {textContent:text}}})
  const inputs: any[] = Object.entries(THEMES).map(([value,label])=>events({value,checked:selected.includes(value),nextElementSibling:{textContent:label},setCustomValidity(v:string){this.validity=v},focus(){doc.activeElement=this}}))
  const summary = {focus(){doc.activeElement=summary}}
  const tags: any = {children:[],textContent:'',replaceChildren(){this.children=[];this.textContent=''},appendChild(c:any){this.children.push(c)}}
  const form = events({})
  const field = events({open:false,closest(){return form},contains(target:any){return target===summary||inputs.includes(target)}})
  const source = readFileSync('public/app.js','utf8') as string
  runInNewContext(source.slice(source.indexOf('  // Best For:'),source.indexOf('  var roomSel =')),{
    $:(s:string)=>s==='summary'?summary:tags,$$:(s:string)=>s==='[data-best-for]'?[field]:inputs,document:doc,setTimeout:(f:Function)=>f(),
  })
  return {inputs,field,tags,summary,doc,select(key:string){const input=inputs.find(i=>i.value===key)!;input.checked=!input.checked;input.fire('change')},values(){return inputs.filter(i=>i.checked).map(i=>i.value)}}
}

describe('Best For multi-select',()=>{
  it('keeps multiple selections open, displays removable chips and supports keyboard/validation',()=>{
    const ui=dropdown(['family']);ui.field.open=true
    for(const key of ['honeymoon','nature','adventure']) ui.select(key)
    expect(ui.values()).toEqual(['family','honeymoon','nature','adventure'])
    expect(ui.tags.children.map((t:any)=>t.children[0].textContent)).toEqual(['Family','Honeymoon / couples','Nature & wildlife','Adventure'])
    expect(ui.field.open).toBe(true)
    const remove=ui.tags.children[1].children[1]
    expect(remove['aria-label']).toBe('Remove Honeymoon / couples')
    remove.fire('click',{preventDefault(){},stopPropagation(){}})
    expect(ui.values()).toEqual(['family','nature','adventure'])
    ui.select('adventure');expect(ui.values()).toEqual(['family','nature'])
    ui.field.fire('keydown',{key:'ArrowDown',preventDefault(){}})
    expect(ui.doc.activeElement).toBe(ui.inputs[0])
    ui.field.fire('keydown',{key:'Escape'});expect(ui.field.open).toBe(false)
    expect(ui.doc.activeElement).toBe(ui.summary)
    ui.select('family');ui.select('nature')
    expect(ui.inputs[0].validity).toBe('Select at least one Best For option.')
    ui.inputs[0].fire('invalid');expect(ui.field.open).toBe(true)
  })

  it('creates, saves, reopens and removes selections without changing unrelated records',async()=>{
    const {db,env,app}=fixture()
    try {
      const before=JSON.stringify(['properties','rooms','season_rates','property_photos'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
      const post=async(path:string,values:string[])=>{
        const body=new URLSearchParams({name:'Multi Best For Test',destination:'Vagamon',type:'resort',highlights:'Estate; Mountain',facilities:'pool'})
        values.forEach(v=>body.append('best_for',v))
        return app.request('http://localhost'+path,{method:'POST',body},env)
      }
      const created=await post('/admin/properties/new',['family','honeymoon','nature','adventure'])
      expect(created.status).toBe(303)
      const id=Number(created.headers.get('location')!.match(/properties\/(\d+)/)![1])
      expect(db.prepare('SELECT themes,stay_type FROM properties WHERE id=?').get(id)).toMatchObject({themes:'["family","honeymoon","nature","adventure"]',stay_type:'resort'})
      const html=await (await app.request(`http://localhost/admin/properties/${id}/setup/1`,{},env)).text()
      for(const key of ['family','honeymoon','nature','adventure']) expect(html).toContain(`name="best_for" value="${key}" checked`)
      expect(html.match(/type="checkbox" name="best_for"/g)).toHaveLength(11)
      expect(html).toContain('name="type" id="type" required')
      expect((await post(`/admin/properties/${id}/setup/1`,['family','nature','adventure'])).status).toBe(303)
      expect(JSON.parse((db.prepare('SELECT themes FROM properties WHERE id=?').get(id) as any).themes)).toEqual(['family','nature','adventure'])
      const reopened=await (await app.request(`http://localhost/admin/properties/${id}/setup/1`,{},env)).text()
      expect(reopened).not.toContain('value="honeymoon" checked')
      const single=await post(`/admin/properties/${id}/setup/1`,['family'])
      expect(single.status).toBe(303)
      expect((db.prepare('SELECT themes FROM properties WHERE id=?').get(id) as any).themes).toBe('["family"]')
      expect(await (await app.request(`http://localhost/admin/properties/${id}/setup/1`,{},env)).text()).toContain('value="family" checked')
      await post(`/admin/properties/${id}/setup/1`,[])
      expect((db.prepare('SELECT themes FROM properties WHERE id=?').get(id) as any).themes).toBe('["family"]')
      expect(JSON.stringify(['properties','rooms','season_rates','property_photos'].map(t=>db.prepare('SELECT * FROM '+t+' WHERE '+(t==='properties'?'id':'property_id')+' IS NOT ? ORDER BY id').all(id)))).toBe(before)
    }finally{db.close()}
  })

  it('public badges list every theme and Family/Pet filters match membership or legacy flags',async()=>{
    const {db,env}=fixture()
    try {
      const p=db.prepare("SELECT id,slug FROM properties WHERE status='live' ORDER BY id LIMIT 1").get() as any
      db.prepare('UPDATE properties SET family_friendly=0,pet_friendly=0,themes=? WHERE id=?').run('["family","honeymoon","nature","adventure","pet"]',p.id)
      for(const filter of [{family:true},{pet:true}]) expect((await searchProperties(env,filter)).map(p=>p.id)).toContain(p.id)
      const html=await (await new Hono().route('/',publicRoutes).request('http://localhost/stay/'+p.slug,{},env)).text()
      for(const key of ['family','honeymoon','nature','adventure','pet']) expect(html).toContain(THEMES[key].replace('&','&amp;'))
      db.prepare("UPDATE properties SET themes='[]',family_friendly=1,pet_friendly=1 WHERE id=?").run(p.id)
      for(const filter of [{family:true},{pet:true}]) expect((await searchProperties(env,filter)).map(p=>p.id)).toContain(p.id)
      db.prepare('UPDATE properties SET family_friendly=0,pet_friendly=0 WHERE id=?').run(p.id)
      for(const filter of [{family:true},{pet:true}]) expect((await searchProperties(env,filter)).map(p=>p.id)).not.toContain(p.id)
    }finally{db.close()}
  })
})
