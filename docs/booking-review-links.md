## Staff and Admin workflow

Open a booking, mark the stay completed through the existing booking workflow, and after the checkout date open **Guest review → Send Review Link**. The assigned staff member or an Admin with booking permissions can issue it. An approved voucher without a Booking record is not an eligible stay. Use the existing approved quote-to-booking conversion when appropriate; sending an invitation never creates or modifies a booking.

Copy the private link or open the WhatsApp composer to share it with the guest. Nothing is sent automatically by the dashboard. Replacing or revoking a link invalidates the previous URL and any verification code tied to it. The 30-day link contains an opaque token in the URL fragment, which is exchanged in a POST and kept in a scoped HTTP-only cookie. No customer, booking, price, or property ID is present in the URL.

Guests open the link, request a verification code to the WhatsApp number saved on the booking, and submit a rating, feedback and up to four photos. No account is created. Staff sessions and staff phone numbers cannot verify reviews. A review is saved as pending and handled by **Admin → Reviews**; only approved reviews and their photos appear publicly. The existing booking-level uniqueness constraint covers both guest submission paths.

## Release and verification

- Migration `0024_booking_review_links.sql` only creates a table and its uniqueness constraints. It does not rewrite booking, payment, or review data. No new Cloudflare resources are needed.
- Before merging, confirm the production D1 ledger is current through 0023, 0024 is pending, and a current recovery point and active Worker version are recorded. Verify the production deploy settings still apply migrations to the existing D1 before activation. Do not run a separate remote migration or seed operation.
- Verify production has the existing WhatsApp credentials, an approved `otp` authentication template and `SESSION_SECRET`. Check their availability without exposing values. The review flow does not use the login OTP records and fails closed without working WhatsApp delivery.
- For local acceptance use an isolated completed booking and mocked WhatsApp delivery. On desktop and mobile open the link, verify the resort, request a code, check the star controls, enter text, attach photos, and confirm the moderation flow. Check private photos cannot be fetched before approval or after hiding.
- In production, verify the dashboard control on an existing eligible booking and the generic review landing page read-only. Do not submit a fake review or send a test code to a real guest. OTP delivery and guest form visual checks need an authorized test number and a test stay in an isolated environment.
- If rollback is necessary, leave the additive table intact. Photos use the existing private storage prefix. An older Worker will deny all access to these photos, including approved ones, until this feature is restored.
