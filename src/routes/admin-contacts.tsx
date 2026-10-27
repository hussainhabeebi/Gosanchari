// Admin → Resort contacts: look up a resort's contact person, numbers and email by location and name.
// Admin side only (needs "See property contact details", which only admins have by default) — never in the staff area.
// Also: export the contacts as CSV, and email one, some or all resorts through Resend.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Select } from '../views/components'
import { requirePerm } from '../lib/auth'
import { all, logActivity } from '../lib/db'
import { contact as readContact, stayTypeLabel, type Contact } from '../lib/catalog'
import { EMAIL_RE, fillTemplate, resendKey, sendEmails, type OutgoingEmail, type SendReport } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import { int, str, toCsv, todayIST } from '../lib/util'
import { form } from './helpers'

export const contactRoutes = new Hono<AppEnv>()

interface ContactRow {
  id: number
  name: string
  destination: string
  address: string | null
  map_url: string | null
  status: string
  type: string
  stay_type: string | null
  contact: string
  owner_name: string | null
  owner_phone: string | null
  owner_email: string | null
}

const digits = (phone: string) => phone.replace(/[^\d+]/g, '')
/** Indian 10-digit numbers get the 91 country code for WhatsApp links. */
const waNumber = (phone: string) => {
  const d = phone.replace(/\D/g, '')
  return d.length === 10 ? `91${d}` : d
}
const PHONE_IN_TEXT = /\+?\d[\d\s-]{7,}\d/

/** Contact details for one property; older properties only have the owner columns. */
export function contactOf(p: ContactRow): Contact {
  const con = readContact(p.contact)
  return { ...con, person: con.person ?? p.owner_name ?? undefined, phone: con.phone ?? p.owner_phone ?? undefined, email: con.email ?? p.owner_email ?? undefined }
}

/** Lower-case text the search box matches against: resort name, location, address, people, numbers and emails. */
export function searchText(p: ContactRow, con: Contact): string {
  const nums = [con.phone, con.phone2, con.phone3].filter(Boolean).map((n) => `${n} ${n!.replace(/\D/g, '')}`)
  return [p.name, p.destination, p.address, con.person, ...nums, con.email, con.email2, con.others].filter(Boolean).join(' ').toLowerCase()
}

const Phone = ({ n }: { n: string }) => (
  <span class="contact-phone">
    <a href={`tel:${digits(n)}`}>{n}</a>
    <a class="small" href={`https://wa.me/${waNumber(n)}`} target="_blank" rel="noopener">WhatsApp</a>
  </span>
)

type Item = { p: ContactRow; con: Contact; text: string }

async function loadContacts(c: Context<AppEnv>): Promise<Item[]> {
  const rows = await all<ContactRow>(c.env, 'SELECT id, name, destination, address, map_url, status, type, stay_type, contact, owner_name, owner_phone, owner_email FROM properties ORDER BY destination, name')
  return rows.map((p) => {
    const con = contactOf(p)
    return { p, con, text: searchText(p, con) }
  })
}

/** The location + search-words filter, shared by the page, the CSV export and "email all shown". */
function filterFor(loc: string, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return (i: Item) => (!loc || i.p.destination === loc) && words.every((w) => i.text.includes(w) || (!!w.replace(/\D/g, '') && i.text.includes(w.replace(/\D/g, ''))))
}

/** Valid, distinct email addresses saved for a resort (main and second email). */
export function emailsOf(con: Contact): string[] {
  return [...new Set([con.email, con.email2].map((e) => (e ?? '').trim()).filter((e) => EMAIL_RE.test(e)).map((e) => e.toLowerCase()))]
}

const filterQuery = (loc: string, q: string) => {
  const u = new URLSearchParams()
  if (loc) u.set('location', loc)
  if (q) u.set('q', q)
  const s = u.toString()
  return s ? `?${s}` : ''
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** Builds one personalised email per resort from the plain-text message. */
export function resortEmail(i: Item, subject: string, message: string): OutgoingEmail {
  const vars = { resort: i.p.name, person: i.con.person || 'Sir/Madam', location: i.p.destination }
  const text = fillTemplate(message, vars)
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">${escHtml(text).replace(/\r?\n/g, '<br>')}</div>`
  return { to: emailsOf(i.con), subject: fillTemplate(subject, vars), html, text }
}

contactRoutes.get('/admin/contacts', requirePerm('view_property_contacts'), async (c) => {
  const q = str(c.req.query('q'), 80)
  const loc = str(c.req.query('location'), 80)
  const items = await loadContacts(c)
  // The page holds every resort and filters as you type; the same filter runs here so links with ?q= work without JavaScript.
  const shown = filterFor(loc, q)
  const visible = items.filter(shown).length
  const locations = [...new Set(items.map((i) => i.p.destination))].filter(Boolean).sort()
  const withEmail = items.filter((i) => emailsOf(i.con).length).length
  return page(c, { title: 'Resort contacts', area: 'admin', active: 'contacts' }, (
    <div class="stack-lg" data-contact-finder>
      <div class="row-between">
        <h1>Resort contacts</h1>
        <span class="muted small" data-contact-count>{visible} of {items.length} resorts</span>
      </div>
      <div class="row wrap-row contact-actions">
        <a class="btn btn-sm btn-outline" href={`/admin/contacts/export.csv${filterQuery(loc, q)}`} data-filter-link="/admin/contacts/export.csv" download>Export shown to CSV</a>
        <a class="btn btn-sm btn-outline" href={`/admin/contacts/email?all=1${filterQuery(loc, q).replace('?', '&')}`} data-filter-link="/admin/contacts/email?all=1">Email all shown</a>
        <button class="btn btn-sm" form="contact-email" data-email-selected>Email selected</button>
        <label class="check small"><input type="checkbox" data-select-shown /> Select all shown</label>
        <span class="muted small">{withEmail} of {items.length} resorts have an email address</span>
      </div>
      <form id="contact-email" method="get" action="/admin/contacts/email" hidden></form>
      <form method="get" class="row filters-inline wrap-row contact-search" role="search">
        <Select name="location" value={loc} options={[['', 'All locations'], ...locations.map((d) => [d, d] as [string, string])]} />
        <input name="q" type="search" value={q} placeholder="Resort name, contact person or number" aria-label="Search resort contacts" autofocus autocomplete="off" />
        <button class="btn btn-sm">Search</button>
      </form>
      <div class="grid grid-3 contact-grid">
        {items.map(({ p, con, text }) => {
          const others = (con.others ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
          return (
            <article class="card stack contact-card" data-location={p.destination} data-search={text} hidden={!shown({ p, con, text })}>
              <div class="row-between">
                <div>{emailsOf(con).length > 0 && <input type="checkbox" name="ids" value={p.id} form="contact-email" aria-label={`Select ${p.name} for email`} data-contact-pick />} <strong>{p.name}</strong><div class="muted small">{p.destination} · {stayTypeLabel(p)}</div></div>
                {p.status !== 'live' && <span class={`pill pill-${p.status === 'hidden' ? 'disabled' : p.status}`}>{p.status === 'hidden' ? 'disabled' : p.status}</span>}
              </div>
              {con.person || con.phone || con.phone2 || con.phone3 || con.email || con.email2 || others.length ? (
                <dl class="contact-list">
                  {con.person && <><dt>Contact person</dt><dd>{con.person}</dd></>}
                  {(con.phone || con.phone2 || con.phone3) && <><dt>Phone</dt><dd>{[con.phone, con.phone2, con.phone3].filter(Boolean).map((n) => <Phone n={n!} />)}</dd></>}
                  {(con.email || con.email2) && <><dt>Email</dt><dd>{[con.email, con.email2].filter(Boolean).map((e) => <a href={`mailto:${e}`}>{e}</a>)}</dd></>}
                  {others.length > 0 && <><dt>More contacts</dt><dd>{others.map((l) => {
                    const m = l.match(PHONE_IN_TEXT)
                    return m ? <div>{l.slice(0, m.index).replace(/[\s–-]+$/, '')}{m.index ? ' · ' : ''}<Phone n={m[0].trim()} />{l.slice(m.index! + m[0].length)}</div> : <div>{l}</div>
                  })}</dd></>}
                </dl>
              ) : <p class="muted small">No contact details saved yet.</p>}
              {con.bank_details && <details class="small"><summary>Account details</summary><div class="pre-line">{con.bank_details}</div></details>}
              <div class="row wrap-row small">
                {p.address && <span class="muted">{p.address}</span>}
                {p.map_url && <a href={p.map_url} target="_blank" rel="noopener">Map</a>}
                {emailsOf(con).length > 0 && <a href={`/admin/contacts/email?ids=${p.id}`}>Send email</a>}
                <a href={`/admin/properties/${p.id}/setup/5`}>Edit contacts</a>
              </div>
            </article>
          )
        })}
      </div>
      <div data-contact-empty hidden={visible > 0}><Empty>No resort matches this search.</Empty></div>
    </div>
  ))
})

contactRoutes.get('/admin/contacts/export.csv', requirePerm('view_property_contacts'), async (c) => {
  const shown = filterFor(str(c.req.query('location'), 80), str(c.req.query('q'), 80))
  const rows = (await loadContacts(c)).filter(shown).map(({ p, con }) => ({
    Resort: p.name,
    Location: p.destination,
    'Stay type': stayTypeLabel(p),
    Status: p.status === 'hidden' ? 'disabled' : p.status,
    'Contact person': con.person ?? '',
    Email: con.email ?? '',
    'Email 2': con.email2 ?? '',
    Phone: con.phone ?? '',
    'Phone 2': con.phone2 ?? '',
    'Phone 3': con.phone3 ?? '',
    'More contacts': (con.others ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join('; '),
    Address: p.address ?? '',
  }))
  const columns = ['Resort', 'Location', 'Stay type', 'Status', 'Contact person', 'Email', 'Email 2', 'Phone', 'Phone 2', 'Phone 3', 'More contacts', 'Address']
  await logActivity(c.env, c.get('user')!.id, 'contacts.exported', 'property', null, { count: rows.length })
  return new Response('\uFEFF' + toCsv(rows, columns), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="resort-contacts-${todayIST()}.csv"` } })
})

const DEFAULT_MESSAGE = 'Dear {person},\n\n\n\nRegards,\n'

async function composePage(c: Context<AppEnv>, items: Item[], picked: Set<number>, draft: { subject: string; message: string }, note?: { ok?: string; err?: string }) {
  const s = await getSettings(c.env)
  const connected = !!(await resendKey(c.env))
  const reachable = items.filter((i) => emailsOf(i.con).length)
  const noEmail = items.filter((i) => !emailsOf(i.con).length)
  return page(c, { title: 'Email resorts', area: 'admin', active: 'contacts' }, (
    <form method="post" action="/admin/contacts/email" class="stack-lg">
      <div class="row-between">
        <h1>Email resorts</h1>
        <a class="small" href="/admin/contacts">← Resort contacts</a>
      </div>
      {note?.ok && <div class="flash flash-ok" role="status">{note.ok}</div>}
      {note?.err && <div class="flash flash-err" role="alert">{note.err}</div>}
      {!connected && <p class="flash flash-err">Resend is not connected — emails will only be logged, not delivered. Add the API key in <a href="/admin/settings#email">Settings → Email</a>.</p>}
      <section class="card stack">
        <p class="small muted">From <strong>{s.email.from}</strong>{s.email.reply_to && <> · replies go to <strong>{s.email.reply_to}</strong></>}. Each resort gets its own email; resorts never see each other's addresses.</p>
        <Field label="Subject" hint="Placeholders work here too: {resort} {person} {location}"><input name="subject" required maxlength={200} value={draft.subject} /></Field>
        <Field label="Message" hint="{resort} = resort name, {person} = contact person (or “Sir/Madam”), {location} = location"><textarea name="message" rows={12} required maxlength={20000}>{draft.message || DEFAULT_MESSAGE}</textarea></Field>
      </section>
      <section class="card stack">
        <h2>Recipients ({reachable.filter((i) => picked.has(i.p.id)).length} selected)</h2>
        {reachable.length ? (
          <div class="facility-grid">{reachable.map((i) => (
            <label class="check"><input type="checkbox" name="ids" value={i.p.id} checked={picked.has(i.p.id)} /> <span><strong>{i.p.name}</strong> <span class="muted small">{i.p.destination} · {emailsOf(i.con).join(', ')}</span></span></label>
          ))}</div>
        ) : <Empty>None of these resorts has an email address saved.</Empty>}
        {noEmail.length > 0 && <p class="small muted">Skipped (no email saved): {noEmail.map((i) => i.p.name).join(', ')}</p>}
      </section>
      <div class="sticky-actions row wrap-row">
        <button class="btn" name="action" value="send" data-confirm="Send this email to the selected resorts?">Send email</button>
        <button class="btn btn-outline" name="action" value="test">Send me a test first</button>
      </div>
    </form>
  ))
}

contactRoutes.get('/admin/contacts/email', requirePerm('view_property_contacts'), async (c) => {
  const items = await loadContacts(c)
  let chosen: Item[]
  if (c.req.query('all')) chosen = items.filter(filterFor(str(c.req.query('location'), 80), str(c.req.query('q'), 80)))
  else {
    const ids = new Set(c.req.queries('ids')?.map((v) => int(v)).filter(Boolean) ?? [])
    chosen = items.filter((i) => ids.has(i.p.id))
  }
  if (!chosen.length) return c.redirect('/admin/contacts?err=' + encodeURIComponent('Select at least one resort to email.'), 303)
  return composePage(c, chosen, new Set(chosen.map((i) => i.p.id)), { subject: '', message: '' })
})

contactRoutes.post('/admin/contacts/email', requirePerm('view_property_contacts'), async (c) => {
  const f = await form(c)
  const user = c.get('user')!
  const subject = str(f.subject, 200).trim()
  const message = str(f.message, 20000).trim()
  const ids = new Set((f.__all.ids ?? []).map((v) => int(v)).filter(Boolean))
  const items = await loadContacts(c)
  const picked = items.filter((i) => ids.has(i.p.id) && emailsOf(i.con).length)
  const again = (note: { ok?: string; err?: string }) => composePage(c, items.filter((i) => ids.has(i.p.id)), ids, { subject, message }, note)
  if (!subject || !message) return again({ err: 'Add a subject and a message.' })
  if (!picked.length) return again({ err: 'Select at least one resort with an email address.' })
  const done = (r: SendReport, what: string) => (r.dryRun ? ' (Resend is not connected, so it was only logged.)' : r.failed ? ` ${r.failed} ${what} failed: ${r.errors.join('; ').slice(0, 200)}` : '')

  if (f.action === 'test') {
    const to = (user.email ?? '').trim()
    if (!EMAIL_RE.test(to)) return again({ err: 'Your staff account has no email address to send a test to.' })
    const sample = resortEmail(picked[0], subject, message)
    const r = await sendEmails(c.env, [{ ...sample, to: [to], subject: `[Test] ${sample.subject}` }])
    return again(r.sent ? { ok: `Test sent to ${to} (filled in for ${picked[0].p.name}).${done(r, 'email')}` } : { err: `Test email failed: ${r.errors.join('; ').slice(0, 200)}` })
  }

  const r = await sendEmails(c.env, picked.map((i) => resortEmail(i, subject, message)))
  await logActivity(c.env, user.id, 'contacts.emailed', 'property', picked.length === 1 ? picked[0].p.id : null, { subject, sent: r.sent, failed: r.failed, resorts: picked.map((i) => i.p.id) })
  if (!r.sent) return again({ err: `Email not sent: ${r.errors.join('; ').slice(0, 200)}` })
  const u = new URLSearchParams({ ok: `Email sent to ${r.sent} resort${r.sent === 1 ? '' : 's'}.${done(r, 'more')}`.slice(0, 200) })
  return c.redirect(`/admin/contacts?${u}`, 303)
})
