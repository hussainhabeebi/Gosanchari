// Production rollout: verify existing resources, apply migrations, then activate the Worker.
// Never provisions resources. Run only through the approved production deployment pipeline.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const PRODUCTION_D1_ID = '04eb5123-059a-45fb-ae10-6541ad1ae92a'
const DB = 'gosanchari'
const KV_TITLE = 'gosanchari-kv'
const CONFIG = 'wrangler.toml'

function jsonOutput(output) {
  const text = (output ?? '').trim()
  try { return JSON.parse(text) } catch {
    const begin = text.indexOf('['), object = text.indexOf('{')
    const start = begin >= 0 && (object < 0 || begin < object) ? begin : object
    const end = start === begin ? text.lastIndexOf(']') : text.lastIndexOf('}')
    if (start < 0 || end < start) throw new Error('Wrangler returned no valid resource JSON.')
    return JSON.parse(text.slice(start, end + 1))
  }
}
function section(config, heading) {
  return config.split(/(?=^\[)/m).filter(block => block.startsWith(`[[${heading}]]`))
}
function value(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, 'm'))?.[1]
}

/** Injected IO keeps tests entirely local: no real Wrangler process or production calls. */
export function deployProduction({ run, read, write, log = console.log }) {
  const config = read(CONFIG)
  const databases = section(config, 'd1_databases')
  const namespaces = section(config, 'kv_namespaces')
  if (value(config, 'name') !== DB || databases.length !== 1 ||
      value(databases[0], 'binding') !== 'DB' || value(databases[0], 'database_name') !== DB ||
      value(databases[0], 'database_id') !== PRODUCTION_D1_ID ||
      value(databases[0], 'migrations_dir') !== 'migrations') {
    throw new Error('Production Worker/D1 configuration is missing or mismatched. Deployment stopped.')
  }
  if (namespaces.length !== 1 || value(namespaces[0], 'binding') !== 'KV') {
    throw new Error('Expected existing KV binding is missing or mismatched. Deployment stopped.')
  }

  log(`▶ Verifying existing D1 ${DB} (${PRODUCTION_D1_ID})`)
  const info = run(['d1', 'info', DB, '--json'], true)
  if (info.status !== 0) throw new Error(`Could not look up existing production D1. No database will be created.\n${info.stderr || info.stdout || ''}`)
  const result = jsonOutput(info.stdout)
  const database = Array.isArray(result) && result.length === 1 ? result[0] : result
  if (database?.uuid !== PRODUCTION_D1_ID || database?.name !== DB) {
    throw new Error('D1 lookup does not match the approved production UUID/name. Deployment stopped.')
  }

  log(`▶ Verifying existing KV ${KV_TITLE}`)
  const lookup = run(['kv', 'namespace', 'list'], true)
  if (lookup.status !== 0) throw new Error(`Could not list existing KV namespaces. No namespace will be created.\n${lookup.stderr || lookup.stdout || ''}`)
  const list = jsonOutput(lookup.stdout)
  const matches = Array.isArray(list) ? list.filter(item => item.title === KV_TITLE) : []
  if (matches.length !== 1 || !/^[a-f0-9]{32}$/i.test(matches[0].id)) {
    throw new Error('Expected existing KV namespace is missing, ambiguous or invalid. Deployment stopped.')
  }
  const kvId = matches[0].id, configured = value(namespaces[0], 'id')
  if (configured && configured !== kvId) throw new Error('Configured KV ID does not match the existing namespace. Deployment stopped.')
  const kvBlock = configured ? namespaces[0] : namespaces[0].replace(/^(binding\s*=\s*"KV"[^\n]*\n)/m, `$1id = "${kvId}"\n`)
  const pinned = config.replace(namespaces[0], kvBlock)
  if (value(section(pinned, 'kv_namespaces')[0], 'id') !== kvId) throw new Error('Could not pin the existing KV identity. Deployment stopped.')

  try {
    write(CONFIG, pinned)
    // Wrangler resolves this name through the verified, UUID-pinned binding above.
    log('▶ Applying migrations to the existing production database')
    if (run(['d1', 'migrations', 'apply', DB, '--remote']).status !== 0) {
      throw new Error('Migrations failed — the new Worker was not deployed.')
    }
    log('▶ Activating the Worker')
    if (run(['deploy']).status !== 0) throw new Error('Worker deployment failed. No retry was attempted.')
  } finally {
    write(CONFIG, config)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('Production deployment does not accept configuration or environment overrides.')
    deployProduction({
      run: (args, quiet = false) => spawnSync('npx', ['wrangler', ...args], {
        stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', env: { ...process.env, CI: '1' },
      }),
      read: path => readFileSync(path, 'utf8'),
      write: (path, text) => writeFileSync(path, text),
    })
  } catch (error) {
    console.error(`✘ ${error.message}`)
    process.exitCode = 1
  }
}
