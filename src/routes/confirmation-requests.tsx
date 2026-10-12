// Quote-based approval snapshots. Never creates bookings, payments or inventory holds.
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { requirePerm, requireStaff } from '../lib/auth'
import { all, first, run } from '../lib/db'
import { loadQuoteFor } from './staff-ops'
import { roomLines, roomNames, roomsLabel } from '../lib/quote-rooms'
import { voucherHtml, type VoucherData } from '../lib/vouchers'
import { FACILITIES, MEAL_PLANS } from '../lib/search'
import { fmtDate, int, isDate, money, nightsBetween, nowIso, parseJson, randomToken, refCode, str } from '../lib/util'
import { page } from '../views/layout'
import { Field } from '../views/components'
import { form, redirectMsg } from './helpers'
import type { PropertyRow, QuoteOptionRow } from '../lib/types'

export const confirmationRoutes = new Hono<AppEnv>()
const adminOnly: MiddlewareHandler<AppEnv> = async(c,next)=>{
  if(c.get('user')?.role !== 'admin') return c.text('Admin approval required.',403)
  await next()
}
interface RequestRow { id:number; code:string; quotation_id:number; option_id:number; requested_by:number; status:'pending'|'approved'|'rejected'; details:string; admin_remarks:string; decided_by:number|null; decided_at:string|null; created_at:string; revision:number; edited_by:number|null; edited_at:string|null }
interface Details extends VoucherData { room_rent:number; quote_code:string; subtotal:number; discount:number; extras:number; gst:number; reported_advance?:number }
const allowed = (c:Context<AppEnv>, r:RequestRow)=>c.get('user')!.id===r.requested_by || c.get('user')!.role==='admin'
const number = (value:string)=>value.trim()!=='' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN
export function validateConfirmationAmounts(total:number, advance:number, rent:number, netSubtotal:number){
  if(!Number.isSafeInteger(total)||total<=0||!Number.isSafeInteger(advance)||advance<=0||advance>total) throw new Error('Enter a positive whole-rupee advance no greater than the full booking total.')
  if(!Number.isSafeInteger(rent)||rent<0||rent>netSubtotal) throw new Error('Enter room rent after discount, no greater than the saved accommodation subtotal after discount.')
  return total-advance
}
export function validateKidsAges(children:number,text:string){
  const ages=text.trim()?text.split(/[,\s]+/).filter(Boolean):[]
  if(ages.length!==children || ages.some(a=>!/^\d+$/.test(a)||Number(a)>17)) throw new Error('Enter one age (0–17) for each child, separated by commas; leave blank when there are no kids.')
  return ages.join(', ')
}
async function options(c:Context<AppEnv>, qid:number){return all<QuoteOptionRow>(c.env,'SELECT * FROM quotation_options WHERE quotation_id=? ORDER BY id',qid)}
confirmationRoutes.get('/staff/quotes/:id/confirmation', requirePerm('manage_quotes'), async c=>{
  const q=await loadQuoteFor(c,int(c.req.param('id'))); if(!q)return c.notFound()
  const opts=await options(c,q.id), option=opts.find(o=>o.id===int(c.req.query('option')))??opts[0]
  if(!option)return c.text('Save a quotation option first.',400)
  const p=await first<PropertyRow>(c.env,'SELECT * FROM properties WHERE id=?',option.property_id);if(!p)return c.notFound()
  const rooms=roomsLabel(option,await roomNames(c.env,[option]))
  return page(c,{title:'Request Booking Confirmation',area:'staff',active:'confirmation-requests'},<div class="stack">
    <h1>Request Booking Confirmation</h1><p>Quotation {q.code}. This request does not confirm a booking or verify payment. Admin must approve it.</p>
    <form method="get" action={`/staff/quotes/${q.id}/confirmation`} class="row"><Field label="Quotation option"><select name="option">{opts.map(o=><option value={o.id} selected={o.id===option.id}>Option {o.id} · {money(o.total)}</option>)}</select></Field><button class="btn btn-outline">Review option</button></form>
    <section class="card stack"><h2>{p.name}</h2><p>{p.destination} · {rooms}</p><p>{fmtDate(option.check_in)} → {fmtDate(option.check_out)} · {option.adults} adults · {option.children} kids · {option.meal_plan ?? 'Room only'}</p><p>Saved subtotal {money(option.subtotal)} · Discount {money(option.discount)} · Extras {money(option.extra_charges)} · GST {money(option.taxes)} · <strong>Full booking total {money(option.total)}</strong></p>
    <p class="small muted">To change rooms, guests, dates or prices, edit and save the quotation first. This request preserves the reviewed saved values.</p>
    <form method="post" action={`/staff/quotes/${q.id}/confirmation`} class="stack"><input type="hidden" name="option_id" value={option.id}/><input type="hidden" name="submission_key" value={randomToken(24)}/>
    <div class="grid grid-2"><Field label="Guest Name"><input name="guest_name" value={q.guest_name} required maxlength={120}/></Field><Field label="Guest Contact Number"><input name="guest_phone" type="tel" value={q.phone??''} required maxlength={60}/></Field>
    <Field label="Resort Name"><input name="resort_name" value={p.name} required maxlength={200}/></Field><Field label="Location"><input name="location" value={p.destination} required maxlength={300}/></Field>
    <Field label="Resort Contact Number"><input name="resort_phone" type="tel" required maxlength={100}/></Field><Field label="Kids' Ages" hint={`Enter ${option.children} ages, separated by commas.`}><input name="kids_ages" required={option.children>0} maxlength={120}/></Field>
    <Field label="Total Room Rent ₹ (after discount)" hint="Accommodation only, excluding extra-person charges, kids, add-ons and GST. Enter from the agreed breakdown; legacy quotations do not itemise it separately."><input name="room_rent" type="number" min="0" max={option.subtotal-option.discount} step="1" required/></Field>
    <Field label="Advance Amount Received ₹" hint="Reported by staff; Admin must explicitly verify before approval."><input name="advance" type="number" min="1" max={option.total} step="1" required/></Field></div>
    <Field label="Staff remarks (optional)"><textarea name="remarks" rows={3} maxlength={1000}/></Field><button class="btn">Submit for Admin Approval</button></form></section>
    <a href="/staff/confirmation-requests">My confirmation requests</a></div>)
})
confirmationRoutes.post('/staff/quotes/:id/confirmation', requirePerm('manage_quotes'), async c=>{
  const q=await loadQuoteFor(c,int(c.req.param('id')));if(!q)return c.notFound()
  const f=await form(c), back=`/staff/quotes/${q.id}/confirmation?option=${int(f.option_id)}`
  const o=(await options(c,q.id)).find(o=>o.id===int(f.option_id));if(!o)return c.notFound()
  const p=await first<PropertyRow>(c.env,'SELECT * FROM properties WHERE id=?',o.property_id);if(!p)return c.notFound()
  try{
    if(q.status==='pending_approval')throw new Error('Approve the quotation discount before requesting booking confirmation.')
    if(!/^[a-zA-Z0-9_-]{16,100}$/.test(f.submission_key??''))throw new Error('Reopen the confirmation form before submitting.')
    if(!isDate(o.check_in)||!isDate(o.check_out)||o.check_out<=o.check_in || !Number.isSafeInteger(o.adults)||o.adults<1||!Number.isSafeInteger(o.children)||o.children<0)throw new Error('Complete and save valid stay details in the quotation first.')
    if(o.subtotal-o.discount+o.extra_charges+o.taxes!==o.total)throw new Error('Saved quotation breakdown does not match its total. Review the quotation first.')
    const advance=number(f.advance??''), rent=number(f.room_rent??'')
    const balance=validateConfirmationAmounts(o.total,advance,rent,o.subtotal-o.discount)
    const ages=validateKidsAges(o.children,f.kids_ages??'')
    for(const key of ['guest_name','guest_phone','resort_name','resort_phone','location'])if(!f[key]?.trim())throw new Error('Complete guest name/contact and resort name/contact/location.')
    const names=await roomNames(c.env,[o]);const lines=roomLines(o)
    if(lines.some(l=>!names.has(l.room_id)||!Number.isSafeInteger(l.rooms_count)||l.rooms_count<1))throw new Error('Review room categories in the quotation first.')
    const owned=await all<{id:number}>(c.env,'SELECT id FROM rooms WHERE property_id=?',p.id)
    if(lines.some(l=>!owned.some(r=>r.id===l.room_id)))throw new Error('Every room category must belong to the selected resort.')
    const d:Details={booking_code:q.code,quote_code:q.code,status:'Confirmed',guest_name:str(f.guest_name,120),guest_phone:str(f.guest_phone,60),adults:o.adults,children:o.children,kids_ages:ages,
      resort_name:str(f.resort_name,200),resort_phone:str(f.resort_phone,100),location:str(f.location,300),map_url:null,check_in:o.check_in,check_out:o.check_out,nights:nightsBetween(o.check_in,o.check_out),
      checkin_time:p.checkin_time??'',checkout_time:p.checkout_time??'',rooms:roomsLabel(o,names),meal_plan:o.meal_plan?MEAL_PLANS[o.meal_plan]??o.meal_plan:'Room only',
      amenities:parseJson<string[]>(p.facilities,[]).map(k=>FACILITIES[k]??k),payments:[],total:o.total,paid:advance,reported_advance:advance,balance,room_rent:rent,subtotal:o.subtotal,discount:o.discount,extras:o.extra_charges,gst:o.taxes,staff_remarks:str(f.remarks,1000),admin_remarks:''}
    await run(c.env,"INSERT OR IGNORE INTO quotation_confirmation_requests(code,quotation_id,option_id,requested_by,submission_key,details) VALUES(?,?,?,?,?,?)",refCode('VC'),q.id,o.id,c.get('user')!.id,f.submission_key,JSON.stringify(d))
    if(!await first(c.env,"SELECT id FROM quotation_confirmation_requests WHERE requested_by=? AND (submission_key=? OR (option_id=? AND status='pending'))",c.get('user')!.id,f.submission_key,o.id)) throw new Error('Could not retain the request. Reopen the form and try again.')
    return redirectMsg(c,'/staff/confirmation-requests',{ok:'Request retained for Admin approval. Duplicate submissions do not create another pending request.'})
  }catch(e){return redirectMsg(c,back,{err:e instanceof Error?e.message:'Could not submit request.'})}
})
async function list(c:Context<AppEnv>, admin:boolean){
 const rows=await all<RequestRow>(c.env,`SELECT * FROM quotation_confirmation_requests ${admin?'':'WHERE requested_by=?'} ORDER BY id DESC LIMIT 200`,...(admin?[]:[c.get('user')!.id]))
 return page(c,{title:admin?'Booking Approvals':'My confirmation requests',area:admin?'admin':'staff',active:admin?'booking-approvals':'confirmation-requests'},<div class="stack"><h1>{admin?'Booking Approvals':'My confirmation requests'}</h1>
 {admin&&<a href="/admin/vouchers">Existing booking-based voucher approvals</a>}
 {rows.length===0&&<p>No requests yet.</p>}{rows.map(r=>{const d=parseJson<Details>(r.details,{} as Details);return <section class="card"><strong>{r.code} · {r.status.toUpperCase()}</strong><p>{d.guest_name} · {d.resort_name} · {money(d.total)} · Advance reported {money(d.paid)}</p>{r.admin_remarks&&<p>Admin remarks: {r.admin_remarks}</p>}<a class="btn btn-outline" href={`/staff/confirmation-requests/${r.id}`}>Review / history{r.status==='approved'?' / Download PDF':''}</a></section>})}</div>)
}
confirmationRoutes.get('/staff/confirmation-requests',requireStaff,c=>list(c,false))
confirmationRoutes.get('/admin/booking-approvals',requireStaff,adminOnly,c=>list(c,true))
confirmationRoutes.get('/staff/confirmation-requests/:id',requireStaff,async c=>{
 const r=await first<RequestRow>(c.env,'SELECT * FROM quotation_confirmation_requests WHERE id=?',int(c.req.param('id')));if(!r||!allowed(c,r))return c.notFound()
 c.header('Cache-Control','private, no-store')
 const d=parseJson<Details>(r.details,{} as Details), history=await all<{status:string;remarks:string;created_at:string;name:string}>(c.env,'SELECT a.*,u.name FROM quotation_confirmation_audit a JOIN users u ON u.id=a.actor_id WHERE request_id=? ORDER BY a.id',r.id)
 return page(c,{title:r.code,area:c.get('user')!.role==='admin'?'admin':'staff',active:'confirmation-requests'},<div class="stack"><h1>{r.code} · {r.status.toUpperCase()}</h1><section class="card stack"><h2>{d.resort_name}</h2><p>{d.location} · Resort contact: {d.resort_phone}</p><p>{d.guest_name} · {d.guest_phone} · {d.adults} adults · {d.children} kids · Ages: {d.kids_ages||'No kids'}</p><p>{d.rooms} · {d.check_in} → {d.check_out} · {d.meal_plan}</p><p>Total Room Rent (after discount): {money(d.room_rent)} · Full booking total: {money(d.total)} · Advance reported by staff: {money(d.reported_advance ?? d.paid)} · Advance Received: {money(d.paid)} ({r.status==='approved'?'verified by Admin':'not yet verified'}) · Balance: {money(d.balance)}</p><p>Balance amount to be paid at the hotel at check-in time.</p><p>Saved subtotal: {money(d.subtotal)} · Discount: {money(d.discount)} · Extras: {money(d.extras)} · GST: {money(d.gst)}</p><p>Amenities: {d.amenities.join(' · ')||'Not supplied'}</p>{d.staff_remarks&&<p>Staff remarks: {d.staff_remarks}</p>}{r.admin_remarks&&<p>Admin remarks: {r.admin_remarks}</p>}
 {r.status==='approved'?<><p>Advance and resort availability explicitly verified by Admin on {r.decided_at}. This is not an independent payment-gateway verification.</p><a class="btn" href={`/staff/confirmation-requests/${r.id}/print`} target="_blank">Open approved voucher / Download PDF</a><p class="small">Download the PDF, then share the file using your device.</p></>:<p>No official confirmed voucher is available.</p>}</section>
 {c.get('user')!.role==='admin'&&r.status==='pending'&&<section class="card stack"><h2>Edit pending confirmation details</h2><p class="small muted">Stay categories, dates and saved amounts come from the quotation. Correct those in the quotation and submit a new request if they need changing; this editor never reprices a stay.</p><form method="post" action={`/admin/booking-approvals/${r.id}/edit`} class="stack" data-confirmation-edit><input type="hidden" name="revision" value={r.revision}/><div class="grid grid-2">
 <Field label="Guest Name"><input name="guest_name" value={d.guest_name} required maxlength={120}/></Field><Field label="Guest Contact Number"><input name="guest_phone" value={d.guest_phone} required maxlength={60}/></Field>
 <Field label="Resort Name"><input name="resort_name" value={d.resort_name} required maxlength={200}/></Field><Field label="Resort Contact Number"><input name="resort_phone" value={d.resort_phone} required maxlength={100}/></Field>
 <Field label="Location"><input name="location" value={d.location} required maxlength={300}/></Field><Field label="Kids' Ages"><input name="kids_ages" value={d.kids_ages} maxlength={120}/></Field>
 <Field label="Total Room Rent ₹ (after discount)"><input type="number" name="room_rent" value={d.room_rent} min="0" max={d.subtotal-d.discount} required/></Field><Field label="Advance Received (₹)"><input type="number" name="advance" value={d.paid} min="0" max={d.total} required/></Field></div><p>Total Quotation Amount: {money(d.total)} · Balance Amount: {money(d.balance)}</p><button class="btn">Save Admin edits</button></form></section>}
 {c.get('user')!.role==='admin'&&r.status==='pending'&&<form method="post" action={`/admin/booking-approvals/${r.id}/decision`} class="card stack"><input type="hidden" name="revision" value={r.revision}/><Field label="Admin remarks"><textarea name="remarks" maxlength={1000}/></Field><label><input type="checkbox" name="payment_verified" value="1"/> I have verified the reported advance and approved payable amount.</label><label><input type="checkbox" name="availability_verified" value="1"/> I have verified these room categories and dates with the resort.</label><div class="row"><button name="decision" value="approved" class="btn" data-confirmation-approve>Approve and issue voucher</button><button name="decision" value="rejected" class="btn btn-outline">Reject request</button></div></form>}
 <section class="card"><h2>Approval history</h2>{history.map(h=><p>{h.created_at} · {h.name} · {h.status} · {h.remarks}</p>)}</section></div>)
})
confirmationRoutes.post('/admin/booking-approvals/:id/edit',requireStaff,adminOnly,async c=>{
 const id=int(c.req.param('id')),back=`/staff/confirmation-requests/${id}`,f=await form(c)
 const r=await first<RequestRow>(c.env,'SELECT * FROM quotation_confirmation_requests WHERE id=?',id);if(!r)return c.notFound()
 if(r.status!=='pending')return redirectMsg(c,back,{err:'Approved and rejected snapshots cannot be edited. Submit a new request.'})
 const old=parseJson<Details>(r.details,{} as Details)
 try {
  const advance=number(f.advance??''), rent=number(f.room_rent??'')
  if(!Number.isSafeInteger(advance)||advance<0||advance>old.total)throw new Error('Advance Received must be between ₹0 and the full payable amount.')
  if(!Number.isSafeInteger(rent)||rent<0||rent>old.subtotal-old.discount)throw new Error('Room rent must be within the saved net subtotal.')
  for(const key of ['guest_name','guest_phone','resort_name','resort_phone','location'])if(!f[key]?.trim())throw new Error('Complete the required guest and resort details.')
  const next:Details={...old,reported_advance:old.reported_advance??old.paid,paid:advance,balance:old.total-advance,room_rent:rent,guest_name:str(f.guest_name,120),guest_phone:str(f.guest_phone,60),resort_name:str(f.resort_name,200),resort_phone:str(f.resort_phone,100),location:str(f.location,300),kids_ages:validateKidsAges(old.children,f.kids_ages??'')}
  const won=await c.env.DB.prepare("UPDATE quotation_confirmation_requests SET details=?,edited_by=?,edited_at=?,revision=revision+1,payment_verified=0,availability_verified=0 WHERE id=? AND status='pending' AND revision=? RETURNING id").bind(JSON.stringify(next),c.get('user')!.id,nowIso(),id,int(f.revision)).first()
  return redirectMsg(c,back,won?{ok:'Admin edits saved. Review and explicitly verify before approval.'}:{err:'The request changed. Reload before editing.'})
 }catch(e){return redirectMsg(c,back,{err:e instanceof Error?e.message:'Could not save edits.'})}
})
confirmationRoutes.post('/admin/booking-approvals/:id/decision',requireStaff,adminOnly,async c=>{
 const f=await form(c),id=int(c.req.param('id')),back=`/staff/confirmation-requests/${id}`
 const r=await first<RequestRow>(c.env,'SELECT * FROM quotation_confirmation_requests WHERE id=?',id);if(!r)return c.notFound()
 if(r.status!=='pending')return redirectMsg(c,back,{err:'This request has already been decided.'})
 if(!['approved','rejected'].includes(f.decision))return c.text('Invalid decision',400)
 if(f.decision==='approved'&&parseJson<Details>(r.details,{} as Details).paid<=0)return redirectMsg(c,back,{err:'A positive advance must be received and verified before issuing a confirmed voucher.'})
 if(f.decision==='approved'&&(f.payment_verified!=='1'||f.availability_verified!=='1'))return redirectMsg(c,back,{err:'Explicitly verify the advance and resort availability before approval.'})
 if(f.decision==='rejected'&&!f.remarks?.trim())return redirectMsg(c,back,{err:'Enter remarks explaining the rejection.'})
 const result=await c.env.DB.prepare("UPDATE quotation_confirmation_requests SET status=?,admin_remarks=?,payment_verified=?,availability_verified=?,decided_by=?,decided_at=? WHERE id=? AND status='pending' AND revision=? RETURNING id").bind(f.decision,str(f.remarks,1000),f.decision==='approved'?1:0,f.decision==='approved'?1:0,c.get('user')!.id,nowIso(),id,int(f.revision)).first()
 return redirectMsg(c,back,result?{ok:'Decision recorded. The requester can view the result in their account.'}:{err:'The request changed or was decided. Reload and review the saved details before approving.'})
})
confirmationRoutes.get('/staff/confirmation-requests/:id/print',requireStaff,async c=>{
 const r=await first<RequestRow>(c.env,'SELECT * FROM quotation_confirmation_requests WHERE id=?',int(c.req.param('id')))
 if(!r||!allowed(c,r)||r.status!=='approved')return c.notFound()
 c.header('Cache-Control','private, no-store')
 const d=parseJson<Details>(r.details,{} as Details)
 return c.html(voucherHtml({...d,admin_remarks:r.admin_remarks,payment_verified:true},{code:r.code,issued:r.decided_at}))
})
