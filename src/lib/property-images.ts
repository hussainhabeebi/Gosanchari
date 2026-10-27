/** Browser-displayable property photos. Never accept active SVG/HTML by filename. */
export const PROPERTY_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp,image/apng,.jpg,.jpeg,.jfif,.png,.webp,.avif,.gif,.bmp,.apng'
export const PROPERTY_IMAGE_FORMATS = 'JPG, PNG, WebP, AVIF, GIF, BMP or APNG'

const types: Record<string, { contentType: string; extension: string }> = {
  'image/jpeg': { contentType: 'image/jpeg', extension: 'jpg' },
  'image/png': { contentType: 'image/png', extension: 'png' },
  'image/webp': { contentType: 'image/webp', extension: 'webp' },
  'image/avif': { contentType: 'image/avif', extension: 'avif' },
  'image/gif': { contentType: 'image/gif', extension: 'gif' },
  'image/bmp': { contentType: 'image/bmp', extension: 'bmp' },
  'image/apng': { contentType: 'image/apng', extension: 'png' },
}
const aliases: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png', 'image/x-ms-bmp': 'image/bmp', 'image/x-avif': 'image/avif' }

export async function propertyImageType(file: File): Promise<{ contentType: string; extension: string } | null> {
  const mime = file.type.toLowerCase().split(';')[0].trim()
  if (types[mime] || types[aliases[mime]]) return types[mime] || types[aliases[mime]]
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return null
  // OS/browser MIME databases can omit AVIF (and other image) types. Inspect only a small
  // header in that case; a renamed SVG/HTML/HEIC must not pass on its extension alone.
  const data = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const text = (start: number, length: number) => String.fromCharCode(...data.slice(start, start + length))
  let detected = ''
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) detected = 'image/jpeg'
  else if (data.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => data[i] === n)) detected = 'image/png'
  else if (data.length >= 12 && text(0,4) === 'RIFF' && text(8,4) === 'WEBP') detected = 'image/webp'
  else if (text(0,6) === 'GIF87a' || text(0,6) === 'GIF89a') detected = 'image/gif'
  else if (data.length >= 14 && text(0,2) === 'BM') detected = 'image/bmp'
  else if (data.length >= 16 && text(4,4) === 'ftyp') {
    const size = new DataView(data.buffer).getUint32(0)
    if (size >= 16 && size <= data.length && size % 4 === 0) {
      const brands = [text(8,4)]
      for (let i = 16; i < size; i += 4) brands.push(text(i,4))
      if (brands.some(brand => brand === 'avif' || brand === 'avis')) detected = 'image/avif'
    }
  }
  return types[detected] ?? null
}
