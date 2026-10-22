import { quotationArchiveRoutes } from './routes/quotation-archive'
import { publicSitemap, robotsText } from './lib/seo'
// Go Sanchari web portal — one Cloudflare Worker serving pages, API, queue consumer and cron jobs.

import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { csrf } from 'hono/csrf'
import type { AppEnv, Env, JobMessage } from './env'
import { sessionMiddleware } from './lib/auth'
import { page } from './views/layout'
import { publicRoutes } from './routes/public'
import { bookingDocRoutes } from './routes/booking-docs'
import { authRoutes } from './routes/auth'
import { guestRoutes } from './routes/guest'
import { staffRoutes } from './routes/staff'
import { calculatorRoutes } from './routes/rate-calculator'
import { opsRoutes } from './routes/staff-ops'
import { staffRoomRoutes } from './routes/staff-rooms'
import { rateSheetRoutes } from './routes/admin-ratesheet'
import { applyTaxonomy } from './lib/taxonomy'
import { assistantRoutes } from './routes/staff-assistant'
import { adminRoutes } from './routes/admin'
import { contactRoutes } from './routes/admin-contacts'
import { confirmationRoutes } from './routes/confirmation-requests'
import { voucherRoutes } from './routes/vouchers'
import { propertyEditorRoutes } from './routes/admin-properties'
import { wizardRoutes } from './routes/admin-wizard'
import { admin2Routes } from './routes/admin2'
import { webhookRoutes } from './routes/webhooks'
import { handleQueue } from './jobs/queue'
import { handleScheduled } from './jobs/cron'
import { getSettings } from './lib/settings'
import { assetVersion, VERSIONED_ASSETS } from './lib/assets'

export { ChatRoom } from './do/chat'

const app = new Hono<AppEnv>()

const security = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://www.googletagmanager.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
    fontSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com'],
    frameSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
    mediaSrc: ["'self'"],
    formAction: ["'self'"],
    // 'self' so the home page's property-details popup can show the stay page in an iframe; other sites still can't frame us.
    frameAncestors: ["'self'"],
  },
  crossOriginEmbedderPolicy: false,
})
// WebSocket upgrade responses (101) have immutable headers, so skip them.
// Lists extended by the team (categories, facilities, amenities…) are merged in before each request.
// Versioned stylesheet/script (see lib/assets.ts). Registered before the middleware below so these stay instant.
app.get('/v/:ver/:file', async (c) => {
  const path = '/' + c.req.param('file')
  if (!VERSIONED_ASSETS.has(path)) return c.notFound()
  const res = await c.env.ASSETS.fetch(new URL(path, c.req.url))
  if (!res.ok) return res
  const out = new Response(res.body, res)
  // An old version id only ever maps to that deploy's file, so it can be cached for good.
  out.headers.set('Cache-Control', c.req.param('ver') === assetVersion(c.env) ? 'public, max-age=31536000, immutable' : 'no-cache')
  return out
})

app.use('*', async (c, next) => {
  if (!c.req.path.startsWith('/app.') && !c.req.path.startsWith('/brand/')) await applyTaxonomy(c.env).catch(() => {})
  await next()
})
app.use('*', (c, next) => (c.req.path === '/chat/ws' ? next() : security(c, next)))
// Form posts must come from our own pages (webhooks use JSON and verify signatures).
app.use('*', csrf())
app.use('*', sessionMiddleware)

// Live chat: WebSocket to the visitor's chat room Durable Object.
app.get('/chat/ws', async (c) => {
  const room = c.req.query('room') ?? ''
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(room) || c.req.header('Upgrade') !== 'websocket') return c.text('bad request', 400)
  const stub = c.env.CHAT.get(c.env.CHAT.idFromName(room))
  const headers = new Headers(c.req.raw.headers)
  headers.set('x-room', room)
  headers.set('x-lang', c.get('user')?.language ?? 'en')
  return stub.fetch(new Request(c.req.raw, { headers }))
})

app.get('/robots.txt', (c) => c.text(robotsText(c.env.SITE_URL)))
app.get('/sitemap.xml', publicSitemap)
app.get('/healthz', (c) => c.json({ ok: true }))

app.route('/', webhookRoutes)
app.route('/', authRoutes)
app.route('/', bookingDocRoutes)
app.route('/', guestRoutes)
app.route('/', staffRoutes)
app.route('/', opsRoutes)
app.route('/', quotationArchiveRoutes)
app.route('/', calculatorRoutes)
app.route('/', staffRoomRoutes)
app.route('/', rateSheetRoutes)
app.route('/', assistantRoutes)
app.route('/', wizardRoutes)
app.route('/', propertyEditorRoutes)
app.route('/', adminRoutes)
app.route('/', contactRoutes)
app.route('/', confirmationRoutes)
app.route('/', voucherRoutes)
app.route('/', admin2Routes)
app.route('/', publicRoutes)

app.notFound((c) =>
  page(c, { title: 'Page not found', noindex: true }, (
    <div class="wrap narrow section center">
      <h1>We couldn't find that page</h1>
      <p><a class="btn" href="/search">Browse stays</a> <a class="btn btn-outline" href="/">Home</a></p>
    </div>
  ), 404),
)

app.onError(async (err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('Unhandled error', c.req.method, c.req.path, err)
  if (c.req.header('accept')?.includes('application/json')) return c.json({ error: 'Something went wrong' }, 500)
  const s = await getSettings(c.env).catch(() => null)
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div class="wrap narrow section center"><h1>Something went wrong</h1><p>Please try again. If it keeps happening, WhatsApp us${s ? ` on ${s.business.whatsapp}` : ''}.</p><p><a class="btn" href="/">Home</a></p></div>`,
    500,
  )
})

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    await handleQueue(batch, env)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(controller, env))
  },
} satisfies ExportedHandler<Env, JobMessage>

export { app }
