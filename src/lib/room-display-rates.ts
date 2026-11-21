// Rates shown in a property page's room list, read from the same season rates the Room Rates wizard saves.
import { nightlyRate, staffRateForStay, type RoomRates, type SeasonRate } from './pricing'
import { addDays } from './util'

export interface DisplayRate {
  /** Guest (Direct) rate per night; null when no Direct rate is set ("personalised offer"). */
  direct: number | null
  /** true when there is no Direct rate tonight and `direct` is the lowest upcoming rate ("from ₹X"). */
  from: boolean
  /** Internal staff rate for tonight (only for logged-in staff views). */
  staff: number | null
}

/** Tonight's Direct rate, else the lowest Direct rate in the next two weeks of each upcoming season. */
export function displayRate(room: RoomRates, seasons: SeasonRate[], today: string): DisplayRate {
  const staff = staffRateForStay(room, seasons, today, addDays(today, 1))
  const tonight = nightlyRate(room, seasons, today).rate
  if (tonight > 0) return { direct: tonight, from: false, staff }
  let best = 0
  const upcoming = seasons.filter((s) => (s.room_id == null || s.room_id === room.id) && s.supplement == null && s.end_date >= today)
  for (const s of upcoming.slice(0, 40)) {
    let d = s.start_date > today ? s.start_date : today
    // Two weeks covers weekday/weekend and "every Saturday" style periods.
    for (let i = 0; i < 14 && d <= s.end_date; i++, d = addDays(d, 1)) {
      const r = nightlyRate(room, seasons, d).rate
      if (r > 0 && (!best || r < best)) best = r
    }
  }
  return { direct: best || null, from: best > 0, staff }
}
