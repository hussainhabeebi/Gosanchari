import type { Child, FC } from 'hono/jsx'
import { raw } from 'hono/html'
import type { Context } from 'hono'
import type { AppEnv, SessionUser } from '../env'
import { getSettings, type Settings } from '../lib/settings'
import { isStaff, resolvePermissions, type Permissions } from '../lib/permissions'

export type Area = 'public' | 'guest' | 'staff' | 'admin'

export interface PageOpts {
  title: string
  description?: string
  area?: Area
  active?: string
  /** Extra <head> content (e.g. Leaflet / Chart.js). */
  head?: Child
  noindex?: boolean
  image?: string
  canonical?: string
}

interface LayoutProps extends PageOpts {
  user: SessionUser | null
  settings: Settings
  perms: Permissions | null
  flash: { ok?: string; err?: string }
  turnstileSiteKey: string
  siteUrl: string
  children?: Child
}

const STAFF_NAV: { key: string; href: string; label: string; perm?: keyof Permissions }[] = [
  { key: 'dashboard', href: '/staff', label: 'Dashboard' },
  { key: 'inbox', href: '/staff/enquiries', label: 'Enquiries', perm: 'manage_enquiries' },
  { key: 'finder', href: '/staff/finder', label: 'Property finder', perm: 'manage_quotes' },
  { key: 'quotes', href: '/staff/quotes', label: 'Quotations', perm: 'manage_quotes' },
  { key: 'bookings', href: '/staff/bookings', label: 'Bookings', perm: 'manage_bookings' },
  { key: 'calendar', href: '/staff/calendar', label: 'Availability', perm: 'manage_bookings' },
  { key: 'guests', href: '/staff/guests', label: 'Guests', perm: 'manage_enquiries' },
  { key: 'tasks', href: '/staff/tasks', label: 'Follow-ups', perm: 'manage_enquiries' },
  { key: 'profile', href: '/staff/profile', label: 'My profile' },
]

const ADMIN_NAV: { key: string; href: string; label: string; perm: keyof Permissions }[] = [
  { key: 'admin', href: '/admin', label: 'Overview', perm: 'view_reports' },
  { key: 'properties', href: '/admin/properties', label: 'Properties', perm: 'manage_properties' },
  { key: 'rates', href: '/admin/rates', label: 'Rates & availability', perm: 'manage_rates' },
  { key: 'offers', href: '/admin/offers', label: 'Offers & coupons', perm: 'manage_offers' },
  { key: 'all-enquiries', href: '/admin/enquiries', label: 'All enquiries', perm: 'view_all_enquiries' },
  { key: 'all-quotes', href: '/admin/quotes', label: 'All quotations', perm: 'approve_discounts' },
  { key: 'all-bookings', href: '/admin/bookings', label: 'All bookings', perm: 'approve_cancellations' },
  { key: 'payments', href: '/admin/payments', label: 'Payments & refunds', perm: 'manage_payments' },
  { key: 'all-guests', href: '/admin/guests', label: 'All guests', perm: 'manage_guests' },
  { key: 'staff', href: '/admin/staff', label: 'Staff & roles', perm: 'manage_staff' },
  { key: 'reports', href: '/admin/reports', label: 'Reports', perm: 'view_reports' },
  { key: 'ask', href: '/admin/ask', label: 'Ask AI', perm: 'ask_ai' },
  { key: 'reviews', href: '/admin/reviews', label: 'Reviews', perm: 'manage_reviews' },
  { key: 'content', href: '/admin/content', label: 'Website content', perm: 'manage_content' },
  { key: 'settings', href: '/admin/settings', label: 'Settings', perm: 'manage_settings' },
  { key: 'activity', href: '/admin/activity', label: 'Activity log', perm: 'view_activity' },
]

const GUEST_NAV = [
  { key: 'trips', href: '/my', label: 'My trips' },
  { key: 'bookings', href: '/my/bookings', label: 'Bookings' },
  { key: 'enquiries', href: '/my/enquiries', label: 'Enquiries & quotes' },
  { key: 'saved', href: '/my/saved', label: 'Saved' },
  { key: 'profile', href: '/my/profile', label: 'Profile' },
  { key: 'help', href: '/help', label: 'Help & chat' },
]

const TopBar: FC<{ user: SessionUser | null; settings: Settings }> = ({ user, settings }) => (
  <header class="topbar">
    <div class="wrap topbar-in">
      <a href="/" class="logo" aria-label={settings.business.name}>
        <img src="/brand/logo-200.webp" alt={settings.business.name} width="72" height="72" class="logo-img" />
      </a>
      <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Menu" />
      <label for="nav-toggle" class="nav-burger" aria-hidden="true">☰</label>
      <nav class="topnav">
        <a href="/search">Stays</a>
        <a href="/offers">Offers</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        {user ? (
          <>
            <a href={isStaff(user.role) ? (user.role === 'sales' ? '/staff' : '/admin') : '/my'} class="btn btn-sm btn-outline">
              {isStaff(user.role) ? 'Dashboard' : 'My trips'}
            </a>
            <form method="post" action="/logout" class="inline">
              <button class="linklike">Log out</button>
            </form>
          </>
        ) : (
          <a href="/login" class="btn btn-sm">Login / Sign up</a>
        )}
        <a class="btn btn-sm btn-wa" href={`https://wa.me/${settings.business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener">
          WhatsApp
        </a>
      </nav>
    </div>
  </header>
)

const Footer: FC<{ settings: Settings }> = ({ settings }) => (
  <footer class="footer">
    <div class="wrap footer-grid">
      <div>
        <img src="/brand/logo.webp" alt={settings.business.name} width="120" height="120" class="footer-logo" loading="lazy" />
        <p class="muted">{settings.business.tagline}</p>
      </div>
      <div>
        <h4>Contact</h4>
        <p>
          {settings.business.phone}<br />
          <a href={`mailto:${settings.business.email}`}>{settings.business.email}</a><br />
          {settings.business.address}
        </p>
      </div>
      <div>
        <h4>Policies</h4>
        <p>
          <a href="/policies/privacy">Privacy policy</a><br />
          <a href="/policies/cancellation">Cancellation & refunds</a><br />
          <a href="/policies/terms">Terms</a>
        </p>
      </div>
      <div>
        <h4>Follow us</h4>
        <p>
          {Object.entries(settings.business.social).filter(([, v]) => v).map(([k, v]) => (
            <><a href={v} target="_blank" rel="noopener">{k[0].toUpperCase() + k.slice(1)}</a><br /></>
          ))}
        </p>
      </div>
    </div>
    <div class="wrap muted small footer-bottom">
      <span>© {new Date().getFullYear()} {settings.business.legal_name}</span>
      <span class="footer-credits">
        Built by team <a href="https://aiingo.com" target="_blank" rel="noopener">aiingo.com</a>
        <span aria-hidden="true"> · </span>
        Powered by <a href="https://leadvyne.com" target="_blank" rel="noopener">leadvyne.com</a>
      </span>
    </div>
  </footer>
)

const SideNav: FC<{ area: Area; active?: string; perms: Permissions | null; user: SessionUser }> = ({ area, active, perms, user }) => {
  const staffItems = STAFF_NAV.filter((i) => !i.perm || perms?.[i.perm])
  const adminItems = ADMIN_NAV.filter((i) => perms?.[i.perm])
  return (
    <aside class="sidenav">
      <input type="checkbox" id="side-toggle" class="nav-toggle" />
      <label for="side-toggle" class="side-burger">☰ Menu</label>
      <div class="side-items">
        <div class="side-user">
          <strong>{user.name || 'Account'}</strong>
          <span class="muted small">{user.role === 'guest' ? 'Guest' : user.role}</span>
        </div>
        {area === 'guest' ? (
          GUEST_NAV.map((i) => <a href={i.href} class={active === i.key ? 'active' : ''}>{i.label}</a>)
        ) : (
          <>
            <div class="side-h">Staff</div>
            {staffItems.map((i) => <a href={i.href} class={active === i.key ? 'active' : ''}>{i.label}</a>)}
            {adminItems.length > 0 && <div class="side-h">Admin</div>}
            {adminItems.map((i) => <a href={i.href} class={active === i.key ? 'active' : ''}>{i.label}</a>)}
          </>
        )}
        <form method="post" action="/logout"><button class="linklike side-logout">Log out</button></form>
      </div>
    </aside>
  )
}

export const Layout: FC<LayoutProps> = (p) => {
  const area = p.area ?? 'public'
  const dash = area !== 'public' && p.user
  const fullTitle = p.title === p.settings.business.name ? p.title : `${p.title} · ${p.settings.business.name}`
  return (
    <>
      {raw('<!doctype html>')}
      <html lang={p.user?.language === 'ml' ? 'ml' : 'en'}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{fullTitle}</title>
          {p.description && <meta name="description" content={p.description} />}
          {(p.noindex || area !== 'public') && <meta name="robots" content="noindex" />}
          {p.canonical && <link rel="canonical" href={p.canonical} />}
          <meta property="og:title" content={fullTitle} />
          {p.description && <meta property="og:description" content={p.description} />}
          <meta property="og:image" content={p.image ?? `${p.siteUrl}/brand/og.jpg`} />
          <meta property="og:site_name" content={p.settings.business.name} />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="theme-color" content="#0f5e57" />
          <link rel="icon" href="/favicon.png" type="image/png" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="stylesheet" href="/app.css" />
          {p.turnstileSiteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>}
          {p.head}
        </head>
        <body class={`area-${area}`}>
          <a class="skip" href="#main">Skip to content</a>
          <TopBar user={p.user} settings={p.settings} />
          {dash ? (
            <div class="dash">
              <SideNav area={area} active={p.active} perms={p.perms} user={p.user!} />
              <main id="main" class="dash-main">
                <Flash {...p.flash} />
                {p.children}
              </main>
            </div>
          ) : (
            <main id="main">
              <Flash {...p.flash} />
              {p.children}
            </main>
          )}
          {area === 'public' && <Footer settings={p.settings} />}
          {area !== 'staff' && area !== 'admin' && (
            <a class="wa-float" href={`https://wa.me/${p.settings.business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener" aria-label="Chat on WhatsApp">
              💬
            </a>
          )}
          <script src="/app.js" defer></script>
        </body>
      </html>
    </>
  )
}

const Flash: FC<{ ok?: string; err?: string }> = ({ ok, err }) => (
  <>
    {ok && <div class="flash flash-ok wrap" role="status">{ok}</div>}
    {err && <div class="flash flash-err wrap" role="alert">{err}</div>}
  </>
)

/** Render a full page with the shared layout. */
export async function page(c: Context<AppEnv>, opts: PageOpts, body: Child, status = 200) {
  const user = c.get('user')
  const settings = await getSettings(c.env)
  const perms = user && isStaff(user.role) ? resolvePermissions(user.role, settings.role_permissions) : null
  const flash = { ok: c.req.query('ok')?.slice(0, 200), err: c.req.query('err')?.slice(0, 200) }
  return c.html(
    <Layout {...opts} user={user} settings={settings} perms={perms} flash={flash} turnstileSiteKey={c.env.TURNSTILE_SITE_KEY} siteUrl={c.env.SITE_URL}>
      {body}
    </Layout>,
    status as 200,
  )
}
