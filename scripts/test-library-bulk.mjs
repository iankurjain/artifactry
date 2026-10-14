/**
 * Library bulk actions, one collection per artifact, bulk upload and the HTML
 * preview default — end to end.
 *
 * Drives the REAL application (src/index.tsx), bundled, through `app.fetch`
 * against a real SQLite built from the migration files:
 *
 *   1. migration 0012 keeps one membership per artifact (live, then newest)
 *   2. new HTML starts in Interactive Preview unless the uploader opts out
 *   3. saving into collections files into one only; adding moves
 *   4. bulk move to a collection, to a new one, and out of any collection
 *   5. bulk delete: Owners and Admins only, permanent, always per artifact
 *   6. a stranger's ids are skipped, never touched
 *   7. /me says who may delete and who may manage collections
 *
 * Run: node scripts/test-library-bulk.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
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
const section = (t) => console.log(`\n=== ${t} ===`)

mkdirSync('/tmp/build', { recursive: true })
await build({
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  logLevel: 'error',
  entryPoints: ['src/index.tsx'],
  outfile: '/tmp/build/app-library-bulk.mjs'
})
const { default: app } = await import(pathToFileURL('/tmp/build/app-library-bulk.mjs').href)

// ---------------------------------------------------------------
// D1 over node:sqlite, R2 over a Map
// ---------------------------------------------------------------

const sqlite = new DatabaseSync(':memory:')
for (const f of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'))
}
function statement(sql, bound) {
  const exec = () => sqlite.prepare(sql).all(...bound.map((v) => (v === undefined ? null : v)))
  return {
    bind: (...p) => statement(sql, p),
    first: async () => exec()[0] ?? null,
    all: async () => ({ results: exec(), success: true }),
    run: async () => {
      exec()
      return { success: true, meta: {} }
    },
    _exec: exec
  }
}
const db = {
  prepare: (sql) => statement(sql, []),
  batch: async (stmts) => stmts.map((s) => ({ results: s._exec(), success: true })),
  exec: (sql) => sqlite.exec(sql)
}
const insert = (table, row) => {
  const k = Object.keys(row)
  sqlite.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => row[x]))
}
const q = (sql, ...p) => sqlite.prepare(sql).all(...p)

const r2 = new Map()
const R2 = {
  async put(key, value, opts = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer())
    r2.set(key, { bytes, type: opts.httpMetadata?.contentType })
  },
  async get(key) {
    const o = r2.get(key)
    return o
      ? {
          body: new Response(o.bytes).body,
          httpMetadata: { contentType: o.type },
          size: o.bytes.byteLength,
          arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength),
          text: async () => new TextDecoder().decode(o.bytes)
        }
      : null
  },
  async head(key) {
    return r2.has(key) ? { size: r2.get(key).bytes.byteLength } : null
  },
  async delete(key) {
    r2.delete(key)
  }
}

const T = '2026-01-01T00:00:00.000Z'
const APP = 'https://artifactry.test'
const env = { DB: db, R2, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '5000000' }

// Ankur owns Acme. Mia is a Contributor (the Member tier) in its workspace,
// Zed a stranger with his own organization.
for (const [id, email] of [['usr_a', 'ankur@acme.test'], ['usr_m', 'mia@acme.test'], ['usr_z', 'zed@other.test']]) {
  insert('users', { id, email, email_normalized: email, display_name: id, status: 'ACTIVE', created_at: T, updated_at: T })
}
for (const [id, name, owner] of [['org_a', 'Acme', 'usr_a'], ['org_z', 'Other', 'usr_z']]) {
  insert('organizations', {
    id, name, slug: name.toLowerCase(), plan: 'FREE', max_upload_bytes: 5000000,
    settings_json: '{}', status: 'ACTIVE', created_by: owner, created_at: T, updated_at: T
  })
  insert('organization_members', {
    id: `om_${owner}`, organization_id: id, user_id: owner, role: 'ORG_OWNER', created_at: T, created_by: owner, status: 'ACTIVE'
  })
}
insert('workspaces', {
  id: 'ws_a', organization_id: 'org_a', owner_user_id: 'usr_a', workspace_type: 'ORGANIZATION',
  name: 'Launch', description: null, created_at: T, created_by: 'usr_a', archived_at: null
})
insert('workspaces', {
  id: 'ws_z', organization_id: 'org_z', owner_user_id: 'usr_z', workspace_type: 'ORGANIZATION',
  name: 'Zed', description: null, created_at: T, created_by: 'usr_z', archived_at: null
})
insert('workspace_members', { id: 'wsm_m', workspace_id: 'ws_a', user_id: 'usr_m', role: 'CONTRIBUTOR', created_at: T, created_by: 'usr_a', status: 'ACTIVE' })

const cookies = {}
for (const user of ['usr_a', 'usr_m', 'usr_z']) {
  const token = `session-${user}`
  insert('auth_sessions', {
    id: `ses_${user}`, user_id: user,
    token_hash: createHash('sha256').update(`session:v1:${token}`).digest('hex'),
    created_at: T, expires_at: '2099-01-01T00:00:00.000Z', last_seen_at: T, revoked_at: null, user_agent: null
  })
  cookies[user] = `al_session=${token}`
}

const ctx = { waitUntil() {}, passThroughOnException() {} }
async function call(path, { user, body, method, headers = {} } = {}) {
  const init = { method: method ?? (body ? 'POST' : 'GET'), headers: { ...headers } }
  if (user) init.headers.Cookie = cookies[user]
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return app.fetch(new Request(`${APP}${path}`, init), env, ctx)
}
async function json(res) {
  try {
    return await res.clone().json()
  } catch {
    return {}
  }
}
const data = async (res) => (await json(res)).data ?? {}


const upload = async (user, filename, content, fields = {}) => {
  const form = new FormData()
  form.append('file', new File([content], filename, { type: filename.endsWith('.html') ? 'text/html' : 'text/plain' }))
  form.append('workspaceId', fields.workspaceId ?? 'ws_a')
  for (const [k, v] of Object.entries(fields)) if (k !== 'workspaceId') form.append(k, v)
  const res = await app.fetch(
    new Request(`${APP}/api/v1/artifacts`, { method: 'POST', headers: { Cookie: cookies[user] }, body: form }),
    env,
    ctx
  )
  return { res, body: await data(res) }
}
const memberships = (artifactId) =>
  q('SELECT collection_id FROM collection_artifacts WHERE artifact_id = ? ORDER BY collection_id', artifactId).map((r) => r.collection_id)
const newCollection = async (user, name, workspaceId = 'ws_a') =>
  (await data(await call('/api/v1/collections', { user, body: { name, workspaceId } }))).collection?.id

// ---------------------------------------------------------------
section('1. Migration 0012 keeps one collection per artifact')
// ---------------------------------------------------------------
{
  const old = new DatabaseSync(':memory:')
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()
  for (const f of files.filter((f) => f < '0012')) old.exec(readFileSync(`migrations/${f}`, 'utf8'))
  old.exec('PRAGMA foreign_keys = OFF')
  const put = (table, row) => {
    const k = Object.keys(row)
    old.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => row[x]))
  }
  put('collections', { id: 'c_old', workspace_id: 'w', name: 'Old', created_at: T, updated_at: T })
  put('collections', { id: 'c_new', workspace_id: 'w', name: 'New', created_at: T, updated_at: T })
  put('collections', { id: 'c_arch', workspace_id: 'w', name: 'Archived', created_at: T, updated_at: T, archived_at: T })
  // art_1: in two live collections, c_new added last. art_2: archived one added last.
  put('collection_artifacts', { id: 'ca1', collection_id: 'c_old', artifact_id: 'art_1', added_at: '2026-01-01' })
  put('collection_artifacts', { id: 'ca2', collection_id: 'c_new', artifact_id: 'art_1', added_at: '2026-02-01' })
  put('collection_artifacts', { id: 'ca3', collection_id: 'c_old', artifact_id: 'art_2', added_at: '2026-01-01' })
  put('collection_artifacts', { id: 'ca4', collection_id: 'c_arch', artifact_id: 'art_2', added_at: '2026-03-01' })
  put('collection_artifacts', { id: 'ca5', collection_id: 'c_old', artifact_id: 'art_3', added_at: '2026-01-01' })
  old.exec(readFileSync('migrations/0012_one_collection_per_artifact.sql', 'utf8'))
  const left = Object.fromEntries(
    old.prepare('SELECT artifact_id, collection_id FROM collection_artifacts').all().map((r) => [r.artifact_id, r.collection_id])
  )
  check('two live collections: the most recently added one stays', left.art_1 === 'c_new', JSON.stringify(left))
  check('a live collection wins over a newer archived one', left.art_2 === 'c_old', JSON.stringify(left))
  check('an artifact in one collection is untouched', left.art_3 === 'c_old', JSON.stringify(left))
  let threw = false
  try {
    old.exec(`INSERT INTO collection_artifacts (id, collection_id, artifact_id, added_at) VALUES ('ca9', 'c_old', 'art_1', '2026-04-01')`)
  } catch {
    threw = true
  }
  check('a second membership is now impossible', threw)
}

// ---------------------------------------------------------------
section('2. New HTML starts in Interactive Preview')
// ---------------------------------------------------------------
let htmlOn, htmlOff, note
{
  const page = '<!doctype html><title>Demo</title><script>document.title = "ran"</script><p>Hi</p>'
  let r = await upload('usr_a', 'demo.html', page)
  htmlOn = r.body.artifact?.id
  check('an HTML upload succeeds', r.res.status < 300 && htmlOn, JSON.stringify(r.body).slice(0, 200))
  check('it is Interactive by default', q('SELECT interactive_html FROM artifacts WHERE id = ?', htmlOn)[0]?.interactive_html === 1)
  const audit = q(`SELECT metadata_json FROM audit_events WHERE target_id = ? AND action = 'ARTIFACT_CREATE'`, htmlOn)[0]
  check('the creation audit records the starting mode', /"interactiveHtml":true/.test(audit?.metadata_json ?? ''), audit?.metadata_json)

  r = await upload('usr_a', 'safe.html', page, { interactiveHtml: 'false' })
  htmlOff = r.body.artifact?.id
  check('unticking it starts in Safe Preview', q('SELECT interactive_html FROM artifacts WHERE id = ?', htmlOff)[0]?.interactive_html === 0)

  const saved = await data(await call('/api/v1/artifacts', {
    user: 'usr_a',
    body: { filename: 'note.html', mimeType: 'text/html', contentText: '<p>x</p>', workspaceId: 'ws_a' }
  }))
  check('Save HTML is Interactive by default too',
    q('SELECT interactive_html FROM artifacts WHERE id = ?', saved.artifact?.id)[0]?.interactive_html === 1)

  r = await upload('usr_a', 'note.txt', 'plain words')
  note = r.body.artifact?.id
  check('a non-HTML file is never Interactive', q('SELECT interactive_html FROM artifacts WHERE id = ?', note)[0]?.interactive_html === 0)
  check('the title defaults to the file name', r.body.artifact?.title === 'note', r.body.artifact?.title)
}

// ---------------------------------------------------------------
section('3. One collection at save time; adding moves')
// ---------------------------------------------------------------
const cDecks = await newCollection('usr_a', 'Decks')
const cBoard = await newCollection('usr_a', 'Board')
let a1, a2, a3
{
  let r = await upload('usr_a', 'one.txt', 'one', { collectionIds: `${cDecks},${cBoard}` })
  a1 = r.body.artifact?.id
  check('asking for two collections files into the first only', JSON.stringify(memberships(a1)) === JSON.stringify([cDecks]), memberships(a1))
  check('the response lists that one collection', r.body.artifact?.collections?.length === 1)
  a2 = (await upload('usr_a', 'two.txt', 'two', { collectionIds: cDecks })).body.artifact?.id
  a3 = (await upload('usr_m', 'three.txt', 'three')).body.artifact?.id
  check('a Contributor can upload', Boolean(a3))

  const res = await call(`/api/v1/collections/${cBoard}/artifacts`, { user: 'usr_a', body: { artifactIds: [a1] } })
  check('adding to another collection succeeds', res.status === 200, res.status)
  check('...and moves it out of the first', JSON.stringify(memberships(a1)) === JSON.stringify([cBoard]), memberships(a1))

  const list = await data(await call(`/api/v1/artifacts?workspaceId=ws_a&collectionId=${cDecks}`, { user: 'usr_a' }))
  check('the library filter follows the move', list.artifacts?.map((a) => a.id).join() === a2, list.artifacts?.map((a) => a.id).join())
}

// ---------------------------------------------------------------
section('4. Bulk move')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/artifacts/bulk/collection', { user: 'usr_m', body: { artifactIds: [a1, a2, a3], collectionId: cDecks } })
  let out = await data(res)
  check('a Contributor moves three artifacts at once', res.status === 200 && out.moved === 3, JSON.stringify(out))
  check('all three are in Decks and nowhere else',
    [a1, a2, a3].every((id) => JSON.stringify(memberships(id)) === JSON.stringify([cDecks])))

  const cNew = await newCollection('usr_a', 'Fresh')
  out = await data(await call('/api/v1/artifacts/bulk/collection', { user: 'usr_a', body: { artifactIds: [a1, a2], collectionId: cNew } }))
  check('moving into a new collection', out.moved === 2 && memberships(a1)[0] === cNew && memberships(a2)[0] === cNew, JSON.stringify(out))

  out = await data(await call('/api/v1/artifacts/bulk/collection', { user: 'usr_a', body: { artifactIds: [a1], collectionId: null } }))
  check('collectionId null takes it out of every collection', out.moved === 1 && memberships(a1).length === 0)

  const cZed = await newCollection('usr_z', 'Zed things', 'ws_z')
  res = await call('/api/v1/artifacts/bulk/collection', { user: 'usr_z', body: { artifactIds: [a2], collectionId: cZed } })
  out = await data(res)
  check("a stranger cannot pull an artifact into their collection", out.moved === 0 && memberships(a2)[0] === cNew, JSON.stringify(out))
  res = await call('/api/v1/artifacts/bulk/collection', { user: 'usr_z', body: { artifactIds: [a2], collectionId: cDecks } })
  check("a stranger cannot use someone else's collection", res.status === 403 || res.status === 404, res.status)
  res = await call('/api/v1/artifacts/bulk/collection', { user: 'usr_a', body: { artifactIds: [], collectionId: cDecks } })
  check('an empty selection is refused', res.status === 400, res.status)
}

// ---------------------------------------------------------------
section('5. Bulk delete: Owners and Admins only, permanent')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/artifacts/bulk/delete', { user: 'usr_m', body: { artifactIds: [a3] } })
  check('a Contributor cannot bulk delete, even their own upload', res.status === 403, res.status)
  res = await call(`/api/v1/artifacts/${a3}`, { user: 'usr_m', method: 'DELETE' })
  check('...nor delete it one at a time', res.status === 403, res.status)
  check('...and it is still there', q('SELECT deleted_at FROM artifacts WHERE id = ?', a3)[0]?.deleted_at === null)

  res = await call('/api/v1/artifacts/bulk/delete', { user: 'usr_z', body: { artifactIds: [a3] } })
  const zedOut = await data(res)
  check("a stranger's delete touches nothing", res.status === 200 && zedOut.deleted === 0 && zedOut.skipped?.length === 1, JSON.stringify(zedOut))

  const keys = q('SELECT r2_object_key FROM artifact_versions WHERE artifact_id IN (?, ?)', a2, a3).map((r) => r.r2_object_key)
  check('the files exist before', keys.length === 2 && keys.every((k) => r2.has(k)))
  res = await call('/api/v1/artifacts/bulk/delete', { user: 'usr_a', body: { artifactIds: [a2, a3, 'art_missing'] } })
  const out = await data(res)
  check('the Owner deletes two at once', res.status === 200 && out.deleted === 2, JSON.stringify(out))
  check('an unknown id is reported as skipped', out.skipped?.join() === 'art_missing')
  check('both are marked deleted', q('SELECT COUNT(*) AS n FROM artifacts WHERE id IN (?, ?) AND deleted_at IS NOT NULL', a2, a3)[0].n === 2)
  check('their stored files are gone', keys.every((k) => !r2.has(k)))
  check('their extracted text is gone',
    q('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id IN (?, ?) AND extracted_text IS NOT NULL', a2, a3)[0].n === 0)
  check('they left their collection', memberships(a2).length === 0 && memberships(a3).length === 0)
  const audits = q(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'ARTIFACT_DELETE' AND target_id IN (?, ?)`, a2, a3)[0].n
  check('each delete is audited', audits === 2, audits)
  const list = await data(await call('/api/v1/artifacts?workspaceId=ws_a', { user: 'usr_a' }))
  check('the library no longer lists them', !list.artifacts?.some((a) => a.id === a2 || a.id === a3))
  res = await call(`/api/v1/artifacts/${a2}/content`, { user: 'usr_a' })
  check('their content is not served', res.status === 404, res.status)

  res = await call(`/api/v1/artifacts/${note}`, { user: 'usr_a', method: 'DELETE' })
  check('the Owner can still delete one from its page', res.status === 200, res.status)
}

// ---------------------------------------------------------------
section('6. Who may do what, as the app is told')
// ---------------------------------------------------------------
{
  const ws = async (user) => ((await data(await call('/api/v1/auth/me', { user }))).workspaces || []).find((w) => w.id === 'ws_a')
  const owner = await ws('usr_a')
  const member = await ws('usr_m')
  check('the Owner may delete and manage collections', owner?.canDelete === true && owner?.canManageCollections === true, JSON.stringify(owner))
  check('a Contributor may manage collections but not delete', member?.canDelete === false && member?.canManageCollections === true, JSON.stringify(member))
  const detail = await data(await call(`/api/v1/artifacts/${htmlOn}`, { user: 'usr_m' }))
  check('the artifact page tells a Contributor they cannot delete', detail.artifact?.canDelete === false || detail.canDelete === false,
    JSON.stringify(detail).slice(0, 200))
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
