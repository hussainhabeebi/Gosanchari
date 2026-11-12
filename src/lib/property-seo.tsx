// Property SEO helpers shared by the Add/Edit wizard, the full property editor and the public stay page:
// per-property FAQs, the description limit, and image alt text.
import type { FC } from 'hono/jsx'
import { parseJson } from './util'

export const DESCRIPTION_MAX = 2000
export const META_TITLE_MAX = 70
export const META_DESCRIPTION_MAX = 170
export const FAQ_MAX = 20
export const FAQ_QUESTION_MAX = 200
export const FAQ_ANSWER_MAX = 1000
export const ALT_TEXT_MAX = 150

export interface PropertyFaq { q: string; a: string }

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '')

/** Stored FAQs, ignoring anything malformed (older rows have the default '[]'). */
export function readFaqs(json: string | null | undefined): PropertyFaq[] {
  const list = parseJson<unknown>(json ?? '[]', [])
  if (!Array.isArray(list)) return []
  return list
    .map((x) => (x && typeof x === 'object' ? { q: clean((x as PropertyFaq).q, FAQ_QUESTION_MAX), a: clean((x as PropertyFaq).a, FAQ_ANSWER_MAX) } : null))
    .filter((x): x is PropertyFaq => !!x && !!x.q && !!x.a)
    .slice(0, FAQ_MAX)
}

/** FAQ rows from the form (faq_q[] / faq_a[]). Blank rows are dropped; a half-filled row is an error. */
export function faqsFromForm(all: Record<string, string[]>): { faqs: PropertyFaq[] } | { err: string } {
  const qs = all.faq_q ?? [], as = all.faq_a ?? []
  const out: PropertyFaq[] = []
  for (let i = 0; i < Math.max(qs.length, as.length); i++) {
    const rawQ = (qs[i] ?? '').trim(), rawA = (as[i] ?? '').trim()
    if (!rawQ && !rawA) continue
    if (!rawQ || !rawA) return { err: `FAQ ${out.length + 1}: enter both a question and an answer, or remove the row.` }
    if (rawQ.length > FAQ_QUESTION_MAX) return { err: `FAQ ${out.length + 1}: the question can be at most ${FAQ_QUESTION_MAX} characters.` }
    if (rawA.length > FAQ_ANSWER_MAX) return { err: `FAQ ${out.length + 1}: the answer can be at most ${FAQ_ANSWER_MAX} characters.` }
    out.push({ q: clean(rawQ, FAQ_QUESTION_MAX), a: clean(rawA, FAQ_ANSWER_MAX) })
  }
  if (out.length > FAQ_MAX) return { err: `Add at most ${FAQ_MAX} FAQs.` }
  return { faqs: out }
}

/** The public property description is limited to 2,000 characters; a longer one is rejected, never cut silently. */
export function descriptionError(next: string, before: string | null | undefined): string | null {
  const text = next.replace(/\r\n/g, '\n').trim()
  if (text.length <= DESCRIPTION_MAX) return null
  if (before != null && text === before.replace(/\r\n/g, '\n').trim()) return null
  return `The property description can be at most ${DESCRIPTION_MAX.toLocaleString('en-IN')} characters (it has ${text.length.toLocaleString('en-IN')}). Shorten it and save again.`
}

/** Alt text for a property image: the SEO alt text, else the caption, else a fallback (usually the property name). */
export function photoAlt(ph: { alt_text?: string | null; caption?: string | null }, fallback: string): string {
  return ph.alt_text?.trim() || ph.caption?.trim() || fallback
}

/** FAQPage structured data built from exactly the FAQs shown on the page. */
export function faqSchema(faqs: PropertyFaq[]) {
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }
}

const FaqRow: FC<{ faq?: PropertyFaq }> = ({ faq }) => (
  <div class="faq-row stack" data-faq-row>
    <label class="wf"><span class="wl">Question</span><input name="faq_q" value={faq?.q ?? ''} maxlength={FAQ_QUESTION_MAX} placeholder="e.g. Is the property suitable for children?" /></label>
    <label class="wf"><span class="wl">Answer</span><textarea name="faq_a" rows={3} maxlength={FAQ_ANSWER_MAX} placeholder="Write a clear, helpful answer">{faq?.a ?? ''}</textarea></label>
    <div><button type="button" class="btn btn-sm btn-outline" data-faq-remove>Remove FAQ</button></div>
  </div>
)

/** Repeatable FAQ fields for the admin forms (add/remove handled in public/app.js, data-faq-*). */
export const FaqEditor: FC<{ faqs: PropertyFaq[] }> = ({ faqs }) => (
  <div class="faq-editor stack" data-faq-editor data-faq-max={FAQ_MAX}>
    <span class="wl">FAQs <span class="muted small">(optional — shown on the property page)</span></span>
    <div class="stack" data-faq-list>{faqs.map((f) => <FaqRow faq={f} />)}</div>
    <template data-faq-template><FaqRow /></template>
    <div><button type="button" class="btn btn-sm btn-soft" data-faq-add>+ Add FAQ</button></div>
    <noscript><p class="small muted">Turn on JavaScript to add or remove FAQ rows.</p><FaqRow /></noscript>
  </div>
)
