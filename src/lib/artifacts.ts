/**
 * Artifact domain service.
 *
 * Implements the upload → verify → validate → scan → index pipeline from
 * PRD §21 and §22. The PRD describes this as a queue-driven pipeline; on
 * Cloudflare Pages there is no queue consumer, so the same stages run
 * in-request and their outcomes are recorded as processing_jobs rows. That
 * keeps the state machine, the job history and the API contract identical,
 * and makes a later move to a real queue a transport change only.
 */

import type {
  ArtifactRow,
  ArtifactStatus,
  Env,
  Principal,
  SourceProvider,
  SourceType,
  VersionRow
} from '../types'
import { all, first, nowIso, ps, run } from './db'
import { buildObjectKey, putObject } from './storage'
import { indexArtifact, loadTagsFor } from './search'
import { prefixed, slugify, ulid } from './ids'
import {
  extensionOf,
  kindForExtension,
  magicBytesMatch,
  looksSuspicious,
  effectiveLimit,
  isSupportedExtension,
  sanitizeFilename,
  EXTENSION_MIME
} from './validate'
import { conflict, notFound, tooLarge, unsupported } from './http'
import { recordAudit } from './audit'
import { extractText, type ExtractionResult } from './extract'
import { reindexVersion, removeArtifactVectors, type IndexState } from './embeddings'

// ---------------------------------------------------------------
// Processing job bookkeeping
// ---------------------------------------------------------------

export type JobType = 'EXTRACT' | 'INDEX' | 'THUMBNAIL' | 'EMBED' | 'SCAN'

/**
 * Job outcomes (§22).
 *
 * `PARTIAL` is the honest middle state: the extractor ran and understands the
 * format, but recovered no usable text (a scanned PDF, a deck of images). It is
 * distinct from `SKIPPED`, which means no extractor exists for that type at all.
 * Both leave the artifact searchable by title, filename, description and tags.
 */
export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED' | 'SKIPPED'

/**
 * Map an extraction result onto a job status.
 * Kept in one place so the upload and re-version paths cannot drift apart.
 */
export function statusForExtraction(result: ExtractionResult): JobStatus {
  if (result.ok) return 'DONE'
  return result.supported ? 'PARTIAL' : 'SKIPPED'
}

export interface ExtractionSummary {
  status: JobStatus
  supported: boolean
  chars: number
  note: string
  via?: string
}

/** Plain-language extraction outcome, surfaced on the artifact payload. */
export function summariseExtraction(result: ExtractionResult): ExtractionSummary {
  return {
    status: statusForExtraction(result),
    supported: result.supported,
    chars: result.text?.length ?? 0,
    note: result.note,
    via: result.via
  }
}

export async function recordJob(
  db: D1Database,
  artifactId: string,
  versionId: string | null,
  jobType: JobType,
  status: JobStatus,
  detail: Record<string, unknown> = {},
  lastError: string | null = null
): Promise<void> {
  const existing = await first<{ id: string; attempts: number }>(
    db,
    `SELECT id, attempts FROM processing_jobs WHERE artifact_id = ? AND job_type = ? AND COALESCE(version_id,'') = COALESCE(?, '')`,
    [artifactId, jobType, versionId]
  )

  if (existing) {
    await run(
      db,
      `UPDATE processing_jobs SET status = ?, detail_json = ?, last_error = ?, attempts = ?, updated_at = ?
        WHERE id = ?`,
      [
        status,
        JSON.stringify(detail),
        lastError,
        existing.attempts + 1,
        nowIso(),
        existing.id
      ]
    )
    return
  }

  await run(
    db,
    `INSERT INTO processing_jobs
       (id, artifact_id, version_id, job_type, status, attempts, last_error, detail_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      prefixed('job', ulid()),
      artifactId,
      versionId,
      jobType,
      status,
      lastError,
      JSON.stringify(detail),
      nowIso(),
      nowIso()
    ]
  )
}

// ---------------------------------------------------------------
// Validation + scanning (PRD §69 — abstraction over a scanner)
// ---------------------------------------------------------------

export interface ScanVerdict {
  verdict: 'CLEAN' | 'SUSPICIOUS' | 'REJECTED'
  reason: string | null
}

/**
 * Scanner abstraction. Swapping in a commercial provider means replacing
 * this function's body; no artifact API changes, as the PRD requires.
 */
export function scanFile(ext: string, bytes: Uint8Array): ScanVerdict {
  const suspicious = looksSuspicious(ext, bytes)
  if (suspicious) return { verdict: 'SUSPICIOUS', reason: suspicious }
  return { verdict: 'CLEAN', reason: null }
}

export interface ValidateOutcome {
  ok: boolean
  status: ArtifactStatus
  detail: string
}

export function validateUpload(
  ext: string,
  bytes: Uint8Array,
  declaredLimit: number
): ValidateOutcome {
  if (!isSupportedExtension(ext)) {
    throw unsupported(`.${ext || 'unknown'} is not a supported artifact format`)
  }

  if (bytes.byteLength > declaredLimit) {
    throw tooLarge(
      `File exceeds the ${Math.floor(declaredLimit / (1024 * 1024))} MB limit for this workspace`,
      { actualBytes: bytes.byteLength, limitBytes: declaredLimit }
    )
  }

  const magic = magicBytesMatch(ext, bytes)
  if (!magic.ok) {
    return {
      ok: false,
      status: 'PROCESSING_FAILED',
      detail: magic.reason ?? 'File content does not match its extension'
    }
  }

  const scan = scanFile(ext, bytes)
  if (scan.verdict === 'SUSPICIOUS') {
    return {
      ok: false,
      status: 'QUARANTINED',
      detail: scan.reason ?? 'File failed security inspection'
    }
  }

  return { ok: true, status: 'READY', detail: 'Validated' }
}

// ---------------------------------------------------------------
// Artifact creation
// ---------------------------------------------------------------

export interface CreateArtifactInput {
  workspaceId: string
  organizationId: string | null
  ownerUserId: string
  title: string
  description?: string | null
  filename: string
  mimeType?: string
  bytes: Uint8Array
  sourceType: SourceType
  sourceProvider: SourceProvider | null
  metadata?: Record<string, unknown>
  createdBy: string
}

export interface CreateArtifactResult {
  artifactId: string
  versionId: string
  status: ArtifactStatus
  detail: string
  canonicalUrl: string
}

/**
 * Create an artifact and its first version.
 *
 * The artifact row is written first with status UPLOADING so its canonical
 * identity exists immediately (PRD §112: "Artifact shell + canonical ID
 * should be available immediately"), then binary handling proceeds.
 */
export async function createArtifact(
  env: Env,
  input: CreateArtifactInput,
  origin: string
): Promise<CreateArtifactResult> {
  const db = env.DB
  const timestamp = nowIso()

  const filename = sanitizeFilename(input.filename)
  const ext = extensionOf(filename)

  const orgLimit = input.organizationId
    ? (await first<{ max_upload_bytes: number }>(
        db,
        `SELECT max_upload_bytes FROM organizations WHERE id = ?`,
        [input.organizationId]
      ))?.max_upload_bytes ?? null
    : null
  const platformLimit = Number(env.MAX_UPLOAD_BYTES || 26214400)

  const limit = effectiveLimit(ext, orgLimit, platformLimit)

  const artifactId = prefixed('art', ulid())
  const versionId = prefixed('ver', ulid())

  const objectKey = buildObjectKey({
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    artifactId,
    versionId
  })

  const slug = slugify(input.title || filename)

  // 1. Artifact shell — canonical identity available immediately
  const insert = await run(
    db,
    `INSERT INTO artifacts
       (id, organization_id, workspace_id, owner_user_id, title, description, canonical_slug,
        filename, extension, mime_type, size_bytes, current_version_id, version_count,
        source_type, source_provider, status, status_detail, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, 'UPLOADING', ?, ?, ?, ?)`,
    [
      artifactId,
      input.organizationId,
      input.workspaceId,
      input.ownerUserId,
      input.title || filename,
      input.description ?? null,
      slug,
      filename,
      ext,
      input.mimeType ?? EXTENSION_MIME[ext] ?? 'application/octet-stream',
      input.sourceType,
      input.sourceProvider,
      'Upload initiated',
      JSON.stringify(input.metadata ?? {}),
      timestamp,
      timestamp
    ]
  )

  const seq = insert.meta?.last_row_id ?? null

  await recordJob(db, artifactId, versionId, 'SCAN', 'PENDING', { declaredExtension: ext })

  // 2. Validate + scan before anything is persisted
  const validation = validateUpload(ext, input.bytes, limit)

  if (!validation.ok) {
    await run(
      db,
      `UPDATE artifacts SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?`,
      [validation.status, validation.detail, nowIso(), artifactId]
    )
    await recordJob(db, artifactId, versionId, 'SCAN', 'FAILED', { ext }, validation.detail)
    await recordAudit(db, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      actorUserId: input.createdBy,
      actorType: input.sourceType === 'WEB_UPLOAD' ? 'USER' : 'AI',
      action: 'ARTIFACT_CREATE',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { status: validation.status, detail: validation.detail }
    })

    return {
      artifactId,
      versionId,
      status: validation.status,
      detail: validation.detail,
      canonicalUrl: `${origin}/a/${artifactId}`
    }
  }

  // 3. Store the binary
  const mimeType = input.mimeType ?? EXTENSION_MIME[ext] ?? 'application/octet-stream'
  const stored = await putObject(env, objectKey, input.bytes, mimeType)

  await run(
    db,
    `INSERT INTO artifact_versions
       (id, artifact_id, version_number, r2_object_key, filename, mime_type, extension,
        size_bytes, checksum, source_type, source_provider, change_summary,
        extracted_text, created_by_user_id, created_at, deleted_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [
      versionId,
      artifactId,
      objectKey,
      filename,
      mimeType,
      ext,
      stored.size,
      stored.checksum,
      input.sourceType,
      input.sourceProvider,
      'Initial version',
      input.createdBy,
      timestamp
    ]
  )

  await run(
    db,
    `UPDATE artifacts
        SET current_version_id = ?, version_count = 1, size_bytes = ?, checksum = ?,
            status = 'PROCESSING', status_detail = ?, updated_at = ?
      WHERE id = ?`,
    [versionId, stored.size, stored.checksum, 'Indexing', nowIso(), artifactId]
  )

  await recordJob(db, artifactId, versionId, 'SCAN', 'DONE', { ext, verdict: 'CLEAN' })

  // 4. Extract text, index, and finish
  await runPipeline(env, artifactId, versionId, ext, input.bytes)

  if (seq !== null) await indexArtifact(db, artifactId)

  const final = await first<ArtifactRow>(db, `SELECT * FROM artifacts WHERE id = ?`, [artifactId])

  await recordAudit(db, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    actorUserId: input.createdBy,
    actorType: input.sourceType === 'WEB_UPLOAD' ? 'USER' : 'AI',
    action: 'ARTIFACT_CREATE',
    targetType: 'artifact',
    targetId: artifactId,
    metadata: {
      filename,
      sizeBytes: stored.size,
      sourceType: input.sourceType,
      sourceProvider: input.sourceProvider
    }
  })

  return {
    artifactId,
    versionId,
    status: final?.status ?? 'READY',
    detail: final?.status_detail ?? 'Ready',
    canonicalUrl: `${origin}/a/${artifactId}`
  }
}

/**
 * Semantic indexing stage (PRD §31, §94).
 *
 * Loads the tenant identifiers from the artifact row so every vector carries
 * its own scope, embeds the version's extracted text in chunks, and records an
 * explicit EMBED job state. Bounded and non-throwing: uploads must never fail
 * because the vector index is unavailable.
 */
export async function runEmbeddingStage(
  env: Env,
  artifactId: string,
  versionId: string
): Promise<{ state: IndexState; chunks: number; vectors: number; reason: string }> {
  const db = env.DB

  try {
    const artifact = await first<{
      workspace_id: string
      organization_id: string | null
      owner_user_id: string
    }>(
      db,
      `SELECT workspace_id, organization_id, owner_user_id FROM artifacts WHERE id = ?`,
      [artifactId]
    )
    if (!artifact) {
      return { state: 'FAILED', chunks: 0, vectors: 0, reason: 'Artifact not found' }
    }

    const outcome = await reindexVersion(env, {
      artifactId,
      versionId,
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      ownerUserId: artifact.owner_user_id
    })

    await recordJob(db, artifactId, versionId, 'EMBED', outcome.state, {
      note: outcome.reason,
      chunks: outcome.chunks,
      vectors: outcome.vectors
    })

    return outcome
  } catch (err) {
    await recordJob(db, artifactId, versionId, 'EMBED', 'FAILED', {}, String(err)).catch(() => {})
    return { state: 'FAILED', chunks: 0, vectors: 0, reason: String(err).slice(0, 200) }
  }
}

/** Runs the post-storage stages of the §22 pipeline and records each job. */
async function runPipeline(
  env: Env,
  artifactId: string,
  versionId: string,
  ext: string,
  bytes: Uint8Array
): Promise<void> {
  const db = env.DB

  try {
    const extraction = await extractText(ext, bytes)
    if (extraction.text) {
      await run(db, `UPDATE artifact_versions SET extracted_text = ? WHERE id = ?`, [
        extraction.text,
        versionId
      ])
    }
    await recordJob(db, artifactId, versionId, 'EXTRACT', statusForExtraction(extraction), {
      note: extraction.note,
      chars: extraction.text?.length ?? 0,
      via: extraction.via
    })
  } catch (err) {
    await recordJob(db, artifactId, versionId, 'EXTRACT', 'FAILED', {}, String(err))
  }

  try {
    await indexArtifact(db, artifactId)
    await recordJob(db, artifactId, versionId, 'INDEX', 'DONE', {})
  } catch (err) {
    await recordJob(db, artifactId, versionId, 'INDEX', 'FAILED', {}, String(err))
  }

  // Thumbnail generation needs an image pipeline that the runtime cannot run
  await recordJob(db, artifactId, versionId, 'THUMBNAIL', 'SKIPPED', {
    note: 'Thumbnail generation requires an image processing service'
  })

  // Semantic indexing (PRD §31). Never throws: a failure here leaves lexical
  // search fully working and is recorded as an explicit state.
  await runEmbeddingStage(env, artifactId, versionId)

  const current = await first<{ status: string }>(db, `SELECT status FROM artifacts WHERE id = ?`, [
    artifactId
  ])
  if (current?.status === 'PROCESSING') {
    await run(
      db,
      `UPDATE artifacts SET status = 'READY', status_detail = 'Ready', updated_at = ? WHERE id = ?`,
      [nowIso(), artifactId]
    )
  }
}

// ---------------------------------------------------------------
// Version operations (§13, §14)
// ---------------------------------------------------------------

export interface CreateVersionInput {
  artifactId: string
  bytes: Uint8Array
  filename: string
  mimeType?: string
  sourceType: SourceType
  sourceProvider: SourceProvider | null
  changeSummary?: string | null
  createdBy: string
  makeCurrent?: boolean
}

export async function createVersion(
  env: Env,
  input: CreateVersionInput
): Promise<{ versionId: string; versionNumber: number; status: ArtifactStatus; detail: string }> {
  const db = env.DB

  const artifact = await first<ArtifactRow>(db, `SELECT * FROM artifacts WHERE id = ?`, [
    input.artifactId
  ])
  if (!artifact || artifact.deleted_at) throw notFound('Artifact not found')

  const filename = sanitizeFilename(input.filename)
  const ext = extensionOf(filename)

  const orgLimit = artifact.organization_id
    ? (await first<{ max_upload_bytes: number }>(
        db,
        `SELECT max_upload_bytes FROM organizations WHERE id = ?`,
        [artifact.organization_id]
      ))?.max_upload_bytes ?? null
    : null
  const platformLimit = Number(env.MAX_UPLOAD_BYTES || 26214400)
  const limit = effectiveLimit(ext, orgLimit, platformLimit)

  const versionId = prefixed('ver', ulid())
  const nextNumber =
    (await first<{ max_number: number | null }>(
      db,
      `SELECT MAX(version_number) AS max_number FROM artifact_versions WHERE artifact_id = ?`,
      [input.artifactId]
    ))?.max_number ?? 0

  const versionNumber = nextNumber + 1

  const objectKey = buildObjectKey({
    organizationId: artifact.organization_id,
    ownerUserId: artifact.owner_user_id,
    workspaceId: artifact.workspace_id,
    artifactId: artifact.id,
    versionId
  })

  const validation = validateUpload(ext, input.bytes, limit)
  if (!validation.ok) {
    return { versionId, versionNumber, status: validation.status, detail: validation.detail }
  }

  const mimeType = input.mimeType ?? EXTENSION_MIME[ext] ?? 'application/octet-stream'
  const stored = await putObject(env, objectKey, input.bytes, mimeType)
  const timestamp = nowIso()

  await run(
    db,
    `INSERT INTO artifact_versions
       (id, artifact_id, version_number, r2_object_key, filename, mime_type, extension,
        size_bytes, checksum, source_type, source_provider, change_summary,
        extracted_text, created_by_user_id, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    [
      versionId,
      input.artifactId,
      versionNumber,
      objectKey,
      filename,
      mimeType,
      ext,
      stored.size,
      stored.checksum,
      input.sourceType,
      input.sourceProvider,
      input.changeSummary ?? null,
      input.createdBy,
      timestamp
    ]
  )

  await recordJob(db, input.artifactId, versionId, 'SCAN', 'DONE', { ext, verdict: 'CLEAN' })

  const extraction = await extractText(ext, input.bytes)
  if (extraction.text) {
    await run(db, `UPDATE artifact_versions SET extracted_text = ? WHERE id = ?`, [
      extraction.text,
      versionId
    ])
  }
  await recordJob(db, input.artifactId, versionId, 'EXTRACT', statusForExtraction(extraction), {
    note: extraction.note,
    chars: extraction.text?.length ?? 0,
    via: extraction.via
  })

  if (input.makeCurrent !== false) {
    await run(
      db,
      `UPDATE artifacts
          SET current_version_id = ?, version_count = ?, filename = ?, extension = ?,
              mime_type = ?, size_bytes = ?, checksum = ?, updated_at = ?
        WHERE id = ?`,
      [
        versionId,
        versionNumber,
        filename,
        ext,
        mimeType,
        stored.size,
        stored.checksum,
        timestamp,
        input.artifactId
      ]
    )
  } else {
    await run(db, `UPDATE artifacts SET version_count = ?, updated_at = ? WHERE id = ?`, [
      versionNumber,
      timestamp,
      input.artifactId
    ])
  }

  await indexArtifact(db, input.artifactId)

  // Semantic re-index: replaces the previous version's vectors with this one's,
  // so a superseded version can never surface in semantic results.
  await runEmbeddingStage(env, input.artifactId, versionId)

  await recordAudit(db, {
    organizationId: artifact.organization_id,
    workspaceId: artifact.workspace_id,
    actorUserId: input.createdBy,
    actorType: input.sourceType === 'WEB_UPLOAD' ? 'USER' : 'AI',
    action: 'ARTIFACT_VERSION_CREATE',
    targetType: 'artifact',
    targetId: input.artifactId,
    metadata: { versionNumber, filename, sizeBytes: stored.size }
  })

  return { versionId, versionNumber, status: 'READY', detail: 'Version created' }
}

export async function listVersions(db: D1Database, artifactId: string): Promise<VersionRow[]> {
  return all<VersionRow>(
    db,
    `SELECT * FROM artifact_versions
      WHERE artifact_id = ? AND deleted_at IS NULL
      ORDER BY version_number DESC`,
    [artifactId]
  )
}

export async function getVersion(
  db: D1Database,
  artifactId: string,
  versionId: string
): Promise<VersionRow | null> {
  return first<VersionRow>(
    db,
    `SELECT * FROM artifact_versions WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
    [versionId, artifactId]
  )
}

/** Restore makes a prior version current again without deleting history (§14). */
export async function restoreVersion(
  db: D1Database,
  artifactId: string,
  versionId: string
): Promise<void> {
  const version = await getVersion(db, artifactId, versionId)
  if (!version) throw notFound('Version not found')

  await run(
    db,
    `UPDATE artifacts
        SET current_version_id = ?, filename = ?, extension = ?, mime_type = ?,
            size_bytes = ?, checksum = ?, updated_at = ?
      WHERE id = ?`,
    [
      version.id,
      version.filename,
      version.extension,
      version.mime_type,
      version.size_bytes,
      version.checksum,
      nowIso(),
      artifactId
    ]
  )

  await indexArtifact(db, artifactId)
}

export async function loadArtifact(db: D1Database, artifactId: string): Promise<ArtifactRow | null> {
  return first<ArtifactRow>(db, `SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL`, [
    artifactId
  ])
}

/** Soft delete preserves the audit trail and share history (§70, §104). */
/**
 * Soft-delete an artifact and purge its derived state.
 *
 * Delete is logical (the row is retained for audit and the canonical URL keeps
 * resolving to a neutral state), but derived indexes are removed outright:
 * the FTS row and every Vectorize vector. Leaving vectors behind would let a
 * deleted artifact keep occupying semantic result slots, so their removal is
 * part of the delete, not a background nicety (§94).
 */
export async function softDeleteArtifact(env: Env, artifactId: string): Promise<void> {
  const db = env.DB
  const artifact = await first<ArtifactRow & { seq: number }>(
    db,
    `SELECT * FROM artifacts WHERE id = ?`,
    [artifactId]
  )
  if (!artifact) throw notFound('Artifact not found')

  const timestamp = nowIso()
  await run(
    db,
    `UPDATE artifacts SET deleted_at = ?, status = 'DELETED', updated_at = ? WHERE id = ?`,
    [timestamp, timestamp, artifactId]
  )
  await run(db, `DELETE FROM artifact_search WHERE rowid = ?`, [artifact.seq])

  // Purge semantic vectors. Never fatal: a delete must succeed even if the
  // vector store is unavailable — the D1 bookkeeping rows go regardless, and a
  // later reindex of the artifact reconciles any orphan.
  try {
    await removeArtifactVectors(env, artifactId)
  } catch (err) {
    console.error('[artifacts] vector purge failed during delete', err)
    await run(db, `DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [artifactId]).catch(
      () => {}
    )
  }

  await run(db, `UPDATE shares SET status = 'REVOKED', revoked_at = ? WHERE target_type = 'ARTIFACT' AND target_id = ?`, [
    timestamp,
    artifactId
  ])
}

// ---------------------------------------------------------------
// Tag assignment (§25)
// ---------------------------------------------------------------

export async function assignTags(
  db: D1Database,
  artifactId: string,
  tagIds: string[],
  assignedBy: string
): Promise<{ added: number; removed: number }> {
  const existing = await all<{ tag_id: string }>(
    db,
    `SELECT tag_id FROM artifact_tags WHERE artifact_id = ?`,
    [artifactId]
  )
  const existingIds = new Set(existing.map((r) => r.tag_id))
  const desired = new Set(tagIds)

  let added = 0
  for (const tagId of desired) {
    if (existingIds.has(tagId)) continue
    await run(
      db,
      `INSERT OR IGNORE INTO artifact_tags (id, artifact_id, tag_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?, ?)`,
      [prefixed('atg', ulid()), artifactId, tagId, assignedBy, nowIso()]
    )
    added++
  }

  let removed = 0
  for (const tagId of existingIds) {
    if (desired.has(tagId)) continue
    await run(db, `DELETE FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`, [
      artifactId,
      tagId
    ])
    removed++
  }

  if (added || removed) await indexArtifact(db, artifactId)
  return { added, removed }
}

export async function tagsForArtifact(db: D1Database, artifactId: string): Promise<string[]> {
  const map = await loadTagsFor(db, [artifactId])
  return map.get(artifactId) ?? []
}

/** Ensure a title is present and within bounds; titles drive list rendering. */
export function normalizeTitle(raw: string | undefined, filename: string): string {
  const title = (raw ?? '').trim()
  if (title) return title.slice(0, 200)
  const dot = filename.lastIndexOf('.')
  return (dot > 0 ? filename.slice(0, dot) : filename).slice(0, 200)
}

export { kindForExtension }
