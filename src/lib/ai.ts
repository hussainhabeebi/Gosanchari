// One place for every AI call. Every call:
//  - checks the feature switch in Settings (AI is always optional; callers must handle null),
//  - checks the daily limit,
//  - goes through AI Gateway (cache, rate limits, logs, cost),
//  - falls back to a second model on error,
//  - is logged in ai_usage.

import type { Env } from '../env'
import { getSettings, type AiFeature, type Settings } from './settings'
import { parseJson, todayIST } from './util'

type ModelSize = 'small' | 'large'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function aiEnabled(env: Env, feature: AiFeature, settings?: Settings): Promise<boolean> {
  const s = settings ?? (await getSettings(env))
  return !!env.AI && s.ai.features[feature] !== false
}

async function underDailyLimit(env: Env, s: Settings): Promise<boolean> {
  const key = `ai:count:${todayIST()}`
  const n = parseInt((await env.KV.get(key)) ?? '0', 10)
  if (n >= s.ai.daily_limit) return false
  // Approximate counter (KV is eventually consistent); AI Gateway rate limiting is the hard stop.
  await env.KV.put(key, String(n + 1), { expirationTtl: 2 * 86400 })
  return true
}

async function logUsage(env: Env, feature: string, model: string, ok: boolean, ms: number) {
  await env.DB.prepare('INSERT INTO ai_usage (feature, model, ok, ms) VALUES (?, ?, ?, ?)')
    .bind(feature, model, ok ? 1 : 0, ms)
    .run()
    .catch(() => {})
}

function gatewayOpts(env: Env, cacheTtl?: number) {
  if (!env.AI_GATEWAY_ID) return undefined
  return {
    gateway: {
      id: env.AI_GATEWAY_ID,
      skipCache: !cacheTtl,
      ...(cacheTtl ? { cacheTtl } : {}),
    },
  }
}

async function callModel(env: Env, model: string, input: Record<string, unknown>, cacheTtl?: number): Promise<unknown> {
  // Model names come from Settings, so the binding's literal model union cannot be used here.
  const run = env.AI.run as unknown as (m: string, i: unknown, o?: unknown) => Promise<unknown>
  return run.call(env.AI, model, input, gatewayOpts(env, cacheTtl))
}

/** Guard + limit + log + fallback wrapper. */
async function guarded<T>(
  env: Env,
  feature: AiFeature,
  models: string[],
  fn: (model: string) => Promise<T>,
): Promise<T | null> {
  const s = await getSettings(env)
  if (!(await aiEnabled(env, feature, s))) return null
  if (!(await underDailyLimit(env, s))) return null
  for (const model of models) {
    const t0 = Date.now()
    try {
      const out = await fn(model)
      await logUsage(env, feature, model, true, Date.now() - t0)
      return out
    } catch (e) {
      console.error(`AI ${feature} via ${model} failed`, e)
      await logUsage(env, feature, model, false, Date.now() - t0)
    }
  }
  return null
}

function textOf(out: unknown): string {
  if (!out) return ''
  if (typeof out === 'string') return out
  const o = out as Record<string, unknown>
  if (typeof o.response === 'string') return o.response
  if (o.response && typeof o.response === 'object') return JSON.stringify(o.response)
  const choices = o.choices as { message?: { content?: string } }[] | undefined
  if (choices?.[0]?.message?.content) return choices[0].message.content
  if (typeof o.translated_text === 'string') return o.translated_text
  if (typeof o.description === 'string') return o.description
  if (typeof o.text === 'string') return o.text
  return ''
}

export interface TextOptions {
  size?: ModelSize
  system?: string
  messages?: ChatMessage[]
  prompt?: string
  maxTokens?: number
  temperature?: number
  /** Seconds to cache identical requests in AI Gateway (repeat questions hit AI once). */
  cacheTtl?: number
}

export async function aiText(env: Env, feature: AiFeature, o: TextOptions): Promise<string | null> {
  const s = await getSettings(env)
  const primary = o.size === 'large' ? s.ai.models.large : s.ai.models.small
  const messages: ChatMessage[] = [
    ...(o.system ? [{ role: 'system' as const, content: o.system }] : []),
    ...(o.messages ?? []),
    ...(o.prompt ? [{ role: 'user' as const, content: o.prompt }] : []),
  ]
  const out = await guarded(env, feature, [primary, s.ai.models.fallback], async (model) => {
    const r = await callModel(env, model, { messages, max_tokens: o.maxTokens ?? 512, temperature: o.temperature ?? 0.3 }, o.cacheTtl)
    const t = textOf(r).trim()
    if (!t) throw new Error('empty AI response')
    return t
  })
  return out
}

/** Pull the first JSON object/array out of a model reply. */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return null
  const open = body[start]
  const close = open === '{' ? '}' : ']'
  const end = body.lastIndexOf(close)
  if (end <= start) return null
  return parseJson<T | null>(body.slice(start, end + 1), null)
}

export async function aiJson<T>(env: Env, feature: AiFeature, o: TextOptions): Promise<T | null> {
  const t = await aiText(env, feature, { ...o, temperature: o.temperature ?? 0 })
  return extractJson<T>(t)
}

/** Embeddings (bge-m3: multilingual, so Malayalam and English land in the same space). */
export async function aiEmbed(env: Env, feature: AiFeature, texts: string[]): Promise<number[][] | null> {
  const s = await getSettings(env)
  return guarded(env, feature, [s.ai.models.embed], async (model) => {
    const r = (await callModel(env, model, { text: texts })) as { data?: number[][] }
    if (!r?.data?.length) throw new Error('no embedding')
    return r.data
  })
}

export async function aiTranscribe(env: Env, audio: ArrayBuffer): Promise<string | null> {
  const s = await getSettings(env)
  return guarded(env, 'voice_notes', [s.ai.models.whisper], async (model) => {
    const bytes = new Uint8Array(audio)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const r = (await callModel(env, model, { audio: btoa(bin) })) as { text?: string }
    return (r?.text ?? '').trim()
  })
}

export async function aiTranslate(env: Env, text: string, source: 'en' | 'ml', target: 'en' | 'ml'): Promise<string | null> {
  const s = await getSettings(env)
  return guarded(env, 'translate', [s.ai.models.translate], async (model) => {
    const r = await callModel(env, model, { text, source_lang: source, target_lang: target }, 86400)
    const t = textOf(r).trim()
    if (!t) throw new Error('empty translation')
    return t
  })
}

export async function aiImageTags(env: Env, image: ArrayBuffer, allowed: string[]): Promise<string[] | null> {
  const s = await getSettings(env)
  return guarded(env, 'photo_tags', [s.ai.models.vision], async (model) => {
    const r = await callModel(env, model, {
      image: [...new Uint8Array(image)],
      prompt: `This is a photo of a holiday property. Which of these apply? ${allowed.join(', ')}. Answer with a comma-separated list of the matching words only.`,
      max_tokens: 60,
    })
    const t = textOf(r).toLowerCase()
    return allowed.filter((a) => t.includes(a.toLowerCase().replace(/_/g, ' ')) || t.includes(a.toLowerCase()))
  })
}

export interface KbChunk {
  text: string
  key: string
  score: number
}

/** Retrieval from AI Search over the R2 knowledge base. Optional folder narrows to e.g. one property. */
export async function kbSearch(env: Env, feature: AiFeature, query: string, folder?: string): Promise<KbChunk[] | null> {
  if (!env.AI_SEARCH) return null
  if (!(await aiEnabled(env, feature))) return null
  try {
    const r = await env.AI_SEARCH.search({
      query,
      ai_search_options: {
        retrieval: {
          max_num_results: 6,
          match_threshold: 0.35,
          ...(folder ? { filters: { folder: { $eq: folder } } as VectorizeVectorMetadataFilter } : {}),
        },
      },
    })
    return r.chunks
      .filter((c) => !folder || c.item.key.startsWith(folder))
      .map((c) => ({ text: c.text, key: c.item.key, score: c.score }))
  } catch (e) {
    console.error('AI Search failed', e)
    return null
  }
}

/** Malayalam script detection — no AI needed. */
export function detectLanguage(text: string): 'en' | 'ml' {
  const ml = (text.match(/[ഀ-ൿ]/g) ?? []).length
  return ml > 3 && ml / Math.max(1, text.replace(/\s/g, '').length) > 0.2 ? 'ml' : 'en'
}

export const LANGUAGE_NAME = { en: 'English', ml: 'Malayalam' } as const
