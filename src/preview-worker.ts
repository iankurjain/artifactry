/**
 * Dedicated preview surface — PRD §67, §68.
 *
 * A SEPARATE Cloudflare Pages project (`artifactry-preview`) bound only to
 * preview.artifactry.app.
 *
 * Why a separate Worker rather than a second hostname on the main project: a
 * shared runtime answers every unmatched path with the application's SPA shell.
 * Measured on the shared runtime before this split:
 *
 *     GET http://preview.localhost:3000/p/   ->  200
 *     22056 bytes, containing boot-data, id="app" and /static/app.js
 *
 * That is the application served from the untrusted hostname — markup, client
 * scripts and boot payload included. A hostname whose only reason to exist is
 * to be isolated must never serve the app, so this surface is its own Worker
 * with its own router and NO shell, NO static assets and NO API.
 *
 * Routable here:
 *   GET /p/:token     the preview document, or a generic refusal notice
 *   GET /api/health   liveness only
 *   everything else   404, plain text
 *
 * It deliberately has no `withPrincipal`, no session handling, no D1 writes
 * beyond share analytics, and no relation to the app origin's routes.
 */

import { Hono } from 'hono'
import type { Env } from './types'
import { classifyRequest, verifyPreviewToken } from './lib/htmlpreview'
import {
  previewDocumentHeaders,
  previewNoticePage,
  resolvePreviewRequest
} from './lib/preview'
import { recordAudit } from './lib/audit'
import { recordEvent } from './lib/analytics'

/**
 * Identifies which Worker answered. The app origin sets no such header, so the
 * production validation can assert that a preview document came from THIS
 * surface rather than from a stray binding on the main project.
 */
const PREVIEW_SURFACE = 'dedicated'

const app = new Hono<{ Bindings: Env }>()

/** Plain-text 404. Never HTML: an unmatched path must not render anything. */
function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Preview-Surface': PREVIEW_SURFACE
    }
  })
}

/** Liveness only — no service name, version or timestamp is echoed. */
app.get('/api/health', () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Preview-Surface': PREVIEW_SURFACE
    }
  })
})

app.get('/p/:token', async (c) => {
  // Belt and braces. This Worker is bound only to the preview origin, but the
  // Pages project is also reachable on <project>.pages.dev; requiring the
  // configured origin means a signed URL is inert anywhere else and cannot be
  // replayed against the default hostname.
  if (classifyRequest(c.env, c.req.url, c.req.header('Host')) !== 'PREVIEW') {
    return previewNoticePage({
      ok: false,
      status: 404,
      reason: 'PREVIEW_UNAVAILABLE',
      appOrigin: null
    })
  }

  const payload = await verifyPreviewToken(c.env, c.req.param('token'))
  if (!payload) {
    return previewNoticePage({
      ok: false,
      status: 401,
      reason: 'PREVIEW_UNAVAILABLE',
      appOrigin: null
    })
  }

  const resolution = await resolvePreviewRequest(c.env.DB, c.env, payload)
  if (!resolution.ok) return previewNoticePage(resolution)

  const object = await c.env.R2.get(resolution.version.r2_object_key)
  if (!object) {
    return previewNoticePage({
      ok: false,
      status: 404,
      reason: 'NO_CONTENT',
      appOrigin: resolution.appOrigin
    })
  }

  // The bytes are the artifact exactly as uploaded. Safe and Interactive differ
  // only in the policy attached to them, never in the document.
  const html = await object.text()

  // Analytics/audit for a share viewer. An in-app preview is already counted by
  // the app origin when the token was minted, so it is not counted twice.
  if (resolution.shareId && resolution.channel) {
    await recordEvent(c.env.DB, {
      artifactId: resolution.artifact.id,
      workspaceId: resolution.artifact.workspace_id,
      organizationId: resolution.artifact.organization_id,
      shareId: resolution.shareId,
      eventType: 'artifact_viewed',
      actorType: 'ANONYMOUS',
      actorLabel: resolution.actorLabel,
      accessChannel: resolution.channel,
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    }).catch(() => {})

    await recordAudit(c.env.DB, {
      organizationId: resolution.artifact.organization_id,
      workspaceId: resolution.artifact.workspace_id,
      actorUserId: null,
      actorType: 'ANONYMOUS',
      action: 'SHARE_ACCESS',
      targetType: 'artifact',
      targetId: resolution.artifact.id,
      metadata: {
        shareId: resolution.shareId,
        versionId: resolution.versionId,
        mode: resolution.mode,
        downgraded: resolution.downgraded
      }
    })
  }

  const headers = previewDocumentHeaders(resolution.mode, resolution.appOrigin)
  headers['X-Preview-Surface'] = PREVIEW_SURFACE

  return new Response(html, { headers })
})

app.notFound(() => notFound())

app.onError((err, c) => {
  console.error('[preview]', c.req.method, c.req.path, err instanceof Error ? err.message : err)
  return notFound()
})

export default app
