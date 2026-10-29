// @ts-expect-error Node-only client regression fixture.
import { readFileSync } from 'node:fs'
// @ts-expect-error Node-only client regression fixture.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ComparisonRate, PropertyCard } from '../src/views/components'
import { money } from '../src/lib/util'
const script = readFileSync('public/app.js','utf8') as string
const runtime: any = { Intl, Number, Math }
runInNewContext(script.slice(0, script.indexOf('// Go Sanchari client script:')), runtime)
const card: any = {id:1,slug:'test',name:'Public stay',destination:'Munnar',facilities:'[]',from_price:4000,rating_avg:0,staff_rate:123456,net_rate:234567}
describe('public display-only comparison rates', () => {
  it.each([4000, 1000, 3999, 4000.5, 100000])('shows 5 percent above %s consistently on server and client', async value => {
    const html = String(await ComparisonRate({value}))
    expect(html).toContain('<s>'+money(value*1.05)+'</s>')
    expect(html).toBe(runtime.gsPublicComparisonRate(value))
    expect(html).toContain('Comparison rate (+5%)'); expect(html).toContain('not a previous price')
    expect(html).not.toMatch(/Original price|5% off|discount/)
  })
  it('keeps the selling price, property links and private-rate boundaries unchanged', async () => {
    const before = JSON.stringify(card)
    const html = String(await PropertyCard({p:card}))
    expect(html).toContain('<s>₹4,200</s>'); expect(html).toContain('<div class="price">₹4,000</div>')
    expect(html).toContain('/stay/test'); expect(html).not.toMatch(/123456|234567|1,23,456|2,34,567/)
    expect(JSON.stringify(card)).toBe(before)
  })
  it('uses the date-resolved public nightly rate rather than the fallback rate', async () => {
    const html = String(await PropertyCard({p:{...card,stay_price:8000,stay_total:18880}}))
    expect(html).toContain('<s>₹8,400</s>'); expect(html).toContain('<div class="price">₹8,000</div>')
    expect(html).toContain('₹18,880 total incl. GST'); expect(html).not.toContain('₹4,200')
  })
  it.each([0,-1,NaN,Infinity])('omits invalid or missing comparisons for %s', async value => {
    expect(String(await ComparisonRate({value}) ?? '')).toBe('')
    expect(runtime.gsPublicComparisonRate(value)).toBe('')
  })
  it('keeps enquiry treatment when no public selling rate is available', async () => {
    const html=String(await PropertyCard({p:{...card,from_price:0}}))
    expect(html).toContain('For a personalised offer'); expect(html).not.toContain('comparison-rate'); expect(html).not.toContain('₹0')
  })
  it('limits dynamic comparisons to accommodation, leaving taxes, extras and totals untouched', () => {
    const box=script.slice(script.indexOf('// ---------- Booking box live price'),script.indexOf('// ---------- Property Q&A'))
    expect(box).toContain('gsPublicComparisonRate(p.roomCharges != null ? p.roomCharges : p.subtotal)')
    expect(box).not.toMatch(/gsPublicComparisonRate\(p\.(total|taxes|discount|extraGuests)/)
    expect(box).toContain("money(p.total) + '</td></tr></table>'")
    expect(script).toContain('gsPublicComparisonRate(nightlyRate)')
  })
})
