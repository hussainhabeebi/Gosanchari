// Staff → AI assistant: chat with our own property database. Prices in answers are calculated exactly for the dates.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { permissionsFor, rateLimit, requirePerm, requireStaff } from '../lib/auth'
import { aiEnabled } from '../lib/ai'
import { findOptions, needFromForm, propertyInfo, readNeed, writeAnswer, fallbackAnswer, type AssistantResult, type Need } from '../lib/assistant'
import { destinations } from '../lib/properties'
import { logActivity } from '../lib/db'
import { geminiKey } from '../lib/gemini'
import { str } from '../lib/util'

export const assistantRoutes = new Hono<AppEnv>()
assistantRoutes.use('/staff/assistant', requireStaff)
assistantRoutes.use('/staff/assistant/*', requireStaff)

const EXAMPLES = [
  'Group of 15 people in Munnar, 20–22 Dec, budget around ₹4,000 per room',
  'Family of 4 with 2 kids, Wayanad, this weekend, need a pool',
  'Honeymoon couple, Alleppey houseboat, 3 nights from 14 Feb',
  'What is the cancellation policy at Misty Tea Bungalow?',
]

assistantRoutes.get('/staff/assistant', requirePerm('manage_quotes'), async (c) => {
  const [on, gemini, dests] = await Promise.all([aiEnabled(c.env, 'staff_assistant'), geminiKey(c.env), destinations(c.env)])
  return page(c, { title: 'AI assistant', area: 'staff', active: 'assistant' }, (
    <div class="stack-lg assistant" data-assistant="/staff/assistant/ask">
      <div class="row-between">
        <h1><span class="ai-badge">AI</span> Assistant</h1>
        <button type="button" class="btn btn-sm btn-outline" data-assistant-reset>New chat</button>
      </div>
      <p class="muted">Describe what your client needs. I search our properties, check free rooms and calculate the exact price for the dates (seasons, special dates, weekends, GST) — then suggest the best options.{!gemini && ' Tip: add a Gemini API key in Admin → Settings for better answers.'}</p>
      {!on && <div class="flash flash-err">The AI assistant is switched off in Admin → Settings → AI. You will still get the calculated options without the written summary.</div>}
      <div class="chat-log" id="as-log" aria-live="polite">
        <div class="as-hint">
          <strong>Try:</strong>
          <div class="chips">{EXAMPLES.map((e) => <button type="button" class="chip" data-example={e}>{e}</button>)}</div>
        </div>
      </div>
      <form class="need-bar" id="as-need" hidden>
        <strong class="small">Search details</strong>
        <select name="destination" aria-label="Destination"><option value="">Any destination</option>{dests.map((d) => <option value={d}>{d}</option>)}</select>
        <input type="date" name="checkIn" aria-label="Check-in" />
        <input type="date" name="checkOut" aria-label="Check-out" />
        <label class="small">Adults <input type="number" name="adults" min="1" max="300" class="w-sm" /></label>
        <label class="small">Kids <input type="number" name="children" min="0" max="100" class="w-sm" /></label>
        <label class="small">Max ₹/room <input type="number" name="priceMax" min="0" step="500" class="w-md" /></label>
        <button class="btn btn-sm btn-outline">Update results</button>
      </form>
      <form class="chat-form" id="as-form">
        <textarea id="as-q" rows={2} maxlength={1500} placeholder="e.g. 15 people, Munnar, 20 to 22 Dec, pool, budget ₹4,000 per room" required></textarea>
        <button class="btn">Ask</button>
      </form>
    </div>
  ))
})

assistantRoutes.post('/staff/assistant/ask', requirePerm('manage_quotes'), async (c) => {
  const u = c.get('user')!
  if (!(await rateLimit(c.env, `assistant:${u.id}`, 60, 3600))) return c.json({ error: 'Too many questions in the last hour. Please wait a little.' }, 429)
  const body = (await c.req.json().catch(() => ({}))) as { q?: string; history?: unknown; need?: unknown; edited?: boolean }
  const q = str(body.q, 1500)
  if (!q) return c.json({ error: 'Type a question.' }, 400)
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && typeof m === 'object' && ((m as { role?: string }).role === 'user' || (m as { role?: string }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
  const prev = body.need && typeof body.need === 'object' ? (body.need as Need) : null
  const perms = await permissionsFor(c.env, u.role)

  // Staff edited the need bar: use those values as they are (no AI reading needed).
  const need = body.edited ? needFromForm(body.need, await destinations(c.env)) : await readNeed(c.env, q, prev)
  let result: AssistantResult
  if (need.intent === 'property_info' && need.propertyName) {
    const info = await propertyInfo(c.env, need.propertyName, perms.view_property_contacts, perms.view_net_rates)
    result = { need, checkIn: '', checkOut: '', nights: 0, guests: 0, assumedDates: false, options: [], ...(info ? { info } : {}) }
    if (!info) result = await findOptions(c.env, { ...need, intent: 'find' }, perms.view_net_rates)
  } else {
    result = await findOptions(c.env, need, perms.view_net_rates)
  }
  const answer = (await aiEnabled(c.env, 'staff_assistant')) ? await writeAnswer(c.env, q, history, result) : fallbackAnswer(result)
  await logActivity(c.env, u.id, 'assistant.ask', 'assistant', null, { q: q.slice(0, 200), options: result.options.length })
  return c.json({
    answer,
    need: result.need,
    dates: result.nights ? { checkIn: result.checkIn, checkOut: result.checkOut, nights: result.nights, guests: result.guests, assumed: result.assumedDates } : null,
    options: result.options,
  })
})
