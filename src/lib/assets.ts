// Long-cached copies of the main stylesheet and script. Their URLs carry the deployment's version
// (/v/<version>/app.css), so phones keep them for a year and still fetch new files after every deploy.

import type { Env } from '../env'

/** Files that may be served under /v/<version>/. */
export const VERSIONED_ASSETS = new Set(['/app.css', '/app.js'])

export function assetVersion(env: Pick<Env, 'CF_VERSION_METADATA'>): string {
  return env.CF_VERSION_METADATA?.id?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'dev'
}

export function assetUrl(version: string, path: string): string {
  return version === 'dev' || !VERSIONED_ASSETS.has(path) ? path : `/v/${version}${path}`
}
