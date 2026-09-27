/**
 * Sharing routes — PRD §108, §34–§42.
 *
 *   POST   /api/v1/shares
 *   GET    /api/v1/shares
 *   GET    /api/v1/shares/:shareId
 *   PATCH  /api/v1/shares/:shareId
 *   DELETE /api/v1/shares/:shareId
 *
 * External recipient surface:
 *   GET    /s/:token                     → share landing page (may require verification)
 *   POST   /api/v1/shares/:token/verify  → redeem an OTP to prove email control
 *   GET    /api/v1/shares/:token/view    → the shared item, external view only
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import {
  artifactsForCollectionShare,
  createShare,
  evaluateShareAccess,
  externalShareView,
  findShareByToken,
  listShares,
  revokeShare,
  shareCoversArtifact,
  shareEffectiveStatus,
  updateShare
} from '../lib/sharing'
import { assertArtifactPermission } from '../lib/access'
import { can, effectiveWorkspaceRole } from '../lib/principal'
import { issueOtp, verifyOtp, findOrCreateUser } from '../lib/auth'
import { hashSessionToken } from '../lib/crypto'
import { all, first, nowIso, run } from '../lib/db'
import { prefixed, randomToken, ulid } from '../lib/ids'
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  readJson,
  readShareGrantCookie,
  setShareGrantCookie,
  unauthorized
} from '../lib/http'
import { recordEvent } from '../lib/analytics'
import { recordAudit } from '../lib/audit'
import { loadArtifact } from '../lib/artifacts'
import type { ShareRow } from '../types'

const shares = new Hono<AppEnv>()

// ---------------------------------------------------------------
// Create (§108)
// ---------------------------------------------------------------

shares.post(
  '/',
  rateLimit({ bucket: 'share:create', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const body = await readJson<{
      targetType?: 'ARTIFACT' | 'COLLECTION'
      targetId?: string
      accessType?: 'PUBLIC_LINK' | 'EMAIL' | 'DOMAIN'
      allowView?: boolean
      allowDownload?: boolean
      includeNewItems?: boolean
      expiresAt?: string | null
      expiresInDays?: number
      recipients?: Array<{ type?: 'EMAIL' | 'DOMAIN'; value: string }> | string[]
      title?: string
      note?: string
    }>(c)

    const targetType = body.targetType ?? 'ARTIFACT'
    const targetId = (body.targetId ?? '').trim()
    if (!targetId) throw badRequest('targetId is required')

    const accessType = body.accessType ?? 'PUBLIC_LINK'

    // Permission is checked against the artifact/collection's workspace
    if (targetType === 'ARTIFACT') {
      await assertArtifactPermission(c.env.DB, principal, targetId, 'share.create')
    } else {
      const collection = await first<{ id: string; workspace_id: string; organization_id: string | null; owner_user_id: string }>(
        c.env.DB,
        `SELECT c.id, c.workspace_id, c.organization_id, w.owner_user_id
           FROM collections c JOIN workspaces w ON w.id = c.workspace_id
          WHERE c.id = ? AND c.archived_at IS NULL`,
        [targetId]
      )
      if (!collection) throw notFound('Collection not found')
      if (
        !can(principal, 'share.create', {
          id: collection.workspace_id,
          organization_id: collection.organization_id,
          owner_user_id: collection.owner_user_id
        })
      ) {
        throw forbidden()
      }
    }

    // Accept either [{type,value}] or ["alice@x.com"] for convenience
    const recipients = (body.recipients ?? []).map((r) =>
      typeof r === 'string'
        ? { type: accessType === 'DOMAIN' ? ('DOMAIN' as const) : ('EMAIL' as const), value: r }
        : { type: r.type === 'DOMAIN' ? ('DOMAIN' as const) : ('EMAIL' as const), value: r.value }
    )

    // Prefer an explicit expiry; otherwise derive from expiresInDays
    let expiresAt = body.expiresAt ?? null
    if (!expiresAt && typeof body.expiresInDays === 'number' && body.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + body.expiresInDays * 86400_000).toISOString()
    }

    const origin = new URL(c.req.url).origin

    const created = await createShare(
      c.env.DB,
      principal,
      {
        targetType,
        targetId,
        accessType,
        allowView: body.allowView !== false,
        allowDownload: body.allowDownload === true,
        includeNewItems: body.includeNewItems !== false,
        expiresAt,
        recipients,
        title: body.title ?? null,
        note: body.note ?? null
      },
      origin
    )

    await recordEvent(c.env.DB, {
      artifactId: targetType === 'ARTIFACT' ? targetId : null,
      eventType: 'artifact_shared',
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      actorUserId: principal.userId,
      aiProvider: principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : null,
      accessChannel: principal.kind === 'AI_GRANT' ? 'AI' : 'INTERNAL',
      shareId: created.share.id,
      metadata: { accessType }
    })

    return ok(
      c,
      {
        share: presentShare(created.share),
        // The raw token is returned exactly once, here (§36)
        url: created.url,
        token: created.token
      },
      201
    )
  })
)

function presentShare(share: ShareRow) {
  return {
    id: share.id,
    targetType: share.target_type,
    targetId: share.target_id,
    accessType: share.access_type,
    allowView: !!share.allow_view,
    allowDownload: !!share.allow_download,
    includeNewItems: !!share.include_new_items,
    effectiveStatus: shareEffectiveStatus(share),
    status: share.status,
    startsAt: share.starts_at,
    expiresAt: share.expires_at,
    tokenPrefix: share.token_prefix,
    title: share.title,
    note: share.note,
    createdAt: share.created_at,
    revokedAt: share.revoked_at
  }
}

// ---------------------------------------------------------------
// Manage
// ---------------------------------------------------------------

shares.get(
  '/',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const targetId = c.req.query('targetId') ?? undefined

    const rows = await listShares(c.env.DB, {
      createdBy: principal.userId!,
      targetId
    })

    const origin = new URL(c.req.url).origin

    return ok(c, {
      shares: rows.map((row) => ({
        ...presentShare(row as unknown as ShareRow),
        targetTitle: row.target_title,
        openCount: row.open_count,
        // The full token is never recoverable after creation, by design (§36)
        urlPrefix: `${origin}/s/${row.token_prefix}…`
      }))
    })
  })
)

shares.get(
  '/:shareId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const shareId = c.req.param('shareId')

    const share = await first<ShareRow>(c.env.DB, `SELECT * FROM shares WHERE id = ?`, [shareId])
    if (!share) throw notFound('Share not found')
    if (share.created_by_user_id !== principal.userId) throw notFound('Share not found')

    const recipients = await all<{ recipient_type: string; recipient_value: string; created_at: string }>(
      c.env.DB,
      `SELECT recipient_type, recipient_value, created_at FROM share_recipients WHERE share_id = ?`,
      [shareId]
    )

    const eventCounts = await first<{ opens: number; views: number; denied: number }>(
      c.env.DB,
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'share_opened' THEN 1 ELSE 0 END), 0) AS opens,
         COALESCE(SUM(CASE WHEN event_type = 'artifact_viewed' THEN 1 ELSE 0 END), 0) AS views,
         COALESCE(SUM(CASE WHEN event_type = 'share_access_denied' THEN 1 ELSE 0 END), 0) AS denied
       FROM artifact_events WHERE share_id = ?`,
      [shareId]
    )

    return ok(c, {
      share: presentShare(share),
      recipients,
      activity: {
        opens: eventCounts?.opens ?? 0,
        views: eventCounts?.views ?? 0,
        denied: eventCounts?.denied ?? 0
      }
    })
  })
)

shares.patch(
  '/:shareId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const shareId = c.req.param('shareId')

    const share = await first<ShareRow>(c.env.DB, `SELECT * FROM shares WHERE id = ?`, [shareId])
    if (!share) throw notFound('Share not found')
    if (share.created_by_user_id !== principal.userId) throw forbidden()

    const body = await readJson<{
      allowView?: boolean
      allowDownload?: boolean
      expiresAt?: string | null
      includeNewItems?: boolean
    }>(c)

    const updated = await updateShare(c.env.DB, shareId, body)
    return ok(c, { share: updated ? presentShare(updated) : null })
  })
)

shares.delete(
  '/:shareId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const shareId = c.req.param('shareId')

    const share = await first<ShareRow>(c.env.DB, `SELECT * FROM shares WHERE id = ?`, [shareId])
    if (!share) throw notFound('Share not found')
    if (share.created_by_user_id !== principal.userId) throw forbidden()

    await revokeShare(c.env.DB, shareId)

    await recordAudit(c.env.DB, {
      organizationId: share.organization_id,
      workspaceId: share.workspace_id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'SHARE_REVOKE',
      targetType: 'share',
      targetId: shareId
    })

    return ok(c, { revoked: true, shareId })
  })
)

// ---------------------------------------------------------------
// External recipient surface (§37, §38, §42)
// ---------------------------------------------------------------

/**
 * Resolve the visitor's proven email for a share, if any.
 * A grant cookie binds a short-lived session hash to a verified address.
 */
async function verifiedEmailFor(c: { env: { DB: D1Database }; req: { header: (k: string) => string | undefined } }, share: ShareRow): Promise<string | null> {
  const cookie = readShareGrantCookie(c as never)
  if (!cookie) return null

  const raw = cookie.split(':')
  if (raw.length !== 2) return null
  const [shareId, sessionToken] = raw
  if (shareId !== share.id) return null

  const sessionHash = await hashSessionToken(sessionToken)
  const grant = await first<{ email_normalized: string; expires_at: string }>(
    c.env.DB,
    `SELECT email_normalized, expires_at FROM share_access_grants
      WHERE share_id = ? AND session_hash = ?`,
    [share.id, sessionHash]
  )
  if (!grant) return null
  if (new Date(grant.expires_at).getTime() <= Date.now()) return null

  await run(c.env.DB, `UPDATE share_access_grants SET last_used_at = ? WHERE session_hash = ?`, [
    nowIso(),
    sessionHash
  ])

  return grant.email_normalized
}

/** Public metadata about a share — safe to show before verification. */
shares.get(
  '/:token/meta',
  rateLimit({ bucket: 'share:meta', limit: 120, windowSeconds: 300 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const share = await findShareByToken(c.env.DB, token)

    if (!share) {
      return ok(c, { exists: false })
    }

    const status = shareEffectiveStatus(share)

    // Owner/creator display name only — never the full internal record (§42)
    const creator = await first<{ display_name: string | null; email: string }>(
      c.env.DB,
      `SELECT display_name, email FROM users WHERE id = ?`,
      [share.created_by_user_id]
    )

    return ok(c, {
      exists: true,
      status,
      accessType: share.access_type,
      requiresVerification: share.access_type !== 'PUBLIC_LINK',
      allowView: !!share.allow_view,
      allowDownload: !!share.allow_download,
      expiresAt: share.expires_at,
      sharedBy: creator?.display_name ?? creator?.email ?? 'A library user',
      title: share.title
    })
  })
)

/**
 * Prove control of an address to open an EMAIL or DOMAIN share (§37, §38).
 * Typing an address without redeeming a code never grants access.
 */
shares.post(
  '/:token/request-code',
  rateLimit({ bucket: 'share:otp', limit: 10, windowSeconds: 600 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const body = await readJson<{ email?: string }>(c)
    const email = (body.email ?? '').trim()

    const share = await findShareByToken(c.env.DB, token)
    if (!share) throw notFound('This share link is not valid')

    const evaluation = await evaluateShareAccess(c.env.DB, share, null)
    if (evaluation.reason === 'REVOKED') throw badRequest('This share has been revoked.')
    if (evaluation.reason === 'EXPIRED') throw badRequest('This share has expired.')
    if (evaluation.reason === 'NOT_STARTED') throw badRequest('This share is not yet active.')

    if (share.access_type === 'PUBLIC_LINK') {
      // No verification needed; do not send a code for a link share.
      return ok(c, { requiresVerification: false })
    }

    const { normalizeEmail, isValidEmail } = await import('../lib/validate')
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address')
    const normalized = normalizeEmail(email)

    // Send regardless of whether the address matches, so the endpoint cannot
    // be used to enumerate which addresses a share was granted to. Access is
    // decided only at verification time.
    const result = await issueOtp(c.env, normalized, 'SHARE_ACCESS', share.id)

    return ok(c, {
      requiresVerification: true,
      deliveredVia: result.deliveredVia,
      devCode: result.devCode,
      expiresInMinutes: 10
    })
  })
)

shares.post(
  '/:token/verify',
  rateLimit({ bucket: 'share:verify', limit: 20, windowSeconds: 600 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const body = await readJson<{ email?: string; code?: string }>(c)

    const share = await findShareByToken(c.env.DB, token)
    if (!share) throw notFound('This share link is not valid')

    const { normalizeEmail, isValidEmail } = await import('../lib/validate')
    const email = normalizeEmail((body.email ?? '').trim())
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address')
    if (!/^\d{4,8}$/.test((body.code ?? '').trim())) throw badRequest('Enter the numeric code')

    const verification = await verifyOtp(c.env.DB, email, (body.code ?? '').trim(), 'SHARE_ACCESS')
    if (!verification.ok) {
      await recordEvent(c.env.DB, {
        artifactId: share.target_type === 'ARTIFACT' ? share.target_id : null,
        shareId: share.id,
        eventType: 'share_access_denied',
        actorType: 'ANONYMOUS',
        actorLabel: null,
        accessChannel: share.access_type === 'PUBLIC_LINK' ? 'PUBLIC_LINK' : share.access_type === 'EMAIL' ? 'EMAIL' : 'DOMAIN'
      })
      throw badRequest(verification.reason)
    }

    // Code is valid; now decide whether this address is actually entitled
    const evaluation = await evaluateShareAccess(c.env.DB, share, email)

    if (!evaluation.allowed) {
      await recordEvent(c.env.DB, {
        artifactId: share.target_type === 'ARTIFACT' ? share.target_id : null,
        shareId: share.id,
        eventType: 'share_access_denied',
        actorType: 'ANONYMOUS',
        accessChannel: share.access_type === 'EMAIL' ? 'EMAIL' : 'DOMAIN',
        metadata: { reason: evaluation.reason }
      })
      throw forbidden(
        evaluation.reason === 'EMAIL_MISMATCH'
          ? 'This share was not granted to that email address.'
          : 'This share is no longer available.'
      )
    }

    // Establish a short-lived grant bound to the verified address
    const sessionToken = randomToken(24)
    const sessionHash = await hashSessionToken(sessionToken)
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000).toISOString()

    await run(
      c.env.DB,
      `INSERT INTO share_access_grants
         (id, share_id, email_normalized, granted_at, expires_at, session_hash, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [prefixed('sag', ulid()), share.id, email, nowIso(), expiresAt, sessionHash]
    )

    setShareGrantCookie(c, `${share.id}:${sessionToken}`)

    await recordEvent(c.env.DB, {
      artifactId: share.target_type === 'ARTIFACT' ? share.target_id : null,
      shareId: share.id,
      eventType: 'share_access_granted',
      actorType: 'USER',
      actorLabel: email,
      accessChannel: share.access_type === 'EMAIL' ? 'EMAIL' : 'DOMAIN'
    })

    await recordAudit(c.env.DB, {
      organizationId: share.organization_id,
      workspaceId: share.workspace_id,
      actorType: 'USER',
      action: 'SHARE_ACCESS',
      targetType: 'share',
      targetId: share.id,
      metadata: { accessType: share.access_type }
    })

    return ok(c, { verified: true, expiresAt })
  })
)

/**
 * Fetch the shared content as an external recipient.
 * The response contains only the shared item — no workspaces, tags, members,
 * analytics or internal navigation (§42).
 */
shares.get(
  '/:token/view',
  rateLimit({ bucket: 'share:view', limit: 300, windowSeconds: 300 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const share = await findShareByToken(c.env.DB, token)
    if (!share) throw notFound('This share link is not valid')

    const verifiedEmail = await verifiedEmailFor(c as never, share)
    const evaluation = await evaluateShareAccess(c.env.DB, share, verifiedEmail)

    const channel =
      share.access_type === 'PUBLIC_LINK'
        ? 'PUBLIC_LINK'
        : share.access_type === 'EMAIL'
          ? 'EMAIL'
          : 'DOMAIN'

    if (!evaluation.allowed) {
      await recordEvent(c.env.DB, {
        artifactId: share.target_type === 'ARTIFACT' ? share.target_id : null,
        shareId: share.id,
        eventType: 'share_access_denied',
        actorType: 'ANONYMOUS',
        accessChannel: channel,
        metadata: { reason: evaluation.reason }
      })

      return ok(c, {
        accessible: false,
        reason: evaluation.reason,
        requiresVerification: evaluation.reason === 'VERIFICATION_REQUIRED',
        accessType: share.access_type,
        expiresAt: share.expires_at
      })
    }

    // Denied attempts are counted; a successful open is counted once per visit
    await recordEvent(c.env.DB, {
      artifactId: share.target_type === 'ARTIFACT' ? share.target_id : null,
      workspaceId: share.workspace_id,
      organizationId: share.organization_id,
      shareId: share.id,
      eventType: 'share_opened',
      actorType: 'ANONYMOUS',
      actorLabel: verifiedEmail,
      accessChannel: channel,
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    })

    const origin = new URL(c.req.url).origin

    if (share.target_type === 'ARTIFACT') {
      const artifact = await loadArtifact(c.env.DB, share.target_id)
      if (!artifact) return ok(c, { accessible: false, reason: 'GONE' })

      await recordEvent(c.env.DB, {
        artifactId: artifact.id,
        workspaceId: artifact.workspace_id,
        organizationId: artifact.organization_id,
        shareId: share.id,
        eventType: 'artifact_viewed',
        actorType: 'ANONYMOUS',
        actorLabel: verifiedEmail,
        accessChannel: channel,
        sessionSeed: c.req.header('CF-Connecting-IP') ?? null
      })

      return ok(c, {
        accessible: true,
        view: {
          ...externalShareView(share, { kind: 'ARTIFACT', artifact }),
          contentUrl: `${origin}/api/v1/shares/${token}/content`,
          expiresAt: share.expires_at
        }
      })
    }

    const items = await artifactsForCollectionShare(c.env.DB, share.target_id, !!share.include_new_items)
    const collection = await first<{ name: string; description: string | null }>(
      c.env.DB,
      `SELECT name, description FROM collections WHERE id = ?`,
      [share.target_id]
    )

    return ok(c, {
      accessible: true,
      view: {
        ...externalShareView(share, { kind: 'COLLECTION', items }),
        name: collection?.name ?? 'Shared collection',
        description: collection?.description ?? null,
        contentUrlBase: `${origin}/api/v1/shares/${token}/content`
      }
    })
  })
)

/**
 * Binary delivery for an external recipient. Re-checks the share on every
 * request rather than trusting a prior view, so a revoked or expired share
 * cannot keep serving bytes (§39).
 */
shares.get(
  '/:token/content',
  rateLimit({ bucket: 'share:content', limit: 600, windowSeconds: 300 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const artifactId = c.req.query('artifactId') ?? null

    const share = await findShareByToken(c.env.DB, token)
    if (!share) throw notFound('This share link is not valid')

    const verifiedEmail = await verifiedEmailFor(c as never, share)
    const evaluation = await evaluateShareAccess(c.env.DB, share, verifiedEmail)
    if (!evaluation.allowed) throw forbidden('This share is not available')

    if (!share.allow_view) throw forbidden('This share does not permit viewing')

    const wantDownload = c.req.query('download') === '1'
    if (wantDownload && !share.allow_download) {
      throw forbidden('This share does not permit downloading')
    }

    let targetArtifactId: string | null = null
    if (share.target_type === 'ARTIFACT') {
      targetArtifactId = share.target_id
    } else if (artifactId) {
      const covered = await shareCoversArtifact(c.env.DB, share, artifactId)
      if (!covered) throw forbidden('That artifact is not part of this share')
      targetArtifactId = artifactId
    }
    if (!targetArtifactId) throw badRequest('artifactId is required for a collection share')

    const artifact = await loadArtifact(c.env.DB, targetArtifactId)
    if (!artifact?.current_version_id) throw notFound('Content unavailable')

    const version = await first<{ r2_object_key: string; filename: string; mime_type: string; size_bytes: number }>(
      c.env.DB,
      `SELECT r2_object_key, filename, mime_type, size_bytes FROM artifact_versions WHERE id = ?`,
      [artifact.current_version_id]
    )
    if (!version) throw notFound('Content unavailable')

    const { getObject, buildDeliveryHeaders } = await import('../lib/storage')
    const object = await getObject(c.env, version.r2_object_key)
    if (!object) throw notFound('Content unavailable')

    const channel =
      share.access_type === 'PUBLIC_LINK'
        ? 'PUBLIC_LINK'
        : share.access_type === 'EMAIL'
          ? 'EMAIL'
          : 'DOMAIN'

    await recordEvent(c.env.DB, {
      artifactId: artifact.id,
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      shareId: share.id,
      eventType: wantDownload ? 'artifact_downloaded' : 'artifact_viewed',
      actorType: 'ANONYMOUS',
      actorLabel: verifiedEmail,
      accessChannel: channel,
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    })

    return new Response(object.body, {
      headers: buildDeliveryHeaders({
        filename: version.filename,
        mimeType: version.mime_type,
        size: version.size_bytes,
        inline: !wantDownload,
        download: wantDownload
      })
    })
  })
)

/**
 * Sandboxed preview for an external recipient (§68).
 * Same opaque-origin treatment as the internal preview.
 */
shares.get(
  '/:token/preview',
  rateLimit({ bucket: 'share:preview', limit: 200, windowSeconds: 300 }),
  guarded(async (c) => {
    const token = c.req.param('token')
    const artifactId = c.req.query('artifactId') ?? null

    const share = await findShareByToken(c.env.DB, token)
    if (!share) throw notFound('This share link is not valid')

    const verifiedEmail = await verifiedEmailFor(c as never, share)
    const evaluation = await evaluateShareAccess(c.env.DB, share, verifiedEmail)
    if (!evaluation.allowed) throw forbidden('This share is not available')
    if (!share.allow_view) throw forbidden('This share does not permit viewing')

    let targetArtifactId: string | null = share.target_type === 'ARTIFACT' ? share.target_id : null
    if (!targetArtifactId && artifactId) {
      const covered = await shareCoversArtifact(c.env.DB, share, artifactId)
      if (!covered) throw forbidden('That artifact is not part of this share')
      targetArtifactId = artifactId
    }
    if (!targetArtifactId) throw badRequest('artifactId is required')

    const artifact = await loadArtifact(c.env.DB, targetArtifactId)
    if (!artifact?.current_version_id) throw notFound('Content unavailable')
    if (artifact.mime_type !== 'text/html') {
      throw badRequest('Preview rendering is available for HTML artifacts only')
    }

    const version = await first<{ r2_object_key: string }>(
      c.env.DB,
      `SELECT r2_object_key FROM artifact_versions WHERE id = ?`,
      [artifact.current_version_id]
    )
    if (!version) throw notFound('Content unavailable')

    const { getObject, previewCsp } = await import('../lib/storage')
    const object = await getObject(c.env, version.r2_object_key)
    if (!object) throw notFound('Content unavailable')

    const html = await object.text()
    const nonce = ulid().replace(/[^A-Za-z0-9]/g, '').slice(0, 16)

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': previewCsp(nonce),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    })
  })
)

export { verifiedEmailFor }
export default shares
export { findOrCreateUser }
