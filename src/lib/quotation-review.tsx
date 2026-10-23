// Quotation review is distinct from both delivery status and booking confirmation.
// Use the existing append-only application audit history; no status-table rebuild/backfill.
import type { AppEnv } from '../env'
import { all } from './db'
import { fmtDateTime, parseJson } from './util'
import type { QuotationRow } from './types'
import { Pill } from '../views/components'

export const REVIEW_ACTIONS = "'quote.approval_requested','quote.discount_approved','quote.review_rejected','quote.review_reset'"
// q must be the quotations alias. Old approvals without revision metadata are valid only
// while the draft has not been edited after the audit entry. Never relabel a newer draft.
export const REVIEW_STATUS_SQL = `CASE WHEN q.status='pending_approval' THEN 'pending' ELSE COALESCE((
 SELECT CASE
 WHEN a.action='quote.discount_approved' AND (
   (q.status='draft' AND (json_extract(a.details,'$.quotation_version')=q.updated_at OR
     (json_extract(a.details,'$.quotation_version') IS NULL AND julianday(q.updated_at)<=julianday(a.created_at))))
   OR q.status IN ('sent','viewed','accepted','expired','declined')) THEN 'approved'
 WHEN a.action='quote.review_rejected' AND q.status='changes_requested' THEN 'rejected'
 ELSE 'none' END FROM activity_log a WHERE a.entity='quotation' AND a.entity_id=CAST(q.id AS TEXT)
 AND a.action IN (${REVIEW_ACTIONS}) ORDER BY a.id DESC LIMIT 1), 'none') END`
export function QuotationStatus({ q }: { q: Pick<QuotationRow,'status'|'review_status'> }) {
  // Legacy review decisions stay in history; they no longer gate issuing an offer.
  if (q.status === 'pending_approval' || q.status === 'changes_requested') return <Pill s="draft" />
  return <Pill s={q.status} />
}
export async function quotationReviewHistory(env: AppEnv['Bindings'], id: number) {
  return all<{ id: number; action: string; details: string; created_at: string; name: string | null }>(env,
    `SELECT a.id,a.action,a.details,a.created_at,u.name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.entity='quotation' AND a.entity_id=? AND a.action IN (${REVIEW_ACTIONS},'quote.admin_edited') ORDER BY a.id DESC`, String(id))
}
export function ReviewHistory({ history }: { history: Awaited<ReturnType<typeof quotationReviewHistory>> }) {
  if (!history.length) return null
  const labels: Record<string,string> = {'quote.approval_requested':'Pending Approval','quote.discount_approved':'Quotation Approved','quote.review_rejected':'Rejected','quote.review_reset':'Reopened / saved to draft','quote.admin_edited':'Admin edits saved'}
  return <section class="card stack" data-quotation-review-history><h2>Historical quotation approval history</h2>{history.map(row => {
    const details = parseJson<{reason?:string}>(row.details,{})
    return <p>{labels[row.action]} · {row.name ?? 'Recorded reviewer'} · {fmtDateTime(row.created_at)}{details.reason && <><br />Reason: {details.reason}</>}</p>
  })}<p class="small muted">Historical decisions are retained. Only final booking approval verifies payment and availability and issues a booking voucher.</p></section>
}
