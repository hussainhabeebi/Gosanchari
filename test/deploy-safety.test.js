// Execute the real deployment script with a stub npx; never contact Cloudflare.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function deploy(scenario) {
  const cwd = mkdtempSync(join(tmpdir(), 'gosanchari-deploy-test-'))
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  writeFileSync(join(cwd, 'wrangler.toml'), config)
  writeFileSync(join(cwd, 'npx'), `#!/bin/sh
printf '%s\\n' "$*" >> calls
case "$*" in
  'wrangler d1 info gosanchari')
    if [ "$DEPLOY_TEST_SCENARIO" = lookup ]; then
      echo 'original lookup stdout'
      echo 'original lookup error: permission denied' >&2
      exit 7
    fi
    exit 0 ;;
  'wrangler kv namespace list') echo '[{"title":"gosanchari-kv","id":"existing-kv"}]'; exit 0 ;;
  'wrangler d1 migrations apply gosanchari --remote') echo 'original migration error' >&2; exit 9 ;;
  *) echo 'Unexpected command' >&2; exit 99 ;;
esac
`, { mode: 0o700 })
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url))], {
      cwd, encoding: 'utf8', env: { ...process.env, PATH: cwd + ':' + process.env.PATH, DEPLOY_TEST_SCENARIO: scenario },
    })
    return { ...result, calls: readFileSync(join(cwd, 'calls'), 'utf8').trim().split('\n'), config: readFileSync(join(cwd, 'wrangler.toml'), 'utf8'), originalConfig: config }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}

it('fails closed on D1 lookup error and preserves the original error without creating resources', () => {
  const result = deploy('lookup')
  expect(result.status).toBe(7)
  expect(result.stderr).toContain('original lookup stdout')
  expect(result.stderr).toContain('original lookup error: permission denied')
  expect(result.stderr).toContain('stopping without creating a database or applying migrations')
  expect(result.calls).toEqual(['wrangler d1 info gosanchari'])
  expect(result.config).toBe(result.originalConfig)
})

it('does not suppress migration failure or proceed to Worker deploy or seed', () => {
  const result = deploy('migration')
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('original migration error')
  expect(result.stderr).toContain('Migrations failed')
  expect(result.calls).toEqual(['wrangler d1 info gosanchari', 'wrangler kv namespace list', 'wrangler d1 migrations apply gosanchari --remote'])
})
