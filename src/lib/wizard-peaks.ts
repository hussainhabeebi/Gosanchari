import type { SeasonRate } from './pricing'
import { commonPeakKey, overridePeakKey } from './pricing'
import { isDate } from './util'

type Row = SeasonRate & { id: number }
type Fields = { __all: Record<string, string[]> }
const validKey = (key: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)

/** Only explicit managed rows are mutated. Legacy rates and absent form collections are untouched. */
export function peakStatements(db: D1Database, propertyId: number, userId: number, roomIds: number[], old: Row[], fields: Fields): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  const commons = new Map(old.filter(s => commonPeakKey(s)).map(s => [commonPeakKey(s)!, s]))
  const seen = new Set<string>()
  const deleted = new Set<number>()
  const read = (prefix: string) => (fields.__all[`${prefix}_managed_id`] ?? []).map((id, i) => {
    const get = (field: string) => fields.__all[`${prefix}_managed_${field}`]?.[i] ?? ''
    return { id: Number(id), key: get('key'), remove: get('remove') === '1', from: get('from'), to: get('to'), amount: get('amt'), name: get('desc').trim().slice(0, 60) || 'Peak time' }
  })
  const write = (draft: ReturnType<typeof read>[number], roomId: number | null, from: string, to: string) => {
    const source = `${roomId == null ? 'wizard-common:' : 'wizard-override:'}${draft.key}`
    const existing = draft.id ? old.find(s => s.id === draft.id && s.property_id === propertyId && s.room_id === roomId && s.source === source && s.kind === 'special') : old.find(s => !deleted.has(s.id) && s.property_id === propertyId && s.room_id === roomId && s.source === source)
    if (draft.id && !existing) throw new Error('Peak charge ownership changed. Reopen Step 3 before saving.')
    if (draft.remove) {
      if (existing) { deleted.add(existing.id); statements.push(db.prepare('DELETE FROM season_rates WHERE id=? AND property_id=? AND source=?').bind(existing.id, propertyId, source)) }
      return
    }
    const amount = Number(draft.amount)
    if (!validKey(draft.key) || !isDate(from) || !isDate(to) || to < from || draft.amount === '' || !Number.isFinite(amount) || amount < 0) throw new Error('Complete the peak dates, association and non-negative charge before saving.')
    const identity = `${roomId}:${draft.key}`
    if (seen.has(identity)) throw new Error('Each room can have only one override for a common peak charge.')
    seen.add(identity)
    if (existing) statements.push(db.prepare('UPDATE season_rates SET name=?,start_date=?,end_date=?,supplement=? WHERE id=? AND property_id=? AND source=?').bind(draft.name, from, to, amount, existing.id, propertyId, source))
    else statements.push(db.prepare("INSERT INTO season_rates(property_id,room_id,name,start_date,end_date,supplement,kind,source,created_by) SELECT ?,?,?,?,?,?,'special',?,? WHERE NOT EXISTS (SELECT 1 FROM season_rates WHERE property_id=? AND room_id IS ? AND source=?)").bind(propertyId, roomId, draft.name, from, to, amount, source, userId, propertyId, roomId, source))
  }
  for (const draft of read('common')) {
    if (!draft.id && !draft.amount && !draft.from && !draft.to && draft.name === 'Peak time') continue
    write(draft, null, draft.from, draft.to)
    if (draft.remove) {
      commons.delete(draft.key)
      // Explicit common removal also removes only its new managed overrides.
      for (const override of old.filter(s => overridePeakKey(s) === draft.key)) statements.push(db.prepare('DELETE FROM season_rates WHERE id=? AND property_id=? AND source=?').bind(override.id, propertyId, override.source!))
    } else commons.set(draft.key, { property_id: propertyId, room_id: null, name: draft.name, start_date: draft.from, end_date: draft.to } as Row)
  }
  for (const roomId of roomIds) for (const draft of read(`r${roomId}`)) {
    if (!draft.id && !draft.key && !draft.amount && draft.name === 'Peak time') continue
    // A blank per-category charge means "use the common charge": drop any saved override.
    if (draft.amount.trim() === '') draft.remove = true
    // A new peak row left blank for this category has nothing to save.
    if (draft.remove && !draft.id && !commons.has(draft.key)) continue
    const common = commons.get(draft.key)
    // An override of an explicitly removed common is removed with its parent.
    if (!common && read('common').some(s => s.key === draft.key && s.remove)) continue
    if (!common) throw new Error('Select an existing common peak charge for this override.')
    // Overrides carry the peak's own description unless one was given.
    write({ ...draft, name: draft.name === 'Peak time' ? common.name : draft.name }, roomId, common.start_date, common.end_date)
  }
  // Keep override periods in sync when the common period is edited, even for omitted room forms.
  for (const row of old) {
    const key = overridePeakKey(row), common = key ? commons.get(key) : null
    if (common && !deleted.has(row.id) && (row.start_date !== common.start_date || row.end_date !== common.end_date) && !seen.has(`${row.room_id}:${key}`)) statements.push(db.prepare('UPDATE season_rates SET start_date=?,end_date=? WHERE id=? AND property_id=? AND source=?').bind(common.start_date, common.end_date, row.id, propertyId, row.source!))
  }
  return statements
}
