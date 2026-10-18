/**
 * Artifact routes — PRD §106.
 *
 *   POST   /api/v1/artifacts
 *   POST   /api/v1/artifacts/media-uploads              (audio / video in parts)
 *   PUT    /api/v1/artifacts/media-uploads/:id/parts/:n
 *   POST   /api/v1/artifacts/media-uploads/:id/complete
 *   DELETE /api/v1/artifacts/media-uploads/:id
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

import { Hono, type Context } from 'hono'
import type { AppEnv } from '../middleware'
import type { ArtifactRow, Principal } from '../types'
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
  deleteArtifactPermanently,
  getVersion,
  runEmbeddingStage,
  type CreateArtifactInput
} from '../lib/artifacts'
import { artifactAccess, assertArtifactPermission, loadArtifactFor, mayReadAnalytics, workspaceRefOf } from '../lib/access'
import { indexStateFor, isSemanticConfigured } from '../lib/embeddings'
import { reprocessVersion } from '../lib/reprocess'
import { assertWorkspaceAccess, effectiveWorkspaceRole, can } from '../lib/principal'
import { buildDeliveryHeaders, deliverObject, getObject, isContinuationRange } from '../lib/storage'
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
import { lineageFor, madeByLabel, removeLineage } from '../lib/handoffs'
import { all, first, nowIso, run } from '../lib/db'
import {
  badRequest,
  forbidden,
  notFound,
  ok,
  readJson,
  tooLarge,
  unsupported
} from '../lib/http'
import { extensionOf, isSupportedExtension, sanitizeFilename } from '../lib/validate'
import { ulid } from '../lib/ids'
import {
  MEDIA_PART_BYTES,
  MediaUploadError,
  abortMediaUpload,
  completeMediaUpload,
  startMediaUpload,
  uploadMediaPart
} from '../lib/mediauploads'
import { autoTagArtifact, decideTags, tagsByState } from '../lib/tags'
import { collectionsOf, fileIntoCollections, noteRecentView, placeInCollection, recentlyViewed } from '../lib/collections'

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
    sourceClient: row.source_client ?? null,
    madeBy: madeByLabel(row.source_provider as string | null, row.source_client as string | null),
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

/** The workspace an upload lands in, checked server-side. */
async function resolveUploadWorkspace(
  c: Context<AppEnv>,
  principal: Principal,
  workspaceId: string | undefined
): Promise<{ id: string; name: string; organization_id: string | null }> {
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

  return workspace
}

interface UploadFields {
  bytes: Uint8Array
  filename: string
  declaredMime?: string
  workspaceId?: string
  title?: string
  description?: string
  tagSlugs: string[]
  collectionIds: string[]
  interactiveHtml: boolean
  acceptSuggestedTags: boolean
  /** Set for a parted audio or video upload already in R2 (see CreateArtifactInput). */
  stored?: CreateArtifactInput['stored']
  workspace?: { id: string; name: string; organization_id: string | null }
}

/**
 * Create the artifact, then apply tags, collections and suggestions. Shared by
 * the one-request upload and the parted audio and video upload.
 */
async function saveUpload(c: Context<AppEnv>, principal: Principal, fields: UploadFields): Promise<Response> {
  const { bytes, filename, declaredMime, title, description, tagSlugs, collectionIds, interactiveHtml, acceptSuggestedTags } = fields
  const workspace = fields.workspace ?? (await resolveUploadWorkspace(c, principal, fields.workspaceId))
  const origin = new URL(c.req.url).origin

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
      createdBy: principal.userId!,
      interactiveHtml,
      stored: fields.stored
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

  // Collections chosen at save time. Ids outside the workspace, or without
  // collection.manage there, are skipped rather than failing the upload.
  const filedInto = await fileIntoCollections(
    c.env.DB,
    principal,
    { id: result.artifactId, workspace_id: workspace.id },
    collectionIds
  )

  // Automatic tagging: generate a small set of suggestions from the artifact's
  // own extracted content and metadata and attach them as SUGGESTED. Bounded
  // and non-throwing, so an AI outage never fails an upload that succeeded.
  const suggestions = await autoTagArtifact(c.env, principal, result.artifactId)

  // Bulk uploads into a collection keep the system-generated tags rather than
  // leaving every file with suggestions to review. The same governance as an
  // accept from the artifact page applies; a refusal never fails the upload.
  if (acceptSuggestedTags && suggestions.proposed.length) {
    try {
      await decideTags(
        c.env.DB,
        principal,
        {
          id: result.artifactId,
          organization_id: workspace.organization_id,
          current_version_id: (await loadArtifact(c.env.DB, result.artifactId))?.current_version_id ?? null
        },
        { accept: suggestions.proposed }
      )
    } catch (err) {
      tagWarning = err instanceof Error ? err.message : 'Suggested tags could not be applied'
    }
  }

  const artifact = await loadArtifact(c.env.DB, result.artifactId)
  const tagState = await tagsByState(c.env.DB, result.artifactId)

  const status = result.status === 'READY' ? 201 : 200

  return ok(
    c,
    {
      artifact: artifact
        ? presentArtifact(artifact as unknown as Record<string, unknown>, {
            tags: tagState.confirmed,
            collections: filedInto
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
    let collectionIds: string[] = []
    // HTML starts in Interactive Preview unless the uploader turns it off.
    let interactiveHtml = true
    let acceptSuggestedTags = false

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

      interactiveHtml = form.get('interactiveHtml') !== 'false'
      acceptSuggestedTags = form.get('acceptSuggestedTags') === 'true'

      const rawCollections = form.get('collectionIds')
      if (typeof rawCollections === 'string' && rawCollections.trim()) {
        collectionIds = rawCollections.split(',').map((id) => id.trim()).filter(Boolean)
      }

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
        collectionIds?: string[]
        interactiveHtml?: boolean
      }>(c)

      if (!body.filename) throw badRequest('filename is required')
      filename = sanitizeFilename(body.filename)
      declaredMime = body.mimeType
      workspaceId = body.workspaceId
      title = body.title
      description = body.description
      tagSlugs = Array.isArray(body.tags) ? body.tags.map(String) : []
      collectionIds = Array.isArray(body.collectionIds) ? body.collectionIds.map(String) : []
      interactiveHtml = body.interactiveHtml !== false

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
        `.${ext || 'unknown'} is not a supported format. Supported: pptx, pdf, docx, html, images, text and code, audio (mp3, m4a, wav, ogg, flac) and video (mp4, mov, webm)`
      )
    }

    return saveUpload(c, principal, {
      bytes,
      filename,
      declaredMime,
      workspaceId,
      title,
      description,
      tagSlugs,
      collectionIds,
      interactiveHtml,
      acceptSuggestedTags
    })
  })
)

// ---------------------------------------------------------------
// Create — audio and video, in parts (see lib/mediauploads.ts)
// ---------------------------------------------------------------

function mediaError(err: unknown): never {
  if (err instanceof MediaUploadError) {
    if (err.status === 404) throw notFound(err.message)
    if (err.status === 413) throw tooLarge(err.message)
    if (err.status === 415) throw unsupported(err.message)
    throw badRequest(err.message)
  }
  throw err
}

artifacts.post(
  '/media-uploads',
  rateLimit({ bucket: 'artifact:create', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{
      filename?: string
      size?: number
      workspaceId?: string
      title?: string
      description?: string
      tags?: string[]
      collectionIds?: string[]
      acceptSuggestedTags?: boolean
    }>(c)
    if (!body.filename) throw badRequest('filename is required')
    const workspace = await resolveUploadWorkspace(c, principal, body.workspaceId)
    try {
      return ok(c, await startMediaUpload(c.env, principal, workspace, { ...body, filename: body.filename, size: body.size }), 201)
    } catch (err) {
      mediaError(err)
    }
  })
)

artifacts.put(
  '/media-uploads/:uploadId/parts/:part',
  rateLimit({ bucket: 'artifact:media-part', limit: 600, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const declared = Number(c.req.header('Content-Length') ?? NaN)
    // Refuse an oversized part before reading it into memory.
    if (declared > MEDIA_PART_BYTES) throw tooLarge(`A part can be at most ${MEDIA_PART_BYTES} bytes`)
    try {
      const body = await c.req.arrayBuffer()
      return ok(
        c,
        await uploadMediaPart(c.env, principal, c.req.param('uploadId'), Number(c.req.param('part')), body)
      )
    } catch (err) {
      mediaError(err)
    }
  })
)

artifacts.post(
  '/media-uploads/:uploadId/complete',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ parts?: unknown }>(c)
    let joined: Awaited<ReturnType<typeof completeMediaUpload>>
    try {
      joined = await completeMediaUpload(c.env, principal, c.req.param('uploadId'), body.parts)
    } catch (err) {
      mediaError(err)
    }
    const { meta, head, stored } = joined
    try {
      // Access is checked again: it may have changed while the parts went up.
      const workspace = await resolveUploadWorkspace(c, principal, meta.workspace_id)
      return await saveUpload(c, principal, {
        bytes: head,
        filename: meta.filename,
        workspace,
        title: meta.fields.title,
        description: meta.fields.description,
        tagSlugs: meta.fields.tags ?? [],
        collectionIds: meta.fields.collectionIds ?? [],
        interactiveHtml: false,
        acceptSuggestedTags: Boolean(meta.fields.acceptSuggestedTags),
        stored
      })
    } catch (err) {
      // No artifact row points at the file unless saving got that far.
      if (!(await loadArtifact(c.env.DB, stored.artifactId))) {
        await c.env.R2.delete(stored.objectKey).catch(() => {})
      }
      throw err
    }
  })
)

artifacts.delete(
  '/media-uploads/:uploadId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    try {
      await abortMediaUpload(c.env, principal, c.req.param('uploadId'))
    } catch (err) {
      mediaError(err)
    }
    return ok(c, { aborted: true })
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
    const collectionId = c.req.query('collectionId')
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
    // Membership is checked through collection_artifacts; the workspace bound
    // above still holds, so a collection id cannot reach another workspace.
    if (collectionId) {
      where.push(
        'EXISTS (SELECT 1 FROM collection_artifacts ca WHERE ca.artifact_id = a.id AND ca.collection_id = ?)'
      )
      params.push(collectionId)
    }

    const order =
      sort === 'created'
        ? 'a.created_at DESC'
        : sort === 'oldest'
          ? 'a.created_at ASC'
          : sort === 'title'
            ? 'a.title COLLATE NOCASE ASC'
            : 'a.updated_at DESC'

    // "viewed" lists only what this person has opened, most recent first.
    const rows =
      sort === 'viewed'
        ? await recentlyViewed(c.env.DB, principal.userId!, where, params, limit + 1, offset)
        : await all<Record<string, unknown>>(
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

    const collectionMap = await collectionsOf(c.env.DB, page.map((r) => r.id as string))

    const wsName = new Map(readable.map((w) => [w.id, w.name]))

    return ok(c, {
      artifacts: page.map((row) =>
        presentArtifact(row, {
          tags: tagMap.get(row.id as string) ?? [],
          collections: collectionMap.get(row.id as string) ?? [],
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
// Bulk actions from the library: move to a collection, delete
//
// Each artifact is checked on its own against its own workspace, so a mixed
// or forged list can only ever touch what this person may change. Ids that
// are missing or not allowed come back in `skipped` rather than failing the
// whole request.
// ---------------------------------------------------------------

const BULK_LIMIT = 200
const DELETE_FORBIDDEN = 'Only workspace Owners and Admins can delete artifacts.'

type WorkspaceRef = { id: string; organization_id: string | null; owner_user_id: string }

/** The real workspace row. workspaceRefOf() reads the uploader as owner, so it is not used for delete. */
function workspaceOf(db: D1Database, workspaceId: string) {
  return first<WorkspaceRef>(db, `SELECT id, organization_id, owner_user_id FROM workspaces WHERE id = ?`, [
    workspaceId
  ])
}

function bulkIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw badRequest('Provide artifactIds')
  const ids = [...new Set(raw.map(String).filter(Boolean))]
  if (!ids.length) throw badRequest('Provide artifactIds')
  if (ids.length > BULK_LIMIT) throw badRequest(`Select at most ${BULK_LIMIT} artifacts at a time`)
  return ids
}

function auditDelete(db: D1Database, principal: Principal, artifact: ArtifactRow) {
  return recordAudit(db, {
    organizationId: artifact.organization_id,
    workspaceId: artifact.workspace_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'ARTIFACT_DELETE',
    targetType: 'artifact',
    targetId: artifact.id,
    metadata: { title: artifact.title, permanent: true }
  })
}

/**
 * Puts every listed artifact in one collection (moving it out of the one it
 * was in), or in none when collectionId is null.
 */
artifacts.post(
  '/bulk/collection',
  rateLimit({ bucket: 'artifact:bulk', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ artifactIds?: unknown; collectionId?: unknown }>(c)
    const ids = bulkIds(body.artifactIds)
    const collectionId = typeof body.collectionId === 'string' && body.collectionId ? body.collectionId : null

    const collection = collectionId
      ? await first<{ id: string; name: string; workspace_id: string }>(
          c.env.DB,
          `SELECT id, name, workspace_id FROM collections WHERE id = ? AND archived_at IS NULL`,
          [collectionId]
        )
      : null
    if (collectionId && !collection) throw notFound('Collection not found')
    if (collection) await assertWorkspaceAccess(c.env.DB, principal, collection.workspace_id, 'collection.manage')

    const moved: string[] = []
    const skipped: string[] = []
    const workspaces = new Map<string, WorkspaceRef | null>()
    for (const id of ids) {
      const artifact = await loadArtifactFor(c.env.DB, id)
      // A collection only holds artifacts of its own workspace.
      if (!artifact || (collection && artifact.workspace_id !== collection.workspace_id)) {
        skipped.push(id)
        continue
      }
      if (!workspaces.has(artifact.workspace_id)) {
        workspaces.set(artifact.workspace_id, await workspaceOf(c.env.DB, artifact.workspace_id))
      }
      const workspace = workspaces.get(artifact.workspace_id)
      if (!workspace || !can(principal, 'collection.manage', workspace)) {
        skipped.push(id)
        continue
      }
      await placeInCollection(c.env.DB, artifact.id, collection?.id ?? null, principal.userId)
      moved.push(id)
    }

    return ok(c, {
      moved: moved.length,
      skipped,
      collection: collection ? { id: collection.id, name: collection.name } : null
    })
  })
)

/** Deletes every listed artifact for good. Owners and Admins only. */
artifacts.post(
  '/bulk/delete',
  rateLimit({ bucket: 'artifact:bulk', limit: 60, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ artifactIds?: unknown }>(c)
    const ids = bulkIds(body.artifactIds)

    const allowed: ArtifactRow[] = []
    const skipped: string[] = []
    let refused = 0
    const workspaces = new Map<string, WorkspaceRef | null>()
    for (const id of ids) {
      const artifact = await loadArtifactFor(c.env.DB, id)
      if (!artifact) {
        skipped.push(id)
        continue
      }
      if (!workspaces.has(artifact.workspace_id)) {
        workspaces.set(artifact.workspace_id, await workspaceOf(c.env.DB, artifact.workspace_id))
      }
      const workspace = workspaces.get(artifact.workspace_id)
      if (!workspace || !can(principal, 'artifact.read', workspace)) {
        skipped.push(id)
      } else if (!can(principal, 'artifact.delete', workspace)) {
        skipped.push(id)
        refused++
      } else {
        allowed.push(artifact)
      }
    }
    // Nothing deletable and at least one refused for role: say why plainly.
    if (!allowed.length && refused) throw forbidden(DELETE_FORBIDDEN)

    for (const artifact of allowed) {
      await deleteArtifactPermanently(c.env, artifact.id)
      await auditDelete(c.env.DB, principal, artifact)
    }

    return ok(c, { deleted: allowed.length, skipped })
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
    /**
     * The same tags split by decision state. `tags` above is the flat
     * confirmed-plus-suggested list the chips render from; this adds the
     * per-state split so the client can offer Accept/Reject on pending
     * suggestions and show rejected tags it may reverse. Derived from the same
     * rows, so the flat list and the split can never disagree.
     */
    const tagState = await tagsByState(c.env.DB, artifactId)
    const workspace = await first<{
      id: string
      name: string
      workspace_type: string
      organization_id: string | null
      owner_user_id: string
    }>(
      c.env.DB,
      `SELECT id, name, workspace_type, organization_id, owner_user_id FROM workspaces WHERE id = ?`,
      [access.artifact.workspace_id]
    )
    const versions = await listVersions(c.env.DB, artifactId)
    const collections = (await collectionsOf(c.env.DB, [artifactId])).get(artifactId) ?? []
    if (principal.kind !== 'AI_GRANT' && principal.userId) {
      await noteRecentView(c.env.DB, principal.userId, artifactId)
    }

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
        tagsByState: tagState,
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
        collections,
        // Matches the check the collection endpoints make against the workspace.
        canManageCollections: workspace ? can(principal, 'collection.manage', workspace) : false,
        // Deleting is for workspace Owners and Admins, uploader or not.
        canDelete: workspace ? can(principal, 'artifact.delete', workspace) : false,
        workspace: workspace ? { name: workspace.name, type: workspace.workspace_type } : null,
        lineage: await lineageFor(c.env.DB, principal, artifactId, origin)
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
        madeBy: madeByLabel(v.source_provider, v.source_client),
        changeSummary: v.change_summary,
        hasExtractedText: !!v.extracted_text,
        createdAt: v.created_at,
        isCurrent: v.id === access.artifact.current_version_id
      }))
    })
  })
)

/**
 * Remove a "built from" link that is wrong. Either side's editor may do it;
 * the link is identified from this artifact's side so ids cannot be probed.
 */
artifacts.delete(
  '/:artifactId/links/:linkId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const access = await artifactAccess(c.env.DB, principal, c.req.param('artifactId'))
    await removeLineage(c.env.DB, principal, access.artifact, c.req.param('linkId'))
    return ok(c, { removed: true })
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
// Delete (permanent)
// ---------------------------------------------------------------

artifacts.delete(
  '/:artifactId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const artifact = await loadArtifactFor(c.env.DB, artifactId)
    if (!artifact) throw notFound('Artifact not found')
    const workspace = await workspaceOf(c.env.DB, artifact.workspace_id)
    if (!workspace || !can(principal, 'artifact.read', workspace)) throw notFound('Artifact not found')
    if (!can(principal, 'artifact.delete', workspace)) throw forbidden(DELETE_FORBIDDEN)

    await deleteArtifactPermanently(c.env, artifactId)
    await auditDelete(c.env.DB, principal, artifact)

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

    const range = c.req.header('Range')
    const headers = buildDeliveryHeaders({
      filename: version.filename,
      mimeType: version.mime_type,
      size: version.size_bytes,
      inline: !wantDownload,
      download: wantDownload
    })
    const response = await deliverObject(c.env, version.r2_object_key, version.size_bytes, headers, range)
    if (!response) throw notFound('Artifact content is unavailable')

    // A player seeking through audio or video asks for many ranges; only the
    // first fetch is a view.
    if (isContinuationRange(range)) return response

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

    return response
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
