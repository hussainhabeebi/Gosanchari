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
console.log(`▶ D1 database "${DB}"`)
if (run(['d1', 'info', DB], true).status !== 0) {
  console.log('  not found — creating it')
  if (run(['d1', 'create', DB, '--location', 'apac']).status !== 0) fail('Could not create the D1 database')
} else console.log('  found')

// ---- KV: find by title (create if missing) and pin its id in the config used for this deploy ----
function findKv() {
  const r = run(['kv', 'namespace', 'list'], true)
  if (r.status !== 0) fail(`Could not list KV namespaces:\n${r.stderr}`)
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
console.log('▶ Applying database migrations')
if (run(['d1', 'migrations', 'apply', DB, '--remote']).status !== 0) fail('Migrations failed')

console.log('▶ Deploying the Worker')
const d = run(['deploy', ...process.argv.slice(2)])
// Restore the committed config when running locally (keeps the repo clean).
if (!process.env.WORKERS_CI) writeFileSync(CONFIG, cfg)
process.exit(d.status ?? 1)
