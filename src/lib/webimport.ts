// "Add from website link": read a resort's own website for property quick fill.
//  - Only public http(s) addresses; local / private network addresses are refused (SSRF guard).
//  - Booking sites (Booking.com, MakeMyTrip, Agoda…) are refused: their terms forbid copying listings.
//  - Each page: 10 s timeout, at most 2 MB read. The home page plus up to 3 linked pages about rooms,
//    tariff, facilities or contact are read, because resort sites usually split these up.
//  - Besides the visible text, schema.org JSON-LD (Hotel / LodgingBusiness), og: meta tags and tel: / mailto:
//    links are kept: they carry exact facts (name, address, coordinates, phone).
//  - Gallery images are listed so staff can pick photos to import (with the owner's permission).

const PAGE_TIMEOUT_MS = 10_000
const MAX_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_SUBPAGES = 3
const MAX_IMAGES = 40
const UA = 'Mozilla/5.0 (compatible; GoSanchariPropertyImport/1.0)'

/** Domains whose terms forbid copying listings. Staff are asked for the resort's own website instead. */
export const BLOCKED_SITES = [
  'booking.com', 'makemytrip.com', 'agoda.com', 'goibibo.com', 'expedia.com', 'expedia.co.in', 'airbnb.com', 'airbnb.co.in',
  'tripadvisor.com', 'tripadvisor.in', 'hotels.com', 'trivago.com', 'trivago.in', 'cleartrip.com', 'yatra.com', 'oyorooms.com',
  'easemytrip.com', 'ixigo.com', 'trip.com', 'kayak.com', 'kayak.co.in',
]

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string }

function privateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [+m[1], +m[2]]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

/** Is this an address we may fetch? Public http(s) only, no IP-literal / local hosts, no booking sites. */
export function checkImportUrl(raw: string, opts: { allowBookingSites?: boolean } = {}): UrlCheck {
  let s = raw.trim()
  if (!s) return { ok: false, error: 'Please paste a website link.' }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  let url: URL
  try { url = new URL(s) } catch { return { ok: false, error: 'That does not look like a website link.' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Only http(s) website links can be read.' }
  if (url.username || url.password) return { ok: false, error: 'Links with a username or password cannot be read.' }
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, error: 'Links with an unusual port cannot be read.' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || host.startsWith('[') || privateIPv4(host) || /^\d+$/.test(host) || /^0x/i.test(host)
    || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) {
    return { ok: false, error: 'Only public websites can be read.' }
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, error: 'Please use the website name, not an IP address.' }
  if (!opts.allowBookingSites && BLOCKED_SITES.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, error: 'Booking sites (Booking.com, MakeMyTrip, Agoda…) do not allow copying their listings. Please use the resort’s own website.' }
  }
  url.hash = ''
  return { ok: true, url }
}

/** Read a response body, stopping at `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > max) return null
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, max)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => {}); return null }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.byteLength }
  return out
}

/** Fetch with manual redirects so every hop is checked again (a public page must not bounce us to a private one). */
export async function safeFetch(raw: string, accept: string, max: number, fetcher: typeof fetch = fetch): Promise<{ url: URL; type: string; body: Uint8Array } | { error: string }> {
  let check = checkImportUrl(raw, { allowBookingSites: accept.startsWith('image/') })
  for (let hop = 0; hop < 5; hop++) {
    if (!check.ok) return { error: check.error }
    let res: Response
    try {
      res = await fetcher(check.url.toString(), { redirect: 'manual', headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) })
    } catch (e) {
      return { error: (e as Error)?.name === 'TimeoutError' ? 'The website took too long to answer.' : 'Could not reach the website.' }
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      check = checkImportUrl(new URL(res.headers.get('location')!, check.url).toString(), { allowBookingSites: accept.startsWith('image/') })
      continue
    }
    if (!res.ok) return { error: `The website answered with an error (${res.status}).` }
    const body = await readCapped(res, max)
    if (!body) return { error: 'The page is too large to read.' }
    return { url: check.url, type: (res.headers.get('content-type') ?? '').toLowerCase(), body }
  }
  return { error: 'The website redirected too many times.' }
}

// ---- HTML parsing (plain string work, so it also runs in tests outside Workers) ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', rupee: '₹' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : null
}

/** Visible text of a page, keeping blocks and table rows on their own lines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, ' | ')
      .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|tr|table|h[1-6]|dt|dd|dl|figure|figcaption|blockquote|address|form|label|option)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\| ?\n/g, '\n')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface PageFacts {
  title: string
  meta: Record<string, string>
  jsonLd: unknown[]
  phones: string[]
  emails: string[]
  links: { url: string; text: string }[]
  images: string[]
  text: string
}

const LODGING = /^(hotel|resort|lodgingbusiness|bedandbreakfast|hostel|motel|campground|vacationrental|apartment|house|accommodation|localbusiness|organization|place|touristaccommodation|hotelroom|room|suite|offer|aggregaterating|postaladdress|geocoordinates)$/i

/** Keep only JSON-LD that describes the place (drops breadcrumbs, web-site search boxes, articles…). */
function lodgingLd(x: unknown): unknown[] {
  if (!x || typeof x !== 'object') return []
  if (Array.isArray(x)) return x.flatMap(lodgingLd)
  const o = x as Record<string, unknown>
  if (Array.isArray(o['@graph'])) return lodgingLd(o['@graph'])
  const types = ([] as unknown[]).concat(o['@type'] ?? []).map(String)
  return types.some((t) => LODGING.test(t)) ? [o] : []
}

const SKIP_IMG = /(logo|icon|favicon|sprite|avatar|badge|payment|visa|mastercard|paypal|tripadvisor|booking|flag|loader|loading|spinner|placeholder|blank|pixel|emoji|arrow|button|banner-ad|ads?[-_/]|social|facebook|instagram|twitter|whatsapp|youtube)/i

function bestFromSrcset(srcset: string): string | null {
  let best: [string, number] | null = null
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/)
    if (!u) continue
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1
    if (!best || w > best[1]) best = [u, w]
  }
  return best?.[0] ?? null
}

/** Pull the useful facts out of one HTML page. `base` resolves relative links. */
export function parsePage(html: string, base: URL): PageFacts {
  const abs = (u: string | null) => {
    if (!u || u.startsWith('data:') || u.startsWith('javascript:')) return null
    try { const x = new URL(u, base); return x.protocol === 'http:' || x.protocol === 'https:' ? x : null } catch { return null }
  }
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim())
  const meta: Record<string, string> = {}
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const k = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase()
    const v = attr(tag, 'content')
    if (v && /^(description|keywords|og:(title|description|site_name|street-address|locality|region|postal-code|phone_number|email|latitude|longitude)|place:location:(latitude|longitude)|geo\.position|icbm)$/.test(k)) meta[k] = v.slice(0, 500)
  }
  const jsonLd: unknown[] = []
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonLd.push(...lodgingLd(JSON.parse(m[1].trim()))) } catch { /* broken JSON-LD is common; skip it */ }
  }
  const phones = new Set<string>(), emails = new Set<string>()
  const links: { url: string; text: string }[] = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, 'href') ?? ''
    if (/^tel:/i.test(href)) { phones.add(decodeURIComponent(href.slice(4)).replace(/[^\d+]/g, '')); continue }
    if (/^mailto:/i.test(href)) { emails.add(decodeURIComponent(href.slice(7)).split('?')[0].trim()); continue }
    const u = abs(href)
    if (u) links.push({ url: u.toString(), text: htmlToText(m[2]).replace(/\s+/g, ' ').slice(0, 80) })
  }
  const images: string[] = []
  const seen = new Set<string>()
  const addImg = (u: string | null) => {
    const x = abs(u)
    if (!x) return
    const key = x.toString()
    if (seen.has(key) || SKIP_IMG.test(x.pathname) || /\.(svg|gif|ico)(\?|$)/i.test(x.pathname)) return
    seen.add(key)
    images.push(key)
  }
  for (const k of ['og:image', 'og:image:url', 'twitter:image']) {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) if ((attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase() === k) addImg(attr(tag, 'content'))
  }
  for (const tag of html.match(/<(img|source)\b[^>]*>/gi) ?? []) {
    const w = parseInt(attr(tag, 'width') ?? '', 10), h = parseInt(attr(tag, 'height') ?? '', 10)
    if ((w && w < 200) || (h && h < 150)) continue
    const set = attr(tag, 'data-srcset') ?? attr(tag, 'srcset')
    addImg((set && bestFromSrcset(set)) || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'src'))
  }
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:jpe?g|png|webp))(?:\?[^"']*)?["']/gi)) addImg(m[1])
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+\.(?:jpe?g|png|webp)[^'")]*)['"]?\s*\)/gi)) addImg(decodeEntities(m[1]))
  return { title, meta, jsonLd, phones: [...phones].filter((p) => p.replace(/\D/g, '').length >= 8), emails: [...emails].filter((e) => /@/.test(e)), links, images, text: htmlToText(html) }
}

const SUBPAGE = /(room|suite|cottage|villa|accommodation|stay|tariff|rate|price|package|facilit|amenit|dining|restaurant|contact|about|location|reach|policy|polic|faq|gallery)/i

/** Pick the linked pages worth reading: same site, about rooms / tariff / facilities / contact, most useful first. */
export function pickSubpages(links: { url: string; text: string }[], home: URL, max = MAX_SUBPAGES): string[] {
  const host = home.hostname.replace(/^www\./, '')
  const score = (l: { url: string; text: string }) => {
    const s = `${new URL(l.url).pathname} ${l.text}`
    return /(room|suite|cottage|villa|accommodation|tariff|rate|price)/i.test(s) ? 3 : /(facilit|amenit|dining|restaurant)/i.test(s) ? 2 : /(contact|location|reach|polic|faq)/i.test(s) ? 1 : 0
  }
  const out: [string, number][] = []
  const seen = new Set([home.toString().replace(/\/$/, '')])
  for (const l of links) {
    const u = new URL(l.url)
    u.hash = ''
    const key = u.toString().replace(/\/$/, '')
    if (seen.has(key) || u.hostname.replace(/^www\./, '') !== host) continue
    if (/\.(pdf|jpe?g|png|webp|gif|zip|docx?)$/i.test(u.pathname) || /(login|cart|checkout|wp-admin|feed|tag\/|category\/|blog)/i.test(u.pathname)) continue
    if (!SUBPAGE.test(`${u.pathname} ${l.text}`)) continue
    seen.add(key)
    out.push([key, score(l)])
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, max).map(([u]) => u)
}

/** The facts of all pages as one block of notes for the AI. */
export function pagesToNotes(pages: { url: string; facts: PageFacts }[], limit = 40000): string {
  const parts: string[] = []
  const first = pages[0]?.facts
  if (first) {
    const head = [
      `Website: ${pages[0].url}`,
      first.title && `Title: ${first.title}`,
      ...Object.entries(first.meta).map(([k, v]) => `${k}: ${v}`),
    ].filter(Boolean)
    parts.push(head.join('\n'))
  }
  const ld = pages.flatMap((p) => p.facts.jsonLd)
  if (ld.length) parts.push(`Structured data published by the website (schema.org, reliable):\n${JSON.stringify(ld).slice(0, 8000)}`)
  const phones = [...new Set(pages.flatMap((p) => p.facts.phones))]
  const emails = [...new Set(pages.flatMap((p) => p.facts.emails))]
  if (phones.length || emails.length) parts.push(`Contact links on the website: ${[...phones, ...emails].join(', ')}`)
  const each = Math.floor(limit / Math.max(1, pages.length))
  for (const p of pages) parts.push(`--- Page: ${p.url} ---\n${p.facts.text.slice(0, each)}`)
  return parts.join('\n\n').slice(0, limit)
}

export interface WebImport {
  url: string
  notes: string
  /** Characters of visible text found; little text usually means the site draws its content with JavaScript. */
  textLength: number
  pages: string[]
  images: string[]
}

/** Read a resort website (home + up to 3 useful linked pages). */
export async function readWebsite(raw: string, fetcher: typeof fetch = fetch): Promise<WebImport | { error: string }> {
  const home = await safeFetch(raw, 'text/html,application/xhtml+xml', MAX_PAGE_BYTES, fetcher)
  if ('error' in home) return home
  if (!/html|xml|text\/plain/.test(home.type) && home.type) return { error: 'That link is not a web page. For a PDF brochure, download it and attach it as a file.' }
  const html = new TextDecoder().decode(home.body)
  const homeFacts = parsePage(html, home.url)
  const subs = pickSubpages(homeFacts.links, home.url)
  const more = await Promise.all(subs.map(async (u) => {
    const r = await safeFetch(u, 'text/html,application/xhtml+xml', MAX_PAGE_BYTES, fetcher)
    if ('error' in r || (r.type && !/html|xml/.test(r.type))) return null
    return { url: r.url.toString(), facts: parsePage(new TextDecoder().decode(r.body), r.url) }
  }))
  const pages = [{ url: home.url.toString(), facts: homeFacts }, ...more.filter((x): x is { url: string; facts: PageFacts } => !!x)]
  const images = [...new Set(pages.flatMap((p) => p.facts.images))].slice(0, MAX_IMAGES)
  return {
    url: home.url.toString(),
    notes: pagesToNotes(pages),
    textLength: pages.reduce((a, p) => a + p.facts.text.length, 0),
    pages: pages.map((p) => p.url),
    images,
  }
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp|avif)$/

/** Download one picked website image (for import into the gallery). */
export async function fetchImage(raw: string, fetcher: typeof fetch = fetch): Promise<{ type: string; body: Uint8Array } | { error: string }> {
  const r = await safeFetch(raw, 'image/avif,image/webp,image/jpeg,image/png', MAX_IMAGE_BYTES, fetcher)
  if ('error' in r) return r
  const type = r.type.split(';')[0].trim()
  if (!IMAGE_TYPES.test(type)) return { error: 'not a JPG / PNG / WebP / AVIF image' }
  if (r.body.byteLength < 8 * 1024) return { error: 'image too small' }
  return { type, body: r.body }
}
