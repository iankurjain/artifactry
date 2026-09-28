/**
 * Production backfill — re-extract every stored artifact version and index it.
 *
 * This runs the SHIPPED code: `extractText` and the chunking / vector-identity
 * helpers are imported from the real modules (bundled with esbuild), not
 * reimplemented. Only the transport is different — D1, R2, Workers AI and
 * Vectorize are reached over the REST API with the operator token, because the
 * Worker itself needs an authenticated user to accept a reindex request and the
 * product's authentication boundary is deliberately not bypassable.
 *
 * The result is identical to calling POST /:artifactId/reprocess for each
 * artifact: same extraction, same chunking, same deterministic vector ids, same
 * job rows and bookkeeping. Re-running converges rather than duplicating.
 *
 * Usage: node scripts/backfill-production.mjs
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const DB_ID = '10cb7bc6-41c5-4c9d-8788-6d1896531fd5'
const BUCKET = 'artifact-library-bucket'
const INDEX = 'artifact-library-embeddings'
const MODEL = '@cf/baai/bge-base-en-v1.5'
const API = 'https://api.cloudflare.com/client/v4'

if (!ACCOUNT || !TOKEN) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required')
  process.exit(1)
}

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// ---------------------------------------------------------------
// Bundle the real modules
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
for (const [entry, out] of [
  ['src/lib/extract.ts', 'extract-bf.mjs'],
  ['src/lib/embeddings.ts', 'embeddings-bf.mjs']
]) {
  await build({
    entryPoints: [entry],
    outfile: `/tmp/build/${out}`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'error'
  })
}

const { extractText } = await import(pathToFileURL('/tmp/build/extract-bf.mjs').href)
const { chunkText, vectorIdFor, buildMetadata, EMBEDDING_DIMENSIONS } = await import(
  pathToFileURL('/tmp/build/embeddings-bf.mjs').href
)

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------

async function d1(sql, params = []) {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ sql, params })
  })
  const json = await res.json()
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message ?? `D1 error: ${JSON.stringify(json).slice(0, 200)}`)
  }
  return json.result?.[0]?.results ?? []
}

async function r2Get(key) {
  const res = await fetch(
    `${API}/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/${key}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  )
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}

async function embed(texts) {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ text: texts })
  })
  const json = await res.json()
  const data = json?.result?.data
  if (!Array.isArray(data) || data.length !== texts.length) return null
  for (const v of data) if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) return null
  return data
}

async function vectorUpsert(vectors) {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}/upsert`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ vectors })
  })
  const json = await res.json()
  if (!json.success) throw new Error(json.errors?.[0]?.message ?? 'Vectorize upsert failed')
  return json.result?.mutationId ?? null
}

const iso = () => new Date().toISOString()
const uid = (p) =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.toUpperCase()

/** Upsert a processing_jobs row the same way recordJob does. */
async function recordJob(artifactId, versionId, type, status, detail = {}) {
  const existing = await d1(
    `SELECT id, attempts FROM processing_jobs
      WHERE artifact_id = ? AND job_type = ? AND COALESCE(version_id,'') = COALESCE(?, '')`,
    [artifactId, type, versionId]
  )
  if (existing.length) {
    await d1(
      `UPDATE processing_jobs SET status = ?, detail_json = ?, last_error = NULL,
              attempts = ?, updated_at = ? WHERE id = ?`,
      [status, JSON.stringify(detail), existing[0].attempts + 1, iso(), existing[0].id]
    )
  } else {
    await d1(
      `INSERT INTO processing_jobs
         (id, artifact_id, version_id, job_type, status, attempts, last_error, detail_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
      [uid('job'), artifactId, versionId, type, status, JSON.stringify(detail), iso(), iso()]
    )
  }
}

/** Mirrors statusForExtraction() in src/lib/artifacts.ts. */
function statusForExtraction(r) {
  if (r.ok) return 'DONE'
  if (r.supported) return 'PARTIAL'
  return 'SKIPPED'
}

// ---------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------

const versions = await d1(
  `SELECT v.id AS version_id, v.artifact_id, v.extracted_text, v.r2_object_key,
          v.filename, v.extension, v.mime_type,
          a.workspace_id, a.organization_id, a.owner_user_id, a.deleted_at
     FROM artifact_versions v
     JOIN artifacts a ON a.id = v.artifact_id
    WHERE v.deleted_at IS NULL AND a.deleted_at IS NULL
    ORDER BY v.artifact_id`
)

console.log(`Backfilling ${versions.length} version(s)\n`)
const report = []

for (const v of versions) {
  const ext = (v.extension || '').toLowerCase()
  console.log(`--- ${v.artifact_id} (${ext || 'unknown'}) ${v.filename}`)

  // Stage 1 — extraction from the stored original
  let extraction = { status: 'SKIPPED', chars: 0, note: '', via: '', ran: false }
  const bytes = await r2Get(v.r2_object_key)

  if (!bytes) {
    extraction = {
      status: 'FAILED',
      chars: 0,
      note: 'Original file not available in storage',
      via: 'r2-missing',
      ran: false
    }
    await recordJob(v.artifact_id, v.version_id, 'EXTRACT', 'FAILED', { note: extraction.note })
  } else {
    const result = await extractText(ext, bytes)
    const status = statusForExtraction(result)
    if (result.text) {
      await d1(`UPDATE artifact_versions SET extracted_text = ? WHERE id = ?`, [
        result.text,
        v.version_id
      ])
    }
    extraction = {
      status,
      chars: result.text?.length ?? 0,
      note: result.note,
      via: result.via,
      ran: true
    }
    await recordJob(v.artifact_id, v.version_id, 'EXTRACT', status, {
      note: result.note,
      chars: extraction.chars,
      via: result.via,
      reprocessed: true
    })
  }

  // Stage 2 — indexing, independent of stage 1 (separate job row)
  const text = await d1(`SELECT extracted_text FROM artifact_versions WHERE id = ?`, [v.version_id])
  const stored = text[0]?.extracted_text ?? null
  const chunks = chunkText(stored)

  let index = { state: 'PARTIAL', chunks: 0, vectors: 0, reason: '' }

  const prior = await d1(
    `SELECT vector_id FROM artifact_embeddings WHERE artifact_id = ?`,
    [v.artifact_id]
  )

  if (!chunks.length) {
    // Understood the format but nothing embeddable — no empty vectors invented.
    if (prior.length) {
      await d1(`DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [v.artifact_id])
    }
    index = {
      state: 'PARTIAL',
      chunks: 0,
      vectors: 0,
      reason: 'No extractable text to embed (empty or scanned document) — searchable by metadata'
    }
  } else {
    const vectors = await embed(chunks.map((c) => c.text))
    if (!vectors) {
      index = {
        state: 'FAILED',
        chunks: chunks.length,
        vectors: 0,
        reason: 'Embedding model unavailable — lexical search only'
      }
    } else {
      const records = chunks.map((chunk, i) => ({
        id: vectorIdFor(v.artifact_id, v.version_id, chunk.index),
        values: vectors[i],
        metadata: buildMetadata({
          artifactId: v.artifact_id,
          versionId: v.version_id,
          workspaceId: v.workspace_id,
          organizationId: v.organization_id,
          ownerUserId: v.owner_user_id,
          chunkIndex: chunk.index,
          chunkTotal: chunks.length
        })
      }))

      await vectorUpsert(records)
      await d1(`DELETE FROM artifact_embeddings WHERE artifact_id = ?`, [v.artifact_id])

      const ts = iso()
      for (const r of records) {
        await d1(
          `INSERT INTO artifact_embeddings
             (id, artifact_id, version_id, chunk_index, chunk_text, vector_id, provider,
              status, workspace_id, organization_id, chunk_total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'WORKERS_AI', 'INDEXED', ?, ?, ?, ?, ?)`,
          [
            r.id,
            v.artifact_id,
            v.version_id,
            r.metadata.chunkIndex,
            chunks[r.metadata.chunkIndex]?.text.slice(0, 4000) ?? '',
            r.id,
            v.workspace_id,
            v.organization_id,
            chunks.length,
            ts,
            ts
          ]
        )
      }

      index = {
        state: 'INDEXED',
        chunks: chunks.length,
        vectors: records.length,
        reason: `${records.length} chunk vector(s) indexed`
      }
    }
  }

  await recordJob(v.artifact_id, v.version_id, 'EMBED', index.state, {
    note: index.reason,
    chunks: index.chunks,
    vectors: index.vectors,
    reprocessed: true
  })

  const row = {
    artifactId: v.artifact_id,
    filename: v.filename,
    ext,
    extract: extraction.status,
    chars: extraction.chars,
    index: index.state,
    vectors: index.vectors,
    note: extraction.note || index.reason
  }
  report.push(row)

  console.log(
    `    EXTRACT ${extraction.status} (${extraction.chars} chars)  |  INDEX ${index.state} (${index.vectors} vectors)`
  )
  console.log(`    ${row.note.slice(0, 100)}`)
}

console.log(`\n${'='.repeat(70)}`)
console.log('artifact                                  extract  chars  index     vec')
console.log('-'.repeat(70))
for (const r of report) {
  console.log(
    `${r.artifactId.padEnd(40)} ${r.extract.padEnd(8)} ${String(r.chars).padStart(5)}  ${r.index.padEnd(8)} ${String(r.vectors).padStart(3)}`
  )
}

const summary = report.reduce((acc, r) => {
  const k = `${r.extract}/${r.index}`
  acc[k] = (acc[k] ?? 0) + 1
  return acc
}, {})
console.log(`\nSummary (EXTRACT/INDEX): ${JSON.stringify(summary)}`)
console.log('Backfill complete.')
