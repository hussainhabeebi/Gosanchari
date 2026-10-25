# Recoverable quotation archive

## Behaviour

Staff use Quotations → Actions → Delete. The dialog identifies the quote and asks:

> Are you sure you want to remove this quotation? It will disappear from your active quotation list. This action will not cancel any booking or payment.

Cancel, Escape and backdrop dismissal do not submit. The optional reason, actor and timestamp are retained. A server-rendered confirmation page works without dialog/JavaScript support. Staff can archive their own quotes; existing explicit cross-staff management permissions continue to apply. Unassigned quotes require those explicit permissions.

Admin uses Active / Archived in Quotations, then View archive / Restore. Archived details and prior quotation-review history remain read-only. Restore is Admin-only, eligibility checked again, and audited. It retains the original lifecycle status and amounts. Previously issued customer links become available again after explicit restoration; the restore confirmation explains this.

Archive is independent of quotation status: no records are permanently deleted, no business statuses are rewritten, and the single final booking-approval workflow remains unchanged. Eligible customer-accepted offers without financial/operational dependencies may also be archived; acceptance alone is not a confirmed booking.

## Eligibility and security

The database view `quotation_archive_eligibility` is the single eligibility source for both UI and transition triggers. Archiving is blocked by:

- Any non-cancelled booking, including pending bookings.
- Current reported advance or payment metadata, or positive reported-advance audit history even if Staff later clears the amount.
- Pending/approved final confirmation, or retained financial evidence in a rejected request.
- Booking payments/refunds/paid balances or non-unpaid financial status, including historical refunded payments.
- Pending/approved official vouchers or financial evidence in a rejected voucher.
- Active future/current room holds. Archiving never releases inventory.

This deliberately retains financial evidence conservatively; zeroing an advance is not a way to hide payment history. Cancelled/rejected records with no such dependencies remain eligible and are retained unchanged.

Transition triggers check eligibility atomically with the archive/restore update. Reverse guards prevent new advances, confirmation requests, bookings, holds, payments/refunds or vouchers after archive. Thus a concurrent dependency either commits first and blocks archive, or archive commits first and blocks the dependency. Revision/current-quotation checks prevent stale or duplicate archive/restore actions. The audit write is part of the same SQL statement: an audit failure rolls back the transition. Archive audit entries cannot be updated/deleted.

Existing ownership/role checks and global CSRF middleware remain enforced. Active quote loaders reject archived records, covering edit, pricing preview, download, share/send, options, duplication, advance and confirmation routes. Customer token GET/POST endpoints return not found without exposing the quote and use private/no-store responses. Guest quote lists, active CRM quote/follow-up lists, calendar selectors and background quote jobs exclude archived records. Related tasks/history remain stored and can resume after restore.

Previously downloaded PDFs, copied text or already-sent messages cannot be recalled. A previously opened screen cannot be erased remotely; future requests are denied and stale writes are guarded. No public record cleanup or external test messages are part of this feature.

## Migration and compatibility

`0022_quotation_archive.sql` is additive: six archive/restore metadata columns on quotations, supporting indexes, an eligibility view and transition/dependency/audit triggers. It contains no UPDATE/DELETE/backfill, no business-status rebuild, and no changes to applied migrations 0001–0021. Existing quotation, option, payment, booking, approval and voucher values remain unchanged. Local migration validation includes foreign-key checks and preservation assertions. No new resources or dependencies are required.

Production prerequisites before merging (merge triggers the existing deployment pipeline):

1. Re-fetch main and compare the final PR diff. Verify the production Worker version and D1 ledger, with 0021 applied and 0022 pending; reconcile any newer migration numbering rather than assuming it.
2. Verify the existing production D1 UUID `04eb5123-059a-45fb-ae10-6541ad1ae92a` and KV resource identity. Deployment safeguards are unchanged and must remain fail-closed.
3. Record and verify a fresh production Time Travel bookmark or UTC restore timestamp and retention, plus the active Worker version. A historical recovery point outside retention is insufficient.
4. Verify production branch main, build `npm run build`, deploy `npm run deploy`. The existing deploy script verifies resources, applies migrations, stops on migration failure, then activates the Worker. Do not execute separate remote migration commands or provision resources.
5. Full tests, TypeScript, JS syntax, Worker dry-run, required checks and reviews must pass. Investigate failed Preview checks separately; do not bypass branch protection.
6. Merge only after the recovery/production prerequisites are verified. Monitor the automatic production build; stop on failure without retrying automatically.

Rollback: before any quotations are archived, the previous Worker can coexist with the additive metadata. Once archival is in use, **do not roll back to a Worker that ignores archived_at**: that could expose old customer links or break housekeeping. Preserve the archive-aware access guards in any rollback/forward fix. Do not restore a database checkpoint, unarchive records or disable guards without separate operational approval; those actions may affect subsequent legitimate business activity.

## Manual acceptance (isolated test accounts/data)

- Desktop/tablet/mobile: Actions menu, exact dialog text, Delete/Cancel, optional reason, Escape/backdrop and focus restoration. Dialog must fit the viewport; tables retain their existing horizontal scrolling.
- Archive an eligible local draft and sent quote; verify it disappears from Staff/Admin active lists, guest portal and follow-ups. Admin can inspect its saved values and immutable audit, then restore original status/amounts. Check issued-link revival is explicit.
- Try another Staff account, unassigned quote, manager with explicit permissions, guest and absent CSRF. No unauthorized mutation or archive listing.
- Verify live-page UI after deployment without clicking Delete/Restore on real customers, opening `/staff/quotes/new`, or submitting enquiries/payments/approvals/vouchers.
- Confirm advances/evidence, bookings, vouchers, pending confirmations and holds block deletion with clear reasons. Verify no preliminary quotation-approval stage reappears.
- Automated local tests cover both archive/dependency write orderings, duplicate submissions, audit rollback and unchanged historical records. Physical Android/iPhone and authenticated live UI checks require authorised access.
