// @ts-expect-error Node-only local SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Node-only local filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { calculatePrice, nightlyRate, staffRateForStay, netRateForStay, type SeasonRate } from '../src/lib/pricing'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { publicRoutes } from '../src/routes/public'
import { opsRoutes } from '../src/routes/staff-ops'
import { searchProperties } from '../src/lib/properties'
import { loadPricing } from '../src/lib/db'

const key = '11111111-1111-4111-8111-111111111111', key2 = '22222222-2222-4222-8222-222222222222'
const room = { id: 1, property_id: 10, base_rate: 7000, staff_rate: 5000, net_rate: 4000, weekend_rate: null, capacity: 2, units: 10, min_nights: 1 }
const peak = (k=key, from='2026-12-20', to='2027-01-05', amount=1000): SeasonRate => ({property_id:10,room_id:null,name:'Peak',start_date:from,end_date:to,rate:null,pct_adjust:null,min_nights:null,kind:'special',source:'wizard-common:'+k,supplement:amount,net_supplement:600})

describe('shared common peak resolution',()=>{
  it('applies across categories, partial overlaps, multiple rooms/nights and excludes check-out',()=>{
    for(const id of [1,2]) {
      const result=calculatePrice({room:{...room,id},seasons:[peak()],checkIn:'2026-12-19',checkOut:'2026-12-23',roomsCount:2})
      expect(result.roomCharges).toBe(7000*2*4+6000)
      expect(result.lines.map(l=>l.rate)).toEqual([7000,8000,8000,8000])
    }
    expect(calculatePrice({room,seasons:[peak()],checkIn:'2026-12-19',checkOut:'2026-12-20'}).roomCharges).toBe(7000)
    expect(nightlyRate(room,[peak()],'2027-01-05').rate).toBe(8000)
    expect(nightlyRate(room,[peak()],'2027-01-06').rate).toBe(7000)
  })
  it('keeps distinct common periods even with the same description and replaces only the linked common',()=>{
    const peaks=[peak(),peak(key2,'2026-12-22','2026-12-24',2000)]
    const override={...peak(),room_id:1,source:'wizard-override:'+key,name:'Different exception description',supplement:300,net_supplement:100}
    expect(nightlyRate(room,peaks,'2026-12-22').rate).toBe(10000)
    expect(nightlyRate(room,[...peaks,override],'2026-12-22').rate).toBe(9300)
    expect(nightlyRate({...room,id:2},[...peaks,override],'2026-12-22').rate).toBe(10000)
    expect(staffRateForStay(room,[...peaks,override],'2026-12-22','2026-12-23')).toBe(7300)
    expect(netRateForStay(room,[...peaks,override],'2026-12-22','2026-12-23')).toBe(4700)
    expect(nightlyRate(room,[{...override,supplement:0} ,peak()],'2026-12-22').rate).toBe(7000)
  })
  it('preserves legacy name-based precedence and never charges an orphan or cross-property override',()=>{
    const legacy={...peak(),source:'wizard'}, exception={...peak(),source:null,room_id:1,supplement:500}
    expect(nightlyRate(room,[legacy,exception],'2026-12-22').rate).toBe(7500)
    expect(nightlyRate(room,[{...exception,source:'wizard-override:'+key}],'2026-12-22').rate).toBe(7000)
    expect(nightlyRate(room,[peak(),{...exception,property_id:99,source:'wizard-override:'+key}],'2026-12-22').rate).toBe(8000)
  })
})

function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const user=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const id=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,status) VALUES('common-peak-test','Common peak test','resort','Munnar','live')").run().lastInsertRowid)
  const rooms=['Room A','Room B'].map(name=>Number(db.prepare('INSERT INTO rooms(property_id,name,base_rate,staff_rate,net_rate) VALUES(?,?,7000,5432,4321)').run(id,name).lastInsertRowid))
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st},async batch(stmts:any[]){db.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}}
  const env:any={DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes)
  const save=(body:URLSearchParams)=>app.request(`http://localhost/admin/properties/${id}/setup/3`,{method:'POST',body},env)
  const rows=()=>db.prepare('SELECT * FROM season_rates WHERE property_id=? ORDER BY id').all(id) as any[]
  return {db,env,app,id,rooms,save,rows}
}
function commonForm(k=key){return new URLSearchParams({common_managed_id:'',common_managed_key:k,common_managed_from:'2026-12-20',common_managed_to:'2027-01-05',common_managed_amt:'1000',common_managed_desc:'Christmas & New Year Peak',common_managed_remove:'0'})}

describe('Step 3 scoped persistence',()=>{
  it('saves/reopens common and override rows, keeps their IDs on repeat saves and exposes only public pricing',async()=>{
    const f=fixture();try{
      const body=commonForm();for(const [k,v] of Object.entries({id:'',key,amt:'300',desc:'Room exception',remove:'0'}))body.append(`r${f.rooms[0]}_managed_${k}`,v)
      expect((await f.save(body)).headers.get('location')).toContain('/setup/4')
      const rows=f.rows();expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({room_id:null,kind:'special',supplement:1000,net_supplement:null,source:'wizard-common:'+key})
      expect(rows[1]).toMatchObject({room_id:f.rooms[0],supplement:300,start_date:'2026-12-20',end_date:'2027-01-05',source:'wizard-override:'+key})
      await f.save(body);expect(f.rows()).toEqual(rows)
      const html=await(await f.app.request(`http://localhost/admin/properties/${f.id}/setup/3`,{},f.env)).text()
      expect(html).not.toContain('Common Peak Time Charges'); expect(html).not.toContain('Room-specific Peak Override'); expect(html).not.toContain('Existing room-specific Peak Time Charges'); expect(html.match(/<h3>Peak Time Charges<\/h3>/g)).toHaveLength(1)
      expect(html).toContain(`name="common_managed_id" value="${rows[0].id}"`)
      expect(html).toContain('data-shared-peak-section')
      for(const rid of f.rooms){const loaded=await loadPricing(f.env,rid);expect(calculatePrice({...loaded!,checkIn:'2026-12-20',checkOut:'2026-12-23',roomsCount:2}).roomCharges).toBe((8750+(rid===f.rooms[0]?300:1000))*6)}
      const publicApp=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',publicRoutes)
      const response=await publicApp.request('http://localhost/stay/common-peak-test/price',{method:'POST',body:new URLSearchParams({room:String(f.rooms[0]),checkIn:'2026-12-20',checkOut:'2026-12-23',rooms:'2',adults:'2',children:'0'})},f.env)
      expect(response.status).toBe(200); const result=await response.json() as any; expect(result.roomCharges).toBe(54300); const json=JSON.stringify(result);expect(json).not.toMatch(/staff_rate|net_rate|net_supplement|5432|4321/)
    }finally{f.db.close()}
  })
  it('preserves unrelated/common/other-room/legacy rows and valid matrices during a partial save',async()=>{
    const f=fixture();try{
      await f.save(commonForm())
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,supplement,kind,source) VALUES(?,?,'Legacy peak','2026-12-20','2027-01-05',650,'special','wizard')").run(f.id,f.rooms[1])
      f.db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,rate,kind,meal_plan,source) VALUES(?,?,'Off season','2026-01-01','2026-12-31',8000,'off_season','CP','wizard')").run(f.id,f.rooms[1])
      const before=JSON.stringify(f.db.prepare('SELECT * FROM season_rates ORDER BY id').all())
      const body=new URLSearchParams({[`r${f.rooms[0]}_off_from`]:'2026-01-01',[`r${f.rooms[0]}_off_to`]:'2026-12-31',[`r${f.rooms[0]}_off_wk_CP_direct`]:'9000'})
      await f.save(body)
      expect(JSON.stringify(f.db.prepare('SELECT * FROM season_rates WHERE room_id IS NOT ? ORDER BY id').all(f.rooms[0]))).toBe(before)
      const saved=f.rows();await f.save(new URLSearchParams());expect(f.rows()).toEqual(saved)
    }finally{f.db.close()}
  })
  it('updates linked dates, rejects duplicate/cross-property associations and removes only explicit managed rows',async()=>{
    const f=fixture();try{
      const body=commonForm();for(const [k,v] of Object.entries({id:'',key,amt:'300',desc:'Exception',remove:'0'}))body.append(`r${f.rooms[0]}_managed_${k}`,v)
      await f.save(body);const rows=f.rows()
      const edit=commonForm();edit.set('common_managed_id',String(rows[0].id));edit.set('common_managed_from','2026-12-22');await f.save(edit)
      expect(f.rows()[1].start_date).toBe('2026-12-22')
      const invalid=new URLSearchParams({[`r${f.rooms[0]}_managed_id`]:'', [`r${f.rooms[0]}_managed_key`]:key2,[`r${f.rooms[0]}_managed_amt`]:'400'})
      const duplicate=commonForm();duplicate.set('common_managed_id',String(rows[0].id))
      for(let i=0;i<2;i++)for(const [k,v] of Object.entries({id:'',key,amt:'400',desc:'Duplicate',remove:'0'}))duplicate.append(`r${f.rooms[0]}_managed_${k}`,v)
      const unchanged=f.rows();expect((await f.save(duplicate)).headers.get('location')).toContain('err=');expect(f.rows()).toEqual(unchanged)
      const before=f.rows();expect((await f.save(invalid)).headers.get('location')).toContain('err=');expect(f.rows()).toEqual(before)
      edit.set('common_managed_remove','1');await f.save(edit);expect(f.rows()).toEqual([])
    }finally{f.db.close()}
  })
})

// @ts-expect-error Node VM executes the shipped room and shared-peak browser handlers.
import { runInNewContext } from 'node:vm'
function draftUI(storage:Map<string,string>, saved:Record<string,string>={}) {
  const events=(node:any)=>Object.assign(node,{listeners:{} as Record<string,Function[]>,addEventListener(k:string,f:Function){(this.listeners[k]??=[]).push(f)},fire(k:string,e:any={}){for(const f of this.listeners[k]??[])f(e)}})
  const row=():any=>{const node:any={hidden:false,inputs:[]};for(const suffix of ['id','remove','key','from','to','amt','desc']){const name='common_managed_'+suffix,value=saved[name]??(suffix==='remove'?'0':'');node.inputs.push({name,value,defaultValue:value,closest(){return section}})}node.cloneNode=()=>{const clone=row();node.inputs.forEach((c:any,i:number)=>Object.assign(clone.inputs[i],{value:c.value,defaultValue:c.defaultValue}));return clone};return node}
  const form=events({dataset:{ratesDraft:'1'},getAttribute(){return '/admin/properties/99/setup/3'}}),window=events({})
  const section:any=events({parent:null})
  const entries:any={children:[row()],get firstElementChild(){return this.children[0]},appendChild(r:any){this.children.push(r)},replaceChildren(...r:any[]){this.children=r}}
  const box=events({entries,closest(s:string){return s==='form'?form:section}})
  const panels=[101,102,103].map(id=>({dataset:{rateRoom:String(id)},hidden:false}))
  const slots=panels.map(panel=>({appendChild(editor:any){editor.parent=panel}}))
  const statuses=panels.map(()=>({textContent:''}))
  const buttons=panels.map(panel=>events({dataset:{viewRateRoom:panel.dataset.rateRoom}}))
  const next=events({}),select:any=events({options:panels.map(p=>({value:p.dataset.rateRoom})),selectedIndex:0,closest(){return form},scrollIntoView(){}})
  Object.defineProperty(select,'value',{get(){return this.options[this.selectedIndex].value},set(v){this.selectedIndex=this.options.findIndex((o:any)=>o.value===v)}})
  const all=(s:string,root:any):any[]=>s==='[data-rate-room]'?panels:s==='[data-view-rate-room]'?buttons:s==='[data-peak-entry]'?entries.children:s==='input[name]'?root.inputs:s==='input'||s==='input[type="number"]'?[]:[]
  const one=(s:string,root:any)=>s==='[data-room-select]'?select:s==='[data-next-room]'?next:s==='[data-shared-peak-section]'?section:s==='[data-managed-peaks="common"]'?box:s==='[data-peak-entries]'?entries:s.startsWith('[data-peak-slot=')?slots[panels.findIndex(p=>s===`[data-peak-slot="${p.dataset.rateRoom}"]`)]:s.startsWith('[data-rate-status=')?statuses[panels.findIndex(p=>s===`[data-rate-status="${p.dataset.rateRoom}"]`)]:root?.inputs?.find((i:any)=>s===`input[name="${i.name}"]`)
  const source=readFileSync('public/app.js','utf8') as string
  runInNewContext(source.slice(source.indexOf('  var roomSel ='),source.indexOf('  function cloneClean(')),{$:one,$$:all,window,crypto,alert(){},sessionStorage:{getItem(k:string){return storage.get(k)},setItem(k:string,v:string){storage.set(k,v)},removeItem(k:string){storage.delete(k)}}})
  const set=(name:string,value:string,index=0)=>{entries.children[index].inputs.find((i:any)=>i.name===name).value=value;box.fire('input')}
  const add=()=>section.fire('click',{target:{closest(s:string){return s==='[data-add-managed-peak]'?{}:null}}})
  const remove=(index:number)=>section.fire('click',{target:{closest(s:string){return s==='[data-remove-managed-peak]'?{closest(){return entries.children[index]}}:null}}})
  return {form,window,entries,section,set,add,remove,next,view(index:number){buttons[index].fire('click')},switchRoom(index:number){select.value=panels[index].dataset.rateRoom;select.fire('change')},value(name:string,index=0){return entries.children[index].inputs.find((i:any)=>i.name===name).value}}
}

describe('shared peaks in the original Room Rates workflow',()=>{
  it.each([0,1])('enter in room %s, switch and View/Edit: every room shows the same live values',start=>{
    const ui=draftUI(new Map());ui.switchRoom(start)
    for(const [k,v] of Object.entries({from:'2026-12-20',to:'2027-01-05',amt:'1000',desc:'Xmas New-Year Hike'}))ui.set('common_managed_'+k,v)
    const editor=ui.section,association=ui.value('common_managed_key')
    for(const room of [2,0,1]){ui.switchRoom(room);expect(ui.section).toBe(editor);expect(ui.section.parent.dataset.rateRoom).toBe(String(101+room));expect(ui.value('common_managed_amt')).toBe('1000');expect(ui.value('common_managed_key')).toBe(association)}
    ui.view(0);expect(ui.section.parent.dataset.rateRoom).toBe('101');expect(ui.value('common_managed_desc')).toBe('Xmas New-Year Hike')
    ui.next.fire('click');expect(ui.section.parent.dataset.rateRoom).toBe('102');expect(ui.value('common_managed_amt')).toBe('1000')
  })
  it('shares multiple periods, edits and removals across rooms and restores drafts on Previous/Next and reopening',()=>{
    const storage=new Map<string,string>();let ui=draftUI(storage)
    for(const [k,v] of Object.entries({from:'2026-12-20',to:'2027-01-05',amt:'1000',desc:'Xmas New-Year Hike'}))ui.set('common_managed_'+k,v)
    const association=ui.value('common_managed_key')
    ui.switchRoom(1);ui.add()
    for(const [k,v] of Object.entries({from:'2026-11-05',to:'2026-11-15',amt:'500',desc:'Diwali Hike'}))ui.set('common_managed_'+k,v,1)
    ui.view(0);expect(ui.entries.children).toHaveLength(2);expect(ui.value('common_managed_amt',1)).toBe('500')
    ui.set('common_managed_amt','1200');ui.switchRoom(2);expect(ui.value('common_managed_amt')).toBe('1200')
    ui.remove(1);ui.view(1);expect(ui.entries.children[1].hidden).toBe(true)
    ui.window.fire('pagehide');ui=draftUI(storage)
    expect(ui.value('common_managed_amt')).toBe('1200');expect(ui.value('common_managed_key')).toBe(association);expect(ui.entries.children[1].hidden).toBe(true)
    ui.form.fire('submit');ui=draftUI(storage);expect(ui.value('common_managed_remove',1)).toBe('1')
    // Saved server values supersede stale drafts after Save & Continue / reopen.
    ui=draftUI(storage,{common_managed_id:'42',common_managed_key:association,common_managed_amt:'1200',common_managed_from:'2026-12-20',common_managed_to:'2027-01-05',common_managed_desc:'Xmas New-Year Hike'})
    expect(ui.value('common_managed_id')).toBe('42');expect(ui.entries.children).toHaveLength(1)
    ui.view(2);expect(ui.value('common_managed_amt')).toBe('1200')
  })
})

describe('public / Staff Finder / quotation integration and supplement privacy',()=>{
  it('uses linked peaks in search and quotes while keeping B2B supplements out of Sales and Manager HTML',async()=>{
    const f=fixture();try{
      const body=commonForm();await f.save(body)
      const common=f.rows()[0]
      f.db.prepare('UPDATE season_rates SET net_supplement=987654 WHERE id=?').run(common.id)
      const publicApp=new Hono<any>().use('*',async(c,next)=>{c.set('user',null);await next()}).route('/',publicRoutes)
      const result=await(await publicApp.request('http://localhost/stay/common-peak-test/price',{method:'POST',body:new URLSearchParams({room:String(f.rooms[0]),checkIn:'2026-12-20',checkOut:'2026-12-23',rooms:'1',adults:'2'})},f.env)).json() as any
      expect(result.roomCharges).toBe(29250);expect(JSON.stringify(result)).not.toMatch(/987654|991975|net_supplement|staff_rate|net_rate/)
      const cards=await searchProperties(f.env,{destination:'Munnar',checkIn:'2026-12-20',checkOut:'2026-12-23',guests:2},100,true)
      expect(cards.some(p=>p.id===f.id)).toBe(true)
      // Exercise the existing configurable Manager permission without changing production role defaults.
      f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('role_permissions',?)").run(JSON.stringify({manager:{view_net_rates:false}}))
      for(const role of ['sales','manager','admin']) {
        const staff=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Pricing test',role,language:'en'});await next()}).route('/',opsRoutes)
        const html=await(await staff.request('http://localhost/staff/finder?destination=Munnar&checkIn=2026-12-20&checkOut=2026-12-23&guests=2',{},f.env)).text()
        expect(html).toContain('Common peak test');expect(html).toContain('₹6,432');expect(html).toContain('₹9,750')
        if(role==='admin')expect(html).toContain('₹9,91,975')
        else {expect(html).not.toContain('9,91,975');expect(html).not.toContain('987654')}
      }
      const staff=new Hono<any>().use('*',async(c,next)=>{c.set('user',{id:1,name:'Quote test',role:'sales',language:'en'});await next()}).route('/',opsRoutes)
      const qid=Number(f.db.prepare("INSERT INTO quotations(code,token,staff_id,guest_name,valid_till) VALUES('PEAK-TEST','peak-test-token',1,'Guest','2027-01-31')").run().lastInsertRowid)
      const oid=Number(f.db.prepare("INSERT INTO quotation_options(quotation_id,property_id,room_id,check_in,check_out,adults,rooms_count) VALUES(?,?,?,'2026-12-20','2026-12-23',2,2)").run(qid,f.id,f.rooms[0]).lastInsertRowid)
      const save=new URLSearchParams({guest_name:'Guest',valid_till:'2027-01-31',opt_id:String(oid),['room_'+oid]:String(f.rooms[0]),['in_'+oid]:'2026-12-20',['out_'+oid]:'2026-12-23',['rooms_'+oid]:'2',['adults_'+oid]:'2',['children_'+oid]:'0',['extra_'+oid]:'0',['grate_'+oid]:'7500'})
      const response=await staff.request('http://localhost/staff/quotes/'+qid,{method:'POST',body:save},f.env)
      expect(response.status).toBe(303)
      const option=f.db.prepare('SELECT * FROM quotation_options WHERE id=?').get(oid) as any
      expect(option.subtotal).toBe((7500+1000)*2*3)
      const html=await(await staff.request('http://localhost/staff/quotes/'+qid,{},f.env)).text()
      expect(html).not.toContain('987654');expect(html).not.toContain('9,91,975')
    }finally{f.db.close()}
  })
})

describe('shared peak Save & Continue / reopen',()=>{
  it('stores each period once, restores one editor for every room and edits/removes without duplicate pricing',async()=>{
    const f=fixture();try{
      const unrelated=JSON.stringify(['season_rates','users','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()))
      const body=commonForm();body.set('common_managed_from','2030-12-20');body.set('common_managed_to','2031-01-05')
      for(const [k,v] of Object.entries({id:'',key:key2,from:'2030-11-05',to:'2030-11-15',amt:'500',desc:'Diwali Hike',remove:'0'}))body.append('common_managed_'+k,v)
      expect((await f.save(body)).headers.get('location')).toContain('/setup/4')
      const initial=f.rows();expect(initial).toHaveLength(2);expect(initial.every(r=>r.room_id===null)).toBe(true)
      await f.save(body);expect(f.rows()).toEqual(initial)
      for(const [index,row] of initial.entries()) {
        const values=body.getAll('common_managed_id');values[index]=String(row.id);body.delete('common_managed_id');values.forEach(v=>body.append('common_managed_id',v))
      }
      const html=await(await f.app.request(`http://localhost/admin/properties/${f.id}/setup/3`,{},f.env)).text()
      expect(html.match(/data-shared-peak-section/g)).toHaveLength(1)
      for(const rid of f.rooms)expect(html).toContain(`data-peak-slot="${rid}"`)
      expect(html).toContain('name="common_managed_amt" value="1000"');expect(html).toContain('name="common_managed_amt" value="500"')
      const amounts=body.getAll('common_managed_amt');amounts[0]='1200';body.delete('common_managed_amt');amounts.forEach(v=>body.append('common_managed_amt',v));await f.save(body)
      for(const rid of f.rooms){const loaded=await loadPricing(f.env,rid);expect(calculatePrice({...loaded!,checkIn:'2030-12-20',checkOut:'2030-12-23',roomsCount:2}).roomCharges).toBe((7000+1200)*6);expect(calculatePrice({...loaded!,checkIn:'2030-11-05',checkOut:'2030-11-08',roomsCount:2}).roomCharges).toBe((7000+500)*6)}
      body.delete('common_managed_remove');body.append('common_managed_remove','1');body.append('common_managed_remove','0');await f.save(body)
      expect(f.rows()).toHaveLength(1);expect(f.rows()[0].id).toBe(initial[1].id)
      for(const rid of f.rooms){const loaded=await loadPricing(f.env,rid);expect(calculatePrice({...loaded!,checkIn:'2030-12-20',checkOut:'2030-12-23',roomsCount:2}).roomCharges).toBe(7000*6)}
      expect(JSON.stringify(['season_rates','users','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+(t==='season_rates'?' WHERE property_id IS NOT ?':'')+' ORDER BY id').all(...(t==='season_rates'?[f.id]:[]))))).toBe(unrelated)
    }finally{f.db.close()}
  })
})
