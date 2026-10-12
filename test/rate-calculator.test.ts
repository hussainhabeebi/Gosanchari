// @ts-expect-error Local SQLite fixture.
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Local fixture files.
import { readFileSync,readdirSync } from 'node:fs'
import { describe,it,expect } from 'vitest'
import { Hono } from 'hono'
import { calculatorInput,rateEstimate,type CalculatorInput,type CalculatorRoom } from '../src/lib/rate-calculator'
import { combinedQuotationPrice,splitGuests } from '../src/lib/quotation-pricing'
import { calculatorRoutes } from '../src/routes/rate-calculator'

const input=():CalculatorInput=>({property:1,checkIn:'2030-12-20',checkOut:'2030-12-23',mealPlan:'CP',adults:21,extraAdults:0,children:0,kidsAmount:0,discount:1000,additional:200,applyGst:true,rooms:[{id:1,count:4},{id:2,count:3}]})
const pricing=():CalculatorRoom[]=>[1,2].map(id=>({room:{id,name:'Room '+id,property_id:1,capacity:3,base_guests:3,units:4,min_nights:1,base_rate:5000+id*1000,weekend_rate:7000+id*1000,staff_rate:4000,net_rate:3147,extra_adult_rate:500,extra_child_rate:800,rate_meal_plan:'CP'},seasons:[{property_id:1,room_id:null,name:'Holiday',start_date:'2030-12-21',end_date:'2030-12-22',rate:null,pct_adjust:null,min_nights:null,supplement:1000,net_supplement:271}]}))
describe('read-only rate calculator',()=>{
 it('matches saved quote engine exactly including combined categories, discount and GST',()=>{
  const x=input(),p=pricing(),alloc=splitGuests(p.map((l,i)=>({...l.room,rooms:x.rooms[i].count})),x.adults,x.children)
  const quote=combinedQuotationPrice(p.map((l,i)=>({...l,room:{...l.room,extra_child_rate:0},staffRoom:l.room,staffSeasons:l.seasons,checkIn:x.checkIn,checkOut:x.checkOut,mealPlan:x.mealPlan,roomsCount:x.rooms[i].count,...alloc[i]})),{discountAmount:x.discount,extraCharges:x.additional,applyGst:true})
  const result=rateEstimate(x,p,undefined,true),direct=result.tiers[0]
  expect(direct.available).toBe(true);expect(direct.total).toBe(quote.total);expect(direct.gst).toBe(quote.taxes);expect(direct.discount).toBe(quote.discount)
  expect(result.totalRooms).toBe(7);expect(result.capacity).toBe(21);expect(result.warnings).toEqual([])
  expect(result.tiers.map(t=>t.key)).toEqual(['direct','staff','net']);expect(result.tiers[2].available).toBe(true)
  expect(result.tiers.slice(1).map(t=>t.discount)).toEqual([0,0])
 })
 it('never includes B2B tier, fields or distinctive net amounts in Staff output',()=>{
  const r=rateEstimate(input(),pricing(),undefined,false),s=JSON.stringify(r)
  expect(r.tiers.map(t=>t.key)).toEqual(['direct','staff']);for(const text of ['net_rate','net_supplement','3147','271','B2B'])expect(s).not.toContain(text)
 })
 it('keeps matrix blanks unavailable without substituting private rates or zero',()=>{
  const p=pricing();p.forEach(l=>{l.room.base_rate=0;l.seasons=[{source:'wizard',property_id:1,room_id:l.room.id,name:'CP Season',start_date:'2030-10-01',end_date:'2031-03-31',meal_plan:'CP',rate:null,weekend_rate:null,staff_rate:4500,staff_weekend_rate:4700,net_rate:3000,pct_adjust:null,min_nights:null}]})
  const x={...input(),discount:0},r=rateEstimate(x,p,undefined,false)
  expect(r.tiers[0].available).toBe(false);expect(r.tiers[0].total).toBeUndefined();expect(r.tiers[1].available).toBe(true)
  expect(rateEstimate({...x,mealPlan:'AP'},p,undefined,false).tiers.every(t=>!t.available)).toBe(true)
 })
 it('manual kids and extras appear once, GST OFF works, and floors reject excessive discount',()=>{
  const x={...input(),adults:18,children:3,kidsAmount:900,additional:300,applyGst:false},r=rateEstimate(x,pricing(),undefined,false)
  expect(r.tiers[0].extras).toBe(1200);expect(r.tiers.every(t=>t.gst===0)).toBe(true)
  expect(r.tiers[0].total).toBe(r.tiers[0].subtotal!-x.discount+1200)
  expect(rateEstimate({...x,discount:100000},pricing(),undefined,false).tiers[0].available).toBe(false)
 })
 it('reports combined capacity and inventory advisories, excluding checkout peak night',()=>{
  const p=pricing(),x={...input(),adults:25,rooms:[{id:1,count:5},{id:2,count:1}],discount:0};p[1].room.units=0
  const r=rateEstimate(x,p,undefined,false);expect(r.warnings.join(' ')).toContain('configured category inventory is 4');expect(r.warnings.join(' ')).toContain('at most 18')
  const one={...input(),checkIn:'2030-12-20',checkOut:'2030-12-21',adults:3,rooms:[{id:1,count:1}],discount:0,additional:0};const staff=rateEstimate(one,[p[0]],undefined,false).tiers[1];expect((staff.rows[0] as any).accommodation).toBe(4000)
 })
 it('resolves configured extra-adult charges without duplicating manual kids/additional amounts',()=>{
  const p=pricing();p.forEach(l=>l.room.capacity=4)
  const x={...input(),extraAdults:2,discount:0,kidsAmount:0,additional:150},r=rateEstimate(x,p,undefined,false)
  expect(r.tiers[0].available).toBe(true);expect((r.tiers[0].rows as any[]).reduce((a,row)=>a+row.extraAdults,0)).toBe(3000);expect(r.tiers[0].extras).toBe(150)
 })
 it('uses common peak fallback and room override once across Guest, Staff and Admin B2B',()=>{
  const p=pricing();p.forEach(l=>{l.room.weekend_rate=null;l.seasons=[{source:'wizard-common:christmas',property_id:1,room_id:null,name:'Christmas',start_date:'2030-12-20',end_date:'2030-12-22',rate:null,pct_adjust:null,min_nights:null,supplement:1000,net_supplement:1000}]})
  p[0].seasons.push({source:'wizard-override:christmas',property_id:1,room_id:1,name:'Room exception',start_date:'2030-12-20',end_date:'2030-12-22',rate:null,pct_adjust:null,min_nights:null,supplement:500,net_supplement:500})
  const r=rateEstimate({...input(),discount:0},p,undefined,true)
  expect(r.tiers.every(t=>t.available)).toBe(true)
  expect((r.tiers[0].rows[0] as any).accommodation).toBe((6000+500)*4*3)
  expect((r.tiers[1].rows[0] as any).accommodation).toBe((4000+500)*4*3)
  expect((r.tiers[2].rows[0] as any).accommodation).toBe((3147+500)*4*3)
  expect((r.tiers[1].rows[1] as any).accommodation).toBe((4000+1000)*3*3)
 })
 it('validates duplicate categories, dates, amounts, empty input and child amount',()=>{
  expect(()=>calculatorInput({...input(),rooms:[{id:1,count:1},{id:1,count:2}]})).toThrow(/only once/)
  expect(()=>calculatorInput({...input(),checkOut:input().checkIn})).toThrow(/dates/)
  expect(()=>calculatorInput({...input(),discount:-1})).toThrow(/non-negative/)
  expect(()=>calculatorInput({...input(),kidsAmount:1})).toThrow(/child count/)
  expect(()=>calculatorInput(null)).toThrow()
 })
})

function fixture(role:string|null='sales'){
 const db=new DatabaseSync(':memory:');for(const f of readdirSync('migrations').filter((f:string)=>f.endsWith('.sql')).sort())db.exec(readFileSync('migrations/'+f,'utf8'));db.exec(readFileSync('seed/seed.sql','utf8'))
 const pid=Number(db.prepare("INSERT INTO properties(slug,name,type,destination,address,status) VALUES('calculator-test','Calculator Test','resort','Munnar','','live')").run().lastInsertRowid)
 const rid=Number(db.prepare("INSERT INTO rooms(property_id,name,capacity,units,base_rate,staff_rate,net_rate) VALUES(?,'Calculator Room',3,4,6000,5000,3147)").run(pid).lastInsertRowid)
 const DB={prepare(sql:string){let args:any[]=[];const st={bind(...a:any[]){args=a;return st},async first(){return db.prepare(sql).get(...args)??null},async all(){return {results:db.prepare(sql).all(...args)}}};return st}}
 const env:any={DB,KV:{get:async()=>null,put:async()=>{}},SITE_URL:'http://localhost',TURNSTILE_SITE_KEY:''};const app=new Hono<any>();app.use('*',async(c,next)=>{c.set('user',role?{id:1,name:'Tester',role,language:'en'}:null);await next()});app.route('/',calculatorRoutes)
 const post=(data:any)=>app.request('http://localhost/staff/rate-calculator/calculate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)},env)
 return {db,pid,rid,app,env,post}
}
describe('calculator HTTP access and read-only boundary',()=>{
 it('Staff HTML/metadata/JSON excludes private data; no records change',async()=>{
  const f=fixture();try{
   const before=Number((f.db.prepare('SELECT total_changes() AS n').get() as any).n)
   const page=await f.app.request('http://localhost/staff/rate-calculator',{},f.env);expect(page.status).toBe(200);const html=await page.text();expect(html).toContain('Rate Calculator');expect(html.match(/href="\/staff\/rate-calculator"/g)).toHaveLength(1);expect(html).not.toContain('3147');expect(html).not.toContain('net_rate')
   const rooms=await f.app.request('http://localhost/staff/rate-calculator/rooms?property='+f.pid,{},f.env);const metadata=await rooms.text();expect(metadata).not.toContain('net_rate');expect(metadata).not.toContain('staff_rate')
   const res=await f.post({...input(),property:f.pid,adults:2,discount:0,rooms:[{id:f.rid,count:1}],admin:true,tier:'net'});expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('private, no-store');expect((await res.json() as any).tiers.map((t:any)=>t.key)).toEqual(['direct','staff'])
   expect(Number((f.db.prepare('SELECT total_changes() AS n').get() as any).n)).toBe(before)
  }finally{f.db.close()}
 })
 it.each(['admin','manager','sales'])('role %s receives only its allowed tiers',async role=>{
  const f=fixture(role);try{const r=await f.post({...input(),property:f.pid,adults:2,discount:0,rooms:[{id:f.rid,count:1}]});expect(r.status).toBe(200);expect((await r.json() as any).tiers.length).toBe(role==='admin'?3:2)}finally{f.db.close()}
 })
 it.each([null,'guest'])('blocks unauthorised role %s',async role=>{const f=fixture(role);try{const r=await f.post(input());expect(r.status).toBe(role?403:302)}finally{f.db.close()}})
 it('rejects rooms from another property and duplicate categories server-side',async()=>{const f=fixture();try{
  expect((await f.post({...input(),property:f.pid+1,rooms:[{id:f.rid,count:1}]})).status).toBe(422)
  expect((await f.post({...input(),property:f.pid,rooms:[{id:f.rid,count:1},{id:f.rid,count:1}]})).status).toBe(422)
 }finally{f.db.close()}})
})

// @ts-expect-error Local browser-script harness.
import { runInNewContext } from 'node:vm'
function browserFixture(fetcher:any){
 class Node {
  children:Node[]=[];parent:Node|null=null;dataset:any={};handlers:any={};value='';text='';disabled=false;checked=false;type='';className='';required=false;min='';max=''
  constructor(public tag:string){}
  get textContent():string{return this.text+this.children.map(c=>c.textContent).join(' ')}
  set textContent(v:string){this.text=v;this.children=[]}
  get options(){return this.children}
  append(...nodes:Node[]){nodes.forEach(n=>{n.parent=this;this.children.push(n)})}
  replaceChildren(){this.children=[];this.text=''}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this)}
  addEventListener(type:string,fn:any){(this.handlers[type]??=[]).push(fn)}
  async emit(type:string,event:any={}){for(const fn of this.handlers[type]??[])await fn({target:this,preventDefault(){},...event})}
  querySelectorAll(selector:string):Node[]{const key=selector.match(/^\[data-(.+)\]$/)?.[1]?.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return this.children.flatMap(c=>[...(key?key in c.dataset:c.tag===selector)?[c]:[],...c.querySelectorAll(selector)])}
  querySelector(selector:string){return this.querySelectorAll(selector)[0]}
 }
 const list=new Node('div'),results=new Node('section'),status=new Node('span'),add=new Node('button'),clear=new Node('button'),calculate=new Node('button'),topCalculate=new Node('button');const defaults:any={property:'',checkIn:'2030-12-20',checkOut:'2030-12-23',mealPlan:'CP',adults:'2',extraAdults:'0',children:'0',kidsAmount:'0',discount:'0',additional:'0'}
 const form:any=new Node('form');form.elements=Object.fromEntries(Object.entries(defaults).map(([k,v])=>{const n=new Node('input');n.value=v as string;return[k,n]}));form.elements.applyGst=new Node('input');form.elements.applyGst.checked=true;form.reportValidity=()=>true;form.reset=()=>{Object.entries(defaults).forEach(([k,v])=>form.elements[k].value=v);form.elements.applyGst.checked=true}
 form.querySelector=(s:string)=>s==='[data-calculator-rooms]'?list:s==='[data-calculator-add]'?add:s==='[data-calculator-status]'?status:s==='[data-calculator-clear]'?clear:calculate
 form.querySelectorAll=(s:string)=>s==='[data-calculator-calculate]'?[calculate,topCalculate]:[]
 const document={querySelector:(s:string)=>s==='[data-rate-calculator]'?form:results,createElement:(tag:string)=>new Node(tag)}
 runInNewContext(readFileSync('public/rate-calculator.js','utf8'),{document,fetch:fetcher,AbortController,console})
 const selectProperty=async(value='1')=>{form.elements.property.value=value;await form.elements.property.emit('change')}
 return {form,list,results,status,add,clear,selectProperty,calculate,topCalculate}
}
const roomResponse=()=>({ok:true,json:async()=>({rooms:[1,2,3].map(id=>({id,name:'Room '+id,units:id===3?0:4,capacity:3}))})})
const estimateResponse=(total:number)=>({ok:true,json:async()=>({totalRooms:2,guests:4,capacity:6,warnings:[],kidsAmount:0,additional:0,tiers:[{label:'Guest / Direct',available:true,rows:[],subtotal:total,discount:0,gst:0,total}]})})
describe('calculator script interaction regressions (DOM harness)',()=>{
 it('adds distinct categories, preserves quantities, removes one and clears all inputs/results',async()=>{
  let payload:any;const b=browserFixture(async(url:string,opts:any)=>url.includes('/rooms')?roomResponse():(payload=JSON.parse(opts.body),estimateResponse(12345)))
  await b.selectProperty();await b.add.emit('click');await b.add.emit('click');expect(b.list.children.map((r:any)=>r.querySelector('select').value)).toEqual(['1','2','3']);expect(b.add.disabled).toBe(true)
  b.list.children[0].querySelector('input')!.value='5';await b.form.emit('input');expect(b.list.children[0].querySelector('[data-inventory]')!.textContent).toContain('Requested 5')
  expect(b.list.children[1].querySelector('select')!.options[0].disabled).toBe(true)
  await b.list.children[1].querySelector('button')!.emit('click');expect(b.list.children).toHaveLength(2);expect(b.list.children[0].querySelector('input')!.value).toBe('5')
  await b.form.emit('submit');expect(payload.rooms).toEqual([{id:1,count:5},{id:3,count:1}]);expect(b.results.textContent).toContain('12,345')
  await b.clear.emit('click');expect(b.list.children).toHaveLength(0);expect(b.form.elements.property.value).toBe('');expect(b.results.textContent).toBe('');expect(b.add.disabled).toBe(true)
 })
 it('rejects stale calculation responses after edits and preserves input on error',async()=>{
  let first:any,second:any,calls=0;const b=browserFixture((url:string)=>url.includes('/rooms')?Promise.resolve(roomResponse()):new Promise(resolve=>{calls++;if(calls===1)first=resolve;else second=resolve}))
  await b.selectProperty();const pending=b.form.emit('submit');expect(b.calculate.disabled).toBe(true);expect(b.topCalculate.disabled).toBe(true);b.form.elements.kidsAmount.value='400';await b.form.emit('input');const current=b.form.emit('submit');second(estimateResponse(22222));await current;first(estimateResponse(11111));await pending;expect(b.results.textContent).toContain('22,222');expect(b.results.textContent).not.toContain('11,111');expect(b.form.elements.kidsAmount.value).toBe('400')
  const failure=b.form.emit('submit');second({ok:false,json:async()=>({error:'Please review dates.'})});await failure;expect(b.status.textContent).toBe('Please review dates.');expect(b.form.elements.kidsAmount.value).toBe('400');expect(b.calculate.disabled).toBe(false)
 })
 it('room loading survives edits to other inputs and Clear invalidates pending room responses',async()=>{
  let resolve:any;const b=browserFixture(()=>new Promise(r=>resolve=r));const pending=b.selectProperty();b.form.elements.adults.value='4';await b.form.emit('input');resolve(roomResponse());await pending;expect(b.list.children).toHaveLength(1);expect(b.form.elements.adults.value).toBe('4')
  const next=b.selectProperty('2');await b.clear.emit('click');resolve(roomResponse());await next;expect(b.list.children).toHaveLength(0);expect(b.form.elements.property.value).toBe('')
 })
})


describe('combined calculator presentation',()=>{
 it.each([false,true])('renders one room-wise table and only server-permitted total cards, Admin=%s',async admin=>{
  const result=rateEstimate(input(),pricing(),undefined,admin)
  const b=browserFixture(async(url:string)=>url.includes('/rooms')?roomResponse():({ok:true,json:async()=>result}))
  await b.selectProperty();await b.add.emit('click');await b.form.emit('submit')
  expect(b.results.querySelectorAll('table')).toHaveLength(1)
  const summaries=b.results.querySelectorAll('section').filter((n:any)=>n.className.startsWith('calculator-summary '))
  expect(summaries).toHaveLength(admin?3:2)
  expect(b.results.textContent).toContain('Total Staff Rate');expect(b.results.textContent).toContain('Total Guest / Direct Rate')
  expect(b.results.textContent.includes('Total B2B Rate')).toBe(admin)
  const headers=b.results.querySelectorAll('th').map((n:any)=>n.textContent)
  expect(headers).toContain('Staff / room / night');expect(headers.includes('B2B / room / night')).toBe(admin)
  expect(b.results.textContent).toContain('Detailed price breakdown');expect(b.results.textContent).toContain('Accommodation')
  expect(b.calculate.disabled).toBe(false);expect(b.topCalculate.disabled).toBe(false)
 })
})
