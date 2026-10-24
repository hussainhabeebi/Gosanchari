// Recoverable quotation removal. A single guarded UPDATE and its database audit
// trigger win together; no dependent record is deleted or financially altered.
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { requireStaff, requirePerm, permissionsFor } from '../lib/auth'
import { all, first } from '../lib/db'
import { archiveBlocker, ARCHIVE_CONFIRMATION } from '../lib/quotation-archive'
import { quotationReviewHistory, ReviewHistory } from '../lib/quotation-review'
import { roomNames, roomsLabel } from '../lib/quote-rooms'
import type { QuotationRow, QuoteOptionRow } from '../lib/types'
import { fmtDateTime, int, money, nowIso, parseJson } from '../lib/util'
import { Field } from '../views/components'
import { page } from '../views/layout'
import { form, redirectMsg } from './helpers'
import { loadQuoteFor } from './staff-ops'

export const quotationArchiveRoutes = new Hono<AppEnv>()
async function manageable(c:Context<AppEnv>,id:number) {
  const q=await loadQuoteFor(c,id)
  if(!q)return null
  const u=c.get('user')!,p=await permissionsFor(c.env,u.role)
  return q.staff_id===u.id || p.view_all_enquiries ? q : null
}
quotationArchiveRoutes.get('/staff/quotes/:id/archive',requireStaff,requirePerm('manage_quotes'),async c=>{
  const q=await manageable(c,int(c.req.param('id')));if(!q)return c.notFound()
  const blocker=await archiveBlocker(c.env,q.id)
  c.header('Cache-Control','private, no-store')
  return page(c,{title:`Delete ${q.code}`,area:'staff',active:'quotes'},<div class="stack narrow"><h1>Delete quotation {q.code}</h1><p>{q.guest_name}</p>
    {blocker?<p class="flash flash-err">Cannot delete: {blocker}</p>:<form method="post" class="card stack" action={`/staff/quotes/${q.id}/archive`}><p>{ARCHIVE_CONFIRMATION}</p><p class="small muted">The record and history remain recoverable by Admin.</p><input type="hidden" name="reviewed_at" value={q.updated_at}/><input type="hidden" name="archive_revision" value={q.archive_revision??0}/><Field label="Reason (optional)"><textarea name="reason" maxlength={500} rows={2}/></Field><div class="row wrap-row"><button class="btn btn-danger">Delete quotation</button><a class="btn btn-outline" href="/staff/quotes">Cancel</a></div></form>}
    {blocker&&<a href="/staff/quotes">Back to quotations</a>}</div>)
})
quotationArchiveRoutes.post('/staff/quotes/:id/archive',requireStaff,requirePerm('manage_quotes'),async c=>{
  const q=await manageable(c,int(c.req.param('id')));if(!q)return c.notFound()
  const f=await form(c),u=c.get('user')!,p=await permissionsFor(c.env,u.role),back=u.role==='admin'?'/admin/quotes':'/staff/quotes'
  if(f.reviewed_at!==q.updated_at||f.archive_revision!==String(q.archive_revision??0)||String(f.reason??'').trim().length>500)return redirectMsg(c,back,{err:'This quotation changed or the reason is too long. Reload and review before deleting.'})
  const blocker=await archiveBlocker(c.env,q.id);if(blocker)return redirectMsg(c,back,{err:blocker})
  try{
    const changed=await c.env.DB.prepare(`UPDATE quotations SET archived_at=?,archived_by=?,archive_reason=?,archive_revision=archive_revision+1,restored_at=NULL,restored_by=NULL WHERE id=? AND archived_at IS NULL AND updated_at=? AND archive_revision=? AND (staff_id=? OR ?=1) RETURNING id`).bind(nowIso(),u.id,(f.reason??'').trim(),q.id,f.reviewed_at,q.archive_revision??0,u.id,p.view_all_enquiries?1:0).first()
    return redirectMsg(c,back,changed?{ok:'Quotation removed from the active list. Admin can restore the archived record.'}:{err:'This quotation changed. Reload before deleting.'})
  }catch{return redirectMsg(c,back,{err:await archiveBlocker(c.env,q.id)??'Quotation changed or is protected. No quotation was removed.'})}
})
async function archivedForAdmin(c:Context<AppEnv>) {
  if(c.get('user')!.role!=='admin')return null
  return first<QuotationRow & {archived_name:string|null}>(c.env,'SELECT q.*,(SELECT name FROM users WHERE id=q.archived_by) AS archived_name FROM quotations q WHERE q.id=? AND q.archived_at IS NOT NULL',int(c.req.param('id')))
}
quotationArchiveRoutes.get('/admin/quotes/:id/archive',requireStaff,requirePerm('manage_quotes'),async c=>{
  const q=await archivedForAdmin(c);if(!q)return c.notFound()
  const opts=await all<QuoteOptionRow & {property_name:string}>(c.env,'SELECT o.*,p.name AS property_name FROM quotation_options o JOIN properties p ON p.id=o.property_id WHERE quotation_id=? ORDER BY o.id',q.id)
  const names=await roomNames(c.env,opts)
  const events=await all<{action:string;created_at:string;name:string|null;details:string}>(c.env,"SELECT a.*,u.name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id WHERE entity='quotation' AND entity_id=? AND action IN ('quote.archived','quote.restored') ORDER BY a.id DESC",String(q.id))
  const blocker=await archiveBlocker(c.env,q.id)
  c.header('Cache-Control','private, no-store')
  return page(c,{title:`Archived ${q.code}`,area:'admin',active:'all-quotes'},<div class="stack narrow"><h1>{q.code} · Archived</h1><p>{q.guest_name} · {q.status} (retained)</p><p>Archived by {q.archived_name??'Recorded user'} · {fmtDateTime(q.archived_at)}</p><p>Reason: {q.archive_reason||'Not supplied'}</p>
    {opts.map(o=><section class="card stack"><h2>{o.property_name}</h2><p>{roomsLabel(o,names)} · {o.check_in} → {o.check_out}</p><p>{o.adults} adults · {o.children} children · {o.meal_plan||'Room only'}</p><p>Saved subtotal {money(o.subtotal)} · Discount {money(o.discount)} · Extras {money(o.extra_charges)} · GST {money(o.taxes)} · Saved amount {money(o.total)}</p></section>)}
    {(q.inclusions||q.exclusions||q.payment_terms||q.message)&&<section class="card stack">{q.inclusions&&<p>Included: {q.inclusions}</p>}{q.exclusions&&<p>Excluded: {q.exclusions}</p>}{q.payment_terms&&<p>Payment terms: {q.payment_terms}</p>}{q.message&&<p>Remarks: {q.message}</p>}</section>}
    <ReviewHistory history={await quotationReviewHistory(c.env,q.id)}/><section class="card"><h2>Archive history</h2>{events.map(e=><p>{e.action==='quote.archived'?'Archived':'Restored'} · {e.name??'Recorded user'} · {fmtDateTime(e.created_at)} · {parseJson<{reason?:string}>(e.details,{}).reason??''}</p>)}</section>
    {blocker?<p class="flash flash-err">Cannot restore: {blocker}</p>:<form method="post" action={`/admin/quotes/${q.id}/restore`} class="card stack" data-confirm={`Restore ${q.code} to the active quotation list? Its original status and customer link will become available again.`}><input type="hidden" name="archive_revision" value={q.archive_revision??0}/><p>Restore retains the original status and amounts. Previously issued customer links will work again.</p><button class="btn">Restore quotation</button></form>}
    <a href="/admin/quotes?archive=archived">Back to archived quotations</a></div>)
})
quotationArchiveRoutes.post('/admin/quotes/:id/restore',requireStaff,requirePerm('manage_quotes'),async c=>{
  if(c.get('user')!.role!=='admin')return c.text('Admin restore required.',403)
  const q=await archivedForAdmin(c);if(!q)return c.notFound()
  const f=await form(c),back=`/admin/quotes/${q.id}/archive`
  if(f.archive_revision!==String(q.archive_revision??0))return redirectMsg(c,back,{err:'Archive changed. Reload before restoring.'})
  const blocker=await archiveBlocker(c.env,q.id);if(blocker)return redirectMsg(c,back,{err:blocker})
  try{
    const result=await c.env.DB.prepare('UPDATE quotations SET archived_at=NULL,archived_by=NULL,archive_reason=\'\',archive_revision=archive_revision+1,restored_at=?,restored_by=? WHERE id=? AND archived_at IS NOT NULL AND archive_revision=? RETURNING id').bind(nowIso(),c.get('user')!.id,q.id,q.archive_revision??0).first()
    return redirectMsg(c,'/admin/quotes',result?{ok:'Quotation restored with its original status and amounts.'}:{err:'Archive changed. Reload before restoring.'})
  }catch{return redirectMsg(c,back,{err:await archiveBlocker(c.env,q.id)??'Restore could not be recorded safely. No changes were made.'})}
})
