# Single final booking approval

## Staff workflow

1. Create/edit a quotation as usual. Rooms, combined capacity, rates, Staff floors, discounts, extras and GST use the existing server calculations.
2. **Save Draft** retains an editable offer. **Generate / Download Quotation** saves the form and opens the existing HTML-to-PDF download. Neither action requests approval, sends messages, reserves rooms or verifies money.
3. **Share Quotation** saves and validates the offer, publishes its existing private customer link and shows the manual WhatsApp sharing link. Staff must deliberately open/send the message. An offer is not a confirmed booking.
4. After receiving an advance, open **Record Advance Payment**, select the correct option and record the whole-rupee amount, actual payment date, method and optional transaction reference. The balance is that option's full saved payable amount minus reported advance. These details are not Admin verification and do not create a payment ledger entry.
5. Open **Request Booking Confirmation**, select the agreed option, review saved categories, dates, guests, full total and reported payment, complete resort contact/kids ages/room rent, and submit once. The selected option and payment details are captured in the pending request. Duplicate pending/approved requests for the same quotation are refused.
6. Check **Confirmation requests** for Admin remarks. A rejected/correction request can be corrected and resubmitted. After approval, use **Open approved voucher / Download PDF**; only this final approval produces an official confirmed voucher.

Proof attachments are not supported by the existing private media model. No public R2/media upload is used for financial evidence. Keep proof securely outside the application for Admin to review; do not include card/bank credentials in remarks.

## Admin workflow

1. Open **Booking Approvals**, then the pending request. The former preliminary quotation Approve/Reject URLs are retired without changing historical audit records.
2. Review room categories/dates, guest and resort contacts, full payable amount, reported advance, payment date/method/reference and actual external receipt evidence.
3. Use the existing pending-request editor for permitted corrections, save, then review the saved revision. Corrections remain audited and clear verification flags.
4. Independently check actual payment receipt and resort availability. Approval requires both explicit verification checkboxes, a positive valid advance and the currently reviewed request revision.
5. Choose **Approve and issue voucher** or **Reject / Request corrections** with a reason. A quotation or payment edited after submission cannot be approved from a stale snapshot; reject it and have Staff submit the corrected details.
6. Approved snapshots and audit history remain immutable. No booking/payment ledger or inventory writes occur merely from recording an advance, submitting or approving a confirmation request. The legacy booking conversion endpoint now requires a final Admin approval and uses that approval's selected option.

## Compatibility and migration

- Additive `0021_quotation_advance_details.sql` adds JSON `quotation_options.advance_details`, default `{}`. No historical statuses, prices, advances, payment records, approvals or vouchers are rewritten/backfilled. Existing schema/migrations 0001–0020 remain unchanged.
- Legacy preliminary pending/rejected statuses display as drafts and can be edited/issued directly. Preliminary decisions remain accessible as historical approval history. Old preliminary submission/decision endpoints cannot mutate state.
- Existing accepted and final-confirmed quotations remain locked; duplicate them for a different offer. Existing historical pending confirmation snapshots lacking the new metadata retain the existing Admin verification process, and historical approved vouchers remain available.
- Existing quoted amounts change only when an authorised user deliberately saves/recalculates an editable quotation. The pricing engine, staff floor enforcement, GST and rate visibility are unchanged.
- Changing the reported amount in the ordinary quotation form clears its old evidence metadata. Complete the dedicated payment page before submitting a new final request. Same-amount detail corrections remain audited.
- New payment metadata stays on authorised Staff/Admin pages and approval snapshots; transaction references do not appear in customer quotations or vouchers.

## Review and rollout gates

This branch is for pull-request review only. Do not merge/deploy until separately approved. No production data or migrations were used for validation.

Before an approved rollout, verify the latest production migration ledger has 0001–0020 and no conflicting 0021; reconcile any newer main changes, record the current Worker version and a fresh D1 recovery checkpoint, and verify production resources/build branch. The existing deployment script applies pending migrations before activating Worker code, so this release necessarily requires separately approved application of 0021. Do not run that script, a remote migration or a preview using production bindings during PR review. No deployment scripts/bindings/resources are changed by this feature.

If a rollback is authorised after migration, the nullable-free JSON column is additive and can remain when reverting Worker code. Do not drop it or alter immutable approved records. Confirm actual rollback steps and current recovery retention before any production operation.

## Manual acceptance checklist

Use an isolated local/staging database and test accounts; no production enquiries, messages, payments, bookings or vouchers.

- Desktop and 390px/768px layouts: quotation actions wrap without overlapping; payment form labels, option selector, balance and errors remain readable and keyboard accessible.
- One and multiple quotation options/categories: save, download and deliberately share without preliminary review; correct customer link and non-confirmation notice; no Staff/B2B values or payment reference in customer output.
- Record advance on option B, reload and confirm option A is unchanged. Check zero/full/excess advance, future/impossible date, invalid method, stale tab and amount-change evidence reset.
- Submit final request twice; retain one pending snapshot for the selected option. Another Staff account cannot view it or its PDF. Staff/manager cannot approve, edit or manufacture verified flags.
- Admin review/correct/save, then attempt approval without each verification and with an old revision. No official voucher. Reject with remarks, correct and resubmit.
- Change the quote/payment after submission: Admin must not approve the stale snapshot, including concurrent changes. Complete a fresh request, both checks and approval; Staff can download its frozen A4 voucher. Repeat decisions/submissions cannot produce another approval.
- Existing legacy preliminary-approved quotations, pending requests and historical vouchers remain accessible. Quotation PDFs remain offers until actual final confirmation. Verify Remarks, amenities, totals and existing PDF pagination/logo/mobile download.
- No real external notifications or production mutations are part of this checklist. Real-device Android/iPhone and authenticated operational acceptance require separate approval and test accounts.
