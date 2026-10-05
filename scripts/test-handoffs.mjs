/**
 * Handoffs, lineage, provenance and projects — end to end.
 *
 * Drives the REAL application (src/index.tsx), bundled, through `app.fetch`
 * against a real SQLite built from the migration files, with two AI
 * connections that report themselves as Claude and Cursor:
 *
 *   1. text and code files: saved verbatim, returned whole by get
 *   2. provenance: "made by" on artifacts, versions and search, plus the filter
 *   3. lineage: declared derived_from, inferred from recent reads, opt-out
 *   4. handoffs: create, pick up, list, close; the pickup is recorded once
 *   5. access: another user sees neither the handoff nor the links
 *   6. projects: a collection flagged as a project is listed and saved into
 *   7. REST: handoff screens, lineage on the detail, removing a link
 *   8. the directory-review sign-in, then the three listing test prompts
 *
 * Run: node scripts/test-handoffs.mjs
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
  outfile: '/tmp/build/app-handoffs.mjs'
})
const { default: app } = await import(pathToFileURL('/tmp/build/app-handoffs.mjs').href)

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

// Ankur owns Acme; Zed is a stranger with his own organization.
for (const [id, email] of [['usr_a', 'ankur@acme.test'], ['usr_z', 'zed@other.test']]) {
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

const cookies = {}
for (const user of ['usr_a', 'usr_z']) {
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

let rpcId = 0
async function mcp(token, method, params) {
  return call('/api/v1/mcp', {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }
  })
}
async function tool(token, name, args) {
  const j = await json(await mcp(token, 'tools/call', { name, arguments: args }))
  return j?.result ?? { isError: true, error: j?.error }
}
const sc = (r) => r?.structuredContent ?? {}

/** A pasted-token connection that reports itself under `clientName`. */
async function connect(user, clientName, integration = 'int_other') {
  const res = await call(`/api/v1/integrations/${integration}/connect`, {
    user,
    body: { scopes: ['artifact.read', 'artifact.write'] }
  })
  const token = (await data(res)).token
  await mcp(token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: clientName, version: '1.0.0' } })
  return token
}

// Reconnecting one integration replaces its token, so each tool uses its own.
const claude = await connect('usr_a', 'claude-ai', 'int_claude')
const cursor = await connect('usr_a', 'cursor-vscode')
const zed = await connect('usr_z', 'Cursor')

// ---------------------------------------------------------------
section('1. Text and code files are kept exactly as written')
// ---------------------------------------------------------------

const SPEC = '# Billing API spec\r\n\r\n- POST /invoices creates an invoice\n- `amount` is in cents\n'
const CODE = 'export function total(lines) {\n  return lines.reduce((s, l) => s + l.amount, 0)\n}\n'
let specId
let researchId
{
  const tools = (await json(await mcp(claude, 'tools/list'))).result?.tools?.map((t) => t.name) ?? []
  check('tools/list offers handoff, get_handoff, list_handoffs, list_projects',
    ['handoff', 'get_handoff', 'list_handoffs', 'list_projects'].every((n) => tools.includes(n)), tools.join(','))

  let r = await tool(claude, 'save', { content: 'Market research: buyers want invoices in cents.', title: 'Billing research', format: 'md', workspace: 'ws_a' })
  researchId = sc(r).artifact_id
  check('Claude saves Markdown research', !r.isError && researchId, JSON.stringify(r).slice(0, 300))
  check('the save reports made by Claude', sc(r).made_by === 'Claude', sc(r).made_by)

  r = await tool(claude, 'save', { content: SPEC, file: 'billing-spec.md', workspace: 'ws_a', derived_from: [researchId] })
  specId = sc(r).artifact_id
  check('a .md file is saved', !r.isError && specId, JSON.stringify(r).slice(0, 300))
  const row = q('SELECT extension, mime_type, source_client FROM artifacts WHERE id = ?', specId)[0]
  check('stored as plain text with its client name', row?.extension === 'md' && /^text\/plain/.test(row?.mime_type ?? '') && row?.source_client === 'claude-ai', JSON.stringify(row))

  r = await tool(cursor, 'get', { artifact: specId })
  check('get returns the file whole, byte for byte', sc(r).file?.content === SPEC && sc(r).file?.name === 'billing-spec.md', JSON.stringify(sc(r).file))
  check('get says who made it', sc(r).made_by === 'Claude')

  r = await tool(cursor, 'save', { content: CODE, file: 'total.ts', workspace: 'ws_a', derived_from: [] })
  check('a .ts file saves', !r.isError && sc(r).artifact_id, JSON.stringify(r).slice(0, 300))
  const codeGet = await tool(cursor, 'get', { artifact: sc(r).artifact_id })
  check('code comes back unchanged', sc(codeGet).file?.content === CODE)
  check('derived_from: [] records no sources', (sc(r).built_from ?? []).length === 0, JSON.stringify(sc(r).built_from))

  r = await tool(cursor, 'save', { content: 'MZ\u0000\u0000binary', file: 'evil.js', workspace: 'ws_a' })
  // Same as any format whose bytes don't match: kept, but marked failed and never served as text.
  check('a NUL-laden "text" file fails validation', sc(r).status === 'PROCESSING_FAILED' && /binary/i.test(sc(r).detail ?? ''),
    JSON.stringify({ status: sc(r).status, detail: sc(r).detail }))
}

// ---------------------------------------------------------------
section('2. Provenance: made by, on artifacts, versions and search')
// ---------------------------------------------------------------
{
  let r = await tool(claude, 'search', { query: 'billing', made_by: 'cursor' })
  const titles = (sc(r).results ?? []).map((x) => x.title)
  check('search made_by=cursor excludes Claude\'s work', !titles.includes('Billing research'), titles.join(','))

  r = await tool(claude, 'search', { query: 'billing', made_by: 'claude' })
  const claudeHits = sc(r).results ?? []
  check('search made_by=claude finds Claude\'s work and labels it',
    claudeHits.some((x) => x.artifact_id === specId && x.made_by === 'Claude'), JSON.stringify(claudeHits).slice(0, 300))

  const res = await call('/api/v1/search', { user: 'usr_a', body: { query: '', madeBy: 'Cursor' } })
  const web = (await data(res)).results ?? []
  check('REST search filters by madeBy', res.status === 200 && web.length > 0 && web.every((x) => x.madeBy === 'Cursor'),
    JSON.stringify(web.map((x) => x.madeBy)))

  r = await tool(cursor, 'create_version', { artifact: specId, content: SPEC + '- `currency` is ISO 4217\n', file: 'billing-spec.md' })
  check('Cursor adds version 2 of the spec', !r.isError, JSON.stringify(r).slice(0, 300))
  const versions = sc(await tool(claude, 'get', { artifact: specId, include_text: false })).versions ?? []
  check('each version says who made it', versions[0]?.made_by === 'Cursor' && versions[1]?.made_by === 'Claude',
    JSON.stringify(versions.map((v) => v.made_by)))
}

// ---------------------------------------------------------------
section('3. Lineage: declared, inferred and visible from both ends')
// ---------------------------------------------------------------
let deckId
{
  const declared = q('SELECT origin FROM artifact_links WHERE from_artifact_id = ? AND to_artifact_id = ?', specId, researchId)[0]
  check('derived_from records a DECLARED link', declared?.origin === 'DECLARED', JSON.stringify(declared))

  // Cursor read the spec above (get) and now saves without naming sources.
  const r = await tool(cursor, 'save', { content: '# Pricing deck outline\n', file: 'deck.md', workspace: 'ws_a' })
  deckId = sc(r).artifact_id
  const built = (sc(r).built_from ?? []).map((b) => b.artifact_id ?? b)
  check('a save after a read is linked to what was read', built.includes(specId), JSON.stringify(sc(r).built_from))
  const inferred = q('SELECT origin FROM artifact_links WHERE from_artifact_id = ? AND to_artifact_id = ?', deckId, specId)[0]
  check('… as INFERRED', inferred?.origin === 'INFERRED', JSON.stringify(inferred))

  const g = sc(await tool(claude, 'get', { artifact: specId, include_text: false }))
  check('get shows built_from and used_in',
    g.built_from?.some((b) => b.artifact_id === researchId && b.how === 'declared') &&
    g.used_in?.some((b) => b.artifact_id === deckId && b.how === 'inferred'),
    JSON.stringify({ b: g.built_from, u: g.used_in }))

  const bad = await tool(claude, 'save', { content: 'x', file: 'x.md', workspace: 'ws_a', derived_from: ['art_doesnotexist'] })
  check('an unknown source is skipped, not an error', !bad.isError && (sc(bad).derived_from_skipped ?? []).length === 1,
    JSON.stringify(sc(bad)).slice(0, 300))
}

// ---------------------------------------------------------------
section('4. Handoffs: Claude leaves one, Cursor picks it up')
// ---------------------------------------------------------------
let handoffId
{
  let r = await tool(claude, 'handoff', {
    artifacts: [researchId, `${APP}/a/${specId}`],
    brief: 'Build the billing API from the spec. Amounts are in cents.',
    to: 'Cursor'
  })
  handoffId = sc(r).handoff_id
  check('handoff is created with both artifacts', !r.isError && /^hof_/.test(handoffId ?? '') && sc(r).artifacts?.length === 2,
    JSON.stringify(r).slice(0, 400))
  check('it returns a link and a pickup line', sc(r).url === `${APP}/h/${handoffId}` && sc(r).pickup_prompt?.includes(handoffId), sc(r).pickup_prompt)

  r = await tool(claude, 'handoff', { artifacts: [researchId], brief: '   ' })
  check('a handoff needs a brief', r.isError === true)

  r = await tool(cursor, 'list_handoffs', {})
  check('Cursor sees it in list_handoffs', (sc(r).handoffs ?? []).some((h) => h.handoff_id === handoffId && h.from === 'Claude'),
    JSON.stringify(sc(r)).slice(0, 300))

  r = await tool(cursor, 'get_handoff', { handoff: `Open my Artifactry handoff ${handoffId} please` })
  const got = sc(r)
  check('get_handoff finds it from a pasted sentence', !r.isError && got.handoff_id === handoffId, JSON.stringify(r).slice(0, 300))
  check('it carries the brief and the spec in full',
    got.brief?.startsWith('Build the billing API') && got.artifacts?.some((a) => a.artifact_id === specId && a.file?.content?.includes('ISO 4217')),
    JSON.stringify(got).slice(0, 400))

  const row = q('SELECT status, picked_up_by_client FROM handoffs WHERE id = ?', handoffId)[0]
  check('the handoff is marked picked up by Cursor', row?.status === 'PICKED_UP' && row?.picked_up_by_client === 'Cursor', JSON.stringify(row))

  await tool(claude, 'get_handoff', { handoff: handoffId })
  const again = q('SELECT picked_up_by_client FROM handoffs WHERE id = ?', handoffId)[0]
  check('a second pickup does not overwrite the first', again?.picked_up_by_client === 'Cursor')

  r = await tool(cursor, 'save', { content: CODE, file: 'billing.ts', workspace: 'ws_a' })
  const built = (sc(r).built_from ?? []).map((b) => b.artifact_id ?? b)
  check('what Cursor saves next is linked to the handoff\'s artifacts', built.includes(specId) && built.includes(researchId),
    JSON.stringify(sc(r).built_from))

  r = await tool(cursor, 'get_handoff', {})
  check('get_handoff with no id opens the latest', sc(r).handoff_id === handoffId, JSON.stringify(sc(r)).slice(0, 200))

  const audit = q("SELECT action FROM audit_events WHERE target_id = ? ORDER BY occurred_at", handoffId).map((a) => a.action)
  check('create and pickup are audited', audit.includes('HANDOFF_CREATE') && audit.includes('HANDOFF_PICKUP'), audit.join(','))
}

// ---------------------------------------------------------------
section('5. Access: a stranger sees nothing')
// ---------------------------------------------------------------
{
  let r = await tool(zed, 'get_handoff', { handoff: handoffId })
  check('another user cannot open the handoff', r.isError === true, JSON.stringify(r).slice(0, 200))

  r = await tool(zed, 'list_handoffs', {})
  check('… or list it', !(sc(r).handoffs ?? []).some((h) => h.handoff_id === handoffId))

  r = await tool(zed, 'handoff', { artifacts: [specId], brief: 'steal it' })
  check('… or hand off Ankur\'s artifacts', r.isError === true, JSON.stringify(r).slice(0, 200))

  const mine = await tool(zed, 'save', { content: 'zed notes', file: 'zed.md', workspace: 'ws_z', derived_from: [specId] })
  check('… or link to them as a source', (sc(mine).built_from ?? []).length === 0 && (sc(mine).derived_from_skipped ?? []).length === 1,
    JSON.stringify(sc(mine)).slice(0, 300))

  const res = await call(`/api/v1/handoffs/${handoffId}`, { user: 'usr_z' })
  check('the REST handoff screen is 404 for him', res.status === 404, String(res.status))

  r = await tool(zed, 'search', { query: 'billing', made_by: 'claude' })
  check('made_by never widens search beyond what he can read', (sc(r).results ?? []).length === 0)
}

// ---------------------------------------------------------------
section('6. Projects')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/collections', { user: 'usr_a', body: { name: 'Q4 launch', workspaceId: 'ws_a', isProject: true } })
  const projectId = (await data(res)).collection?.id
  check('a collection is created as a project', res.status === 201 && projectId, JSON.stringify(await json(res)).slice(0, 200))
  res = await call('/api/v1/collections', { user: 'usr_a', body: { name: 'Scratch', workspaceId: 'ws_a' } })
  const plainId = (await data(res)).collection?.id

  let r = await tool(cursor, 'list_projects', {})
  const names = (sc(r).projects ?? []).map((p) => p.name)
  check('list_projects shows projects only', names.includes('Q4 launch') && !names.includes('Scratch'), names.join(','))

  r = await tool(cursor, 'save', { content: '# Launch checklist', file: 'checklist.md', workspace: 'ws_a', project: 'Q4 launch' })
  const inProject = q('SELECT 1 FROM collection_artifacts WHERE collection_id = ? AND artifact_id = ?', projectId, sc(r).artifact_id)
  check('save with project files it into the project', !r.isError && inProject.length === 1, JSON.stringify(sc(r)).slice(0, 300))

  res = await call(`/api/v1/collections/${plainId}`, { user: 'usr_a', method: 'PATCH', body: { isProject: true } })
  check('PATCH isProject turns a collection into a project', res.status === 200 && (await data(res)).isProject === true)
  res = await call('/api/v1/collections', { user: 'usr_a' })
  const listed = ((await data(res)).collections ?? []).find((c) => c.id === plainId)
  check('the collections list reports isProject', listed?.isProject === true, JSON.stringify(listed))

  res = await call(`/api/v1/collections/${plainId}`, { user: 'usr_z', method: 'PATCH', body: { isProject: false } })
  check('a stranger cannot change it', res.status === 403 || res.status === 404, String(res.status))

  res = await call('/api/v1/projects', { user: 'usr_a' })
  check('GET /projects lists both', res.status === 200 && ((await data(res)).projects ?? []).length === 2, JSON.stringify(await json(res)).slice(0, 200))
}

// ---------------------------------------------------------------
section('7. The app: handoff screens, lineage and removing a link')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/handoffs', { user: 'usr_a' })
  const listed = (await data(res)).handoffs ?? []
  check('GET /handoffs lists it', res.status === 200 && listed.some((h) => h.id === handoffId), JSON.stringify(listed).slice(0, 200))

  res = await call(`/api/v1/handoffs/${handoffId}`, { user: 'usr_a' })
  let d = await data(res)
  check('GET /handoffs/:id has the brief, artifacts and pickup line',
    d.handoff?.brief?.includes('cents') && d.artifacts?.length === 2 && d.handoff?.pickupPrompt?.includes(handoffId) && d.handoff?.pickedUpBy === 'Cursor',
    JSON.stringify(d).slice(0, 400))
  check('… and says Ankur may close it', d.handoff?.canChange === true)

  res = await call(`/api/v1/handoffs/${handoffId}/status`, { user: 'usr_a', body: { status: 'CLOSED' } })
  check('closing works', res.status === 200, String(res.status))
  res = await call('/api/v1/handoffs', { user: 'usr_a' })
  check('closed handoffs drop out of the default list', !((await data(res)).handoffs ?? []).some((h) => h.id === handoffId))
  res = await call('/api/v1/handoffs?status=all', { user: 'usr_a' })
  check('… but show with status=all', ((await data(res)).handoffs ?? []).some((h) => h.id === handoffId))

  res = await call('/api/v1/handoffs', { user: 'usr_a', body: { artifactIds: [deckId], brief: 'Turn this into slides', to: 'Gemini' } })
  d = await data(res)
  check('a person can start a handoff in the app', res.status === 201 && /^hof_/.test(d.handoff?.id ?? ''), JSON.stringify(await json(res)).slice(0, 300))
  check('… attributed to them, not an AI', d.handoff?.from && !/Claude|Cursor/.test(d.handoff.from), d.handoff?.from)

  res = await call(`/api/v1/artifacts/${specId}`, { user: 'usr_a' })
  d = await data(res)
  const art = d.artifact ?? d
  const lineage = d.lineage ?? art.lineage
  check('the artifact detail carries made by and lineage',
    (art.madeBy === 'Cursor' || art.madeBy === 'Claude') && lineage?.builtFrom?.some((b) => b.artifactId === researchId),
    JSON.stringify({ madeBy: art.madeBy, lineage }).slice(0, 400))

  const link = lineage?.builtFrom?.find((b) => b.artifactId === researchId)
  res = await call(`/api/v1/artifacts/${specId}/links/${link?.linkId}`, { user: 'usr_z', method: 'DELETE' })
  check('a stranger cannot remove a link', res.status === 403 || res.status === 404, String(res.status))
  res = await call(`/api/v1/artifacts/${specId}/links/${link?.linkId}`, { user: 'usr_a', method: 'DELETE' })
  check('the owner removes a wrong link', res.status === 200, String(res.status))
  check('… and it is gone', q('SELECT 1 FROM artifact_links WHERE id = ?', link?.linkId ?? '').length === 0)

  res = await call(`/h/${handoffId}`, { user: 'usr_a' })
  check('/h/:id serves the app shell', res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? ''))
  res = await call('/connect', { user: 'usr_a' })
  check('/connect serves the app shell', res.status === 200)

  res = await call('/api/v1/integrations', { user: 'usr_a' })
  const tools = ((await data(res)).connectedTools ?? []).map((t) => t.name)
  check('integrations lists the connected tools by name', tools.includes('Claude') && tools.includes('Cursor'), tools.join(','))
}

// ---------------------------------------------------------------
section('8. Directory reviewer: fixed-code sign-in and the listing test prompts')
// ---------------------------------------------------------------
{
  // A real email provider is configured, so any send that happens is caught here.
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push(String(url))
    return new Response(JSON.stringify({ id: 'email_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  env.EMAIL_API_KEY = 're_test'
  const REVIEWER = 'reviewer@artifactry.app'
  const CODE = '48151623'
  const signIn = async (email, code) => {
    const res = await call('/api/v1/auth/verify-code', { body: { email, code } })
    return { res, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] }
  }

  try {
    // Off unless both are set, and an unsafe code keeps it off.
    env.REVIEWER_EMAIL = REVIEWER
    env.REVIEWER_CODE = '1234'
    let res = await call('/api/v1/auth/request-code', { body: { email: REVIEWER } })
    check('a code shorter than 8 digits leaves the reviewer sign-in off (a real email goes out)',
      res.status === 200 && (await data(res)).deliveredVia === 'EMAIL' && sent.length === 1, JSON.stringify(await json(res)))
    sqlite.prepare('DELETE FROM auth_otp WHERE email_normalized = ?').run(REVIEWER)

    env.REVIEWER_CODE = CODE
    res = await call('/api/v1/auth/request-code', { body: { email: 'Reviewer@Artifactry.app' } })
    let d = await data(res)
    check('the reviewer address sends no email', res.status === 200 && d.deliveredVia === 'REVIEWER' && sent.length === 1, JSON.stringify(d))
    check('… and never echoes the code', d.devCode === undefined)

    let { res: bad } = await signIn(REVIEWER, '11111111')
    check('a wrong code is refused', bad.status === 400)
    const { res: good, cookie } = await signIn(REVIEWER, CODE)
    check('the fixed code signs the reviewer in', good.status === 200 && /^al_session=/.test(cookie), String(good.status))

    res = await call('/api/v1/auth/request-code', { body: { email: 'someone@acme.test' } })
    check('everyone else still gets an emailed code', (await data(res)).deliveredVia === 'EMAIL' && sent.length === 2)
    const other = await signIn('someone@acme.test', CODE)
    check('the reviewer code does not work for anyone else', other.res.status === 400)

    // The reviewer connects Claude the way a directory reviewer would, then runs the listing's prompts.
    res = await app.fetch(new Request(`${APP}/api/v1/integrations/int_claude/connect`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['artifact.read', 'artifact.write'] })
    }), env, ctx)
    const token = (await data(res)).token
    await mcp(token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1.0.0' } })

    // "Save a note called Directory test to Artifactry"
    let r = await tool(token, 'save', { content: 'A note to check the Artifactry connector works.', title: 'Directory test', format: 'md' })
    const noteId = sc(r).artifact_id
    check('prompt 1: the note saves to the reviewer\'s own workspace', !r.isError && noteId && sc(r).made_by === 'Claude', JSON.stringify(r).slice(0, 300))

    // "Find my Directory test note"
    r = await tool(token, 'search', { query: 'Directory test' })
    check('prompt 2: search finds it', (sc(r).results ?? []).some((x) => x.artifact_id === noteId), JSON.stringify(sc(r)).slice(0, 300))
    r = await tool(token, 'get', { artifact: noteId })
    check('… and get returns it word for word', sc(r).file?.content === 'A note to check the Artifactry connector works.')

    // "Hand off the Directory test note to Cursor with the brief: turn it into a README"
    r = await tool(token, 'handoff', { artifacts: [noteId], brief: 'Turn it into a README', to: 'Cursor' })
    check('prompt 3: the handoff is created with a pickup line', !r.isError && /^hof_/.test(sc(r).handoff_id ?? '') && sc(r).pickup_prompt,
      JSON.stringify(r).slice(0, 300))

    r = await tool(token, 'search', { query: 'billing' })
    check('the reviewer sees none of anyone else\'s work', (sc(r).results ?? []).length === 0)

    // Removing the code switches it off again.
    delete env.REVIEWER_CODE
    sqlite.prepare("UPDATE auth_otp SET created_at = '2000-01-01T00:00:00.000Z' WHERE email_normalized = ?").run(REVIEWER)
    res = await call('/api/v1/auth/request-code', { body: { email: REVIEWER } })
    check('with REVIEWER_CODE removed, the reviewer gets a normal emailed code', (await data(res)).deliveredVia === 'EMAIL')
  } finally {
    globalThis.fetch = realFetch
    delete env.EMAIL_API_KEY
    delete env.REVIEWER_EMAIL
    delete env.REVIEWER_CODE
  }
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
