/**
 * Isolated preview origin — PRD §67, §68.
 *
 *   GET /p/:token   the artifact's HTML document, served from PREVIEW_ORIGIN
 *
 * This router is mounted on every hostname, but is only reachable when the
 * request actually arrived on the configured preview origin: `previewSurfaceGate`
 * (middleware.ts) serves the /p/ prefix exclusively on that surface and returns
 * 404 for it everywhere else. The handler repeats the check, so an artifact can
 * never be executed from the application origin even if the URL is hand-typed.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { classifyRequest, verifyPreviewToken } from '../lib/htmlpreview'
import {
  previewDocumentHeaders,
  previewNoticePage,
  resolvePreviewRequest
} from '../lib/preview'
import { recordAudit } from '../lib/audit'
import { recordEvent } from '../lib/analytics'

const preview = new Hono<AppEnv>()

preview.get('/p/:token', async (c) => {
  // Second gate: the handler refuses to serve unless it is on the preview
  // origin. The middleware gate already enforces this; belt and braces, because
  // serving this document from the app origin is the one outcome that must be
  // impossible.
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

  // The bytes are the artifact as stored; the mode exists only in the policy we
  // attach to them.
  const html = await object.text()

  // Analytics and audit for a share viewer. An in-app preview has already been
  // recorded by the app origin when the token was minted, so it is not counted
  // twice here.
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

  return new Response(html, {
    headers: previewDocumentHeaders(resolution.mode, resolution.appOrigin)
  })
})

export default preview
