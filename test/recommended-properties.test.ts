// @ts-expect-error Local SQLite fixture only.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local browser-controller fixture only.
import { runInNewContext } from 'node:vm'
// @ts-expect-error Local filesystem fixture only.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { describe, expect, it } from 'vitest'
import { admin2Routes } from '../src/routes/admin2'
import { publicRoutes } from '../src/routes/public'
import { recommendedIds, recommendedState, saveRecommended } from '../src/lib/recommended'

const path='/admin/recommended-properties'
function fixture() {
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const admin=Number(db.prepare("INSERT INTO users(name,email,role) VALUES('Admin','recommendations@example.test','admin')").run().lastInsertRowid)
  const ids=Array.from({length:8},(_,i)=>{
    const id=Number(db.prepare("INSERT INTO properties(name,slug,destination,type,status) VALUES(?,?,?,'resort','live')").run('Recommended Stay '+i,'recommended-stay-'+i,i===0?'Munnar':'Vagamon').lastInsertRowid)
    db.prepare('INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate) VALUES(?,?,?,?,?)').run(id,'Room',4000+i*100,987654,876543)
    return id
  })
  const kv=new Map<string,string>()
  const DB:any={prepare(sql:string){let values:any[]=[];const st={bind(...args:any[]){values=args;return st},async all(){return {results:db.prepare(sql).all(...values)}},async first(){return db.prepare(sql).get(...values)??null},async run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const env:any={DB,KV:{async get(k:string,type?:string){const v=kv.get(k);return v?type==='json'?JSON.parse(v):v:null},async put(k:string,v:string){kv.set(k,v)},async delete(k:string){kv.delete(k)}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  let user:any={id:admin,role:'admin',name:'Admin',language:'en'}
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).use('*',csrf()).route('/',admin2Routes).route('/',publicRoutes)
  const read=()=>db.prepare("SELECT value FROM content WHERE key='recommended_property_ids'").get() as any
  const idsNow=()=>JSON.parse(read()?.value??'[]') as number[]
  const post=(action:string,id:number,revision=read()?.value??'')=>app.request('http://localhost'+path,{method:'POST',headers:{Origin:'http://localhost'},body:new URLSearchParams({action,property_id:String(id),revision})},env)
  const home=async()=>await(await app.request('http://localhost/',{},env)).text()
  return {db,env,app,kv,ids,post,home,read,idsNow,as(u:any){user=u}}
}
const location=(r:Response)=>decodeURIComponent(r.headers.get('location')??'').replaceAll('+',' ')
function section(html:string){const at=html.indexOf('<section class="wrap section popular-stays recommended-properties"');return at<0?'':html.slice(at,html.indexOf('</section>',at))}
describe('Admin-managed homepage recommendations',()=>{
  it('defaults to hidden, without changing Popular Stays or creating content records',async()=>{
    const f=fixture();try{const html=await f.home();expect(section(html)).toBe('');expect(html).toContain('popular-stays');expect(f.read()).toBeUndefined()}finally{f.db.close()}
  })
  it.each([1,6])('renders %s selected Live properties in saved order immediately after Popular Stays',async n=>{
    const f=fixture();try{
      for(const id of f.ids.slice(0,n).reverse()) expect(location(await f.post('add',id))).toContain('saved')
      const html=await f.home(),block=section(html)
      expect(block.match(/class="card pcard"/g)).toHaveLength(n)
      const popularEnd=html.indexOf('</section>',html.indexOf('<section class="wrap section popular-stays">'))+10
      expect(html.slice(popularEnd).trimStart()).toMatch(/^<section class="wrap section popular-stays recommended-properties"/)
      expect(block).toContain('Recommended <span>Properties</span>')
      expect(block).toContain('data-stay-preview');expect(block).toContain('recommended-track');expect(block).toContain('tabindex="0"')
      expect(block).toContain('/stay/recommended-stay-');expect(block).toContain('₹4,')
      expect(block).not.toMatch(/987654|876543|9,87,654|8,76,543|staff_rate|net_rate/)
      const order=f.idsNow().map(id=>block.indexOf('/stay/recommended-stay-'+f.ids.indexOf(id)))
      expect(order).toEqual([...order].sort((a,b)=>a-b))
      expect(block.includes('Previous recommended properties')).toBe(n>1)
    }finally{f.db.close()}
  })
  it('supports search, adding, moving, removing and reopening with correct audit and cache invalidation',async()=>{
    const f=fixture();try{
      await f.home();expect(f.kv.has('cache:content:v1')).toBe(true)
      await f.post('add',f.ids[0]);expect(f.kv.has('cache:content:v1')).toBe(false)
      await f.post('add',f.ids[1]);await f.post('up',f.ids[1]);expect(f.idsNow()).toEqual([f.ids[1],f.ids[0]])
      await f.post('down',f.ids[1]);expect(f.idsNow()).toEqual(f.ids.slice(0,2))
      const page=await(await f.app.request('http://localhost'+path+'?q=MUNNAR',{},f.env)).text()
      expect(page).toContain('value="MUNNAR"');expect(page).toContain('Selected properties (2/6)');expect(page).toContain('name="revision"')
      const candidates=page.slice(page.indexOf('<ul class="recommended-candidates">'))
      expect(candidates).toContain('Recommended Stay 0');expect(candidates).not.toContain('Recommended Stay 1')
      await f.post('remove',f.ids[0]);expect(f.idsNow()).toEqual([f.ids[1]])
      expect((await recommendedState(f.env)).ids).toEqual([f.ids[1]])
      await f.post('remove',f.ids[1]);expect(section(await f.home())).toBe('')
      expect((f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='recommendations.updated'").get() as any).n).toBe(6)
    }finally{f.db.close()}
  })
  it('rejects duplicates, seventh property, invalid action/id and boundary moves',async()=>{
    const f=fixture();try{
      await f.post('add',f.ids[0]);expect(location(await f.post('add',f.ids[0]))).toContain('already selected')
      expect(location(await f.post('up',f.ids[0]))).toContain('cannot move')
      for(const id of f.ids.slice(1,6))await f.post('add',id)
      expect(location(await f.post('add',f.ids[6]))).toContain('no more than 6')
      expect(location(await f.post('invalid',f.ids[0]))).toContain('Invalid recommendation action')
      expect(location(await f.post('add',NaN))).toContain('valid property')
      expect(f.idsNow()).toEqual(f.ids.slice(0,6))
    }finally{f.db.close()}
  })
  it.each(['draft','hidden'])('rejects non-public %s properties even by direct POST',async status=>{
    const f=fixture();try{
      f.db.prepare('UPDATE properties SET status=? WHERE id=?').run(status,f.ids[0])
      expect(location(await f.post('add',f.ids[0]))).toContain('visibility changed')
      expect(f.read()).toBeUndefined()
    }finally{f.db.close()}
  })
  it('rejects a deleted or missing property ID',async()=>{
    const f=fixture();try{expect(location(await f.post('add',999999))).toContain('visibility changed');expect(f.read()).toBeUndefined()}finally{f.db.close()}
  })
  it('escapes search wildcards and does not let SQL-like search text alter selection',async()=>{
    const f=fixture();try{
      const response=await f.app.request('http://localhost'+path+'?q='+encodeURIComponent("%' OR 1=1 --"),{},f.env)
      expect(response.status).toBe(200);const html=await response.text();expect(html).toContain('No matching Live properties.');expect(f.read()).toBeUndefined()
    }finally{f.db.close()}
  })
  it('immediately omits newly hidden properties and allows cleanup of multiple unavailable selections',async()=>{
    const f=fixture();try{
      for(const id of f.ids.slice(0,3))await f.post('add',id)
      await f.home()
      f.db.prepare("UPDATE properties SET status='hidden' WHERE id IN (?,?)").run(f.ids[0],f.ids[1])
      const block=section(await f.home());expect(block).not.toContain('Recommended Stay 0');expect(block).not.toContain('Recommended Stay 1');expect(block).toContain('Recommended Stay 2')
      await f.post('remove',f.ids[0]);expect(f.idsNow()).toEqual([f.ids[2]])
    }finally{f.db.close()}
  })
  it('rejects stale requests and concurrent compare-and-set writes without losing a selection',async()=>{
    const f=fixture();try{
      await f.post('add',f.ids[0]);expect(location(await f.post('add',f.ids[1],''))).toContain('another session')
      const rev=f.read().value
      const writes=await Promise.all([saveRecommended(f.env,[f.ids[0],f.ids[1]],rev),saveRecommended(f.env,[f.ids[0],f.ids[2]],rev)])
      expect(writes.filter(Boolean)).toHaveLength(1);expect(f.idsNow()).toHaveLength(2)
      expect(await saveRecommended(f.env,[f.ids[0],f.ids[0]],f.read().value)).toBe(false)
    }finally{f.db.close()}
  })
  it.each(['sales','manager','accounts','guest'])('denies %s management even with direct access',async role=>{
    const f=fixture();try{f.as({id:1,role,name:'Not Admin'});expect((await f.app.request('http://localhost'+path,{},f.env)).status).toBe(403);expect((await f.post('add',f.ids[0])).status).toBe(403);expect(f.read()).toBeUndefined()}finally{f.db.close()}
  })
  it('requires login and rejects cross-origin mutation',async()=>{
    const f=fixture();try{
      expect((await f.app.request('http://localhost'+path,{method:'POST',headers:{Origin:'https://evil.test'},body:new URLSearchParams({action:'add',property_id:String(f.ids[0]),revision:''})},f.env)).status).toBe(403)
      f.as(null);expect((await f.app.request('http://localhost'+path,{},f.env)).status).toBe(302)
      expect(f.read()).toBeUndefined()
    }finally{f.db.close()}
  })
  it('shows Admin management navigation and leaves property, rate, booking and quotation records unchanged',async()=>{
    const f=fixture();try{
      const snapshot=()=>JSON.stringify(['properties','rooms','season_rates','quotations','bookings'].map(table=>f.db.prepare('SELECT * FROM '+table+' ORDER BY id').all()))
      const before=snapshot();await f.post('add',f.ids[0]);await f.post('add',f.ids[1]);await f.post('up',f.ids[1]);await f.post('remove',f.ids[0]);await f.home()
      const html=await(await f.app.request('http://localhost'+path,{},f.env)).text();expect(html).toContain('href="/admin/recommended-properties"');expect(html).toContain('aria-label="Move Recommended Stay 1 up"')
      expect(snapshot()).toBe(before)
    }finally{f.db.close()}
  })
  it('keeps Popular and Recommended carousel controls independent and reuses responsive card styles',()=>{
    const script=readFileSync('public/app.js','utf8') as string
    const line=script.split('\n').find(line=>line.includes("document.querySelectorAll('[data-carousel]')"))!
    const moves:number[][]=[[],[]]
    const buttons=[0,1].map(index=>({dataset:{carousel:'1'},parentElement:{querySelector:()=>({clientWidth:300,scrollBy:({left}:{left:number})=>moves[index].push(left)})},listener:()=>{},addEventListener(_:string,fn:()=>void){this.listener=fn}}))
    runInNewContext(line,{document:{querySelectorAll:()=>buttons},Number})
    buttons[1].listener();expect(moves).toEqual([[],[300]])
    buttons[0].listener();expect(moves).toEqual([[300],[300]])
    const css=readFileSync('public/app.css','utf8') as string
    expect(css).toContain('.stay-carousel .pcard { flex-basis:85%')
    expect(css).toContain('.recommended-search { flex-wrap:wrap; }')
  })
  it('sanitizes malformed saved selection values without duplicates or invalid IDs',()=>{
    expect(recommendedIds([1,1,'2',null,-2,0,3,4,5,6,7,8])).toEqual([1,3,4,5,6,7])
    expect(recommendedIds({})).toEqual([])
  })
})
