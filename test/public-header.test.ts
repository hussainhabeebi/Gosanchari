// @ts-expect-error Node-only client fixture.
import { readFileSync } from 'node:fs'
// @ts-expect-error Node-only client fixture.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Layout, publicNav } from '../src/views/layout'
import { DEFAULT_SETTINGS } from '../src/lib/settings'

describe('public header navigation', () => {
  it.each([['/','home'],['/search','stays'],['/destinations/Munnar','stays'],['/offers','offers'],['/packages/kerala','offers'],['/about','about'],['/contact','contact'],['/ai-search','ai-search'],['/ai-insights','ai-insights'],['/stay/test',undefined]])('maps %s to its menu', (path, active) => {
    expect(publicNav(path)).toBe(active)
  })
  it('renders the active indicator while preserving navigation and portal destinations', () => {
    const html = Layout({title:'About',nav:publicNav('/about'),settings:DEFAULT_SETTINGS,user:null,perms:null,flash:{},turnstileSiteKey:'',siteUrl:'http://localhost'})!.toString()
    expect(html).toContain('data-public-nav="about" aria-current="page"')
    const menu = html.slice(html.indexOf('<div class="topnav-menu">'), html.indexOf('<div class="topnav-account">'))
    for (const label of ['Home','AI Search','AI Insights','Destinations','Packages','About Us','Contact']) expect(menu).toContain(label)
    expect(menu).not.toContain('Portal Login')
    expect(html.slice(html.indexOf('<div class="topnav-account">'))).toContain('Portal Login')
    expect(html).not.toContain('data-public-nav="home" aria-current="page"')
    for (const label of ['Home','AI Search','AI Insights','Destinations','Packages','About Us','Contact','Portal Login']) expect(html).toContain(label)
    for (const href of ['/#ai-search','/#ai-insights','/offers','/about','/login?next=%2Fmy']) expect(html).toContain(href)
  })
  it('updates Home/AI fragment indicators without changing navigation', () => {
    const links = ['home','ai-search','ai-insights'].map(key=>({dataset:{publicNav:key},current:'',setAttribute(_k:string,v:string){this.current=v},removeAttribute(){this.current=''}}))
    const location={pathname:'/',hash:''}
    let hashchange:Function=()=>{}
    const source=readFileSync('public/app.js','utf8') as string
    runInNewContext(source.slice(source.indexOf('  function updatePublicNav'),source.indexOf('  // Keep native details/tap behavior')), {location,$$:()=>links,window:{addEventListener(_e:string,fn:Function){hashchange=fn}}})
    expect(links.map(l=>l.current)).toEqual(['page','',''])
    location.hash='#ai-search';hashchange();expect(links.map(l=>l.current)).toEqual(['','page',''])
    location.hash='#ai-insights';hashchange();expect(links.map(l=>l.current)).toEqual(['','','page'])
    location.hash='';hashchange();expect(links.map(l=>l.current)).toEqual(['page','',''])
  })
  it('opens Destinations on desktop hover/focus, closes outside, and preserves touch behavior', () => {
    const listeners:Record<string,Function>={}
    const inside={matches:()=>true}
    const dropdown={open:false,contains:(el:unknown)=>el===inside,addEventListener:(name:string,fn:Function)=>{listeners[name]=fn}}
    const media={matches:true}
    const document={activeElement:null as unknown}
    const source=readFileSync('public/app.js','utf8') as string
    runInNewContext(source.slice(source.indexOf('  var destinationsDropdown'),source.indexOf('  function post')),{$:()=>dropdown,window:{matchMedia:()=>media},document})
    listeners.mouseenter();expect(dropdown.open).toBe(true)
    listeners.mouseleave();expect(dropdown.open).toBe(false)
    listeners.focusin();expect(dropdown.open).toBe(true)
    document.activeElement=inside;listeners.mouseleave();expect(dropdown.open).toBe(true)
    listeners.focusout({relatedTarget:inside});expect(dropdown.open).toBe(true)
    listeners.focusout({relatedTarget:null});expect(dropdown.open).toBe(false)
    listeners.focusin();listeners.keydown({key:'Escape'});expect(dropdown.open).toBe(false)
    media.matches=false;listeners.mouseenter();listeners.focusin();expect(dropdown.open).toBe(false)
    dropdown.open=true;listeners.mouseleave();expect(dropdown.open).toBe(true)
    const css=readFileSync('public/app.css','utf8') as string
    expect(css).toContain('background: var(--cta-orange); color: #fff')
    expect(css).toContain('top: -12px; height: 12px')
  })

})
