// Allowlist HTML sanitizer for blog content (stored XSS protection). Runs on every save and again on display.
//
// The input is tokenised and the output is rebuilt from scratch: only allowlisted tags are written, each with
// only its allowlisted attributes, every attribute value and every text run is escaped, and URLs must use a safe
// scheme. Anything else is dropped. Dangerous elements (script, style, iframe, svg, \u2026) are removed with their
// content; other unknown tags are removed but their text is kept. Tags are balanced, so nothing can leak out.

const VOID = new Set(['br', 'hr', 'img'])
const BLOCK = new Set(['p', 'ul', 'ol', 'h2', 'h3', 'h4', 'blockquote'])
const ALLOWED: Record<string, string[]> = {
  p: [], br: [], hr: [], h2: [], h3: [], h4: [], strong: [], em: [], u: [], s: [], ul: [], ol: [], li: [],
  blockquote: [], a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'],
}
// Editor and pasted markup mapped onto the allowlist.
const RENAME: Record<string, string> = { b: 'strong', i: 'em', strike: 's', del: 's', div: 'p', h1: 'h2', h5: 'h4', h6: 'h4' }
// Removed together with everything inside them.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes', 'template', 'textarea', 'title', 'svg', 'math', 'select', 'option', 'xmp', 'plaintext', 'head', 'form', 'button', 'canvas', 'audio', 'video', 'link', 'meta', 'base'])

// Dropped elements that have no closing tag: drop the tag only, never wait for a closing tag.
const VOID_DROPPED = new Set(['link', 'meta', 'base', 'embed', 'param', 'source', 'track', 'input', 'keygen', 'frame', 'area', 'col', 'wbr'])

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', period: '.', comma: ',' }

/** Decode character references, so `jav&#x61;script:` or `&colon;` cannot hide a scheme. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const n = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    const v = NAMED[ref.toLowerCase()]
    return v ?? m
  })
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Text from the source: decode once, then escape, so entities stay correct and nothing becomes markup. */
const text = (s: string) => escapeHtml(decodeEntities(s))

/** A safe URL for href/src, or null. Relative paths, http(s), and (links only) mailto/tel. */
export function safeUrl(raw: string, kind: 'href' | 'src'): string | null {
  const v = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
  if (!v) return null
  const scheme = v.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (scheme) {
    const ok = kind === 'href' ? ['http', 'https', 'mailto', 'tel'] : ['https']
    if (!ok.includes(scheme)) return null
    if ((scheme === 'http' || scheme === 'https') && !/^https?:\/\/[^/\\]/i.test(v)) return null
  } else {
    if (v.startsWith('//') || v.startsWith('\\') || v.startsWith('/\\')) return null // protocol-relative
    if (kind === 'src' && !v.startsWith('/media/')) return null
    if (kind === 'href' && !/^(\/|#|\?)/.test(v)) return null
  }
  return v
}

function attributes(tag: string, src: string, siteHost: string | null): string {
  const allowed = ALLOWED[tag]
  if (!allowed.length) return ''
  const out: Record<string, string> = {}
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase()
    if (!allowed.includes(name) || name in out) continue
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    if (name === 'href' || name === 'src') {
      const url = safeUrl(value, name)
      if (url) out[name] = url
    } else if (name === 'width' || name === 'height') {
      if (/^\d{1,4}$/.test(value.trim())) out[name] = value.trim()
    } else {
      out[name] = decodeEntities(value).slice(0, 300)
    }
  }
  if (tag === 'img' && !out.src) return '\u0000' // an image without a safe source is dropped
  if (tag === 'img') out.alt = out.alt ?? ''
  if (tag === 'a' && out.href) {
    let external = /^(https?:)?\/\//i.test(out.href)
    if (external && siteHost) try { external = new URL(out.href).host !== siteHost } catch { /* keep external */ }
    if (external) { out.rel = 'noopener noreferrer nofollow'; out.target = '_blank' }
  }
  return Object.entries(out).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('')
}

export interface SanitizeOptions { siteUrl?: string; maxLength?: number }

export function sanitizeHtml(input: string, opts: SanitizeOptions = {}): string {
  const src = String(input ?? '').slice(0, opts.maxLength ?? 200_000)
  let siteHost: string | null = null
  try { siteHost = opts.siteUrl ? new URL(opts.siteUrl).host : null } catch { siteHost = null }
  const out: string[] = []
  const stack: string[] = []
  let dropping: string | null = null
  // Comments, CDATA, doctypes / processing instructions, tags \u2014 or text up to the next "<".
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<|[^<]+/g
  let m: RegExpExecArray | null
  while ((m = token.exec(src))) {
    const whole = m[0]
    if (m[2] === undefined) {
      if (whole.startsWith('<!') || whole.startsWith('<?')) continue // comments, doctype, CDATA
      if (!dropping) out.push(whole === '<' ? '&lt;' : text(whole))
      continue
    }
    const closing = m[1] === '/'
    const rawName = m[2].toLowerCase()
    if (dropping) {
      if (closing && rawName === dropping) dropping = null
      continue
    }
    if (DROP_WITH_CONTENT.has(rawName)) {
      if (!closing && !/\/\s*$/.test(m[3]) && !VOID_DROPPED.has(rawName)) dropping = rawName
      continue
    }
    const name = RENAME[rawName] ?? rawName
    if (!(name in ALLOWED)) continue
    if (closing) {
      if (VOID.has(name)) continue
      const at = stack.lastIndexOf(name)
      if (at === -1) continue
      while (stack.length > at) out.push(`</${stack.pop()}>`)
      continue
    }
    const attrs = attributes(name, m[3], siteHost)
    if (attrs === '\u0000') continue
    if (name === 'hr' && stack.includes('p')) { const at = stack.lastIndexOf('p'); while (stack.length > at) out.push(`</${stack.pop()}>`) }
    if (VOID.has(name)) { out.push(`<${name}${attrs}>`); continue }
    // No nested links; a new list item / paragraph closes an open one of the same kind.
    if (name === 'a' && stack.includes('a')) continue
    if ((name === 'p' || name === 'li') && stack[stack.length - 1] === name) out.push(`</${stack.pop()}>`)
    // Block elements can't sit inside a paragraph (browsers' list buttons create <p><ul>…): close the paragraph first.
    if (BLOCK.has(name) && stack.includes('p')) { const at = stack.lastIndexOf('p'); while (stack.length > at) out.push(`</${stack.pop()}>`) }
    if (stack.length >= 40) continue
    stack.push(name)
    out.push(`<${name}${attrs}>`)
  }
  while (stack.length) out.push(`</${stack.pop()}>`)
  // Drop empty paragraphs the editor leaves behind.
  return out.join('').replace(/<p>(\s|&nbsp;|\u00a0|<br>)*<\/p>/g, '').trim()
}

/** Plain text of sanitized HTML (for word counts and fallback descriptions). */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|h[2-4]|li|blockquote)>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}
