/**
 * Audio and video artifacts — end to end.
 *
 * Drives the REAL application (src/index.tsx), bundled, through `app.fetch`
 * against a real SQLite built from the migration files and an in-memory R2
 * with multipart uploads and ranged reads:
 *
 *   1. small audio saves in one request, typed by extension, never as declared
 *   2. audio over 20 MB and video over 200 MB are refused before any upload
 *   3. a video goes up in parts, is joined, and lands READY with its fields
 *   4. parts must be exactly sized and complete; a stranger cannot touch them
 *   5. a file whose bytes are not what its extension says is not kept
 *   6. delivery honours Range (206, suffix, 416) and counts one view per play
 *
 * Run: node scripts/test-media.mjs
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
  outfile: '/tmp/build/app-media.mjs'
})
const { default: app } = await import(pathToFileURL('/tmp/build/app-media.mjs').href)

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
const multiparts = new Map()
const asBytes = async (value) =>
  value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer())
const bodyOf = (bytes, type) => ({
  body: new Response(bytes).body,
  httpMetadata: { contentType: type },
  size: bytes.byteLength,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  text: async () => new TextDecoder().decode(bytes)
})
const R2 = {
  async put(key, value, opts = {}) {
    r2.set(key, { bytes: await asBytes(value), type: opts.httpMetadata?.contentType })
  },
  async get(key, opts = {}) {
    const o = r2.get(key)
    if (!o) return null
    const range = opts.range
    const bytes = range ? o.bytes.subarray(range.offset, range.offset + range.length) : o.bytes
    return bodyOf(bytes, o.type)
  },
  async head(key) {
    return r2.has(key) ? { size: r2.get(key).bytes.byteLength, etag: 'e-' + key.length } : null
  },
  async delete(key) {
    r2.delete(key)
  },
  async list({ prefix = '' } = {}) {
    return { objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: r2.get(key).bytes.byteLength })), truncated: false }
  },
  async createMultipartUpload(key, opts = {}) {
    const uploadId = `r2up-${multiparts.size + 1}`
    multiparts.set(uploadId, { key, type: opts.httpMetadata?.contentType, parts: new Map() })
    return R2.resumeMultipartUpload(key, uploadId)
  },
  resumeMultipartUpload(key, uploadId) {
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const mp = multiparts.get(uploadId)
        if (!mp) throw new Error('no such upload')
        mp.parts.set(partNumber, await asBytes(value))
        return { partNumber, etag: `etag-${partNumber}-${mp.parts.get(partNumber).byteLength}` }
      },
      async complete(parts) {
        const mp = multiparts.get(uploadId)
        if (!mp) throw new Error('no such upload')
        const pieces = parts.map((p) => {
          const b = mp.parts.get(p.partNumber)
          if (!b || p.etag !== `etag-${p.partNumber}-${b.byteLength}`) throw new Error('bad part')
          return b
        })
        const total = pieces.reduce((n, b) => n + b.byteLength, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const b of pieces) {
          out.set(b, off)
          off += b.byteLength
        }
        r2.set(key, { bytes: out, type: mp.type })
        multiparts.delete(uploadId)
      },
      async abort() {
        multiparts.delete(uploadId)
      }
    }
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



const MB = 1024 * 1024
// An MP4 starts with an `ftyp` box; an MP3 with an ID3 tag.
const mp4 = (size) => {
  const b = new Uint8Array(size)
  b.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  for (let i = 12; i < size; i += 4096) b[i] = i % 251
  return b
}
const mp3 = (size) => {
  const b = new Uint8Array(size)
  b.set([0x49, 0x44, 0x33, 3, 0])
  return b
}
const upload = async (user, filename, bytes, type) => {
  const form = new FormData()
  form.append('file', new File([bytes], filename, { type }))
  form.append('workspaceId', 'ws_a')
  const res = await app.fetch(
    new Request(`${APP}/api/v1/artifacts`, { method: 'POST', headers: { Cookie: cookies[user] }, body: form }),
    env,
    ctx
  )
  return { res, body: await data(res) }
}
const putPart = (user, id, n, bytes) =>
  app.fetch(
    new Request(`${APP}/api/v1/artifacts/media-uploads/${id}/parts/${n}`, {
      method: 'PUT',
      headers: { Cookie: cookies[user], 'Content-Type': 'application/octet-stream' },
      body: bytes
    }),
    env,
    ctx
  )
async function sendInParts(user, filename, bytes, fields = {}) {
  const start = await call('/api/v1/artifacts/media-uploads', { user, body: { filename, size: bytes.byteLength, workspaceId: 'ws_a', ...fields } })
  const s = await data(start)
  if (start.status !== 201) return { start, s }
  const parts = []
  for (let n = 1; n <= s.partCount; n++) {
    const res = await putPart(user, s.uploadId, n, bytes.subarray((n - 1) * s.partSize, n * s.partSize))
    parts.push(await data(res))
  }
  const done = await call(`/api/v1/artifacts/media-uploads/${s.uploadId}/complete`, { user, body: { parts } })
  return { start, s, parts, done, body: await data(done) }
}

// ---------------------------------------------------------------
section('1. Small audio in one request')
// ---------------------------------------------------------------
let song
{
  const r = await upload('usr_a', 'theme.mp3', mp3(40_000), 'application/octet-stream')
  song = r.body.artifact
  check('an MP3 upload succeeds', r.res.status === 201, JSON.stringify(r.body).slice(0, 200))
  check('it is READY', song?.status === 'READY', song?.status)
  check('it is served as audio/mpeg whatever was declared', song?.mimeType === 'audio/mpeg', song?.mimeType)
  const bad = await upload('usr_a', 'fake.wav', new TextEncoder().encode('not really audio'), 'audio/wav')
  check('a .wav that is not WAV is refused', bad.body.artifact?.status === 'PROCESSING_FAILED', JSON.stringify(bad.body).slice(0, 200))
}

// ---------------------------------------------------------------
section('2. Limits: 20 MB audio, 200 MB video')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/artifacts/media-uploads', { user: 'usr_a', body: { filename: 'long.mp3', size: 20 * MB + 1, workspaceId: 'ws_a' } })
  check('audio over 20 MB is refused before upload', res.status === 413, res.status)
  check('the message names the audio limit', /Audio files can be up to 20 MB/.test((await json(res)).message ?? ''), (await json(res)).message)
  res = await call('/api/v1/artifacts/media-uploads', { user: 'usr_a', body: { filename: 'film.mp4', size: 200 * MB + 1, workspaceId: 'ws_a' } })
  check('video over 200 MB is refused', res.status === 413, res.status)
  res = await call('/api/v1/artifacts/media-uploads', { user: 'usr_a', body: { filename: 'film.mp4', size: 200 * MB, workspaceId: 'ws_a' } })
  const big = await data(res)
  check('exactly 200 MB of video is accepted', res.status === 201 && big.partCount === 25, JSON.stringify(big))
  res = await call(`/api/v1/artifacts/media-uploads/${big.uploadId}`, { user: 'usr_a', method: 'DELETE' })
  check('an upload can be given up', res.status === 200 && multiparts.size === 0, res.status)
  res = await call('/api/v1/artifacts/media-uploads', { user: 'usr_a', body: { filename: 'deck.pdf', size: 100, workspaceId: 'ws_a' } })
  check('a non-media file cannot use the parted path', res.status === 415, res.status)
  res = await call('/api/v1/artifacts/media-uploads', { user: 'usr_z', body: { filename: 'x.mp4', size: 100, workspaceId: 'ws_a' } })
  check("a stranger cannot start an upload into someone else's workspace", res.status === 403 || res.status === 404, res.status)
  const r = await upload('usr_a', 'big.mp3', mp3(21 * MB), 'audio/mpeg')
  check('audio over 20 MB in one request is refused too', r.res.status === 413, r.res.status)
}

// ---------------------------------------------------------------
section('3. A video in parts')
// ---------------------------------------------------------------
let film, filmBytes
{
  const cId = (await data(await call('/api/v1/collections', { user: 'usr_a', body: { name: 'Clips', workspaceId: 'ws_a' } }))).collection?.id
  filmBytes = mp4(20 * MB + 123)
  const r = await sendInParts('usr_a', 'launch film.mp4', filmBytes, { title: 'Launch film', tags: ['launch'], collectionIds: [cId] })
  check('the upload starts with 8 MB parts', r.s.partSize === 8 * MB && r.s.partCount === 3, JSON.stringify(r.s))
  check('every part is stored', r.parts.every((p) => p.etag), JSON.stringify(r.parts))
  film = r.body.artifact
  check('joining creates the artifact', r.done.status === 201 && film?.status === 'READY', JSON.stringify(r.body).slice(0, 300))
  check('it keeps the title, tag and collection', film?.title === 'Launch film' && (film?.tags || []).includes('launch') && film?.collections?.[0]?.id === cId,
    JSON.stringify({ t: film?.title, tags: film?.tags, c: film?.collections }))
  check('it is video/mp4 of the full size', film?.mimeType === 'video/mp4' && film?.sizeBytes === filmBytes.byteLength, `${film?.mimeType} ${film?.sizeBytes}`)
  const key = q('SELECT r2_object_key FROM artifact_versions WHERE artifact_id = ?', film?.id)[0]?.r2_object_key
  check('the stored bytes are the file', key && Buffer.compare(Buffer.from(r2.get(key).bytes), Buffer.from(filmBytes)) === 0)
  check('no upload state is left behind', ![...r2.keys()].some((k) => k.startsWith('staging/media/')), [...r2.keys()].join(','))
}

// ---------------------------------------------------------------
section('4. Parts are checked')
// ---------------------------------------------------------------
{
  const bytes = mp4(9 * MB)
  const s = await data(await call('/api/v1/artifacts/media-uploads', { user: 'usr_a', body: { filename: 'clip.mp4', size: bytes.byteLength, workspaceId: 'ws_a' } }))
  let res = await putPart('usr_a', s.uploadId, 1, bytes.subarray(0, 8 * MB - 1))
  check('a short middle part is refused', res.status === 400, res.status)
  res = await putPart('usr_a', s.uploadId, 3, bytes.subarray(0, 10))
  check('a part past the end is refused', res.status === 400, res.status)
  res = await putPart('usr_z', s.uploadId, 1, bytes.subarray(0, 8 * MB))
  check("a stranger cannot send parts to someone else's upload", res.status === 404, res.status)
  const p1 = await data(await putPart('usr_a', s.uploadId, 1, bytes.subarray(0, 8 * MB)))
  res = await call(`/api/v1/artifacts/media-uploads/${s.uploadId}/complete`, { user: 'usr_a', body: { parts: [p1] } })
  check('joining with a part missing is refused', res.status === 400 && /Part 2/.test((await json(res)).message ?? ''), (await json(res)).message)
  const p2 = await data(await putPart('usr_a', s.uploadId, 2, bytes.subarray(8 * MB)))
  res = await call(`/api/v1/artifacts/media-uploads/${s.uploadId}/complete`, { user: 'usr_z', body: { parts: [p1, p2] } })
  check('a stranger cannot join it', res.status === 404, res.status)
  res = await call(`/api/v1/artifacts/media-uploads/${s.uploadId}/complete`, { user: 'usr_a', body: { parts: [p1, p2] } })
  check('with every part it joins', res.status === 201, res.status)
  res = await call(`/api/v1/artifacts/media-uploads/${s.uploadId}/complete`, { user: 'usr_a', body: { parts: [p1, p2] } })
  check('a finished upload cannot be joined twice', res.status === 404, res.status)
  res = await call('/api/v1/artifacts/media-uploads/not-an-id/complete', { user: 'usr_a', body: { parts: [] } })
  check('an unknown id is not found', res.status === 404, res.status)
}

// ---------------------------------------------------------------
section('5. Bytes must match the extension')
// ---------------------------------------------------------------
{
  const before = r2.size
  const r = await sendInParts('usr_a', 'renamed.mov', new Uint8Array(9 * MB).fill(7))
  check('a .mov that is not QuickTime fails', r.body.artifact?.status === 'PROCESSING_FAILED', JSON.stringify(r.body).slice(0, 200))
  check('its bytes are not kept', r2.size === before, `${before} -> ${r2.size}`)
  const ok = await sendInParts('usr_a', 'screen.webm', (() => { const b = new Uint8Array(1000); b.set([0x1a, 0x45, 0xdf, 0xa3]); return b })())
  check('a real WebM in a single part is fine', ok.body.artifact?.status === 'READY' && ok.body.artifact?.mimeType === 'video/webm', JSON.stringify(ok.body).slice(0, 200))
}

// ---------------------------------------------------------------
section('6. Playback: ranges and views')
// ---------------------------------------------------------------
{
  const views = () => q(`SELECT COUNT(*) AS n FROM artifact_events WHERE artifact_id = ? AND event_type = 'artifact_viewed'`, film.id)[0].n
  const get = (range) => call(`/api/v1/artifacts/${film.id}/content`, { user: 'usr_a', headers: range ? { Range: range } : {} })
  let res = await get()
  check('a plain fetch is the whole file and says ranges work', res.status === 200 && res.headers.get('Accept-Ranges') === 'bytes' &&
    Number(res.headers.get('Content-Length')) === filmBytes.byteLength, `${res.status} ${res.headers.get('Accept-Ranges')}`)
  check('it is served inline as video/mp4', res.headers.get('Content-Type') === 'video/mp4' && /^inline/.test(res.headers.get('Content-Disposition')),
    `${res.headers.get('Content-Type')} ${res.headers.get('Content-Disposition')}`)
  const v0 = views()
  res = await get('bytes=0-')
  check('bytes=0- is 206 for the whole file', res.status === 206 && res.headers.get('Content-Range') === `bytes 0-${filmBytes.byteLength - 1}/${filmBytes.byteLength}`, res.headers.get('Content-Range'))
  check('the first range of a play counts as a view', views() === v0 + 1, `${v0} -> ${views()}`)
  res = await get('bytes=100-199')
  const chunk = new Uint8Array(await res.arrayBuffer())
  check('a middle range returns exactly those bytes', res.status === 206 && chunk.byteLength === 100 &&
    Buffer.compare(Buffer.from(chunk), Buffer.from(filmBytes.subarray(100, 200))) === 0, `${res.status} ${chunk.byteLength}`)
  res = await get('bytes=-500')
  check('a suffix range returns the end', res.status === 206 && res.headers.get('Content-Range') === `bytes ${filmBytes.byteLength - 500}-${filmBytes.byteLength - 1}/${filmBytes.byteLength}`,
    res.headers.get('Content-Range'))
  check('seeking does not count more views', views() === v0 + 1, `${v0} -> ${views()}`)
  res = await get(`bytes=${filmBytes.byteLength}-`)
  check('a range past the end is 416', res.status === 416 && res.headers.get('Content-Range') === `bytes */${filmBytes.byteLength}`, res.status)
  res = await call(`/api/v1/artifacts/${song.id}/content`, { user: 'usr_z', headers: { Range: 'bytes=0-' } })
  check('a stranger gets no bytes', res.status === 403 || res.status === 404, res.status)
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
