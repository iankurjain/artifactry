/**
 * OAuth 2.1 endpoints for AI connectors (see lib/oauth.ts for the model).
 *
 *   GET  /.well-known/oauth-protected-resource[/api/v1/mcp]  → RFC 9728
 *   GET  /.well-known/oauth-authorization-server            → RFC 8414
 *   POST /oauth/register                                     → RFC 7591 (public clients)
 *   GET  /oauth/authorize                                    → sign-in + consent page
 *   POST /oauth/authorize                                    → approve / deny
 *   POST /oauth/token                                        → code + refresh grants
 *   POST /oauth/revoke                                       → RFC 7009
 *
 * The consent page is server-rendered and self-contained rather than a SPA
 * route: it is opened in a popup by another company's app, has to work
 * before the SPA's assets load, and should carry its own tight CSP.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit } from '../middleware'
import {
  OAuthError,
  authenticateClient,
  authorizationServerMetadata,
  exchangeCode,
  issueCode,
  protectedResourceMetadata,
  refreshGrant,
  registerClient,
  revokeToken,
  validateAuthorizeRequest,
  type AuthorizeRequest
} from '../lib/oauth'
import type { AiScope } from '../types'
import { randomToken } from '../lib/ids'

const oauth = new Hono<AppEnv>()

// Discovery, registration and token calls come from other companies' servers
// and, for some clients, from a browser. None of them carries a cookie.
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version'],
  credentials: false,
  maxAge: 600
})
oauth.use('/.well-known/*', openCors)
oauth.use('/oauth/register', openCors)
oauth.use('/oauth/token', openCors)
oauth.use('/oauth/revoke', openCors)

function originOf(c: Context): string {
  return new URL(c.req.url).origin
}

function noStore(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
}

function oauthError(c: Context, err: unknown) {
  noStore(c)
  if (err instanceof OAuthError) {
    if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="artifactry"')
    return c.json({ error: err.code, error_description: err.message }, err.status as 400)
  }
  console.error('[oauth]', err instanceof Error ? err.message : err)
  return c.json({ error: 'server_error', error_description: 'Unexpected error' }, 500)
}

// ---------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------

const prm = (c: Context) => {
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(protectedResourceMetadata(originOf(c)))
}
oauth.get('/.well-known/oauth-protected-resource', prm)
oauth.get('/.well-known/oauth-protected-resource/api/v1/mcp', prm)

const asm = (c: Context) => {
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(authorizationServerMetadata(originOf(c)))
}
oauth.get('/.well-known/oauth-authorization-server', asm)
// Path-suffixed form some clients try first (RFC 8414 §3.1 with an issuer path).
oauth.get('/.well-known/oauth-authorization-server/api/v1/mcp', asm)

// ---------------------------------------------------------------
// Dynamic Client Registration
// ---------------------------------------------------------------

// Registration and token calls arrive from each AI provider's shared egress
// addresses, so these per-IP budgets are sized for many users behind one IP.
oauth.post(
  '/oauth/register',
  rateLimit({ bucket: 'oauth:register', limit: 300, windowSeconds: 3600 }),
  async (c) => {
    try {
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        throw new OAuthError('invalid_client_metadata', 'Body must be JSON')
      }
      const registered = await registerClient(c.env.DB, body ?? {})
      noStore(c)
      return c.json(registered, 201)
    } catch (err) {
      return oauthError(c, err)
    }
  }
)

// ---------------------------------------------------------------
// Authorization: sign-in + consent
// ---------------------------------------------------------------

const SCOPE_LABELS: Record<AiScope, string> = {
  'artifact.read': 'Search and read your artifacts',
  'artifact.write': 'Save new artifacts, add versions and tags',
  'artifact.share': 'Create and revoke share links (outside-org shares still ask you first)',
  'artifact.analytics.read': 'Read view and download analytics',
  'workspace.read': 'List your workspaces',
  'team.read': 'List your teams',
  'tags.read': 'List your tags',
  'profile.read': 'Read your name and email'
}

const CLIENT_LABELS: Record<string, string> = {
  int_chatgpt: 'ChatGPT',
  int_claude: 'Claude',
  int_gemini: 'Gemini',
  int_copilot: 'Microsoft Copilot',
  int_other: 'An AI app'
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(
  c: Context,
  opts: { title: string; body: string; nonce?: string; formAction?: string; status?: number }
) {
  const formAction = ["'self'", ...(opts.formAction ? [opts.formAction] : [])].join(' ')
  const csp = [
    "default-src 'none'",
    opts.nonce ? `script-src 'nonce-${opts.nonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    `form-action ${formAction}`,
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(opts.title)} · Artifactry</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 16px; background: #f5f6f2; color: #12151c;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { max-width: 440px; margin: 0 auto; background: #fff; border: 1px solid #e2e4da;
    border-radius: 14px; padding: 24px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { font-size: 14px; line-height: 1.55; color: #3d434a; margin: 0 0 14px; }
  ul { padding-left: 18px; margin: 0 0 18px; font-size: 14px; line-height: 1.6; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input[type=email], input[type=text] { width: 100%; min-height: 42px; padding: 0 12px;
    border: 1px solid #cfd2c7; border-radius: 10px; font-size: 15px; }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  button { flex: 1; min-height: 44px; border-radius: 10px; font-size: 14.5px; font-weight: 600;
    border: 1px solid #12151c; background: #12151c; color: #fff; cursor: pointer; }
  button.secondary { background: #fff; color: #12151c; border-color: #cfd2c7; }
  .muted { font-size: 12.5px; color: #6a7076; }
  .err { color: #a3261b; font-size: 13px; min-height: 18px; margin-top: 8px; }
</style></head>
<body><main class="card">${opts.body}</main></body></html>`
  c.header('Content-Security-Policy', csp)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(html, (opts.status ?? 200) as 200)
}

function redirectWith(c: Context, redirectUri: string, params: Record<string, string | null>) {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v)
  noStore(c)
  return c.redirect(url.toString(), 302)
}

async function handleAuthorizeError(c: Context, err: unknown) {
  const e = err as OAuthError & { redirectable?: boolean; redirectUri?: string; state?: string | null }
  if (e instanceof OAuthError && e.redirectable !== false && e.redirectUri) {
    return redirectWith(c, e.redirectUri, {
      error: e.code,
      error_description: e.message,
      state: e.state ?? null,
      iss: originOf(c)
    })
  }
  const message = e instanceof OAuthError ? e.message : 'Something went wrong'
  if (!(e instanceof OAuthError)) console.error('[oauth/authorize]', err)
  return page(c, {
    title: 'Cannot connect',
    status: 400,
    body: `<h1>This connection request is not valid</h1><p>${esc(message)}</p>
<p class="muted">Go back to the AI app and start connecting Artifactry again.</p>`
  })
}

function hiddenFields(params: Record<string, string | undefined>): string {
  const keys = [
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'scope',
    'code_challenge',
    'code_challenge_method',
    'resource'
  ]
  return keys
    .filter((k) => params[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k]!)}">`)
    .join('')
}

function signInPage(c: Context, clientLabel: string) {
  const nonce = randomToken(16)
  return page(c, {
    title: 'Sign in',
    nonce,
    body: `<h1>Sign in to connect ${esc(clientLabel)}</h1>
<p>${esc(clientLabel)} wants to use your Artifactry library. Sign in first; you will then choose what it may do.</p>
<form id="f-email">
  <label for="email">Work email</label>
  <input id="email" type="email" autocomplete="email" required>
  <div class="row"><button type="submit">Email me a code</button></div>
</form>
<form id="f-code" hidden>
  <label for="code">6-digit code</label>
  <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" required>
  <div class="row"><button type="submit">Sign in</button></div>
  <p class="muted" id="dev"></p>
</form>
<div class="err" id="err" role="alert"></div>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id)
  let email = ''
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.ok === false) throw new Error(j.message || 'Something went wrong')
    return j.data || {}
  }
  $('f-email').addEventListener('submit', async (e) => {
    e.preventDefault(); $('err').textContent = ''
    email = $('email').value.trim()
    try {
      const d = await post('/api/v1/auth/request-code', { email })
      $('f-email').hidden = true; $('f-code').hidden = false; $('code').focus()
      if (d.devCode) $('dev').textContent = 'Development mode code: ' + d.devCode
    } catch (err) { $('err').textContent = err.message }
  })
  $('f-code').addEventListener('submit', async (e) => {
    e.preventDefault(); $('err').textContent = ''
    try {
      await post('/api/v1/auth/verify-code', { email, code: $('code').value.trim() })
      location.reload()
    } catch (err) { $('err').textContent = err.message }
  })
})()
</script>`
  })
}

function consentPage(
  c: Context,
  req: AuthorizeRequest,
  params: Record<string, string | undefined>,
  email: string
) {
  const clientLabel = CLIENT_LABELS[req.client.integration_id] ?? 'An AI app'
  const reported = req.client.client_name && req.client.client_name !== clientLabel ? req.client.client_name : null
  const redirectHost = new URL(req.redirectUri).host
  const scopes = req.scopes.map((s) => `<li>${esc(SCOPE_LABELS[s] ?? s)}</li>`).join('')
  return page(c, {
    title: `Connect ${clientLabel}`,
    formAction: new URL(req.redirectUri).origin,
    body: `<h1>Connect ${esc(clientLabel)} to Artifactry?</h1>
<p>Signed in as <strong>${esc(email)}</strong>. ${esc(clientLabel)}${reported ? ` (reports itself as “${esc(reported)}”)` : ''} will be able to:</p>
<ul>${scopes}</ul>
<p class="muted">It can never do more than you can, and you can disconnect it any time in Artifactry Settings. After you approve, you return to <strong>${esc(redirectHost)}</strong>.</p>
<form method="post" action="/oauth/authorize">
  ${hiddenFields(params)}
  <div class="row">
    <button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
    <button type="submit" name="decision" value="approve">Allow</button>
  </div>
</form>`
  })
}

function authorizeParams(source: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const k of [
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'scope',
    'code_challenge',
    'code_challenge_method',
    'resource'
  ]) {
    const v = source[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}

oauth.get(
  '/oauth/authorize',
  guarded(async (c) => {
    const params = authorizeParams(c.req.query())
    let req: AuthorizeRequest
    try {
      req = await validateAuthorizeRequest(c.env.DB, params, originOf(c))
    } catch (err) {
      return handleAuthorizeError(c, err)
    }

    const principal = c.get('principal')
    if (principal?.kind !== 'SESSION' || !principal.user) {
      return signInPage(c, CLIENT_LABELS[req.client.integration_id] ?? 'An AI app')
    }
    return consentPage(c, req, params, principal.user.email)
  })
)

oauth.post(
  '/oauth/authorize',
  rateLimit({ bucket: 'oauth:authorize', limit: 60, windowSeconds: 600 }),
  guarded(async (c) => {
    // CSRF: the session cookie is SameSite=Lax, so a cross-site form POST
    // arrives without it and fails the session check below. The Origin check
    // is a second, independent guard for browsers that send it.
    const requestOrigin = c.req.header('Origin')
    if (requestOrigin && requestOrigin !== 'null' && requestOrigin !== originOf(c)) {
      return page(c, { title: 'Cannot connect', status: 403, body: '<h1>Request blocked</h1><p>Start again from the AI app.</p>' })
    }

    const form = (await c.req.parseBody()) as Record<string, unknown>
    const params = authorizeParams(form)
    let req: AuthorizeRequest
    try {
      req = await validateAuthorizeRequest(c.env.DB, params, originOf(c))
    } catch (err) {
      return handleAuthorizeError(c, err)
    }

    const principal = c.get('principal')
    if (principal?.kind !== 'SESSION' || !principal.userId) {
      return signInPage(c, CLIENT_LABELS[req.client.integration_id] ?? 'An AI app')
    }

    if (form.decision !== 'approve') {
      return redirectWith(c, req.redirectUri, {
        error: 'access_denied',
        error_description: 'The user declined',
        state: req.state,
        iss: originOf(c)
      })
    }

    const code = await issueCode(c.env.DB, req, principal.userId, req.scopes)
    return redirectWith(c, req.redirectUri, { code, state: req.state, iss: originOf(c) })
  })
)

// ---------------------------------------------------------------
// Token + revocation
// ---------------------------------------------------------------

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = (c.req.header('Content-Type') ?? '').toLowerCase()
  const out: Record<string, string> = {}
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === 'string') out[k] = v
    return out
  }
  const body = await c.req.parseBody().catch(() => ({}))
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
  return out
}

oauth.post(
  '/oauth/token',
  rateLimit({ bucket: 'oauth:token', limit: 1200, windowSeconds: 600 }),
  async (c) => {
    try {
      const form = await readForm(c)
      const client = await authenticateClient(c.env.DB, form, c.req.header('Authorization'))
      let tokens
      if (form.grant_type === 'authorization_code') tokens = await exchangeCode(c.env, client, form)
      else if (form.grant_type === 'refresh_token') tokens = await refreshGrant(c.env, client, form)
      else throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
      noStore(c)
      return c.json(tokens)
    } catch (err) {
      return oauthError(c, err)
    }
  }
)

oauth.post('/oauth/revoke', async (c) => {
  try {
    const form = await readForm(c)
    const client = await authenticateClient(c.env.DB, form, c.req.header('Authorization'))
    await revokeToken(c.env, client, form.token ?? '')
    noStore(c)
    return c.body(null, 200)
  } catch (err) {
    return oauthError(c, err)
  }
})

export default oauth
