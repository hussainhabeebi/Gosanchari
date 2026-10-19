// @ts-expect-error Tests use Node; application types target Workers.
import { readFileSync } from 'node:fs'
// @ts-expect-error Tests use Node; application types target Workers.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { analyticsPage, GA4_READINESS } from '../src/lib/analytics'
import { Layout, page } from '../src/views/layout'
import { Hono } from 'hono'
import { DEFAULT_SETTINGS } from '../src/lib/settings'

const ready = { readiness: GA4_READINESS, policy: 'Approved Google Analytics disclosure with consent choices.', origin: 'https://gosanchari.com', path: '/', area: 'public', authenticated: false, status: 200 }
const source = readFileSync('public/analytics.js', 'utf8')
function browser(options: { stored?: any; unavailable?: boolean; path?: string; eligible?: boolean; origin?: string; state?: any; legacy?: boolean } = {}) {
  const nodes: any = {}
  for (const name of ['panel','settings','accept','reject']) nodes[name] = { hidden: true, children: [], appendChild(node:any) { this.children.push(node) }, focus() {}, addEventListener(_event: string, fn: any) { this.click = fn } }
  const state = options.state || { raw: options.stored ? JSON.stringify({...options.stored,check:'initial'}) : null, failRead: !!options.unavailable, failWrite: !!options.unavailable, silentWrite: false, failCookie: false, cookies: new Map([['_ga','existing'],['unrelated','keep']]) }
  if (!options.state && options.stored && !options.legacy) state.cookies.set('gs_analytics_consent',options.stored.value+'.'+options.stored.at+'.initial')
  const scripts: any[] = []; const writes: any[] = []; let reloads = 0
  const root = { dataset: { page: options.path || '/' }, querySelector(selector: string) { return nodes[selector.match(/consent-(\w+)/)![1]] } }
  const document = {
    get cookie() { return [...state.cookies].map(([k,v]:any)=>k+'='+v).join('; ') },
    set cookie(value:string) { if(state.failCookie) return; const [pair]=value.split(';'); const eq=pair.indexOf('='); const name=pair.slice(0,eq); if(value.includes('Max-Age=0')) state.cookies.delete(name); else state.cookies.set(name,pair.slice(eq+1)) },
    getElementById: () => options.eligible === false ? null : root,
    createElement: () => ({textContent:'',setAttribute(){},removed:false,remove(){this.removed=true}}), head: { appendChild: (node: any) => scripts.push(node) }
  }
  const window: any = {}
  const context = { window, document, Date, location: { origin: options.origin || 'https://gosanchari.com', href: 'https://gosanchari.com/?email=private@example.com#phone', reload() { reloads++ } }, localStorage: {
    getItem() { if (state.failRead) throw Error('blocked'); return state.raw },
    setItem(k: string, v: string) { if (state.failWrite) throw Error('blocked'); writes.push([k,JSON.parse(v)]); if(!state.silentWrite) state.raw=v }
  } }
  runInNewContext(source,context)
  return { nodes, scripts, window, writes, document, context, state, reloads: () => reloads, commands: () => (window.dataLayer || []).map((args: any) => Array.from(args)) }
}

describe('consent-first public GA4', () => {
  it('is disabled unless privacy and account readiness are explicitly approved and the policy is not a placeholder', () => {
    expect(analyticsPage(ready)).toBe('/')
    for (const change of [{readiness:undefined},{readiness:'true'},{policy:''},{policy:'This policy is being updated. Google Analytics consent'},{policy:'A privacy policy without analytics disclosure'},{origin:'http://localhost'}]) expect(analyticsPage({...ready,...change})).toBeUndefined()
  })
  it('excludes private, sensitive, unknown, authenticated, preview and error pages even with readiness approval', () => {
    for (const path of ['/staff','/admin','/my','/q/customer-token','/booking/token','/invoice/token','/login','/help','/enquiry','/enquiry/thanks/code','/unrecognised','/stay/person@example.com']) expect(analyticsPage({...ready,path})).toBeUndefined()
    for (const change of [{area:'staff'},{area:'admin'},{area:'guest'},{authenticated:true},{embedded:true},{noindex:true},{status:404}]) expect(analyticsPage({...ready,...change})).toBeUndefined()
  })
  it('uses only fixed public paths, never property names, slugs, form values or query input', () => {
    expect(analyticsPage({...ready,path:'/stay/existing-property'})).toBe('/stay/property')
    expect(analyticsPage({...ready,path:'/search'})).toBe('/search')
    expect(analyticsPage({...ready,path:'/search?email=private@example.com'})).toBeUndefined()
  })
  it('does not load Google or initialise its queue without consent, including unavailable or expired storage', () => {
    for (const options of [{},{unavailable:true},{stored:{value:'rejected',at:Date.now()}},{stored:{value:'accepted',at:0}}]) {
      const b=browser(options);expect(b.scripts).toHaveLength(0);expect(b.commands()).toHaveLength(0)
    }
    const b=browser();expect(b.nodes.panel.hidden).toBe(false);b.nodes.reject.click();expect(b.scripts).toHaveLength(0);expect(b.writes[0][1].value).toBe('rejected')
  })
  it('loads the official tag once and sends exactly one sanitised page view after acceptance', () => {
    const b=browser({path:'/search'});b.nodes.accept.click();b.nodes.accept.click();runInNewContext(source,b.context)
    expect(b.scripts).toHaveLength(1)
    expect(b.scripts[0]).toMatchObject({src:'https://www.googletagmanager.com/gtag/js?id=G-J5JVRNNVKL',async:true,referrerPolicy:'no-referrer'})
    const commands=b.commands();const config=commands.filter((v:any[])=>v[0]==='config');expect(config).toHaveLength(1)
    expect(config[0][2]).toMatchObject({send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,page_referrer:'',page_location:'https://gosanchari.com/search'})
    const events=commands.filter((v:any[])=>v[0]==='event');expect(events).toHaveLength(1);expect(events[0][1]).toBe('page_view')
    expect(JSON.stringify(commands)).not.toMatch(/private@example|email=|phone|customer|enquiry/)
    expect(commands[0][2]).toMatchObject({analytics_storage:'granted',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'})
  })
  it('restores consent, permits withdrawal, disables further collection and leaves unrelated cookies alone', () => {
    const b=browser({stored:{value:'accepted',at:Date.now()}});expect(b.scripts).toHaveLength(1)
    b.nodes.settings.click();expect(b.nodes.panel.hidden).toBe(false);b.nodes.reject.click()
    expect(b.window['ga-disable-G-J5JVRNNVKL']).toBe(true);expect(b.reloads()).toBe(0);expect(JSON.parse(b.state.raw).value).toBe('rejected')
    expect(b.state.cookies.has('_ga')).toBe(false);expect(b.state.cookies.get('unrelated')).toBe('keep');expect(b.scripts[0].removed).toBe(true);expect(b.commands()).toHaveLength(0)
  })
  it('stops immediately when withdrawal cannot overwrite old acceptance, never reloads, and remains off on a subsequent visit', () => {
    const accepted={value:'accepted',at:Date.now()};const b=browser({stored:accepted})
    expect(b.scripts).toHaveLength(1)
    b.state.failWrite=true
    b.nodes.reject.click()
    expect(b.window['ga-disable-G-J5JVRNNVKL']).toBe(true)
    expect(b.reloads()).toBe(0);expect(b.commands()).toHaveLength(0);expect(b.scripts[0].removed).toBe(true)
    expect(JSON.parse(b.state.raw)).toMatchObject(accepted)
    expect(b.nodes.panel.children[0].textContent).toContain('Analytics is off')
    expect(browser({state:b.state}).scripts).toHaveLength(0)
    // Even after localStorage recovers, the independent withdrawal marker blocks the stale acceptance.
    b.state.failWrite=false
    expect(browser({state:b.state}).scripts).toHaveLength(0)
  })
  it('fails closed with read-only acceptance when all consent writes fail, including on manual reload', () => {
    const b=browser({stored:{value:'accepted',at:Date.now()}})
    b.state.failWrite=true;b.state.failCookie=true;b.nodes.reject.click()
    expect(b.window['ga-disable-G-J5JVRNNVKL']).toBe(true);expect(b.reloads()).toBe(0)
    expect(browser({state:b.state}).scripts).toHaveLength(0)
  })
  it('persists withdrawal in localStorage if consent-cookie writes fail and does not reactivate after reload', () => {
    const b=browser({stored:{value:'accepted',at:Date.now()}})
    b.state.failCookie=true;b.nodes.reject.click()
    expect(JSON.parse(b.state.raw).value).toBe('rejected');expect(b.reloads()).toBe(0)
    expect(browser({state:b.state}).scripts).toHaveLength(0)
  })
  it('does not restore old acceptance when writes silently fail or preference-cookie writes are blocked', () => {
    for(const mode of ['silentWrite','failCookie']) {
      const b=browser({stored:{value:'accepted',at:Date.now()}})
      b.state[mode]=true
      expect(browser({state:b.state}).scripts).toHaveLength(0)
    }
  })
  it('does not start tracking after acceptance if storage throws, silently fails, or cookies are blocked', () => {
    for(const mode of ['failWrite','silentWrite','failCookie','failRead']) {
      const b=browser();b.state[mode]=true;b.nodes.accept.click()
      expect(b.scripts).toHaveLength(0);expect(b.window['ga-disable-G-J5JVRNNVKL']).toBe(true)
      expect(b.nodes.panel.hidden).toBe(false);expect(browser({state:b.state}).scripts).toHaveLength(0)
    }
  })
  it('restores a successfully persisted acceptance and keeps a successfully persisted withdrawal off after reload', () => {
    const b=browser();b.nodes.accept.click()
    expect(browser({state:b.state}).scripts).toHaveLength(1)
    b.nodes.reject.click();expect(browser({state:b.state}).scripts).toHaveLength(0)
    b.nodes.accept.click();expect(b.scripts).toHaveLength(1)
    expect(b.nodes.panel.children[0].textContent).toContain('remains off on this page')
  })
  it('does not trust legacy, mismatched, malformed or future-dated acceptance records', () => {
    const accepted={value:'accepted',at:Date.now()}
    expect(browser({stored:accepted,legacy:true}).scripts).toHaveLength(0)
    expect(browser({stored:{value:'accepted',at:Date.now()+86400000}}).scripts).toHaveLength(0)
    expect(browser({stored:{value:'accepted',at:'invalid'}}).scripts).toHaveLength(0)
    const b=browser({stored:accepted});b.state.cookies.set('gs_analytics_consent','rejected.1')
    expect(browser({state:b.state}).scripts).toHaveLength(0)
  })
  it('never initialises on excluded pages or another origin even with saved consent', () => {
    for (const options of [{eligible:false},{path:'/q/private'},{origin:'http://localhost'}]) expect(browser({...options,stored:{value:'accepted',at:Date.now()}}).scripts).toHaveLength(0)
  })
  it('applies the gate through actual page rendering without sending query strings or reading customer records', async () => {
    const app=new Hono<any>()
    app.use('*', async (c,next)=>{c.set('user',c.req.header('x-test-user') ? {id:1,role:'guest',language:'en'} : null);await next()})
    app.get('*', c=>page(c,{title:'Never use this title private@example.com',noindex:c.req.path.startsWith('/q/'),area:c.req.path.startsWith('/staff')?'staff':'public'},'public content'))
    const env:any={SITE_URL:'https://gosanchari.com',GA4_READINESS:GA4_READINESS,TURNSTILE_SITE_KEY:'',KV:{async get(key:string){return key.includes('content')?{policies:{privacy:ready.policy}}:DEFAULT_SETTINGS}},DB:{prepare(){throw Error('Must not query customer data')}}}
    const html=await(await app.request('https://gosanchari.com/search?email=private@example.com',{},env)).text()
    expect(html).toContain('id="public-analytics" data-page="/search"')
    const controller=html.slice(html.indexOf('<aside id="public-analytics"'),html.indexOf('</aside>',html.indexOf('<aside id="public-analytics"')))
    expect(controller).not.toContain('private@example.com')
    for(const path of ['/q/private','/staff','/stay/public-property?preview=1','/enquiry']) expect(await(await app.request('https://gosanchari.com'+path,{},env)).text()).not.toContain('id="public-analytics"')
    expect(await(await app.request('https://gosanchari.com/',{headers:{'x-test-user':'1'}},env)).text()).not.toContain('id="public-analytics"')
    expect(await(await app.request('https://gosanchari.com/',{},{...env,GA4_READINESS:undefined})).text()).not.toContain('id="public-analytics"')
  })
  it('renders one shared consent controller only for eligible pages, with safe referrer handling and accessible controls', async () => {
    const props:any={title:'Public',settings:DEFAULT_SETTINGS,user:null,perms:null,flash:{},turnstileSiteKey:'',siteUrl:'https://gosanchari.com'}
    const off=await Layout(props)!.toString();expect(off).not.toContain('id="public-analytics"')
    const on=await Layout({...props,analyticsPath:'/'})!.toString()
    expect(on.match(/id="public-analytics"/g)).toHaveLength(1);expect(on.match(/src="\/analytics.js/g)).toHaveLength(1)
    expect(on).toContain('name="referrer" content="no-referrer"');expect(on).toContain('Reject analytics');expect(on).toContain('Accept analytics');expect(on).toContain('/policies/privacy')
    expect(on).not.toContain('googletagmanager.com')
  })
})
