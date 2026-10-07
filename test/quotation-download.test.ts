// @ts-expect-error Node-only script fixture.
import { readFileSync } from 'node:fs'
// @ts-expect-error Node-only isolated browser-handler fixture.
import { runInNewContext } from 'node:vm'
import { describe, it, expect } from 'vitest'

const script=readFileSync('public/quotation-download.js','utf8')
const settle=()=>new Promise(resolve=>setTimeout(resolve,0))
function fixture(fail=false,missing=false){
  let click:()=>void=()=>{},options:any,source:any,saves=0,resolve:()=>void=()=>{}
  const button={disabled:false,textContent:'⬇ Download PDF',getAttribute:()=> 'GS-QT-8GNW63',addEventListener:(_:string,fn:()=>void)=>{click=fn}}
  const clone={querySelectorAll:()=>[]};const content={scrollHeight:1000,cloneNode:()=>clone},status={textContent:''}
  const exporter={set(o:any){options=o;return this},from(el:any){source=el;return this},save(){saves++;return fail?Promise.reject(Error('failed')):new Promise<void>(r=>{resolve=r})}}
  runInNewContext(script,{document:{querySelector:(s:string)=>s==='[data-download-quote]'?button:s==='[data-quote-export]'?content:status},window:{html2pdf:missing?undefined:()=>exporter,print(){throw Error('Download must not print')}},Promise})
  return {button,content,clone,status,click,finish:()=>resolve(),options:()=>options,source:()=>source,saves:()=>saves}
}
describe('quotation HTML PDF download',()=>{
  it('exports only quotation content with dynamic filename, bounded scale and pagination; prevents repeated clicks',async()=>{
    const f=fixture();f.click();expect(f.button.disabled).toBe(true);expect(f.button.textContent).toBe('Preparing PDF…');f.click();await settle();expect(f.saves()).toBe(1);expect(f.source()).toBe(f.clone)
    expect(f.options().filename).toBe('Quotation-GS-QT-8GNW63.pdf');expect(f.options().html2canvas.scale).toBe(1);expect(f.options().pagebreak.avoid).toContain('tr')
    f.finish();await settle();expect(f.button.disabled).toBe(false);expect(f.status.textContent).toContain('browser downloads')
  })
  it.each([[true,false],[false,true]])('restores controls after generation/library failure',async(fail,missing)=>{const f=fixture(fail,missing);f.click();await settle();expect(f.button.disabled).toBe(false);expect(f.status.textContent).toContain('Could not prepare')})
  it('rejects oversized canvas instead of creating a blank PDF',async()=>{const f=fixture();f.content.scrollHeight=12001;f.click();await settle();expect(f.saves()).toBe(0);expect(f.button.disabled).toBe(false)})
  it('keeps the print action, viewport, export boundaries and local pinned library scoped to the print page',()=>{
    const route=readFileSync('src/routes/staff-ops.tsx','utf8').split("opsRoutes.get('/staff/quotes/:id/print'")[1].split('// ---------- 24.')[0]
    expect(route).toContain('width=device-width, initial-scale=1');expect(route).toContain('min-height:44px');expect(route).toContain('data-print>Print</button>');expect(route).toContain('html2pdf-0.14.0.bundle.min.js');expect(route).toContain('<main data-quote-export><h1>');expect(route).toContain('</main></body>')
    expect(readFileSync('public/app.js','utf8')).toContain("b.addEventListener('click', function () { window.print() })")
    expect(route).not.toContain('/pdf');expect(route).toContain("requirePerm('manage_quotes')");expect(route).toContain('loadQuoteFor(')
  })
})
