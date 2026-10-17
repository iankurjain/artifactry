/**
 * The auth model, end to end against the real app (same harness as
 * test-oauth.mjs: bundled src/index.tsx, SQLite from the real migrations).
 *
 *   1. Consent: the person can untick scopes; the token carries only what
 *      was left ticked, and unticking everything is a refusal.
 *   2. Client ID Metadata Documents: an https client_id is fetched, checked
 *      and used for a full sign-in with no registration call.
 *   3. Personal access tokens: named, scoped, shown once, hashed, expiring,
 *      revocable one at a time, and unable to mint or list tokens.
 *   4. Every tool call is audited under the person, per credential.
 *   5. Existing credentials keep working: pasted connector tokens, OAuth
 *      grants from before migration 0013, and reconnecting a pasted token
 *      leaves OAuth sign-ins and PATs alone.
 *
 * Run: node scripts/test-auth-model.mjs
 */


import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
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

// ---------------------------------------------------------------
// Bundle the real app
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
await build({
  entryPoints: ['src/index.tsx'],
  outfile: '/tmp/build/app-auth-model.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  logLevel: 'error'
})
const { default: app } = await import(pathToFileURL('/tmp/build/app-auth-model.mjs').href)

// ---------------------------------------------------------------
// D1 over node:sqlite, R2 over a Map
// ---------------------------------------------------------------

function makeDB() {
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
  return {
    sqlite,
    prepare: (sql) => statement(sql, []),
    batch: async (stmts) => stmts.map((s) => ({ results: s._exec(), success: true })),
    exec: (sql) => sqlite.exec(sql),
    insert(table, row) {
      const k = Object.keys(row)
      sqlite.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => row[x]))
    }
  }
}

function makeR2() {
  const store = new Map()
  return {
    store,
    async put(key, value, opts) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer())
      store.set(key, { bytes, opts })
      return { key }
    },
    async get(key) {
      const o = store.get(key)
      if (!o) return null
      return {
        body: new Response(o.bytes).body,
        arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength),
        text: async () => new TextDecoder().decode(o.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
        httpMetadata: o.opts?.httpMetadata ?? {},
        size: o.bytes.byteLength
      }
    },
    async head(key) {
      const o = store.get(key)
      return o ? { size: o.bytes.byteLength, httpMetadata: o.opts?.httpMetadata ?? {} } : null
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    async list({ prefix = '' } = {}) {
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.bytes.byteLength }))
      return { objects, truncated: false }
    }
  }
}

const db = makeDB()
const R2 = makeR2()
const env = { DB: db, R2, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '5000000' }
const ORIGIN = 'https://artifactry.test'
const T = '2026-01-01T00:00:00.000Z'

// One user with an org workspace, and a browser session for them.
db.insert('users', {
  id: 'usr_a', email: 'ankur@example.com', email_normalized: 'ankur@example.com',
  display_name: 'Ankur', status: 'ACTIVE', created_at: T, updated_at: T
})
db.insert('organizations', {
  id: 'org_a', name: 'Acme', slug: 'acme', plan: 'FREE', max_upload_bytes: 5000000,
  settings_json: '{}', status: 'ACTIVE', created_by: 'usr_a', created_at: T, updated_at: T
})
db.insert('organization_members', {
  id: 'om_a', organization_id: 'org_a', user_id: 'usr_a', role: 'ORG_OWNER',
  created_at: T, created_by: 'usr_a', status: 'ACTIVE'
})
db.insert('workspaces', {
  id: 'ws_a', organization_id: 'org_a', owner_user_id: 'usr_a', workspace_type: 'ORGANIZATION',
  name: 'Marketing', description: null, created_at: T, created_by: 'usr_a', archived_at: null
})
const sessionToken = 'session-token-for-tests'
db.insert('auth_sessions', {
  id: 'ses_a', user_id: 'usr_a',
  token_hash: createHash('sha256').update(`session:v1:${sessionToken}`).digest('hex'),
  created_at: T, expires_at: '2099-01-01T00:00:00.000Z', last_seen_at: T, revoked_at: null, user_agent: null
})
const COOKIE = `al_session=${sessionToken}`

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

async function call(path, init = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), env, { waitUntil() {}, passThroughOnException() {} })
}
async function json(res) {
  return res.json().catch(() => null)
}
const b64url = (buf) => Buffer.from(buf).toString('base64url')
function pkce() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}
function form(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined))
}
let rpcId = 0
async function mcp(token, method, params, { notification = false } = {}) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
  if (!notification) body.id = ++rpcId
  return call('/api/v1/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
}
async function tool(token, name, args) {
  const res = await mcp(token, 'tools/call', { name, arguments: args })
  const j = await json(res)
  return j?.result ?? { isError: true, error: j?.error }
}


const post = (path, body, headers = {}) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const sessionJson = { Cookie: COOKIE, Origin: ORIGIN }
const formHeaders = { Cookie: COOKIE, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }

async function exchange(clientId, redirectUri, code, verifier) {
  const res = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier })
  })
  return { res, body: await json(res) }
}

// ---------------------------------------------------------------
section('1. Consent lets the person choose scopes')
// ---------------------------------------------------------------

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const dcr = await json(await post('/oauth/register', { client_name: 'ChatGPT', redirect_uris: [REDIRECT] }))
const authParams = (challenge, extra = {}) => ({
  response_type: 'code',
  client_id: dcr.client_id,
  redirect_uri: REDIRECT,
  state: 'st',
  scope: 'artifact.read artifact.write artifact.share',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...extra
})

let oauthAccess
{
  const p = pkce()
  const page = await call(`/oauth/authorize?${form(authParams(p.challenge))}`, { headers: { Cookie: COOKIE } })
  const html = await page.text()
  check('the consent page shows a ticked checkbox per requested scope',
    (html.match(/name="grant_scope"/g) ?? []).length === 3 && (html.match(/ checked>/g) ?? []).length === 3)
  check('it says actions are recorded under the person', /recorded under your name/.test(html))

  // Untick artifact.share: two grant_scope values and the page's marker.
  const body = new URLSearchParams(form(authParams(p.challenge)))
  body.append('scope_choice', '1')
  body.append('grant_scope', 'artifact.read')
  body.append('grant_scope', 'artifact.write')
  body.append('decision', 'approve')
  const approve = await call('/oauth/authorize', { method: 'POST', headers: formHeaders, body: body.toString() })
  const code = new URL(approve.headers.get('Location')).searchParams.get('code')
  const { body: tokens } = await exchange(dcr.client_id, REDIRECT, code, p.verifier)
  check('the token carries only the scopes left ticked', tokens?.scope === 'artifact.read artifact.write', tokens?.scope)
  oauthAccess = tokens.access_token

  const shareCall = await tool(oauthAccess, 'share', { artifact_id: 'art_x', audience: 'public' })
  check('an unticked scope is refused at call time', shareCall.isError === true)

  const none = new URLSearchParams(form(authParams(pkce().challenge)))
  none.append('scope_choice', '1')
  none.append('decision', 'approve')
  const refused = await call('/oauth/authorize', { method: 'POST', headers: formHeaders, body: none.toString() })
  const loc = refused.headers.get('Location') ?? ''
  check('unticking everything is access_denied, with no code', /error=access_denied/.test(loc) && !/code=/.test(loc), loc)

  const forged = new URLSearchParams(form(authParams(pkce().challenge, { scope: 'artifact.read' })))
  forged.append('scope_choice', '1')
  forged.append('grant_scope', 'artifact.read')
  forged.append('grant_scope', 'artifact.share')
  forged.append('decision', 'approve')
  const f = await call('/oauth/authorize', { method: 'POST', headers: formHeaders, body: forged.toString() })
  const fcode = new URL(f.headers.get('Location')).searchParams.get('code')
  const row = db.sqlite.prepare('SELECT scopes FROM oauth_codes WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1').get()
  check('a ticked scope the client never asked for is not granted', !!fcode && row?.scopes === '["artifact.read"]', row?.scopes)

  const grant = db.sqlite.prepare("SELECT kind FROM integration_grants WHERE oauth_client_id = ? AND status = 'ACTIVE'").get(dcr.client_id)
  check('an OAuth grant is stored as kind OAUTH', grant?.kind === 'OAUTH', grant?.kind)
}

// ---------------------------------------------------------------
section('2. Client ID Metadata Documents')
// ---------------------------------------------------------------

const CIMD_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CIMD_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const documents = new Map([
  [CIMD_ID, { client_id: CIMD_ID, client_name: 'Claude', redirect_uris: [CIMD_REDIRECT], token_endpoint_auth_method: 'none' }],
  ['https://evil.example/client', { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirect_uris: ['https://evil.example/cb'] }],
  ['https://secret.example/client', { client_id: 'https://secret.example/client', redirect_uris: ['https://secret.example/cb'], token_endpoint_auth_method: 'client_secret_post' }]
])
const fetched = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url
  fetched.push(url)
  const doc = documents.get(url)
  return doc ? new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('no', { status: 404 })
}
try {
  const asm = await json(await call('/.well-known/oauth-authorization-server'))
  check('server metadata advertises client_id_metadata_document_supported', asm?.client_id_metadata_document_supported === true)

  const p = pkce()
  const q = (extra = {}) => form({
    response_type: 'code', client_id: CIMD_ID, redirect_uri: CIMD_REDIRECT, state: 's',
    scope: 'artifact.read artifact.write', code_challenge: p.challenge, code_challenge_method: 'S256', ...extra
  })
  const page = await call(`/oauth/authorize?${q()}`, { headers: { Cookie: COOKIE } })
  const html = await page.text()
  check('an https client_id is fetched and the consent page names Claude',
    page.status === 200 && /Connect Claude to Artifactry/.test(html) && fetched.includes(CIMD_ID), `${page.status} ${html.slice(0, 200)}`)
  check('the consent page says which host the client was verified from', /verified from <strong>claude\.ai<\/strong>/.test(html))
  const row = db.sqlite.prepare('SELECT integration_id, secret_hash, metadata_fetched_at FROM oauth_clients WHERE id = ?').get(CIMD_ID)
  check('the document is cached as a public Claude client', row?.integration_id === 'int_claude' && row?.secret_hash === null && !!row?.metadata_fetched_at, JSON.stringify(row))

  const before = fetched.length
  await call(`/oauth/authorize?${q()}`, { headers: { Cookie: COOKIE } })
  check('a fresh cached copy is not fetched again', fetched.length === before)

  const approve = await call('/oauth/authorize', { method: 'POST', headers: formHeaders, body: `${q()}&decision=approve` })
  const code = new URL(approve.headers.get('Location')).searchParams.get('code')
  const { res, body } = await exchange(CIMD_ID, CIMD_REDIRECT, code, p.verifier)
  check('the code exchanges for tokens with the URL as client_id', res.status === 200 && !!body?.access_token, JSON.stringify(body))
  const init = await json(await mcp(body.access_token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1' } }))
  check('the metadata-document client can call MCP', !!init?.result?.serverInfo)

  const wrongRedirect = await call(`/oauth/authorize?${q({ redirect_uri: 'https://attacker.example/cb' })}`, { headers: { Cookie: COOKIE } })
  check('a redirect not in the document is refused on our page', wrongRedirect.status === 400 && !wrongRedirect.headers.get('Location'))

  const spoof = await call(`/oauth/authorize?${q({ client_id: 'https://evil.example/client', redirect_uri: 'https://evil.example/cb' })}`, { headers: { Cookie: COOKIE } })
  check('a document whose client_id differs from its URL is refused', spoof.status === 400 && /does not match/.test(await spoof.text()))

  const secret = await call(`/oauth/authorize?${q({ client_id: 'https://secret.example/client', redirect_uri: 'https://secret.example/cb' })}`, { headers: { Cookie: COOKIE } })
  check('a document asking for a confidential client is refused', secret.status === 400)

  const missing = await call(`/oauth/authorize?${q({ client_id: 'https://nowhere.example/client' })}`, { headers: { Cookie: COOKIE } })
  check('an unreachable document is refused', missing.status === 400)

  const n = fetched.length
  const ip = await call(`/oauth/authorize?${q({ client_id: 'https://10.0.0.1/client' })}`, { headers: { Cookie: COOKIE } })
  check('an IP-literal client_id URL is never fetched', ip.status === 400 && fetched.length === n)
  const local = await call(`/oauth/authorize?${q({ client_id: 'https://metadata.internal/client' })}`, { headers: { Cookie: COOKIE } })
  check('an internal hostname is never fetched', local.status === 400 && fetched.length === n)

  // Stale copy + unreachable document: sign-in keeps working on the cache.
  db.sqlite.prepare("UPDATE oauth_clients SET metadata_fetched_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(CIMD_ID)
  documents.delete(CIMD_ID)
  const stale = await call(`/oauth/authorize?${q()}`, { headers: { Cookie: COOKIE } })
  check('a stale copy is re-fetched, and kept when the fetch fails', stale.status === 200 && fetched.filter((u) => u === CIMD_ID).length === 2)
} finally {
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------
section('3. Personal access tokens')
// ---------------------------------------------------------------

let pat, pat2
{
  const noName = await post('/api/v1/tokens', { scopes: ['artifact.read'] }, sessionJson)
  check('a token needs a name', noName.status === 400)
  const badExpiry = await post('/api/v1/tokens', { name: 'x', scopes: ['artifact.read'], expiresInDays: 12 }, sessionJson)
  check('expiry must be one of the offered choices', badExpiry.status === 400)
  const badScope = await post('/api/v1/tokens', { name: 'x', scopes: ['artifact.admin'] }, sessionJson)
  check('an unknown scope is refused', badScope.status === 400)

  const res = await post('/api/v1/tokens', { name: 'Nightly backup', scopes: ['artifact.read', 'workspace.read'] }, sessionJson)
  pat = (await json(res))?.data
  check('a signed-in person creates a token, shown in the response', res.status === 201 && /^art_pat_/.test(pat?.token ?? ''), JSON.stringify(pat))
  check('it defaults to a 90-day expiry', !!pat?.expiresAt && Math.abs(Date.parse(pat.expiresAt) - Date.now() - 90 * 86400e3) < 60e3)

  const row = db.sqlite.prepare('SELECT * FROM integration_grants WHERE id = ?').get(pat.id)
  check('stored as kind PAT with its name', row?.kind === 'PAT' && row?.name === 'Nightly backup')
  check('only a hash is stored, never the token', !Object.values(row).some((v) => typeof v === 'string' && v.includes(pat.token.slice(8))) &&
    row.token_hash === createHash('sha256').update(`grant:v1:${pat.token}`).digest('hex'))
  check('the visible prefix tells tokens apart (past art_pat_)', row.token_prefix.length === 14 && pat.token.startsWith(row.token_prefix))

  const list = (await json(await call('/api/v1/access', { headers: { Cookie: COOKIE } })))?.data
  const listed = list?.tokens?.find((t) => t.id === pat.id)
  check('the token is listed by name, prefix and scopes', listed?.name === 'Nightly backup' && listed?.tokenPrefix === row.token_prefix)
  check('the listing never contains the token itself', !JSON.stringify(list).includes(pat.token))
  check('OAuth sign-ins are listed per app', list?.connections?.some((c) => c.app === 'ChatGPT') && list?.connections?.some((c) => c.app === 'Claude'), JSON.stringify(list?.connections))
  check('default token scopes are read, write, share', JSON.stringify(list?.defaultTokenScopes) === '["artifact.read","artifact.write","artifact.share"]')

  const ws = await tool(pat.token, 'list_workspaces', {})
  check('the token works on MCP within its scopes', ws.isError !== true, JSON.stringify(ws).slice(0, 200))
  const save = await tool(pat.token, 'save', { title: 'x', content: 'y', format: 'md' })
  check('a scope it was not given is refused', save.isError === true)

  const viaToken = await post('/api/v1/tokens', { name: 'escalate', scopes: ['artifact.write'] }, { Authorization: `Bearer ${pat.token}` })
  check('a token cannot mint another token', viaToken.status === 400 || viaToken.status === 403, String(viaToken.status))
  const listViaToken = await call('/api/v1/access', { headers: { Authorization: `Bearer ${pat.token}` } })
  check('a token cannot list tokens', listViaToken.status === 400 || listViaToken.status === 403, String(listViaToken.status))

  pat2 = (await json(await post('/api/v1/tokens', { name: 'CI', scopes: ['artifact.read'], expiresInDays: null }, sessionJson)))?.data
  check('a token can be created with no expiry', pat2?.expiresAt === null)

  const revoke = await call(`/api/v1/tokens/${pat.id}`, { method: 'DELETE', headers: sessionJson })
  check('one token is revoked on its own', revoke.status === 200)
  const after = await mcp(pat.token, 'ping')
  check('the revoked token stops working at once', after.status === 401)
  const other = await json(await mcp(pat2.token, 'ping'))
  check('the other token keeps working', !!other?.result)
  const audit = db.sqlite.prepare("SELECT action FROM audit_events WHERE target_id = ? OR json_extract(metadata_json, '$.grantId') = ? ORDER BY occurred_at").all(pat.id, pat.id).map((r) => r.action)
  check('creating and revoking are audited', audit.includes('TOKEN_CREATE') && audit.includes('TOKEN_REVOKE'), audit.join(','))

  db.sqlite.prepare("UPDATE integration_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(pat2.id)
  const expired = await mcp(pat2.token, 'ping')
  check('an expired token is 401', expired.status === 401)
}

// ---------------------------------------------------------------
section('4. Every tool call is audited under the person')
// ---------------------------------------------------------------

{
  const p = (await json(await post('/api/v1/tokens', { name: 'Audit probe', scopes: ['workspace.read'] }, sessionJson)))?.data
  await tool(p.token, 'list_workspaces', {})
  await tool(p.token, 'search', { query: 'x' })
  const rows = db.sqlite.prepare("SELECT actor_user_id, actor_type, metadata_json FROM audit_events WHERE action = 'AI_TOOL_CALL' AND target_type = 'grant' AND target_id = ? ORDER BY occurred_at").all(p.id)
  const metas = rows.map((r) => JSON.parse(r.metadata_json))
  check('each call writes one audit row for the grant', rows.length === 2, String(rows.length))
  check('rows carry the person, actor type AI and the credential kind',
    rows.every((r) => r.actor_user_id === 'usr_a' && r.actor_type === 'AI') && metas.every((m) => m.credential === 'PAT'))
  check('a successful call is ok and a missing scope is denied',
    metas[0]?.tool === 'list_workspaces' && metas[0]?.outcome === 'ok' && metas[1]?.tool === 'search' && metas[1]?.outcome === 'denied', JSON.stringify(metas))
  check('a PAT call is attributed to the token name until a client reports one', metas[0]?.client === 'Audit probe', metas[0]?.client)

  await tool(oauthAccess, 'list_workspaces', {})
  const grantId = db.sqlite.prepare("SELECT id FROM integration_grants WHERE oauth_client_id = ? AND status = 'ACTIVE'").get(dcr.client_id).id
  const act = (await json(await call(`/api/v1/access/${grantId}/activity`, { headers: { Cookie: COOKIE } })))?.data
  check('OAuth calls are audited too and readable per connection',
    act?.activity?.length >= 1 && act.activity.some((a) => a.tool === 'list_workspaces'), JSON.stringify(act))

  const foreign = await call('/api/v1/access/grt_not_mine/activity', { headers: { Cookie: COOKIE } })
  check("another person's grant is not found", foreign.status === 404)
}

// ---------------------------------------------------------------
section('5. Existing credentials keep working')
// ---------------------------------------------------------------

{
  const legacy = (await json(await post('/api/v1/integrations/int_claude/connect', { scopes: ['artifact.read', 'workspace.read'] }, sessionJson)))?.data
  const row = db.sqlite.prepare('SELECT kind, expires_at FROM integration_grants WHERE id = ?').get(legacy.grantId)
  check('a pasted connector token is kind CONNECTOR and never expires', row?.kind === 'CONNECTOR' && row?.expires_at === null)
  const ok1 = await tool(legacy.token, 'list_workspaces', {})
  check('it works on MCP', ok1.isError !== true)

  const p = (await json(await post('/api/v1/tokens', { name: 'Survivor', scopes: ['artifact.read'] }, sessionJson)))?.data
  const claudeGrant = db.sqlite.prepare("SELECT id FROM integration_grants WHERE oauth_client_id = ? AND status = 'ACTIVE'").get(CIMD_ID)
  await post('/api/v1/integrations/int_claude/connect', { scopes: ['artifact.read'] }, sessionJson)
  await post('/api/v1/integrations/int_other/connect', { scopes: ['artifact.read'] }, sessionJson)
  const stillOauth = db.sqlite.prepare('SELECT status FROM integration_grants WHERE id = ?').get(claudeGrant.id)
  const stillPat = db.sqlite.prepare('SELECT status FROM integration_grants WHERE id = ?').get(p.id)
  const oldLegacy = db.sqlite.prepare('SELECT status FROM integration_grants WHERE id = ?').get(legacy.grantId)
  check('reconnecting a pasted token replaces only the old pasted token', oldLegacy.status === 'REVOKED')
  check('...and leaves the Claude OAuth sign-in alone', stillOauth.status === 'ACTIVE')
  check('...and leaves personal access tokens alone (both live under Other MCP client)', stillPat.status === 'ACTIVE')

  const list = (await json(await call('/api/v1/integrations', { headers: { Cookie: COOKIE } })))?.data
  const otherRow = list?.integrations?.find((i) => i.integrationId === 'int_other')
  check('a PAT never shows up as the "Other MCP client" connector', otherRow?.grantId !== p.id)

  // Migration 0013 on a database that already holds grants from 0007-0012.
  const old = new DatabaseSync(':memory:')
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()
  for (const f of files.filter((f) => f < '0013')) old.exec(readFileSync(`migrations/${f}`, 'utf8'))
  old.exec(`INSERT INTO users (id, email, email_normalized, display_name, status, created_at, updated_at) VALUES ('u','u@x','u@x','U','ACTIVE','${T}','${T}')`)
  old.exec(`INSERT INTO integration_grants (id, integration_id, user_id, scopes, token_hash, token_prefix, status, created_at) VALUES ('g_paste','int_claude','u','[]','h1','p','ACTIVE','${T}')`)
  old.exec(`INSERT INTO integration_grants (id, integration_id, user_id, scopes, token_hash, token_prefix, status, created_at, oauth_client_id, expires_at) VALUES ('g_oauth','int_claude','u','[]','h2','p','ACTIVE','${T}','oac_1','${T}')`)
  for (const f of files.filter((f) => f >= '0013')) old.exec(readFileSync(`migrations/${f}`, 'utf8'))
  const kinds = Object.fromEntries(old.prepare('SELECT id, kind FROM integration_grants').all().map((r) => [r.id, r.kind]))
  check('0013 marks existing OAuth grants OAUTH and pasted tokens CONNECTOR', kinds.g_oauth === 'OAUTH' && kinds.g_paste === 'CONNECTOR', JSON.stringify(kinds))
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
