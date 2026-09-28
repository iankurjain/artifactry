/**
 * Re-extract and re-index an existing artifact version — PRD §31, §94.
 *
 * Why this exists: extraction and embedding run at upload time (§22). An
 * artifact uploaded *before* a parser or the vector index existed keeps its
 * original outcome forever, so improving the extractor or provisioning
 * Vectorize had no effect on existing content — the only way to get text was
 * to re-upload, which changes the version history and is not something a user
 * should have to do to fix a server-side capability.
 *
 * This path reads the original binary straight back out of R2 and re-runs the
 * *current* pipeline over it, so the stored copy is the single source of truth
 * and nothing depends on a user action:
 *
 *   version row → R2 original → extractText → extracted_text
 *              → EXTRACT job → (stale vectors deleted) → chunk
 *              → embed → upsert → EMBED job
 *
 * Extraction and indexing are recorded as **separate jobs** (EXTRACT vs EMBED)
 * so a Vectorize or Workers AI outage cannot mark extraction as failed, and a
 * parser failure cannot mark the index as failed. Each stage owns its own
 * state; neither erases the other's result.
 *
 * The whole operation is idempotent. Re-running it:
 *   - rewrites the same `extracted_text` for identical bytes,
 *   - updates the same EXTRACT/EMBED job rows (keyed by artifact+type+version),
 *   - upserts the same deterministic vector ids
 *     (`{artifactId}__{versionId}__{chunkIndex}`),
 * so a repeat run converges on the same state instead of duplicating rows.
 *
 * Never throws: callers always receive an explicit per-stage outcome.
 */

import type { ArtifactRow, Env, VersionRow } from '../types'
import { first, nowIso, run } from './db'
import { getObject } from './storage'
import { extractText } from './extract'
import { extensionOf } from './validate'
import { recordJob, statusForExtraction, type JobStatus } from './artifacts'
import { reindexVersion, type IndexState } from './embeddings'
import { indexArtifact } from './search'

export interface ReprocessOutcome {
  artifactId: string
  versionId: string
  extraction: {
    status: JobStatus
    chars: number
    note: string
    via: string
    /** False when R2 had no readable object — nothing could be attempted. */
    ran: boolean
  }
  index: {
    state: IndexState
    chunks: number
    vectors: number
    reason: string
  }
}

/**
 * Re-run extraction then indexing for one version.
 *
 * `runIndex` exists so a caller can re-extract without re-embedding (useful
 * when only the parser changed); the default runs both.
 */
export async function reprocessVersion(
  env: Env,
  artifactId: string,
  versionId: string,
  options: { runIndex?: boolean } = {}
): Promise<ReprocessOutcome> {
  const db = env.DB
  const runIndex = options.runIndex !== false

  const artifact = await first<ArtifactRow>(
    db,
    `SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL`,
    [artifactId]
  )
  const version = await first<VersionRow>(
    db,
    `SELECT * FROM artifact_versions WHERE id = ? AND artifact_id = ? AND deleted_at IS NULL`,
    [versionId, artifactId]
  )

  if (!artifact || !version) {
    return {
      artifactId,
      versionId,
      extraction: {
        status: 'SKIPPED',
        chars: 0,
        note: 'Artifact or version not found',
        via: 'reprocess',
        ran: false
      },
      index: { state: 'SKIPPED', chunks: 0, vectors: 0, reason: 'Nothing to index' }
    }
  }

  // ---------------------------------------------------------------
  // Stage 1 — extraction from the stored original
  // ---------------------------------------------------------------
  const ext = (version.extension || extensionOf(version.filename) || '').toLowerCase()
  let extraction: ReprocessOutcome['extraction']

  const object = await getObject(env, version.r2_object_key).catch(() => null)

  if (!object) {
    // The binary is gone from R2: the version row survives but cannot be
    // re-read. Recorded honestly rather than reported as an empty document.
    extraction = {
      status: 'FAILED',
      chars: 0,
      note: 'Original file is not available in storage, so it could not be re-extracted',
      via: 'r2-missing',
      ran: false
    }
    await recordJob(db, artifactId, versionId, 'EXTRACT', 'FAILED', {
      note: extraction.note,
      chars: 0
    })
  } else {
    try {
      const bytes = new Uint8Array(await object.arrayBuffer())
      const result = await extractText(ext, bytes)
      const status = statusForExtraction(result)

      if (result.text) {
        await run(
          db,
          `UPDATE artifact_versions SET extracted_text = ? WHERE id = ?`,
          [result.text, versionId]
        )
      }

      extraction = {
        status,
        chars: result.text?.length ?? 0,
        note: result.note,
        via: result.via,
        ran: true
      }

      await recordJob(db, artifactId, versionId, 'EXTRACT', status, {
        note: result.note,
        chars: result.text?.length ?? 0,
        via: result.via,
        reprocessed: true
      })
    } catch (err) {
      extraction = {
        status: 'FAILED',
        chars: 0,
        note: `Extraction error: ${String(err).slice(0, 160)}`,
        via: 'reprocess',
        ran: true
      }
      await recordJob(
        db,
        artifactId,
        versionId,
        'EXTRACT',
        'FAILED',
        { reprocessed: true },
        String(err)
      )
    }
  }

  // ---------------------------------------------------------------
  // Stage 2 — indexing (independent of stage 1's outcome)
  //
  // A failed parse still runs this: the artifact may already hold usable text
  // from an earlier run, and reindexVersion reconciles the index to whatever
  // text is actually stored.
  // ---------------------------------------------------------------
  let index: ReprocessOutcome['index'] = {
    state: 'SKIPPED',
    chunks: 0,
    vectors: 0,
    reason: 'Indexing not requested'
  }

  if (runIndex) {
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
      vectors: outcome.vectors,
      reprocessed: true
    })

    index = {
      state: outcome.state,
      chunks: outcome.chunks,
      vectors: outcome.vectors,
      reason: outcome.reason
    }
  }

  // Rebuild the lexical row so FTS reflects the newly extracted text.
  //
  // This is not optional bookkeeping: `artifact_search` is populated explicitly
  // (there are no triggers), and the FTS row is what the lexical engine matches
  // against. Without this call a re-extract updated `extracted_text` and the
  // vector index but left the keyword index holding the *old* text, so newly
  // recovered words were unfindable by search — the exact problem this path
  // exists to solve. `indexArtifact` re-reads current_version_id's text, so it
  // is also correct when the version being reprocessed is not the current one.
  await indexArtifact(db, artifactId).catch((err) => {
    console.error('[reprocess] lexical re-index failed', err)
  })

  await run(db, `UPDATE artifacts SET updated_at = ? WHERE id = ?`, [nowIso(), artifactId]).catch(
    () => {}
  )

  return { artifactId, versionId, extraction, index }
}
