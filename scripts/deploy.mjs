// Deploy: make sure the D1 database and KV namespace exist (reusing them if they do), apply migrations,
// then `wrangler deploy`. Works locally (after `wrangler login`) and in Cloudflare Workers Builds.
// R2 buckets and the queue are named in wrangler.toml and provisioned by `wrangler deploy`.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const DB = 'gosanchari'
const KV_TITLE = 'gosanchari-kv'
const CONFIG = 'wrangler.toml'
const run = (args, quiet = false) =>
  spawnSync('npx', ['wrangler', ...args], { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', env: { ...process.env, CI: '1' } })
const fail = (msg, code = 1) => { console.error(`✘ ${msg}`); process.exit(code) }

// ---- D1 ----
// Only a definite "not found" creates the database. Any other lookup error (token permissions, wrong account,
// network) stops the deploy, so a live site is never pointed at a new, empty database.
console.log(`▶ D1 database "${DB}"`)
const info = run(['d1', 'info', DB, '--json'], true)
const infoOut = `${info.stdout ?? ''}\n${info.stderr ?? ''}`
if (info.status === 0) {
  const uuid = infoOut.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1]
  console.log(`  found${uuid ? ` (${uuid})` : ''}`)
} else if (/Couldn't find a D1 DB named|database not found/i.test(infoOut)) {
  console.log('  not found — creating it')
  if (run(['d1', 'create', DB, '--location', 'apac']).status !== 0) fail('Could not create the D1 database')
} else fail(`Could not look up the D1 database (check the API token has D1 Edit permission and the right account):\n${infoOut.trim()}`)

// ---- KV: find by title (create if missing) and pin its id in the config used for this deploy ----
function findKv() {
  const r = run(['kv', 'namespace', 'list'], true)
  if (r.status !== 0) fail(`Could not list KV namespaces (check the API token has Workers KV Storage Edit permission):\n${r.stderr || r.stdout}`)
  const out = r.stdout ?? ''
  const list = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1) || '[]')
  return list.find((n) => n.title === KV_TITLE)?.id
}
console.log(`▶ KV namespace "${KV_TITLE}"`)
let kvId = findKv()
if (!kvId) {
  console.log('  not found — creating it')
  if (run(['kv', 'namespace', 'create', KV_TITLE]).status !== 0) fail('Could not create the KV namespace')
  kvId = findKv()
  if (!kvId) fail('KV namespace was created but could not be found')
} else console.log(`  found (${kvId})`)
const cfg = readFileSync(CONFIG, 'utf8')
const pinned = cfg.replace(/(\[\[kv_namespaces\]\][ \t]*\nbinding = "KV"[ \t]*\n)(id = "[^"]*"[ \t]*\n)?/, `$1id = "${kvId}"\n`)
if (!pinned.includes(`id = "${kvId}"`)) fail('Could not set the KV namespace id in wrangler.toml')
writeFileSync(CONFIG, pinned)

// ---- Migrations + deploy ----
// Migrations run before the new code goes live; if one fails, the old code keeps running on the old schema.
console.log('▶ Applying database migrations')
if (run(['d1', 'migrations', 'apply', DB, '--remote']).status !== 0) fail('Migrations failed — the Worker was not deployed')

console.log('▶ Deploying the Worker')
const d = run(['deploy', ...process.argv.slice(2)])
// Restore the committed config when running locally (keeps the repo clean).
if (!process.env.WORKERS_CI) writeFileSync(CONFIG, cfg)
process.exit(d.status ?? 1)
