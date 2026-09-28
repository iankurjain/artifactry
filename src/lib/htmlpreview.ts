/**
 * HTML preview modes and the isolated preview origin.
 *
 * An HTML artifact has one of two explicit rendering modes:
 *
 *   SAFE        "Safe Preview"         — HTML and CSS render; JavaScript never
 *                                        executes. This is the default and the
 *                                        only mode served from the app origin.
 *   INTERACTIVE "Interactive Preview"  — JavaScript executes, but only on a
 *                                        separate origin (PREVIEW_ORIGIN), never
 *                                        on the Artifactry app origin.
 *
 * Why a separate origin instead of a nonce or `allow-same-origin`:
 *
 *   Script execution on the application origin cannot be made safe by policy
 *   alone. Even with a sandboxed iframe, the artifact is same-origin with the
 *   app, so it shares the cookie jar and storage. Moving the document to its own
 *   origin makes the separation structural: the browser refuses to send app
 *   cookies (they are host-only), and `localStorage`/`sessionStorage` are
 *   per-origin, so there is nothing to reach. The sandbox attribute is then a
 *   second layer rather than the only one.
 *
 * Fail-closed rules encoded here:
 *   * the default is SAFE, because `artifacts.interactive_html` defaults to 0;
 *   * INTERACTIVE requires BOTH `PREVIEW_ORIGIN` and `PREVIEW_TOKEN_SECRET`,
 *     so a half-configured deployment degrades to SAFE rather than to
 *     unauthenticated script execution;
 *   * a token must be correctly signed, unexpired, and carry the app origin it
 *     may be framed by. Anything else is rejected outright.
 */

import type { Env } from '../types'
import { timingSafeEqual } from './crypto'

export type PreviewMode = 'SAFE' | 'INTERACTIVE'

/**
 * Lifetime of a signed preview token, in seconds.
 *
 * Short by design. The token is the only thing standing behind an interactive
 * document, so it is minted on demand and expires quickly rather than being
 * long-lived or stored.
 */
export const PREVIEW_TOKEN_TTL_SECONDS = 600

const TOKEN_VERSION = 'v1'
const encoder = new TextEncoder()

export const PREVIEW_MODES: PreviewMode[] = ['SAFE', 'INTERACTIVE']

/**
 * Hard ceiling on a token's life, in seconds, regardless of what a caller asks
 * for. A preview token is a capability, so it is always short-lived.
 */
export const PREVIEW_TOKEN_MAX_TTL_SECONDS = 900

/** Clamp a requested TTL into (0, PREVIEW_TOKEN_MAX_TTL_SECONDS]. */
export function clampPreviewTtl(requested?: number): number {
  if (!Number.isFinite(requested) || (requested as number) <= 0) return PREVIEW_TOKEN_TTL_SECONDS
  return Math.min(Math.floor(requested as number), PREVIEW_TOKEN_MAX_TTL_SECONDS)
}

// ---------------------------------------------------------------
// base64url (Workers has atob/btoa; no Buffer)
// ---------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4))
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

// ---------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return b64urlEncode(new Uint8Array(signature))
}

// ---------------------------------------------------------------
// Origin configuration
// ---------------------------------------------------------------

/** Hostname of the configured preview origin, or null when unavailable. */
export function previewOriginHost(env: Pick<Env, 'PREVIEW_ORIGIN'>): string | null {
  const origin = previewOrigin(env)
  return origin ? new URL(origin).hostname.toLowerCase() : null
}

/**
 * Normalised origin (`scheme://host[:port]`) of the preview origin, or null.
 *
 * The port is preserved because an origin includes it: `http://localhost:3000`
 * and `http://localhost:8080` are different origins, and the surface check must
 * agree with the browser about that.
 */
export function previewOrigin(env: Pick<Env, 'PREVIEW_ORIGIN'>): string | null {
  return normalizeOrigin(env.PREVIEW_ORIGIN?.trim())
}

/**
 * Whether an Interactive Preview can actually be served.
 *
 * Both halves are required: somewhere isolated to serve it from, and a way to
 * prove a request is authorised to see it. Missing either one means the mode is
 * unavailable, and callers must fall back to Safe Preview rather than serve
 * executing HTML unauthenticated.
 */
export function interactiveAvailable(
  env: Pick<Env, 'PREVIEW_ORIGIN' | 'PREVIEW_TOKEN_SECRET'>
): boolean {
  return Boolean(previewOriginHost(env) && env.PREVIEW_TOKEN_SECRET?.trim())
}

/** Hostname of the incoming request, lowercased, or '' when unparseable. */
export function requestHost(url: string, hostHeader?: string | null): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return (hostHeader ?? '').split(':')[0]?.toLowerCase() ?? ''
  }
}

export type RequestSurface = 'APP' | 'PREVIEW'

/**
 * Which surface a request arrived on.
 *
 * Compares full origins, not bare hostnames: `http://localhost:3000` and
 * `http://localhost:8080` share a hostname but are different origins, and the
 * gate must agree with the browser about what an origin is. When no preview
 * origin is configured every request is the app — the isolated surface does not
 * exist, so nothing can be served from it.
 */
export function classifyRequest(
  env: Pick<Env, 'PREVIEW_ORIGIN'>,
  url: string,
  hostHeader?: string | null
): RequestSurface {
  const configured = previewOrigin(env)
  if (!configured) return 'APP'

  const actual = normalizeOrigin(url)
  if (actual) return actual === configured ? 'PREVIEW' : 'APP'

  // Unparseable request URL: fall back to the Host header, still full-origin.
  if (!hostHeader) return 'APP'
  return normalizeOrigin(`https://${hostHeader}`) === configured ? 'PREVIEW' : 'APP'
}

// ---------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------

export interface PreviewModeResolution {
  mode: PreviewMode
  /** What the artifact's flag asked for, before availability was considered. */
  requested: boolean
  reason: string
}

/**
 * Decide how an artifact's HTML may be rendered.
 *
 * Never throws and never returns INTERACTIVE unless it can be served safely and
 * verified. `interactive_html` is treated as a request, not a guarantee: if the
 * preview origin is not provisioned the request is downgraded, and the caller
 * can surface `reason` to the owner so the mismatch is visible rather than
 * mysterious.
 */
export function resolvePreviewMode(
  artifact: { interactive_html?: number | boolean | null },
  env: Pick<Env, 'PREVIEW_ORIGIN' | 'PREVIEW_TOKEN_SECRET'>
): PreviewModeResolution {
  const requested = Number(artifact.interactive_html ?? 0) === 1

  if (!requested) {
    return {
      mode: 'SAFE',
      requested: false,
      reason: 'Safe Preview — HTML and CSS render, JavaScript does not execute'
    }
  }

  const host = previewOriginHost(env)
  if (!host) {
    return {
      mode: 'SAFE',
      requested: true,
      reason:
        'Interactive Preview was requested but no isolated preview origin is configured, so JavaScript stays disabled'
    }
  }

  if (!env.PREVIEW_TOKEN_SECRET?.trim()) {
    return {
      mode: 'SAFE',
      requested: true,
      reason:
        'Interactive Preview was requested but the preview access secret is missing, so JavaScript stays disabled'
    }
  }

  return {
    mode: 'INTERACTIVE',
    requested: true,
    reason: `Interactive Preview — JavaScript executes inside an isolated sandbox on ${host}`
  }
}

// ---------------------------------------------------------------
// Signed preview tokens
// ---------------------------------------------------------------

export interface PreviewTokenPayload {
  /** Artifact id. */
  a: string
  /** Version id — a token never outlives the version it was minted for. */
  v: string
  /** Mode the token authorises. */
  m: PreviewMode
  /** Share id, or null for an authenticated in-app preview. */
  s: string | null
  /**
   * `share_access_grants.id`, or null.
   *
   * Present only for a share whose access type is EMAIL or DOMAIN. The
   * recipient identity is NOT copied into the token: the grant id is an opaque
   * reference, and the preview origin re-reads the grant row to recover the
   * verified email. Deleting or expiring the grant therefore revokes the
   * preview immediately, and the recipient rule stays enforced from the
   * database rather than asserted by the token.
   */
  g: string | null
  /**
   * The app origin allowed to frame this document (`frame-ancestors`).
   * Carried in the signed payload so the preview origin does not need its own
   * copy of the app's hostname and cannot be tricked into framing for a third
   * party.
   */
  o: string
  /** Expiry, epoch seconds. */
  e: number
}

function isHttpsOrigin(value: unknown): value is string {
  return normalizeOrigin(value) !== null
}

/**
 * Reduce a URL to its origin, or null when it is not an http(s) URL.
 *
 * Used so a signed framing origin can never carry a path, query or fragment
 * into a `frame-ancestors` source expression.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Mint a short-lived token authorising one artifact version's preview.
 *
 * Returns null when the deployment cannot sign (no secret) — a caller must
 * treat that as "interactive unavailable", never as "allow".
 */
export async function mintPreviewToken(
  env: Pick<Env, 'PREVIEW_TOKEN_SECRET'>,
  input: {
    artifactId: string
    versionId: string
    mode: PreviewMode
    shareId?: string | null
    /** `share_access_grants.id` binding the verified recipient, when applicable. */
    grantId?: string | null
    appOrigin: string
    ttlSeconds?: number
  }
): Promise<string | null> {
  const secret = env.PREVIEW_TOKEN_SECRET?.trim()
  if (!secret) return null
  const appOrigin = normalizeOrigin(input.appOrigin)
  if (!appOrigin) return null
  if (!input.artifactId || !input.versionId) return null

  const payload: PreviewTokenPayload = {
    a: input.artifactId,
    v: input.versionId,
    m: input.mode,
    s: input.shareId ?? null,
    g: input.grantId ?? null,
    o: appOrigin,
    e: Math.floor(Date.now() / 1000) + clampPreviewTtl(input.ttlSeconds)
  }

  const body = `${TOKEN_VERSION}.${b64urlEncode(encoder.encode(JSON.stringify(payload)))}`
  const signature = await hmac(secret, body)
  return `${body}.${signature}`
}

/**
 * Verify and decode a preview token. Returns null for anything not provably ours.
 *
 * Rejects: malformed shapes, bad base64, wrong version prefix, a signature that
 * does not match, an expired token, an unknown mode, a missing/invalid framing
 * origin, and empty ids. Each is a reason to refuse, never to relax.
 */
export async function verifyPreviewToken(
  env: Pick<Env, 'PREVIEW_TOKEN_SECRET'>,
  token: string | null | undefined
): Promise<PreviewTokenPayload | null> {
  const secret = env.PREVIEW_TOKEN_SECRET?.trim()
  if (!secret || !token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [version, encoded, signature] = parts as [string, string, string]
  if (version !== TOKEN_VERSION) return null

  const expected = await hmac(secret, `${version}.${encoded}`)
  // Constant-time: a length-dependent early return would leak the signature.
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null

  const bytes = b64urlDecode(encoded)
  if (!bytes) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const p = parsed as Partial<PreviewTokenPayload>
  if (typeof p.a !== 'string' || !p.a) return null
  if (typeof p.v !== 'string' || !p.v) return null
  if (p.m !== 'SAFE' && p.m !== 'INTERACTIVE') return null
  if (p.s !== null && typeof p.s !== 'string') return null
  if (p.g !== undefined && p.g !== null && typeof p.g !== 'string') return null
  if (!isHttpsOrigin(p.o)) return null
  if (typeof p.e !== 'number' || !Number.isFinite(p.e)) return null

  const now = Math.floor(Date.now() / 1000)
  if (p.e <= now) return null

  return { a: p.a, v: p.v, m: p.m, s: p.s ?? null, g: p.g ?? null, o: p.o, e: p.e }
}

/** Absolute URL of the isolated preview document for a token. */
export function previewDocumentUrl(
  env: Pick<Env, 'PREVIEW_ORIGIN'>,
  token: string
): string | null {
  const origin = previewOrigin(env)
  return origin ? `${origin}/p/${token}` : null
}

// ---------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------

/**
 * CSP for Safe Preview.
 *
 * `script-src 'none'` rather than a nonce: an uploaded document has arbitrary
 * inline `<script>` tags and none of them can be trusted, so there is no
 * meaningful allow-list. `'none'` states that plainly, and unlike a
 * nonce-plus-`'unsafe-inline'` pair it cannot be misread as permitting inline
 * script (browsers ignore `'unsafe-inline'` when a nonce is present, which made
 * the previous policy's intent ambiguous even though the outcome was correct).
 */
export function safePreviewCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`
  ].join('; ')
}

/**
 * CSP for Interactive Preview.
 *
 * `script-src 'unsafe-inline'` is unavoidable and acceptable *only* because the
 * document is on its own origin with no credentials and nothing else on it. Note
 * what is still denied:
 *
 *   * no external `script-src`/`style-src`/`img-src` origins — an artifact
 *     cannot pull code or exfiltrate via a subresource;
 *   * `connect-src 'none'` — no fetch/XHR/WebSocket/EventSource/beacon, so
 *     there is no network egress for data, which is what makes running a
 *     stranger's script tolerable;
 *   * `form-action 'none'` — `allow-forms` in the sandbox lets a form be
 *     interacted with, but it cannot submit anywhere, since any submission
 *     would be an unvetted outbound request;
 *   * `object-src`/`frame-src 'none'` and `base-uri 'none'` — no plugin, no
 *     nested frame, no `<base>` hijack of relative URLs.
 *
 * `'unsafe-eval'` is deliberately absent, so code relying on `eval` or
 * `new Function` will not run. That is a restriction to relax explicitly later,
 * not an oversight.
 */
export function interactivePreviewCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`
  ].join('; ')
}

export function previewCspFor(mode: PreviewMode, frameAncestors: string): string {
  return mode === 'INTERACTIVE'
    ? interactivePreviewCsp(frameAncestors)
    : safePreviewCsp(frameAncestors)
}

/**
 * CSP for a document served *from the isolated preview origin*.
 *
 * Adds the `sandbox` directive, which applies the sandbox to the document
 * itself rather than relying only on the embedding iframe's attribute. That is
 * the important difference: if a future caller embeds the preview URL without a
 * `sandbox` attribute — or with a careless one — the document still restricts
 * itself, because the policy travels with the response.
 *
 * Omitting `allow-same-origin` keeps the document on an opaque origin even
 * under the CSP-level sandbox, so it has no cookies and no storage.
 */
export function previewDocumentCsp(mode: PreviewMode, appOrigin: string): string {
  const sandbox = mode === 'INTERACTIVE' ? 'sandbox allow-scripts allow-forms' : 'sandbox'
  return `${previewCspFor(mode, appOrigin)}; ${sandbox}`
}

/**
 * `sandbox` tokens for the framing iframe.
 *
 * Neither mode ever includes `allow-same-origin`: that token would reattach the
 * document to its real origin and undo the isolation. Top navigation and popups
 * are likewise omitted (`allow-top-navigation`, `allow-popups`,
 * `allow-popups-to-escape-sandbox`), so a document cannot navigate the app away
 * or open a window that outlives its sandbox.
 *
 * Safe Preview gets the empty (maximally restrictive) sandbox. It needs neither
 * scripting nor form submission, so it asks for nothing — and `script-src 'none'`
 * in the document CSP is the second, independent lock.
 */
export function previewSandbox(mode: PreviewMode): string {
  return mode === 'INTERACTIVE' ? 'allow-scripts allow-forms' : ''
}
