/**
 * OAuth 2.1 authorization server for AI connectors.
 *
 * Why this exists: ChatGPT, Claude (web, desktop, mobile), Gemini Enterprise and
 * Copilot Studio connect to a remote MCP server through OAuth or not at all.
 * None of them accepts a pasted bearer token, so without this the MCP endpoint
 * is unreachable from every consumer chat app.
 *
 * Design rule: an OAuth access token is an ordinary integration_grants row.
 * Everything downstream — scope checks, `can()` re-checking the user's real
 * role, provenance, analytics, revocation from Settings — is unchanged and
 * cannot tell an OAuth grant from a pasted one. The only additions are expiry
 * and a rotating refresh token.
 *
 * Supported:
 *   - Protected resource metadata (RFC 9728) and authorization server
 *     metadata (RFC 8414), so clients discover everything from the MCP URL.
 *   - Dynamic Client Registration (RFC 7591) for public clients.
 *   - Client ID Metadata Documents: a client whose client_id is an https URL
 *     is described by the JSON document at that URL, so it needs no
 *     registration call at all (the MCP spec's preferred method).
 *   - Manually created confidential clients (client id + secret) for clients
 *     that need them typed in: Gemini Enterprise and Copilot Studio "Manual".
 *   - Authorization code + PKCE S256. PKCE is mandatory for public clients.
 *   - Refresh token rotation.
 */

import type { AiScope, Env, Principal } from '../types'
import { AI_SCOPES } from '../types'
import { first, nowIso, run } from './db'
import { hashGrantToken, sha256Hex, timingSafeEqual, tokenPrefix } from './crypto'
import { prefixed, randomToken, ulid } from './ids'
import { recordAudit } from './audit'

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const REFRESH_TOKEN_TTL_DAYS = 90
export const CODE_TTL_SECONDS = 5 * 60

/** What a client gets when it asks for nothing specific: Find, Save, Share. */
export const DEFAULT_OAUTH_SCOPES: AiScope[] = [
  'artifact.read',
  'artifact.write',
  'artifact.share',
  'workspace.read',
  'team.read',
  'tags.read'
]

export const MCP_PATH = '/api/v1/mcp'

/** What a person calls each connector row, on the consent page and in Settings. */
export const CLIENT_LABELS: Record<string, string> = {
  int_chatgpt: 'ChatGPT',
  int_claude: 'Claude',
  int_gemini: 'Gemini',
  int_copilot: 'Microsoft Copilot',
  int_other: 'An AI app'
}

export class OAuthError extends Error {
  status: number
  code: string
  constructor(code: string, description: string, status = 400) {
    super(description)
    this.code = code
    this.status = status
  }
}

export interface OAuthClientRow {
  id: string
  client_name: string | null
  redirect_uris: string
  secret_hash: string | null
  token_endpoint_auth_method: string
  integration_id: string
  created_by_user_id: string | null
  status: string
  created_at: string
}

// ---------------------------------------------------------------
// Discovery documents
// ---------------------------------------------------------------

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: AI_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Artifactry',
    resource_documentation: `${origin}/guide`
  }
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: AI_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: JWT_ALGS,
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    service_documentation: `${origin}/guide`
  }
}

/** The header every 401 from the MCP endpoint carries, so sign-in can start. */
export function wwwAuthenticate(origin: string, error?: 'invalid_token'): string {
  const parts = [`resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`]
  if (error) parts.push(`error="${error}"`)
  return `Bearer ${parts.join(', ')}`
}

// ---------------------------------------------------------------
// Redirect URIs and client classification
// ---------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * A redirect URI must be https, or http on a loopback address for native
 * clients (Claude Code, Gemini CLI). Fragments are never allowed.
 */
export function validRedirectUri(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/**
 * Exact match, except that a loopback redirect matches on any port (RFC 8252
 * §7.3): native clients pick an ephemeral port per session.
 */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  let req: URL
  try {
    req = new URL(requested)
  } catch {
    return false
  }
  if (req.protocol !== 'http:' || !isLoopbackHost(req.hostname)) return false
  return registered.some((r) => {
    try {
      const reg = new URL(r)
      return (
        reg.protocol === 'http:' &&
        isLoopbackHost(reg.hostname) &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      )
    } catch {
      return false
    }
  })
}

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * Which connector row a client belongs to, for provenance only. It never
 * changes what the client may do. Hosted apps are identified by their callback
 * host, which they cannot choose freely; local clients only have their
 * self-reported name, so anything unrecognised lands on "Other MCP client".
 */
export function integrationForClient(clientName: string | null, redirectUris: string[]): string {
  for (const raw of redirectUris) {
    let host = ''
    try {
      host = new URL(raw).hostname.toLowerCase()
    } catch {
      continue
    }
    if (hostMatches(host, ['chatgpt.com', 'openai.com'])) return 'int_chatgpt'
    if (hostMatches(host, ['claude.ai', 'claude.com', 'anthropic.com'])) return 'int_claude'
    if (hostMatches(host, ['google.com', 'googleusercontent.com', 'gemini.google'])) return 'int_gemini'
    if (
      hostMatches(host, [
        'azure-apim.net',
        'azure-apihub.net',
        'powerplatform.com',
        'microsoft.com',
        'botframework.com',
        'copilotstudio.microsoft.com'
      ])
    ) {
      return 'int_copilot'
    }
  }
  const name = (clientName ?? '').toLowerCase()
  if (/claude|anthropic/.test(name)) return 'int_claude'
  if (/chatgpt|openai|codex/.test(name)) return 'int_chatgpt'
  if (/gemini|google/.test(name)) return 'int_gemini'
  if (/copilot|microsoft/.test(name)) return 'int_copilot'
  return 'int_other'
}

// ---------------------------------------------------------------
// Clients
// ---------------------------------------------------------------

function parseRedirects(row: OAuthClientRow): string[] {
  try {
    const parsed = JSON.parse(row.redirect_uris)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function clientRedirects(row: OAuthClientRow): string[] {
  return parseRedirects(row)
}

function hashClientSecret(secret: string): Promise<string> {
  return sha256Hex(`oauth-client:v1:${secret}`)
}

function hashCode(code: string): Promise<string> {
  return sha256Hex(`oauth-code:v1:${code}`)
}

function hashRefresh(token: string): Promise<string> {
  return sha256Hex(`oauth-refresh:v1:${token}`)
}

function readRedirectList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array')
  }
  if (value.length > 10) throw new OAuthError('invalid_redirect_uri', 'At most 10 redirect_uris')
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || v.length > 2000 || !validRedirectUri(v)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        'Each redirect URI must be https, or http on localhost / 127.0.0.1'
      )
    }
    out.push(v)
  }
  return out
}

/** Dynamic Client Registration (RFC 7591). Public clients only: PKCE is their proof. */
export async function registerClient(
  db: D1Database,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const redirectUris = readRedirectList(body.redirect_uris)
  const clientName =
    typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 120) || null : null

  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ['authorization_code']
  if (!grantTypes.includes('authorization_code')) {
    throw new OAuthError('invalid_client_metadata', 'grant_types must include authorization_code')
  }

  // A self-registered client never gets a secret. A client that asks for one
  // is registered as public anyway; RFC 7591 lets the server decide, and the
  // response tells the client which method it got.
  const id = prefixed('oac', ulid())
  const integrationId = integrationForClient(clientName, redirectUris)
  const createdAt = nowIso()

  await run(
    db,
    `INSERT INTO oauth_clients
       (id, client_name, redirect_uris, secret_hash, token_endpoint_auth_method,
        integration_id, created_by_user_id, status, created_at)
     VALUES (?, ?, ?, NULL, 'none', ?, NULL, 'ACTIVE', ?)`,
    [id, clientName, JSON.stringify(redirectUris), integrationId, createdAt]
  )

  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    client_name: clientName ?? undefined,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }
}

/**
 * A confidential client created by a signed-in user, for apps whose setup
 * form asks for a client id and secret (Gemini Enterprise, Copilot Studio
 * "Manual"). The secret is returned once and stored only as a hash.
 */
export async function createManualClient(
  db: D1Database,
  principal: Principal,
  input: { name?: unknown; redirect_uris?: unknown; provider?: unknown }
): Promise<{ client_id: string; client_secret: string; integration_id: string }> {
  if (!principal.userId) throw new OAuthError('access_denied', 'Sign in first', 401)
  const redirectUris = readRedirectList(input.redirect_uris)
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) || null : null

  const byProvider: Record<string, string> = {
    CHATGPT: 'int_chatgpt',
    CLAUDE: 'int_claude',
    GEMINI: 'int_gemini',
    COPILOT: 'int_copilot'
  }
  const provider = typeof input.provider === 'string' ? input.provider.toUpperCase() : ''
  const integrationId = byProvider[provider] ?? integrationForClient(name, redirectUris)

  const id = prefixed('oac', ulid())
  const secret = randomToken(32)
  await run(
    db,
    `INSERT INTO oauth_clients
       (id, client_name, redirect_uris, secret_hash, token_endpoint_auth_method,
        integration_id, created_by_user_id, status, created_at)
     VALUES (?, ?, ?, ?, 'client_secret_post', ?, ?, 'ACTIVE', ?)`,
    [id, name, JSON.stringify(redirectUris), await hashClientSecret(secret), integrationId, principal.userId, nowIso()]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'USER',
    action: 'AI_CONNECT',
    targetType: 'integration',
    targetId: integrationId,
    metadata: { oauthClientId: id, manualClient: true }
  })

  return { client_id: id, client_secret: secret, integration_id: integrationId }
}

/**
 * Look up a client. A client_id that is an https URL is a Client ID Metadata
 * Document: it is fetched on first use and cached. `refresh` re-fetches a copy
 * older than a day, which the authorization endpoint asks for so a client's
 * changed redirect URIs or name reach the consent page; the token endpoint
 * uses the cached copy.
 */
export async function loadClient(
  db: D1Database,
  clientId: string,
  opts: { refresh?: boolean } = {}
): Promise<OAuthClientRow | null> {
  if (!clientId) return null
  if (isMetadataClientId(clientId)) return loadMetadataClient(db, clientId, opts.refresh === true)
  if (clientId.length > 200) return null
  const row = await first<OAuthClientRow>(db, `SELECT * FROM oauth_clients WHERE id = ?`, [clientId])
  return row && row.status === 'ACTIVE' ? row : null
}

// ---------------------------------------------------------------
// Client ID Metadata Documents
// ---------------------------------------------------------------

export const METADATA_DOCUMENT_TTL_SECONDS = 24 * 60 * 60
const METADATA_DOCUMENT_MAX_BYTES = 16 * 1024
const METADATA_FETCH_TIMEOUT_MS = 5000

/** An https URL with a path, per the CIMD draft; anything else is a plain id. */
export function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://') || clientId.length > 2000) return false
  try {
    const url = new URL(clientId)
    return url.pathname !== '/' && !url.hash && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * Refuse hosts that are not public DNS names. Workers cannot reach private
 * networks anyway; this keeps the fetch from being pointed at literal IPs or
 * internal-looking names at all.
 */
function publicHost(host: string): boolean {
  const h = host.toLowerCase()
  if (!h.includes('.') || h.startsWith('[')) return false
  if (/^[0-9.]+$/.test(h)) return false
  return !/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(h)
}

async function fetchMetadataDocument(clientId: string): Promise<Record<string, unknown>> {
  return fetchPublicJson(clientId, 'client metadata document')
}

async function fetchPublicJson(target: string, what: string): Promise<Record<string, unknown>> {
  const url = new URL(target)
  if (url.protocol !== 'https:' || !publicHost(url.hostname)) {
    throw new OAuthError('invalid_client', `The ${what} URL must be https on a public host`)
  }
  const clientId = target
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(clientId, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal
    })
  } catch {
    throw new OAuthError('invalid_client', `Could not fetch the ${what}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status !== 200) {
    throw new OAuthError('invalid_client', `The ${what} returned HTTP ${res.status}`)
  }
  const text = await res.text()
  if (text.length > METADATA_DOCUMENT_MAX_BYTES) {
    throw new OAuthError('invalid_client', `The ${what} is too large`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new OAuthError('invalid_client', `The ${what} is not JSON`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new OAuthError('invalid_client', `The ${what} must be a JSON object`)
  }
  return doc as Record<string, unknown>
}

/**
 * Validate a fetched document. The document must name itself (client_id equal
 * to the URL it was fetched from). Being public, it can't carry a secret, so it
 * describes either a public client (PKCE is its proof of possession, as with
 * DCR) or one that signs a JWT with a key published in the document
 * (private_key_jwt, which ChatGPT uses).
 */
export function readMetadataDocument(
  clientId: string,
  doc: Record<string, unknown>
): { clientName: string | null; redirectUris: string[]; authMethod: 'none' | 'private_key_jwt' } {
  if (doc.client_id !== clientId) {
    throw new OAuthError('invalid_client', 'client_id in the metadata document does not match its URL')
  }
  const method = doc.token_endpoint_auth_method ?? 'none'
  if (method !== 'none' && method !== 'private_key_jwt') {
    throw new OAuthError(
      'invalid_client',
      'Metadata documents must use token_endpoint_auth_method "none" or "private_key_jwt"'
    )
  }
  if (method === 'private_key_jwt' && typeof doc.jwks_uri !== 'string' && !isJwkSet(doc.jwks)) {
    throw new OAuthError('invalid_client', 'private_key_jwt needs jwks_uri or jwks in the metadata document')
  }
  if (doc.client_secret !== undefined) {
    throw new OAuthError('invalid_client', 'A metadata document must not contain a client_secret')
  }
  const redirectUris = readRedirectList(doc.redirect_uris)
  const clientName =
    typeof doc.client_name === 'string' ? doc.client_name.trim().slice(0, 120) || null : null
  return { clientName, redirectUris, authMethod: method }
}

async function loadMetadataClient(
  db: D1Database,
  clientId: string,
  refresh: boolean
): Promise<OAuthClientRow | null> {
  const cached = await first<OAuthClientRow & { metadata_fetched_at: string | null }>(
    db,
    `SELECT * FROM oauth_clients WHERE id = ?`,
    [clientId]
  )
  if (cached && cached.status !== 'ACTIVE') return null
  const fresh =
    cached?.metadata_fetched_at &&
    Date.now() - Date.parse(cached.metadata_fetched_at) < METADATA_DOCUMENT_TTL_SECONDS * 1000
  if (cached && (fresh || !refresh)) return cached

  let parsed: ReturnType<typeof readMetadataDocument>
  try {
    parsed = readMetadataDocument(clientId, await fetchMetadataDocument(clientId))
  } catch (err) {
    // A client whose document is briefly unreachable keeps signing in with
    // the copy it already has; a client never seen before cannot.
    if (cached) return cached
    throw err
  }

  // The URL's host is fetched, not claimed, so it counts as a redirect host
  // when deciding which connector the client belongs to.
  const integrationId = integrationForClient(parsed.clientName, [clientId, ...parsed.redirectUris])
  const now = nowIso()
  await run(
    db,
    `INSERT INTO oauth_clients
       (id, client_name, redirect_uris, secret_hash, token_endpoint_auth_method,
        integration_id, created_by_user_id, status, created_at, metadata_fetched_at)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, 'ACTIVE', ?, ?)
     ON CONFLICT(id) DO UPDATE SET client_name = excluded.client_name,
       redirect_uris = excluded.redirect_uris, integration_id = excluded.integration_id,
       token_endpoint_auth_method = excluded.token_endpoint_auth_method,
       metadata_fetched_at = excluded.metadata_fetched_at`,
    [clientId, parsed.clientName, JSON.stringify(parsed.redirectUris), parsed.authMethod, integrationId, now, now]
  )
  return first<OAuthClientRow>(db, `SELECT * FROM oauth_clients WHERE id = ?`, [clientId])
}

/**
 * Authenticate the client at the token endpoint. A public client proves
 * nothing here (PKCE does that); a confidential client must present its
 * secret, by POST body or HTTP Basic; a private_key_jwt metadata client signs
 * a client_assertion with a key from its document.
 */
export async function authenticateClient(
  db: D1Database,
  form: Record<string, string>,
  authorizationHeader: string | undefined,
  endpoint = ''
): Promise<OAuthClientRow> {
  let clientId = form.client_id ?? ''
  let secret = form.client_secret ?? ''
  const assertion = form.client_assertion ?? ''
  if (!clientId && assertion) clientId = jwtClaims(assertion)?.sub ?? ''

  if (authorizationHeader && /^basic\s+/i.test(authorizationHeader)) {
    try {
      const decoded = atob(authorizationHeader.replace(/^basic\s+/i, '').trim())
      const idx = decoded.indexOf(':')
      if (idx > 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx))
        secret = decodeURIComponent(decoded.slice(idx + 1))
      }
    } catch {
      throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401)
    }
  }

  const client = await loadClient(db, clientId)
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401)

  if (client.token_endpoint_auth_method === 'private_key_jwt') {
    await verifyClientAssertion(client.id, form, endpoint)
  } else if (client.secret_hash) {
    if (!secret) throw new OAuthError('invalid_client', 'Client secret required', 401)
    const presented = await hashClientSecret(secret)
    if (!timingSafeEqual(presented, client.secret_hash)) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401)
    }
  }
  return client
}

// ---------------------------------------------------------------
// private_key_jwt (RFC 7523 client assertions)
// ---------------------------------------------------------------

const JWT_ALGS = ['RS256', 'ES256']
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const ASSERTION_MAX_AGE_SECONDS = 10 * 60

interface JwtClaims {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
}

function isJwkSet(v: unknown): v is { keys: JsonWebKey[] } {
  return !!v && typeof v === 'object' && Array.isArray((v as { keys?: unknown }).keys)
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

function b64urlJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T
  } catch {
    return null
  }
}

function jwtClaims(jwt: string): JwtClaims | null {
  const parts = jwt.split('.')
  return parts.length === 3 ? b64urlJson<JwtClaims>(parts[1]) : null
}

/**
 * Check a client_assertion: signed by a key in the client's metadata document
 * (re-fetched, so key rotation is picked up), naming the client as iss and sub
 * and this endpoint as audience, and not expired.
 */
async function verifyClientAssertion(clientId: string, form: Record<string, string>, endpoint: string) {
  const fail = (why: string): never => {
    throw new OAuthError('invalid_client', `Client assertion rejected: ${why}`, 401)
  }
  if (form.client_assertion_type !== JWT_BEARER || !form.client_assertion) fail('missing client_assertion')
  const [h, p, sig] = form.client_assertion.split('.')
  if (!h || !p || !sig) fail('malformed JWT')
  const header = b64urlJson<{ alg?: string; kid?: string }>(h)
  const claims = b64urlJson<JwtClaims>(p)
  if (!header || !claims) fail('malformed JWT')
  if (!header!.alg || !JWT_ALGS.includes(header!.alg)) fail(`unsupported alg ${header!.alg}`)
  if (claims!.iss !== clientId || claims!.sub !== clientId) fail('iss and sub must be the client_id')
  const aud = Array.isArray(claims!.aud) ? claims!.aud : [claims!.aud]
  const issuer = endpoint ? new URL(endpoint).origin : ''
  if (endpoint && !aud.some((a) => a === endpoint || a === issuer)) fail('wrong audience')
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims!.exp !== 'number' || claims!.exp < now - 30 || claims!.exp > now + ASSERTION_MAX_AGE_SECONDS) {
    fail('expired or too long-lived')
  }

  const doc = await fetchMetadataDocument(clientId)
  const published: unknown = isJwkSet(doc.jwks)
    ? doc.jwks
    : typeof doc.jwks_uri === 'string'
      ? await fetchPublicJson(doc.jwks_uri, 'JWKS')
      : null
  if (!isJwkSet(published)) return fail('no keys published')
  const rsa = header!.alg === 'RS256'
  const candidates = published.keys.filter(
    (k: JsonWebKey & { kid?: string }) => k.kty === (rsa ? 'RSA' : 'EC') && (!header!.kid || (k as { kid?: string }).kid === header!.kid)
  )
  const data = new TextEncoder().encode(`${h}.${p}`)
  const signature = b64urlBytes(sig)
  for (const jwk of candidates) {
    try {
      const { kid: _kid, use: _use, alg: _alg, key_ops: _ops, ...material } = jwk as JsonWebKey & {
        kid?: string
        use?: string
      }
      const key = await crypto.subtle.importKey(
        'jwk',
        material,
        rsa ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      )
      const ok = await crypto.subtle.verify(
        rsa ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signature,
        data
      )
      if (ok) return
    } catch {
      // Try the next key.
    }
  }
  fail('signature does not match a published key')
}

// ---------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------

/**
 * Unknown scopes are dropped rather than rejected: clients add their own
 * (`offline_access`, `openid`), and failing the whole sign-in over one would
 * strand the user on an error page.
 */
export function parseScopes(raw: string | null | undefined): AiScope[] {
  if (!raw || !raw.trim()) return [...DEFAULT_OAUTH_SCOPES]
  const out: AiScope[] = []
  for (const s of raw.split(/\s+/)) {
    if (AI_SCOPES.includes(s as AiScope) && !out.includes(s as AiScope)) out.push(s as AiScope)
  }
  return out.length ? out : [...DEFAULT_OAUTH_SCOPES]
}

// ---------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------

export interface AuthorizeRequest {
  client: OAuthClientRow
  redirectUri: string
  state: string | null
  codeChallenge: string | null
  scopes: AiScope[]
  resource: string | null
}

/**
 * Validate an authorization request. Errors that make the redirect URI
 * untrustworthy are thrown as `redirectable: false` and shown on our own page;
 * everything else is sent back to the client per RFC 6749 §4.1.2.1.
 */
export async function validateAuthorizeRequest(
  db: D1Database,
  params: Record<string, string | undefined>,
  origin: string
): Promise<AuthorizeRequest> {
  let client: OAuthClientRow | null
  try {
    client = await loadClient(db, params.client_id ?? '', { refresh: true })
  } catch (err) {
    throw Object.assign(err instanceof OAuthError ? err : new OAuthError('invalid_client', 'Unknown client'), {
      redirectable: false
    })
  }
  if (!client) throw Object.assign(new OAuthError('invalid_client', 'Unknown client'), { redirectable: false })

  const registered = parseRedirects(client)
  const redirectUri = params.redirect_uri ?? (registered.length === 1 ? registered[0] : '')
  if (!redirectUri || !redirectMatches(registered, redirectUri)) {
    throw Object.assign(new OAuthError('invalid_request', 'redirect_uri is not registered for this client'), {
      redirectable: false
    })
  }

  const base = { redirectUri, state: params.state ?? null }

  if (params.response_type !== 'code') {
    throw Object.assign(new OAuthError('unsupported_response_type', 'Only response_type=code is supported'), base)
  }

  const challenge = params.code_challenge ?? null
  const method = params.code_challenge_method ?? (challenge ? 'plain' : null)
  if (challenge) {
    if (method !== 'S256') {
      throw Object.assign(new OAuthError('invalid_request', 'code_challenge_method must be S256'), base)
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge)) {
      throw Object.assign(new OAuthError('invalid_request', 'Malformed code_challenge'), base)
    }
  } else if (!client.secret_hash) {
    // Public clients have no other proof of possession.
    throw Object.assign(new OAuthError('invalid_request', 'PKCE code_challenge is required'), base)
  }

  // RFC 8707: a client that names a resource must name this one.
  const resource = params.resource ?? null
  if (resource && !sameResource(resource, origin)) {
    throw Object.assign(new OAuthError('invalid_target', 'Unknown resource'), base)
  }

  return {
    client,
    redirectUri,
    state: params.state ?? null,
    codeChallenge: challenge,
    scopes: parseScopes(params.scope),
    resource
  }
}

function sameResource(resource: string, origin: string): boolean {
  const trimmed = resource.replace(/\/+$/, '')
  return trimmed === origin || trimmed === `${origin}${MCP_PATH}`
}

export async function issueCode(
  db: D1Database,
  req: AuthorizeRequest,
  userId: string,
  scopes: AiScope[]
): Promise<string> {
  const code = randomToken(32)
  const now = Date.now()
  await run(
    db,
    `INSERT INTO oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource,
        expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      await hashCode(code),
      req.client.id,
      userId,
      req.redirectUri,
      req.codeChallenge ?? '',
      JSON.stringify(scopes),
      req.resource,
      new Date(now + CODE_TTL_SECONDS * 1000).toISOString(),
      new Date(now).toISOString()
    ]
  )
  // Housekeeping: codes are tiny and short-lived, so expired ones are reaped
  // on the issuing path instead of needing a cron.
  await run(db, `DELETE FROM oauth_codes WHERE expires_at < ?`, [
    new Date(now - 24 * 3600 * 1000).toISOString()
  ]).catch(() => {})
  return code
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

async function mintTokens(): Promise<{
  access: string
  accessHash: string
  refresh: string
  refreshHash: string
  expiresAt: string
  refreshExpiresAt: string
}> {
  const access = randomToken(32)
  const refresh = randomToken(32)
  return {
    access,
    accessHash: await hashGrantToken(access),
    refresh,
    refreshHash: await hashRefresh(refresh),
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400 * 1000).toISOString()
  }
}

export async function exchangeCode(
  env: Env,
  client: OAuthClientRow,
  form: Record<string, string>
): Promise<TokenResponse> {
  const db = env.DB
  const code = form.code ?? ''
  if (!code) throw new OAuthError('invalid_request', 'code is required')

  const row = await first<{
    code_hash: string
    client_id: string
    user_id: string
    redirect_uri: string
    code_challenge: string
    scopes: string
    expires_at: string
    used_at: string | null
  }>(db, `SELECT * FROM oauth_codes WHERE code_hash = ?`, [await hashCode(code)])

  if (!row || row.client_id !== client.id) throw new OAuthError('invalid_grant', 'Unknown authorization code')
  if (row.used_at) throw new OAuthError('invalid_grant', 'Authorization code already used')
  if (Date.parse(row.expires_at) <= Date.now()) throw new OAuthError('invalid_grant', 'Authorization code expired')

  // Mark used before anything else so a replay racing this request loses.
  await run(db, `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`, [
    nowIso(),
    row.code_hash
  ])

  if (form.redirect_uri && form.redirect_uri !== row.redirect_uri) {
    throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
  }

  if (row.code_challenge) {
    const verifier = form.code_verifier ?? ''
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
      throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed')
    }
    if (!timingSafeEqual(await s256(verifier), row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed')
    }
  } else if (!client.secret_hash) {
    throw new OAuthError('invalid_grant', 'PKCE is required')
  }

  const user = await first<{ id: string; status: string }>(db, `SELECT id, status FROM users WHERE id = ?`, [
    row.user_id
  ])
  if (!user || user.status !== 'ACTIVE') throw new OAuthError('invalid_grant', 'User is not active')

  let scopes: AiScope[] = []
  try {
    scopes = JSON.parse(row.scopes)
  } catch {
    scopes = []
  }

  // One live grant per user per client: re-authorizing the same app replaces
  // its previous tokens, but never touches another app's (claude.ai and Claude
  // Code are separate clients even though both are "Claude").
  await run(
    db,
    `UPDATE integration_grants SET status = 'REVOKED', revoked_at = ?
      WHERE user_id = ? AND oauth_client_id = ? AND status = 'ACTIVE'`,
    [nowIso(), row.user_id, client.id]
  )

  const t = await mintTokens()
  const grantId = prefixed('grt', ulid())
  await run(
    db,
    `INSERT INTO integration_grants
       (id, integration_id, user_id, organization_id, scopes, token_hash, token_prefix,
        status, created_at, last_used_at, revoked_at,
        expires_at, refresh_token_hash, refresh_expires_at, oauth_client_id, kind)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, ?, ?, ?, ?, 'OAUTH')`,
    [
      grantId,
      client.integration_id,
      row.user_id,
      JSON.stringify(scopes),
      t.accessHash,
      tokenPrefix(t.access),
      nowIso(),
      t.expiresAt,
      t.refreshHash,
      t.refreshExpiresAt,
      client.id
    ]
  )

  await recordAudit(db, {
    actorUserId: row.user_id,
    actorType: 'USER',
    action: 'AI_CONNECT',
    targetType: 'integration',
    targetId: client.integration_id,
    metadata: { oauthClientId: client.id, clientName: client.client_name, scopes, grantId }
  })

  return {
    access_token: t.access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: t.refresh,
    scope: scopes.join(' ')
  }
}

export async function refreshGrant(
  env: Env,
  client: OAuthClientRow,
  form: Record<string, string>
): Promise<TokenResponse> {
  const db = env.DB
  const presented = form.refresh_token ?? ''
  if (!presented) throw new OAuthError('invalid_request', 'refresh_token is required')

  const grant = await first<{
    id: string
    user_id: string
    scopes: string
    status: string
    refresh_expires_at: string | null
    oauth_client_id: string | null
  }>(
    db,
    `SELECT id, user_id, scopes, status, refresh_expires_at, oauth_client_id
       FROM integration_grants WHERE refresh_token_hash = ?`,
    [await hashRefresh(presented)]
  )

  // Disconnecting in Settings revokes the grant, which is what makes a refresh
  // fail and the client ask the user to sign in again.
  if (!grant || grant.status !== 'ACTIVE' || grant.oauth_client_id !== client.id) {
    throw new OAuthError('invalid_grant', 'Refresh token is not valid')
  }
  if (!grant.refresh_expires_at || Date.parse(grant.refresh_expires_at) <= Date.now()) {
    throw new OAuthError('invalid_grant', 'Refresh token expired')
  }

  let scopes: AiScope[] = []
  try {
    scopes = JSON.parse(grant.scopes)
  } catch {
    scopes = []
  }
  // A refresh may narrow scope, never widen it.
  if (form.scope) {
    const asked = parseScopes(form.scope)
    scopes = scopes.filter((s) => asked.includes(s))
  }

  const t = await mintTokens()
  await run(
    db,
    `UPDATE integration_grants
        SET token_hash = ?, token_prefix = ?, expires_at = ?,
            refresh_token_hash = ?, refresh_expires_at = ?, scopes = ?
      WHERE id = ? AND status = 'ACTIVE'`,
    [t.accessHash, tokenPrefix(t.access), t.expiresAt, t.refreshHash, t.refreshExpiresAt, JSON.stringify(scopes), grant.id]
  )

  return {
    access_token: t.access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: t.refresh,
    scope: scopes.join(' ')
  }
}

/** RFC 7009: revoking either token ends the whole grant. Always "succeeds". */
export async function revokeToken(env: Env, client: OAuthClientRow, token: string): Promise<void> {
  if (!token) return
  const db = env.DB
  const accessHash = await hashGrantToken(token)
  const refreshHash = await hashRefresh(token)
  await run(
    db,
    `UPDATE integration_grants SET status = 'REVOKED', revoked_at = ?
      WHERE oauth_client_id = ? AND status = 'ACTIVE'
        AND (token_hash = ? OR refresh_token_hash = ?)`,
    [nowIso(), client.id, accessHash, refreshHash]
  )
}
