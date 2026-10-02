import { describe, expect, it } from 'vitest'
import { guardSql } from '../src/lib/sqlguard'

describe('Ask AI SQL guard', () => {
  it('allows read-only selects and adds a row limit', () => {
    const r = guardSql("SELECT p.name, SUM(b.total) AS revenue FROM bookings b JOIN properties p ON p.id = b.property_id WHERE b.status = 'confirmed' GROUP BY p.id ORDER BY revenue DESC;")
    expect(r.ok).toBe(true)
    expect(r.sql).toMatch(/LIMIT 200$/)
  })
  it('allows CTEs over allowed tables', () => {
    expect(guardSql('WITH t AS (SELECT staff_id, COUNT(*) n FROM bookings GROUP BY staff_id) SELECT p.name, t.n FROM t JOIN people p ON p.id = t.staff_id').ok).toBe(true)
  })
  it.each([
    ['DELETE FROM bookings'],
    ['SELECT 1; DROP TABLE users'],
    ['SELECT * FROM users'],
    ['SELECT password_hash FROM people'],
    ['SELECT * FROM sqlite_master'],
    ['SELECT * FROM settings'],
    ['SELECT token FROM quotes'],
    ['SELECT * FROM bookings, users'],
    ['SELECT * FROM "users"'],
    ['PRAGMA table_info(users)'],
    ['SELECT * FROM bookings WHERE id IN (SELECT id FROM activity_log)'],
  ])('blocks %s', (sql) => expect(guardSql(sql).ok).toBe(false))
  it('is not fooled by keywords inside strings or comments', () => {
    expect(guardSql("SELECT guest_name FROM bookings WHERE guest_name = 'drop table'").ok).toBe(true)
    expect(guardSql('SELECT 1 FROM bookings -- ; DELETE FROM bookings').ok).toBe(true)
  })
})
