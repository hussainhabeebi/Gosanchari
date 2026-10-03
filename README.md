# Go Sanchari — web portal

Booking, enquiry and back-office portal for Kerala stays (homestays, villas, resorts, houseboats, cottages).
One Cloudflare Worker serves every page, the API, the queue consumer and the cron jobs.

- **Stack:** Cloudflare Workers + [Hono](https://hono.dev) (server-rendered JSX), D1, KV, R2, Durable Objects, Queues, Cron Triggers,
  Workers AI, Vectorize, AI Search (AutoRAG), AI Gateway, Turnstile.
- **Enquiry-only site:** guests browse stays and send enquiries — there is no online booking or payment.
  Staff send quotes; when a guest accepts, staff confirm the booking and record payments collected offline (UPI, bank transfer, cash).
- **Messaging:** WhatsApp Cloud API. **Email:** Resend.
- **Rule:** AI suggests, people decide. Prices, quotes, bookings, payments, refunds and lead scores are plain code. Every AI feature
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

Phone-OTP login shows the code on screen when WhatsApp isn't configured (development only).

**Demo logins.** Every staff account uses the password `GoSanchari@2026`. Remove these accounts or change their passwords before going live.

| Role | Email |
|---|---|
| Admin | admin@gosanchari.com |
| Manager | manager@gosanchari.com |
| Sales | priya@gosanchari.com, arjun@gosanchari.com |
| Accounts | accounts@gosanchari.com |

Guests log in with any phone number (OTP). Demo quote link: `/q/demo-quote-token-1234567890`.

**Booking flow:** enquiry → staff quote (WhatsApp link) → guest clicks *Accept* → staff get an alert and a task →
*Convert to booking* (confirms it, blocks the rooms and sends the guest a WhatsApp confirmation) → staff *Record payment* on the booking.

```bash
npm test          # unit tests: pricing, coupons, GST, SQL guard, search parsing, lead score
npm run typecheck
```

Trigger cron jobs locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=30+1+*+*+*"` (daily) or `cron=30+2+*+*+1` (weekly).

## Deploy to Cloudflare

| | Command |
|---|---|
| Build | `npm run build` (type check + tests; Wrangler bundles the Worker itself) |
| Deploy | `npm run deploy` (applies D1 migrations, then `wrangler deploy`) |

For a Cloudflare dashboard Git connection (Workers & Pages → Create → Import a repository), use those same two commands. The root directory is `/`.

**First deploy.** No IDs need editing: the deploy script creates the D1 database if needed and applies migrations. `wrangler deploy` then creates the KV namespace, R2 buckets and queue by name.

1. Change `SITE_URL` in `wrangler.toml` to your address, then commit.
2. Deploy, either:
   - **from the Cloudflare dashboard** (Git-connected): build command `npm run build`, deploy command `npm run deploy`; or
   - **from your computer**: `npm install`, `npx wrangler login`, then `npm run deploy`.
3. Set a session secret: `npx wrangler secret put SESSION_SECRET` (or Worker → Settings → Variables and Secrets).
4. Create your admin login, either:
   - **from Cloudflare:** add a secret `SETUP_CODE` (Worker → Settings → Variables and Secrets), open `https://<site>/setup`, enter the code and your details, then delete the secret. The page only works while no admin exists.
   - **from a terminal:** `npm run admin:create -- you@example.com "Your Name"`.

Demo data is optional: `npm run db:seed:remote`. Don't load it on a live site without changing the demo passwords.

**Optional, turn on when ready** (all have safe fallbacks):
1. **AI Gateway:** in the dashboard, create a gateway named `gosanchari` (matches `AI_GATEWAY_ID`). Turn on caching and rate limiting, and set a spend alert.
2. **Vectorize** ("Recommended" sorting and similar properties): run `npm run setup:cloudflare`, then uncomment the `[[vectorize]]` block in `wrangler.toml`.
   **AI Search:** create the instance `gosanchari-kb` with the `gosanchari-kb` R2 bucket as its source, then uncomment the `[[ai_search]]` block.
   Deploys fail if either block is on but its resource doesn't exist.
3. **Turnstile:** set the widget site key in `TURNSTILE_SITE_KEY` (`[vars]`) and the secret with `wrangler secret put TURNSTILE_SECRET`. Until then, forms work without the bot check (rate limits still apply).
4. **WhatsApp:** set the secrets `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`. Point the Meta webhook to `https://<site>/webhooks/whatsapp` and create the approved templates (`otp` and the others). Until then, phone login is unavailable (use email login) and messages are only logged.
5. **Email:** set `RESEND_API_KEY`. **Google login:** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. **Images:** enable Image Transformations on the zone, then tick the option in *Admin → Settings*.
7. **Custom domain:** Workers → gosanchari → Settings → Domains & Routes. Update `SITE_URL` to match.

## Adding a property (Admin → Properties → Add property)

The editor is split into sections. Sections 1–10 are filled in first; sections 11–13 open after the first save.

| # | Section | Notes |
|---|---|---|
| 1 | Basics | Name, type (villa, cottage, resort, homestay, houseboat, hotel, treehouse, glamping…), destination, star category, year, "best for" themes, languages, highlights |
| 2 | Location | Complete address, **Google Maps link** (the map pin is filled in from it), pin on map, how to reach, best time to visit |
| 3 | Description | English and Malayalam (AI writer optional), "good to know" notes |
| 4 | Dining | Restaurant, cuisines, menu types, meal timings, meal-plan prices per person, children's meals |
| 5 | Facilities | Pool, parking, Wi-Fi, spa, bonfire, activities… |
| 6 | Policies | Check-in/out, cancellation, pets, children, extra bed, ID, couples, smoking, alcohol, visitors, payment |
| 7 | Contact & direct booking | Owner and property contacts, direct booking link, GSTIN, bank details. **Staff only:** shown in the property finder, never on the website |
| 8 | Nearby | `Name \| type \| km \| travel time`, one per line |
| 9 | SEO | Title and description (AI suggestions optional) |
| 10 | Remarks | Internal notes for staff |
| 11 | Room categories | Inventory (rooms of each type), guests/adults/children, bed, size, view, weekday/weekend/net rates, extra bed, inclusions, **room amenities** (AC, TV, kettle, balcony…) |
| 12 | Photos & videos | Upload into sections: common areas, facade, **each room category**, pool, views, restaurant, activities. Videos are MP4/WebM files up to 90 MB, or YouTube/Vimeo links |
| 13 | Tariff & seasons | One block per season (Onam, Christmas & New Year, summer…) with dates, minimum nights and a rate for each room category |

## Where each page lives

| # | Page | URL | Code |
|---|---|---|---|
| 1 | Home | `/` | `src/routes/public.tsx` |
| 2 | Search results | `/search` (`?ai=` for the AI line, `?view=map`) | public.tsx |
| 3 | Property details (+ enquiry box with estimated price, Q&A chat, availability, similar) | `/stay/:slug` | public.tsx |
| 4 | Enquiry form | `/enquiry` (`?offer=CODE`) | public.tsx |
| 5–6 | *(No online checkout — removed.)* Invoice and calendar file for confirmed stays | `/invoice/:code`, `/booking/:code/calendar.ics` | booking-docs.ts |
| 7 | Login / sign up / Google / forgot password | `/login`, `/signup`, `/auth/google`, `/forgot` | auth.tsx |
| 8 | Offers | `/offers` | public.tsx |
| 9 | About / Contact / Policies | `/about`, `/contact`, `/policies/:kind` | public.tsx |
| 10–17 | My trips, stays confirmed by the team, enquiries & quotes, saved, review, profile | `/my…` | guest.tsx |
| 14 | Quotation (no login, from WhatsApp): Accept / Ask for changes / Decline | `/q/:token` | public.tsx |
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
