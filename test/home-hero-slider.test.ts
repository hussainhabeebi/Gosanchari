// @ts-expect-error Node-only regression fixture.
import { readFileSync, statSync } from 'node:fs'
// @ts-expect-error Node-only regression fixture.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync('public/app.js', 'utf8') as string
function fixture(reduce = false) {
  const events: Record<string, Function> = {}, documentEvents: Record<string, Function> = {}, windowEvents: Record<string, Function> = {}
  const nodes: Record<string, any> = {}
  for (const name of ['prev', 'next', 'pause', 'counter']) nodes[name] = { textContent: '', attrs: {} as any, setAttribute(k: string, v: string) { this.attrs[k] = v }, addEventListener(k: string, fn: Function) { events[name + ':' + k] = fn } }
  const slides = Array.from({ length: 3 }, (_, i) => ({ active: i === 0, hidden: i !== 0, image: { complete: true, naturalWidth: 1774, loading: 'lazy' }, querySelector() { return this.image }, classList: { toggle(_name: string, value: boolean) { slides[i].active = value } }, setAttribute(_key: string, value: string) { this.hidden = value === 'true' } }))
  const carousel = { querySelectorAll: () => slides, querySelector: (s: string) => nodes[s.slice(11, -1)], contains: (n: unknown) => n === nodes.pause, addEventListener(k: string, fn: Function) { events[k] = fn } }
  let timer: Function | null = null, delay = 0, motionChange: Function = () => {}
  const reduced = { matches: reduce, addEventListener(_k: string, fn: Function) { motionChange = fn } }
  const document = { hidden: false, querySelector: () => carousel, addEventListener(k: string, fn: Function) { documentEvents[k] = fn } }
  const window = { matchMedia: () => reduced, setTimeout(fn: Function, ms: number) { timer = fn; delay = ms; return 1 }, clearTimeout() { timer = null }, addEventListener(k: string, fn: Function) { windowEvents[k] = fn } }
  runInNewContext(source.slice(source.indexOf('// Homepage banner carousel:'), source.indexOf('// End homepage banner carousel.')), { document, window, Array, String })
  return { slides, events, nodes, reduced, document, documentEvents, windowEvents, motionChange: () => motionChange(), get timer() { return timer }, get delay() { return delay }, tick() { const fn = timer; timer = null; fn?.() } }
}

describe('homepage uploaded hero banners', () => {
  it('contains three optimized complete banners and keeps existing search fields', () => {
    const route = readFileSync('src/routes/public.tsx', 'utf8') as string
    for (const name of ['romance', 'direct-offer', 'tea-valley']) {
      expect(route).toContain(`home-hero-${name}.webp`)
      expect(statSync(`public/design/home-hero-${name}.webp`).size).toBeLessThan(350000)
    }
    expect(route).toContain('aria-roledescription="carousel"')
    expect(route).toContain('width="1774" height="887"')
    expect(route).toContain("fetchpriority={index === 0 ? 'high' : 'low'}")
    for (const name of ['destination', 'checkIn', 'checkOut', 'guests', 'children']) expect(route).toContain(`name="${name}"`)
    const css = readFileSync('public/app.css', 'utf8') as string
    expect(route).not.toContain('data-hero-counter')
    expect(route).toContain('class="home-hero-pause"')
    expect(css).toContain('height:clamp(220px,36vw,620px)')
    expect(css).toContain('.home-hero-controls { position:absolute;inset:0;')
    expect(css).toContain('pointer-events:auto')
    expect(css).toContain('.home-hero-pause:focus-visible')
    expect(css).toContain('height:auto;aspect-ratio:2/1;')
    expect(css).toContain('object-fit:contain')
    expect(css).toContain('min-height:44px')
    expect(css).toContain('@media(prefers-reduced-motion:reduce) { .home-hero-slide { transition:none; } }')
  })
  it('crossfades every four seconds, wraps, and updates the current slide accessibility state', () => {
    const f = fixture(); expect(f.delay).toBe(4000)
    f.tick(); expect(f.slides.map(s => s.active)).toEqual([false, true, false]); expect(f.slides.map(s => s.hidden)).toEqual([true, false, true])
    f.tick(); f.tick(); expect(f.slides[0].active).toBe(true)
    f.events['prev:click'](); expect(f.slides[2].active).toBe(true)
    f.events['next:click'](); expect(f.slides[0].active).toBe(true)
  })
  it('pauses and resumes explicitly and while hovered, focused or in a background tab', () => {
    const f = fixture(); f.events['pause:click'](); expect(f.timer).toBeNull(); expect(f.nodes.pause.attrs['aria-pressed']).toBe('true')
    f.events['pause:click'](); expect(f.timer).not.toBeNull()
    f.events.mouseenter(); expect(f.timer).toBeNull(); f.events.mouseleave(); expect(f.timer).not.toBeNull()
    f.events.focusin(); expect(f.timer).toBeNull(); f.events.focusout({ relatedTarget: f.nodes.pause }); expect(f.timer).toBeNull(); f.events.focusout({ relatedTarget: null }); expect(f.timer).not.toBeNull()
    f.document.hidden = true; f.documentEvents.visibilitychange(); expect(f.timer).toBeNull(); f.document.hidden = false; f.documentEvents.visibilitychange(); expect(f.timer).not.toBeNull()
    f.windowEvents.pagehide(); expect(f.timer).toBeNull(); f.windowEvents.pageshow(); expect(f.timer).not.toBeNull()
  })
  it('respects reduced motion initially and after preference changes without disabling manual navigation', () => {
    const f = fixture(true); expect(f.timer).toBeNull(); f.events['next:click'](); expect(f.slides[1].active).toBe(true); expect(f.timer).toBeNull()
    f.reduced.matches = false; f.events['pause:click'](); expect(f.timer).not.toBeNull()
    f.reduced.matches = true; f.motionChange(); expect(f.timer).toBeNull()
  })
  it('does not fade to an unloaded or failed image', () => {
    const f = fixture(); f.slides[1].image.complete = false; f.tick(); expect(f.slides[0].active).toBe(true); expect(f.slides[1].image.loading).toBe('eager')
    f.slides[1].image.complete = true; f.slides[1].image.naturalWidth = 0; f.tick(); expect(f.slides[0].active).toBe(true)
    f.slides[1].image.naturalWidth = 1774; f.tick(); expect(f.slides[1].active).toBe(true)
  })
  it('does nothing on other public, Staff or Admin pages', () => {
    runInNewContext(source.slice(source.indexOf('// Homepage banner carousel:'), source.indexOf('// End homepage banner carousel.')), { document: { querySelector: () => null } })
  })
})
