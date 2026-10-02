// Live chat room (one per visitor conversation): AI assistant first, a person on request.
// Uses the WebSocket Hibernation API so idle chats cost nothing.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { helpChat } from '../lib/assist'
import type { ChatMessage } from '../lib/ai'
import { first, insertId, notifyStaff, run, findOrCreateGuest } from '../lib/db'
import { getSettings } from '../lib/settings'
import { normalizePhone, nowIso, refCode } from '../lib/util'

interface Line {
  from: 'guest' | 'ai' | 'staff' | 'system'
  text: string
  name?: string
  at: string
}

interface State {
  room: string
  mode: 'ai' | 'human'
  enquiryId: number | null
  lang: 'en' | 'ml'
  history: Line[]
  count: number
}

export class ChatRoom extends DurableObject<Env> {
  private async state(): Promise<State> {
    return (
      (await this.ctx.storage.get<State>('state')) ?? { room: '', mode: 'ai', enquiryId: null, lang: 'en', history: [], count: 0 }
    )
  }

  private async save(s: State) {
    s.history = s.history.slice(-60)
    await this.ctx.storage.put('state', s)
  }

  private broadcast(payload: unknown) {
    const data = JSON.stringify(payload)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data)
      } catch {
        /* closed */
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const s = await this.state()
    if (!s.room) {
      s.room = request.headers.get('x-room') ?? ''
      s.lang = request.headers.get('x-lang') === 'ml' ? 'ml' : 'en'
      await this.save(s)
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].send(JSON.stringify({ type: 'hello', mode: s.mode, history: s.history }))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname === '/staff-message' && request.method === 'POST') {
      const { text, name } = (await request.json()) as { text: string; name: string }
      const line: Line = { from: 'staff', text, name, at: nowIso() }
      s.history.push(line)
      s.mode = 'human'
      await this.save(s)
      this.broadcast({ type: 'line', line, mode: s.mode })
      return new Response('ok')
    }
    return new Response('not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 4000) return
    let msg: { type: string; text?: string; name?: string; phone?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const s = await this.state()

    if (msg.type === 'msg' && msg.text?.trim()) {
      s.count++
      if (s.count > 200) {
        ws.send(JSON.stringify({ type: 'line', line: { from: 'system', text: 'This chat is very long — please send us an enquiry or WhatsApp us.', at: nowIso() } }))
        return
      }
      const text = msg.text.trim().slice(0, 600)
      const line: Line = { from: 'guest', text, at: nowIso() }
      s.history.push(line)
      this.broadcast({ type: 'line', line, mode: s.mode })

      if (s.mode === 'human' && s.enquiryId) {
        await run(this.env, "INSERT INTO messages (enquiry_id, sender, channel, body) VALUES (?, 'guest', 'chat', ?)", s.enquiryId, text)
        await run(this.env, "UPDATE enquiries SET waiting_on = 'us', last_guest_msg_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), s.enquiryId)
        await this.save(s)
        return
      }
      this.broadcast({ type: 'typing' })
      const history: ChatMessage[] = s.history
        .slice(-8, -1)
        .filter((l) => l.from === 'guest' || l.from === 'ai')
        .map((l) => ({ role: l.from === 'guest' ? 'user' : 'assistant', content: l.text }))
      const reply = await helpChat(this.env, history, text, s.lang)
      const ai: Line = { from: 'ai', text: reply.answer, at: nowIso() }
      s.history.push(ai)
      await this.save(s)
      this.broadcast({ type: 'line', line: ai, mode: s.mode })
      if (reply.handoff) this.broadcast({ type: 'need_contact' })
      return
    }

    if (msg.type === 'handoff') {
      const phone = normalizePhone(msg.phone)
      const name = (msg.name ?? '').trim().slice(0, 80) || 'Chat guest'
      if (!phone) {
        ws.send(JSON.stringify({ type: 'need_contact', error: 'Please enter a valid phone number.' }))
        return
      }
      if (!s.enquiryId) {
        const transcript = s.history.map((l) => `${l.from === 'guest' ? 'Guest' : l.from === 'ai' ? 'Assistant' : l.name ?? l.from}: ${l.text}`).join('\n')
        const lastQuestion = [...s.history].reverse().find((l) => l.from === 'guest')?.text ?? 'Asked to talk to a person'
        const existing = await first<{ id: number }>(this.env, "SELECT id FROM enquiries WHERE phone = ? AND status IN ('new','in_progress','quoted') ORDER BY id DESC LIMIT 1", phone)
        if (existing) {
          s.enquiryId = existing.id
          await run(this.env, "UPDATE enquiries SET chat_room = ?, waiting_on = 'us', urgent = 1, last_guest_msg_at = ? WHERE id = ?", s.room, nowIso(), existing.id)
        } else {
          const userId = await findOrCreateGuest(this.env, phone, name, null)
          s.enquiryId = await insertId(
            this.env,
            "INSERT INTO enquiries (code, user_id, guest_name, phone, source, message, chat_room, tags, whatsapp_optin, last_guest_msg_at) VALUES (?, ?, ?, ?, 'chat', ?, ?, '[\"handoff\"]', 1, ?)",
            refCode('ENQ'), userId, name, phone, lastQuestion, s.room, nowIso(),
          )
        }
        await run(this.env, "INSERT INTO messages (enquiry_id, sender, channel, body) VALUES (?, 'system', 'chat', ?)", s.enquiryId, `Chat transcript before hand-over:\n${transcript}`)
        await this.env.JOBS.send({ type: 'enquiry_ai', enquiryId: s.enquiryId }).catch(() => {})
        await notifyStaff(this.env, 'new_enquiry', `Chat hand-over from ${name} (${phone}): “${lastQuestion.slice(0, 100)}”`)
      }
      s.mode = 'human'
      const settings = await getSettings(this.env)
      const line: Line = { from: 'system', text: `Thanks ${name}! A member of our team will reply here and on WhatsApp shortly (9am–9pm). You can also call ${settings.business.phone}.`, at: nowIso() }
      s.history.push(line)
      await this.save(s)
      this.broadcast({ type: 'line', line, mode: s.mode })
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, 'closing')
    } catch {
      /* already closed */
    }
  }
}
