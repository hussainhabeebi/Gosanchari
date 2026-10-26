import { describe, it, expect } from 'vitest'
import { metaPixelScript } from '../src/lib/meta-pixel'
const config = { enabled: true, pixel_id: '123456789012345', lead: true, book_now: true }
describe('Meta Pixel', () => {
  it('does not load when disabled, empty or an ID contains script injection', () => {
    for (const c of [{ ...config, enabled: false }, { ...config, pixel_id: '' }, { ...config, pixel_id: "12345</script>" }]) expect(metaPixelScript(c, 'Lead')).toBe('')
  })
  it('emits page views without inventing conversions on ordinary visits', () => {
    const script = metaPixelScript(config)
    expect(script).toContain("fbq('track','PageView')")
    expect(script).not.toContain("fbq('track','Lead')")
    expect(script).not.toContain("fbq('trackCustom','BookNow')")
  })
  it('uses standard Lead and custom BookNow only with their enabled receipt', () => {
    expect(metaPixelScript(config, 'Lead')).toContain("fbq('track','Lead')")
    expect(metaPixelScript(config, 'BookNow')).toContain("fbq('trackCustom','BookNow')")
    expect(metaPixelScript({ ...config, lead: false }, 'Lead')).not.toContain("fbq('track','Lead')")
    expect(metaPixelScript({ ...config, book_now: false }, 'BookNow')).not.toContain("fbq('trackCustom','BookNow')")
  })
})
