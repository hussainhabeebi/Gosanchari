// @ts-expect-error Node-only browser-controller fixture.
import { readFileSync } from 'node:fs'
// @ts-expect-error Node-only browser-controller fixture.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

function fixture(reply: any) {
  const source = readFileSync('public/app.js', 'utf8') as string
  const children: any[] = [], elements: any[] = []
  const button = { disabled: false }, input = { value: 'Pool?' }
  const typing: any = { classList: { remove() {} }, appendChild(el: any) { children.push(el) }, textContent: '' }
  let submit: any
  const form: any = { q: input, querySelector: () => button, addEventListener(_: string, fn: any) { submit = fn } }
  const log = { insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 1 }
  const handoff = { hidden: true, message: { value: '' } }
  const qa = { dataset: { qa: '/stay/hotel/ask' } }
  const document = { createElement(tag: string) { const el: any = { tag, attrs: {}, style: {}, children: [], setAttribute(k: string,v: string) { this.attrs[k] = v }, appendChild(child: any) { this.children.push(child) } }; elements.push(el); return el } }
  let calls = 0
  runInNewContext(source.slice(source.indexOf('  // ---------- Property Q&A'), source.indexOf('  // ---------- Help chat')), {
    $: (selector: string) => selector === '[data-qa]' ? qa : selector === '.qa-log' ? log : selector === '.qa-form' ? form : selector === '.qa-handoff' ? handoff : typing,
    document, URL, Array, esc: (s: string) => s.replace(/</g,'&lt;'), post: () => { calls++; return Promise.resolve(reply) },
  })
  return { submit: () => submit({ preventDefault() {} }), button, elements, children, typing, calls: () => calls }
}
describe('property Q&A cited-answer rendering', () => {
  it('renders model text as text and validates external links without injecting provider HTML into the page', async () => {
    const f = fixture({ answer: '<script>bad()</script>', sources: ['javascript:bad()', 'http://bad.test', 'https://user:pass@bad.test', 'https://example.org/hotel'], searchSuggestions: '<script>bad()</script><div>Google</div>' })
    f.submit(); expect(f.button.disabled).toBe(true); f.submit(); expect(f.calls()).toBe(1)
    await new Promise(resolve => setTimeout(resolve,0))
    expect(f.typing.textContent).toBe('<script>bad()</script>')
    const links = f.elements.filter(el => el.tag === 'a'); expect(links).toHaveLength(1); expect(links[0].href).toBe('https://example.org/hotel'); expect(links[0].rel).toBe('noopener noreferrer')
    const frame = f.elements.find(el => el.tag === 'iframe')
    expect(frame.attrs.sandbox).not.toContain('allow-scripts'); expect(frame.attrs.sandbox).not.toContain('allow-same-origin')
    expect(frame.srcdoc).toContain('Content-Security-Policy'); expect(frame.srcdoc).toContain("default-src 'none'")
    expect(f.button.disabled).toBe(false)
  })
  it('does not render source widgets on uncited website-only answers', async () => {
    const f = fixture({ answer: 'Pool available', searchSuggestions: '<div>ignored</div>' }); f.submit()
    await new Promise(resolve => setTimeout(resolve,0))
    expect(f.elements).toHaveLength(0); expect(f.button.disabled).toBe(false)
  })
  it('keeps the AI warning visible on both standalone and embedded property pages', () => {
    const source = readFileSync('src/routes/public.tsx', 'utf8') as string
    expect(source).toContain('This is an AI-generated answer, please double-check it.')
    expect(source).toContain('Rates come only from Go Sanchari')
  })
})
