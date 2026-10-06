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
import { opsRoutes } from './routes/staff-ops'
import { staffRoomRoutes } from './routes/staff-rooms'
import { rateSheetRoutes } from './routes/admin-ratesheet'
import { applyTaxonomy } from './lib/taxonomy'
import { assistantRoutes } from './routes/staff-assistant'
import { adminRoutes } from './routes/admin'
import { propertyEditorRoutes } from './routes/admin-properties'
import { wizardRoutes } from './routes/admin-wizard'
import { admin2Routes } from './routes/admin2'
import { webhookRoutes } from './routes/webhooks'
import { handleQueue } from './jobs/queue'
import { handleScheduled } from './jobs/cron'
import { getSettings } from './lib/settings'

export { ChatRoom } from './do/chat'

const app = new Hono<AppEnv>()

const security = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'"],
    frameSrc: ['https://challenges.cloudflare.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
    mediaSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  crossOriginEmbedderPolicy: false,
})
// WebSocket upgrade responses (101) have immutable headers, so skip them.
// Lists extended by the team (categories, facilities, amenities…) are merged in before each request.
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

app.get('/robots.txt', (c) => c.text(`User-agent: *\nDisallow: /staff\nDisallow: /admin\nDisallow: /my\nDisallow: /q/\nSitemap: ${c.env.SITE_URL}/sitemap.xml\n`))
app.get('/sitemap.xml', async (c) => {
  const props = await c.env.DB.prepare("SELECT slug, updated_at FROM properties WHERE status = 'live'").all<{ slug: string; updated_at: string }>()
  const urls = ['/', '/search', '/offers', '/about', '/contact', ...props.results.map((p) => `/stay/${p.slug}`)]
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${c.env.SITE_URL}${u}</loc></url>`).join('')}</urlset>`,
    200,
    { 'content-type': 'application/xml' },
  )
})
app.get('/healthz', (c) => c.json({ ok: true }))

app.route('/', webhookRoutes)
app.route('/', authRoutes)
app.route('/', bookingDocRoutes)
app.route('/', guestRoutes)
app.route('/', staffRoutes)
app.route('/', opsRoutes)
app.route('/', staffRoomRoutes)
app.route('/', rateSheetRoutes)
app.route('/', assistantRoutes)
app.route('/', wizardRoutes)
app.route('/', propertyEditorRoutes)
app.route('/', adminRoutes)
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
