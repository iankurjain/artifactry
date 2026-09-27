/**
 * HTTP helpers: uniform JSON envelopes, error mapping and cookie management.
 *
 * Errors are intentionally terse to the client and detailed in the audit
 * trail, so authorization failures never leak which resource exists
 * (PRD §33, §64).
 */

import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

export const SESSION_COOKIE = 'al_session'
export const SHARE_COOKIE = 'al_share'
export const SESSION_TTL_DAYS = 30
export const SHARE_GRANT_TTL_HOURS = 12

export class HttpError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details)

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'UNAUTHENTICATED', message)

export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'FORBIDDEN', message)

export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message)

export const conflict = (message: string) => new HttpError(409, 'CONFLICT', message)

export const tooLarge = (message: string, details?: unknown) =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', message, details)

export const unsupported = (message: string) =>
  new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message)

export const serverError = (message = 'Something went wrong') =>
  new HttpError(500, 'SERVER_ERROR', message)

export function ok<T>(c: Context, data: T, status = 200) {
  return c.json({ ok: true, data }, status as 200)
}

export function fail(c: Context, err: HttpError) {
  return c.json(
    { ok: false, error: err.code, message: err.message, details: err.details },
    err.status as 400
  )
}

/** Wrap a handler so thrown HttpErrors become clean JSON responses. */
export function handler<C extends Context>(fn: (c: C) => Promise<Response> | Response) {
  return async (c: C): Promise<Response> => {
    try {
      return await fn(c)
    } catch (err) {
      if (err instanceof HttpError) return fail(c, err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[unhandled]', message, err)
      return fail(c, serverError(message))
    }
  }
}

export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    throw badRequest('Request body must be valid JSON')
  }
}

// ---------------------------------------------------------------
// Cookies
//
// SameSite=Lax is used because share links are opened by top-level
// navigation from an email client, where Strict would drop the cookie.
// ---------------------------------------------------------------

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60
  })
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function readSessionCookie(c: Context): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null
}

export function setShareGrantCookie(c: Context, token: string) {
  setCookie(c, SHARE_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SHARE_GRANT_TTL_HOURS * 60 * 60
  })
}

export function readShareGrantCookie(c: Context): string | null {
  return getCookie(c, SHARE_COOKIE) ?? null
}

/** Bearer token from the Authorization header (AI connectors, PRD §58). */
export function readBearer(c: Context): string | null {
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Best-effort client address for audit records; never used for identity. */
export function clientIp(c: Context): string | null {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    null
  )
}
