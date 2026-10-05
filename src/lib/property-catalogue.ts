// Catalogue-only pricing. Never pass these rates to the booking/quote price engine.
import type { Env } from '../env'
import type { Role } from './permissions'
import { all, first } from './db'

export const catalogueStaff = (role?: Role | null) => role === 'admin' || role === 'manager' || role === 'sales'
export const catalogueAdmin = (role?: Role | null) => role === 'admin'
export interface CatalogueProperty {
  id: number; slug: string; name: string; destination: string; status: string; catalogue_only: number
  description: string; classification: string | null; facilities: string; highlights: string
  address: string | null; lat: number | null; lng: number | null
  checkin_time: string | null; checkout_time: string | null; cancellation_policy: string; policies: string
}
export interface CatalogueRoom {
  id: number; property_id: number; name: string; units: number; capacity: number | null
  base_guests: number | null; bed_type: string | null; size_sqft: number | null; room_view: string | null
  description: string; facilities: string; rack_rate: number; rack_basis: string | null
}
export interface CataloguePeriod {
  id: number; room_id: number; start_date: string; end_date: string
  staff_rate?: number | null; staff_basis?: string | null; net_rate?: number | null; net_basis?: string | null
}
export interface PropertyCharge {
  id: number; charge_key: string; name: string; amount: number; child_amount: number | null
  basis: string | null; rate_basis: string | null; start_date: string | null; end_date: string | null
  mandatory: number; options: string; notes: string
}
export async function catalogueProperty(env: Env, id: number) {
  return first<CatalogueProperty>(env, `SELECT id,slug,name,destination,status,catalogue_only,description,
    classification,facilities,highlights,address,lat,lng,checkin_time,checkout_time,cancellation_policy,policies
    FROM properties WHERE id = ? AND catalogue_only = 1`, id)
}
export async function loadCatalogue(env: Env, id: number, role: Role | null = null) {
  const property = await catalogueProperty(env, id)
  if (!property) return null
  const rooms = await all<CatalogueRoom>(env, `SELECT id,property_id,name,units,capacity,base_guests,bed_type,
    size_sqft,room_view,description,facilities,rack_rate,rack_basis FROM rooms
    WHERE property_id = ? AND active = 1 ORDER BY id`, id)
  // Public SQL does not select or return either internal tier. Permission overrides cannot broaden this.
  const periods = catalogueStaff(role) ? await all<CataloguePeriod>(env, `SELECT t.id,t.room_id,t.start_date,t.end_date,
    t.staff_rate,t.staff_basis${catalogueAdmin(role) ? ',t.net_rate,t.net_basis' : ''}
    FROM catalogue_rate_periods t JOIN rooms r ON r.id=t.room_id WHERE r.property_id = ? ORDER BY t.start_date,t.room_id`, id) : []
  const charges = await all<PropertyCharge>(env, `SELECT id,charge_key,name,amount,child_amount,basis,rate_basis,
    start_date,end_date,mandatory,options,notes FROM property_charges WHERE property_id = ? ORDER BY id`, id)
  return { property, rooms, periods, charges }
}
export type Catalogue = NonNullable<Awaited<ReturnType<typeof loadCatalogue>>>
export function catalogueRate(periods: CataloguePeriod[], roomId: number, date: string, tier: 'staff' | 'net'): number | null {
  const period = periods.find((p) => p.room_id === roomId && p.start_date <= date && date <= p.end_date)
  return period?.[tier === 'staff' ? 'staff_rate' : 'net_rate'] ?? null
}
export function chargesOn(charges: PropertyCharge[], date: string) {
  return charges.filter((c) => !c.start_date || (c.start_date <= date && date <= c.end_date!))
}
export function catalogueDocument(c: Catalogue) {
  const p = c.property
  return `# ${p.name}\n${p.classification ?? ''}\n${p.destination}\n${p.description}\n` +
    c.rooms.map((r) => `${r.name}: ${r.units} rooms${r.capacity == null ? '' : `; ${r.capacity} Pax`}; Rack ₹${r.rack_rate} ${r.rack_basis ?? ''}`).join('\n') +
    '\nFacilities: ' + p.facilities + '\nAdditional charges: ' + JSON.stringify(c.charges) +
    '\nPolicies: ' + p.policies + '\nCancellation policy:\n' + p.cancellation_policy
}
