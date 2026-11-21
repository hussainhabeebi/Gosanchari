// Eligibility is shared with database transition guards; never decide from status alone.
import type { Env } from '../env'
import { first } from './db'
import { Field } from '../views/components'

export const ARCHIVE_CONFIRMATION = 'Are you sure you want to remove this quotation? It will disappear from your active quotation list. This action will not cancel any booking or payment.'
export async function archiveBlocker(env: Env, id: number): Promise<string | null> {
  return (await first<{reason:string|null}>(env,'SELECT reason FROM quotation_archive_eligibility WHERE id=?',id))?.reason ?? null
}
export function QuotationArchiveDialog() {
  return <dialog class="quotation-archive-dialog" data-quotation-archive-dialog aria-labelledby="quotation-archive-title"><form method="post" class="stack" data-quotation-archive-form>
    <h2 id="quotation-archive-title">Delete quotation <span data-quotation-archive-code/></h2><p>{ARCHIVE_CONFIRMATION}</p><p class="small muted">The record and audit history will be retained. Only Admin can restore it.</p>
    <input name="reviewed_at" type="hidden"/><input name="archive_revision" type="hidden"/>
    <Field label="Reason (optional)"><textarea name="reason" maxlength={500} rows={2}/></Field>
    <div class="row wrap-row"><button class="btn btn-danger" data-archive-submit>Delete quotation</button><button class="btn btn-outline" type="button" data-archive-cancel>Cancel</button></div>
  </form></dialog>
}
