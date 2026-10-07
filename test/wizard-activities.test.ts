// @ts-expect-error Local Node SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local Node filesystem fixture.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Local Node client-handler fixture.
import { runInNewContext } from 'node:vm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { wizardRoutes } from '../src/routes/admin-wizard'
import { addonLines, parseAddonLines, type Addon } from '../src/lib/catalog'

function fixture(){
  const db=new DatabaseSync(':memory:')
  for(const file of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/'+file,'utf8'))
  db.exec(readFileSync('seed/seed.sql','utf8'))
  const DB={prepare(sql:string){let args:any[]=[];const st={bind(...v:any[]){args=v;return st},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){const r=db.prepare(sql).run(...args);return {meta:{last_row_id:Number(r.lastInsertRowid)}}}};return st}}
  const env:any={DB,KV:{async get(){return null},async put(){},async delete(){}},JOBS:{async send(){}},SITE_URL:'http://localhost',ENVIRONMENT:'development'}
  const user=db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  const app=new Hono<any>().use('*',async(c,next)=>{c.set('user',user);await next()}).route('/',wizardRoutes)
  const id=Number(db.prepare("INSERT INTO properties(slug,name,type,destination) VALUES ('activity-test','Activity test','resort','Munnar')").run().lastInsertRowid)
  const saved=()=>JSON.parse((db.prepare('SELECT addons FROM properties WHERE id=?').get(id) as any).addons) as Addon[]
  const save=(rows:{key?:string;name:string;price:number;free?:boolean;items?:{name:string;price:number;free?:boolean}[]}[])=>{
    const body=new URLSearchParams({child_bed:'',child_nobed:'',child_free:'',extra_adult:''})
    rows.forEach(row=>{body.append('act_name',row.name);body.append('act_amt',String(row.price));body.append('act_free',row.free?'1':'0');if(row.key!=null){body.append('act_key',row.key);(row.items??[]).forEach(item=>{body.append(`act_${row.key}_item_name`,item.name);body.append(`act_${row.key}_item_amt`,String(item.price));body.append(`act_${row.key}_item_free`,item.free?'1':'0')})}})
    return app.request(`http://localhost/admin/properties/${id}/setup/4`,{method:'POST',body},env)
  }
  return {db,env,app,id,saved,save}
}

describe('property activity child items',()=>{
  it('restores the old controls and persists multiple distinct parent/child groups without changing existing records',async()=>{
    const f=fixture()
    try{
      const before=JSON.stringify(['properties','rooms','season_rates','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+' WHERE '+(t==='properties'?'id':'property_id')+' IS NOT ? ORDER BY id').all(f.id)))
      const rows=[{key:'0',name:'Bonfire',price:1500,items:[{name:'Music',price:500},{name:'Barbecue',price:1000}]},{key:'1',name:'Plantation Tour',price:0,free:true,items:[{name:'Guide',price:900,free:true}]}]
      await f.save(rows)
      const expected=[{name:'Bonfire',price:1500,net:null,per:'stay',complimentary:false,items:[{name:'Music',price:500,complimentary:false},{name:'Barbecue',price:1000,complimentary:false}]},{name:'Plantation Tour',price:0,net:null,per:'stay',complimentary:true,items:[{name:'Guide',price:0,complimentary:true}]}]
      expect(f.saved()).toEqual(expected)
      await f.save(rows);expect(f.saved()).toEqual(expected)
      const html=await (await f.app.request(`http://localhost/admin/properties/${f.id}/setup/4`,{},f.env)).text()
      expect(html).toContain('Add New Activity');expect(html).not.toContain('Add Another Activity');expect(html).not.toContain('creates a reusable name');expect(html).not.toContain('data-new-activity')
      expect(html).toContain('name="act_0_item_name" value="Music"')
      expect(html).toContain('name="act_0_item_name" value="Barbecue"')
      expect(html).toContain('name="act_1_item_name" value="Guide"')
      expect(html).toContain('name="act_1_item_free" value="1"')
      expect(html).toContain('<td colspan="4"><div class="activity-main">')
      expect(html).toContain('</div><div class="activity-items"')
      expect(html).not.toContain('act-item-charge')
      expect(html).toContain('class="act-item-amount" aria-label="Item charge amount (₹)" min="0" disabled')
      expect(html).toContain('class="act-item-value" name="act_0_item_amt" value="500"')
      expect(html).toContain('class="act-item-value" name="act_1_item_amt" value=""')
      expect(f.db.prepare("SELECT * FROM taxonomy WHERE label='Music'").all()).toHaveLength(0)
      expect(f.saved().map(a=>a.name)).toEqual(['Bonfire','Plantation Tour'])
      expect(JSON.stringify(['properties','rooms','season_rates','property_photos'].map(t=>f.db.prepare('SELECT * FROM '+t+' WHERE '+(t==='properties'?'id':'property_id')+' IS NOT ? ORDER BY id').all(f.id)))).toBe(before)
    }finally{f.db.close()}
  })
  it('deletes only the chosen child or parent, with repeated Edit/Save restoration',async()=>{
    const f=fixture()
    try{
      await f.save([{key:'0',name:'Bonfire',price:1500,items:[{name:'Music',price:500},{name:'Snacks',price:0,free:true}]},{key:'1',name:'Jeep Safari',price:2000,items:[{name:'Guide',price:500}]}])
      const safari=f.saved()[1]
      await f.save([{key:'0',name:'Bonfire',price:1500,items:[{name:'Snacks',price:0,free:true}]},{key:'1',name:'Jeep Safari',price:2000,items:[{name:'Guide',price:500}]}])
      expect(f.saved()[0].price).toBe(1500);expect(f.saved()[0].items).toHaveLength(1);expect(f.saved()[1]).toEqual(safari)
      await f.save([{key:'1',name:'Jeep Safari',price:2000,items:[{name:'Guide',price:500}]}])
      expect(f.saved()).toEqual([safari])
      // Reopening renumbers visible rows; ownership survives that new form key.
      await f.save([{key:'0',name:'Jeep Safari',price:2000,items:[{name:'Guide',price:500}]}])
      expect(f.saved()).toEqual([safari])
      await f.save([{key:'0',name:'Jeep Safari',price:2000,items:[]}]);expect(f.saved()[0].items).toEqual([])
    }finally{f.db.close()}
  })
  it('preserves old rows and private metadata, supports older saves, and rejects orphan children',async()=>{
    const f=fixture()
    try{
      const old:Addon={name:'Legacy tour',price:700,net:500,per:'person',complimentary:false}
      f.db.prepare('UPDATE properties SET addons=? WHERE id=?').run(JSON.stringify([old]),f.id)
      await f.save([{key:'0',name:old.name,price:700}]);expect(f.saved()).toEqual([old])
      await f.save([{key:'0',name:old.name,price:700,items:[{name:'Music',price:500}]}])
      const withItems=f.saved()
      await f.save([{name:old.name,price:700}]);expect(f.saved()).toEqual(withItems)
      expect(parseAddonLines(addonLines(withItems,true),withItems,true)[0].items).toEqual(withItems[0].items)
      const response=await f.save([{key:'0',name:'',price:0,items:[{name:'Orphan',price:100}]}])
      expect(response.headers.get('location')).toContain('err=')
      expect(f.saved()).toEqual(withItems)
    }finally{f.db.close()}
  })
  it('client adds/removes a child within its parent and keeps complimentary amounts disabled without losing submission positions',()=>{
    const events=(o:any)=>Object.assign(o,{listeners:{} as Record<string,Function>,addEventListener(k:string,f:Function){this.listeners[k]=f}})
    const child=()=>{const inputs:any[]=[{name:'act___ACT___item_name',value:'',focus(){}},{name:'act___ACT___item_free',value:'0'},{name:'act___ACT___item_amt',value:'',focus(){}}];const c:any={inputs,free:{checked:false},charge:{checked:false},state:inputs[1],value:inputs[2],amount:{value:'',disabled:false,focus(){},classList:{contains(){return true}}},cloneNode(){return child()},remove(){this.parent.children=this.parent.children.filter((i:any)=>i!==this)}};return c}
    const parents=[0,1].map(i=>({dataset:{actRow:String(i)},name:{value:i?'Jeep Safari':'Bonfire'},items:{children:[] as any[],appendChild(c:any){this.children.push(c);c.parent=this}}}))
    const acts=events({children:parents}),add=events({})
    const source=readFileSync('public/app.js','utf8') as string
    runInNewContext(source.slice(source.indexOf('  var acts ='),source.indexOf('  var contacts =')),{
      $:(s:string,r:any)=>s==='[data-acts]'?acts:s==='[data-add-activity]'?add:s==='input[name=act_name]'?r.name:s==='[data-act-items]'?r.items:s==='input'?r.inputs[0]:s==='.act-item-free'?r.free:s==='.act-item-value'?r.value:s==='.act-item-amount'?r.amount:r.state,
      $$:(s:string,r:any)=>s==='[data-act-row]'?parents:r.inputs,document:{getElementById(){return {content:{firstElementChild:child()}}}},alert(){},cloneClean(){},
    })
    const clickAdd=(p:any)=>acts.listeners.click({target:{closest(s:string){return s==='[data-add-act-item]'?{closest(){return p}}:null}}})
    clickAdd(parents[0]);clickAdd(parents[0]);clickAdd(parents[1])
    expect(parents[0].items.children.map(c=>c.inputs[0].name)).toEqual(['act_0_item_name','act_0_item_name'])
    expect(parents[1].items.children[0].inputs[0].name).toBe('act_1_item_name')
    const c=parents[0].items.children[0];c.amount.closest=()=>c;c.free.closest=()=>c
    c.amount.value='500';acts.listeners.input({target:c.amount});expect(c.value.value).toBe('500')
    c.free.checked=true
    acts.listeners.change({target:c.free});expect(c.amount.value).toBe('');expect(c.amount.disabled).toBe(true);expect(c.value.value).toBe('');expect(c.state.value).toBe('1')
    c.free.checked=false;acts.listeners.change({target:c.free});expect(c.amount.disabled).toBe(false);expect(c.amount.value).toBe('');expect(c.state.value).toBe('0')
    const second=parents[0].items.children[1];second.amount.closest=()=>second
    second.amount.value='1000';acts.listeners.input({target:second.amount})
    expect(parents[0].items.children.map(c=>c.value.value)).toEqual(['','1000'])
    expect(parents.map(p=>p.name.value)).toEqual(['Bonfire','Jeep Safari'])
    acts.listeners.click({target:{closest(s:string){return s==='[data-del-act-item]'?{closest(){return c}}:null}}})
    expect(parents[0].items.children).toHaveLength(1);expect(parents[1].items.children).toHaveLength(1)
  })
})
