import type { Child, FC } from 'hono/jsx'
import { raw } from 'hono/html'
import type { Context } from 'hono'
import type { AppEnv, SessionUser } from '../env'
import { getContent, getSettings, type Settings } from '../lib/settings'
import { mediaUrl } from '../lib/integrations'
import { MOODS, PageHero, type HeroProps } from './moods'
import { isStaff, resolvePermissions, type Permissions } from '../lib/permissions'

export type Area = 'public' | 'guest' | 'staff' | 'admin'

export interface PageOpts {
  title: string
  journey?: JourneyTheme
  embedded?: boolean
  hideJourneyBanner?: boolean
  description?: string
  area?: Area
  active?: string
  /** Extra <head> content (e.g. Leaflet / Chart.js). */
  head?: Child
  noindex?: boolean
  image?: string
  canonical?: string
  /** Mood hero at the top of the page (public / guest pages). */
  hero?: Omit<HeroProps, 'photo' | 'children'> & { slot?: Child }
  /** Which top-menu item to underline. */
  nav?: 'home' | 'stays' | 'offers' | 'about' | 'contact' | 'ai-search' | 'ai-insights'
}

interface LayoutProps extends PageOpts {
  user: SessionUser | null
  settings: Settings
  perms: Permissions | null
  flash: { ok?: string; err?: string }
  turnstileSiteKey: string
  siteUrl: string
  moodPhoto?: string | null
  bell?: number
  children?: Child
}


interface JourneyTheme { mood: string; label: string; description: string; nativeHero?: boolean }
/** A shared visual story, selected by route so all pages receive a consistent theme. */
export function journeyTheme(path: string, area: Area = 'public'): JourneyTheme {
  if (path === '/') return { mood: 'adventure', label: 'Your journey begins', description: 'Explore · Stay · Unwind', nativeHero: true }
  if (path === '/search') return { mood: 'curiosity', label: 'Follow your curiosity', description: 'Find a place that feels like you', nativeHero: true }
  if (path.startsWith('/stay/')) return { mood: 'unwind', label: 'Pause. Breathe. Stay.', description: 'A little comfort along your journey' }
  if (path === '/offers') return { mood: 'anticipation', label: 'Something to look forward to', description: 'Make your next escape a little more memorable' }
  if (path === '/about') return { mood: 'reflection', label: 'Every journey has a story', description: 'Travel more. Worry less.' }
  if (path === '/contact' || path === '/help') return { mood: 'connection', label: 'You are never travelling alone', description: 'A friendly guide, whenever you need one' }
  if (path.startsWith('/login') || path.startsWith('/register') || path.startsWith('/forgot') || path.startsWith('/reset')) return { mood: 'welcome', label: 'Welcome to your next chapter', description: 'Your journey, all in one place' }
  if (path.startsWith('/enquiry')) return { mood: 'hope', label: 'Let us plan your next escape', description: 'Tell us your dream. We will help with the details.' }
  if (path.startsWith('/q/')) return { mood: 'anticipation', label: 'Your escape is taking shape', description: 'The next chapter is almost here' }
  if (path.startsWith('/policies')) return { mood: 'clarity', label: 'Travel with peace of mind', description: 'Clear details for a carefree journey' }
  if (area === 'guest' || path.startsWith('/my')) return { mood: 'memories', label: 'Your travel story', description: 'Plans to look forward to. Memories to keep.' }
  if (area === 'staff' || area === 'admin') return { mood: 'focus', label: 'Make every journey count', description: 'Thoughtful service, one traveller at a time' }
  return { mood: 'discovery', label: 'Keep exploring', description: 'There is always another story waiting' }
}

const JourneyBanner: FC<{ theme: JourneyTheme; title: string }> = ({ theme, title }) => (
  <section class="journey-banner" aria-label={theme.label}>
    <div class="wrap journey-copy"><span class="eyebrow">{theme.label}</span><h2>{title}</h2><p>{theme.description}</p></div>
  </section>
)

const STAFF_NAV: { key: string; href: string; label: string; perm?: keyof Permissions }[] = [
  { key: 'dashboard', href: '/staff', label: 'Dashboard' },
  { key: 'assistant', href: '/staff/assistant', label: 'AI assistant', perm: 'manage_quotes' },
  { key: 'inbox', href: '/staff/enquiries', label: 'Enquiries', perm: 'manage_enquiries' },
  { key: 'finder', href: '/staff/finder', label: 'Property finder', perm: 'manage_quotes' },
  { key: 'rooms', href: '/staff/rooms', label: 'Rooms & photos' },
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

type NavItem = { key: string; href: string; label: string; perm?: keyof Permissions }
type NavGroup = { label: string; icon: string; items: NavItem[] }
const ICO: Record<string, string> = {
  dash: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  ai: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  prop: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h3M13 7h3M8 11h3M13 11h3M10 21v-4h4v4"/>',
  enq: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  quote: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  book: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3.5 2.8 3.5 6"/>',
  offer: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
}
const ico = (k: string) => raw(`<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k] ?? ''}</svg>`)

const NAV_GROUPS: NavGroup[] = [
  { label: 'Dashboard', icon: 'dash', items: [{ key: 'admin', href: '/admin', label: 'Overview', perm: 'view_reports' }, { key: 'dashboard', href: '/staff', label: 'My day' }] },
  { label: 'AI assistant', icon: 'ai', items: [{ key: 'assistant', href: '/staff/assistant', label: 'AI assistant', perm: 'manage_quotes' }] },
  { label: 'Properties', icon: 'prop', items: [
    { key: 'properties', href: '/admin/properties', label: 'All Properties', perm: 'manage_properties' },
    { key: 'prop_new', href: '/admin/properties/new', label: 'Add New Property', perm: 'manage_properties' },
    { key: 'prop_cats', href: '/admin/lists/property_type', label: 'Categories', perm: 'manage_properties' },
    { key: 'prop_facilities', href: '/admin/lists/facility', label: 'Facilities & Activities', perm: 'manage_properties' },
    { key: 'rates', href: '/admin/rates', label: 'Rates & availability', perm: 'manage_rates' },
    { key: 'rooms', href: '/staff/rooms', label: 'Rooms & photos' },
    { key: 'finder', href: '/staff/finder', label: 'Property finder', perm: 'manage_quotes' },
  ] },
  { label: 'Enquiries', icon: 'enq', items: [
    { key: 'inbox', href: '/staff/enquiries', label: 'My enquiries', perm: 'manage_enquiries' },
    { key: 'all-enquiries', href: '/admin/enquiries', label: 'All enquiries', perm: 'view_all_enquiries' },
    { key: 'tasks', href: '/staff/tasks', label: 'Follow-ups', perm: 'manage_enquiries' },
  ] },
  { label: 'Quotations', icon: 'quote', items: [
    { key: 'quotes', href: '/staff/quotes', label: 'My quotations', perm: 'manage_quotes' },
    { key: 'all-quotes', href: '/admin/quotes', label: 'All quotations', perm: 'approve_discounts' },
  ] },
  { label: 'Bookings', icon: 'book', items: [
    { key: 'bookings', href: '/staff/bookings', label: 'My bookings', perm: 'manage_bookings' },
    { key: 'all-bookings', href: '/admin/bookings', label: 'All bookings', perm: 'approve_cancellations' },
    { key: 'calendar', href: '/staff/calendar', label: 'Availability', perm: 'manage_bookings' },
    { key: 'payments', href: '/admin/payments', label: 'Payments & refunds', perm: 'manage_payments' },
  ] },
  { label: 'Customers', icon: 'people', items: [
    { key: 'guests', href: '/staff/guests', label: 'Guests', perm: 'manage_enquiries' },
    { key: 'all-guests', href: '/admin/guests', label: 'All guests', perm: 'manage_guests' },
  ] },
  { label: 'Offers & Packages', icon: 'offer', items: [{ key: 'offers', href: '/admin/offers', label: 'Offers & coupons', perm: 'manage_offers' }] },
  { label: 'Reviews', icon: 'star', items: [{ key: 'reviews', href: '/admin/reviews', label: 'Reviews', perm: 'manage_reviews' }] },
  { label: 'Reports', icon: 'chart', items: [
    { key: 'reports', href: '/admin/reports', label: 'Reports', perm: 'view_reports' },
    { key: 'ask', href: '/admin/ask', label: 'Ask AI', perm: 'ask_ai' },
  ] },
  { label: 'Website Settings', icon: 'gear', items: [
    { key: 'content', href: '/admin/content', label: 'Website content', perm: 'manage_content' },
    { key: 'settings', href: '/admin/settings', label: 'Settings', perm: 'manage_settings' },
    { key: 'staff', href: '/admin/staff', label: 'Staff & roles', perm: 'manage_staff' },
    { key: 'activity', href: '/admin/activity', label: 'Activity log', perm: 'view_activity' },
  ] },
  { label: 'My profile', icon: 'user', items: [{ key: 'profile', href: '/staff/profile', label: 'My profile' }] },
]

const AppSide: FC<{ active?: string; perms: Permissions | null; settings: Settings }> = ({ active, perms, settings }) => (
  <aside class="app-side">
    <a href="/" class="side-logo"><img src="/brand/logo-wide-light.webp" alt={settings.business.name} width="150" height="40" /><span>Travel more, worry less</span></a>
    <input type="checkbox" id="side-toggle" class="nav-toggle" />
    <label for="side-toggle" class="side-burger">☰ Menu</label>
    <nav class="side-nav">
      {NAV_GROUPS.map((g) => {
        const items = g.items.filter((i) => !i.perm || perms?.[i.perm])
        if (!items.length) return null
        const on = items.some((i) => i.key === active)
        if (items.length === 1) return <a href={items[0].href} class={`side-link ${on ? 'active' : ''}`}>{ico(g.icon)}<span>{g.label}</span></a>
        return (
          <details class="side-group" open={on}>
            <summary class={`side-link ${on ? 'active' : ''}`}>{ico(g.icon)}<span>{g.label}</span></summary>
            <div class="side-sub">{items.map((i) => <a href={i.href} class={i.key === active ? 'active' : ''}>{i.label}</a>)}</div>
          </details>
        )
      })}
    </nav>
  </aside>
)

const AppTop: FC<{ user: SessionUser; perms: Permissions | null; bell: number }> = ({ user, perms, bell }) => (
  <header class="app-top">
    <form class="app-search" method="get" action="/admin/search" role="search">
      {ico('quote')}<input name="q" placeholder="Search properties, bookings, or customers..." aria-label="Search" />
    </form>
    <div class="app-top-right">
      {perms?.manage_enquiries && <a href="/staff/enquiries?status=new" class="bell" aria-label={`${bell} new enquiries`}>{raw('<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>')}{bell > 0 && <span class="bell-dot">{bell > 99 ? '99+' : bell}</span>}</a>}
      <details class="nav-drop me">
        <summary><span class="avatar">{(user.name || 'A').trim().slice(0, 1).toUpperCase()}</span><span class="me-txt"><strong>{user.name || 'Account'}</strong><small>{user.role === 'admin' ? 'Admin' : user.role}</small></span></summary>
        <div class="drop-panel">
          <a href="/staff/profile">My profile</a>
          <a href="/" target="_blank">View website</a>
          <form method="post" action="/logout"><button class="linklike">Log out</button></form>
        </div>
      </details>
    </div>
  </header>
)

const GUEST_NAV = [
  { key: 'trips', href: '/my', label: 'My trips' },
  { key: 'bookings', href: '/my/bookings', label: 'Bookings' },
  { key: 'enquiries', href: '/my/enquiries', label: 'Enquiries & quotes' },
  { key: 'saved', href: '/my/saved', label: 'Saved' },
  { key: 'profile', href: '/my/profile', label: 'Profile' },
  { key: 'help', href: '/help', label: 'Help & chat' },
]

export function publicNav(path: string): PageOpts['nav'] {
  if (path === '/') return 'home'
  if (/^\/(search|destinations)(\/|$)/.test(path)) return 'stays'
  if (/^\/(offers|packages)(\/|$)/.test(path)) return 'offers'
  if (/^\/about(\/|$)/.test(path)) return 'about'
  if (/^\/contact(\/|$)/.test(path)) return 'contact'
  if (/^\/ai-search(\/|$)/.test(path)) return 'ai-search'
  if (/^\/ai-insights(\/|$)/.test(path)) return 'ai-insights'
  return undefined
}

const TopBar: FC<{ user: SessionUser | null; settings: Settings; nav?: PageOpts['nav'] }> = ({ user, settings, nav }) => (
  <header class="topbar">
    <div class="wrap topbar-in">
      <a href="/" class="logo" aria-label={settings.business.name}>
        <img src="/brand/logo-wide.webp" alt={settings.business.name} width="181" height="48" class="logo-img" />
      </a>
      <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Menu" />
      <label for="nav-toggle" class="nav-burger" aria-hidden="true">☰</label>
      <nav class="topnav">
        <div class="topnav-menu">
        <a href="/" data-public-nav="home" aria-current={nav === 'home' ? 'page' : undefined}>Home</a>
        <a href="/#ai-search" data-public-nav="ai-search" aria-current={nav === 'ai-search' ? 'page' : undefined}>AI Search</a>
        <a href="/#ai-insights" data-public-nav="ai-insights" aria-current={nav === 'ai-insights' ? 'page' : undefined}>AI Insights</a>
        <details class="nav-dropdown"><summary data-public-nav="stays" aria-current={nav === 'stays' ? 'page' : undefined}>Destinations</summary><div class="nav-panel">{['Munnar', 'Vagamon', 'Ooty', 'Kodaikanal', 'Wayanad'].map((d) => <a href={`/search?destination=${encodeURIComponent(d)}`}>{d}</a>)}<a href="/search">See More →</a></div></details>
        <a href="/offers" data-public-nav="offers" aria-current={nav === 'offers' ? 'page' : undefined}>Packages</a>
        <a href="/about" data-public-nav="about" aria-current={nav === 'about' ? 'page' : undefined}>About Us</a>
        <details class="nav-dropdown"><summary data-public-nav="contact" aria-current={nav === 'contact' ? 'page' : undefined}>Contact</summary><div class="nav-panel contact-panel"><a href={`tel:${settings.business.phone}`}>{settings.business.phone}</a><a href={`mailto:${settings.business.email}`}>{settings.business.email}</a></div></details>
        </div>
        <div class="topnav-account">
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
          <details class="nav-dropdown portal-dropdown"><summary class="btn btn-sm">Portal Login ⌄</summary><div class="nav-panel"><a href="/login?next=%2Fmy"><strong>Guest Login</strong><small>For travel agents &amp; guests</small></a><a href="/login?tab=email&amp;next=%2Fstaff"><strong>Staff Login</strong><small>For team members</small></a></div></details>
        )}
        <a class="btn btn-sm btn-wa" href={`https://wa.me/${settings.business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener">
          WhatsApp
        </a>
        </div>
      </nav>
    </div>
  </header>
)

const Footer: FC<{ settings: Settings }> = ({ settings }) => (
  <footer class="footer">
    <div class="wrap footer-grid">
      <div>
        <img src="/brand/logo-wide-light.webp" alt={settings.business.name} width="211" height="56" class="footer-logo" loading="lazy" />
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
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Great+Vibes&family=Poppins:wght@400;500;600;700&display=swap" />
          <link rel="stylesheet" href="/app.css" />
          {p.turnstileSiteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>}
          {p.head}
        </head>
        <body class={`area-${area}${p.embedded ? ' embedded-stay' : ''} journey-${p.journey?.mood ?? 'discovery'}${p.hero && !dash ? ` has-hero hero-text-${p.moodPhoto ? 'dark' : MOODS[p.hero.mood].text}` : ''}`}>
          <a class="skip" href="#main">Skip to content</a>
          {!(dash && area !== 'guest') && <TopBar user={p.user} settings={p.settings} nav={p.nav} />}
          {dash && area !== 'guest' ? (
            <div class="app-shell">
              <AppSide active={p.active} perms={p.perms} settings={p.settings} />
              <div class="app-main">
                <AppTop user={p.user!} perms={p.perms} bell={p.bell ?? 0} />
                <main id="main" class="dash-main">
                  {p.hero && <PageHero {...p.hero} photo={p.moodPhoto} size="strip">{p.hero.slot}</PageHero>}
                  <Flash {...p.flash} />
                  {p.children}
                </main>
              </div>
            </div>
          ) : dash ? (
            <div class="dash">
              <SideNav area={area} active={p.active} perms={p.perms} user={p.user!} />
              <main id="main" class="dash-main">
                {p.hero && <PageHero {...p.hero} photo={p.moodPhoto} size="strip">{p.hero.slot}</PageHero>}
                <Flash {...p.flash} />
                {p.journey && !p.embedded && <JourneyBanner theme={p.journey} title={p.title} />}
                {p.children}
              </main>
            </div>
          ) : (
            <main id="main">
              {p.hero && <PageHero {...p.hero} photo={p.moodPhoto}>{p.hero.slot}</PageHero>}
              <Flash {...p.flash} />
              {p.journey && !p.hideJourneyBanner && !p.journey.nativeHero && !p.embedded && <JourneyBanner theme={p.journey} title={p.title} />}
              {p.children}
            </main>
          )}
          {area === 'public' && <Footer settings={p.settings} />}
          {area !== 'staff' && area !== 'admin' && (
            <a class="wa-float" href={`https://wa.me/${p.settings.business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener" aria-label="Chat on WhatsApp">
              💬 Need Help?
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
  const photoKey = opts.hero ? (await getContent(c.env)).mood_photos?.[opts.hero.mood] : null
  const moodPhoto = photoKey ? mediaUrl(photoKey, 1800, settings.images_transform) : null
  const area = opts.area ?? 'public'
  const bell = perms?.manage_enquiries && (area === 'staff' || area === 'admin')
    ? (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'").first<{ n: number }>().catch(() => null))?.n ?? 0
    : 0
  return c.html(
    <Layout {...opts} nav={publicNav(c.req.path)} journey={journeyTheme(c.req.path, opts.area)} embedded={c.req.query('preview') === '1'} user={user} settings={settings} perms={perms} flash={flash} turnstileSiteKey={c.env.TURNSTILE_SITE_KEY} siteUrl={c.env.SITE_URL} moodPhoto={moodPhoto} bell={bell}>
      {body}
    </Layout>,
    status as 200,
  )
}
