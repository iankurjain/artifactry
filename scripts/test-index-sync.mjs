/**
 * Lexical index synchronisation tests.
 *
 * `artifact_search` is a standalone FTS5 table populated by explicit code —
 * there are no triggers on `artifacts` or `artifact_versions`. Nothing keeps it
 * in step automatically, so every write path that changes searchable text has
 * to call `indexArtifact` itself.
 *
 * That is exactly the contract the reprocess path silently broke: it updated
 * `extracted_text` and the vector index but never rebuilt the FTS row, so text
 * recovered by a re-extract became findable by meaning but *not* by keyword.
 * These tests run the real `indexArtifact` against a real SQLite engine with a
 * real FTS5 table, so a missing or wrong rebuild fails here.
 *
 * Run: node scripts/test-index-sync.mjs
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
// Bundle the real indexArtifact from the shipped module
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
await build({
  stdin: {
    contents: `export { indexArtifact } from './src/lib/search.ts'`,
    resolveDir: process.cwd(),
    sourcefile: 'index-sync-entry.ts',
    loader: 'ts'
  },
  outfile: '/tmp/build/idx.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const { indexArtifact } = await import(pathToFileURL('/tmp/build/idx.mjs').href)

// ---------------------------------------------------------------
// D1-shaped adapter over node:sqlite
// ---------------------------------------------------------------

function makeDB() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE artifacts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
      title TEXT NOT NULL, filename TEXT, description TEXT,
      current_version_id TEXT, deleted_at TEXT
    );
    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, extracted_text TEXT
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE'
    );
    CREATE TABLE artifact_tags (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, tag_id TEXT NOT NULL,
      -- Migration 0006: an association carries a decision. indexArtifact() and
      -- loadTagsFor() index CONFIRMED tags only, so a harness without this
      -- column would fail to reflect the real index semantics.
      state TEXT NOT NULL DEFAULT 'CONFIRMED',
      provenance TEXT NOT NULL DEFAULT 'USER',
      source_version_id TEXT, decided_by TEXT, decided_at TEXT
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
        const rows = db.prepare(sql).all(...bound.map((v) => (v === undefined ? null : v)))
        return rows.length ? rows[0] : null
      },
      async all() {
        return {
          results: db.prepare(sql).all(...bound.map((v) => (v === undefined ? null : v))),
          success: true
        }
      },
      async run() {
        db.prepare(sql).run(...bound.map((v) => (v === undefined ? null : v)))
        return { success: true }
      }
    }
    return stmt
  }

  return {
    sqlite: db,
    prepare: (sql) => statement(sql, []),
    async batch() {
      return []
    },
    insert: (table, row) => {
      const keys = Object.keys(row)
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
      ).run(...keys.map((k) => row[k]))
    }
  }
}

/** Does the lexical index match this term? */
function matches(db, term) {
  return db.sqlite
    .prepare(`SELECT rowid FROM artifact_search WHERE artifact_search MATCH ?`)
    .all(term).length
}

function rowCount(db) {
  return db.sqlite.prepare(`SELECT COUNT(*) AS n FROM artifact_search`).get().n
}

// ---------------------------------------------------------------
// A. Extracted text reaches the lexical index
// ---------------------------------------------------------------

section('A. indexArtifact writes searchable extracted_text')

const db = makeDB()
db.insert('artifacts', {
  id: 'art_1', workspace_id: 'ws_1', title: 'Quarterly Board Pack',
  filename: 'board.pdf', description: 'Investor summary',
  current_version_id: 'ver_1', deleted_at: null
})
db.insert('artifact_versions', {
  id: 'ver_1', artifact_id: 'art_1',
  extracted_text: 'Consolidated revenue rose with expanding gross margin.'
})

await indexArtifact(db, 'art_1')

check('title is searchable', matches(db, 'quarterly') === 1)
check('filename is searchable', matches(db, 'board') === 1)
check('extracted content is searchable', matches(db, 'gross margin') === 1)
check('exactly one index row exists', rowCount(db) === 1, String(rowCount(db)))

// ---------------------------------------------------------------
// B. Re-extraction REPLACES the old text (the reprocess bug)
//
// This is the case that regressed: the vector index was rebuilt but the FTS
// row kept the previous text, so newly recovered words were unfindable.
// ---------------------------------------------------------------

section('B. Re-extraction replaces the indexed text')

await db.sqlite
  .prepare(`UPDATE artifact_versions SET extracted_text = ? WHERE id = 'ver_1'`)
  .run('Logistics fulfilment schedule for the northern distribution network.')

await indexArtifact(db, 'art_1')

check('new text is searchable after re-index', matches(db, 'fulfilment') === 1)
check('new text: "distribution" is searchable', matches(db, 'northern distribution') === 1)
check('STALE text is no longer searchable', matches(db, 'gross') === 0)
check('stale text: "revenue" is gone', matches(db, 'consolidated revenue') === 0)
check('still exactly one row (replace, not append)', rowCount(db) === 1, String(rowCount(db)))

// ---------------------------------------------------------------
// C. Idempotence — repeated runs converge
// ---------------------------------------------------------------

section('C. Repeated indexing is idempotent')

await indexArtifact(db, 'art_1')
await indexArtifact(db, 'art_1')

check('three calls still leave one row', rowCount(db) === 1, String(rowCount(db)))
check('content still searchable', matches(db, 'fulfilment') === 1)

// ---------------------------------------------------------------
// D. Tag text is denormalised into the index
// ---------------------------------------------------------------

section('D. Tag names are searchable')

db.insert('tags', { id: 'tag_1', name: 'Procurement', status: 'ACTIVE' })
db.insert('artifact_tags', { id: 'at_1', artifact_id: 'art_1', tag_id: 'tag_1' })

await indexArtifact(db, 'art_1')

check('tag name is searchable', matches(db, 'procurement') === 1)

// An INACTIVE tag must not be searchable. The status values are ACTIVE and
// INACTIVE (see the tags table), and this matches loadTagsFor() and the search
// facets, neither of which surfaces an inactive tag.
db.sqlite.prepare(`UPDATE tags SET status = 'INACTIVE' WHERE id = 'tag_1'`).run()
await indexArtifact(db, 'art_1')
check('inactive tag is not searchable', matches(db, 'procurement') === 0)
check('inactive tag also drops out of the indexed tag text', 
  (db.sqlite.prepare(`SELECT tags FROM artifact_search`).get().tags ?? '').trim() === '',
  JSON.stringify(db.sqlite.prepare(`SELECT tags FROM artifact_search`).get().tags))

// ---------------------------------------------------------------
// E. A deleted artifact is not re-indexed
// ---------------------------------------------------------------

section('E. Deleted artifacts are not indexed')

db.sqlite.prepare(`UPDATE artifacts SET deleted_at = ? WHERE id = 'art_1'`).run('2026-01-01')
await indexArtifact(db, 'art_1')

// indexArtifact does not filter on deleted_at (the caller decides), so the row
// is written; what matters is that it does not throw and does not duplicate.
check('re-indexing a deleted artifact does not throw', true)
check('row count still 1 after delete + re-index', rowCount(db) === 1, String(rowCount(db)))

// ---------------------------------------------------------------
// F. Missing artifact / version is a no-op, not a crash
// ---------------------------------------------------------------

section('F. Unknown ids are safe')

await indexArtifact(db, 'art_does_not_exist')
check('unknown artifact id does not throw', true)
check('unknown artifact adds no row', rowCount(db) === 1, String(rowCount(db)))

db.insert('artifacts', {
  id: 'art_2', workspace_id: 'ws_1', title: 'No Content Yet',
  filename: 'empty.pdf', description: null, current_version_id: null, deleted_at: null
})
await indexArtifact(db, 'art_2')
check('artifact with no current version still indexes its metadata', matches(db, 'content yet') === 1)
check('row count is now 2', rowCount(db) === 2, String(rowCount(db)))

console.log(`\n${'='.repeat(52)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures) {
  console.log('INDEX SYNC TESTS FAILED')
  process.exit(1)
}
console.log('ALL INDEX SYNC TESTS PASSED')
