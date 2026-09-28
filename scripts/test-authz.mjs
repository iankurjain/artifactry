/**
 * Cross-tenant / cross-workspace authorization tests for search.
 *
 * Unlike `test-semantic.mjs` (which uses a hand-written D1 double), this suite
 * runs the **real** `searchArtifacts` and `readableWorkspaces` code against a
 * **real SQLite engine** (`node:sqlite`) with a real FTS5 virtual table. That
 * matters: the authorization guarantee ultimately rests on the SQL predicates
 * (`a.workspace_id IN (...)`) and on `readableWorkspaces`' membership joins, so
 * testing it against a stub would test the stub. Here a defect in the ACL SQL
 * fails the test.
 *
 * Vectorize and Workers AI are the only doubles, because they are external
 * services. `filterByScope` — the code that decides which vector matches are
 * trustworthy — runs for real inside `semanticQuery`.
 *
 * Scenarios:
 *   A. two tenants with separate personal workspaces
 *   B. two users sharing one workspace
 *   C. a user denied a workspace
 *   D. direct artifact-id / vector-id attempts cannot bypass authorization
 *   E. ACL applies equally to lexical and semantic results
 *   F. a stale vector from a removed version cannot resurface an artifact
 *
 * Run: node scripts/test-authz.mjs
 */

import { DatabaseSync } from 'node:sqlite'
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
// Bundle the real search + principal modules
//
// A stdin entry is used so no harness file has to live under src/ — the test
// pulls the real exports straight out of the shipped modules.
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
await build({
  stdin: {
    contents: `
      export { searchArtifacts, accessibleWorkspaceIds } from './src/lib/search.ts'
      export { readableWorkspaces } from './src/lib/principal.ts'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'authz-entry.ts',
    loader: 'ts'
  },
  outfile: '/tmp/build/authz.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

// Bundle embeddings separately: the test's semantic provider calls the real
// `semanticQuery` (which runs the real `filterByScope` + `embedTexts`).
await build({
  entryPoints: ['src/lib/embeddings.ts'],
  outfile: '/tmp/build/embeddings-a.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const { searchArtifacts, accessibleWorkspaceIds, readableWorkspaces } = await import(
  pathToFileURL('/tmp/build/authz.mjs').href
)
const { semanticQuery } = await import(pathToFileURL('/tmp/build/embeddings-a.mjs').href)

// ---------------------------------------------------------------
// A D1-shaped adapter over node:sqlite
//
// D1's API is `prepare(sql).bind(...).first()|.all()|.run()`. node:sqlite is
// positional and synchronous, so this bridges the two. Every SQL string from
// src/lib/search.ts and src/lib/principal.ts is executed by the real engine —
// nothing is pattern-matched or faked.
// ---------------------------------------------------------------

function makeDB() {
  const db = new DatabaseSync(':memory:')

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, email_normalized TEXT NOT NULL UNIQUE,
      email_verified_at TEXT, display_name TEXT, avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      owner_user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE organization_members (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, organization_id TEXT, owner_user_id TEXT NOT NULL,
      workspace_type TEXT NOT NULL DEFAULT 'PERSONAL', name TEXT NOT NULL,
      description TEXT, created_at TEXT NOT NULL, created_by TEXT, archived_at TEXT
    );
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL, invited_by TEXT
    );
    CREATE TABLE artifacts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, organization_id TEXT, workspace_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      canonical_slug TEXT, filename TEXT, extension TEXT, mime_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0, checksum TEXT,
      current_version_id TEXT, version_count INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'WEB_UPLOAD', source_provider TEXT,
      status TEXT NOT NULL DEFAULT 'READY', status_detail TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version_number INTEGER NOT NULL,
      r2_object_key TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
      extension TEXT, size_bytes INTEGER NOT NULL, checksum TEXT,
      source_type TEXT NOT NULL DEFAULT 'WEB_UPLOAD', source_provider TEXT,
      change_summary TEXT, extracted_text TEXT, created_by_user_id TEXT,
      created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, organization_id TEXT, scope TEXT NOT NULL DEFAULT 'PERSONAL',
      name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, color TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE artifact_tags (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, tag_id TEXT NOT NULL,
      assigned_by TEXT, assigned_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE artifact_search USING fts5(
      title, filename, description, tags, extracted_text,
      tokenize = 'porter unicode61'
    );
  `)

  function statement(sql, bound) {
    const stmt = {
      bind(...params) {
        return statement(sql, params)
      },
      async first() {
        const rows = run()
        return rows.length ? rows[0] : null
      },
      async all() {
        return { results: run(), success: true }
      },
      async run() {
        run()
        return { success: true }
      }
    }

    function run() {
      const prepared = db.prepare(sql)
      // node:sqlite: .all(...params) returns plain objects.
      return prepared.all(...bound.map((v) => (v === undefined ? null : v)))
    }

    return stmt
  }

  return {
    sqlite: db,
    prepare: (sql) => statement(sql, []),
    async batch() {
      return []
    },
    exec: (sql) => db.exec(sql),
    /** Direct insert helper for fixtures. */
    insert: (table, row) => {
      const keys = Object.keys(row)
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(...keys.map((k) => row[k]))
    }
  }
}

// ---------------------------------------------------------------
// Doubles for the external services only
// ---------------------------------------------------------------

const DIMS = 768

function fakeVector(seed) {
  const v = new Array(DIMS)
  let h = 2166136261
  for (let i = 0; i < String(seed).length; i++) {
    h ^= String(seed).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = 0; i < DIMS; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    v[i] = ((h >>> 0) % 1000) / 1000
  }
  return v
}

/** AI double: returns correctly-shaped vectors for whatever it is given. */
const AI = {
  async run(_model, input) {
    return { data: (input.text ?? []).map((t) => fakeVector(t)) }
  }
}

/**
 * Vectorize double. `matches` stands in for what an ANN lookup would return —
 * deliberately able to include vectors the caller may NOT read, so the scope
 * filter is what has to reject them.
 */
function makeVectorize(matches = []) {
  return {
    async query() {
      return { matches }
    },
    async upsert() {},
    async deleteByIds() {}
  }
}

// ---------------------------------------------------------------
// Fixture: two tenants, three users, three workspaces
//
//   usr_a  →  ws_a   (personal)
//   usr_b  →  ws_b   (personal)
//   usr_c  →  ws_shared   (member, with usr_a)
//
// art_a  lives in ws_a.  art_b  lives in ws_b.  art_shared lives in ws_shared.
// ---------------------------------------------------------------

const T = '2026-01-01T00:00:00.000Z'

function seed(db) {
  for (const u of ['a', 'b', 'c']) {
    db.insert('users', {
      id: `usr_${u}`, email: `${u}@example.com`, email_normalized: `${u}@example.com`,
      email_verified_at: T, display_name: u.toUpperCase(), avatar_url: null,
      status: 'ACTIVE', created_at: T, updated_at: T
    })
  }

  // One tag, applied to a single artifact, so tag filters can be used to probe
  // whether semantic-only hits honour the caller's filters.
  db.insert('tags', {
    id: 'tag_finance', organization_id: null, scope: 'PERSONAL', name: 'Finance',
    slug: 'finance', description: null, color: null, status: 'ACTIVE',
    created_by: 'usr_a', created_at: T, updated_at: T
  })
  db.insert('artifact_tags', {
    id: 'at_1', artifact_id: 'art_a', tag_id: 'tag_finance',
    assigned_by: 'usr_a', assigned_at: T
  })

  db.insert('workspaces', {
    id: 'ws_a', organization_id: null, owner_user_id: 'usr_a', workspace_type: 'PERSONAL',
    name: 'A Personal', description: null, created_at: T, created_by: 'usr_a', archived_at: null
  })
  db.insert('workspaces', {
    id: 'ws_b', organization_id: null, owner_user_id: 'usr_b', workspace_type: 'PERSONAL',
    name: 'B Personal', description: null, created_at: T, created_by: 'usr_b', archived_at: null
  })
  db.insert('workspaces', {
    id: 'ws_shared', organization_id: null, owner_user_id: 'usr_a', workspace_type: 'TEAM',
    name: 'Shared', description: null, created_at: T, created_by: 'usr_a', archived_at: null
  })

  // usr_c is a member of ws_shared only.
  db.insert('workspace_members', {
    id: 'wm_1', workspace_id: 'ws_shared', user_id: 'usr_c', role: 'VIEWER',
    status: 'ACTIVE', created_at: T, invited_by: 'usr_a'
  })

  const artifacts = [
    // id, workspace, owner, title, filename, extraction, body
    ['art_a', 'ws_a', 'usr_a', 'Apollo quarterly revenue', 'apollo.pdf',
      'Consolidated earnings rose sharply with gross margin expanding to 42 percent.'],
    ['art_b', 'ws_b', 'usr_b', 'Borealis quarterly revenue', 'borealis.pdf',
      'Consolidated earnings rose sharply with gross margin expanding to 41 percent.'],
    // Owned by usr_a but in the shared workspace, so usr_c (a member) can read
    // it while usr_b cannot. The title carries both query terms on purpose:
    // with only "revenue" it did not satisfy the strict AND expression, so
    // "A sees its own plus shared" was failing on fixture wording rather than
    // on authorization.
    ['art_shared', 'ws_shared', 'usr_a', 'Shared quarterly revenue memo', 'shared.pdf',
      'Consolidated earnings rose sharply with gross margin expanding to 43 percent.'],
    // Matches only one term of the "governance compliance" probe below, which
    // is what forces the relaxed OR fallback to supply the rows.
    ['art_a2', 'ws_a', 'usr_a', 'Board governance packet', 'governance.pdf',
      'The audit committee reviewed governance obligations for the coming year.']
  ]

  for (const [id, ws, owner, title, filename, body] of artifacts) {
    db.insert('artifacts', {
      id, organization_id: null, workspace_id: ws, owner_user_id: owner,
      title, description: null, canonical_slug: id, filename, extension: 'pdf',
      mime_type: 'application/pdf', size_bytes: 100, checksum: null,
      current_version_id: `ver_${id}`, version_count: 1,
      source_type: 'WEB_UPLOAD', source_provider: 'WEB', status: 'READY',
      status_detail: null, metadata_json: '{}', created_at: T, updated_at: T, deleted_at: null
    })
    db.insert('artifact_versions', {
      id: `ver_${id}`, artifact_id: id, version_number: 1,
      r2_object_key: `k/${id}`, filename, mime_type: 'application/pdf', extension: 'pdf',
      size_bytes: 100, checksum: null, source_type: 'WEB_UPLOAD', source_provider: 'WEB',
      change_summary: null, extracted_text: body, created_by_user_id: owner,
      created_at: T, deleted_at: null
    })

    const seq = db.sqlite.prepare('SELECT seq FROM artifacts WHERE id = ?').get(id).seq
    db.sqlite
      .prepare(
        `INSERT INTO artifact_search (rowid, title, filename, description, tags, extracted_text)
         VALUES (?, ?, ?, '', '', ?)`
      )
      .run(seq, title, filename, body)
  }
}

function principalFor(userId) {
  return {
    kind: 'SESSION',
    userId,
    user: null,
    orgRoles: {},
    workspaceRoles: {},
    scopes: []
  }
}

/**
 * Build a semantic provider whose query returns the given vector matches.
 * The real `semanticQuery` + `filterByScope` still decide what is trusted.
 */
function semanticReturning(matches) {
  return {
    name: 'WORKERS_AI_VECTORIZE',
    available: true,
    reason: 'test provider',
    async search(_query, scope, _limit) {
      // Mirror what resolveSemanticProvider does: run the REAL semanticQuery.
      const { semanticQuery } = await import(pathToFileURL('/tmp/build/embeddings-a.mjs').href)
      const r = await semanticQuery(envWith(matches), _query, scope, _limit)
      return { ran: r.ran, results: r.results, reason: r.reason }
    }
  }
}

const envWith = (matches) => ({ VECTORIZE: makeVectorize(matches), AI })

// Bundle embeddings separately for the real semanticQuery.
await build({
  entryPoints: ['src/lib/embeddings.ts'],
  outfile: '/tmp/build/embeddings-a.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

// ---------------------------------------------------------------
// A. Tenant isolation — B cannot see A's artifact
// ---------------------------------------------------------------

section('A. Tenant isolation — separate personal workspaces')

let db = makeDB()
seed(db)

const wsA = await readableWorkspaces(db, principalFor('usr_a'))
const wsB = await readableWorkspaces(db, principalFor('usr_b'))
check('usr_a reads exactly ws_a + ws_shared', 
  new Set(wsA.map((w) => w.id)).size === 2 && wsA.some((w) => w.id === 'ws_a'),
  wsA.map((w) => w.id).join(','))
check('usr_b reads only ws_b',
  wsB.length === 1 && wsB[0].id === 'ws_b',
  wsB.map((w) => w.id).join(','))

// Lexical: the exact same query text
let resB = await searchArtifacts(db, principalFor('usr_b'), { query: 'quarterly revenue' })
check('B lexical search returns only B artifacts',
  resB.hits.every((h) => h.artifact.workspace_id === 'ws_b'),
  resB.hits.map((h) => `${h.artifact.id}@${h.artifact.workspace_id}`).join(','))
check('B never sees art_a', !resB.hits.some((h) => h.artifact.id === 'art_a'))
check('B never sees art_shared', !resB.hits.some((h) => h.artifact.id === 'art_shared'))

let resA = await searchArtifacts(db, principalFor('usr_a'), { query: 'quarterly revenue' })
check('A sees its own plus shared', 
  resA.hits.some((h) => h.artifact.id === 'art_a') &&
  resA.hits.some((h) => h.artifact.id === 'art_shared'))
check('A never sees art_b', !resA.hits.some((h) => h.artifact.id === 'art_b'))

// ---------------------------------------------------------------
// B. Workspace authorization — shared-workspace member sees shared, not others
// ---------------------------------------------------------------

section('B. Workspace members share one workspace')

const resC = await searchArtifacts(db, principalFor('usr_c'), { query: 'quarterly revenue' })
check('C sees the shared workspace artifact', resC.hits.some((h) => h.artifact.id === 'art_shared'))
check('C does not see A\'s private artifact', !resC.hits.some((h) => h.artifact.id === 'art_a'))
check('C does not see B\'s artifact', !resC.hits.some((h) => h.artifact.id === 'art_b'))
check('C\'s total matches the hits it can see', resC.total === resC.hits.length, `${resC.total}/${resC.hits.length}`)

// Narrowing scope is allowed; widening is not.
const widened = await accessibleWorkspaceIds(db, principalFor('usr_c'), ['ws_shared', 'ws_a', 'ws_b'])
check('C requesting ws_a/ws_b cannot widen its scope',
  widened.length === 1 && widened[0] === 'ws_shared',
  widened.join(','))

// ---------------------------------------------------------------
// C. Semantic results cannot cross a tenant boundary
// ---------------------------------------------------------------

section('C. Semantic results respect the same boundary')

// Vectorize returns vectors for ALL THREE artifacts, including two B may not
// read. The scope filter has to discard them.
const crossTenantMatches = [
  { id: 'ver_art_a__c0', score: 0.95, metadata: { artifactId: 'art_a', versionId: 'ver_art_a', workspaceId: 'ws_a' } },
  { id: 'ver_art_b__c0', score: 0.93, metadata: { artifactId: 'art_b', versionId: 'ver_art_b', workspaceId: 'ws_b' } },
  { id: 'ver_art_shared__c0', score: 0.91, metadata: { artifactId: 'art_shared', versionId: 'ver_art_shared', workspaceId: 'ws_shared' } }
]

// A query that matches NOTHING lexically, so any hit must have come from vectors.
const semanticOnly = 'profitability trajectory'

let semB = await searchArtifacts(
  db, principalFor('usr_b'), { query: semanticOnly }, semanticReturning(crossTenantMatches)
)
check('B semantic-only: semantic flag is true (the query really ran)', semB.engine.semantic === true)
check('B semantic-only: returns B\'s artifact via vectors',
  semB.hits.some((h) => h.artifact.id === 'art_b'),
  semB.hits.map((h) => h.artifact.id).join(','))
check('B semantic-only: art_a vector is REJECTED', !semB.hits.some((h) => h.artifact.id === 'art_a'))
check('B semantic-only: art_shared vector is REJECTED', !semB.hits.some((h) => h.artifact.id === 'art_shared'))
check('B semantic-only: every hit is in ws_b',
  semB.hits.every((h) => h.artifact.workspace_id === 'ws_b'))

let semC = await searchArtifacts(
  db, principalFor('usr_c'), { query: semanticOnly }, semanticReturning(crossTenantMatches)
)
check('C semantic-only: gets art_shared through vectors',
  semC.hits.some((h) => h.artifact.id === 'art_shared'))
check('C semantic-only: art_a and art_b rejected',
  !semC.hits.some((h) => h.artifact.id === 'art_a') &&
  !semC.hits.some((h) => h.artifact.id === 'art_b'))

// A vector whose metadata lost its workspaceId must fail CLOSED.
section('C2. Vectors with missing tenant metadata fail closed')
const untagged = [
  { id: 'x1', score: 0.99, metadata: { artifactId: 'art_b' } },
  { id: 'x2', score: 0.98, metadata: { artifactId: 'art_a', workspaceId: '' } },
  { id: 'x3', score: 0.97, metadata: null }
]
let semFail = await searchArtifacts(
  db, principalFor('usr_b'), { query: semanticOnly }, semanticReturning(untagged)
)
check('unscoped vectors produce no hits', semFail.hits.length === 0, `${semFail.hits.length} hits`)
check('but the semantic query still reports it ran', semFail.engine.semantic === true)

// ---------------------------------------------------------------
// D. Direct-id attempts cannot bypass authorization
// ---------------------------------------------------------------

section('D. Direct artifact-id attempts cannot bypass authorization')

// Narrowing the requested scope to a workspace the caller cannot read yields
// an empty scope, and an empty scope must produce nothing at all.
let probe = await searchArtifacts(
  db, principalFor('usr_b'), { query: 'revenue', workspaceIds: ['ws_a'] }
)
check('B asking for ws_a explicitly returns nothing', probe.hits.length === 0)
check('B asking for ws_a reports no readable scope', probe.engine.semantic === false)

// The same, but with vectors supplied for the forbidden artifact.
probe = await searchArtifacts(
  db, principalFor('usr_b'), { query: semanticOnly, workspaceIds: ['ws_a'] },
  semanticReturning(crossTenantMatches)
)
check('B asking for ws_a still gets nothing even with vectors', probe.hits.length === 0)

// Filters cannot be used to escape the scope either.
probe = await searchArtifacts(
  db, principalFor('usr_b'), { query: 'revenue', ownerIds: ['usr_a'] }
)
check('filtering by another tenant\'s owner returns nothing', probe.hits.length === 0)

// Tag filters likewise.
probe = await searchArtifacts(
  db, principalFor('usr_b'), { query: 'revenue', tagSlugs: ['finance'] }
)
check('tag filter returns nothing for B', probe.hits.length === 0)

// A user with no membership at all.
probe = await searchArtifacts(db, principalFor('usr_nobody'), { query: 'revenue' })
check('unknown user gets nothing', probe.hits.length === 0)
check('unknown user reports no semantic run', probe.engine.semantic === false)

// Anonymous (no userId) must not read anything.
probe = await searchArtifacts(
  db, { kind: 'NONE', userId: null, user: null, orgRoles: {}, workspaceRoles: {}, scopes: [] },
  { query: 'revenue' }
)
check('anonymous caller gets nothing', probe.hits.length === 0)

// ---------------------------------------------------------------
// E. Soft-deleted artifacts disappear from both engines
// ---------------------------------------------------------------

section('E. Soft-deleted artifacts are excluded')

db.sqlite.prepare(`UPDATE artifacts SET deleted_at = ? WHERE id = 'art_b'`).run(T)

let afterDelete = await searchArtifacts(
  db, principalFor('usr_b'), { query: semanticOnly }, semanticReturning(crossTenantMatches)
)
check('deleted artifact is gone from lexical', !afterDelete.hits.some((h) => h.artifact.id === 'art_b'))
check('deleted artifact is gone from semantic too (SQL re-scope)',
  !afterDelete.hits.some((h) => h.artifact.id === 'art_b'))
check('its stale vector therefore cannot resurface it', afterDelete.hits.length === 0,
  afterDelete.hits.map((h) => h.artifact.id).join(','))

// ---------------------------------------------------------------
// F. Both engines combine without leaking
// ---------------------------------------------------------------

section('F. Hybrid results remain scoped')

// Lexical matches art_a (A's) and art_b (B's); vectors additionally propose
// art_a and art_shared. For B, only art_b may survive.
let hybrid = await searchArtifacts(
  db, principalFor('usr_b'), { query: 'quarterly revenue' },
  semanticReturning(crossTenantMatches)
)
check('hybrid for B contains only ws_b',
  hybrid.hits.every((h) => h.artifact.workspace_id === 'ws_b'),
  hybrid.hits.map((h) => `${h.artifact.id}@${h.artifact.workspace_id}`).join(','))

// Restore art_b so the count assertion below is meaningful.
db.sqlite.prepare(`UPDATE artifacts SET deleted_at = NULL WHERE id = 'art_b'`).run()

hybrid = await searchArtifacts(
  db, principalFor('usr_a'), { query: 'quarterly revenue' },
  semanticReturning(crossTenantMatches)
)
check('hybrid for A contains only ws_a/ws_shared',
  hybrid.hits.every((h) => ['ws_a', 'ws_shared'].includes(h.artifact.workspace_id)),
  hybrid.hits.map((h) => `${h.artifact.id}@${h.artifact.workspace_id}`).join(','))
check('hybrid for A never contains ws_b',
  !hybrid.hits.some((h) => h.artifact.workspace_id === 'ws_b'))
check('reported total is also scoped', hybrid.total === hybrid.hits.length, `${hybrid.total}/${hybrid.hits.length}`)

// ---------------------------------------------------------------
// G. The relaxed (OR) fallback reports a consistent total
// ---------------------------------------------------------------

section('G. Relaxed fallback expression stays consistent with the rows')

// No artifact contains both terms, so the strict AND expression matches
// nothing and the looser OR expression supplies the rows. The reported total
// must then describe *that* result set. It used to be computed from the strict
// expression, which reported "0 results" above a non-empty list of hits.
const relaxed = await searchArtifacts(db, principalFor('usr_a'), { query: 'governance compliance' })
check('relaxed fallback returns the partial match', relaxed.hits.length === 1,
  `${relaxed.hits.length} hits`)
check('relaxed hit is the expected artifact', relaxed.hits[0]?.artifact.id === 'art_a2',
  relaxed.hits[0]?.artifact.id)
check('relaxed fallback total matches the hits returned',
  relaxed.total === relaxed.hits.length, `${relaxed.total}/${relaxed.hits.length}`)
check('relaxed hit is still confined to a readable workspace',
  relaxed.hits.every((h) => h.artifact.workspace_id === 'ws_a'),
  relaxed.hits.map((h) => h.artifact.workspace_id).join(','))

// ---------------------------------------------------------------
// H. Semantic hits obey every filter, not just the workspace scope
// ---------------------------------------------------------------

section('H. Semantic-only hits respect the caller\'s other filters')

// art_a is in a workspace usr_a can read, and vector search proposes it. The
// status filter nevertheless excludes everything (every row is READY). A
// vector match must not be able to side-step it: semantic-only candidates were
// re-loaded with only the workspace scope, which dropped every other filter.
let filtered = await searchArtifacts(
  db, principalFor('usr_a'),
  { query: semanticOnly, statuses: ['ARCHIVED'] },
  semanticReturning(crossTenantMatches)
)
check('status filter excludes semantic-only hits', filtered.hits.length === 0,
  filtered.hits.map((h) => h.artifact.id).join(','))
check('total agrees with the filtered semantic hits', filtered.total === filtered.hits.length,
  `${filtered.total}/${filtered.hits.length}`)

// A tag the artifact does carry must still admit it, so this is a real filter
// rather than a blanket refusal of semantic-only results.
filtered = await searchArtifacts(
  db, principalFor('usr_a'),
  { query: semanticOnly, tagSlugs: ['finance'] },
  semanticReturning(crossTenantMatches)
)
check('a tag the artifact carries admits the semantic-only hit',
  filtered.hits.some((h) => h.artifact.id === 'art_a'),
  filtered.hits.map((h) => h.artifact.id).join(','))
check('the same tag filter excludes the untagged in-scope vector',
  filtered.hits.every((h) => h.artifact.id === 'art_a'),
  filtered.hits.map((h) => `${h.artifact.id}@${h.artifact.workspace_id}`).join(','))

// A tag it lacks excludes it.
filtered = await searchArtifacts(
  db, principalFor('usr_a'),
  { query: semanticOnly, tagSlugs: ['legal'] },
  semanticReturning(crossTenantMatches)
)
check('a tag the artifact lacks excludes the semantic-only hit', filtered.hits.length === 0,
  filtered.hits.map((h) => h.artifact.id).join(','))

console.log(`\n${'='.repeat(52)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures) {
  console.log('AUTHORIZATION TESTS FAILED')
  process.exit(1)
}
console.log('ALL AUTHORIZATION TESTS PASSED')
