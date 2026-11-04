## Staff and Admin workflow

Open a completed booking after checkout and select **Guest review → Send Review Link**. The assigned staff member or an Admin with booking permissions can copy the private link and share it manually on WhatsApp. Sending is never automatic. An approved voucher without a booking record is not eligible.

The link expires after 30 days. Staff can replace or revoke it. Share it only with the guest: anyone with a valid link can submit the one review without login or OTP. The link identifies a booking, but does not verify the identity of the person submitting it. The name shown on the review is entered by the reviewer.

The form displays the resort and accepts a name, 1–5 stars, feedback and up to four photos. The review is saved as pending in **Admin → Reviews**. Approve to publish or hide to keep it off the resort page. Booking-level uniqueness applies to both review paths. Rate limits, a spam trap and image validation protect the form. New review photos stay private until approval.

## Release and verification

- Migration `0024_booking_review_links.sql` is unchanged from the original PR and additive. No existing bookings or reviews are rewritten. Its OTP columns are unused by this manual flow. Migration 0025 and the bot integration are excluded.
- Before merging, verify the live D1 ledger and a current recovery point, and confirm the normal production deployment applies migrations to the existing D1 before activation. No WhatsApp credentials, templates or bot settings are needed for the manual review flow.
- Verify an existing completed booking shows the staff control, and verify the generic guest landing page in production without creating a fake review. Exercise approval, rejection, uploads and link revocation using isolated test data.
- If rollback is necessary, leave the additive table intact. Older Workers deny access to all new review photos under the private storage prefix until this feature is restored.
