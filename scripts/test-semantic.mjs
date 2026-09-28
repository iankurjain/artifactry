/**
 * Semantic search test suite — tenant isolation, workspace authorization,
 * stale-version vectors, empty/scanned documents and Vectorize failure fallback.
 *
 * Runs the real Worker module (bundled with esbuild, platform: neutral) against
 * an in-memory D1 double and controllable AI/Vectorize doubles. The point is to
 * exercise the actual shipped code paths, not a reimplementation of them:
 * `chunkText`, `filterByScope`, `semanticQuery`, `reindexVersion`,
 * `removeArtifactVectors` and `indexStateFor` are all imported from source.
 *
 * Run: node scripts/test-semantic.mjs
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failures = 0
let passes = 0

function check(name, condition, detail = '') {
  if (condition) {
    passes++
    console.log(`  [PASS] ${name}`)
  } else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------
// Bundle the real module
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
await build({
  entryPoints: ['src/lib/embeddings.ts'],
  outfile: '/tmp/build/embeddings.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const emb = await import(pathToFileURL('/tmp/build/embeddings.mjs').href)
const {
  chunkText,
  vectorIdFor,
  buildMetadata,
  filterByScope,
  isSemanticConfigured,
  embedTexts,
  semanticQuery,
  reindexVersion,
  removeArtifactVectors,
  indexStateFor,
  MAX_VECTOR_ID_BYTES,
  EMBEDDING_DIMENSIONS,
  MAX_CHUNKS
} = emb

console.log('Semantic search test suite')
console.log(`model dims: ${EMBEDDING_DIMENSIONS}`)

// ---------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------

/** Deterministic pseudo-embedding of the right dimension. */
function fakeVector(seed, dims = EMBEDDING_DIMENSIONS) {
  const v = new Array(dims)
  let h = 2166136261
  for (let i = 0; i < String(seed).length; i++) {
    h ^= String(seed).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = 0; i < dims; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    v[i] = ((h >>> 0) % 1000) / 1000
  }
  return v
}

/** Workers AI double. `mode` selects success / outage / malformed. */
function makeAI(mode = 'ok') {
  return {
    async run(model, input) {
      if (mode === 'throw') throw new Error('AI outage')
      if (mode === 'malformed') return { data: [[1, 2, 3]] }
      if (mode === 'no-data') return {}
      const texts = input.text ?? []
      return { data: texts.map((t) => fakeVector(t)) }
    }
  }
}

/** Vectorize double recording writes so stale-vector behaviour is observable. */
function makeVectorize(mode = 'ok') {
  const state = {
    upserted: [],
    deleted: [],
    /** matches returned by query(), as Vectorize would after ANN lookup */
    matches: []
  }
  return {
    state,
    async upsert(vectors) {
      if (mode === 'throw') throw new Error('Vectorize write outage')
      state.upserted.push(...vectors)
    },
    async query() {
      if (mode === 'throw') throw new Error('Vectorize query outage')
      return { matches: state.matches }
    },
    async deleteByIds(ids) {
      if (mode === 'throw') throw new Error('Vectorize delete outage')
      state.deleted.push(...ids)
    }
  }
}

/**
 * Minimal in-memory D1 double covering exactly the statements the embedding
 * module issues. Throws on an unrecognised statement so a future query change
 * fails loudly here rather than silently passing.
 */
function makeDB(seed = {}) {
  const tables = {
    artifact_versions: seed.artifact_versions ?? [],
    artifact_embeddings: seed.artifact_embeddings ?? [],
    processing_jobs: seed.processing_jobs ?? []
  }

  /**
   * Statement double. `bind()` must return another statement-like object
   * (not the raw result), because db.ts does `prepare(sql).bind(...)` and then
   * calls .first()/.all()/.run() on the result of that chain.
   */
  function statement(sql, bound = []) {
    const norm = sql.replace(/\s+/g, ' ').trim()
    return {
      bind(...params) {
        return statement(sql, params)
      },
      async first() {
        return (await execute(norm, bound)).results?.[0] ?? null
      },
      async all() {
        return execute(norm, bound)
      },
      async run() {
        return execute(norm, bound)
      }
    }
  }

  async function execute(norm, params) {
    // --- artifact_versions -------------------------------------------
    if (norm.startsWith('SELECT extracted_text FROM artifact_versions WHERE id = ?')) {
      const row = tables.artifact_versions.find((v) => v.id === params[0])
      return { results: row ? [{ extracted_text: row.extracted_text }] : [] }
    }

    // --- artifact_embeddings -----------------------------------------
    if (norm.startsWith('SELECT version_id, vector_id FROM artifact_embeddings WHERE artifact_id = ?')) {
      return {
        results: tables.artifact_embeddings
          .filter((r) => r.artifact_id === params[0])
          .map((r) => ({ version_id: r.version_id, vector_id: r.vector_id }))
      }
    }

    if (norm.startsWith('SELECT vector_id FROM artifact_embeddings WHERE artifact_id = ?')) {
      return {
        results: tables.artifact_embeddings
          .filter((r) => r.artifact_id === params[0])
          .map((r) => ({ vector_id: r.vector_id }))
      }
    }

    if (norm.startsWith('DELETE FROM artifact_embeddings WHERE artifact_id = ?')) {
      tables.artifact_embeddings = tables.artifact_embeddings.filter((r) => r.artifact_id !== params[0])
      return { results: [] }
    }

    if (norm.startsWith('INSERT INTO artifact_embeddings')) {
      const [id, artifact_id, version_id, chunk_index, chunk_text, vector_id, workspace_id, organization_id, chunk_total, created_at, updated_at] = params
      const existing = tables.artifact_embeddings.findIndex((r) => r.id === id)
      const row = {
        id, artifact_id, version_id, chunk_index, chunk_text, vector_id,
        workspace_id, organization_id, chunk_total, created_at, updated_at,
        status: 'INDEXED', provider: 'WORKERS_AI'
      }
      if (existing >= 0) tables.artifact_embeddings[existing] = row
      else tables.artifact_embeddings.push(row)
      return { results: [] }
    }

    if (norm.includes('COUNT(*) AS total') && norm.includes('artifact_embeddings')) {
      const rows = tables.artifact_embeddings.filter((r) => r.artifact_id === params[0])
      const indexed = rows.filter((r) => r.status === 'INDEXED').length
      return { results: [{ total: rows.length, indexed }] }
    }

    // --- processing_jobs ---------------------------------------------
    if (norm.startsWith('SELECT status, detail_json, updated_at FROM processing_jobs')) {
      const rows = tables.processing_jobs
        .filter((j) => j.artifact_id === params[0] && j.job_type === 'EMBED')
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      return { results: rows.length ? [rows[0]] : [] }
    }

    throw new Error(`makeDB: unrecognised statement -> ${norm.slice(0, 90)}`)
  }

  return {
    tables,
    prepare: (sql) => statement(sql, []),
    async batch() {
      return []
    }
  }
}

// ---------------------------------------------------------------
// 1. Chunking
// ---------------------------------------------------------------

section('Chunking — chunked, never whole-document')

const manyParas = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}. ${'This sentence carries enough content to be embedded meaningfully. '.repeat(2)}`
).join('\n\n')

const chunks = chunkText(manyParas)
check('long document produces multiple chunks', chunks.length > 1, `got ${chunks.length}`)
check('chunk indices are contiguous from 0', chunks.every((c, i) => c.index === i))
check(
  'no chunk exceeds the target plus overlap',
  chunks.every((c) => c.text.length <= 1200 + 200)
)
check('chunks are capped', chunks.length <= MAX_CHUNKS, `got ${chunks.length}`)
check('no chunk is empty', chunks.every((c) => c.text.trim().length > 0))

const single = chunkText('A short note.')
check('very short text yields no chunks (below the noise floor)', single.length === 0)

const unbroken = chunkText('x'.repeat(5000))
check('unbroken long text is still chunked', unbroken.length > 1, `got ${unbroken.length}`)
check('unbroken chunks are bounded', unbroken.every((c) => c.text.length <= 1400))

check('null input yields no chunks', chunkText(null).length === 0)
check('empty input yields no chunks', chunkText('   \n\n  ').length === 0)

// ---------------------------------------------------------------
// 2. Vector identity + metadata
// ---------------------------------------------------------------

section('Vector identity and metadata')

const vid = vectorIdFor('art_1', 'ver_1', 3)
check('vector id is deterministic', vid === vectorIdFor('art_1', 'ver_1', 3))
check('vector id encodes version', vid !== vectorIdFor('art_1', 'ver_2', 3))
check('vector id encodes chunk', vid !== vectorIdFor('art_1', 'ver_1', 4))
check('vector id is scoped to the version', vid.includes('ver_1'))

// Regression guard: Vectorize caps a vector id at 64 bytes. Real ids are
// `prefix_` + a 26-char ULID (30 bytes each), so the original
// `{artifactId}__{versionId}__{chunkIndex}` form was 65 bytes for chunk 0 and
// rejected every chunk of a real production artifact. The earlier tests used
// short ids like `art_1` and passed while production failed — so this now
// asserts the length against realistic ids at both ends of the chunk range.
const REAL_ART = 'art_01M3H86PX0C9BBRE6K16KXCBG7'   // 30 bytes
const REAL_VER = 'ver_01M3H86PX0Q87XT3S92KZ313TQ'   // 30 bytes
check('real artifact id is 30 bytes (test precondition)', REAL_ART.length === 30)
check('real version id is 30 bytes (test precondition)', REAL_VER.length === 30)
for (const chunk of [0, 9, 59]) {
  const id = vectorIdFor(REAL_ART, REAL_VER, chunk)
  check(
    `realistic id fits Vectorize's limit (chunk ${chunk}, ${id.length} bytes)`,
    id.length <= MAX_VECTOR_ID_BYTES,
    `${id.length} > ${MAX_VECTOR_ID_BYTES}`
  )
}
check(
  'ids are unique across chunks of one version',
  new Set([0, 1, 2, 59].map((c) => vectorIdFor(REAL_ART, REAL_VER, c))).size === 4
)

const meta = buildMetadata({
  artifactId: 'art_1', versionId: 'ver_1', workspaceId: 'ws_1',
  organizationId: null, ownerUserId: 'usr_1', chunkIndex: 0, chunkTotal: 2
})
check('metadata carries workspaceId', meta.workspaceId === 'ws_1')
check('metadata carries artifactId', meta.artifactId === 'art_1')
check('metadata carries versionId', meta.versionId === 'ver_1')
check('metadata normalises null organizationId to empty string', meta.organizationId === '')
check('metadata carries chunk identity', meta.chunkIndex === 0 && meta.chunkTotal === 2)

// ---------------------------------------------------------------
// 3. Tenant isolation  ← the critical boundary
// ---------------------------------------------------------------

section('Tenant isolation — filterByScope')

const matches = [
  { id: 'v1', score: 0.95, metadata: { artifactId: 'art_mine', workspaceId: 'ws_mine', versionId: 'ver_1' } },
  { id: 'v2', score: 0.99, metadata: { artifactId: 'art_other', workspaceId: 'ws_other', versionId: 'ver_1' } },
  { id: 'v3', score: 0.90, metadata: { artifactId: 'art_mine2', workspaceId: 'ws_mine', versionId: 'ver_1' } },
  { id: 'v4', score: 0.97, metadata: { artifactId: 'art_nometa' } },                       // no workspace
  { id: 'v5', score: 0.96, metadata: null },                                              // null metadata
  { id: 'v6', score: 0.94, metadata: { artifactId: 'art_blank', workspaceId: '' } }        // empty workspace
]

const scoped = filterByScope(matches, ['ws_mine'])
const scopedIds = scoped.map((r) => r.artifactId)

check('in-scope artifacts are returned', scopedIds.includes('art_mine') && scopedIds.includes('art_mine2'))
check(
  'OUT-OF-SCOPE artifact is excluded despite the highest score',
  !scopedIds.includes('art_other'),
  `got ${JSON.stringify(scopedIds)}`
)
check('match with no workspace metadata fails closed', !scopedIds.includes('art_nometa'))
check('match with null metadata fails closed', scoped.length === 2)
check('match with empty workspace fails closed', !scopedIds.includes('art_blank'))

const emptyScope = filterByScope(matches, [])
check('empty scope returns nothing (not everything)', emptyScope.length === 0)

const multi = filterByScope(matches, ['ws_mine', 'ws_other'])
check('a wider authorised scope does include the other tenant', multi.some((r) => r.artifactId === 'art_other'))
check('results are ordered by score desc', multi.every((r, i) => i === 0 || multi[i - 1].score >= r.score))

// Dedup: several chunks of one artifact collapse to the best score
const dupes = filterByScope(
  [
    { id: 'a0', score: 0.4, metadata: { artifactId: 'art_x', workspaceId: 'ws_1' } },
    { id: 'a1', score: 0.9, metadata: { artifactId: 'art_x', workspaceId: 'ws_1' } },
    { id: 'a2', score: 0.6, metadata: { artifactId: 'art_x', workspaceId: 'ws_1' } }
  ],
  ['ws_1']
)
check('multiple chunks of one artifact dedupe to a single hit', dupes.length === 1)
check('the best chunk score is kept', dupes[0].score === 0.9)

// ---------------------------------------------------------------
// 4. semantic:true only when the query genuinely ran
// ---------------------------------------------------------------

section('semanticQuery — `ran` reporting and fallbacks')

check('unconfigured env reports not configured', isSemanticConfigured({}) === false)
check('configured env detected', isSemanticConfigured({ VECTORIZE: {}, AI: {} }) === true)

// unconfigured
let r = await semanticQuery({}, 'anything', ['ws_1'], 10)
check('unconfigured: ran === false', r.ran === false)
check('unconfigured: no results', r.results.length === 0)
check('unconfigured: reason explains why', /not provisioned/i.test(r.reason))

// empty query
r = await semanticQuery({ VECTORIZE: makeVectorize(), AI: makeAI() }, '   ', ['ws_1'], 10)
check('empty query: ran === false (nothing was queried)', r.ran === false)

// no readable workspaces
r = await semanticQuery({ VECTORIZE: makeVectorize(), AI: makeAI() }, 'hello', [], 10)
check('empty scope: ran === false', r.ran === false)

// happy path
const vz = makeVectorize()
vz.state.matches = [
  { id: 'v1', score: 0.9, metadata: { artifactId: 'art_mine', workspaceId: 'ws_1' } },
  { id: 'v2', score: 0.8, metadata: { artifactId: 'art_other', workspaceId: 'ws_9' } }
]
r = await semanticQuery({ VECTORIZE: vz, AI: makeAI() }, 'quarterly revenue', ['ws_1'], 10)
check('happy path: ran === true', r.ran === true)
check('happy path: returns the in-scope artifact', r.results.some((x) => x.artifactId === 'art_mine'))
check('happy path: EXCLUDES the out-of-scope vector', !r.results.some((x) => x.artifactId === 'art_other'))
check('happy path: reason names the model', /bge-base-en-v1\.5/.test(r.reason))

// AI outage
r = await semanticQuery({ VECTORIZE: makeVectorize(), AI: makeAI('throw') }, 'hello', ['ws_1'], 10)
check('AI outage: ran === false', r.ran === false)
check('AI outage: no results', r.results.length === 0)
check('AI outage: reason mentions lexical fallback', /lexical/i.test(r.reason))

// malformed AI response
r = await semanticQuery({ VECTORIZE: makeVectorize(), AI: makeAI('malformed') }, 'hello', ['ws_1'], 10)
check('malformed embedding (wrong dims): ran === false', r.ran === false)

// Vectorize query outage
const badVz = makeVectorize('throw')
r = await semanticQuery({ VECTORIZE: badVz, AI: makeAI() }, 'hello', ['ws_1'], 10)
check('Vectorize outage: ran === false', r.ran === false)
check('Vectorize outage: reason mentions failure', /failed/i.test(r.reason))

// ---------------------------------------------------------------
// 5. embedTexts contract
// ---------------------------------------------------------------

section('embedTexts')

const vecs = await embedTexts({ AI: makeAI() }, ['alpha', 'beta'])
check('returns one vector per input', vecs?.length === 2)
check('vectors have the index dimension', vecs?.[0].length === EMBEDDING_DIMENSIONS)
check('null when no AI binding', (await embedTexts({}, ['x'])) === null)
check('null for empty input', (await embedTexts({ AI: makeAI() }, [])) === null)
check('null on AI outage (never throws)', (await embedTexts({ AI: makeAI('throw') }, ['x'])) === null)
check('null on malformed response', (await embedTexts({ AI: makeAI('no-data') }, ['x'])) === null)

// ---------------------------------------------------------------
// 6. reindexVersion — states, stale vectors, empty documents
// ---------------------------------------------------------------

section('reindexVersion — indexing states and stale vectors')

const envBase = (db, aiMode = 'ok', vzMode = 'ok') => ({
  DB: db,
  AI: makeAI(aiMode),
  VECTORIZE: makeVectorize(vzMode)
})

// 6a. Unconfigured deployment -> SKIPPED, never a crash
let db = makeDB({ artifact_versions: [{ id: 'ver_1', extracted_text: 'Some real extracted text about finance.' }] })
let outcome = await reindexVersion({ DB: db }, {
  artifactId: 'art_1', versionId: 'ver_1', workspaceId: 'ws_1', organizationId: null, ownerUserId: 'usr_1'
})
check('unconfigured: state SKIPPED', outcome.state === 'SKIPPED', outcome.state)
check('unconfigured: nothing written', db.tables.artifact_embeddings.length === 0)

// 6b. Empty / scanned document -> PARTIAL
db = makeDB({ artifact_versions: [{ id: 'ver_1', extracted_text: null }] })
let env = envBase(db)
outcome = await reindexVersion(env, {
  artifactId: 'art_scan', versionId: 'ver_1', workspaceId: 'ws_1', organizationId: null, ownerUserId: 'usr_1'
})
check('scanned/empty document: state PARTIAL', outcome.state === 'PARTIAL', outcome.state)
check('scanned/empty document: zero vectors', outcome.vectors === 0)
check('scanned/empty document: reason is explicit', /no extractable text/i.test(outcome.reason))
check('scanned/empty document: no vectors upserted', env.VECTORIZE.state.upserted.length === 0)

// 6c. Happy path -> INDEXED with metadata
const body = Array.from({ length: 8 }, (_, i) => `Section ${i}. Revenue grew steadily across the quarter.`).join('\n\n')
db = makeDB({ artifact_versions: [{ id: 'ver_2', extracted_text: body }] })
env = envBase(db)
outcome = await reindexVersion(env, {
  artifactId: 'art_ok', versionId: 'ver_2', workspaceId: 'ws_A', organizationId: 'org_A', ownerUserId: 'usr_1'
})
check('normal document: state INDEXED', outcome.state === 'INDEXED', outcome.state)
check('normal document: vectors written', outcome.vectors > 0)
check('normal document: bookkeeping rows written', db.tables.artifact_embeddings.length === outcome.vectors)
check(
  'every vector carries workspaceId',
  env.VECTORIZE.state.upserted.every((v) => v.metadata.workspaceId === 'ws_A')
)
check(
  'every vector carries organizationId',
  env.VECTORIZE.state.upserted.every((v) => v.metadata.organizationId === 'org_A')
)
check(
  'every vector carries artifactId + versionId',
  env.VECTORIZE.state.upserted.every((v) => v.metadata.artifactId === 'art_ok' && v.metadata.versionId === 'ver_2')
)
check(
  'every vector carries chunk identity',
  env.VECTORIZE.state.upserted.every((v) => Number.isInteger(v.metadata.chunkIndex))
)
check(
  'vectors have the index dimension',
  env.VECTORIZE.state.upserted.every((v) => v.values.length === EMBEDDING_DIMENSIONS)
)

// 6d. Re-index a NEW version -> old version's vectors are deleted
const olderIds = env.VECTORIZE.state.upserted.map((v) => v.id)
const db2 = makeDB({
  artifact_versions: [{ id: 'ver_3', extracted_text: 'A brand new revision of the same document body.' }],
  artifact_embeddings: db.tables.artifact_embeddings  // seed with ver_2 rows
})
const env2 = envBase(db2)
outcome = await reindexVersion(env2, {
  artifactId: 'art_ok', versionId: 'ver_3', workspaceId: 'ws_A', organizationId: 'org_A', ownerUserId: 'usr_1'
})
check('re-index: state INDEXED', outcome.state === 'INDEXED')
check(
  're-index: every stale ver_2 vector was deleted',
  olderIds.every((id) => env2.VECTORIZE.state.deleted.includes(id)),
  `deleted=${env2.VECTORIZE.state.deleted.length} expected>=${olderIds.length}`
)
check(
  're-index: bookkeeping only references the new version',
  db2.tables.artifact_embeddings.every((r) => r.version_id === 'ver_3')
)
check(
  're-index: no vector for the superseded version remains',
  db2.tables.artifact_embeddings.every((r) => r.version_id !== 'ver_2')
)

// 6e. AI outage -> FAILED, lexically still fine, previous vectors untouched
const db3 = makeDB({
  artifact_versions: [{ id: 'ver_1', extracted_text: 'Text that will fail to embed during an outage.' }],
  artifact_embeddings: [
    { id: 'old', artifact_id: 'art_fail', version_id: 'ver_0', vector_id: 'keep_me', status: 'INDEXED' }
  ]
})
const env3 = envBase(db3, 'throw')
outcome = await reindexVersion(env3, {
  artifactId: 'art_fail', versionId: 'ver_1', workspaceId: 'ws_1', organizationId: null, ownerUserId: 'usr_1'
})
check('AI outage: state FAILED', outcome.state === 'FAILED', outcome.state)
check('AI outage: reason explains', /unavailable/i.test(outcome.reason))
check('AI outage: no vectors written', env3.VECTORIZE.state.upserted.length === 0)
check('AI outage: does not throw', true)

// 6f. Vectorize write outage -> FAILED, does not throw
const db4 = makeDB({ artifact_versions: [{ id: 'ver_1', extracted_text: 'Text for a vectorize write outage test case.' }] })
const env4 = envBase(db4, 'ok', 'throw')
outcome = await reindexVersion(env4, {
  artifactId: 'art_vz', versionId: 'ver_1', workspaceId: 'ws_1', organizationId: null, ownerUserId: 'usr_1'
})
check('Vectorize write outage: state FAILED', outcome.state === 'FAILED', outcome.state)
check('Vectorize write outage: does not throw', true)
check('Vectorize write outage: bookkeeping not left stale', db4.tables.artifact_embeddings.length === 0)

// 6g. removeArtifactVectors purges everything
const env5 = envBase(makeDB())
const db5 = makeDB({
  artifact_embeddings: [
    { id: 'v1', artifact_id: 'art_del', version_id: 'ver_1', vector_id: 'vec_1', status: 'INDEXED' },
    { id: 'v2', artifact_id: 'art_del', version_id: 'ver_1', vector_id: 'vec_2', status: 'INDEXED' },
    { id: 'v3', artifact_id: 'art_keep', version_id: 'ver_1', vector_id: 'vec_3', status: 'INDEXED' }
  ]
})
const env6 = envBase(db5)
const purged = await removeArtifactVectors(env6, 'art_del')
check('delete: both vectors removed from Vectorize', purged === 2, String(purged))
check('delete: ids sent to Vectorize', env6.VECTORIZE.state.deleted.includes('vec_1') && env6.VECTORIZE.state.deleted.includes('vec_2'))
check('delete: bookkeeping cleared for the artifact', db5.tables.artifact_embeddings.every((r) => r.artifact_id !== 'art_del'))
check('delete: other artifacts untouched', db5.tables.artifact_embeddings.some((r) => r.artifact_id === 'art_keep'))
void env5

// ---------------------------------------------------------------
// 7. indexStateFor — per-artifact indexing state
// ---------------------------------------------------------------

section('indexStateFor — PENDING / INDEXED / PARTIAL / FAILED')

let stateDb = makeDB({
  processing_jobs: [{ artifact_id: 'art_a', job_type: 'EMBED', status: 'DONE', detail_json: '{"note":"ok"}', updated_at: '2026-01-02T00:00:00Z' }],
  artifact_embeddings: [
    { id: 'e1', artifact_id: 'art_a', version_id: 'v1', vector_id: 'x1', status: 'INDEXED' },
    { id: 'e2', artifact_id: 'art_a', version_id: 'v1', vector_id: 'x2', status: 'INDEXED' }
  ]
})
let st = await indexStateFor(stateDb, 'art_a')
check('all chunks indexed -> INDEXED', st.state === 'INDEXED', st.state)
check('chunk counts reported', st.chunks === 2 && st.indexedChunks === 2)

stateDb = makeDB({
  processing_jobs: [{ artifact_id: 'art_b', job_type: 'EMBED', status: 'PARTIAL', detail_json: '{"note":"scanned doc"}', updated_at: '2026-01-02T00:00:00Z' }],
  artifact_embeddings: []
})
st = await indexStateFor(stateDb, 'art_b')
check('no chunks + PARTIAL job -> PARTIAL', st.state === 'PARTIAL', st.state)
check('reason surfaced from job detail', /scanned/i.test(st.reason), st.reason)

stateDb = makeDB({
  processing_jobs: [{ artifact_id: 'art_c', job_type: 'EMBED', status: 'FAILED', detail_json: '{}', updated_at: '2026-01-02T00:00:00Z' }],
  artifact_embeddings: []
})
st = await indexStateFor(stateDb, 'art_c')
check('FAILED job -> FAILED', st.state === 'FAILED', st.state)

stateDb = makeDB({
  processing_jobs: [{ artifact_id: 'art_d', job_type: 'EMBED', status: 'SKIPPED', detail_json: '{}', updated_at: '2026-01-02T00:00:00Z' }],
  artifact_embeddings: []
})
st = await indexStateFor(stateDb, 'art_d')
check('SKIPPED job (no bindings) -> SKIPPED', st.state === 'SKIPPED', st.state)

st = await indexStateFor(makeDB({}), 'art_none')
check('no job at all -> PENDING', st.state === 'PENDING', st.state)

stateDb = makeDB({
  processing_jobs: [{ artifact_id: 'art_e', job_type: 'EMBED', status: 'DONE', detail_json: '{}', updated_at: '2026-01-02T00:00:00Z' }],
  artifact_embeddings: [
    { id: 'p1', artifact_id: 'art_e', version_id: 'v1', vector_id: 'y1', status: 'INDEXED' },
    { id: 'p2', artifact_id: 'art_e', version_id: 'v1', vector_id: 'y2', status: 'PENDING' }
  ]
})
st = await indexStateFor(stateDb, 'art_e')
check('some chunks indexed -> PARTIAL', st.state === 'PARTIAL', st.state)
check('partial counts are reported', st.chunks === 2 && st.indexedChunks === 1)

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------

console.log(`\n${'='.repeat(52)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures) {
  console.log('SEMANTIC TESTS FAILED')
  process.exit(1)
}
console.log('ALL SEMANTIC TESTS PASSED')
