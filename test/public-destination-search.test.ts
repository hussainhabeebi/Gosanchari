// @ts-expect-error Test runtime uses Node 24; app types intentionally target Workers.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node filesystem is used only by the local test fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { matchingDestinations, publicDestinations } from '../src/lib/public-destinations'
import { publicRoutes } from '../src/routes/public'

function fixture(categories: string[] = []) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync('migrations').filter((f: string) => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'))
  db.exec(readFileSync('seed/seed.sql', 'utf8'))
  const property = db.prepare('SELECT id,slug,name FROM properties WHERE status=\'live\' ORDER BY id LIMIT 1').get() as { id: number; slug: string; name: string }
  db.prepare('DELETE FROM property_photos WHERE property_id=?').run(property.id)
  categories.forEach((category, index) => db.prepare('INSERT INTO property_photos(property_id,r2_key,category,sort) VALUES (?,?,?,?)').run(property.id, `ui-photo-${index}.jpg`, category, index))
  const DB = { prepare(sql: string) {
    let values: any[] = []
    const statement = { bind(...v: any[]) { values = v; return statement }, async all() { return { results: db.prepare(sql).all(...values) } }, async first() { return db.prepare(sql).get(...values) ?? null } }
    return statement
  } }
  const env: any = { DB, KV: { async get() { return null }, async put() {} }, SITE_URL: 'http://localhost', TURNSTILE_SITE_KEY: '', ENVIRONMENT: 'development' }
  return { db, property, env, app: new Hono().route('/', publicRoutes) }
}

describe('public destination autocomplete', () => {
  it('deduplicates Live locations, expands unambiguous incomplete names and rejects invalid entries without writes', async () => {
    const f = fixture()
    try {
      f.db.exec("UPDATE properties SET status='hidden'")
      const locations = ['Vag', 'Vagamon', 'Vagamon,Keral', 'VAGAMON', 'Munnar', 'MUNNAR', 'Munna', 'unknown', '12', '', 'Ooty']
      for (const [i, destination] of locations.entries()) f.db.prepare('INSERT INTO properties(slug,name,type,destination,status) VALUES (?,?,?,?,?)').run('destination-'+i, 'Destination '+i, 'resort', destination, 'live')
      f.db.prepare('INSERT INTO properties(slug,name,type,destination,status) VALUES (?,?,?,?,?)').run('draft-place', 'Draft', 'resort', 'Draftville', 'draft')
      const before = JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())
      const catalog = await publicDestinations(f.env)
      expect(catalog.map(d=>d.label)).toEqual(['Munnar, Kerala', 'Ooty', 'Vagamon, Kerala'])
      expect(catalog.find(d=>d.label==='Vagamon, Kerala')?.aliases).toHaveLength(4)
      for (const q of ['Vag', 'Vagmon', 'vAgAmOn', 'Vagamon,Keral']) expect(matchingDestinations(catalog,q).map(d=>d.label)).toEqual(['Vagamon, Kerala'])
      expect(matchingDestinations(catalog,'zzzzzz')).toEqual([])
      expect(matchingDestinations(catalog,'')).toEqual(catalog)
      expect(JSON.stringify(f.db.prepare('SELECT * FROM properties ORDER BY id').all())).toBe(before)
    } finally { f.db.close() }
  })

  it('returns labels only and searches every stored alias of the selected destination', async () => {
    const f = fixture()
    try {
      f.db.exec("UPDATE properties SET status='hidden'")
      for (const [i,destination] of ['Vagamon','Vag','Vagamon,Keral','VAGAMON','Munnar'].entries()) {
        const id = Number(f.db.prepare('INSERT INTO properties(slug,name,type,destination,status) VALUES (?,?,?,?,?)').run('search-place-'+i,'Search Place '+i,'resort',destination,'live').lastInsertRowid)
        f.db.prepare('INSERT INTO rooms(property_id,name,base_rate,capacity,units,staff_rate,net_rate) VALUES (?,?,?,?,?,?,?)').run(id,'Room',4000,2,5,987654,876543)
      }
      const suggestions = await (await f.app.request('http://localhost/api/public/destinations?q=Vagmon',{},f.env)).json()
      expect(suggestions).toEqual(['Vagamon, Kerala'])
      for (const destination of ['Vagamon, Kerala','Vagmon','VAGAMON']) {
        const response = await f.app.request('http://localhost/search?destination='+encodeURIComponent(destination)+'&guests=2',{},f.env)
        expect(response.status).toBe(200)
        const html = await response.text()
        const results = html.slice(html.indexOf('class="results'),html.indexOf('class="results')+20000)
        // Property cards are the actual matching results; aliases all resolve.
        for (const i of [0,1,2,3]) expect(html).toContain('href="/stay/search-place-'+i)
        expect(html).toContain('4 stays')
        expect(results).not.toContain('987654')
        expect(html).not.toContain('876543')
        expect(html).toContain('value="Vagamon, Kerala" selected')
      }
      const unknown = await (await f.app.request('http://localhost/search?destination=NoSuchPlace',{},f.env)).text()
      expect(unknown).toContain('0 stays')
      const blank = await (await f.app.request('http://localhost/api/public/destinations?q=',{},f.env)).json() as string[]
      expect(blank).toEqual(['Munnar, Kerala','Vagamon, Kerala'])
    } finally { f.db.close() }
  })

  it('keeps date, guest and Find My Stay controls with an accessible editable destination', async () => {
    const f = fixture()
    try {
      const html = await (await f.app.request('http://localhost/',{},f.env)).text()
      const hero = html.slice(html.indexOf('<section class="hero'),html.indexOf('<section class="wrap section popular-stays'))
      expect(hero).toContain('role="combobox"'); expect(hero).toContain('role="listbox"')
      expect(hero).toContain('name="destination" type="text"')
      expect(hero).not.toContain('<select')
      for (const name of ['checkIn','checkOut','guests','children']) expect(hero).toContain('name="'+name+'"')
      expect(hero).toContain('Find My Stay'); expect(hero).toContain('action="/search"')
    } finally { f.db.close() }
  })
})

// @ts-expect-error Local browser event fixture.
import { runInNewContext } from 'node:vm'
function combobox() {
  const callbacks: Record<string, (event?: any) => void> = {}, requests: any[] = [], timers = new Map<number,()=>void>(); let nextTimer = 0
  const attrs: Record<string,string> = {}, status = {textContent:''}
  const form = {addEventListener: (name:string, fn:any)=>callbacks['form:'+name]=fn}
  const input:any = {value:'',setAttribute:(k:string,v:string)=>attrs[k]=v,removeAttribute:(k:string)=>delete attrs[k],addEventListener:(k:string,v:any)=>callbacks[k]=v,focus(){document.activeElement=input},dispatchEvent(){}}
  const list:any = {hidden:true,children:[],replaceChildren(){this.children=[]},appendChild(n:any){this.children.push(n)}}
  const root = {querySelector:(q:string)=>q==='input'?input:q.includes('listbox')?list:status,contains:(n:any)=>n===input||list.children.includes(n),closest:()=>form}
  const document:any = {activeElement:input,querySelector:()=>root,addEventListener:(k:string,v:any)=>callbacks['document:'+k]=v,createElement:()=>({attrs:{} as Record<string,string>,events:{} as Record<string,any>,setAttribute(k:string,v:string){this.attrs[k]=v},addEventListener(k:string,v:any){this.events[k]=v},scrollIntoView(){}})}
  const script = readFileSync('public/app.js','utf8').split('// Homepage destination combobox:')[1].split('// End homepage destination combobox.')[0].split('\n').slice(1).join('\n')
  runInNewContext(script,{document,Event:class{},AbortController:class{signal={};abort(){}},setTimeout:(fn:any)=>{timers.set(++nextTimer,fn);return nextTimer},clearTimeout:(n:number)=>{timers.delete(n)},fetch:(url:string)=>new Promise(resolve=>requests.push({url,resolve}))})
  const flush=()=>{for(const [id,fn] of timers){timers.delete(id);fn()}}
  const respond=async(index:number,values:string[],ok=true)=>{requests[index].resolve({ok,json:async()=>values});await new Promise(resolve=>setTimeout(resolve,0))}
  return {input,list,status,attrs,callbacks,requests,flush,respond}
}

it('supports keyboard selection, Escape, touch/click selection and unmodified form submission',async()=>{
  const b=combobox();b.input.value='Vagmon';b.callbacks.input();b.flush()
  expect(b.requests[0].url).toContain('q=Vagmon')
  await b.respond(0,['Vagamon, Kerala'])
  expect(b.list.hidden).toBe(false);expect(b.attrs['aria-expanded']).toBe('true')
  let prevented=false;b.callbacks.keydown({key:'ArrowDown',preventDefault(){prevented=true}})
  expect(prevented).toBe(true);expect(b.attrs['aria-activedescendant']).toBe('destination-option-0')
  b.callbacks.keydown({key:'Enter',preventDefault(){}})
  expect(b.input.value).toBe('Vagamon, Kerala');expect(b.list.hidden).toBe(true)
  b.callbacks.focus();b.flush();await b.respond(1,['Munnar, Kerala'])
  b.list.children[0].events.pointerdown({preventDefault(){}});b.list.children[0].events.click()
  expect(b.input.value).toBe('Munnar, Kerala');expect(b.list.hidden).toBe(true)
  b.callbacks.focus();b.flush();await b.respond(2,['Munnar, Kerala']);b.callbacks.keydown({key:'Escape'})
  expect(b.attrs['aria-expanded']).toBe('false')
  b.callbacks['form:submit']();expect(b.input.value).toBe('Munnar, Kerala')
})

it('ignores out-of-order responses, handles no matches and permits typed search after suggestion failures',async()=>{
  const b=combobox();b.input.value='Vag';b.callbacks.input();b.flush()
  b.input.value='Mun';b.callbacks.input();b.flush()
  await b.respond(1,['Munnar, Kerala']);await b.respond(0,['Vagamon, Kerala'])
  expect(b.list.children[0].textContent).toBe('Munnar, Kerala')
  b.input.value='unknown';b.callbacks.input();b.flush();await b.respond(2,[])
  expect(b.status.textContent).toBe('No matching destinations.')
  b.callbacks.focus();b.flush();await b.respond(3,[],false)
  expect(b.status.textContent).toContain('You can still type');expect(b.input.value).toBe('unknown')
})
