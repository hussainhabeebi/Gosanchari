import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { requirePerm } from '../lib/auth'
import { all, loadPricing } from '../lib/db'
import { getSettings } from '../lib/settings'
import { calculatorInput, rateEstimate, type CalculatorRoom } from '../lib/rate-calculator'
import { page } from '../views/layout'
import { Field } from '../views/components'
import { MEAL_PLANS } from '../lib/search'

export const calculatorRoutes=new Hono<AppEnv>()
calculatorRoutes.use('/staff/rate-calculator*',requirePerm('manage_quotes'))
calculatorRoutes.use('/staff/rate-calculator*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next()})
calculatorRoutes.get('/staff/rate-calculator',async c=>{
  const properties=await all<{id:number;name:string}>(c.env,"SELECT id,name FROM properties WHERE status='live' ORDER BY name")
  return page(c,{title:'Rate Calculator',area:c.get('user')!.role==='admin'?'admin':'staff',active:'rate-calculator',noindex:true,head:<script src="/rate-calculator.js" defer/>},<div class="stack-lg"><h1>Rate Calculator</h1><p class="muted">Estimates only. No quotation, booking, payment or availability confirmation is created.</p>
  <form class="card stack calculator-form" data-rate-calculator>
  <div class="calculator-top">
  <div class="calculator-property"><Field label="Property"><select name="property" required><option value="">Select property</option>{properties.map(p=><option value={p.id}>{p.name}</option>)}</select></Field></div>
  <div data-calculator-rooms class="calculator-room-list"/><div class="calculator-room-placeholder"><Field label="Room Category"><select disabled aria-label="Room category — select a property first"><option>Select property first</option></select></Field><Field label="No. of Rooms"><input type="number" value="1" disabled aria-label="Number of rooms — select a property first"/></Field></div>
  <div class="calculator-add"><Field label="Add Room Category"><button type="button" class="btn btn-sm btn-outline" data-calculator-add disabled>+ Add category</button></Field></div>
  <div class="calculator-extra"><Field label="Extra Adults"><input name="extraAdults" type="number" min="0" max="1000" value="0" required/></Field></div>
  <div class="calculator-kids"><Field label="Kids Rate ₹"><input name="kidsAmount" type="number" min="0" value="0" required aria-describedby="calculator-notes"/></Field></div>
  <div class="calculator-discount"><Field label="Discount ₹"><input name="discount" type="number" min="0" value="0" required aria-describedby="calculator-notes"/></Field></div>
  <div class="calculator-additional"><Field label="Additional Payment ₹"><input name="additional" type="number" min="0" value="0" required aria-describedby="calculator-notes"/></Field></div>
  <button class="btn calculator-top-submit" data-calculator-calculate>Calculate</button>
  </div>
  <div class="calculator-dates">
  <Field label="Check-in"><input type="date" name="checkIn" required/></Field><Field label="Check-out"><input type="date" name="checkOut" required/></Field>
  <Field label="Meal plan"><select name="mealPlan"><option value="">Property default</option>{Object.entries(MEAL_PLANS).map(([v,l])=><option value={v}>{l}</option>)}</select></Field>
  <Field label="Adults (excluding extra adults)"><input name="adults" type="number" min="0" max="1000" value="2" required/></Field>
  <Field label="Children"><input name="children" type="number" min="0" max="1000" value="0" required/></Field>
  </div>
  <label class="small"><input type="checkbox" name="applyGst" checked/> Apply GST to estimate</label>
  <p id="calculator-notes" class="small muted">Kids Rate and Additional Payment are total amounts for this stay, added once. Children count toward capacity; check ages/bed policy before entering Kids Rate. Extra adults use configured included occupancy. Discount is Guest/Direct only, subject to the Staff floor; extras do not increase the allowance. Missing rates remain unavailable.</p>
  <section data-calculator-results class="stack" aria-live="polite"/>
  <div class="calculator-actions"><span role="status" aria-live="polite" data-calculator-status/><button type="button" class="btn btn-outline" data-calculator-clear>Clear</button><button class="btn" data-calculator-calculate>Calculate</button></div>
  </form></div>)
})
calculatorRoutes.get('/staff/rate-calculator/rooms',async c=>{
  const id=Number(c.req.query('property'))
  if(!Number.isSafeInteger(id)||id<1)return c.json({error:'Choose a property.'},422)
  const rooms=await all(c.env,"SELECT r.id,r.name,r.capacity,r.base_guests,r.units,r.extra_child_rate,r.child_no_bed_rate,p.child_free_below,p.child_age_to FROM rooms r JOIN properties p ON p.id=r.property_id WHERE r.property_id=? AND r.active=1 AND p.status='live' ORDER BY r.name",id)
  return c.json({rooms})
})
calculatorRoutes.post('/staff/rate-calculator/calculate',async c=>{
  try {
    const x=calculatorInput(await c.req.json())
    const eligible=await all<{id:number}>(c.env,"SELECT r.id FROM rooms r JOIN properties p ON p.id=r.property_id WHERE r.property_id=? AND r.active=1 AND p.status='live'",x.property)
    const loaded:CalculatorRoom[]=[]
    for(const line of x.rooms){if(!eligible.some(r=>r.id===line.id))throw new Error('Every room must belong to the selected Live property.');const p=await loadPricing(c.env,line.id);if(!p)throw new Error('Room pricing unavailable.');loaded.push(p)}
    const settings=await getSettings(c.env)
    return c.json(rateEstimate(x,loaded,settings.tax_slabs,c.get('user')!.role==='admin'))
  } catch(e){return c.json({error:e instanceof Error?e.message:'Calculation failed.'},422)}
})
