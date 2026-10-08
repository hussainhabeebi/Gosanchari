// Admin → Resort contacts: look up a resort's contact person, numbers and email by location and name.
// Admin side only (needs "See property contact details", which only admins have by default) — never in the staff area.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Select } from '../views/components'
import { requirePerm } from '../lib/auth'
import { all } from '../lib/db'
import { contact as readContact, stayTypeLabel, type Contact } from '../lib/catalog'
import { str } from '../lib/util'

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

contactRoutes.get('/admin/contacts', requirePerm('view_property_contacts'), async (c) => {
  const q = str(c.req.query('q'), 80)
  const loc = str(c.req.query('location'), 80)
  const rows = await all<ContactRow>(c.env, 'SELECT id, name, destination, address, map_url, status, type, stay_type, contact, owner_name, owner_phone, owner_email FROM properties ORDER BY destination, name')
  const items = rows.map((p) => {
    const con = contactOf(p)
    return { p, con, text: searchText(p, con) }
  })
  // The page holds every resort and filters as you type; the same filter runs here so links with ?q= work without JavaScript.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (i: (typeof items)[number]) => (!loc || i.p.destination === loc) && words.every((w) => i.text.includes(w) || (!!w.replace(/\D/g, '') && i.text.includes(w.replace(/\D/g, ''))))
  const visible = items.filter(shown).length
  const locations = [...new Set(rows.map((r) => r.destination))].filter(Boolean).sort()
  return page(c, { title: 'Resort contacts', area: 'admin', active: 'contacts' }, (
    <div class="stack-lg" data-contact-finder>
      <div class="row-between">
        <h1>Resort contacts</h1>
        <span class="muted small" data-contact-count>{visible} of {items.length} resorts</span>
      </div>
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
                <div><strong>{p.name}</strong><div class="muted small">{p.destination} · {stayTypeLabel(p)}</div></div>
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
