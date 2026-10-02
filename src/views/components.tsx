import type { Child, FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { FACILITIES } from '../lib/search'
import type { PropertyCard as Card } from '../lib/types'
import { money, parseJson } from '../lib/util'
import { mediaUrl } from '../lib/integrations'

export const FACILITY_ICONS: Record<string, string> = {
  pool: '🏊', wifi: '📶', parking: '🅿️', ac: '❄️', kitchen: '🍳', breakfast: '🥐', garden: '🌿', view: '🏞', campfire: '🔥',
  power_backup: '🔋', hot_water: '🚿', tv: '📺', lake_view: '🛶', sea_view: '🌊', hill_view: '⛰', restaurant: '🍽', spa: '💆',
  wheelchair: '♿', ground_floor: '⬇️',
}

export const Stars: FC<{ value: number; count?: number }> = ({ value, count }) =>
  value > 0 ? (
    <span class="stars" aria-label={`${value.toFixed(1)} out of 5`}>
      ★ {value.toFixed(1)}{count != null && <span class="muted"> ({count})</span>}
    </span>
  ) : (
    <span class="muted small">New</span>
  )

export const Pill: FC<{ s: string }> = ({ s }) => <span class={`pill pill-${s.replace(/[^a-z_]/gi, '')}`}>{s.replace(/_/g, ' ')}</span>

export const PropertyCard: FC<{ p: Card; saved?: boolean; qs?: string; transform?: boolean }> = ({ p, saved, qs, transform }) => {
  const fac = parseJson<string[]>(p.facilities, []).slice(0, 3)
  const price = p.stay_price ?? p.from_price
  return (
    <article class="card pcard">
      <a href={`/stay/${p.slug}${qs ? '?' + qs : ''}`} class="pcard-img">
        <img src={mediaUrl(p.photo, 600, transform)} alt={p.name} loading="lazy" width="600" height="400" />
        <span class="pcard-type">{p.type}</span>
      </a>
      <form method="post" action={`/saved/${p.id}`} class="pcard-heart">
        <button title={saved ? 'Remove from saved' : 'Save'} aria-label="Save property" class={saved ? 'on' : ''}>{saved ? '♥' : '♡'}</button>
      </form>
      <div class="pcard-body">
        <div class="row-between">
          <h3><a href={`/stay/${p.slug}${qs ? '?' + qs : ''}`}>{p.name}</a></h3>
          <Stars value={p.rating_avg} count={p.rating_count} />
        </div>
        <div class="muted small">📍 {p.destination}</div>
        <div class="chips">{fac.map((f) => <span class="chip">{FACILITY_ICONS[f] ?? '•'} {FACILITIES[f] ?? f}</span>)}</div>
        <div class="row-between pcard-foot">
          <div>
            <span class="muted small">{p.stay_price ? 'avg / night' : 'from / night'}</span>
            <div class="price">{money(price)}</div>
            {p.stay_total != null && <div class="muted small">{money(p.stay_total)} total incl. GST</div>}
          </div>
          <a class="btn btn-sm" href={`/stay/${p.slug}${qs ? '?' + qs : ''}`}>View</a>
        </div>
      </div>
    </article>
  )
}

export const Empty: FC<{ children?: Child }> = ({ children }) => <div class="empty">{children}</div>

export const Turnstile: FC<{ siteKey: string }> = ({ siteKey }) => (siteKey ? <div class="cf-turnstile" data-sitekey={siteKey}></div> : <></>)

export const Field: FC<{ label: string; children?: Child; hint?: string; class?: string }> = ({ label, children, hint, class: cls }) => (
  <label class={`field ${cls ?? ''}`}>
    <span class="field-label">{label}</span>
    {children}
    {hint && <span class="hint">{hint}</span>}
  </label>
)

export const Select: FC<{ name: string; value?: string | number | null; options: [string | number, string][]; required?: boolean; id?: string; class?: string }> = ({
  name, value, options, required, id, class: cls,
}) => (
  <select name={name} required={required} id={id} class={cls}>
    {options.map(([v, l]) => (
      <option value={String(v)} selected={String(v) === String(value ?? '')}>{l}</option>
    ))}
  </select>
)

export const Pager: FC<{ page: number; hasMore: boolean; base: string }> = ({ page, hasMore, base }) => {
  const sep = base.includes('?') ? '&' : '?'
  return (
    <div class="pager">
      {page > 1 && <a class="btn btn-sm btn-outline" href={`${base}${sep}page=${page - 1}`}>← Previous</a>}
      <span class="muted">Page {page}</span>
      {hasMore && <a class="btn btn-sm btn-outline" href={`${base}${sep}page=${page + 1}`}>Next →</a>}
    </div>
  )
}

export const Stat: FC<{ label: string; value: string | number; hint?: string; tone?: string; href?: string }> = ({ label, value, hint, tone, href }) => {
  const inner = (
    <>
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {hint && <div class="muted small">{hint}</div>}
    </>
  )
  return href ? <a href={href} class={`stat ${tone ?? ''}`}>{inner}</a> : <div class={`stat ${tone ?? ''}`}>{inner}</div>
}

export const AiNote: FC<{ children?: Child; label?: string }> = ({ children, label }) => (
  <div class="ai-note"><span class="ai-badge">AI</span> {label && <strong>{label}: </strong>}{children}</div>
)

/** Safe JSON for inline <script type="application/json">. */
export function jsonScript(id: string, data: unknown) {
  const s = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  return raw(`<script type="application/json" id="${id}">${s}</script>`)
}

export const LeafletHead = () => (
  <>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin="" defer></script>
  </>
)

export const ChartHead = () => <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js" defer></script>

export const Table: FC<{ head: string[]; children?: Child; class?: string }> = ({ head, children, class: cls }) => (
  <div class="table-wrap">
    <table class={`table ${cls ?? ''}`}>
      <thead><tr>{head.map((h) => <th>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
)

export const Tabs: FC<{ items: [string, string][]; active: string; base: string; param?: string }> = ({ items, active, base, param = 'tab' }) => (
  <nav class="tabs">
    {items.map(([k, l]) => (
      <a href={`${base}${base.includes('?') ? '&' : '?'}${param}=${k}`} class={k === active ? 'active' : ''}>{l}</a>
    ))}
  </nav>
)
