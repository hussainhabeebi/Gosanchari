import { PDFDocument, rgb, type PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import regularBytes from '../assets/quotation-sans.ttf'
import boldBytes from '../assets/quotation-sans-bold.ttf'
import { extrasLabel } from './catalog'
import { MEAL_PLANS } from './search'
import { fmtDate, money } from './util'
import { gstLabel, quotationInclusions } from './quotation-pricing'
import type { QuotationRow, QuoteOptionRow } from './types'
import type { Settings } from './settings'

export type PdfQuoteOption = QuoteOptionRow & { property_name: string; room_name: string; destination: string }

/** Render saved quotation figures only. No rate lookup or independent calculation. */
export async function quotationPdf(q: QuotationRow, options: PdfQuoteOption[], business: Settings['business'], siteUrl: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const regular = await doc.embedFont(new Uint8Array(regularBytes), { subset: false, features: { liga: false } })
  const bold = await doc.embedFont(new Uint8Array(boldBytes), { subset: false, features: { liga: false } })
  doc.setTitle(`Quotation ${q.code}`)
  doc.setAuthor(business.name)
  const width = 595.28, height = 841.89, margin = 36, contentWidth = width - 2 * margin
  let page = doc.addPage([width, height]), y = height - margin
  const ink = rgb(29/255,43/255,42/255)
  function reserve(amount: number) {
    if (y - amount < margin) { page = doc.addPage([width,height]); y = height-margin }
  }
  function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = []
    for (const paragraph of text.replace(/\r\n?/g,'\n').split('\n')) {
      let line = ''
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? line+' '+word : word
        if (font.widthOfTextAtSize(candidate,size) <= maxWidth) { line = candidate; continue }
        if (line) { lines.push(line); line = '' }
        // Long URLs/words must wrap rather than overflow the page.
        for (const char of Array.from(word)) {
          if (line && font.widthOfTextAtSize(line+char,size)>maxWidth) { lines.push(line); line='' }
          line += char
        }
      }
      lines.push(line)
    }
    return lines
  }
  function paragraph(text: string, size=10.5, font=regular, gap=10) {
    const lines = wrap(text,font,size,contentWidth)
    for (const line of lines) { reserve(size*1.5); y-=size*1.5; page.drawText(line,{x:margin,y,size,font,color:ink}) }
    y-=gap
  }
  function row(label: string, amount: string, total=false) {
    const font=total?bold:regular, size=10.5
    const lines=wrap(label,font,size,contentWidth-140), valueLines=wrap(amount,font,size,130)
    const count=Math.max(lines.length,valueLines.length), h=count*16+8
    reserve(h)
    lines.forEach((line,i)=>page.drawText(line,{x:margin+4,y:y-14-i*16,font,size,color:ink}))
    valueLines.forEach((line,i)=>page.drawText(line,{x:width-margin-4-font.widthOfTextAtSize(line,size),y:y-14-i*16,font,size,color:ink}))
    y-=h
    page.drawLine({start:{x:margin,y},end:{x:width-margin,y},thickness:0.5,color:rgb(.86,.86,.86)})
  }
  paragraph(`${business.name} — Quotation ${q.code}`,20,bold)
  paragraph(`For ${q.guest_name} · valid till ${fmtDate(q.valid_till)}`)
  if(q.explainer) paragraph(q.explainer)
  options.forEach((o,i)=>{
    reserve(80)
    paragraph(`${options.length>1?`Option ${i+1}: `:''}${o.property_name}`,15,bold,6)
    paragraph(`${o.destination} · ${o.room_name} × ${o.rooms_count} · ${fmtDate(o.check_in)} → ${fmtDate(o.check_out)} · ${o.adults+o.children} guests · ${o.meal_plan ? MEAL_PLANS[o.meal_plan] ?? o.meal_plan : 'Room only'}`)
    row('Room charges',money(o.subtotal))
    if(o.discount) row('Discount','− '+money(o.discount))
    if(o.extra_charges) row(extrasLabel(o),money(o.extra_charges))
    row(gstLabel(q.apply_gst),money(o.taxes))
    row('Total',money(o.total),true)
    y-=12
  })
  for(const [heading,text] of [['Included',q.inclusions?quotationInclusions(q.inclusions,q.apply_gst):''],['Not included',q.exclusions],['Payment terms',q.payment_terms]]) {
    if(text) { reserve(50); paragraph(heading,13,bold,4); paragraph(text) }
  }
  paragraph(`Accept online: ${siteUrl}/q/${q.token}`)
  paragraph(`${business.phone} · ${business.email}`)
  return doc.save()
}

export function quotationPdfFilename(code: string): string {
  return `Quotation-${code.replace(/[^A-Za-z0-9_-]/g,'_')}.pdf`
}
