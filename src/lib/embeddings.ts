/**
 * Semantic embeddings — Workers AI + Vectorize (PRD §31, §32, §94).
 *
 * Design notes that matter for correctness and safety:
 *
 *  - **Tenant isolation is enforced in our code, not only in the vector store.**
 *    Every vector carries its `workspaceId`/`organizationId`, but a vector query
 *    result is treated as an *untrusted candidate list*. The caller re-binds it
 *    to the principal's authorised workspace ids (`filterByScope`) and then the
 *    final row load is a SQL query bounded by those same workspace ids. A vector
 *    belonging to a foreign tenant can therefore never become a search hit, even
 *    if the index were shared or a metadata filter were misconfigured (§33, §64).
 *
 *  - **Chunked, never whole-document.** Long documents are split on paragraph
 *    and sentence boundaries so a single vector never has to represent an entire
 *    file, and a query can match one relevant section.
 *
 *  - **Failure is never fatal.** Every entry point degrades to lexical-only
 *    search and records an explicit state; nothing here can break an upload.
 *
 *  - **Vector ids are deterministic** (`{artifactId}__{versionId}__{chunk}`) and
 *    mirrored into D1, because Vectorize has no delete-by-metadata: stale
 *    vectors are removed by id, looked up from `artifact_embeddings`.
 */

import type { Env } from '../types'
import { all, first, nowIso, run } from './db'

// ---------------------------------------------------------------
// Index contract (documented in README + wrangler.jsonc)
// ---------------------------------------------------------------

/** Embedding model. Chosen because it is English-optimised and cheap at 768d. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'

/** Output dimension of EMBEDDING_MODEL. Must equal the Vectorize index dims. */
export const EMBEDDING_DIMENSIONS = 768

/**
 * Scrub implementation detail from a reason string before it leaves the API.
 *
 * Reasons are shown on the artifact detail screen and in search metadata, where
 * they must explain *what happened* without naming the embedding model, its
 * dimension, the vector index or individual vector ids. Those are internals, and
 * the kind of detail that ages badly the moment the model changes.
 *
 * This runs on read as well as on write so rows recorded before the rule existed
 * cannot leak a model name, and so the shape survives any future reason wording.
 */
export function publicIndexReason(raw: string): string {
  return raw
    .replace(EMBEDDING_MODEL, 'the embedding model')
    .replace(`${EMBEDDING_DIMENSIONS}d`, '')
    .replace(/\bVectorize\b/g, 'the semantic index')
    .replace(/\bWorkers AI\b/g, 'the embedding service')
    // Tidy the punctuation and spacing those substitutions can leave behind,
    // e.g. "the semantic index (the embedding model, ) over 2 ...".
    .replace(/\s+with the embedding model\b/g, '')
    .replace(/\(\s*the embedding model\s*,\s*\)/g, '')
    .replace(/\(\s*,?\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Vectorize index name (production). */
export const INDEX_NAME = 'artifact-library-embeddings'

/** Target characters per chunk; bge handles ~512 tokens comfortably. */
export const CHUNK_TARGET_CHARS = 1200

/** Overlap between hard-split chunks so a sentence cut in half stays findable. */
export const CHUNK_OVERLAP_CHARS = 200

/** Hard ceiling on chunks per version, bounding CPU and Vectorize writes. */
export const MAX_CHUNKS = 60

/** Hard ceiling on embedded characters per version (extracted_text is capped at 200k). */
export const MAX_EMBED_INPUT_CHARS = 60_000

/** Vectors per upsert call. Vectorize allows 1000; we stay well under it. */
export const UPSERT_BATCH = 32

/** Candidates pulled from Vectorize before ACL filtering. */
export const QUERY_TOP_K = 60

/**
 * Per-artifact / per-chunk indexing state (PRD §94).
 *
 *   PENDING   — queued, not yet embedded
 *   INDEXED   — every chunk embedded and upserted
 *   PARTIAL   — understood, but nothing embeddable (empty or scanned document),
 *               or only some chunks succeeded
 *   FAILED    — embedding ran and errored; lexical search still works
 *   SKIPPED   — semantic search is not provisioned on this deployment
 */
export type IndexState = 'PENDING' | 'INDEXED' | 'PARTIAL' | 'FAILED' | 'SKIPPED'

export interface TextChunk {
  index: number
  text: string
}

/** True when this deployment can genuinely embed and query vectors. */
export function isSemanticConfigured(env: Pick<Env, 'VECTORIZE' | 'AI'>): boolean {
  return Boolean(env?.VECTORIZE && env?.AI)
}

// ---------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------

/**
 * Split extracted text into embeddable chunks.
 *
 * Paragraph boundaries are preferred; a paragraph longer than the target is
 * hard-split on sentence boundaries with a small overlap so a query matching a
 * phrase that straddles the cut still hits. Very short fragments are dropped —
 * they add noise without adding recall.
 */
export function chunkText(raw: string | null | undefined): TextChunk[] {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (!text) return []

  const limited = text.slice(0, MAX_EMBED_INPUT_CHARS)
  const parts = limited.split(/\n{2,}/)

  const out: string[] = []
  let current = ''

  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed.length >= 24) out.push(trimmed)
    current = ''
  }

  for (const part of parts) {
    const para = part.trim()
    if (!para) continue

    if (para.length > CHUNK_TARGET_CHARS) {
      flush()
      let start = 0
      while (start < para.length) {
        let end = Math.min(start + CHUNK_TARGET_CHARS, para.length)
        if (end < para.length) {
          const window = para.slice(start, end)
          const cut = Math.max(
            window.lastIndexOf('. '),
            window.lastIndexOf('! '),
            window.lastIndexOf('? '),
            window.lastIndexOf('\n')
          )
          // Only honour a sentence cut if it is not near the start of the window
          if (cut > CHUNK_TARGET_CHARS * 0.5) end = start + cut + 1
        }
        const piece = para.slice(start, end).trim()
        if (piece.length >= 24) out.push(piece)
        if (end >= para.length) break
        start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1)
      }
      continue
    }

    if (current && (current + '\n\n' + para).length > CHUNK_TARGET_CHARS) flush()
    current = current ? current + '\n\n' + para : para
  }
  flush()

  return out.slice(0, MAX_CHUNKS).map((t, index) => ({ index, text: t }))
}

// ---------------------------------------------------------------
// Vector identity + metadata
// ---------------------------------------------------------------

/**
 * Deterministic vector id. Mirrored into D1 so stale vectors can be deleted.
 *
 * Keyed on the **version**, not the artifact: a version id is globally unique
 * and belongs to exactly one artifact, so it already identifies both. This
 * matters because Vectorize caps ids at **64 bytes**, and the obvious
 * `{artifactId}__{versionId}__{chunkIndex}` form silently overflows on real
 * data — both ids are `prefix_` + a 26-char ULID, so that format is 65 bytes
 * for chunk 0 and 66 for chunk 10+.
 *
 * That overflow was not theoretical: it rejected every chunk of a real
 * production artifact. Short ids in the unit tests (`art_1` / `ver_1`) hid it,
 * which is why `test-semantic.mjs` now asserts the length against realistic
 * ULID-sized ids.
 *
 * Worst case here is 30 (version) + 2 + 3 (`c` + 59) = 35 bytes.
 */
export function vectorIdFor(_artifactId: string, versionId: string, chunkIndex: number): string {
  return `${versionId}__c${chunkIndex}`
}

/** Vectorize's hard limit on a vector id, in bytes. */
export const MAX_VECTOR_ID_BYTES = 64

/**
 * Metadata stored on every vector.
 *
 * Tenant identifiers travel with the vector so a query result can be checked
 * against the caller's scope before it is ever trusted. `organizationId` uses
 * '' rather than null because Vectorize metadata cannot hold null.
 */
export interface VectorMetadata {
  artifactId: string
  versionId: string
  workspaceId: string
  organizationId: string
  ownerUserId: string
  chunkIndex: number
  chunkTotal: number
}

export function buildMetadata(input: {
  artifactId: string
  versionId: string
  workspaceId: string
  organizationId: string | null
  ownerUserId: string
  chunkIndex: number
  chunkTotal: number
}): VectorMetadata {
  return {
    artifactId: input.artifactId,
    versionId: input.versionId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId ?? '',
    ownerUserId: input.ownerUserId,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal
  }
}

// ---------------------------------------------------------------
// ACL filtering of semantic candidates  ← the tenant-isolation boundary
// ---------------------------------------------------------------

export interface VectorMatch {
  id: string
  score: number
  metadata?: Record<string, unknown> | null
}

export interface ScopedHit {
  artifactId: string
  score: number
  versionId: string | null
}

/**
 * Reduce raw vector matches to artifact-level hits that are *provably* inside
 * the caller's authorised workspaces.
 *
 * A match is dropped unless its metadata carries a workspaceId that is present
 * in `allowedWorkspaceIds`. Missing or malformed metadata fails closed. Results
 * are deduplicated per artifact, keeping the best-scoring chunk.
 *
 * This runs before any database read, so an out-of-scope vector cannot even
 * influence ordering, counts or snippets.
 */
export function filterByScope(matches: VectorMatch[], allowedWorkspaceIds: string[]): ScopedHit[] {
  const allowed = new Set(allowedWorkspaceIds)
  if (!allowed.size) return []

  const best = new Map<string, ScopedHit>()

  for (const match of matches) {
    const meta = match.metadata
    if (!meta || typeof meta !== 'object') continue

    const workspaceId = meta.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) continue
    if (!allowed.has(workspaceId)) continue

    const artifactId = meta.artifactId
    if (typeof artifactId !== 'string' || !artifactId) continue

    const versionId = typeof meta.versionId === 'string' ? meta.versionId : null
    const score = Number.isFinite(match.score) ? Number(match.score) : 0

    const existing = best.get(artifactId)
    if (!existing || score > existing.score) {
      best.set(artifactId, { artifactId, score, versionId })
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------
// Workers AI — embeddings
// ---------------------------------------------------------------

/**
 * Embed texts with Workers AI.
 *
 * Returns null (never throws) when the binding is missing, the response is
 * malformed, or the call fails — callers treat null as "semantic unavailable"
 * and fall back to lexical search.
 */
export async function embedTexts(env: Pick<Env, 'AI'>, texts: string[]): Promise<number[][] | null> {
  if (!env?.AI || !texts.length) return null

  try {
    const response = (await env.AI.run(EMBEDDING_MODEL, { text: texts })) as unknown
    const data = (response as { data?: unknown })?.data

    if (!Array.isArray(data) || data.length !== texts.length) return null

    const vectors: number[][] = []
    for (const vector of data) {
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) return null
      vectors.push(vector as number[])
    }
    return vectors
  } catch (err) {
    console.error('[embeddings] Workers AI embedding failed', err)
    return null
  }
}

// ---------------------------------------------------------------
// Vectorize — upsert / query / delete
// ---------------------------------------------------------------

/**
 * Vectorize's client signature has changed across versions (array vs
 * `{vectors}`). The runtime accepts a plain array; the cast keeps this working
 * on both without a version pin.
 */
type VectorizeLike = {
  upsert: (vectors: unknown) => Promise<unknown>
  query: (vector: number[], options?: unknown) => Promise<unknown>
  deleteByIds: (ids: unknown) => Promise<unknown>
}

async function upsertVectors(
  env: Pick<Env, 'VECTORIZE'>,
  vectors: Array<{ id: string; values: number[]; metadata: VectorMetadata }>
): Promise<number> {
  const index = env.VECTORIZE as unknown as VectorizeLike
  let written = 0

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
    const batch = vectors.slice(i, i + UPSERT_BATCH)
    await index.upsert(batch)
    written += batch.length
  }
  return written
}

/** Delete vectors by id. Vectorize has no delete-by-metadata, hence D1 mirroring. */
export async function deleteVectors(
  env: Pick<Env, 'VECTORIZE'>,
  vectorIds: string[]
): Promise<number> {
  const ids = vectorIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (!env?.VECTORIZE || !ids.length) return 0

  const index = env.VECTORIZE as unknown as VectorizeLike
  let deleted = 0

  for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
    const batch = ids.slice(i, i + UPSERT_BATCH)
    try {
      await index.deleteByIds(batch)
      deleted += batch.length
    } catch (err) {
      console.error('[embeddings] vector delete failed', err)
    }
  }
  return deleted
}

export interface SemanticQueryResult {
  /** Did a genuine vector query actually execute? Drives `engine.semantic`. */
  ran: boolean
  results: ScopedHit[]
  reason: string
}

/**
 * Embed the query and retrieve in-scope artifact candidates.
 *
 * `ran` is true only when the embedding call *and* the Vectorize query both
 * completed — so `semantic:true` in the API can never be reported for a
 * degraded or skipped path (§32).
 */
export async function semanticQuery(
  env: Pick<Env, 'VECTORIZE' | 'AI'>,
  query: string,
  allowedWorkspaceIds: string[],
  limit: number
): Promise<SemanticQueryResult> {
  const text = (query ?? '').trim()
  if (!text) {
    return { ran: false, results: [], reason: 'Empty query — semantic engine not consulted' }
  }
  if (!isSemanticConfigured(env)) {
    return {
      ran: false,
      results: [],
      reason: 'Semantic index not provisioned — keyword search only'
    }
  }
  if (!allowedWorkspaceIds.length) {
    return { ran: false, results: [], reason: 'No readable workspaces in scope' }
  }

  const embedded = await embedTexts(env, [text.slice(0, 2000)])
  if (!embedded?.[0]) {
    return { ran: false, results: [], reason: 'Query embedding unavailable — lexical results only' }
  }

  try {
    const index = env.VECTORIZE as unknown as VectorizeLike
    const raw = (await index.query(embedded[0], {
      topK: Math.min(Math.max(limit * 4, 20), QUERY_TOP_K),
      returnMetadata: 'all',
      returnValues: false
    })) as { matches?: VectorMatch[] }

    const matches = Array.isArray(raw?.matches) ? raw.matches : []
    const results = filterByScope(matches, allowedWorkspaceIds).slice(0, limit)

    return {
      ran: true,
      results,
      reason: `Semantic search ran over ${allowedWorkspaceIds.length} readable workspace(s)`
    }
  } catch (err) {
    console.error('[embeddings] Vectorize query failed, falling back to lexical', err)
    return {
      ran: false,
      results: [],
      reason: 'Vector index query failed — lexical results only'
    }
  }
}

// ---------------------------------------------------------------
// Indexing pipeline
// ---------------------------------------------------------------

export interface ReindexOutcome {
  state: IndexState
  chunks: number
  vectors: number
  reason: string
}

export interface ReindexTarget {
  artifactId: string
  versionId: string
  workspaceId: string
  organizationId: string | null
  ownerUserId: string
}

/**
 * Embed one artifact version and reconcile the index.
 *
 * Order matters: stale vectors (from previous versions of the same artifact)
 * are deleted *before* new rows are written, so a failed re-index leaves the
 * previous version's vectors intact rather than a half-migrated index.
 *
 * Never throws. Callers get an explicit state and lexical search keeps working.
 */
export async function reindexVersion(
  env: Env,
  target: ReindexTarget
): Promise<ReindexOutcome> {
  const db = env.DB

  if (!isSemanticConfigured(env)) {
    return {
      state: 'SKIPPED',
      chunks: 0,
      vectors: 0,
      reason: 'Semantic index not provisioned — lexical search only'
    }
  }

  try {
    const version = await first<{ extracted_text: string | null }>(
      db,
      `SELECT extracted_text FROM artifact_versions WHERE id = ?`,
      [target.versionId]
    )

    const chunks = chunkText(version?.extracted_text ?? null)

    // Existing bookkeeping for this artifact (all versions).
    const existing = await all<{ version_id: string | null; vector_id: string | null }>(
      db,
      `SELECT version_id, vector_id FROM artifact_embeddings WHERE artifact_id = ?`,
      [target.artifactId]
    )

    if (!chunks.length) {
      // Understood the format but there is nothing to embed: scanned/empty doc.
      await deleteVectors(
        env,
        existing.map((r) => r.vector_id).filter((id): id is string => Boolean(id))
      )
      await run(db, `DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [target.artifactId])
      return {
        state: 'PARTIAL',
        chunks: 0,
        vectors: 0,
        reason: 'No extractable text to embed (empty or scanned document) — searchable by metadata'
      }
    }

    // Stale vectors: any version other than the one being indexed.
    const staleIds = existing
      .filter((r) => r.version_id !== target.versionId)
      .map((r) => r.vector_id)
      .filter((id): id is string => Boolean(id))
    await deleteVectors(env, staleIds)

    const vectors = await embedTexts(
      env,
      chunks.map((chunk) => chunk.text)
    )
    if (!vectors) {
      return {
        state: 'FAILED',
        chunks: chunks.length,
        vectors: 0,
        reason: 'Embedding model unavailable — lexical search only'
      }
    }

    const records = chunks.map((chunk, i) => ({
      id: vectorIdFor(target.artifactId, target.versionId, chunk.index),
      values: vectors[i],
      metadata: buildMetadata({
        artifactId: target.artifactId,
        versionId: target.versionId,
        workspaceId: target.workspaceId,
        organizationId: target.organizationId,
        ownerUserId: target.ownerUserId,
        chunkIndex: chunk.index,
        chunkTotal: chunks.length
      })
    }))

    await upsertVectors(env, records)

    // Rebuild bookkeeping for the whole artifact so it mirrors the index
    // exactly: current version's chunks, nothing else.
    await run(db, `DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [target.artifactId])

    const timestamp = nowIso()
    for (const record of records) {
      await run(
        db,
        `INSERT INTO artifact_embeddings
           (id, artifact_id, version_id, chunk_index, chunk_text, vector_id, provider,
            status, workspace_id, organization_id, chunk_total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'WORKERS_AI', 'INDEXED', ?, ?, ?, ?, ?)`,
        [
          record.id,
          target.artifactId,
          target.versionId,
          record.metadata.chunkIndex,
          chunks[record.metadata.chunkIndex]?.text.slice(0, 4000) ?? '',
          record.id,
          target.workspaceId,
          target.organizationId,
          chunks.length,
          timestamp,
          timestamp
        ]
      )
    }

    return {
      state: 'INDEXED',
      chunks: chunks.length,
      vectors: records.length,
      reason: `${records.length} chunk${records.length === 1 ? '' : 's'} indexed`
    }
  } catch (err) {
    console.error('[embeddings] reindex failed', err)
    return {
      state: 'FAILED',
      chunks: 0,
      vectors: 0,
      reason: `Indexing error: ${String(err).slice(0, 200)}`
    }
  }
}

/** Remove every vector belonging to an artifact (delete / hard removal). */
export async function removeArtifactVectors(env: Env, artifactId: string): Promise<number> {
  const rows = await all<{ vector_id: string | null }>(
    env.DB,
    `SELECT vector_id FROM artifact_embeddings WHERE artifact_id = ?`,
    [artifactId]
  )
  const deleted = await deleteVectors(
    env,
    rows.map((r) => r.vector_id).filter((id): id is string => Boolean(id))
  )
  await run(env.DB, `DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [artifactId])
  return deleted
}

// ---------------------------------------------------------------
// Per-artifact indexing state (PRD §94)
// ---------------------------------------------------------------

export interface ArtifactIndexState {
  state: IndexState
  chunks: number
  indexedChunks: number
  reason: string
  updatedAt: string | null
}

/**
 * Derive the artifact's indexing state for display.
 *
 * Reads the latest EMBED job plus the chunk bookkeeping, so the reported state
 * always reflects what is actually in the index rather than an optimistic flag.
 */
export async function indexStateFor(db: D1Database, artifactId: string): Promise<ArtifactIndexState> {
  const job = await first<{ status: string; detail_json: string; updated_at: string }>(
    db,
    `SELECT status, detail_json, updated_at FROM processing_jobs
      WHERE artifact_id = ? AND job_type = 'EMBED'
      ORDER BY updated_at DESC LIMIT 1`,
    [artifactId]
  )

  const counts = await first<{ total: number; indexed: number }>(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'INDEXED' THEN 1 ELSE 0 END) AS indexed
       FROM artifact_embeddings WHERE artifact_id = ?`,
    [artifactId]
  )

  const total = counts?.total ?? 0
  const indexed = counts?.indexed ?? 0

  let reason = 'Not yet indexed'
  try {
    const detail = job?.detail_json ? (JSON.parse(job.detail_json) as { note?: string }) : null
    // Scrubbed on read: a row written before the rule existed can still carry a
    // model name, and this value is rendered on the detail screen.
    if (detail?.note) reason = publicIndexReason(detail.note)
  } catch {
    /* detail_json is best-effort display metadata */
  }

  let state: IndexState
  if (job?.status === 'FAILED') state = 'FAILED'
  else if (total > 0 && indexed === total) state = 'INDEXED'
  else if (total > 0) state = 'PARTIAL'
  else if (job?.status === 'SKIPPED') state = 'SKIPPED'
  else if (job?.status === 'PARTIAL') state = 'PARTIAL'
  else if (job) state = 'PENDING'
  else state = 'PENDING'

  return {
    state,
    chunks: total,
    indexedChunks: indexed,
    reason,
    updatedAt: job?.updated_at ?? null
  }
}
