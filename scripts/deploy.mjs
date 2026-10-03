// Deploy: make sure the D1 database exists, apply migrations, then `wrangler deploy`.
// Works locally (after `wrangler login`) and in Cloudflare Workers Builds (Git-connected deploys).
// KV, R2 and the queue are created automatically by `wrangler deploy` (resource provisioning).
import { spawnSync } from 'node:child_process'

const DB = 'gosanchari'
const run = (args, opts = {}) => spawnSync('npx', ['wrangler', ...args], { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', env: { ...process.env, CI: '1' } })

console.log(`▶ Checking D1 database "${DB}"`)
if (run(['d1', 'info', DB], { quiet: true }).status !== 0) {
  console.log(`  not found — creating it`)
  const c = run(['d1', 'create', DB, '--location', 'apac'])
  if (c.status !== 0) process.exit(c.status ?? 1)
}

console.log('▶ Applying database migrations')
const m = run(['d1', 'migrations', 'apply', DB, '--remote'])
if (m.status !== 0) process.exit(m.status ?? 1)

console.log('▶ Deploying the Worker')
const d = run(['deploy', ...process.argv.slice(2)])
process.exit(d.status ?? 1)
