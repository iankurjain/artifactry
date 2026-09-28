/**
 * Cross-cutting middleware: security headers, principal resolution, rate
 * limiting and cache policy.
 *
 * Note on caching: every response under /api carries `no-store` because
 * responses are authorization-scoped. A shared cache holding one user's
 * artifact list and serving it to another would be a cross-tenant leak
 * (PRD §64) — so caching is disabled rather than carefully keyed.
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import type { Env, Principal } from './types'
import { resolvePrincipal, EMPTY_PRINCIPAL } from './lib/principal'
import { fail, HttpError, unauthorized } from './lib/http'

export type AppEnv = {
  Bindings: Env
  Variables: { principal: Principal }
}

/** Resolve the caller once per request and expose it as c.get('principal'). */
export const withPrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
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
  headers.set('X-Content-Type-Options', 'nosniff')

  // HTML previews are framed by our own pages inside an opaque-origin sandbox
  // iframe, so they must remain frameable *by us*. `DENY` blocks framing even
  // same-origin, which is why the artifact preview could not render. SAMEORIGIN
  // narrows framing to our own documents only — combined with the sandbox
  // attribute (no allow-same-origin) and previewCsp() the artifact still never
  // runs on the application origin.
  const isPreviewDocument = /\/preview$/.test(c.req.path)
  headers.set('X-Frame-Options', isPreviewDocument ? 'SAMEORIGIN' : 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
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
    const ip =
      c.req.header('CF-Connecting-IP') ??
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
      'unknown'
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
