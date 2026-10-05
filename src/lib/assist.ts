// AI features built on the wrapper in ai.ts. Every function returns null / a safe fallback
// when AI is off or fails, so the portal keeps working without it.

import type { Env } from '../env'
import { aiJson, aiText, detectLanguage, kbSearch, LANGUAGE_NAME, type ChatMessage } from './ai'
import { all, first, run } from './db'
import { propertyDoc, semanticScores, cardsByIds } from './properties'
import { getContent, getSettings } from './settings'
import { guardSql, schemaForPrompt } from './sqlguard'
import type { EnquiryRow, MessageRow, PropertyCard, PropertyRow, QuotationRow, QuoteOptionRow, ReviewRow } from './types'
import { fmtDate, money, nightsBetween, sha256Hex, todayIST } from './util'
import { roomAvailability } from './db'
import { roomsNeeded } from './pricing'

const NOT_FOUND = 'NOT_FOUND'

export interface AssistantReply {
  answer: string
  handoff: boolean
  sources?: string[]
}

function handoffText(lang: 'en' | 'ml') {
  return lang === 'ml'
    ? 'ഇതിനെക്കുറിച്ച് എനിക്ക് ഉറപ്പില്ല. ഞങ്ങളുടെ ടീമുമായി ബന്ധിപ്പിക്കാം.'
    : "I'm not sure about that. Let me connect you to our team."
}

// ---- Property Q&A (page 3) ----

export async function propertyQA(env: Env, p: PropertyRow, question: string): Promise<AssistantReply> {
  const lang = detectLanguage(question)
  const norm = question.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
  const cacheKey = `qa:${p.id}:${p.updated_at}:${await sha256Hex(norm)}`
  const cached = await env.KV.get<AssistantReply>(cacheKey, 'json')
  if (cached) return cached

  // Context only from this property: AI Search over its own folder, else its details straight from D1.
  const chunks = await kbSearch(env, 'property_qa', question, `properties/${p.slug}/`)
  const context = chunks?.length ? chunks.map((c) => c.text).join('\n---\n') : await propertyDoc(env, p)

  const out = await aiText(env, 'property_qa', {
    size: 'large',
    maxTokens: 300,
    cacheTtl: 86400,
    system:
      `You answer guest questions about ONE holiday property, "${p.name}", using ONLY the property information below. ` +
      `Never guess or use outside knowledge. Never promise prices, discounts or availability. ` +
      `If the answer is not clearly in the information, reply with exactly ${NOT_FOUND}. ` +
      `Answer in ${LANGUAGE_NAME[lang]} in 1-3 short sentences.\n\nPROPERTY INFORMATION:\n${context}`,
    prompt: question,
  })
  const reply: AssistantReply =
    !out || out.includes(NOT_FOUND) ? { answer: handoffText(lang), handoff: true } : { answer: out, handoff: false }
  if (out) await env.KV.put(cacheKey, JSON.stringify(reply), { expirationTtl: 86400 })
  return reply
}

// ---- Help chat assistant (page 18) ----

export async function needsHandoff(env: Env, text: string): Promise<boolean> {
  const s = await getSettings(env)
  const t = text.toLowerCase()
  return s.ai.handoff_topics.some((k) => k && t.includes(k.toLowerCase())) || /talk to (a )?(person|human|agent|someone)/.test(t)
}

export async function helpChat(env: Env, history: ChatMessage[], message: string, prefLang?: 'en' | 'ml'): Promise<AssistantReply> {
  const lang = detectLanguage(message) === 'ml' ? 'ml' : prefLang ?? 'en'
  if (await needsHandoff(env, message)) {
    return {
      answer: lang === 'ml' ? 'ഇതിനായി ഞങ്ങളുടെ ടീം നിങ്ങളെ സഹായിക്കും. ഒരു ടിക്കറ്റ് ഉണ്ടാക്കുന്നു.' : 'Our team will help you with this. I am passing your message to a person now.',
      handoff: true,
    }
  }
  const s = await getSettings(env)
  const chunks = await kbSearch(env, 'help_chat', message)
  let context: string
  if (chunks?.length) context = chunks.map((c) => `[${c.key}]\n${c.text}`).join('\n---\n')
  else {
    const c = await getContent(env)
    context = [
      ...c.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`),
      `Cancellation policy: ${c.policies.cancellation}`,
      `Contact: ${s.business.phone}, WhatsApp ${s.business.whatsapp}, ${s.business.email}`,
    ].join('\n\n')
  }
  const out = await aiText(env, 'help_chat', {
    size: 'large',
    maxTokens: 350,
    cacheTtl: history.length ? undefined : 86400,
    system:
      `You are the ${s.business.name} help assistant for a Kerala holiday-stay booking site. Tone: ${s.ai.assistant_tone}. ` +
      `Answer ONLY from the information below. Do not invent prices, availability, policies or promises. ` +
      `If the information does not answer the question, reply with exactly ${NOT_FOUND}. ` +
      `Reply in ${LANGUAGE_NAME[lang]}. Keep it under 80 words.\n\nINFORMATION:\n${context}`,
    messages: [...history.slice(-6), { role: 'user', content: message }],
  })
  if (!out || out.includes(NOT_FOUND)) return { answer: handoffText(lang), handoff: true }
  return { answer: out, handoff: false, sources: chunks?.map((c) => c.key) }
}

// ---- Enquiry: tags + summary (page 4/20), runs in the queue ----

export const ENQUIRY_TAGS = ['budget', 'luxury', 'family', 'honeymoon', 'group', 'urgent', 'corporate', 'elderly', 'pets', 'long_stay'] as const

export function ruleTags(e: Pick<EnquiryRow, 'adults' | 'children' | 'budget' | 'check_in' | 'check_out' | 'message'>): string[] {
  const t = new Set<string>()
  const m = e.message.toLowerCase()
  const guests = e.adults + e.children
  if (e.children > 0 || /kids?|child|family/.test(m)) t.add('family')
  if (/honeymoon|anniversary|couple/.test(m)) t.add('honeymoon')
  if (guests >= 8 || /group|friends|team/.test(m)) t.add('group')
  if (/elderly|parents|senior|wheelchair/.test(m)) t.add('elderly')
  if (/\bpets?\b|dog/.test(m)) t.add('pets')
  if (e.check_in) {
    const days = (Date.parse(e.check_in) - Date.parse(todayIST())) / 86400000
    if (days <= 3) t.add('urgent')
    if (e.check_out && nightsBetween(e.check_in, e.check_out) >= 7) t.add('long_stay')
  }
  if (/urgent|asap|today|tomorrow/.test(m)) t.add('urgent')
  if (e.budget && e.check_in && e.check_out) {
    const perNight = e.budget / Math.max(1, nightsBetween(e.check_in, e.check_out))
    if (perNight < 3500) t.add('budget')
    if (perNight > 20000) t.add('luxury')
  }
  return [...t]
}

function parseJsonTags(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export async function processEnquiryAI(env: Env, enquiryId: number): Promise<void> {
  const e = await first<EnquiryRow & { property_name: string | null }>(
    env,
    'SELECT e.*, p.name AS property_name FROM enquiries e LEFT JOIN properties p ON p.id = e.property_id WHERE e.id = ?',
    enquiryId,
  )
  if (!e) return
  const msgs = await all<MessageRow>(env, "SELECT * FROM messages WHERE enquiry_id = ? AND sender = 'guest' ORDER BY id LIMIT 10", enquiryId)
  const text = [e.message, ...msgs.map((m) => m.transcript ?? m.body)].filter(Boolean).join('\n')
  const tags = new Set([...parseJsonTags(e.tags), ...ruleTags(e)])
  const language = detectLanguage(text)

  const facts = `Guest: ${e.guest_name}. Destination: ${e.destination ?? e.property_name ?? 'not given'}. Dates: ${e.check_in ?? '?'} to ${e.check_out ?? '?'}. Adults ${e.adults}, children ${e.children}. Budget: ${e.budget ? money(e.budget) : 'not given'}.`
  const ai = await aiJson<{ tags?: string[]; summary?: string; urgent?: boolean }>(env, 'enquiry_ai', {
    size: 'small',
    maxTokens: 200,
    system:
      `Read a travel enquiry for Kerala holiday stays. Return ONLY JSON: {"tags": [...], "summary": "...", "urgent": true|false}. ` +
      `tags from: ${ENQUIRY_TAGS.join(', ')}. summary: one line under 25 words for staff, in English, with group, dates, place, budget and any special need ` +
      `(e.g. "Family of 5, 12–14 Dec, Munnar, ₹15k budget, needs ground floor for elderly parents.").`,
    prompt: `${facts}\nMessage:\n${text || '(no message)'}`,
  })
  for (const t of ai?.tags ?? []) if ((ENQUIRY_TAGS as readonly string[]).includes(t)) tags.add(t)
  if (ai?.urgent) tags.add('urgent')
  const summary = ai?.summary?.slice(0, 300) ?? null
  await run(
    env,
    'UPDATE enquiries SET tags = ?, language = ?, summary = COALESCE(?, summary), urgent = ? WHERE id = ?',
    JSON.stringify([...tags]), language, summary, tags.has('urgent') ? 1 : 0, enquiryId,
  )
}

// ---- Staff workspace (page 21) ----

export async function enquirySummary(env: Env, e: EnquiryRow, msgs: MessageRow[]): Promise<string | null> {
  const convo = msgs.slice(-20).map((m) => `${m.sender}: ${m.transcript ?? m.body}`).join('\n')
  return aiText(env, 'staff_summary', {
    size: 'small',
    maxTokens: 120,
    system: 'Summarise this travel enquiry for a sales agent in ONE line under 30 words: group, dates, place, budget, special needs, what the guest is waiting for. English only.',
    prompt: `Enquiry: ${e.guest_name}, ${e.destination ?? ''}, ${e.check_in ?? '?'}–${e.check_out ?? '?'}, ${e.adults} adults ${e.children} children, budget ${e.budget ?? '?'}.\n${e.message}\n\nConversation:\n${convo}`,
  })
}

/** Top property matches: Vectorize on the guest's needs + real availability from D1. */
export async function matchProperties(env: Env, e: EnquiryRow, n = 3): Promise<(PropertyCard & { reason?: string; free?: boolean })[]> {
  const guests = e.adults + e.children
  const needs = [e.destination, e.summary, e.message, JSON.parse(e.tags || '[]').join(' ')].filter(Boolean).join('. ')
  const sem = needs ? await semanticScores(env, needs, 30) : null
  let candidates: number[]
  if (sem?.size) candidates = [...sem.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  else candidates = (await all<{ id: number }>(env, "SELECT id FROM properties WHERE status = 'live' ORDER BY (destination = ?) DESC, rating_avg DESC LIMIT 30", e.destination ?? '')).map((r) => r.id)
  let cards = await cardsByIds(env, candidates)
  if (e.destination) cards = [...cards.filter((c) => c.destination === e.destination), ...cards.filter((c) => c.destination !== e.destination)]
  cards = cards.filter((c) => (c.max_guests ?? 0) >= guests)
  if (e.check_in && e.check_out) {
    const avail = await roomAvailability(env, cards.map((c) => c.id), e.check_in, e.check_out)
    const rooms = await all<{ id: number; property_id: number; capacity: number }>(env, `SELECT id, property_id, capacity FROM rooms WHERE active = 1`)
    const ok = (pid: number) => rooms.filter((r) => r.property_id === pid).some((r) => (avail.get(r.id)?.free ?? 0) >= roomsNeeded(guests, r.capacity))
    cards = cards.filter((c) => ok(c.id))
  }
  if (e.budget && e.check_in && e.check_out) {
    const perNight = e.budget / Math.max(1, nightsBetween(e.check_in, e.check_out))
    cards.sort((a, b) => Number(a.from_price > perNight * 1.15) - Number(b.from_price > perNight * 1.15))
  }
  return cards.slice(0, n)
}

export async function replySuggestion(env: Env, e: EnquiryRow, msgs: MessageRow[], staffName: string): Promise<string | null> {
  const s = await getSettings(env)
  const convo = msgs.slice(-12).map((m) => `${m.sender === 'guest' ? 'Guest' : 'Us'}: ${m.transcript ?? m.body}`).join('\n')
  return aiText(env, 'reply_suggest', {
    size: 'large',
    maxTokens: 220,
    system:
      `You draft WhatsApp replies for ${staffName}, a travel consultant at ${s.business.name} (Kerala stays). ` +
      `Write in ${LANGUAGE_NAME[e.language]}. Friendly, short (under 70 words), no emojis overload. ` +
      `Never state prices, discounts or availability that are not in the conversation — say you will check and send a quote instead. ` +
      `Return only the message text.`,
    prompt: `Enquiry summary: ${e.summary ?? e.message}\n\nConversation so far:\n${convo}\n\nDraft the next reply from us.`,
  })
}

// ---- Quotation builder (page 23) and explainer (page 14) ----

export async function quoteFillFromEnquiry(env: Env, e: EnquiryRow) {
  // Dates/guests come straight from the enquiry record; AI only reads them out of free text when missing.
  let checkIn = e.check_in
  let checkOut = e.check_out
  let adults = e.adults
  let children = e.children
  if ((!checkIn || !checkOut) && e.message) {
    const ai = await aiJson<{ checkIn?: string; checkOut?: string; adults?: number; children?: number }>(env, 'quote_fill', {
      size: 'small',
      maxTokens: 120,
      system: `Today is ${todayIST()}. Extract stay dates and guest counts from a travel enquiry. Return ONLY JSON {"checkIn":"YYYY-MM-DD","checkOut":"YYYY-MM-DD","adults":n,"children":n}; omit unknown keys.`,
      prompt: e.message,
    })
    if (ai?.checkIn && /^\d{4}-\d{2}-\d{2}$/.test(ai.checkIn)) checkIn = ai.checkIn
    if (ai?.checkOut && /^\d{4}-\d{2}-\d{2}$/.test(ai.checkOut) && (!checkIn || ai.checkOut > checkIn)) checkOut = ai.checkOut
    if (ai?.adults && ai.adults > 0 && ai.adults < 50) adults = Math.round(ai.adults)
    if (ai?.children != null && ai.children >= 0 && ai.children < 50) children = Math.round(ai.children)
  }
  const matches = await matchProperties(env, { ...e, check_in: checkIn, check_out: checkOut, adults, children }, 3)
  return { checkIn, checkOut, adults, children, propertyId: e.property_id ?? matches[0]?.id ?? null, matches }
}

export async function quoteMessageDraft(env: Env, q: Pick<QuotationRow, 'guest_name'>, lines: string[], lang: 'en' | 'ml'): Promise<string | null> {
  const s = await getSettings(env)
  return aiText(env, 'quote_fill', {
    size: 'small',
    maxTokens: 180,
    system: `Write a short, warm WhatsApp message (under 60 words) from ${s.business.name} sending a stay quotation. Language: ${LANGUAGE_NAME[lang]}. Do not change or add any prices; refer to "the quote" for details. Return only the message.`,
    prompt: `Guest: ${q.guest_name}\nQuote options:\n${lines.join('\n')}`,
  })
}

/** Written once when a quote is created/sent and stored; never regenerated per view. */
export async function buildQuoteExplainer(env: Env, quotationId: number): Promise<void> {
  const q = await first<QuotationRow>(env, 'SELECT * FROM quotations WHERE id = ?', quotationId)
  if (!q) return
  const opts = await all<QuoteOptionRow & { property_name: string; room_name: string }>(
    env,
    'SELECT o.*, p.name AS property_name, r.name AS room_name FROM quotation_options o JOIN properties p ON p.id = o.property_id JOIN rooms r ON r.id = o.room_id WHERE o.quotation_id = ? ORDER BY o.id',
    quotationId,
  )
  if (!opts.length) return
  // Facts are assembled by code; the model only phrases them.
  const facts = opts.map((o, i) =>
    `Option ${i + 1}: ${nightsBetween(o.check_in, o.check_out)} nights at ${o.property_name} (${o.room_name} x${o.rooms_count}) for ${o.adults + o.children} people, ${fmtDate(o.check_in)} to ${fmtDate(o.check_out)}, meal plan ${o.meal_plan ?? 'room only'}, total ${money(o.total)} including taxes.`,
  )
  const lang = q.enquiry_id ? ((await first<{ language: 'en' | 'ml' }>(env, 'SELECT language FROM enquiries WHERE id = ?', q.enquiry_id))?.language ?? 'en') : 'en'
  const out = await aiText(env, 'quote_explainer', {
    size: 'small',
    maxTokens: 140,
    system: `Rewrite these quote facts as a plain 2-3 line summary for the guest in ${LANGUAGE_NAME[lang]}. Keep every number exactly as given. No greetings. Example: "3 nights at Hill View Villa for 5 people, breakfast included, ₹14,500 total."`,
    prompt: facts.join('\n') + (q.inclusions ? `\nIncluded: ${q.inclusions}` : ''),
  })
  // If AI is off, store the plain facts – still useful, and exact.
  const amounts = opts.map((o) => money(o.total))
  const safe = out && amounts.every((a) => out.includes(a.replace('₹', '')) || out.includes(a)) ? out : facts.join(' ')
  await run(env, 'UPDATE quotations SET explainer = ? WHERE id = ?', safe, quotationId)
}

// ---- Guest preference notes (page 28) ----

export async function extractGuestPrefs(env: Env, enquiryId: number): Promise<void> {
  const e = await first<EnquiryRow>(env, 'SELECT * FROM enquiries WHERE id = ?', enquiryId)
  if (!e || (!e.user_id && !e.phone)) return
  const msgs = await all<MessageRow>(env, "SELECT * FROM messages WHERE enquiry_id = ? AND sender = 'guest' ORDER BY id DESC LIMIT 30", enquiryId)
  const text = [e.message, ...msgs.map((m) => m.transcript ?? m.body)].join('\n').slice(0, 4000)
  if (text.trim().length < 20) return
  const prefs = await aiJson<string[]>(env, 'guest_prefs', {
    size: 'small',
    maxTokens: 120,
    system: 'List lasting travel preferences of this guest that a travel agent should remember (e.g. "vegetarian", "prefers pool", "travels with elderly parents"). Return ONLY a JSON array of up to 5 short strings in English. Return [] if none.',
    prompt: text,
  })
  if (!Array.isArray(prefs)) return
  const existing = await all<{ note: string }>(env, "SELECT note FROM guest_notes WHERE kind = 'preference' AND (user_id = ? OR phone = ?)", e.user_id, e.phone)
  const have = new Set(existing.map((x) => x.note.toLowerCase()))
  for (const p of prefs.slice(0, 5)) {
    const note = String(p).slice(0, 80).trim()
    if (note && !have.has(note.toLowerCase())) {
      await run(env, "INSERT INTO guest_notes (user_id, phone, note, kind, source) VALUES (?, ?, ?, 'preference', 'ai')", e.user_id, e.phone, note)
    }
  }
}

// ---- Follow-up drafts (page 29) ----

export async function followupDraft(env: Env, taskId: number): Promise<void> {
  const t = await first<{ id: number; reason: string; guest_name: string | null; quotation_id: number | null; enquiry_id: number | null }>(env, 'SELECT * FROM tasks WHERE id = ?', taskId)
  if (!t) return
  const q = t.quotation_id ? await first<QuotationRow>(env, 'SELECT * FROM quotations WHERE id = ?', t.quotation_id) : null
  const e = t.enquiry_id ? await first<EnquiryRow>(env, 'SELECT * FROM enquiries WHERE id = ?', t.enquiry_id) : null
  const prop = q ? await first<{ name: string }>(env, 'SELECT p.name FROM quotation_options o JOIN properties p ON p.id = o.property_id WHERE o.quotation_id = ? LIMIT 1', q.id) : null
  const lang = e?.language ?? 'en'
  const s = await getSettings(env)
  const draft = await aiText(env, 'followup_drafts', {
    size: 'small',
    maxTokens: 140,
    system: `Write a short, polite WhatsApp follow-up (under 45 words) from ${s.business.name} in ${LANGUAGE_NAME[lang]}. No prices. Return only the message.`,
    prompt: `Guest: ${t.guest_name ?? e?.guest_name}. Reason: ${t.reason}. ${prop ? `Quote for ${prop.name}, viewed ${q?.view_count ?? 0} times, valid till ${q?.valid_till}.` : ''} ${e?.summary ?? ''}`,
  })
  const fallback = s.whatsapp_templates.followup.replace('{name}', t.guest_name ?? 'there').replace('{property}', prop?.name ?? 'your stay')
  await run(env, 'UPDATE tasks SET draft_message = ? WHERE id = ?', draft ?? fallback, taskId)
}

// ---- Reviews (pages 3, 16, 44) ----

export async function checkReview(env: Env, reviewId: number): Promise<void> {
  const r = await first<ReviewRow>(env, 'SELECT * FROM reviews WHERE id = ?', reviewId)
  if (!r) return
  const ai = await aiJson<{ flag: boolean; reason?: string }>(env, 'review_check', {
    size: 'small',
    maxTokens: 60,
    system: 'You moderate hotel reviews. Flag ONLY if the review is spam, advertising, abusive, hateful, contains personal phone numbers/emails, or is unrelated to the stay. Honest negative reviews are NOT flagged. Return ONLY JSON {"flag": true|false, "reason": "short reason"}.',
    prompt: `Rating: ${r.rating}/5\n${r.body}`,
  })
  const hasContact = /(\+?\d[\d\s-]{8,}\d)|(\S+@\S+\.\S+)|https?:\/\//i.test(r.body)
  const flagged = !!ai?.flag || hasContact
  await run(env, 'UPDATE reviews SET flagged = ?, flag_reason = ? WHERE id = ?', flagged ? 1 : 0, flagged ? (ai?.reason ?? 'Contains contact details or links') : null, reviewId)
}

export async function reviewReplyDraft(env: Env, reviewId: number): Promise<void> {
  const r = await first<ReviewRow & { property_name: string }>(env, 'SELECT r.*, p.name AS property_name FROM reviews r JOIN properties p ON p.id = r.property_id WHERE r.id = ?', reviewId)
  if (!r) return
  const draft = await aiText(env, 'review_insights', {
    size: 'small',
    maxTokens: 140,
    system: 'Write a short, gracious public reply (under 50 words) from the Go Sanchari team to this guest review. Thank them; if there is a complaint, apologise and say we are looking into it. No promises of refunds. Return only the reply.',
    prompt: `${r.property_name}, ${r.rating}/5 from ${r.guest_name}:\n${r.body}`,
  })
  if (draft) await run(env, 'UPDATE reviews SET reply_draft = ? WHERE id = ?', draft, reviewId)
}

/** Generated once a day by the cron job, stored on the property. */
export async function refreshReviewSummary(env: Env, propertyId: number): Promise<void> {
  const rows = await all<{ rating: number; body: string }>(env, "SELECT rating, body FROM reviews WHERE property_id = ? AND status = 'approved' AND body != '' ORDER BY id DESC LIMIT 40", propertyId)
  if (rows.length < 3) return
  const out = await aiText(env, 'review_summary', {
    size: 'small',
    maxTokens: 70,
    system: 'Summarise these guest reviews in ONE balanced sentence under 22 words, like "Guests love the view and food; some mention a steep road." Return only the sentence.',
    prompt: rows.map((r) => `(${r.rating}/5) ${r.body}`).join('\n').slice(0, 6000),
  })
  if (out) await run(env, "UPDATE properties SET review_summary = ?, review_summary_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", out.replace(/^"|"$/g, ''), propertyId)
}

// ---- Property editor helpers (page 33) ----

export async function writeDescription(env: Env, name: string, type: string, destination: string, points: string): Promise<{ en: string; ml: string } | null> {
  const en = await aiText(env, 'description_writer', {
    size: 'large',
    maxTokens: 400,
    system: 'Write a clean, honest holiday-property description (90-140 words, 2 short paragraphs) from the points given. Do not invent facilities or claims that are not in the points. Return only the description.',
    prompt: `${name}, a ${type} in ${destination}, Kerala.\nPoints:\n${points}`,
  })
  if (!en) return null
  const ml = await aiText(env, 'description_writer', {
    size: 'large',
    maxTokens: 700,
    system: 'Translate this holiday-property description into natural Malayalam. Keep names as they are. Return only the translation.',
    prompt: en,
  })
  return { en, ml: ml ?? '' }
}

export async function seoSuggest(env: Env, p: Pick<PropertyRow, 'name' | 'type' | 'destination' | 'description'>): Promise<{ title: string; description: string } | null> {
  const r = await aiJson<{ title: string; description: string }>(env, 'seo_suggest', {
    size: 'small',
    maxTokens: 160,
    system: 'Suggest an SEO page title (under 60 characters) and meta description (under 155 characters) for a holiday property page. Return ONLY JSON {"title": "...", "description": "..."}.',
    prompt: `${p.name}, ${p.type} in ${p.destination}, Kerala.\n${p.description.slice(0, 1200)}`,
  })
  if (!r?.title) return null
  return { title: r.title.slice(0, 70), description: (r.description ?? '').slice(0, 170) }
}

// ---- Ask AI (page 43) ----

export interface AskAiResult {
  question: string
  sql?: string
  columns: string[]
  rows: Record<string, unknown>[]
  explanation: string
  chart?: { labels: string[]; values: number[]; label: string }
  error?: string
}

export async function askAi(env: Env, question: string): Promise<AskAiResult> {
  const base = { question, columns: [], rows: [], explanation: '' }
  const key = `askai:${await sha256Hex(question.toLowerCase().trim() + todayIST())}`
  const cached = await env.KV.get<AskAiResult>(key, 'json')
  if (cached) return cached

  const sqlText = await aiText(env, 'ask_ai', {
    size: 'large',
    maxTokens: 400,
    temperature: 0,
    cacheTtl: 3600,
    system:
      `You write ONE read-only SQLite SELECT query for a travel booking business. Today is ${todayIST()} (dates are TEXT 'YYYY-MM-DD'; created_at is ISO timestamp text, compare with substr(created_at,1,10)). ` +
      `Money is whole rupees. Revenue = SUM(bookings.total) for bookings with status IN ('confirmed','checked_in','completed'). ` +
      `Staff who closed a booking = bookings.staff_id joined to people.id. Use only these tables and columns:\n${schemaForPrompt()}\n` +
      `Return ONLY the SQL, no explanation, at most 50 rows, with readable column aliases.`,
    prompt: question,
  })
  if (!sqlText) return { ...base, error: 'Ask AI is turned off or unavailable right now.' }
  const g = guardSql(sqlText)
  if (!g.ok) return { ...base, sql: sqlText, error: `Could not run that safely (${g.error}). Try rephrasing.` }
  let rows: Record<string, unknown>[]
  try {
    rows = (await env.DB.prepare(g.sql!).all()).results as Record<string, unknown>[]
  } catch (e) {
    return { ...base, sql: sqlText, error: 'The query failed: ' + (e as Error).message }
  }
  const columns = rows[0] ? Object.keys(rows[0]) : []
  const explanation =
    (await aiText(env, 'ask_ai', {
      size: 'small',
      maxTokens: 120,
      system: 'Explain the answer to the business question in one or two plain sentences using the result rows. Use ₹ for money. If there are no rows, say no matching data was found.',
      prompt: `Question: ${question}\nRows (JSON): ${JSON.stringify(rows.slice(0, 20))}`,
    })) ?? (rows.length ? `${rows.length} row(s) found.` : 'No matching data found.')

  let chart: AskAiResult['chart']
  if (columns.length === 2 && rows.length > 1 && rows.every((r) => typeof r[columns[1]] === 'number')) {
    chart = { labels: rows.map((r) => String(r[columns[0]])), values: rows.map((r) => Number(r[columns[1]])), label: columns[1] }
  }
  const result: AskAiResult = { question, sql: sqlText, columns, rows, explanation, chart }
  await env.KV.put(key, JSON.stringify(result), { expirationTtl: 3600 })
  return result
}
