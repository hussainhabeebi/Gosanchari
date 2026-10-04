// Reading uploaded documents (rate sheets, property fact sheets) for AI.
//  - Word (.docx): text is pulled straight out of the file here (it is a zip of XML).
//  - PDF: Gemini reads PDFs directly when a key is set; otherwise Workers AI's document converter turns it into text.

import type { Env } from '../env'
import { aiJson, geminiActive, type TextOptions } from './ai'
import type { AiFeature } from './settings'

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const MAX_DOC_BYTES = 20 * 1024 * 1024

export type DocKind = 'pdf' | 'docx' | 'text' | null

export function docKind(f: { name: string; type: string }): DocKind {
  const n = f.name.toLowerCase()
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (f.type === DOCX_TYPE || n.endsWith('.docx')) return 'docx'
  if (f.type.startsWith('text/') || n.endsWith('.txt') || n.endsWith('.csv')) return 'text'
  return null
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Read one file out of a zip archive (stored or deflated). */
export async function unzipEntry(buf: ArrayBuffer, wanted: string): Promise<Uint8Array | null> {
  const b = new Uint8Array(buf)
  const v = new DataView(buf)
  // End of central directory: last 0x06054b50 signature.
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) return null
    const method = v.getUint16(p + 10, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen))
    if (name === wanted) {
      const lNameLen = v.getUint16(local + 26, true)
      const lExtraLen = v.getUint16(local + 28, true)
      const start = local + 30 + lNameLen + lExtraLen
      const raw = b.subarray(start, start + size)
      if (method === 0) return raw
      if (method === 8) return inflateRaw(raw)
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Word XML → plain text, keeping tables readable as "cell | cell" rows. */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)))
    .replace(/ \| \n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function docxText(buf: ArrayBuffer): Promise<string | null> {
  const xml = await unzipEntry(buf, 'word/document.xml')
  return xml ? docxXmlToText(new TextDecoder().decode(xml)) : null
}

/** PDF → text with Workers AI's converter (used when Gemini is not set up). */
async function pdfTextWorkers(env: Env, name: string, buf: ArrayBuffer): Promise<string | null> {
  const ai = env.AI as unknown as { toMarkdown?: (f: { name: string; blob: Blob }[]) => Promise<{ data?: string; format?: string }[]> }
  if (!ai?.toMarkdown) return null
  try {
    const out = await ai.toMarkdown([{ name, blob: new Blob([buf], { type: 'application/pdf' }) }])
    const t = out?.[0]?.format === 'markdown' ? out[0].data ?? '' : ''
    return t.trim() || null
  } catch (e) {
    console.error('toMarkdown failed', e)
    return null
  }
}

export interface DocInput {
  name: string
  type: string
  data: ArrayBuffer
}

/**
 * Ask AI for JSON about a document. `prompt(notes)` builds the prompt from the document text (or a note that the
 * document is attached, when Gemini reads the PDF itself).
 */
export async function aiJsonFromDocument<T>(
  env: Env,
  feature: AiFeature,
  doc: DocInput,
  prompt: (notes: string) => string,
  opts: Omit<TextOptions, 'prompt' | 'files'> = {},
): Promise<{ data: T | null; error?: string }> {
  const kind = docKind(doc)
  if (!kind) return { data: null, error: 'Please attach a PDF or Word (.docx) file.' }
  if (doc.data.byteLength > MAX_DOC_BYTES) return { data: null, error: 'The file is larger than 20 MB.' }
  const gemini = await geminiActive(env)
  if (kind === 'pdf' && gemini) {
    const data = await aiJson<T>(env, feature, { ...opts, prompt: prompt('(The document is attached as a PDF — read every page, including tables.)'), files: [{ mimeType: 'application/pdf', data: doc.data }] })
    return data ? { data } : { data: null, error: 'Gemini could not read this PDF. Please try again or check the Gemini key in Settings.' }
  }
  let text: string | null = null
  if (kind === 'docx') text = await docxText(doc.data)
  else if (kind === 'text') text = new TextDecoder().decode(doc.data)
  else text = await pdfTextWorkers(env, doc.name, doc.data)
  if (!text) {
    return { data: null, error: kind === 'pdf' ? 'Could not read text from this PDF. Add a Gemini API key in Admin → Settings → AI (it reads scanned PDFs too), or upload a Word file.' : 'Could not read this file.' }
  }
  const limit = gemini ? 60000 : 14000
  const data = await aiJson<T>(env, feature, { ...opts, prompt: prompt(text.slice(0, limit)) })
  return data ? { data } : { data: null, error: 'AI could not read the document. Please try again.' }
}
