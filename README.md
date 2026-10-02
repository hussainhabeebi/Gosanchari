# Go Sanchari — web portal

Booking, enquiry and back-office portal for Kerala stays (homestays, villas, resorts, houseboats, cottages).
One Cloudflare Worker serves every page, the API, the queue consumer and the cron jobs.

- **Stack:** Cloudflare Workers + [Hono](https://hono.dev) (server-rendered JSX), D1, KV, R2, Durable Objects, Queues, Cron Triggers,
  Workers AI, Vectorize, AI Search (AutoRAG), AI Gateway, Turnstile.
- **Payments:** Razorpay (UPI, cards, net banking). **Messaging:** WhatsApp Cloud API. **Email:** Resend.
- **Rule:** AI suggests, people decide. Prices, payments, bookings, refunds and lead scores are plain code. Every AI feature
  can be switched off in *Admin → Settings*, and the portal keeps working without it.

## Run it locally (no Cloudflare account needed)

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:offline
python3 seed/generate.py && npm run db:seed:offline   # demo data
npm run dev:offline                                    # http://localhost:8787
```

`dev:offline` uses `wrangler.offline.toml`, which leaves out the remote-only bindings (Workers AI, Vectorize, AI Search).
The AI features then fall back to their rule-based paths:
- Smart search uses the built-in sentence parser.
- Property Q&A and the help chat hand over to staff.
- Summaries use plain text.

Use `npm run dev` with `wrangler login` to work against the real AI services.

Without keys, the following integrations run in dry-run mode:

| Missing key | What happens instead |
|---|---|
| WhatsApp | Messages are logged |
| Email | Messages are logged |
| Turnstile | The bot check is skipped |
| Razorpay | The checkout shows a payment simulator. **The simulator is disabled when `ENVIRONMENT=production`.** |

Phone-OTP login shows the code on screen when WhatsApp isn't configured (development only).

**Demo logins.** Every staff account uses the password `GoSanchari@2026`. Remove these accounts or change their passwords before going live.

| Role | Email |
|---|---|
| Admin | admin@gosanchari.com |
| Manager | manager@gosanchari.com |
| Sales | priya@gosanchari.com, arjun@gosanchari.com |
| Accounts | accounts@gosanchari.com |

Guests log in with any phone number (OTP). Demo quote link: `/q/demo-quote-token-1234567890`.

```bash
npm test          # unit tests: pricing, coupons, GST, SQL guard, search parsing, lead score
npm run typecheck
```

Trigger cron jobs locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=30+1+*+*+*"` (daily) or `cron=30+2+*+*+1` (weekly).

## Deploy to Cloudflare

```bash
wrangler d1 create gosanchari                 # put database_id in wrangler.toml (and wrangler.offline.toml)
wrangler kv namespace create KV               # put id in wrangler.toml
wrangler r2 bucket create gosanchari-media
wrangler r2 bucket create gosanchari-kb
wrangler queues create gosanchari-jobs
wrangler vectorize create gosanchari-properties --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index gosanchari-properties --property-name=status --type=string
npm run db:migrate:remote
```

In the Cloudflare dashboard:
1. **AI Gateway:** create a gateway named `gosanchari` (matches `AI_GATEWAY_ID`). Turn on caching and rate limiting, and set a spend alert.
2. **AI Search:** create an instance `gosanchari-kb` with the `gosanchari-kb` R2 bucket as its data source.
   The portal writes property details to `properties/<slug>/details.md`, and FAQs and policies to `general/…`. It asks AI Search to re-index when they change.
3. **Turnstile:** create a widget and put its site key in `TURNSTILE_SITE_KEY` (`[vars]`).
4. **Images (optional):** enable Image Transformations on the zone, then tick the option in *Admin → Settings*.

Secrets (`wrangler secret put NAME`):
`SESSION_SECRET`, `TURNSTILE_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `RESEND_API_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Set `ENVIRONMENT = "production"` and `SITE_URL` in `[vars]`, then `npm run deploy`.

Webhooks:
- **Razorpay:** `https://<site>/webhooks/razorpay` (events `payment.captured`, `payment.failed`, `order.paid`).
- **WhatsApp:** `https://<site>/webhooks/whatsapp`.
- In Meta, create approved templates `otp` (authentication) plus confirmation, reminder and follow-up templates for messages sent outside the 24-hour window.

Seed demo data in production only if you want it: `npm run db:seed:remote`.

## Where each page lives

| # | Page | URL | Code |
|---|---|---|---|
| 1 | Home | `/` | `src/routes/public.tsx` |
| 2 | Search results | `/search` (`?ai=` for the AI line, `?view=map`) | public.tsx |
| 3 | Property details (+ Q&A chat, availability, similar) | `/stay/:slug` | public.tsx |
| 4 | Enquiry form | `/enquiry` | public.tsx |
| 5 | Checkout | `/book` → `/pay/:code` | public.tsx, payments.tsx |
| 6 | Confirmation, invoice, calendar file | `/booking/:code/confirmed`, `/invoice/:code`, `/booking/:code/calendar.ics` | payments.tsx |
| 7 | Login / sign up / Google / forgot password | `/login`, `/signup`, `/auth/google`, `/forgot` | auth.tsx |
| 8 | Offers | `/offers` | public.tsx |
| 9 | About / Contact / Policies | `/about`, `/contact`, `/policies/:kind` | public.tsx |
| 10–17 | My trips, bookings, booking detail, enquiries & quotes, saved, review, profile | `/my…` | guest.tsx |
| 14 | Quotation (no login, from WhatsApp) | `/q/:token` | public.tsx |
| 18 | Help & live chat | `/help` (WebSocket `/chat/ws` → `ChatRoom` Durable Object) | guest.tsx, `src/do/chat.ts` |
| 19–21, 28–30 | Staff dashboard, inbox, enquiry workspace, guests, follow-ups, profile | `/staff…` | staff.tsx |
| 22–27 | Property finder, quote builder, quotes, bookings, booking detail, availability | `/staff/finder`, `/staff/quotes…`, `/staff/bookings…`, `/staff/calendar` | staff-ops.tsx |
| 31–40 | Admin dashboard, properties, rates, offers, all enquiries/quotes/bookings, payments, guests | `/admin…` | admin.tsx |
| 41–47 | Staff & roles, reports, Ask AI, reviews, website content, settings, activity log | `/admin…` | admin2.tsx |

Background work: `src/jobs/queue.ts` (Queues) and `src/jobs/cron.ts` (daily 07:00 IST, weekly Monday 08:00 IST).
WhatsApp inbound (text, voice notes, photos): `src/routes/webhooks.ts`.

## AI features and where they run

All AI calls go through `src/lib/ai.ts`. Each call is checked against its on/off switch and the daily limit, routed through AI Gateway, retried on a fallback model, and logged in `ai_usage`.

| Feature | Service | When it runs | Without AI |
|---|---|---|---|
| Smart search (sentence → filters) | Workers AI small model; KV + Gateway cache | AI search line | Rule parser (`parseQueryRules`) |
| Recommended sort, similar, close matches, staff top 3 | bge-m3 embeddings + Vectorize | Embedding on property save (queue); search is a vector query | Rating / destination ordering |
| Property Q&A | AI Search filtered to the property's folder (or its D1 details) | On question; cached per property | Hand-over to staff (creates an enquiry) |
| Help chat (EN / ML) | AI Search over FAQs and policies | Live chat (Durable Object) | Hand-over to staff |
| Enquiry tags, language and summary | Workers AI | Queue, once per enquiry | Rule tags, Malayalam script detection |
| Reply suggestion, summary refresh, translate | Workers AI, m2m100 | On staff click | Buttons say AI is off |
| Voice notes → text | Whisper | Queue, when a voice note arrives | Audio player only |
| Quote "Fill from enquiry", message draft, explainer | Workers AI (prices are always computed by `pricing.ts`) | On click / once on send | Plain facts stored |
| Guest preference notes | Workers AI | Queue, at most hourly per enquiry | Staff notes |
| Review check, reply draft, daily summary, problem alerts | Workers AI | Queue / Cron | Rule checks (links, phones), plain-number summary |
| Follow-up drafts | Workers AI | Cron (daily) + Queue | Template text |
| Description writer (EN + ML), photo tags, SEO | Workers AI (llava for photos) | On click / photo upload | Manual |
| Ask AI | Workers AI → SQL guard → read-only views | On question; cached 1 hour | Disabled message |

Ask AI safety:
- Only single `SELECT`/`WITH` statements are allowed, over allow-listed tables plus the secret-free views `people` and `quotes` (`migrations/0002_ai_views.sql`).
- No quoted identifiers, write keywords or `sqlite_*` tables.
- Results are wrapped in a row limit, and the page requires the `ask_ai` permission.

## Roles

| Role | Default access |
|---|---|
| Admin | Everything |
| Manager | Everything except staff management and settings; 15% discount limit |
| Sales | Enquiries, quotes and bookings; no net rates; 5% discount limit |
| Accounts | Payments, refunds, reports |

Admins can change these defaults in *Admin → Staff & roles*. Discounts above a staff member's limit wait for approval in *All quotations*. Cancellations and date changes by staff without the approval permission become requests. Price changes, discounts, cancellations, refunds, deletions, exports, logins and settings changes go to the activity log.
