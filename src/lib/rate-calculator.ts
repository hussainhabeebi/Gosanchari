import { combinedQuotationPrice, splitGuests } from './quotation-pricing'
import { calculatePrice, staffRateForStay, netRateForStay, seasonAppliesOn, type PriceInput } from './pricing'
import { addDays, eachNight, isDate, nightsBetween } from './util'

export interface CalculatorInput {
  property: number; checkIn: string; checkOut: string; mealPlan: string
  adults: number; extraAdults: number; children: number; kidsAmount: number
  discount: number; additional: number; applyGst: boolean
  rooms: { id: number; count: number }[]
}
export function calculatorInput(v: unknown): CalculatorInput {
  const x = v as CalculatorInput
  if (!x || !isDate(x.checkIn) || !isDate(x.checkOut) || nightsBetween(x.checkIn,x.checkOut)<1 || nightsBetween(x.checkIn,x.checkOut)>60) throw new Error('Choose valid check-in/check-out dates for 1–60 nights.')
  if (!['','CP','MAP','AP','EP'].includes(x.mealPlan)) throw new Error('Choose a valid meal plan.')
  for (const k of ['property','adults','extraAdults','children','kidsAmount','discount','additional'] as const) if (!Number.isSafeInteger(x[k]) || x[k]<0 || x[k]>100000000) throw new Error('Enter valid non-negative whole numbers.')
  if (x.property<1 || x.adults+x.extraAdults<1 || x.adults+x.extraAdults+x.children>1000 || typeof x.applyGst!=='boolean') throw new Error('Choose a property and valid guest counts.')
  if (!Array.isArray(x.rooms) || x.rooms.length<1 || x.rooms.length>20 || x.rooms.some(r=>!r || !Number.isSafeInteger(r.id) || r.id<1 || !Number.isSafeInteger(r.count) || r.count<1 || r.count>100)) throw new Error('Choose 1–20 room categories with valid quantities.')
  if (new Set(x.rooms.map(r=>r.id)).size!==x.rooms.length) throw new Error('Each room category can be selected only once.')
  if (!x.children && x.kidsAmount) throw new Error('Kids Amount requires a child count.')
  return x
}
export type CalculatorRoom = { room: PriceInput['room'] & { name: string }; seasons: PriceInput['seasons'] }
export function rateEstimate(x: CalculatorInput, loaded: CalculatorRoom[], slabs: PriceInput['taxSlabs'], admin: boolean) {
  const allocations=splitGuests(loaded.map((p,i)=>({...p.room,rooms:x.rooms[i].count})),x.adults+x.extraAdults,x.children)
  const base=loaded.map((p,i)=>({room:{...p.room,extra_child_rate:0},seasons:p.seasons,staffRoom:p.room,staffSeasons:p.seasons,checkIn:x.checkIn,checkOut:x.checkOut,mealPlan:x.mealPlan||null,roomsCount:x.rooms[i].count,adults:allocations[i].adults,children:allocations[i].children,taxSlabs:slabs}))
  const nights=eachNight(x.checkIn,x.checkOut)
  const tiers: {key:string;label:string;available:boolean;errors:string[];rows:unknown[];total?:number;subtotal?:number;discount?:number;extras?:number;gst?:number;maximumDiscount?:number|null}[]=[]
  for (const tier of ['direct','staff',...(admin?['net']:[])]) {
    let missing=loaded.some(p=>nights.some(date=>{
      const matrix=p.seasons.filter(s=>s.source==='wizard' && seasonAppliesOn(s,date))
      const plan=x.mealPlan || p.room.rate_meal_plan
      return matrix.length>0 && !matrix.some(s=>!s.meal_plan || s.meal_plan===plan)
    }))
    const inputs=base.map((b,i)=>{
      if(tier==='direct')return b
      // Existing tier resolvers include peak supplements. Adapt their nightly amounts to
      // ephemeral direct rows so the same calculation engine applies occupancy and GST once.
      const resolved=nights.map(date=>({date,amount:tier==='staff'?staffRateForStay(loaded[i].room,loaded[i].seasons,date,addDays(date,1),x.mealPlan||null):netRateForStay(loaded[i].room,loaded[i].seasons,date,addDays(date,1),x.mealPlan||null)}))
      if(resolved.some(r=>r.amount==null || r.amount<=0))missing=true
      return {...b,staffRoom:{...b.room,staff_rate:null},staffSeasons:[],room:{...b.room,base_rate:0,weekend_rate:null},seasons:resolved.map(r=>({property_id:x.property,room_id:b.room.id,name:'Resolved rate',start_date:r.date,end_date:r.date,rate:r.amount,pct_adjust:null,min_nights:null,kind:'season'}))}
    })
    const label=tier==='direct'?'Guest / Direct':tier==='staff'?'Staff':'B2B / Special (Admin only)'
    if(missing){tiers.push({key:tier,label,available:false,errors:['Applicable rate not supplied; no other tier was substituted.'],rows:[]});continue}
    const result=combinedQuotationPrice(inputs,{discountAmount:tier==='direct'?x.discount:0,extraCharges:x.kidsAmount+x.additional,applyGst:x.applyGst})
    const unresolved=inputs.some(b=>calculatePrice({...b,adults:undefined,children:undefined}).lines.length!==nights.length)
    if(unresolved || result.errors.length){tiers.push({key:tier,label,available:false,errors:result.errors.length?result.errors:['Applicable rate not supplied.'],rows:[]});continue}
    tiers.push({key:tier,label,available:true,errors:[],rows:result.parts.map((p,i)=>({name:loaded[i].room.name,rooms:x.rooms[i].count,nights:p.nights,average:p.roomCharges/(p.nights*p.roomsCount),accommodation:p.roomCharges,extraAdults:p.extraGuests?.total??0,discount:p.discount,extras:p.extraCharges,gst:p.taxes,total:p.total,nightly:p.lines})),subtotal:result.subtotal,discount:result.discount,extras:result.extraCharges,gst:result.taxes,total:result.total,...(tier==='direct'?{maximumDiscount:result.maximumDiscount}:{})})
  }
  const warnings=loaded.flatMap((p,i)=>p.room.units>0 && x.rooms[i].count>p.room.units?[`Requested ${x.rooms[i].count} rooms of ${p.room.name}; configured category inventory is ${p.room.units}. Verify with the property.`]:[])
  const capacity=loaded.reduce((a,p,i)=>a+p.room.capacity*x.rooms[i].count,0)
  if(x.adults+x.extraAdults+x.children>capacity)warnings.push(`Selected categories accommodate at most ${capacity} guests. Please add rooms.`)
  return {tiers,warnings,capacity,totalRooms:x.rooms.reduce((a,r)=>a+r.count,0),kidsAmount:x.kidsAmount,additional:x.additional,guests:x.adults+x.extraAdults+x.children}
}
