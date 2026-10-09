// Several room categories in one quotation option / booking (e.g. 4 Standard Non-AC + 2 Standard AC).
// The first category is the row's own room_id / rooms_count; the others are kept in `extra_rooms` (JSON).

import type { Env } from '../env'
import { all, placeholders } from './db'
import { parseJson } from './util'

export interface ExtraRoom {
  room_id: number
  rooms_count: number
  /** Staff selling price per room per night for this category; null = website rate. */
  guest_rate: number | null
}

/** Clean list from the stored JSON (or an already-parsed list). */
export function extraRoomsOf(v: string | ExtraRoom[] | null | undefined): ExtraRoom[] {
  const list = Array.isArray(v) ? v : parseJson<ExtraRoom[]>(v, [])
  return (Array.isArray(list) ? list : [])
    .map((x) => ({ room_id: Math.trunc(Number(x?.room_id)), rooms_count: Math.trunc(Number(x?.rooms_count)), guest_rate: Number(x?.guest_rate) > 0 ? Math.trunc(Number(x.guest_rate)) : null }))
    .filter((x) => x.room_id > 0 && x.rooms_count > 0)
}

/** All room lines of an option or booking, the first category first. */
export function roomLines(o: { room_id: number; rooms_count: number; guest_rate?: number | null; extra_rooms?: string | ExtraRoom[] | null }): ExtraRoom[] {
  return [{ room_id: o.room_id, rooms_count: o.rooms_count, guest_rate: o.guest_rate ?? null }, ...extraRoomsOf(o.extra_rooms)]
}

/** Rooms across every category. */
export const totalRooms = (o: Parameters<typeof roomLines>[0]) => roomLines(o).reduce((a, x) => a + x.rooms_count, 0)

/** Room names by id for the given options / bookings (first and extra categories). */
export async function roomNames(env: Env, rows: Parameters<typeof roomLines>[0][]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.flatMap((o) => roomLines(o).map((x) => x.room_id)))]
  if (!ids.length) return new Map()
  const found = await all<{ id: number; name: string }>(env, `SELECT id, name FROM rooms WHERE id IN (${placeholders(ids.length)})`, ...ids)
  return new Map(found.map((r) => [r.id, r.name]))
}

/** "Standard Non-AC × 4 + Standard AC × 2". */
export function roomsLabel(o: Parameters<typeof roomLines>[0], names: Map<number, string>): string {
  return roomLines(o).map((x) => `${names.get(x.room_id) ?? 'Room'} × ${x.rooms_count}`).join(' + ')
}
