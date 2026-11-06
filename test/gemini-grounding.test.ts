import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiPropertyWeb } from '../src/lib/ai'
import { geminiGenerate } from '../src/lib/gemini'
import { DEFAULT_SETTINGS, getSettings } from '../src/lib/settings'
vi.mock('../src/lib/settings', async original => ({ ...await original<typeof import('../src/lib/settings')>(), getSettings: vi.fn() }))
const identity = { name: 'Tree Blanche', destination: 'Munnar', address: 'Munnar' }
function env(key = 'test-key') {
  const run = vi.fn(async () => ({}))
  const db = { bind: () => db, run }
  return { KV: { get: vi.fn(async (k: string) => k === 'secret:gemini_api_key' ? key : '0'), put: vi.fn(async () => {}) }, DB: { prepare: () => db } } as any
}
function response(text = 'Nearby lake', metadata: any = { groundingChunks: [{ web: { uri: 'https://example.org/hotel' } }], searchEntryPoint: { renderedContent: '<div>Search</div>' } }) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: metadata }] }))
}
beforeEach(() => { vi.mocked(getSettings).mockResolvedValue(structuredClone(DEFAULT_SETTINGS)); vi.stubGlobal('fetch', vi.fn(async () => response())) })
afterEach(() => vi.unstubAllGlobals())
describe('Gemini Google Search opt-in', () => {
  it('sends Google tool only for public lookup and captures grounded citations', async () => {
    const result = await aiPropertyWeb(env(), identity)
    const request = vi.mocked(fetch).mock.calls[0][1]!
    const body = JSON.parse(request.body as string)
    expect(body.tools).toEqual([{ google_search: {} }]); expect(body.contents[0].parts[0].text).toBe(JSON.stringify(identity))
    expect(result?.sources).toEqual(['https://example.org/hotel']); expect(result?.searchSuggestions).toBe('<div>Search</div>')
    expect(request.signal).toBeDefined()
  })
  it('leaves existing ungrounded Gemini calls unchanged', async () => {
    await geminiGenerate('test', 'gemini-2.5-flash', { messages: [{ role: 'user', content: 'Hello' }] })
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).tools).toBeUndefined()
  })
  it.each([{}, { groundingChunks: [{ web: { uri: 'javascript:alert(1)' } }, { web: { uri: 'http://insecure.test' } }, { web: { uri: 'https://user:password@example.org' } }] }])('rejects ungrounded/unsafe sources', async metadata => {
    vi.mocked(fetch).mockResolvedValue(response('Nearby lake', metadata))
    expect(await aiPropertyWeb(env(), identity)).toBeNull()
  })
  it('rejects ambiguous property identity', async () => {
    vi.mocked(fetch).mockResolvedValue(response('NOT_FOUND'))
    expect(await aiPropertyWeb(env(), identity)).toBeNull()
  })
  it('respects missing credentials, provider selection, feature switch and daily limit', async () => {
    expect(await aiPropertyWeb(env(''), identity)).toBeNull()
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'workers' } })
    expect(await aiPropertyWeb(env(), identity)).toBeNull()
    vi.mocked(getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, features: { ...DEFAULT_SETTINGS.ai.features, property_qa: false } } })
    expect(await aiPropertyWeb(env(), identity)).toBeNull()
    vi.mocked(getSettings).mockResolvedValue(DEFAULT_SETTINGS)
    const limited = env(); limited.KV.get.mockImplementation(async (key: string) => key === 'secret:gemini_api_key' ? 'key' : String(DEFAULT_SETTINGS.ai.daily_limit))
    expect(await aiPropertyWeb(limited, identity)).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  })
  it('provider failure returns null for website fallback without leaking API errors', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('provider failure', { status: 503 }))
    expect(await aiPropertyWeb(env(), identity)).toBeNull()
  })
})
