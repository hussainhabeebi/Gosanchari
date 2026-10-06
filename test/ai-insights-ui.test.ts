import { describe, expect, it } from 'vitest'
import { AiInsights } from '../src/views/components'

describe('public AI insights', () => {
  it('explains missing summaries without inventing recommendations', async () => {
    const html = String(await AiInsights({ entries: [] }))
    expect(html).toContain('Review insights appear here when summaries are available')
    expect(html).not.toContain('ai-insight-card')
    expect(html).toContain('href="/search"')
  })
  it('escapes untrusted review content and links to the actual property', async () => {
    const html = String(await AiInsights({ entries: [{ name: 'Test stay', slug: 'test-stay', destination: 'Munnar', rating_count: 4, review_summary: '<script>alert(1)</script>' }] }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('/stay/test-stay#ask')
    expect(html).toContain('AI-generated summaries of guest reviews')
  })
  it('labels search-scoped summaries as highlights for the results', async () => {
    const html = String(await AiInsights({ entries: [], search: true }))
    expect(html).toContain('Guest review highlights for stays in your results')
  })
})
