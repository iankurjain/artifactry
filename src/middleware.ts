/**
 * Cross-cutting middleware: security headers, surface gating, principal
 * resolution, rate limiting and cache policy.
 *
 * Note on caching: every response under /api carries `no-store` because
 * responses are authorization-scoped. A shared cache holding one user's
 * artifact list and serving it to another would be a cross-tenant leak
 * (PRD §64) — so caching is disabled rather than carefully keyed.
 *
 * Note on surfaces: one deployment answers on two origins. The application
 * origin serves the app; the isolated preview origin serves only HTML preview
 * documents. `previewSurfaceGate` keeps those disjoint, so an artifact document
 * can never be requested from the application origin.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import type { Env, Principal } from './types'
import { resolvePrincipal, EMPTY_PRINCIPAL } from './lib/principal'
import { classifyRequest } from './lib/htmlpreview'
import { clientIp, fail, HttpError, unauthorized } from './lib/http'
import type { ShareDomainContext } from './lib/sharedomains'
import { activeShareDomainByHost, edgeForwardedHost, isShareDomainPath } from './lib/sharedomains'

export type AppEnv = {
  Bindings: Env
  Variables: { principal: Principal; shareDomain?: ShareDomainContext }
}

/**
 * Serve a customer's share domain, and nothing else on it.
 *
 * A request forwarded by the share-edge Worker (proven by SHARE_EDGE_SECRET)
 * names the customer hostname it arrived on. That hostname must be an ACTIVE
 * share domain, and the path must be part of the recipient surface; anything
 * else is a bare 404. Sign-in, the library and the rest of the API exist only
 * on the application origin, so a session cookie is never set on, or sent to,
 * a customer's domain.
 *
 * Requests without a valid edge secret are ordinary app requests and pass
 * through untouched, whatever headers they carry.
 */
export const shareDomainGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const forwarded = edgeForwardedHost(c.env, (name) => c.req.header(name))
  if (!forwarded) {
    await next()
    return
  }

  const domain = await activeShareDomainByHost(c.env.DB, forwarded.hostname)
  if (!domain || !isShareDomainPath(c.req.method, c.req.path)) return surfaceNotFound()

  c.set('shareDomain', {
    hostname: domain.hostname,
    origin: `https://${domain.hostname}`,
    workspaceId: domain.workspace_id,
    clientIp: forwarded.clientIp
  })
  await next()
}

/**
 * Keep the two origins disjoint.
 *
 * The isolated origin exists so that script-executing HTML never shares an
 * origin with the application. Page routes are compiled into one Worker and
 * both hostnames reach it, so the separation has to be enforced here rather
 * than by DNS alone:
 *
 *   * on the preview origin, only /p/* (and a liveness probe) exist — no app
 *     shell, no API, no auth surface, so there is nothing there to abuse;
 *   * on the application origin, /p/* does not exist at all, so a preview
 *     document cannot be fetched from the origin that holds the session cookie.
 *
 * With no PREVIEW_ORIGIN configured, `classifyRequest` reports 'APP' for every
 * request and /p/* is uniformly 404 — the isolated surface simply is not there.
 */
export const previewSurfaceGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const surface = classifyRequest(c.env, c.req.url, c.req.header('Host'))

  if (surface === 'PREVIEW') {
    if (c.req.path.startsWith('/p/') || c.req.path === '/api/health') {
      await next()
      return
    }
    return surfaceNotFound()
  }

  if (c.req.path.startsWith('/p/')) return surfaceNotFound()

  await next()
}

/**
 * A hard 404 for a path that does not exist on this surface.
 *
 * Deliberately NOT `c.notFound()`: the application has a notFound handler that
 * renders the SPA shell for deep links, and on the application origin that would
 * answer /p/* with 200 + HTML. Falling through to the shell would make a path
 * that must not exist look like a working route. A bare 404 keeps the two
 * origins genuinely disjoint.
 */
function surfaceNotFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

/** Resolve the caller once per request and expose it as c.get('principal'). */
export const withPrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  // The preview origin has no credentials by construction: cookies are
  // host-only, so none are sent. Skip resolution entirely rather than run it
  // and rely on that — it makes the isolation explicit and keeps any future
  // credential-accepting change from silently applying there.
  if (classifyRequest(c.env, c.req.url, c.req.header('Host')) === 'PREVIEW') {
    c.set('principal', EMPTY_PRINCIPAL)
    await next()
    return
  }

  // A customer share domain is anonymous by construction too: only recipient
  // routes exist there, and they authorise by share token and grant cookie.
  if (c.get('shareDomain')) {
    c.set('principal', EMPTY_PRINCIPAL)
    await next()
    return
  }

  let principal: Principal = EMPTY_PRINCIPAL
  try {
    principal = await resolvePrincipal(c)
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      // An invalid Bearer token is a hard failure: silently falling back to
      // the cookie would let a broken connector ride a browser session.
      return fail(c, err)
    }
    console.error('[principal] resolution failed', err)
  }
  c.set('principal', principal)
  await next()
}

/** Baseline security headers applied to every response. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()

  const headers = c.res.headers
  const surface = classifyRequest(c.env, c.req.url, c.req.header('Host'))

  headers.set('X-Content-Type-Options', 'nosniff')

  if (surface === 'PREVIEW') {
    // The preview document MUST be frameable by the application origin; that is
    // its only reason to exist. Framing is narrowed by the document's own
    // `frame-ancestors`, which travels with the bytes and is checked per
    // request, so no X-Frame-Options is set here — the one value that would
    // allow a single cross-origin framer (ALLOW-FROM) is obsolete and ignored
    // by current browsers, so setting it could only break the legitimate case.
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
    )
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    headers.set('X-Robots-Tag', 'noindex, nofollow')
    headers.set('Cache-Control', 'private, no-store, max-age=0')
    return
  }

  // HTML previews are framed by our own pages inside a sandboxed iframe, so
  // they must remain frameable *by us*. `DENY` blocks framing even
  // same-origin, which is why the artifact preview could not render. SAMEORIGIN
  // narrows framing to our own documents only — combined with the sandbox
  // attribute (no allow-same-origin) and the document CSP the artifact still
  // never runs on the application origin.
  //
  // This branch now only applies to the fallback path where no isolated preview
  // origin is configured; when one is, the document is served from there and
  // this middleware never sees it.
  const isPreviewDocument = /\/preview$/.test(c.req.path)
  headers.set('X-Frame-Options', isPreviewDocument ? 'SAMEORIGIN' : 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  // includeSubDomains is ours to assert for artifactry.app, not for a
  // customer's hostname: it would bind every subdomain of share.acme.com.
  headers.set(
    'Strict-Transport-Security',
    c.get('shareDomain') ? 'max-age=31536000' : 'max-age=31536000; includeSubDomains'
  )
  // Cross-origin isolation for the app shell; the HTML preview endpoint
  // relaxes this deliberately via its own sandboxed document.
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')

  if (c.req.path.startsWith('/api/')) {
    headers.set('Cache-Control', 'private, no-store, max-age=0')
  }
}

/**
 * Fixed-window rate limiter.
 *
 * Cloudflare's Workers runtime has no built-in limiter on Pages, and D1 is the
 * only shared store available, so counters live in app_kv keyed by bucket +
 * window. This is deliberately coarse: it exists to blunt credential stuffing
 * and email-bombing, not to meter normal traffic.
 */
export function rateLimit(options: {
  bucket: string
  limit: number
  windowSeconds: number
  keyFrom?: (c: Context) => string
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = clientIp(c) ?? 'unknown'
    const key = options.keyFrom ? options.keyFrom(c) : ip
    const window = Math.floor(Date.now() / (options.windowSeconds * 1000))
    const bucketKey = `rl:${options.bucket}:${key}:${window}`

    try {
      const row = await c.env.DB.prepare(
        `INSERT INTO app_kv (key, value, updated_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
                                        updated_at = excluded.updated_at
         RETURNING value`
      )
        .bind(bucketKey, new Date().toISOString())
        .first<{ value: string }>()

      const used = Number(row?.value ?? '1')
      if (used > options.limit) {
        return fail(
          c,
          new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.')
        )
      }
    } catch (err) {
      // A limiter outage must not take the app down; log and continue.
      console.error('[ratelimit] counter failed', err)
    }

    await next()
  }
}

/** Require an authenticated principal, else 401. */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get('principal')
  if (!principal?.userId || !principal.user) throw unauthorized()
  return principal
}

/**
 * Require an authenticated AI grant (MCP / connector endpoints).
 * Also enforces the delegated-actor rule: no user, no grant (§59).
 */
export function requireAiPrincipal(c: Context<AppEnv>): Principal {
  const principal = requirePrincipal(c)
  if (principal.kind !== 'AI_GRANT') {
    throw unauthorized('This endpoint requires an AI access token')
  }
  return principal
}

/** Small helper so handlers can wrap their bodies with uniform error JSON. */
export function guarded(fn: (c: Context<AppEnv>) => Promise<Response> | Response) {
  return async (c: Context<AppEnv>, next: Next) => {
    try {
      return await fn(c)
    } catch (err) {
      if (err instanceof HttpError) return fail(c, err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[handler]', c.req.method, c.req.path, message)
      return fail(c, new HttpError(500, 'SERVER_ERROR', message))
    }
  }
}
