// @ts-expect-error Node-only stylesheet regression fixture.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('public primary CTA hierarchy', () => {
  it('reuses existing orange tokens with public-only primary, hover and keyboard focus styles', () => {
    const css=readFileSync('public/app.css','utf8') as string
    expect(css).toContain('.area-public .btn-primary { background: var(--cta-orange)')
    expect(css).toContain('.area-public .btn-primary:hover { background: var(--cta-orange-hover)')
    expect(css).toContain('.area-public .btn-primary:focus-visible { outline: 3px solid var(--ink)')
    expect(css).toContain('.area-public .btn-primary.btn-sm')
    expect(css).toContain('.area-public .btn-primary.btn-lg')
    expect(css).not.toContain('.area-admin .btn-primary')
  })
  it('marks equivalent public actions without promoting filters, account or utility controls', () => {
    const source=readFileSync('src/routes/public.tsx','utf8') as string
    expect(source).toContain('class="btn btn-primary find-stay"')
    expect(source).toContain('class="btn btn-lg btn-primary" data-trip-quote')
    expect(source).toContain('class="btn btn-primary" href="#book">Enquire')
    expect(source).toContain('class="btn">Apply filters')
    expect(source).toContain('class="carousel-arrow"')
    expect(source).toContain('class="btn btn-sm btn-outline filters-open"')
    const layout=readFileSync('src/views/layout.tsx','utf8') as string
    expect(layout).not.toContain('btn-primary')
    const components=readFileSync('src/views/components.tsx','utf8') as string
    expect(components).toContain('class="btn btn-sm btn-primary" data-stay-preview')
    expect(components).toContain('class="btn btn-sm btn-outline" href={`${base}${sep}page=${page - 1}`}')
  })
})
