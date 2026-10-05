// Keep catalogue records out of legacy price/import editors. Other properties retain their existing paths.
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { first } from '../lib/db'
import { int } from '../lib/util'

export const catalogueLegacyGuard: MiddlewareHandler<AppEnv> = async (c,next) => {
  const path=c.req.path
  if(c.req.method!=='POST'||path.startsWith('/staff/catalogue/'))return next()
  const propertyMatch=path.match(/^\/admin\/properties\/(\d+)(?:\/(.*))?$/)
  if(propertyMatch){
    const p=await first<{catalogue_only:number}>(c.env,'SELECT catalogue_only FROM properties WHERE id=?',int(propertyMatch[1]))
    if(p?.catalogue_only){
      if(propertyMatch[2]==='status') {
        if(c.get('user')?.role!=='admin')return c.text('Admin only',403)
        return next()
      }
      return c.text('Use the catalogue editor for this property; automatic imports and legacy pricing are disabled.',409)
    }
  }
  const roomMatch=path.match(/^\/admin\/rooms\/(\d+)$/)
  if(roomMatch){
    const p=await first(c.env,'SELECT p.id FROM rooms r JOIN properties p ON p.id=r.property_id WHERE r.id=? AND p.catalogue_only=1',int(roomMatch[1]))
    if(p)return c.text('Use the catalogue room editor for this property.',409)
  }
  const photoMatch=path.match(/^\/admin\/photos\/(\d+)$/)
  if(photoMatch){
    const p=await first(c.env,'SELECT p.id FROM property_photos ph JOIN properties p ON p.id=ph.property_id WHERE ph.id=? AND p.catalogue_only=1',int(photoMatch[1]))
    if(p)return c.text('Use the catalogue photo editor for this property.',409)
  }
  if(path.startsWith('/admin/rates/')||path.startsWith('/staff/quotes/')){
    const raw=c.req.raw.clone()
    let values:Record<string,unknown>={}
    if(raw.headers.get('content-type')?.includes('application/json')) values=await raw.json().catch(()=>({})) as Record<string,unknown>
    else values=Object.fromEntries(await raw.formData().catch(()=>new FormData()))
    const scope=String(values.scope??'')
    const pid=int(String(values.property_id??values.property??(scope.startsWith('p')?scope.slice(1):'')))
    const rid=int(String(values.room_id??values.room??(scope.startsWith('r')?scope.slice(1):'')))
    const p=await first(c.env,'SELECT id FROM properties WHERE catalogue_only=1 AND (id=? OR id=(SELECT property_id FROM rooms WHERE id=?))',pid,rid)
    if(p)return c.text('This property is a catalogue only; use its catalogue editor to manage supplied rates.',409)
  }
  return next()
}
