// Admin → API & integrations: share full property details (prices, photos, location…) with external services such as LeadVyne.
//   Push: we send properties to the service's endpoint URL with its API token (on demand, or daily).
//   Pull: the service calls our /api/v1/properties with an API key created here.

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Empty, Field, Select, Table } from '../views/components'
import { requirePerm, requireStaff } from '../lib/auth'
import { all, first, logActivity, run } from '../lib/db'
import { createApiKey, maskToken, pushProperties, sharedProperties, validEndpoint, type ApiConnection } from '../lib/property-share'
import { fmtDateTime, int, str } from '../lib/util'
import { form, redirectMsg } from './helpers'

export const integrationRoutes = new Hono<AppEnv>()
integrationRoutes.use('/admin/integrations', requireStaff, requirePerm('manage_settings'))
integrationRoutes.use('/admin/integrations/*', requireStaff, requirePerm('manage_settings'))

const BASE = '/admin/integrations'

async function renderIntegrations(c: Context<AppEnv>, newKey?: { name: string; key: string }) {
  const [conns, props] = await Promise.all([
    all<ApiConnection>(c.env, 'SELECT * FROM api_connections ORDER BY direction, active DESC, id DESC'),
    all<{ id: number; name: string }>(c.env, "SELECT id, name FROM properties WHERE status = 'live' ORDER BY name"),
  ])
  const push = conns.filter((x) => x.direction === 'push')
  const pull = conns.filter((x) => x.direction === 'pull')
  const site = c.env.SITE_URL.replace(/\/+$/, '')
  const propOptions: [string, string][] = [['', `All live properties (${props.length})`], ...props.map((p): [string, string] => [String(p.id), p.name])]
  return page(c, { title: 'API & integrations', area: 'admin', active: 'integrations' }, (
    <div class="stack-lg">
      <h1>API &amp; integrations</h1>
      <p class="muted">Share complete property details — prices, photos, location, rooms, facilities and policies — with external services such as LeadVyne.
        Only guest-facing details are shared: never owner contacts, B2B net or staff rates, commission or internal notes. Only <b>live</b> properties are included.</p>

      {newKey && (
        <section class="card stack" id="new-key">
          <h2>API key for {newKey.name}</h2>
          <p class="error">Copy this key now — it is shown only once.</p>
          <input readonly value={newKey.key} onclick="this.select()" />
        </section>
      )}

      <section class="card stack">
        <h2>Send properties to a service (push)</h2>
        <p class="small muted">Paste the endpoint URL and API token from the other service (e.g. LeadVyne → Settings → API / Webhooks). We POST JSON
          <code>{'{ "source": "gosanchari", "event": "properties.sync", "properties": [...] }'}</code> in batches of 20.</p>
        {push.length ? (
          <Table head={['Service', 'Endpoint', 'Token', 'Daily sync', 'Last sync', '']}>
            {push.map((x) => (
              <tr class={x.active ? '' : 'muted'}>
                <td><b>{x.name}</b>{!x.active && <span class="pill">off</span>}</td>
                <td class="small"><code>{x.url}</code></td>
                <td class="small"><code>{x.token_hint}</code><div class="muted">{x.auth_style === 'x-api-key' ? 'X-API-Key header' : 'Bearer token'}</div></td>
                <td>{x.auto_sync ? 'Yes' : 'No'}</td>
                <td class="small">{x.last_used_at ? fmtDateTime(x.last_used_at) : '—'}<div class={x.last_status?.startsWith('OK') ? 'ok' : 'error'}>{x.last_status ?? ''}</div></td>
                <td class="stack">
                  {x.active ? (
                    <form method="post" action={`${BASE}/${x.id}/sync`} class="row">
                      <Select name="property_id" options={propOptions} />
                      <button class="btn btn-sm">Send now</button>
                    </form>
                  ) : null}
                  <div class="row">
                    <form method="post" action={`${BASE}/${x.id}/toggle`} class="inline"><button class="btn btn-sm btn-outline">{x.active ? 'Turn off' : 'Turn on'}</button></form>
                    <form method="post" action={`${BASE}/${x.id}/delete`} class="inline" onsubmit="return confirm('Remove this connection?')"><button class="btn btn-sm btn-outline">Remove</button></form>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No services connected yet.</Empty>}
        <form method="post" action={`${BASE}/push`} class="stack upload-box">
          <h3>Connect a service</h3>
          <div class="row">
            <Field label="Name"><input name="name" required maxlength={60} placeholder="LeadVyne" /></Field>
            <Field label="Endpoint URL"><input name="url" type="url" required placeholder="https://api.leadvyne.com/…" /></Field>
          </div>
          <div class="row">
            <Field label="API token"><input name="token" type="password" autocomplete="off" required /></Field>
            <Field label="Send the token as"><Select name="auth_style" options={[['bearer', 'Authorization: Bearer <token>'], ['x-api-key', 'X-API-Key: <token>']]} /></Field>
          </div>
          <label class="check"><input type="checkbox" name="auto_sync" value="1" checked /> Send all live properties every day (07:00 IST)</label>
          <label class="check"><input type="checkbox" name="send_now" value="1" checked /> Send all live properties now</label>
          <button class="btn">Connect</button>
        </form>
      </section>

      <section class="card stack">
        <h2>Let a service fetch properties (API keys)</h2>
        <p class="small muted">Give the service our API URL and a key. It sends the key as <code>Authorization: Bearer &lt;key&gt;</code> (or <code>X-API-Key</code>).</p>
        <Table head={['Endpoint', 'What it returns']}>
          <tr><td><code>GET {site}/api/v1/properties</code></td><td class="small">All live properties with full details. Optional: <code>?page=1&amp;limit=20</code> (max 50), <code>&amp;destination=Munnar</code>, <code>&amp;updated_since=2026-01-31</code></td></tr>
          <tr><td><code>GET {site}/api/v1/properties/&lt;id or slug&gt;</code></td><td class="small">One property</td></tr>
        </Table>
        <pre class="small">{`curl -H "Authorization: Bearer <key>" ${site}/api/v1/properties`}</pre>
        {pull.length ? (
          <Table head={['Name', 'Key', 'Created', 'Last used', '']}>
            {pull.map((x) => (
              <tr class={x.active ? '' : 'muted'}>
                <td><b>{x.name}</b>{!x.active && <span class="pill">revoked</span>}</td>
                <td class="small"><code>{x.token_hint}</code></td>
                <td class="small">{fmtDateTime(x.created_at)}</td>
                <td class="small">{x.last_used_at ? fmtDateTime(x.last_used_at) : 'Never'}</td>
                <td class="row">
                  <form method="post" action={`${BASE}/${x.id}/toggle`} class="inline"><button class="btn btn-sm btn-outline">{x.active ? 'Revoke' : 'Restore'}</button></form>
                  <form method="post" action={`${BASE}/${x.id}/delete`} class="inline" onsubmit="return confirm('Delete this key? Services using it stop working.')"><button class="btn btn-sm btn-outline">Delete</button></form>
                </td>
              </tr>
            ))}
          </Table>
        ) : <Empty>No API keys yet.</Empty>}
        <form method="post" action={`${BASE}/keys`} class="row">
          <Field label="Key name (who uses it)"><input name="name" required maxlength={60} placeholder="LeadVyne" /></Field>
          <button class="btn">Create API key</button>
        </form>
      </section>

      <section class="card stack">
        <h2>Preview the shared data</h2>
        <form method="get" action={`${BASE}/preview.json`} target="_blank" class="row">
          <Select name="property_id" options={props.map((p): [string, string] => [String(p.id), p.name])} />
          <button class="btn btn-outline">Open JSON</button>
        </form>
      </section>
    </div>
  ))
}

integrationRoutes.get(BASE, (c) => renderIntegrations(c))

integrationRoutes.get(`${BASE}/preview.json`, async (c) => {
  const [data] = await sharedProperties(c.env, [int(c.req.query('property_id'))])
  return data ? c.json({ data }) : c.json({ error: 'Pick a live property' }, 404)
})

integrationRoutes.post(`${BASE}/push`, async (c) => {
  const f = await form(c)
  const name = str(f.name, 60).trim()
  const url = validEndpoint(c.env, str(f.url, 500))
  const token = str(f.token, 500).trim()
  if (!name || !url || !token) return redirectMsg(c, BASE, { err: 'Enter a name, an https:// endpoint URL and the API token.' })
  const r = await run(
    c.env,
    "INSERT INTO api_connections (name, direction, url, token, auth_style, token_hint, auto_sync, created_by) VALUES (?, 'push', ?, ?, ?, ?, ?, ?)",
    name, url, token, f.auth_style === 'x-api-key' ? 'x-api-key' : 'bearer', maskToken(token), f.auto_sync ? 1 : 0, c.get('user')!.id,
  )
  const id = Number(r.meta.last_row_id)
  await logActivity(c.env, c.get('user')!.id, 'integration.connected', 'api_connection', id, { name, url })
  if (!f.send_now) return redirectMsg(c, BASE, { ok: `${name} connected.` })
  const conn = await first<ApiConnection>(c.env, 'SELECT * FROM api_connections WHERE id = ?', id)
  const res = await pushProperties(c.env, conn!)
  return redirectMsg(c, BASE, res.ok ? { ok: `${name} connected and ${res.sent} properties sent.` } : { err: `${name} connected, but sending failed: ${res.error}` })
})

integrationRoutes.post(`${BASE}/keys`, async (c) => {
  const f = await form(c)
  const name = str(f.name, 60).trim()
  if (!name) return redirectMsg(c, BASE, { err: 'Give the key a name.' })
  const { id, key } = await createApiKey(c.env, name, c.get('user')!.id)
  await logActivity(c.env, c.get('user')!.id, 'integration.key_created', 'api_connection', id, { name })
  return renderIntegrations(c, { name, key })
})

integrationRoutes.post(`${BASE}/:id/sync`, async (c) => {
  const conn = await first<ApiConnection>(c.env, "SELECT * FROM api_connections WHERE id = ? AND direction = 'push' AND active = 1", int(c.req.param('id')))
  if (!conn) return redirectMsg(c, BASE, { err: 'Connection not found or turned off.' })
  const f = await form(c)
  const one = int(f.property_id)
  const res = await pushProperties(c.env, conn, one ? [one] : undefined)
  await logActivity(c.env, c.get('user')!.id, 'integration.sync', 'api_connection', conn.id, { property: one || 'all', sent: res.sent, error: res.error })
  return redirectMsg(c, BASE, res.ok ? { ok: `Sent ${res.sent} ${res.sent === 1 ? 'property' : 'properties'} to ${conn.name}.` } : { err: `Sending to ${conn.name} failed: ${res.error}` })
})

integrationRoutes.post(`${BASE}/:id/toggle`, async (c) => {
  const id = int(c.req.param('id'))
  await run(c.env, 'UPDATE api_connections SET active = 1 - active WHERE id = ?', id)
  await logActivity(c.env, c.get('user')!.id, 'integration.toggled', 'api_connection', id)
  return c.redirect(BASE, 303)
})

integrationRoutes.post(`${BASE}/:id/delete`, async (c) => {
  const id = int(c.req.param('id'))
  await run(c.env, 'DELETE FROM api_connections WHERE id = ?', id)
  await logActivity(c.env, c.get('user')!.id, 'integration.deleted', 'api_connection', id)
  return redirectMsg(c, BASE, { ok: 'Removed.' })
})
