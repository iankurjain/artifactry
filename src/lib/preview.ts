/**
 * Preview-origin document service.
 *
 * Everything an Interactive Preview document needs once a token has been
 * verified: a live re-check of the entitlement, the response headers for the
 * isolated origin, and a readable notice page for a refusal.
 *
 * Two things are re-checked here rather than trusted from the token:
 *
 *   1. Entitlement. A token proves only that the app origin authorised a
 *      preview at mint time. The share is re-evaluated against the database —
 *      effective status, expiry window, allow_view, and the recipient grant —
 *      so revoking a share or expiring a grant takes effect on the next load,
 *      with no token-shortening window to reason about.
 *
 *   2. Mode. The artifact's `interactive_html` flag is re-read. Turning
 *      Interactive HTML off downgrades already-minted tokens to Safe Preview
 *      (JavaScript disabled) instead of leaving a script-executing capability
 *      alive. The direction is one-way: a token can never *raise* the mode.
 */

import type { AccessChannel, ArtifactRow, Env, ShareRow } from '../types'
import { first, nowIso, run } from './db'
import { loadArtifact } from './artifacts'
import { evaluateShareAccess, shareCoversArtifact } from './sharing'
import {
  mintPreviewToken,
  normalizeOrigin,
  previewDocumentCsp,
  previewDocumentUrl,
  previewOrigin,
  previewSandbox,
  resolvePreviewMode
} from './htmlpreview'
import type { PreviewMode, PreviewTokenPayload } from './htmlpreview'

export interface PreviewDenial {
  ok: false
  status: number
  reason: string
  appOrigin: string | null
}

export interface PreviewGrant {
  ok: true
  artifact: ArtifactRow
  versionId: string
  version: { r2_object_key: string; filename: string; mime_type: string; size_bytes: number }
  mode: PreviewMode
  /** What the artifact asked for, before availability was considered. */
  requested: boolean
  reason: string
  appOrigin: string
  shareId: string | null
  channel: AccessChannel | null
  actorLabel: string | null
  /** True when the token authorised INTERACTIVE but the artifact is now SAFE. */
  downgraded: boolean
}

export type PreviewResolution = PreviewDenial | PreviewGrant

function deny(status: number, reason: string, appOrigin: string | null): PreviewDenial {
  return { ok: false, status, reason, appOrigin }
}

/**
 * Re-check a verified token against live state.
 *
 * Fails closed at every step: an artifact that no longer exists, a version that
 * has been superseded, a share that is revoked or expired, a missing or stale
 * recipient grant, or a deployment without a preview origin/secret all produce
 * a denial rather than a document.
 */
export async function resolvePreviewRequest(
  db: D1Database,
  env: Pick<Env, 'PREVIEW_ORIGIN' | 'PREVIEW_TOKEN_SECRET' | 'APP_ORIGIN'>,
  payload: PreviewTokenPayload
): Promise<PreviewResolution> {
  const appOrigin = payload.o

  // A deployment without a preview origin or signing secret cannot serve this.
  if (!previewOrigin(env) || !env.PREVIEW_TOKEN_SECRET?.trim()) {
    return deny(503, 'PREVIEW_UNAVAILABLE', appOrigin)
  }

  // The token's signed framing origin must be the origin this deployment
  // expects. `o` is what becomes `frame-ancestors` on the served document, and
  // the app origin derives it from its own request URL — so a request arriving
  // with a spoofed Host header could otherwise mint a token naming an arbitrary
  // framer. Pinning it here means such a token is refused instead of served.
  const configuredApp = normalizeOrigin(env.APP_ORIGIN)
  if (configuredApp && normalizeOrigin(payload.o) !== configuredApp) {
    return deny(403, 'ORIGIN_NOT_PERMITTED', appOrigin)
  }

  const artifact = await loadArtifact(db, payload.a)
  if (!artifact) return deny(404, 'ARTIFACT_UNAVAILABLE', appOrigin)
  if (artifact.mime_type !== 'text/html') return deny(415, 'NOT_HTML', appOrigin)
  if (!artifact.current_version_id) return deny(404, 'NO_CONTENT', appOrigin)
  // A token is bound to one version, so a newer upload invalidates it.
  if (artifact.current_version_id !== payload.v) return deny(409, 'VERSION_CHANGED', appOrigin)

  let channel: AccessChannel | null = null
  let actorLabel: string | null = null

  if (payload.s) {
    const share = await first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, [payload.s])
    if (!share) return deny(403, 'SHARE_UNAVAILABLE', appOrigin)

    const covered =
      share.target_type === 'ARTIFACT'
        ? share.target_id === artifact.id
        : await shareCoversArtifact(db, share, artifact.id)
    if (!covered) return deny(403, 'SHARE_UNAVAILABLE', appOrigin)
    if (!share.allow_view) return deny(403, 'VIEW_NOT_PERMITTED', appOrigin)

    // Recover the verified recipient from the grant the app origin bound into
    // the token. The email is never carried in the token, so expiring or
    // deleting the grant revokes the preview immediately.
    let verifiedEmail: string | null = null
    if (share.access_type !== 'PUBLIC_LINK') {
      if (!payload.g) return deny(403, 'VERIFICATION_REQUIRED', appOrigin)
      const grant = await first<{ email_normalized: string; expires_at: string }>(
        db,
        `SELECT email_normalized, expires_at FROM share_access_grants
          WHERE id = ? AND share_id = ?`,
        [payload.g, share.id]
      )
      if (!grant) return deny(403, 'VERIFICATION_REQUIRED', appOrigin)
      if (new Date(grant.expires_at).getTime() <= Date.now()) {
        return deny(403, 'VERIFICATION_EXPIRED', appOrigin)
      }
      verifiedEmail = grant.email_normalized
      await run(db, `UPDATE share_access_grants SET last_used_at = ? WHERE id = ?`, [
        nowIso(),
        payload.g
      ]).catch(() => {})
    }

    const evaluation = await evaluateShareAccess(db, share, verifiedEmail)
    if (!evaluation.allowed) return deny(403, evaluation.reason ?? 'SHARE_UNAVAILABLE', appOrigin)

    channel =
      share.access_type === 'PUBLIC_LINK'
        ? 'PUBLIC_LINK'
        : share.access_type === 'EMAIL'
          ? 'EMAIL'
          : 'DOMAIN'
    actorLabel = verifiedEmail
  }

  const version = await first<{
    r2_object_key: string
    filename: string
    mime_type: string
    size_bytes: number
  }>(
    db,
    `SELECT r2_object_key, filename, mime_type, size_bytes FROM artifact_versions WHERE id = ?`,
    [artifact.current_version_id]
  )
  if (!version) return deny(404, 'NO_CONTENT', appOrigin)

  // One-way mode: the artifact may lower it, a token may never raise it.
  const resolved = resolvePreviewMode(artifact, env)
  const mode: PreviewMode =
    resolved.mode === 'INTERACTIVE' && payload.m === 'INTERACTIVE' ? 'INTERACTIVE' : 'SAFE'

  return {
    ok: true,
    artifact,
    versionId: artifact.current_version_id,
    version,
    mode,
    requested: resolved.requested,
    reason: resolved.reason,
    appOrigin,
    shareId: payload.s,
    channel,
    actorLabel,
    downgraded: mode !== payload.m
  }
}

/**
 * Response headers for a document served from the isolated preview origin.
 *
 * The document bytes are the artifact exactly as uploaded — Safe Preview and
 * Interactive Preview differ only in the policy applied to them, never in a
 * rewrite of the artifact. In Safe Preview that means HTML and CSS still render
 * (inline `<style>` is allowed) while `script-src 'none'` stops every script,
 * inline handlers included.
 */
export function previewDocumentHeaders(
  mode: PreviewMode,
  appOrigin: string
): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    // `sandbox` travels with the bytes, so the restriction holds even if a
    // caller embeds the URL without a sandbox attribute of its own.
    'Content-Security-Policy': previewDocumentCsp(mode, appOrigin),
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    // No X-Frame-Options: the only permitted framer is the app origin, and that
    // is expressed by `frame-ancestors`. XFO has no value that permits a single
    // cross-origin framer (ALLOW-FROM is obsolete), so one here could only block
    // the legitimate case or be ignored.
    Vary: 'Host'
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const DENIAL_COPY: Record<string, string> = {
  PREVIEW_UNAVAILABLE: 'This preview is not available.',
  ARTIFACT_UNAVAILABLE: 'This item is no longer available.',
  NOT_HTML: 'This item cannot be previewed.',
  NO_CONTENT: 'This item has no content to preview.',
  VERSION_CHANGED: 'This item has been updated. Reopen it to see the latest version.',
  SHARE_UNAVAILABLE: 'This share link is not valid or has been revoked.',
  VIEW_NOT_PERMITTED: 'The sender has disabled viewing for this share.',
  VERIFICATION_REQUIRED: 'Verify your email address to open this share.',
  VERIFICATION_EXPIRED: 'Your access to this share has expired. Open the link again to verify.',
  EXPIRED: 'This share link has expired.',
  REVOKED: 'This share link has been revoked.',
  NOT_STARTED: 'This share link is not active yet.',
  EMAIL_MISMATCH: 'This share was not addressed to you.'
}

export interface PreviewDescriptor {
  /** Mode the document will actually be rendered in. */
  mode: PreviewMode
  /** Whether the artifact asked for Interactive (before availability). */
  requested: boolean
  /** Owner-facing explanation, safe to display. */
  reason: string
  /** Absolute preview-origin document URL when one is available. */
  url: string | null
  /** Same-origin fallback path, used only when no isolated origin exists. */
  fallbackUrl: string | null
  /** `sandbox` attribute the framing iframe must use. */
  sandbox: string
  /** False when the isolated origin is unavailable and Safe Preview is served. */
  isolated: boolean
  /** True when Interactive was requested but the mode was downgraded. */
  downgraded: boolean
}

/**
 * Build everything the UI needs to frame an artifact's HTML.
 *
 * Called from the app origin (in-app detail) and from the share surface. When an
 * isolated origin is configured and the mode is INTERACTIVE, `url` is a
 * short-lived signed document URL on that origin and the caller must NOT also
 * expose a same-origin route to the same document.
 *
 * When no isolated origin is configured the descriptor reports
 * `mode: 'SAFE'` — never INTERACTIVE — because that is what will actually be
 * served. `fallbackUrl` is returned for the caller's convenience so the
 * existing same-origin preview keeps working in that configuration.
 */
export async function buildPreviewDescriptor(
  db: D1Database,
  env: Pick<Env, 'PREVIEW_ORIGIN' | 'PREVIEW_TOKEN_SECRET'>,
  artifact: Pick<ArtifactRow, 'id' | 'interactive_html' | 'current_version_id' | 'mime_type'>,
  opts: {
    shareId?: string | null
    grantId?: string | null
    appOrigin: string
    /** Raw share token, needed only to build the same-origin fallback path. */
    shareToken?: string | null
  }
): Promise<PreviewDescriptor> {
  const resolved = resolvePreviewMode(artifact, env)
  const isolated = resolved.mode === 'INTERACTIVE'
  const versionId = artifact.current_version_id
  const fallback = fallbackPreviewPath(artifact.id, opts.shareToken ?? null)

  let url: string | null = null
  if (isolated && versionId) {
    const token = await mintPreviewToken(env, {
      artifactId: artifact.id,
      versionId,
      mode: 'INTERACTIVE',
      shareId: opts.shareId ?? null,
      grantId: opts.grantId ?? null,
      appOrigin: opts.appOrigin
    })
    url = token ? previewDocumentUrl(env, token) : null
  }

  // A token could not be minted after all (e.g. the secret was rotated away
  // between the availability check and signing). Degrade rather than serve the
  // document from the app origin: requested=true, mode=SAFE.
  if (isolated && !url) {
    return {
      mode: 'SAFE',
      requested: true,
      reason:
        'Interactive Preview was requested but a signed preview could not be issued, so JavaScript stays disabled',
      url: null,
      fallbackUrl: fallback,
      sandbox: previewSandbox('SAFE'),
      isolated: false,
      downgraded: true
    }
  }

  return {
    mode: resolved.mode,
    requested: resolved.requested,
    reason: resolved.reason,
    url,
    fallbackUrl: isolated ? null : fallback,
    sandbox: previewSandbox(resolved.mode),
    isolated,
    downgraded: resolved.requested && !isolated
  }
}

/**
 * Same-origin preview path used only when no isolated origin is configured, or
 * when the artifact is in Safe Preview.
 *
 * Keyed by share TOKEN, not share id: the share routes resolve a share by the
 * raw token in the URL, and the id is an internal identifier that must not
 * appear in a path a recipient is asked to fetch.
 */
export function fallbackPreviewPath(artifactId: string, shareToken: string | null): string {
  const id = encodeURIComponent(artifactId)
  return shareToken
    ? `/api/v1/shares/${encodeURIComponent(shareToken)}/preview?artifactId=${id}`
    : `/api/v1/artifacts/${id}/preview`
}

/**
 * Notice served from the preview origin when a request is refused.
 *
 * Deliberately generic: it names no artifact, owner or share, so a refused
 * request learns nothing about what might exist.
 */
export function previewNoticePage(denial: PreviewDenial): Response {
  const message = DENIAL_COPY[denial.reason] ?? 'This preview is not available.'
  const ancestors = denial.appOrigin ?? "'none'"
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Preview unavailable</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:40px 20px;background:#f5f6f2;color:#12151c">
<div style="max-width:380px;margin:0 auto;background:#fff;border:1px solid #e2e4da;border-radius:14px;padding:22px">
<h1 style="font-size:17px;margin:0 0 8px">Preview unavailable</h1>
<p style="font-size:14px;color:#5a6066;margin:0;line-height:1.55">${escapeHtml(message)}</p>
</div></body></html>`

  return new Response(html, {
    status: denial.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${ancestors}`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  })
}
