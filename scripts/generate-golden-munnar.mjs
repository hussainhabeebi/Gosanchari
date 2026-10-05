// Targeted SQL generator shared by catalogue tests and the private import CLI.
// No database connection, deployment, markup or generated default values.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Preserve the reviewed generator's JSON representation as well as its SQL values.
function json(value) {
  if (Array.isArray(value)) return `[${value.map(json).join(', ')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${json(v)}`).join(', ')}}`
  return JSON.stringify(value)
}
function literal(value) {
  if (value === null) return 'NULL'
  if (typeof value === 'object') value = json(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new Error('Unsupported SQL value')
}
const columns = (record) => Object.keys(record).join(',')
const values = (record) => Object.values(record).map(literal).join(',')

export function generate(data) {
  const prop = data.property
  const slug = literal(prop.slug), name = literal(prop.name)
  const sql = [
    '-- Targeted catalogue insertion; no markup or defaults. Treat real client output as confidential.',
    'CREATE TRIGGER IF NOT EXISTS golden_catalogue_import_guard BEFORE INSERT ON properties BEGIN\n' +
      ` SELECT CASE WHEN EXISTS(SELECT 1 FROM properties WHERE (name=${name} OR slug=${slug}) AND NOT (name=${name} AND slug=${slug} AND catalogue_only=1)) THEN RAISE(ABORT,'Golden Munnar Palace name/slug conflict: review existing property') END;\nEND;`,
    `INSERT INTO properties (${columns(prop)}) VALUES (${values(prop)}) ON CONFLICT(slug) DO NOTHING;`,
  ]
  const propertyId = `(SELECT id FROM properties WHERE slug=${slug})`
  for (const source of data.rooms) {
    const { periods, ...room } = source
    const roomName = literal(room.name)
    sql.push(`INSERT INTO rooms (property_id,${columns(room)}) SELECT ${propertyId},${values(room)} WHERE NOT EXISTS (SELECT 1 FROM rooms WHERE property_id=${propertyId} AND name=${roomName});`)
    const roomId = `(SELECT id FROM rooms WHERE property_id=${propertyId} AND name=${roomName})`
    for (const period of periods) sql.push(`INSERT INTO catalogue_rate_periods (room_id,${columns(period)}) VALUES (${roomId},${values(period)}) ON CONFLICT(room_id,start_date,end_date) DO NOTHING;`)
  }
  for (const charge of data.charges) sql.push(`INSERT INTO property_charges (property_id,${columns(charge)}) VALUES (${propertyId},${values(charge)}) ON CONFLICT(property_id,charge_key) DO NOTHING;`)
  sql.push('DROP TRIGGER golden_catalogue_import_guard;')
  return sql.join('\n\n') + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let source = new URL('../data/golden-munnar-palace.json', import.meta.url)
  let output = new URL('../seed/golden-munnar-palace.sql', import.meta.url)
  let stdout = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stdout') stdout = true
    else if ((args[i] === '--source' || args[i] === '--output') && args[i + 1]) {
      const path = resolve(args[++i])
      if (args[i - 1] === '--source') source = path
      else output = path
    } else throw new Error('Usage: node scripts/generate-golden-munnar.mjs [--source path] [--output path] [--stdout]')
  }
  const data = JSON.parse(readFileSync(source, 'utf8'))
  if (data._test_only && !stdout) throw new Error('Synthetic test fixture cannot generate an import file')
  const sql = generate(data)
  if (stdout) process.stdout.write(sql)
  else writeFileSync(output, sql, { mode: 0o600 })
}
