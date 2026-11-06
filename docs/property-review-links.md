# Property-based guest review links

Staff or Admin with the existing **manage_bookings** permission can open **Reviews → Review Links** (`/staff/review-links`). Admin can also select **Generate Review Link** from **Admin → Reviews**. No new role permissions or moderation rights are granted.

1. Search for an existing Live property by name or destination and select it.
2. Generate one private link for one guest. Copy Link or Share via WhatsApp opens manual sharing; nothing is sent automatically.
3. The guest opens the link without a login, booking or OTP and enters their own name, 1–5 stars, feedback and optional photos.
4. The review enters the existing Admin → Reviews moderation queue. Approve publishes it on the selected property; Hide rejects/removes it from public display.

## Security and limitations

- Links have 256-bit random tokens, with only SHA-256 hashes stored. Raw tokens appear once to the issuing user and travel in URL fragments, not query strings or access-log paths. Copy the link immediately; revoke and create a new one if it is lost.
- Each link expires in 30 days and accepts one review, including hidden/rejected reviews. Multiple guests need separate links. One review per **link**, not a verified person or booking, is enforceable without login/identity verification. Never label these as verified stays.
- Staff can see/revoke their own links; Admin can manage all. Submitted feedback is moderated through existing permissions. Signed-in Staff/Admin cannot submit via the guest form.
- Expiry, revocation, Live property visibility and unused state are rechecked at submission. A unique database index prevents concurrent duplicate submissions. Revocation does not silently remove submitted reviews; use moderation for submitted content.
- Issuance/revocation and submission audit entries are database triggers committed with the corresponding write. Audit records contain identifiers, never bearer tokens.
- Existing CSRF checks, IP/issuer rate limits, hidden spam trap, bounded inputs and content-sniffed JPEG/PNG/WebP/AVIF uploads apply. Up to four photos, each at most 4 MB. Photos use the existing private R2 path and stay private until moderation approval.
- The existing KV rate limiter is best-effort under concurrent requests; database uniqueness is the strict single-use guarantee. Rate limits and moderation reduce spam; a link can be forwarded and cannot prove reviewer identity.
- Guest links remain noindex, no-store, no-referrer and excluded from analytics and sitemap through the existing `/review-stay` flow.
- PR #28's booking-linked path is unchanged. PR #29 and bot sending are excluded. Existing post-review moderation/notification jobs are reused; no new outbound-message integration is added.

## Migration and rollout

`0026_property_review_links.sql` creates one invitation table, adds a nullable review link foreign key and unique index to `reviews`, and adds audit triggers. Existing reviews receive NULL in the new column. No historical review, booking, payment, pricing, property or photo value is rewritten. No applied migration is edited.

Before merging, independently confirm the current production D1 ledger includes `0025_booking_review_links.sql`, verify no conflicting migration has landed, and obtain a fresh production recovery checkpoint. The prior PR #28 checkpoint predates this release and is not independently proof of the current ledger. PR #29 must use the next unused migration number if ever resumed.

Use only the existing GitHub → Cloudflare production workflow. The fail-closed deploy script verifies the existing D1/KV identities, applies pending migrations and activates the Worker only after migration success. Never manually apply production migrations or create replacement resources for this release.

Validate clean installation and upgrade through 0025 in isolated SQLite/D1. Confirm all prior migration bytes and representative historical records remain unchanged. After deployment confirm the 0026 ledger row and Worker version. Test authenticated Staff/Admin navigation read-only. Do not generate production links, submit fake reviews or change genuine customer records for verification.

For rollback leave the additive schema and private uploads intact; an older Worker ignores the new nullable column and cannot open property-only invitations. Already published reviews still use the existing moderation system. Do not drop tables, clear reviews or delete media as rollback.

## Manual QA (isolated data or separately approved operational test)

- Desktop: search, select, Generate, copy, manual WhatsApp composer, own-link list and revoke.
- Mobile (Android Chrome, iPhone Safari): sidebar access, selectable property names, wrapping controls, horizontally scrollable link-history table; readable guest rating, text and upload controls.
- Separate signed-out browser: open a fresh link, verify correct property/no booking information, submit once, reload and confirm duplicate rejection. Test expired/revoked/hidden-property links.
- Admin: pending review/photo access, approve then verify matching property page, Hide then verify removal. Existing completed-booking links and account reviews must still work.
