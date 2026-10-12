# Quotation and confirmation rollout record

Status: ready for final publishing approval, based on the user-verified production dashboard findings and local checks. No commit, push or deployment authorized yet.
No commit, push, deployment, production migration or restore has been performed.

## Production target

- Repository: hussainhabeebi/Gosanchari
- Cloudflare Worker: gosanchari
- Production branch: main (Cloudflare settings remain unchanged)
- Prepared main base: aa367f72c8d9a581a58baa3372ab9314178b5cb2
- Other branch: claude/beautiful-gauss-il0sjt at f8a05e6dca3c26812505840167c3b3f644805c09
- That other branch's thumbnail refinement is not included or overwritten. The main thumbnail implementation is retained.
- Dashboard-confirmed build command: npm run build
- Dashboard-confirmed deploy command: npm run deploy
- Dashboard-confirmed root: /
- Production DB: gosanchari; binding DB; UUID 04eb5123-059a-45fb-ae10-6541ad1ae92a
- Existing KV: gosanchari-kv; binding KV

## Migration identity

The only new migration is 0015_quotation_review.sql. It is the unpublished
quotation confirmation request/audit migration previously named
0015_quotation_confirmation_requests.sql. Its SQL is unchanged by the rename.
Do not ship both filenames.

The user verified production d1_migrations through 0014 and reported that the
voucher migration is not applied. The repository contains no remote 0015.
A fresh authenticated ledger check before publishing must confirm that neither
0015 filename has subsequently been applied; numbering alone is not proof.

The migration creates approval/audit tables, indexes and triggers. It does not
rewrite existing quotation, booking, property, room, rate or payment records.

## Deployment safeguards

wrangler.toml pins the approved D1 UUID. scripts/deploy.mjs verifies the remote
UUID/name and a unique existing KV namespace before migrations. Missing,
inaccessible or mismatched resources stop the script. There are no D1/KV
creation, seed, reset or restore paths. Configuration/environment overrides are
rejected by the production entry point.

The verified binding targets migrations, then the Worker is activated only after
migration success. A failed migration or deployment is not automatically retried.
Previously successful migrations can remain applied after a later migration fails.

## Pre-deployment recovery checkpoint

- Previously observed active Worker version, supplied by the user: e8d7c4d9-e9fd-4918-a3a7-c939923749a1
- Current active-version verification: user dashboard verification reports prefix e8d7c4d9, 100% production traffic, Ready and 0% observed errors; matches the previously recorded full version above. The fresh dashboard display verifies the prefix, not independently the full UUID.
- D1 UTC restore timestamp (bookmark fallback): 2026-10-12T11:07:58Z
- UTC capture/window check time: 2026-10-12T11:07:58Z
- Seven-day retention boundary for this timestamp: 2026-10-19T11:07:58Z (refresh before this boundary)
- Exact database UUID: 04eb5123-059a-45fb-ae10-6541ad1ae92a
- Time Travel retention: seven days, confirmed by the user through the production dashboard
- Window check: PASS at 2026-10-12T11:24:17Z, based on UTC clock and user-confirmed seven-day retention; no D1 restore/query executed
- Time Travel bookmark: not retrieved; the explicitly approved UTC timestamp alternative is used

This timestamp is a documented intended restore target, not a completed restore or
an independently verified server bookmark. No production D1 command was executed.
Refresh the timestamp immediately before a later approved rollout and recheck the
seven-day window. Recovery to it would discard subsequent writes; review those
transactions before any separately approved restore.

## Final production evidence

The user manually verified the production dashboard: production branch main;
Worker prefix e8d7c4d9 with 100% traffic, Ready, 0% observed errors; migrations
0011, 0012, 0013 and 0014 applied; no 0015 in the ledger. This matches the recorded
baseline. There is no evidence of an intervening active-version or ledger change.
A migration ledger does not prove absence of untracked manual schema changes; no
such changes have been reported, and this environment did not inspect production
schema directly. Ordinary application writes do not invalidate retention, but
restoring the checkpoint would discard subsequent writes.

This readiness relies on the user's production dashboard verification, not an
independent authenticated Cloudflare read by this environment. The production
branch remains main; no dashboard settings were changed.

The final Git fetch confirms main is still at
aa367f72c8d9a581a58baa3372ab9314178b5cb2, matching the prepared base. The approved
diff passes whitespace checks and remains limited to quotation/confirmation
changes, deployment hardening, tests and this rollout record. Existing migrations
0006, 0007 and 0014 are unchanged. Final local checks rerun: 289/289 tests across 33 test files, TypeScript,
Worker dry-run and diff whitespace checks passed. Earlier fresh local migration
validation remains accepted. No implementation code was changed in this check.

Immediately before an approved push, freshly confirm the active Worker version,
production branch and migration ledger, and refresh/check the UTC timestamp above.
Keep this record outside production application data. No push is authorized by
this readiness assessment alone.

## Rollback procedure (documentation only)

1. Stop the rollout after any failed build/deployment. Do not retry automatically.
2. If activation never happened, retain the existing active Worker. Inspect the
   migration ledger to determine whether the additive migration committed.
3. If code rollback is needed, redeploy the recorded pre-rollout Worker version.
   Retain additive tables/data; old code ignores them. Do not drop tables merely
   to undo code activation.
4. If database restoration is genuinely necessary, first pause writes and review
   all transactions since the checkpoint. Time Travel overwrites the database in
   place, including newer bookings/payments and the migration ledger. Restore only
   to the recorded bookmark/timestamp on the exact approved database with explicit approval.
5. Verify the restored Worker/schema combination, quotation totals, existing
   property pricing and ownership/approval protections before resuming writes.

No rollback or restore command has been executed.

## Publishing sequence (only after final approval)

1. Fetch main again; stop if its HEAD differs from the recorded base, pending reconciliation.
2. Check the approved 22-file scope and ensure no implementation changes occurred after validation; rerun checks if code changes.
3. Stage only the approved files, review the staged diff, and create one implementation commit with main as its parent.
4. Push that commit once to main with a normal non-force update; stop on rejection.
5. Cloudflare runs npm run build, then npm run deploy. The hardened deploy script verifies the pinned existing D1 and KV, applies pending migrations including 0015_quotation_review.sql, and only then activates the Worker. No separate production migration command.
6. Monitor Workers Builds: gosanchari and record build ID, migration result, deployed commit and active version. Stop on failure; do not retry automatically.
7. Verify Staff multi-room quotation/draft/recalculation/download, Admin review and verified advance/balance, approved-only confirmation voucher access, and existing pricing/quotation compatibility. Avoid creating synthetic production records merely for verification.

The recorded timestamp remains usable while inside retention; record a fresher UTC
checkpoint close to the approved push if delayed. Never restore without separate
explicit approval and a review of intervening writes.
