// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local Node client-handler fixture.
import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'

function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const env:any={DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const user=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes)
  const id=Number(db.prepare("INSERT INTO properties(slug,name,type,destination) VALUES ('activity-test','Activity test','resort','Munnar')").run().lastInsertRowid)
  return {db,env,app,id}
}

function activityUi(fetch:Function){
  const events=(o:any)=>Object.assign(o,{listeners:{} as Record<string,Function>,addEventListener(k:string,f:Function){this.listeners[k]=f},async fire(k:string,event:any={}){await this.listeners[k]?.(event)}})
  const row=(options:any[])=>{const r:any={select:{options:options.map(o=>({...o})),value:'',focused:false,add(o:any){this.options.push(o)},focus(){this.focused=true}},cloneNode(){return row(this.select.options)},remove(){acts.children=acts.children.filter((x:any)=>x!==r)}};return r}
  const blank=row([{value:'',text:'Select activity'},{value:'Plantation Tour',text:'Plantation Tour'}])
  const acts:any=events({children:[],appendChild(r:any){this.children.push(r)},get lastElementChild(){return this.children.at(-1)}})
  const add=events({}),master=events({disabled:false}),template={content:{firstElementChild:blank}}
  let name='Bonfire with Music';const calls:any[]=[],errors:string[]=[]
  const source=readFileSync('public/app.js','utf8') as string
  runInNewContext(source.slice(source.indexOf('  var acts ='),source.indexOf('  var contacts =')),{
    $:(s:string,r:any)=>s==='[data-acts]'?acts:s==='[data-add-activity]'?add:s==='[data-new-activity]'?master:r.select,
    $$:(_s:string,r:any)=>r===acts?acts.children.map((x:any)=>x.select):[blank.select],document:{getElementById(){return template}},prompt:()=>name,alert:(e:string)=>errors.push(e),FormData,
    Option:function(this:any,text:string,value:string){this.text=text;this.value=value},fetch:async(...args:any[])=>{calls.push(args);return fetch(...args)},
  })
  return {acts,add,master,blank,calls,errors,setName(v:string){name=v}}
}

describe('distinct wizard activity actions',()=>{
  it('creates reusable names separately from rows, deduplicates names, saves charges and restores legacy rows',async()=>{
    const f=fixture()
    try{
      const original=JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' WHERE '+(t==='properties'?'id':'property_id')+' IS NOT ? ORDER BY id').all(f.id)))
      const get=async()=> (await f.app.request(`http://localhost/admin/properties/${f.id}/setup/4`,{},f.env)).text()
      const html=await get()
      expect(html).toContain('Add New Activity');expect(html).toContain('Add Another Activity')
      expect(html.slice(html.indexOf('<tbody data-acts>'),html.indexOf('</tbody>'))).not.toContain('<tr>')
      const ui=activityUi((url:string,args:any)=>f.app.request('http://localhost'+url,args,f.env))
      await ui.master.fire('click')
      expect(ui.acts.children).toHaveLength(0)
      expect(ui.blank.select.options.some((o:any)=>o.value==='Bonfire with Music')).toBe(true)
      ui.setName('  bonfire with music  ');await ui.master.fire('click')
      expect(f.db.prepare("SELECT * FROM taxonomy WHERE kind='activity' AND lower(label)='bonfire with music'").all()).toHaveLength(1)
      expect(ui.blank.select.options.filter((o:any)=>o.value.toLowerCase()==='bonfire with music')).toHaveLength(1)
      const masterCount=(f.db.prepare("SELECT count(*) n FROM taxonomy WHERE kind='activity'").get() as any).n
      await ui.add.fire('click');await ui.add.fire('click');await ui.add.fire('click')
      expect(ui.acts.children).toHaveLength(3)
      expect(ui.calls).toHaveLength(2)
      expect((f.db.prepare("SELECT count(*) n FROM taxonomy WHERE kind='activity'").get() as any).n).toBe(masterCount)
      expect(ui.acts.children[0].select.options.some((o:any)=>o.value==='Bonfire with Music')).toBe(true)
      // Saved legacy names need not become new master items.
      f.db.prepare('UPDATE properties SET addons=? WHERE id=?').run('[{"name":"Legacy private activity","price":700,"net":500,"per":"person","complimentary":false}]',f.id)
      expect(await get()).toContain('value="Legacy private activity" selected')
      const save=async(names:string[],free:string[],amounts:string[])=>{
        const body=new URLSearchParams({child_bed:'',child_nobed:'',child_free:'',extra_adult:''})
        for(const [key,values] of [['act_name',names],['act_free',free],['act_amt',amounts]] as [string,string[]][]) values.forEach(v=>body.append(key,v))
        return f.app.request(`http://localhost/admin/properties/${f.id}/setup/4`,{method:'POST',body},f.env)
      }
      expect((await save(['Plantation Tour','Bonfire with Music','Legacy private activity'],['1','0','0'],['','1200','700'])).status).toBe(303)
      const stored=()=>JSON.parse((f.db.prepare('SELECT addons FROM properties WHERE id=?').get(f.id) as any).addons)
      expect(stored()).toEqual([{name:'Plantation Tour',price:0,net:null,per:'stay',complimentary:true},{name:'Bonfire with Music',price:1200,net:null,per:'stay',complimentary:false},{name:'Legacy private activity',price:700,net:500,per:'person',complimentary:false}])
      const restored=await get()
      expect(restored).toContain('value="Plantation Tour" selected');expect(restored).toContain('value="Bonfire with Music" selected');expect(restored).toContain('value="1200"')
      await save(['Plantation Tour','Bonfire with Music','Legacy private activity'],['1','0','0'],['','1200','700'])
      expect(stored()).toHaveLength(3)
      const removed=ui.acts.children[0]
      await ui.acts.fire('click',{target:{closest(){return {closest(){return removed}}}}})
      expect(ui.acts.children).toHaveLength(2)
      await save(['Plantation Tour','Legacy private activity'],['1','0'],['','700'])
      expect(stored()).toHaveLength(2)
      expect(f.db.prepare("SELECT * FROM taxonomy WHERE kind='activity' AND lower(label)='bonfire with music'").all()).toHaveLength(1)
      const future=Number(f.db.prepare("INSERT INTO properties(slug,name,type,destination) VALUES ('future-activity-test','Future activity test','resort','Munnar')").run().lastInsertRowid)
      expect(await (await f.app.request(`http://localhost/admin/properties/${future}/setup/4`,{},f.env)).text()).toContain('Bonfire with Music')
      f.db.prepare('DELETE FROM properties WHERE id=?').run(future)
      expect(JSON.stringify(['properties','rooms','season_rates'].map(t=>f.db.prepare('SELECT * FROM '+t+' WHERE '+(t==='properties'?'id':'property_id')+' IS NOT ? ORDER BY id').all(f.id)))).toBe(original)
    }finally{f.db.close()}
  })
  it('does not add an option or row when master creation fails',async()=>{
    const ui=activityUi(async()=>new Response(JSON.stringify({error:'Unable to save activity.'}),{status:500}))
    await ui.master.fire('click')
    expect(ui.errors).toEqual(['Unable to save activity.'])
    expect(ui.acts.children).toHaveLength(0)
    expect(ui.blank.select.options).toHaveLength(2)
    expect(ui.master.disabled).toBe(false)
  })
})
