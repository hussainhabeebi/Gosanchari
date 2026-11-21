// Google Gemini (optional). Admins paste an API key in Admin → Settings → AI; when it is set, text AI calls
// (staff assistant, quick fill, rate-sheet reading, etc.) use Gemini and fall back to Workers AI on errors.
// The key is stored on its own in KV (never inside the settings object that pages read).

import type { Env } from '../env'

const KEY_KV = 'secret:gemini_api_key'
const API = 'https://generativelanguage.googleapis.com/v1beta'

export interface GeminiFile {
  mimeType: string
  data: ArrayBuffer
}

export interface GeminiRequest {
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Attach files (PDF, images) to the last user message. */
  files?: GeminiFile[]
  json?: boolean
  /** Gemini structured output (OpenAPI subset). Dropped and retried once if Gemini rejects it (e.g. too large). */
  schema?: Record<string, unknown>
  /** Let Gemini open the http(s) links in the prompt itself (URL context tool). Not combined with JSON mode. */
  urlContext?: boolean
  maxTokens?: number
  temperature?: number
  /** Opt-in Google Search grounding; unused by ordinary Gemini calls. */
  grounding?: (metadata: GroundingMetadata) => void
}

export interface GroundingMetadata {
  groundingChunks?: { web?: { uri?: string; title?: string } }[]
  searchEntryPoint?: { renderedContent?: string }
}

/** Key from Admin settings, else the GEMINI_API_KEY Worker secret. */
export async function geminiKey(env: Env): Promise<string | null> {
  const k = (await env.KV.get(KEY_KV).catch(() => null)) || (env as unknown as { GEMINI_API_KEY?: string }).GEMINI_API_KEY || ''
  return k.trim() || null
}

export async function setGeminiKey(env: Env, key: string | null) {
  if (key) await env.KV.put(KEY_KV, key.trim())
  else await env.KV.delete(KEY_KV)
}

export function maskKey(key: string | null) {
  return key ? `…${key.slice(-4)}` : ''
}

function base64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Pro models always think (no zero budget), so they get a fixed thinking budget on top of the answer budget. */
export const PRO_THINKING = 2048

export async function geminiGenerate(key: string, model: string, r: GeminiRequest): Promise<string> {
  const contents = r.messages.map((m, i) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(i === r.messages.length - 1 ? (r.files ?? []).map((f) => ({ inline_data: { mime_type: f.mimeType, data: base64(f.data) } })) : []),
      { text: m.content },
    ],
  }))
  const json = r.json && !r.urlContext
  const pro = /pro/.test(model)
  const tools = [...(r.grounding ? [{ google_search: {} }] : []), ...(r.urlContext ? [{ url_context: {} }] : [])]
  const body = (schema?: Record<string, unknown>) => ({
    contents,
    ...(r.system ? { systemInstruction: { parts: [{ text: r.system }] } } : {}),
    ...(tools.length ? { tools } : {}),
    generationConfig: {
      temperature: r.temperature ?? 0.3,
      maxOutputTokens: (r.maxTokens ?? 2048) + (pro ? PRO_THINKING : 0),
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(json && schema ? { responseSchema: schema } : {}),
      // Flash models "think" by default, which eats the output budget; these tasks don't need it.
      ...(/flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : pro ? { thinkingConfig: { thinkingBudget: PRO_THINKING } } : {}),
    },
  })
  const call = (schema?: Record<string, unknown>) => fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body(schema)),
    ...(r.grounding ? { signal: AbortSignal.timeout(15000) } : {}),
  })
  let res = await call(r.schema)
  // A schema Gemini cannot handle (too many enum values / states) comes back as 400: plain JSON mode still works.
  if (res.status === 400 && r.schema && json) {
    console.error(`Gemini rejected the response schema, retrying without it: ${(await res.text()).slice(0, 200)}`)
    res = await call()
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; groundingMetadata?: GroundingMetadata }[] }
  const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim()
  if (r.grounding) r.grounding(j.candidates?.[0]?.groundingMetadata ?? {})
  if (!text) throw new Error('Gemini returned an empty answer')
  return text
}

/** Quick check that a key works (used when an admin saves it). */
export async function testGeminiKey(key: string, model: string): Promise<string | null> {
  try {
    await geminiGenerate(key, model, { messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 5 })
    return null
  } catch (e) {
    return (e as Error).message
  }
}
