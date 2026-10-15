import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendWhatsApp } from '../src/lib/integrations'

const env: any = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', ENVIRONMENT: 'production' }

describe('sendWhatsApp', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('gives up with an error instead of hanging when WhatsApp does not answer', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => { expect(init.signal).toBeInstanceOf(AbortSignal); throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) })
    vi.stubGlobal('fetch', fetch)
    const r = await sendWhatsApp(env, '919876543210', 'Your code is 123456', { name: 'otp', params: ['123456'] })
    expect(fetch).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: false, error: 'WhatsApp did not respond in time' })
  })
})
