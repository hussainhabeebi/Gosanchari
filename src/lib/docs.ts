// Reading uploaded documents (rate sheets, property fact sheets) for AI.
//  - Word (.docx): text is pulled straight out of the file here (it is a zip of XML).
//  - PDF: Gemini reads PDFs directly when a key is set; otherwise Workers AI's document converter turns it into text.

import type { Env } from '../env'
import { aiJson, geminiActive, type TextOptions } from './ai'
import type { AiFeature } from './settings'

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const MAX_DOC_BYTES = 20 * 1024 * 1024

export type DocKind = 'pdf' | 'docx' | 'text' | 'image' | null

export function docKind(f: { name: string; type: string }): DocKind {
  const n = f.name.toLowerCase()
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) || /\.(jpe?g|png|webp|heic)$/.test(n)) return 'image'
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

/** PDF / image → text with Workers AI's converter (used when Gemini is not set up). */
async function toTextWorkers(env: Env, name: string, type: string, buf: ArrayBuffer): Promise<string | null> {
  const ai = env.AI as unknown as { toMarkdown?: (f: { name: string; blob: Blob }[]) => Promise<{ data?: string; format?: string }[]> }
  if (!ai?.toMarkdown) return null
  try {
    const out = await ai.toMarkdown([{ name, blob: new Blob([buf], { type }) }])
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

const mimeOf = (d: DocInput, kind: DocKind) => (kind === 'pdf' ? 'application/pdf' : d.type && d.type.startsWith('image/') ? d.type : d.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')

/**
 * Ask AI for JSON about one or more documents (PDF, Word, photos / screenshots of a sheet). `prompt(notes)` builds the
 * prompt from the documents' text — or a note that they are attached, when Gemini reads PDFs and images itself.
 */
export async function aiJsonFromDocuments<T>(
  env: Env,
  feature: AiFeature,
  docs: DocInput[],
  prompt: (notes: string) => string,
  opts: Omit<TextOptions, 'prompt' | 'files'> = {},
): Promise<{ data: T | null; error?: string }> {
  if (!docs.length) return { data: null, error: 'Please attach a file.' }
  const kinds = docs.map(docKind)
  if (kinds.some((k) => !k)) return { data: null, error: 'Please attach PDF, Word (.docx) or photo (JPG / PNG) files.' }
  if (docs.reduce((a, d) => a + d.data.byteLength, 0) > MAX_DOC_BYTES) return { data: null, error: 'The files are larger than 20 MB together.' }
  const gemini = await geminiActive(env)
  const texts: string[] = []
  const files: { mimeType: string; data: ArrayBuffer }[] = []
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i], k = kinds[i]
    if (k === 'docx') texts.push((await docxText(d.data)) ?? '')
    else if (k === 'text') texts.push(new TextDecoder().decode(d.data))
    else if (gemini) files.push({ mimeType: mimeOf(d, k), data: d.data })
    else {
      const t = await toTextWorkers(env, d.name, mimeOf(d, k), d.data)
      if (!t) return { data: null, error: k === 'image' ? 'Reading photos of rate sheets needs a Gemini API key (Admin → Settings → AI).' : 'Could not read text from this PDF. Add a Gemini API key in Admin → Settings → AI (it reads scanned PDFs and photos too), or upload a Word file.' }
      texts.push(t)
    }
  }
  const limit = gemini ? 60000 : 14000
  const attachedNote = files.length ? `(${files.length} page${files.length > 1 ? 's are' : ' is'} attached as PDF / images — read every page, including tables and small print.)` : ''
  const notes = [attachedNote, ...texts.filter(Boolean)].join('\n\n').slice(0, limit)
  if (!notes.trim()) return { data: null, error: 'Could not read anything from these files.' }
  const data = await aiJson<T>(env, feature, { ...opts, prompt: prompt(notes), ...(files.length ? { files } : {}) })
  return data ? { data } : { data: null, error: gemini ? 'AI could not read the documents. Please try again.' : 'AI could not read the documents. A Gemini API key (Admin → Settings → AI) gives much better results.' }
}

/** One document (kept for callers that upload a single file). */
export async function aiJsonFromDocument<T>(env: Env, feature: AiFeature, doc: DocInput, prompt: (notes: string) => string, opts: Omit<TextOptions, 'prompt' | 'files'> = {}) {
  return aiJsonFromDocuments<T>(env, feature, [doc], prompt, opts)
}
