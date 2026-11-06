// @ts-expect-error Local-only stylesheet/route regression fixture.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AmenityList } from '../src/views/components'
import { CUSTOM_ICONS } from '../src/lib/taxonomy'
const labels = { pool:'Pool',wifi:'Wi-Fi',parking:'Parking',campfire:'Campfire',garden:'Garden',restaurant:'Restaurant',ac:'Air conditioning',kitchen:'Kitchen',gym:'Gym',spa:'Spa' }
afterEach(()=>{delete CUSTOM_ICONS.custom_test})
describe('compact public property and room amenities',()=>{
  it('keeps all ten amenities in their original order with accessible icons', async()=>{
    const html=String(await AmenityList({items:Object.keys(labels),label:'Property facilities',labels}))
    expect(html).toContain('aria-label="Property facilities"')
    expect(html.match(/<li>/g)).toHaveLength(10)
    expect(html).toContain('--amenity-rows:5')
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(10)
    let previous=-1
    for(const name of Object.values(labels)){const position=html.indexOf('>'+name+'</span>');expect(position).toBeGreaterThan(previous);previous=position}
    expect(html).toContain('🏊');expect(html).toContain('📶')
  })
  it('preserves long custom labels, honours configured icons and escapes untrusted content',async()=>{
    CUSTOM_ICONS.custom_test='◇'
    const custom='Very long custom amenity name without removing any original words'
    const html=String(await AmenityList({items:['custom_test',custom,'<script>alert(1)</script>'],label:'Room amenities'}))
    expect(html).toContain('◇');expect(html).toContain('custom_test');expect(html).toContain(custom)
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>')
    expect(html.match(/<li>/g)).toHaveLength(3)
  })
  it('does not invent facilities when none are configured',async()=>{
    expect(await AmenityList({items:[],label:'Room amenities'})).toBeNull()
  })
  it('uses balanced two-column flow with wrapping and item-level break protection',()=>{
    const css=readFileSync('public/app.css','utf8') as string
    const rules=css.slice(css.indexOf('/* Two balanced amenity columns'))
    expect(rules).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');expect(rules).toContain('grid-auto-flow:column');expect(rules).toContain('break-inside:avoid');expect(rules).toContain('overflow-wrap:anywhere')
    expect(rules).toContain('@media(max-width:650px)');expect(rules).not.toMatch(/(?:^|[;{])height:|overflow:hidden|white-space:nowrap/)
    const routes=readFileSync('src/routes/public.tsx','utf8') as string
    expect(routes.match(/<AmenityList items=\{am\}/g)).toHaveLength(2)
    expect(routes).toContain('<AmenityList items={facilities} label="Property facilities" />')
  })
})
