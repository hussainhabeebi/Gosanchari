// Admin → property → Tariff: import a B2B rate sheet (PDF / Word). AI reads it, management reviews every figure on
// one screen (room mapping, net / staff / guest rates, seasons), and only then are the rates saved.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { AiNote, Select } from '../views/components'
import { permissionsFor, requirePerm } from '../lib/auth'
import { all, first, insertId, logActivity, placeholders, run } from '../lib/db'
import { aiJsonFromDocument } from '../lib/docs'
import { markup, matchRoom, normalizeRateSheet, rateSheetPrompt, type RateSheet } from '../lib/ratesheet'
import { SEASON_KINDS } from '../lib/pricing'
import type { PropertyRow, RoomRow } from '../lib/types'
import { fmtDate, int, isDate, str } from '../lib/util'
import { form, redirectMsg } from './helpers'
import { afterPropertySave } from './admin-properties'

export const rateSheetRoutes = new Hono<AppEnv>()

async function management(c: Context<AppEnv>) {
  return (await permissionsFor(c.env, c.get('user')!.role)).view_net_rates
}

const sheetKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

rateSheetRoutes.post('/admin/properties/:id/ratesheet', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  if (!(await management(c))) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Only management can import B2B rate sheets.' })
  const p = await first<PropertyRow>(c.env, 'SELECT * FROM properties WHERE id = ?', id)
  if (!p) return c.notFound()
  const body = await c.req.parseBody()
  const file = body.sheet
  if (!(file instanceof File) || !file.size) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: 'Please choose a PDF or Word file.' })
  const staffPct = Math.max(0, Math.min(300, parseFloat(String(body.staff_markup ?? '15')) || 0))
  const guestPct = Math.max(0, Math.min(500, parseFloat(String(body.guest_markup ?? '35')) || 0))
  const res = await aiJsonFromDocument<unknown>(c.env, 'rate_sheet', { name: file.name, type: file.type, data: await file.arrayBuffer() }, (notes) => rateSheetPrompt(notes), { size: 'large', maxTokens: 3500 })
  if (!res.data) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: res.error ?? 'Could not read the rate sheet.' })
  const sheet = normalizeRateSheet(res.data)
  if (!sheet.rooms.length) return redirectMsg(c, `/admin/properties/${id}#ratesheet`, { err: 'No room rates were found in this file.' })
  await logActivity(c.env, c.get('user')!.id, 'ratesheet.read', 'property', id, { file: file.name, rooms: sheet.rooms.length, seasons: sheet.seasons.length })
  const rooms = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ? ORDER BY base_rate', id)
  return reviewPage(c, p, rooms, sheet, file.name, staffPct, guestPct)
})

function reviewPage(c: Context<AppEnv>, p: PropertyRow, rooms: RoomRow[], sheet: RateSheet, fileName: string, staffPct: number, guestPct: number) {
  const mapOpts: [string, string][] = [['new', '+ Create as new room category'], ['skip', 'Skip'], ...rooms.map((r) => [String(r.id), `Update: ${r.name}`] as [string, string])]
  const idxOf = (name: string) => sheet.rooms.findIndex((r) => sheetKey(r.name) === sheetKey(name))
  return page(c, { title: `Review rate sheet · ${p.name}`, area: 'admin', active: 'properties' }, (
    <form method="post" action={`/admin/properties/${p.id}/ratesheet/apply`} class="stack-lg">
      <a href={`/admin/properties/${p.id}#tariff`} class="small">← {p.name}</a>
      <h1>Review rate sheet</h1>
      <AiNote label={`Read from ${fileName}`}>
        Check every figure before saving — nothing is saved yet. Staff rates are net + {staffPct}% and guest rates net + {guestPct}%, rounded to ₹50; change any of them below.
        {sheet.meal_plan && <> Rates include: <strong>{sheet.meal_plan}</strong>.</>}
        {(sheet.valid_from || sheet.valid_to) && <> Valid {sheet.valid_from ? fmtDate(sheet.valid_from) : '…'} – {sheet.valid_to ? fmtDate(sheet.valid_to) : '…'}.</>}
      </AiNote>
      {sheet.notes && <div class="card small"><strong>Other terms on the sheet:</strong> {sheet.notes}</div>}

      <section class="card stack">
        <h2>Room categories — regular rates</h2>
        <input type="hidden" name="rooms_n" value={sheet.rooms.length} />
        <div class="table-wrap">
          <table class="table review-table">
            <thead><tr><th>On the sheet</th><th>Save as</th><th class="internal">B2B / Net ₹</th><th>Staff rate ₹</th><th>Guest rate ₹ (weekdays)</th><th>Guest ₹ (Fri/Sat)</th><th>Guests incl.</th><th>Max guests</th><th>Extra adult ₹/night (guest)</th></tr></thead>
            <tbody>
              {sheet.rooms.map((r, i) => {
                const match = matchRoom(r.name, rooms)
                return (
                  <tr>
                    <td><input name={`r${i}_name`} value={r.name} maxlength={80} />{r.notes && <div class="muted small">{r.notes}</div>}</td>
                    <td><Select name={`r${i}_map`} value={match ? String(match) : 'new'} options={mapOpts} /></td>
                    <td class="internal"><input type="number" name={`r${i}_net`} value={r.net_rate ?? ''} min="0" /></td>
                    <td><input type="number" name={`r${i}_staff`} value={markup(r.net_rate, staffPct) ?? ''} min="0" /></td>
                    <td><input type="number" name={`r${i}_guest`} value={markup(r.net_rate, guestPct) ?? ''} min="0" /></td>
                    <td><input type="number" name={`r${i}_wknd`} value={markup(r.net_weekend_rate, guestPct) ?? ''} min="0" /></td>
                    <td><input type="number" name={`r${i}_base`} value={r.base_guests ?? ''} min="1" max="60" /></td>
                    <td><input type="number" name={`r${i}_cap`} value={r.capacity ?? ''} min="1" max="60" /></td>
                    <td><input type="number" name={`r${i}_xbed`} value={markup(r.extra_bed_rate, guestPct) ?? ''} min="0" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p class="muted small">Blank boxes keep the room's current value. A new room category needs a guest rate.</p>
      </section>

      <section class="card stack">
        <h2>Seasons, off-season & special dates</h2>
        <input type="hidden" name="seasons_n" value={sheet.seasons.length} />
        {sheet.seasons.length === 0 && <p class="muted">No seasons found on the sheet.</p>}
        {sheet.seasons.map((s, j) => (
          <div class="season-edit stack">
            <div class="row wrap-row">
              <label class="check"><input type="checkbox" name={`s${j}_on`} value="1" checked /> Save</label>
              <input name={`s${j}_name`} value={s.name} maxlength={60} aria-label="Season name" />
              <Select name={`s${j}_kind`} value={s.kind} options={Object.entries(SEASON_KINDS)} />
              <input type="date" name={`s${j}_start`} value={s.start_date} aria-label="From" />
              <input type="date" name={`s${j}_end`} value={s.end_date} aria-label="To (last night)" />
              <input type="number" name={`s${j}_min`} value={s.min_nights ?? ''} min="1" placeholder="Min nights" class="w-sm" />
            </div>
            <div class="table-wrap">
              <table class="table review-table">
                <thead><tr><th>Room (from the sheet)</th><th class="internal">B2B / Net ₹</th><th>Staff rate ₹</th><th>Guest rate ₹</th></tr></thead>
                <tbody>
                  {Object.entries(s.rates).map(([name, net]) => {
                    const i = idxOf(name)
                    if (i < 0) return null
                    return (
                      <tr>
                        <td>{name}</td>
                        <td class="internal"><input type="number" name={`s${j}_r${i}_net`} value={net} min="0" /></td>
                        <td><input type="number" name={`s${j}_r${i}_staff`} value={markup(net, staffPct) ?? ''} min="0" /></td>
                        <td><input type="number" name={`s${j}_r${i}_guest`} value={markup(net, guestPct) ?? ''} min="0" /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <p class="muted small">Saving a season replaces any existing season with the same name and dates for these rooms.</p>
      </section>

      <div class="row wrap-row sticky-actions">
        <button class="btn">Save these rates</button>
        <a class="btn btn-outline" href={`/admin/properties/${p.id}#tariff`}>Cancel</a>
      </div>
    </form>
  ))
}

rateSheetRoutes.post('/admin/properties/:id/ratesheet/apply', requirePerm('manage_properties'), async (c) => {
  const id = int(c.req.param('id'))
  if (!(await management(c))) return redirectMsg(c, `/admin/properties/${id}#tariff`, { err: 'Only management can import B2B rate sheets.' })
  if (!(await first(c.env, 'SELECT 1 FROM properties WHERE id = ?', id))) return c.notFound()
  const f = await form(c)
  const u = c.get('user')!
  const existing = await all<RoomRow>(c.env, 'SELECT * FROM rooms WHERE property_id = ?', id)
  const roomIdx = new Map<number, number>()
  const pos = (k: string) => (int(f[k]) > 0 ? int(f[k]) : null)
  let created = 0
  let updated = 0
  for (let i = 0; i < Math.min(30, int(f.rooms_n)); i++) {
    const map = f[`r${i}_map`]
    if (!map || map === 'skip') continue
    const net = pos(`r${i}_net`), staff = pos(`r${i}_staff`), guest = pos(`r${i}_guest`), wknd = pos(`r${i}_wknd`), cap = pos(`r${i}_cap`), xbed = pos(`r${i}_xbed`), base = pos(`r${i}_base`)
    if (map === 'new') {
      const name = str(f[`r${i}_name`], 80)
      if (!name || !guest) continue
      const rid = await insertId(
        c.env,
        'INSERT INTO rooms (property_id, name, capacity, base_guests, units, base_rate, weekend_rate, net_rate, staff_rate, extra_bed, extra_bed_rate, extra_adult_rate) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
        id, name, Math.max(cap ?? 2, base ?? 0), base ?? cap ?? 2, guest, wknd, net, staff, xbed ? 1 : 0, xbed, xbed,
      )
      roomIdx.set(i, rid)
      created++
    } else {
      const r = existing.find((x) => x.id === int(map))
      if (!r) continue
      const set: Record<string, number> = {}
      if (net) set.net_rate = net
      if (staff) set.staff_rate = staff
      if (guest) set.base_rate = guest
      if (wknd) set.weekend_rate = wknd
      if (cap) set.capacity = Math.max(cap, base ?? 0)
      if (base) set.base_guests = base
      if (xbed) { set.extra_adult_rate = xbed; set.extra_bed_rate = xbed; set.extra_bed = 1 }
      const cols = Object.keys(set)
      if (cols.length) {
        await run(c.env, `UPDATE rooms SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), r.id)
        await logActivity(c.env, u.id, 'price.changed', 'room', r.id, { from: { guest: r.base_rate, weekend: r.weekend_rate, staff: r.staff_rate, net: r.net_rate }, to: set, source: 'rate sheet' })
        updated++
      }
      roomIdx.set(i, r.id)
    }
  }
  let seasons = 0
  const stmts: D1PreparedStatement[] = []
  for (let j = 0; j < Math.min(30, int(f.seasons_n)); j++) {
    if (!f[`s${j}_on`]) continue
    const name = str(f[`s${j}_name`], 60)
    const start = f[`s${j}_start`], end = f[`s${j}_end`]
    if (!name || !isDate(start) || !isDate(end) || end < start) continue
    const kind = f[`s${j}_kind`] in SEASON_KINDS ? f[`s${j}_kind`] : 'season'
    const minNights = pos(`s${j}_min`)
    const rows: [number, number, number | null, number | null][] = []
    for (const [i, rid] of roomIdx) {
      const guest = pos(`s${j}_r${i}_guest`)
      if (guest) rows.push([rid, guest, pos(`s${j}_r${i}_staff`), pos(`s${j}_r${i}_net`)])
    }
    if (!rows.length) continue
    const ids = rows.map((r) => r[0])
    stmts.push(c.env.DB.prepare(`DELETE FROM season_rates WHERE property_id = ? AND name = ? AND start_date = ? AND end_date = ? AND room_id IN (${placeholders(ids.length)})`).bind(id, name, start, end, ...ids))
    for (const [rid, guest, staff, net] of rows) {
      stmts.push(c.env.DB.prepare('INSERT INTO season_rates (property_id, room_id, name, start_date, end_date, rate, min_nights, created_by, kind, staff_rate, net_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, rid, name, start, end, guest, minNights, u.id, kind, staff, net))
    }
    seasons++
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  await afterPropertySave(c, id)
  await logActivity(c.env, u.id, 'ratesheet.applied', 'property', id, { created, updated, seasons })
  return redirectMsg(c, `/admin/properties/${id}#tariff`, { ok: `Rate sheet saved: ${created} new room categor${created === 1 ? 'y' : 'ies'}, ${updated} updated, ${seasons} season${seasons === 1 ? '' : 's'}.` })
})
