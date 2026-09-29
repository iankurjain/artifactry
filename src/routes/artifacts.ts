/**
 * Artifact routes — PRD §106.
 *
 *   POST   /api/v1/artifacts
 *   GET    /api/v1/artifacts
 *   GET    /api/v1/artifacts/:artifactId
 *   PATCH  /api/v1/artifacts/:artifactId
 *   DELETE /api/v1/artifacts/:artifactId
 *   GET    /api/v1/artifacts/:artifactId/content
 *   GET    /api/v1/artifacts/:artifactId/preview
 *   POST   /api/v1/artifacts/:artifactId/versions
 *   GET    /api/v1/artifacts/:artifactId/versions
 *   POST   /api/v1/artifacts/:artifactId/versions/:versionId/restore
 *   GET    /api/v1/artifacts/:artifactId/analytics
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import {
  assignTags,
  createArtifact,
  createVersion,
  listVersions,
  loadArtifact,
  normalizeTitle,
  restoreVersion,
  tagsForArtifact,
  softDeleteArtifact,
  getVersion,
  runEmbeddingStage
} from '../lib/artifacts'
import { artifactAccess, assertArtifactPermission, mayReadAnalytics, workspaceRefOf } from '../lib/access'
import { indexStateFor, isSemanticConfigured } from '../lib/embeddings'
import { reprocessVersion } from '../lib/reprocess'
import { assertWorkspaceAccess, effectiveWorkspaceRole, can } from '../lib/principal'
import { getObject, buildDeliveryHeaders } from '../lib/storage'
import {
  interactiveAvailable,
  previewCspFor,
  previewSandbox,
  resolvePreviewMode
} from '../lib/htmlpreview'
import { buildPreviewDescriptor } from '../lib/preview'
import {
  artifactTotals,
  sourceBreakdown,
  dailySeries,
  recentActivity,
  actorDisplay,
  recordEvent
} from '../lib/analytics'
import { recordAudit } from '../lib/audit'
import { all, first, nowIso, run } from '../lib/db'
import {
  badRequest,
  notFound,
  ok,
  readJson,
  tooLarge,
  unsupported
} from '../lib/http'
import { extensionOf, isSupportedExtension, sanitizeFilename } from '../lib/validate'
import { ulid } from '../lib/ids'
import { autoTagArtifact, decideTags, tagsByState } from '../lib/tags'

const artifacts = new Hono<AppEnv>()

/**
 * The tagging block attached to upload / version / reprocess responses.
 *
 * `status` is the important new field. Previously a caller could only see
 * `source` and a free-text `reason`, so a retired model produced the same
 * response shape as a document that genuinely had nothing to tag. Exposing the
 * status (and, on failure, the provider message) makes a broken model visible in
 * the API rather than only in logs.
 */
function taggingReport(outcome: {
  source: string
  reason: string
  status?: string
  error?: string
  deprecatedModel?: boolean
  model?: string
}) {
  return {
    source: outcome.source,
    reason: outcome.reason,
    ...(outcome.status ? { status: outcome.status } : {}),
    ...(outcome.model ? { model: outcome.model } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.deprecatedModel ? { deprecatedModel: true } : {})
  }
}

/** Normalise an artifact row for API responses (never leaks object keys). */
function presentArtifact(
  row: Record<string, unknown>,
  extras: Record<string, unknown> = {}
) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    filename: row.filename,
    extension: row.extension,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    status: row.status,
    statusDetail: row.status_detail,
    sourceType: row.source_type,
    sourceProvider: row.source_provider,
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    currentVersionId: row.current_version_id,
    versionCount: row.version_count,
    canonicalSlug: row.canonical_slug,
    /**
     * HTML rendering mode. Always exposed, and always as a boolean, so a client
     * never has to know about the INTEGER storage form — and so the default is
     * legible at the API boundary: absent row value reads as `false` (OFF).
     */
    interactiveHtml: Number(row.interactive_html ?? 0) === 1,
    metadata: safeParse(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extras
  }
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------
// Create — multipart upload
// ---------------------------------------------------------------

artifacts.post(
  '/',
  rateLimit({ bucket: 'artifact:create', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const contentType = c.req.header('Content-Type') ?? ''

    const origin = new URL(c.req.url).origin

    /**
     * Two accepted shapes:
     *   - multipart/form-data with a `file` part (browser upload)
     *   - application/json with contentText/contentBase64 (AI / API clients)
     */
    let bytes: Uint8Array
    let filename: string
    let declaredMime: string | undefined
    let workspaceId: string | undefined
    let title: string | undefined
    let description: string | undefined
    let tagSlugs: string[] = []

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData()
      const file = form.get('file')

      if (!(file instanceof File)) throw badRequest('Attach a file in the "file" field')

      const maxBytes = Number(c.env.MAX_UPLOAD_BYTES || 26214400)
      if (file.size > maxBytes) {
        throw tooLarge(
          `This upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB platform limit`,
          { actualBytes: file.size, limitBytes: maxBytes }
        )
      }
      if (file.size === 0) throw badRequest('The uploaded file is empty')

      bytes = new Uint8Array(await file.arrayBuffer())
      filename = sanitizeFilename(file.name || 'artifact')
      declaredMime = file.type || undefined
      workspaceId = (form.get('workspaceId') as string | null) ?? undefined
      title = (form.get('title') as string | null) ?? undefined
      description = (form.get('description') as string | null) ?? undefined

      const rawTags = form.get('tags')
      if (typeof rawTags === 'string' && rawTags.trim()) {
        tagSlugs = rawTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      }
    } else {
      const body = await readJson<{
        filename?: string
        mimeType?: string
        contentText?: string
        contentBase64?: string
        workspaceId?: string
        title?: string
        description?: string
        tags?: string[]
      }>(c)

      if (!body.filename) throw badRequest('filename is required')
      filename = sanitizeFilename(body.filename)
      declaredMime = body.mimeType
      workspaceId = body.workspaceId
      title = body.title
      description = body.description
      tagSlugs = Array.isArray(body.tags) ? body.tags.map(String) : []

      if (typeof body.contentBase64 === 'string' && body.contentBase64.trim()) {
        try {
          const binary = atob(body.contentBase64.replace(/\s+/g, ''))
          const buf = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
          bytes = buf
        } catch {
          throw badRequest('contentBase64 is not valid base64')
        }
      } else if (typeof body.contentText === 'string') {
        bytes = new TextEncoder().encode(body.contentText)
      } else {
        throw badRequest('Provide contentText or contentBase64')
      }
    }

    const ext = extensionOf(filename)
    if (!isSupportedExtension(ext)) {
      throw unsupported(
        `.${ext || 'unknown'} is not a supported format. Supported: pptx, pdf, docx, html, png, jpg, jpeg, bmp, gif`
      )
    }

    // Resolve the target workspace server-side; default to personal (§6)
    let workspace
    if (workspaceId) {
      workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'artifact.create')
    } else {
      const personal = await first<{
        id: string
        name: string
        organization_id: string | null
        owner_user_id: string
      }>(
        c.env.DB,
        `SELECT w.id, w.name, w.organization_id, w.owner_user_id FROM workspaces w
          WHERE w.owner_user_id = ? AND w.workspace_type = 'PERSONAL' AND w.archived_at IS NULL
          ORDER BY w.created_at ASC LIMIT 1`,
        [principal.userId]
      )
      if (!personal) throw badRequest('No workspace available. Provide workspaceId.')
      workspace = personal
    }

    const result = await createArtifact(
      c.env,
      {
        workspaceId: workspace.id,
        organizationId: workspace.organization_id,
        ownerUserId: principal.userId!,
        title: normalizeTitle(title, filename),
        description: description ?? null,
        filename,
        mimeType: declaredMime,
        bytes,
        sourceType: principal.kind === 'AI_GRANT' ? 'API' : 'WEB_UPLOAD',
        sourceProvider: principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : 'WEB',
        metadata: {
          uploadedVia: principal.kind === 'AI_GRANT' ? 'ai-connector' : 'web',
          aiProvenance:
            principal.kind === 'AI_GRANT'
              ? {
                  provider: principal.provider ?? 'API',
                  integrationId: principal.integrationId ?? null,
                  createdByUser: principal.userId
                }
              : undefined
        },
        createdBy: principal.userId!
      },
      origin
    )

    // Explicitly supplied tags become CONFIRMED immediately: a person naming a
    // tag is the decision, not a suggestion. decideTags also handles the
    // taxonomy change (a user may create a tag), so an unknown slug is created
    // rather than silently dropped as it was when tags were admin-governed.
    let tagWarning: string | null = null
    if (tagSlugs.length) {
      try {
        await decideTags(
          c.env.DB,
          principal,
          {
            id: result.artifactId,
            organization_id: workspace.organization_id,
            current_version_id: (await loadArtifact(c.env.DB, result.artifactId))?.current_version_id ?? null
          },
          { add: tagSlugs }
        )
      } catch (err) {
        // The artifact exists and is usable; a tag refusal must not turn a
        // successful upload into an error response.
        tagWarning = err instanceof Error ? err.message : 'Tags could not be applied'
      }
    }

    // Automatic tagging: generate a small set of suggestions from the artifact's
    // own extracted content and metadata and attach them as SUGGESTED. Bounded
    // and non-throwing, so an AI outage never fails an upload that succeeded.
    const suggestions = await autoTagArtifact(c.env, principal, result.artifactId)

    const artifact = await loadArtifact(c.env.DB, result.artifactId)
    const tagState = await tagsByState(c.env.DB, result.artifactId)

    const status = result.status === 'READY' ? 201 : 200

    return ok(
      c,
      {
        artifact: artifact
          ? presentArtifact(artifact as unknown as Record<string, unknown>, {
              tags: tagState.confirmed
            })
          : { id: result.artifactId, status: result.status },
        canonicalUrl: result.canonicalUrl,
        detail: result.detail,
        workspace: { id: workspace.id, name: workspace.name },
        tags: tagState,
        suggestedTags: suggestions.created,
        tagging: taggingReport(suggestions),
        ...(tagWarning ? { tagWarning } : {})
      },
      status
    )
  })
)

// ---------------------------------------------------------------
// List
// ---------------------------------------------------------------

artifacts.get(
  '/',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.query('workspaceId')
    const type = c.req.query('type')
    const status = c.req.query('status')
    const sort = c.req.query('sort') ?? 'updated'
    const limit = Math.min(Number(c.req.query('limit') ?? 25) || 25, 100)
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)

    // ACL scope: derive the readable set first, then filter within it (§64)
    const readable = await all<{ id: string; name: string }>(
      c.env.DB,
      `SELECT DISTINCT w.id, w.name FROM workspaces w
         LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ? AND wm.status = 'ACTIVE'
         LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ? AND om.status = 'ACTIVE'
        WHERE w.archived_at IS NULL
          AND (w.owner_user_id = ? OR wm.user_id IS NOT NULL OR om.user_id IS NOT NULL)`,
      [principal.userId, principal.userId, principal.userId]
    )

    const readableIds = readable.map((w) => w.id)
    if (!readableIds.length) return ok(c, { artifacts: [], total: 0, hasMore: false })

    const scopeIds = workspaceId
      ? readableIds.filter((id) => id === workspaceId)
      : readableIds
    if (!scopeIds.length) return ok(c, { artifacts: [], total: 0, hasMore: false })

    const where: string[] = [
      'a.deleted_at IS NULL',
      `a.workspace_id IN (${scopeIds.map(() => '?').join(',')})`
    ]
    const params: unknown[] = [...scopeIds]

    if (type) {
      where.push('a.extension = ?')
      params.push(type.toLowerCase().replace(/^\./, ''))
    }
    if (status) {
      where.push('a.status = ?')
      params.push(status)
    }

    const order =
      sort === 'created'
        ? 'a.created_at DESC'
        : sort === 'title'
          ? 'a.title COLLATE NOCASE ASC'
          : 'a.updated_at DESC'

    const rows = await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT a.* FROM artifacts a
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ? OFFSET ?`,
      [...params, limit + 1, offset]
    )

    const totalRow = await first<{ n: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM artifacts a WHERE ${where.join(' AND ')}`,
      params
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const tagRows = page.length
      ? await all<{ artifact_id: string; name: string }>(
          c.env.DB,
          `SELECT at.artifact_id, t.name FROM artifact_tags at JOIN tags t ON t.id = at.tag_id
            WHERE at.artifact_id IN (${page.map(() => '?').join(',')}) AND t.status = 'ACTIVE'`,
          page.map((r) => r.id as string)
        )
      : []
    const tagMap = new Map<string, string[]>()
    for (const row of tagRows) {
      const list = tagMap.get(row.artifact_id) ?? []
      list.push(row.name)
      tagMap.set(row.artifact_id, list)
    }

    const wsName = new Map(readable.map((w) => [w.id, w.name]))

    return ok(c, {
      artifacts: page.map((row) =>
        presentArtifact(row, {
          tags: tagMap.get(row.id as string) ?? [],
          workspaceName: wsName.get(row.workspace_id as string) ?? null,
          isOwner: row.owner_user_id === principal.userId
        })
      ),
      total: totalRow?.n ?? page.length,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      workspaceIds: scopeIds
    })
  })
)

// ---------------------------------------------------------------
// Read one
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const access = await artifactAccess(c.env.DB, principal, artifactId)
    const tags = await tagsForArtifact(c.env.DB, artifactId)
    const workspace = await first<{ name: string; workspace_type: string }>(
      c.env.DB,
      `SELECT name, workspace_type FROM workspaces WHERE id = ?`,
      [access.artifact.workspace_id]
    )
    const versions = await listVersions(c.env.DB, artifactId)

    const origin = new URL(c.req.url).origin

    /**
     * How this artifact's HTML may be rendered. Returned for every artifact so
     * the client never has to guess a mode or construct a preview URL itself:
     * when an isolated preview origin is provisioned this carries a
     * short-lived signed `url` on that origin, and `fallbackUrl` is null.
     */
    const preview =
      access.artifact.mime_type === 'text/html'
        ? await buildPreviewDescriptor(c.env.DB, c.env, access.artifact, { appOrigin: origin })
        : null

    return ok(c, {
      artifact: presentArtifact(access.artifact as unknown as Record<string, unknown>, {
        tags,
        canonicalUrl: `${origin}/a/${access.artifact.id}`,
        isOwner: access.isOwner,
        canDownload: access.allowDownload,
        canWrite: access.allowWrite,
        /**
         * Exactly the permission the Interactive HTML toggle requires, reported
         * separately from `canWrite` (which also covers version-create) so the
         * control appears to precisely the principals the PUT endpoint admits.
         * The server still enforces it; this only stops the UI from offering an
         * action that would be refused.
         */
        canUpdate:
          access.isOwner || can(principal, 'artifact.update', workspaceRefOf(access.artifact)),
        preview,
        workspace: workspace ? { name: workspace.name, type: workspace.workspace_type } : null
      }),
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        filename: v.filename,
        extension: v.extension,
        mimeType: v.mime_type,
        sizeBytes: v.size_bytes,
        checksum: v.checksum,
        sourceProvider: v.source_provider,
        changeSummary: v.change_summary,
        hasExtractedText: !!v.extracted_text,
        createdAt: v.created_at,
        isCurrent: v.id === access.artifact.current_version_id
      }))
    })
  })
)

// ---------------------------------------------------------------
// Update metadata
// ---------------------------------------------------------------

artifacts.patch(
  '/:artifactId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.update'
    )

    const body = await readJson<{ title?: string; description?: string; tags?: string[] }>(c)

    const sets: string[] = []
    const params: unknown[] = []

    if (typeof body.title === 'string') {
      const title = body.title.trim()
      if (!title) throw badRequest('Title cannot be empty')
      sets.push('title = ?')
      params.push(title.slice(0, 200))
    }
    if (typeof body.description === 'string') {
      sets.push('description = ?')
      params.push(body.description.slice(0, 2000))
    }

    if (sets.length) {
      sets.push('updated_at = ?')
      params.push(nowIso())
      await run(
        c.env.DB,
        `UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`,
        [...params, artifactId]
      )
    }

    if (Array.isArray(body.tags)) {
      const tags = await all<{ id: string; slug: string }>(
        c.env.DB,
        `SELECT id, slug FROM tags WHERE status = 'ACTIVE'`
      )
      const ids = tags.filter((t) => body.tags!.includes(t.slug)).map((t) => t.id)
      await assignTags(c.env.DB, artifactId, ids, principal.userId!)
    }

    await recordAudit(c.env.DB, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: 'ARTIFACT_UPDATE',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { fields: Object.keys(body) }
    })

    const updated = await loadArtifact(c.env.DB, artifactId)
    const tags = await tagsForArtifact(c.env.DB, artifactId)

    return ok(c, {
      artifact: updated
        ? presentArtifact(updated as unknown as Record<string, unknown>, { tags })
        : null
    })
  })
)

// ---------------------------------------------------------------
// Soft delete
// ---------------------------------------------------------------

artifacts.delete(
  '/:artifactId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.delete'
    )

    await softDeleteArtifact(c.env, artifactId)

    await recordAudit(c.env.DB, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: 'ARTIFACT_DELETE',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { title: artifact.title }
    })

    return ok(c, { deleted: true, artifactId })
  })
)

// ---------------------------------------------------------------
// Content delivery — the only path to bytes (§66)
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/content',
  rateLimit({ bucket: 'artifact:content', limit: 300, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const access = await artifactAccess(c.env.DB, principal, artifactId)

    const wantDownload = c.req.query('download') === '1'
    if (wantDownload && !access.allowDownload) {
      throw badRequest('You do not have download permission for this artifact')
    }

    const versionId = c.req.query('versionId')
    const version = versionId
      ? await getVersion(c.env.DB, artifactId, versionId)
      : access.artifact.current_version_id
        ? await getVersion(c.env.DB, artifactId, access.artifact.current_version_id)
        : null

    if (!version) throw notFound('No content available for this artifact')

    const object = await getObject(c.env, version.r2_object_key)
    if (!object) throw notFound('Artifact content is unavailable')

    // Analytics: count successful retrieval (§45)
    await recordEvent(c.env.DB, {
      artifactId,
      workspaceId: access.artifact.workspace_id,
      organizationId: access.artifact.organization_id,
      eventType: wantDownload ? 'artifact_downloaded' : 'artifact_viewed',
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      actorUserId: principal.userId,
      actorLabel: principal.user?.email ?? null,
      aiProvider: principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : null,
      accessChannel: principal.kind === 'AI_GRANT' ? 'AI' : 'INTERNAL',
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    })

    await recordAudit(c.env.DB, {
      organizationId: access.artifact.organization_id,
      workspaceId: access.artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: wantDownload ? 'ARTIFACT_DOWNLOAD' : 'ARTIFACT_VIEW',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { versionId: version.id, provider: principal.provider ?? null }
    })

    const headers = buildDeliveryHeaders({
      filename: version.filename,
      mimeType: version.mime_type,
      size: version.size_bytes,
      inline: !wantDownload,
      download: wantDownload
    })

    return new Response(object.body, { headers })
  })
)

// ---------------------------------------------------------------
// Sandboxed HTML preview (§67, §68)
//
// This route serves from the APPLICATION origin and therefore renders in Safe
// Preview, unconditionally. That is the whole point of the mode split: uploaded
// JavaScript never executes on the origin that holds the session cookie, so a
// request here can never be upgraded to script execution no matter what the
// artifact's Interactive HTML setting says.
//
// When an isolated preview origin is provisioned, Interactive artifacts get a
// signed document URL on that origin from GET /:artifactId instead. This route
// remains as the Safe-mode renderer and as the fallback for deployments with no
// isolated origin configured.
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/preview',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const access = await artifactAccess(c.env.DB, principal, artifactId)

    if (access.artifact.mime_type !== 'text/html') {
      throw unsupported('Preview rendering is available for HTML artifacts only')
    }
    if (!access.artifact.current_version_id) throw notFound('No content available')

    const version = await getVersion(c.env.DB, artifactId, access.artifact.current_version_id)
    if (!version) throw notFound('No content available')

    const object = await getObject(c.env, version.r2_object_key)
    if (!object) throw notFound('Artifact content is unavailable')

    const html = await object.text()

    /**
     * Always Safe Preview here: `script-src 'none'` plus an empty sandbox. The
     * bytes are the artifact as uploaded — HTML and CSS still render, because
     * inline styles are permitted — but nothing executes. The resolved mode is
     * attached for observability only; it never relaxes this response.
     */
    const resolved = resolvePreviewMode(access.artifact, c.env)

    const headers: Record<string, string> = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': previewCspFor('SAFE', "'self'"),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Allowed to be framed by the app shell, but nothing else.
      'Content-Security-Policy-Frame-Ancestors': "'self'",
      // Reported so an operator can see, without reading the database, which
      // artifacts are interactive and where their preview is actually served.
      'X-Artifact-Preview-Mode': resolved.mode,
      'X-Artifact-Preview-Sandbox': previewSandbox('SAFE')
    }

    await recordEvent(c.env.DB, {
      artifactId,
      workspaceId: access.artifact.workspace_id,
      organizationId: access.artifact.organization_id,
      eventType: 'artifact_viewed',
      actorType: 'USER',
      actorUserId: principal.userId,
      actorLabel: principal.user?.email ?? null,
      accessChannel: 'INTERNAL',
      sessionSeed: c.req.header('CF-Connecting-IP') ?? null
    })

    return new Response(html, { headers })
  })
)

// ---------------------------------------------------------------
// Interactive HTML setting (owner-governed)
//
// The ONLY way to turn script execution on for an artifact. Owner-only, audited,
// and re-validated against the deployment's preview configuration on every
// read, so a flag that cannot be honoured safely is reported as OFF rather than
// silently served as Interactive.
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/preview-settings',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const access = await artifactAccess(c.env.DB, principal, artifactId)
    const resolved = resolvePreviewMode(access.artifact, c.env)

    return ok(c, {
      // The persisted flag (what the owner asked for).
      interactiveHtml: Number(access.artifact.interactive_html ?? 0) === 1,
      // The mode that will actually be used, after availability is considered.
      effectiveMode: resolved.mode,
      requested: resolved.requested,
      /** True when the owner asked for Interactive but it cannot be served. */
      unavailable: resolved.requested && resolved.mode !== 'INTERACTIVE',
      reason: resolved.reason,
      /** Whether this deployment can serve Interactive Preview at all. */
      interactiveAvailable: interactiveAvailable(c.env),
      isOwner: access.isOwner,
      eligible: access.artifact.mime_type === 'text/html',
      warning:
        'Interactive HTML runs the uploaded JavaScript. It executes only inside an isolated, credential-free sandbox on a separate origin, with no access to your session, this library, or site data — but scripts in the file will run. Enable it only for artifacts you trust. Use Safe Preview if you are unsure.'
    })
  })
)

artifacts.put(
  '/:artifactId/preview-settings',
  rateLimit({ bucket: 'artifact:preview-mode', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.update'
    )

    if (artifact.mime_type !== 'text/html') {
      throw unsupported('Interactive HTML applies to HTML artifacts only')
    }

    const body = await readJson<{ interactiveHtml?: unknown }>(c)
    if (typeof body.interactiveHtml !== 'boolean') {
      throw badRequest('Provide "interactiveHtml" as true or false')
    }

    const next = body.interactiveHtml ? 1 : 0
    const previous = Number(artifact.interactive_html ?? 0) === 1

    if (next !== (previous ? 1 : 0)) {
      await run(c.env.DB, `UPDATE artifacts SET interactive_html = ?, updated_at = ? WHERE id = ?`, [
        next,
        nowIso(),
        artifactId
      ])

      await recordAudit(c.env.DB, {
        organizationId: artifact.organization_id,
        workspaceId: artifact.workspace_id,
        actorUserId: principal.userId,
        actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
        action: 'ARTIFACT_PREVIEW_MODE',
        targetType: 'artifact',
        targetId: artifactId,
        metadata: {
          interactiveHtml: next === 1,
          previousInteractiveHtml: previous,
          versionId: artifact.current_version_id,
          // Recorded so the trail shows the setting was honoured (or not) at
          // the moment it changed, not merely what was requested.
          effectiveMode: resolvePreviewMode({ interactive_html: next }, c.env).mode
        }
      })
    }

    const updated = await loadArtifact(c.env.DB, artifactId)
    const resolved = resolvePreviewMode(updated ?? artifact, c.env)

    return ok(c, {
      interactiveHtml: Number(updated?.interactive_html ?? 0) === 1,
      effectiveMode: resolved.mode,
      requested: resolved.requested,
      unavailable: resolved.requested && resolved.mode !== 'INTERACTIVE',
      reason: resolved.reason,
      changed: next !== (previous ? 1 : 0)
    })
  })
)

// ---------------------------------------------------------------
// Versions (§14, §106)
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/versions',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const access = await artifactAccess(c.env.DB, principal, artifactId)

    const versions = await listVersions(c.env.DB, artifactId)

    return ok(c, {
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        filename: v.filename,
        extension: v.extension,
        mimeType: v.mime_type,
        sizeBytes: v.size_bytes,
        checksum: v.checksum,
        sourceType: v.source_type,
        sourceProvider: v.source_provider,
        changeSummary: v.change_summary,
        createdAt: v.created_at,
        isCurrent: v.id === access.artifact.current_version_id
      }))
    })
  })
)

artifacts.post(
  '/:artifactId/versions',
  rateLimit({ bucket: 'artifact:version', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.version.create'
    )

    const contentType = c.req.header('Content-Type') ?? ''

    let bytes: Uint8Array
    let filename: string
    let changeSummary: string | null = null

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw badRequest('Attach a file in the "file" field')

      const maxBytes = Number(c.env.MAX_UPLOAD_BYTES || 26214400)
      if (file.size > maxBytes) {
        throw tooLarge(`This upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB platform limit`)
      }
      if (file.size === 0) throw badRequest('The uploaded file is empty')

      bytes = new Uint8Array(await file.arrayBuffer())
      filename = sanitizeFilename(file.name || artifact.filename || 'version')
      changeSummary = (form.get('changeSummary') as string | null) ?? null
    } else {
      const body = await readJson<{
        filename?: string
        contentText?: string
        contentBase64?: string
        changeSummary?: string
      }>(c)

      filename = sanitizeFilename(body.filename || artifact.filename || 'version')
      changeSummary = body.changeSummary ?? null

      if (typeof body.contentBase64 === 'string' && body.contentBase64.trim()) {
        const binary = atob(body.contentBase64.replace(/\s+/g, ''))
        const buf = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
        bytes = buf
      } else if (typeof body.contentText === 'string') {
        bytes = new TextEncoder().encode(body.contentText)
      } else {
        throw badRequest('Provide contentText or contentBase64')
      }
    }

    const ext = extensionOf(filename)
    if (!isSupportedExtension(ext)) {
      throw unsupported(`.${ext || 'unknown'} is not a supported format`)
    }

    const result = await createVersion(c.env, {
      artifactId,
      bytes,
      filename,
      sourceType: principal.kind === 'AI_GRANT' ? 'API' : 'WEB_UPLOAD',
      sourceProvider: principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : 'WEB',
      changeSummary,
      createdBy: principal.userId!,
      makeCurrent: true
    })

    await recordEvent(c.env.DB, {
      artifactId,
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      eventType: 'artifact_version_created',
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      actorUserId: principal.userId,
      aiProvider: principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : null,
      accessChannel: principal.kind === 'AI_GRANT' ? 'AI' : 'INTERNAL'
    })

    // A new version is materially new content, which is the one case in which a
    // previously rejected tag may legitimately be proposed again: the rejection
    // was a judgement about the old content. suggestTagsForArtifact keys that
    // decision to the version it was made against, so this call re-proposes only
    // where the basis has actually changed.
    const suggestions =
      result.status === 'READY'
        ? await autoTagArtifact(c.env, principal, artifactId, result.versionId)
        : { created: [], source: 'unavailable' as const, reason: 'Version was not accepted' }

    const updated = await loadArtifact(c.env.DB, artifactId)
    const versions = await listVersions(c.env.DB, artifactId)
    const tagState = await tagsByState(c.env.DB, artifactId)

    return ok(
      c,
      {
        versionId: result.versionId,
        versionNumber: result.versionNumber,
        status: result.status,
        detail: result.detail,
        artifact: updated
          ? presentArtifact(updated as unknown as Record<string, unknown>, {
              tags: tagState.confirmed
            })
          : null,
        versionCount: versions.length,
        tags: tagState,
        suggestedTags: suggestions.created,
        tagging: taggingReport(suggestions)
      },
      result.status === 'READY' ? 201 : 200
    )
  })
)

artifacts.post(
  '/:artifactId/versions/:versionId/restore',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const versionId = c.req.param('versionId')

    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.version.create'
    )

    await restoreVersion(c.env.DB, artifactId, versionId)

    await recordAudit(c.env.DB, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ARTIFACT_VERSION_CREATE',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { restoredVersionId: versionId }
    })

    const updated = await loadArtifact(c.env.DB, artifactId)

    return ok(c, {
      restored: true,
      artifact: updated ? presentArtifact(updated as unknown as Record<string, unknown>) : null
    })
  })
)

// ---------------------------------------------------------------
// Analytics (§111)
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/analytics',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const access = await artifactAccess(c.env.DB, principal, artifactId)
    const role = effectiveWorkspaceRole(principal, workspaceRefOf(access.artifact))

    if (!mayReadAnalytics(principal, access.artifact, role)) {
      // Viewers and external recipients get no analytics at all (§47)
      return ok(c, {
        permitted: false,
        reason: 'Analytics are visible to the artifact owner and workspace admins only'
      })
    }

    const requested = c.req.query('period') ?? '30d'
    const period = (['7d', '30d', '90d', 'all'] as const).includes(requested as never)
      ? (requested as '7d' | '30d' | '90d' | 'all')
      : '30d'

    const [totals, sources, series, activity] = await Promise.all([
      artifactTotals(c.env.DB, artifactId, period),
      sourceBreakdown(c.env.DB, artifactId, period),
      dailySeries(c.env.DB, artifactId, period),
      recentActivity(c.env.DB, artifactId, 12)
    ])

    const shares = await all<{ id: string; access_type: string; status: string; expires_at: string | null; created_at: string }>(
      c.env.DB,
      `SELECT id, access_type, status, expires_at, created_at FROM shares
        WHERE target_type = 'ARTIFACT' AND target_id = ?
        ORDER BY created_at DESC LIMIT 20`,
      [artifactId]
    )

    const activeShares = shares.filter(
      (s) => s.status === 'ACTIVE' && (!s.expires_at || new Date(s.expires_at) > new Date())
    ).length

    // Percentage breakdown for the mobile analytics screen (§46, §88)
    const sourceTotal =
      sources.internal + sources.publicLink + sources.email + sources.domain + sources.ai

    const percentage = (value: number) =>
      sourceTotal > 0 ? Math.round((value / sourceTotal) * 100) : 0

    return ok(c, {
      permitted: true,
      period,
      views: totals.views,
      uniqueViewers: totals.uniqueViewers,
      downloads: totals.downloads,
      uniqueDownloaders: totals.uniqueDownloaders,
      aiReferences: totals.aiReferences,
      shareOpens: totals.shareOpens,
      deniedRequests: totals.deniedRequests,
      firstViewedAt: totals.firstViewedAt,
      lastViewedAt: totals.lastViewedAt,
      averageViewsPerViewer:
        totals.uniqueViewers > 0 ? Number((totals.views / totals.uniqueViewers).toFixed(1)) : 0,
      sources: {
        internal: sources.internal,
        publicLink: sources.publicLink,
        email: sources.email,
        domain: sources.domain,
        ai: sources.ai
      },
      sourcePercentages: {
        internal: percentage(sources.internal),
        publicLink: percentage(sources.publicLink),
        email: percentage(sources.email),
        domain: percentage(sources.domain),
        ai: percentage(sources.ai)
      },
      series,
      activity: activity.map((a) => ({
        event: a.event_type,
        actor: actorDisplay(a),
        actorType: a.actor_type,
        channel: a.access_channel,
        at: a.occurred_at
      })),
      shares: {
        total: shares.length,
        active: activeShares,
        expiredAttempts: totals.deniedRequests
      }
    })
  })
)

// ---------------------------------------------------------------
// Processing pipeline visibility (§21, §22)
// ---------------------------------------------------------------

artifacts.get(
  '/:artifactId/jobs',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    await artifactAccess(c.env.DB, principal, artifactId)

    const jobs = await all<{
      job_type: string
      status: string
      attempts: number
      last_error: string | null
      detail_json: string
      updated_at: string
    }>(
      c.env.DB,
      `SELECT job_type, status, attempts, last_error, detail_json, updated_at
         FROM processing_jobs WHERE artifact_id = ? ORDER BY created_at ASC`,
      [artifactId]
    )

    return ok(c, {
      jobs: jobs.map((j) => ({
        type: j.job_type,
        status: j.status,
        attempts: j.attempts,
        error: j.last_error,
        detail: safeParse(j.detail_json),
        updatedAt: j.updated_at
      }))
    })
  })
)

// ---------------------------------------------------------------
// Semantic indexing state + manual re-index (PRD §94)
// ---------------------------------------------------------------

/**
 * Per-artifact indexing state.
 *
 * Reports what is actually in the index (derived from chunk bookkeeping plus
 * the latest EMBED job), not an optimistic flag — so PENDING / INDEXED /
 * PARTIAL / FAILED / SKIPPED always reflects reality.
 */
artifacts.post(
  '/:artifactId/reprocess',
  rateLimit({ bucket: 'artifact:reprocess', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    // Same permission as reindex: this rebuilds derived search data from a
    // version that is already stored and creates no new version.
    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.update'
    )
    if (!artifact.current_version_id) throw badRequest('Artifact has no current version')

    const outcome = await reprocessVersion(c.env, artifactId, artifact.current_version_id)

    // Re-processing re-extracts the content, which can change what the artifact
    // is about, so tagging is re-run here for the same reason it runs on upload.
    // Existing decisions are respected: only genuinely new suggestions are added.
    const suggestions = await autoTagArtifact(c.env, principal, artifactId)

    await recordAudit(c.env.DB, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: 'ARTIFACT_REPROCESS',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: {
        extraction: outcome.extraction.status,
        index: outcome.index.state
      }
    }).catch(() => {})

    const tagState = await tagsByState(c.env.DB, artifactId)

    return ok(c, {
      ...outcome,
      tags: tagState,
      suggestedTags: suggestions.created,
      tagging: taggingReport(suggestions)
    })
  })
)

artifacts.get(
  '/:artifactId/index-state',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    await artifactAccess(c.env.DB, principal, artifactId)

    const state = await indexStateFor(c.env.DB, artifactId)

    // No model name, vector id or dimension is returned: this feeds the user
    // facing detail screen, and those are implementation details. The state
    // and chunk counts are what the UI actually needs.
    return ok(c, {
      ...state,
      semanticConfigured: isSemanticConfigured(c.env)
    })
  })
)

/**
 * Re-index an artifact's semantic embeddings.
 *
 * Owner/admin only (the same permission that gates re-versioning). Useful
 * after a model or index change, and for backfilling artifacts that were
 * uploaded before semantic search was provisioned.
 */
artifacts.post(
  '/:artifactId/reindex',
  rateLimit({ bucket: 'artifact:reindex', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    // `artifact.update` — NOT `artifact.version.create`.
    //
    // Reindexing creates no version: it rebuilds derived search data from a
    // version that is already stored. Gating it on version-create implied a
    // mutation that never happens. Both permissions resolve to the identical
    // role set (CONTRIBUTOR and above — see ROLE_PERMISSIONS in src/types.ts),
    // so this changes nobody's access; it only stops the endpoint from
    // claiming a privilege it does not use.
    const artifact = await assertArtifactPermission(
      c.env.DB,
      principal,
      artifactId,
      'artifact.update'
    )
    if (!artifact.current_version_id) throw badRequest('Artifact has no current version')

    const outcome = await runEmbeddingStage(c.env, artifactId, artifact.current_version_id)

    return ok(c, {
      artifactId,
      state: outcome.state,
      chunks: outcome.chunks,
      vectors: outcome.vectors,
      reason: outcome.reason
    })
  })
)

export default artifacts
