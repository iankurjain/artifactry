/**
 * Custom share domains.
 *
 * An organization owner or admin can issue every share link on a hostname they
 * control (share.acme.com) instead of the application origin. Only the external
 * recipient surface is served there; see `isShareDomainPath`.
 *
 * How a request on a customer hostname reaches this app:
 *
 *   share.acme.com  --CNAME-->  SHARE_DOMAIN_CNAME_TARGET (Cloudflare for SaaS)
 *     -> share-edge Worker (src/share-edge-worker.ts, route on the SaaS zone)
 *     -> APP_ORIGIN, with the visitor's hostname and IP in X-Artifactry-* headers
 *        and SHARE_EDGE_SECRET proving the headers came from the edge Worker.
 *
 * The app never trusts those headers without the secret, and never trusts the
 * hostname without an ACTIVE row for it in organization_share_domains. A
 * request that fails either check is a plain 404.
 *
 * Fail-soft rule: everything that *issues* links (shareOriginForOrg) swallows
 * errors and falls back to the application origin, so a missing migration or a
 * D1 hiccup can never stop people from sharing. Everything that *serves* on a
 * custom hostname fails closed.
 */

import type { Context } from 'hono'
import type { Env } from '../types'
import { first } from './db'
import { badRequest } from './http'
import { timingSafeEqual } from './crypto'
import { normalizeOrigin } from './htmlpreview'

export const SHARE_EDGE_HOST_HEADER = 'X-Artifactry-Share-Host'
export const SHARE_EDGE_AUTH_HEADER = 'X-Artifactry-Edge-Auth'
export const SHARE_EDGE_IP_HEADER = 'X-Artifactry-Client-IP'

/** TXT record that proves control of a hostname, and the value it must hold. */
export const CHALLENGE_LABEL = '_artifactry-challenge'
export const CHALLENGE_PREFIX = 'artifactry-verify='

export type ShareDomainStatus = 'PENDING_DNS' | 'PENDING_CERT' | 'ACTIVE' | 'ERROR'

export interface ShareDomainRow {
  id: string
  organization_id: string
  hostname: string
  status: ShareDomainStatus
  verification_token: string
  cf_custom_hostname_id: string | null
  last_error: string | null
  verified_at: string | null
  activated_at: string | null
  last_checked_at: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

/** What a request on a verified customer hostname carries through the app. */
export interface ShareDomainContext {
  hostname: string
  origin: string
  organizationId: string
  clientIp: string | null
}

type ShareDomainEnv = Pick<
  Env,
  'SHARE_EDGE_SECRET' | 'CF_API_TOKEN' | 'CF_ZONE_ID' | 'SHARE_DOMAIN_CNAME_TARGET'
>

/**
 * Whether this deployment can put share links on customer domains at all.
 * Every piece is required: without the edge secret nothing can be served, and
 * without the Cloudflare API nothing can get a certificate.
 */
export function shareDomainsAvailable(env: ShareDomainEnv): boolean {
  return Boolean(
    env.SHARE_EDGE_SECRET?.trim() &&
      env.CF_API_TOKEN?.trim() &&
      env.CF_ZONE_ID?.trim() &&
      env.SHARE_DOMAIN_CNAME_TARGET?.trim()
  )
}

// ---------------------------------------------------------------
// Hostname rules
// ---------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

function hostOf(origin: string | undefined | null): string | null {
  const normalized = normalizeOrigin(origin?.trim())
  return normalized ? new URL(normalized).hostname.toLowerCase() : null
}

/**
 * Normalize what an admin typed into a bare lowercase hostname, or throw.
 *
 * Accepts "https://Share.Acme.com/" and "share.acme.com." alike. Refuses IP
 * literals, single-label names, and anything on the application's own domains:
 * those are not the customer's to claim.
 */
export function normalizeShareHostname(
  raw: string,
  env: Pick<Env, 'APP_ORIGIN' | 'PREVIEW_ORIGIN' | 'SHARE_DOMAIN_CNAME_TARGET'>
): string {
  let value = String(raw ?? '').trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split(/[/?#]/)[0] ?? ''
  value = value.replace(/\.$/, '')
  if (value.includes(':')) throw badRequest('Enter a hostname without a port, like share.yourcompany.com')
  if (!HOSTNAME_RE.test(value)) throw badRequest('Enter a hostname like share.yourcompany.com')

  const reserved = [
    hostOf(env.APP_ORIGIN),
    hostOf(env.PREVIEW_ORIGIN),
    env.SHARE_DOMAIN_CNAME_TARGET?.trim().toLowerCase() || null,
    'pages.dev',
    'workers.dev'
  ].filter((h): h is string => !!h)
  for (const host of reserved) {
    if (value === host || value.endsWith(`.${host}`)) {
      throw badRequest('That hostname belongs to Artifactry. Use a hostname on your own domain.')
    }
  }
  return value
}

export function challengeName(hostname: string): string {
  return `${CHALLENGE_LABEL}.${hostname}`
}

export function challengeValue(token: string): string {
  return `${CHALLENGE_PREFIX}${token}`
}

// ---------------------------------------------------------------
// Request surface
// ---------------------------------------------------------------

/**
 * The customer hostname a request was forwarded for, or null.
 *
 * Null unless the edge secret is configured AND the request presents it, so
 * anyone calling the app origin directly with a forged host header is treated
 * as an ordinary app request.
 */
export function edgeForwardedHost(
  env: Pick<Env, 'SHARE_EDGE_SECRET'>,
  header: (name: string) => string | undefined
): { hostname: string; clientIp: string | null } | null {
  const secret = env.SHARE_EDGE_SECRET?.trim()
  if (!secret) return null
  const presented = header(SHARE_EDGE_AUTH_HEADER)
  if (!presented || !timingSafeEqual(presented, secret)) return null
  const hostname = (header(SHARE_EDGE_HOST_HEADER) ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!HOSTNAME_RE.test(hostname)) return null
  const ip = (header(SHARE_EDGE_IP_HEADER) ?? '').trim()
  return { hostname, clientIp: ip || null }
}

/**
 * Paths that exist on a customer hostname. Everything else is a 404 there:
 * no sign-in, no library, no API beyond the recipient endpoints, no MCP.
 */
const SHARE_DOMAIN_PATHS: Array<{ method: string[]; re: RegExp }> = [
  { method: ['GET', 'HEAD'], re: /^\/s\/[A-Za-z0-9_-]+\/?$/ },
  { method: ['GET', 'HEAD'], re: /^\/s\/[A-Za-z0-9_-]+\/artifact\/[A-Za-z0-9_-]+\/?$/ },
  { method: ['GET', 'HEAD'], re: /^\/api\/v1\/shares\/[A-Za-z0-9_-]+\/(meta|view|content|preview)$/ },
  { method: ['POST'], re: /^\/api\/v1\/shares\/[A-Za-z0-9_-]+\/(request-code|verify)$/ },
  { method: ['GET', 'HEAD'], re: /^\/api\/health$/ },
  // The recipient page's footer links to the public user guide.
  { method: ['GET', 'HEAD'], re: /^\/guide\/?$/ }
]

export function isShareDomainPath(method: string, path: string): boolean {
  const m = method.toUpperCase()
  return SHARE_DOMAIN_PATHS.some((p) => p.method.includes(m) && p.re.test(path))
}

/** The ACTIVE domain row for a hostname, or null. Fails closed. */
export async function activeShareDomainByHost(
  db: D1Database,
  hostname: string
): Promise<Pick<ShareDomainRow, 'organization_id' | 'hostname'> | null> {
  try {
    return await first<Pick<ShareDomainRow, 'organization_id' | 'hostname'>>(
      db,
      `SELECT organization_id, hostname FROM organization_share_domains
        WHERE hostname = ? AND status = 'ACTIVE' AND verified_at IS NOT NULL`,
      [hostname]
    )
  } catch (err) {
    console.error('[share-domain] lookup failed', err)
    return null
  }
}

/**
 * Origin share links for this organization should use, or null for the
 * application origin. Fails soft: see the module comment.
 */
export async function shareOriginForOrg(
  db: D1Database,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null
  try {
    const row = await first<{ hostname: string }>(
      db,
      `SELECT hostname FROM organization_share_domains
        WHERE organization_id = ? AND status = 'ACTIVE' AND verified_at IS NOT NULL`,
      [organizationId]
    )
    return row ? `https://${row.hostname}` : null
  } catch {
    return null
  }
}

/**
 * Whether `origin` is an ACTIVE share domain belonging to `organizationId`.
 * Used by the preview origin to accept a framing origin other than APP_ORIGIN.
 */
export async function isActiveShareOriginFor(
  db: D1Database,
  origin: string,
  organizationId: string | null
): Promise<boolean> {
  if (!organizationId) return false
  const normalized = normalizeOrigin(origin)
  if (!normalized || !normalized.startsWith('https://')) return false
  const hostname = new URL(normalized).hostname.toLowerCase()
  if (normalized !== `https://${hostname}`) return false
  const row = await activeShareDomainByHost(db, hostname)
  return row?.organization_id === organizationId
}

/** The share-domain context of this request, if it arrived on one. */
export function shareDomainOf(c: Context): ShareDomainContext | null {
  return (c.get('shareDomain' as never) as ShareDomainContext | undefined) ?? null
}

/**
 * The origin the visitor actually sees: the customer hostname on a share
 * domain, otherwise the request's own origin. Use it for every absolute URL a
 * recipient endpoint hands back, and as the framing origin of a preview.
 */
export function publicOrigin(c: Context): string {
  return shareDomainOf(c)?.origin ?? new URL(c.req.url).origin
}

// ---------------------------------------------------------------
// DNS ownership check (DNS over HTTPS)
// ---------------------------------------------------------------

/** TXT values at `name`, with quoting removed and split strings joined. */
export async function lookupTxt(name: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } })
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`)
  const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> }
  return (body.Answer ?? [])
    .filter((a) => a.type === 16)
    .map((a) => {
      const parts = a.data.match(/"((?:[^"\\]|\\.)*)"/g)
      return parts ? parts.map((p) => p.slice(1, -1)).join('') : a.data
    })
}

// ---------------------------------------------------------------
// Cloudflare for SaaS custom hostnames
// ---------------------------------------------------------------

export interface CustomHostnameState {
  id: string
  status: string
  sslStatus: string | null
  errors: string[]
}

interface CfEnvelope<T> {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result: T
}

interface CfCustomHostname {
  id: string
  hostname: string
  status: string
  ssl?: { status?: string; validation_errors?: Array<{ message?: string }> }
  verification_errors?: string[]
}

async function cfRequest<T>(
  env: Pick<Env, 'CF_API_TOKEN' | 'CF_ZONE_ID'>,
  method: string,
  path: string,
  body?: unknown
): Promise<CfEnvelope<T>> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CF_ZONE_ID ?? '')}/custom_hostnames${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN ?? ''}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  )
  const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null
  if (!json) throw new Error(`Cloudflare API returned ${res.status}`)
  return json
}

function toState(h: CfCustomHostname): CustomHostnameState {
  return {
    id: h.id,
    status: h.status,
    sslStatus: h.ssl?.status ?? null,
    errors: [
      ...(h.verification_errors ?? []),
      ...(h.ssl?.validation_errors ?? []).map((e) => e.message ?? '').filter(Boolean)
    ]
  }
}

function cfError(env: CfEnvelope<unknown>): string {
  return env.errors?.map((e) => e.message).join('; ') || 'Cloudflare refused the request'
}

/**
 * Register the hostname with Cloudflare for SaaS (HTTP validation, which
 * succeeds on its own once the customer's CNAME is in place). Re-uses an
 * existing registration for the same hostname rather than failing on it.
 */
export async function createCustomHostname(
  env: Pick<Env, 'CF_API_TOKEN' | 'CF_ZONE_ID'>,
  hostname: string
): Promise<CustomHostnameState> {
  const created = await cfRequest<CfCustomHostname>(env, 'POST', '', {
    hostname,
    ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } }
  })
  if (created.success) return toState(created.result)

  const existing = await cfRequest<CfCustomHostname[]>(env, 'GET', `?hostname=${encodeURIComponent(hostname)}`)
  const match = existing.success ? existing.result.find((h) => h.hostname === hostname) : undefined
  if (match) return toState(match)
  throw new Error(cfError(created))
}

export async function getCustomHostname(
  env: Pick<Env, 'CF_API_TOKEN' | 'CF_ZONE_ID'>,
  id: string
): Promise<CustomHostnameState | null> {
  const res = await cfRequest<CfCustomHostname>(env, 'GET', `/${encodeURIComponent(id)}`)
  return res.success ? toState(res.result) : null
}

export async function deleteCustomHostname(
  env: Pick<Env, 'CF_API_TOKEN' | 'CF_ZONE_ID'>,
  id: string
): Promise<void> {
  const res = await cfRequest<unknown>(env, 'DELETE', `/${encodeURIComponent(id)}`)
  if (!res.success) throw new Error(cfError(res))
}

export function customHostnameLive(state: CustomHostnameState | null): boolean {
  return !!state && state.status === 'active' && state.sslStatus === 'active'
}
