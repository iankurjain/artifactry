/**
 * OAuth connector sign-in + MCP transport + save sources — end to end.
 *
 * Drives the REAL application (src/index.tsx, bundled) through `app.fetch`
 * against a real SQLite built from the actual migration files, with an
 * in-memory R2. Nothing is mocked above the storage bindings except outbound
 * fetch for source_url / file_ref downloads.
 *
 * It walks the exact sequence a hosted AI app (ChatGPT, Claude, Copilot
 * Studio, Gemini Enterprise) performs:
 *
 *   1. unauthenticated MCP call → 401 + WWW-Authenticate → metadata discovery
 *   2. dynamic client registration
 *   3. authorize: sign-in page, consent page, approve → code
 *   4. token exchange with PKCE, then MCP calls with the access token
 *   5. expiry → 401 invalid_token → refresh (rotation) → calls resume
 *   6. disconnect in Settings → refresh fails
 *
 * plus a manually created confidential client (client id + secret), the
 * streamable-HTTP transport details, every save source, and large files sent
 * in parts (upload_part) or in one PUT.
 *
 * Run: node scripts/test-oauth.mjs
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
  outfile: '/tmp/build/app-oauth.mjs',
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
const { default: app } = await import(pathToFileURL('/tmp/build/app-oauth.mjs').href)

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

const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'

// ---------------------------------------------------------------
section('1. Discovery starts from a 401')
// ---------------------------------------------------------------

{
  const res = await mcp(null, 'initialize', { protocolVersion: '2025-06-18' })
  check('unauthenticated MCP call is 401', res.status === 401, String(res.status))
  const header = res.headers.get('WWW-Authenticate') ?? ''
  check('401 carries WWW-Authenticate with resource_metadata',
    header.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp"`), header)

  const bad = await mcp('not-a-real-token', 'ping')
  check('an invalid token is 401 with error="invalid_token"',
    bad.status === 401 && /invalid_token/.test(bad.headers.get('WWW-Authenticate') ?? ''),
    `${bad.status} ${bad.headers.get('WWW-Authenticate')}`)

  const prm = await json(await call('/.well-known/oauth-protected-resource/api/v1/mcp'))
  check('protected resource metadata names the MCP URL exactly', prm?.resource === `${ORIGIN}/api/v1/mcp`, JSON.stringify(prm))
  check('it names this origin as the authorization server', prm?.authorization_servers?.[0] === ORIGIN)
  const prmRoot = await call('/.well-known/oauth-protected-resource')
  check('the root-level metadata path works too', prmRoot.status === 200)

  const asm = await json(await call('/.well-known/oauth-authorization-server'))
  check('authorization server metadata advertises DCR, PKCE S256 and both grants',
    asm?.registration_endpoint === `${ORIGIN}/oauth/register` &&
      asm?.code_challenge_methods_supported?.includes('S256') &&
      asm?.grant_types_supported?.includes('refresh_token') &&
      asm?.token_endpoint_auth_methods_supported?.includes('none'),
    JSON.stringify(asm))
}

// ---------------------------------------------------------------
section('2. Dynamic client registration')
// ---------------------------------------------------------------

let chatgptClient
{
  const res = await call('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none'
    })
  })
  chatgptClient = await json(res)
  check('registration returns 201 with a client_id', res.status === 201 && /^oac_/.test(chatgptClient?.client_id ?? ''), JSON.stringify(chatgptClient))
  check('a self-registered client is public (no secret)', chatgptClient?.token_endpoint_auth_method === 'none' && !chatgptClient?.client_secret)
  const row = db.sqlite.prepare('SELECT integration_id FROM oauth_clients WHERE id = ?').get(chatgptClient.client_id)
  check('the ChatGPT callback host maps the client to the ChatGPT connector', row?.integration_id === 'int_chatgpt', row?.integration_id)

  const reject = await call('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example.com/cb'] })
  })
  check('a plain-http non-loopback redirect is refused', reject.status === 400)

  for (const [name, uri, expected] of [
    ['Claude', 'https://claude.ai/api/mcp/auth_callback', 'int_claude'],
    ['Claude Code', 'http://localhost/callback', 'int_claude'],
    ['Copilot Studio', 'https://global.consent.azure-apim.net/redirect/abc', 'int_copilot'],
    ['Gemini CLI', 'http://localhost:7777/oauth/callback', 'int_gemini'],
    ['Cursor', 'http://127.0.0.1/cb', 'int_other']
  ]) {
    const r = await json(await call('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [uri] })
    }))
    const got = db.sqlite.prepare('SELECT integration_id FROM oauth_clients WHERE id = ?').get(r?.client_id)
    check(`${name} is attributed to ${expected}`, got?.integration_id === expected, got?.integration_id)
  }
}

// ---------------------------------------------------------------
section('3. Authorize: sign-in, consent, approve')
// ---------------------------------------------------------------

function authorizeQuery(extra = {}) {
  return form({
    response_type: 'code',
    client_id: chatgptClient.client_id,
    redirect_uri: CHATGPT_REDIRECT,
    state: 'st-123',
    scope: 'artifact.read artifact.write artifact.share offline_access',
    resource: `${ORIGIN}/api/v1/mcp`,
    code_challenge_method: 'S256',
    ...extra
  }).toString()
}

let code
const main = pkce()
{
  const signedOut = await call(`/oauth/authorize?${authorizeQuery({ code_challenge: main.challenge })}`)
  const html = await signedOut.text()
  check('signed out: a sign-in page, not a redirect', signedOut.status === 200 && /Email me a code/.test(html))
  const csp = signedOut.headers.get('Content-Security-Policy') ?? ''
  check('the page carries a nonce-only script CSP and forbids framing',
    /script-src 'nonce-/.test(csp) && /frame-ancestors 'none'/.test(csp), csp)

  const consent = await call(`/oauth/authorize?${authorizeQuery({ code_challenge: main.challenge })}`, {
    headers: { Cookie: COOKIE }
  })
  const consentHtml = await consent.text()
  check('signed in: a consent page naming the app and the user',
    consent.status === 200 && /Connect ChatGPT to Artifactry/.test(consentHtml) && consentHtml.includes('ankur@example.com'))
  check('consent lists exactly the requested known scopes (offline_access dropped)',
    /Search and read/.test(consentHtml) && /Save new artifacts/.test(consentHtml) && !/List your teams/.test(consentHtml))
  check('form-action allows the redirect back to the app',
    (consent.headers.get('Content-Security-Policy') ?? '').includes('https://chatgpt.com'))

  const noPkce = await call(`/oauth/authorize?${authorizeQuery({ code_challenge_method: undefined })}`, {
    headers: { Cookie: COOKIE }
  })
  const loc = noPkce.headers.get('Location') ?? ''
  check('a public client without PKCE is sent back with invalid_request',
    noPkce.status === 302 && loc.startsWith(CHATGPT_REDIRECT) && /error=invalid_request/.test(loc), loc)

  const wrongRedirect = await call(
    `/oauth/authorize?${authorizeQuery({ code_challenge: main.challenge, redirect_uri: 'https://attacker.example/cb' })}`,
    { headers: { Cookie: COOKIE } }
  )
  check('an unregistered redirect_uri is never redirected to',
    wrongRedirect.status === 400 && !wrongRedirect.headers.get('Location'))

  const crossSite = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: COOKIE, Origin: 'https://attacker.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${authorizeQuery({ code_challenge: main.challenge })}&decision=approve`
  })
  check('a cross-origin approval POST is refused', crossSite.status === 403)

  const noSession = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${authorizeQuery({ code_challenge: main.challenge })}&decision=approve`
  })
  check('an approval POST without a session issues no code', !(noSession.headers.get('Location') ?? '').includes('code='))

  const deny = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: COOKIE, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${authorizeQuery({ code_challenge: main.challenge })}&decision=deny`
  })
  check('Cancel returns access_denied with the state',
    /error=access_denied/.test(deny.headers.get('Location') ?? '') && /state=st-123/.test(deny.headers.get('Location') ?? ''))

  const approve = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: COOKIE, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${authorizeQuery({ code_challenge: main.challenge })}&decision=approve`
  })
  const back = new URL(approve.headers.get('Location') ?? 'https://x')
  code = back.searchParams.get('code')
  check('Allow redirects back with code, state and iss',
    approve.status === 302 && back.origin + back.pathname === CHATGPT_REDIRECT && !!code &&
      back.searchParams.get('state') === 'st-123' && back.searchParams.get('iss') === ORIGIN,
    approve.headers.get('Location'))
}

// ---------------------------------------------------------------
section('4. Token exchange')
// ---------------------------------------------------------------

let tokens
{
  // A second code, burned by a wrong verifier, proves PKCE is enforced.
  const other = pkce()
  const r = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: COOKIE, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${authorizeQuery({ code_challenge: other.challenge })}&decision=approve`
  })
  const otherCode = new URL(r.headers.get('Location')).searchParams.get('code')
  const wrong = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code: otherCode, client_id: chatgptClient.client_id,
      redirect_uri: CHATGPT_REDIRECT, code_verifier: main.verifier })
  })
  const wrongBody = await json(wrong)
  check('a wrong PKCE verifier is invalid_grant', wrong.status === 400 && wrongBody?.error === 'invalid_grant', JSON.stringify(wrongBody))

  const res = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, client_id: chatgptClient.client_id,
      redirect_uri: CHATGPT_REDIRECT, code_verifier: main.verifier })
  })
  tokens = await json(res)
  check('the code exchanges for access + refresh tokens',
    res.status === 200 && tokens?.token_type === 'Bearer' && tokens?.access_token && tokens?.refresh_token && tokens?.expires_in === 3600,
    JSON.stringify(tokens))
  check('the granted scope is what the user approved', tokens?.scope === 'artifact.read artifact.write artifact.share', tokens?.scope)
  check('token responses are not cacheable', res.headers.get('Cache-Control') === 'no-store')

  const replay = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, client_id: chatgptClient.client_id,
      redirect_uri: CHATGPT_REDIRECT, code_verifier: main.verifier })
  })
  check('a code cannot be used twice', replay.status === 400)

  const grant = db.sqlite.prepare("SELECT integration_id, oauth_client_id, expires_at FROM integration_grants WHERE oauth_client_id = ? AND status = 'ACTIVE'").get(chatgptClient.client_id)
  check('the OAuth grant is an ordinary ChatGPT connector grant with an expiry',
    grant?.integration_id === 'int_chatgpt' && !!grant?.expires_at, JSON.stringify(grant))
}

// ---------------------------------------------------------------
section('5. MCP with the OAuth token')
// ---------------------------------------------------------------

const token = () => tokens.access_token
{
  const init = await json(await mcp(token(), 'initialize', {
    protocolVersion: '2025-11-25', clientInfo: { name: 'openai-mcp', version: '1.0.0' }
  }))
  check('initialize succeeds and echoes a supported protocol version',
    init?.result?.protocolVersion === '2025-11-25', JSON.stringify(init?.result?.protocolVersion))

  const note = await mcp(token(), 'notifications/initialized', undefined, { notification: true })
  check('a notification gets 202 with no body', note.status === 202 && (await note.text()) === '')

  const sse = await call('/api/v1/mcp', { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token()}` } })
  check('GET asking for an SSE stream is 405 (no server push)', sse.status === 405)

  const list = await json(await mcp(token(), 'tools/list'))
  const byName = Object.fromEntries((list?.result?.tools ?? []).map((t) => [t.name, t]))
  check('search is annotated read-only', byName.search?.annotations?.readOnlyHint === true)
  check('save declares file_ref as a ChatGPT file parameter',
    JSON.stringify(byName.save?._meta?.['openai/fileParams']) === '["file_ref"]')
  for (const name of ['save', 'create_version']) {
    const ref = byName[name]?.inputSchema?.properties?.file_ref
    check(`${name} file_ref follows OpenAI's file schema (download_url and file_id required)`,
      JSON.stringify([...(ref?.required ?? [])].sort()) === '["download_url","file_id"]')
  }
  check('revoke_share is annotated destructive', byName.revoke_share?.annotations?.destructiveHint === true)
  check('save and create_version are annotated open-world (they fetch source_url / file_ref)',
    byName.save?.annotations?.openWorldHint === true && byName.create_version?.annotations?.openWorldHint === true)
  check('upload_part is annotated destructive', byName.upload_part?.annotations?.destructiveHint === true)

  const narrow = await tool(token(), 'list_teams', {})
  check('a tool outside the approved scopes is refused', !!narrow.error || narrow.isError === true)
}

// ---------------------------------------------------------------
section('6. Save: every source')
// ---------------------------------------------------------------

function storedBytesFor(artifactId) {
  const v = db.sqlite.prepare(
    'SELECT v.r2_object_key AS k FROM artifacts a JOIN artifact_versions v ON v.id = a.current_version_id WHERE a.id = ?'
  ).get(artifactId)
  return v ? R2.store.get(v.k)?.bytes : null
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Launch plan</title>
<style>body{font-family:sans-serif}</style></head>
<body><h1>Launch plan</h1><p>Q4 launch plan for the Aurora campaign.</p>
<script>document.querySelector('h1').textContent += ' ✓'</script></body></html>`

let htmlArtifactId
{
  const r = await tool(token(), 'save', { file: 'launch-plan.html', content: HTML_PAGE, title: 'Launch plan', tags: ['Aurora'] })
  htmlArtifactId = r.structuredContent?.artifact_id
  check('an HTML page passed as content with a .html file saves', r.isError === false && !!htmlArtifactId, r.content?.[0]?.text)
  const bytes = storedBytesFor(htmlArtifactId)
  check('the stored bytes are the page exactly as written (not escaped)',
    bytes && new TextDecoder().decode(bytes) === HTML_PAGE)
  check('the canonical URL uses the real origin (known issue 4 fixed)',
    r.structuredContent?.canonical_url === `${ORIGIN}/a/${htmlArtifactId}`, r.structuredContent?.canonical_url)
  check('an explicitly given tag is applied', (r.structuredContent?.applied_tags ?? []).includes('Aurora'),
    JSON.stringify(r.structuredContent?.applied_tags))

  const viaFormat = await tool(token(), 'save', { content: HTML_PAGE, format: 'html', title: 'Launch plan 2' })
  const b2 = storedBytesFor(viaFormat.structuredContent?.artifact_id)
  check('format "html" with a full document is also stored verbatim',
    viaFormat.isError === false && b2 && new TextDecoder().decode(b2) === HTML_PAGE, viaFormat.content?.[0]?.text)

  const prose = await tool(token(), 'save', { content: 'Just some notes about <b>tags</b>.', format: 'html', title: 'Notes' })
  const b3 = storedBytesFor(prose.structuredContent?.artifact_id)
  check('plain text with format "html" still goes through the document template (escaped)',
    prose.isError === false && b3 && new TextDecoder().decode(b3).includes('&lt;b&gt;tags&lt;/b&gt;'))

  const empty = await tool(token(), 'save', { title: 'nothing' })
  check('save with no source explains the options', empty.isError === true && /file_ref/.test(empty.content?.[0]?.text ?? ''))
}

{
  // Outbound downloads: file_ref (as ChatGPT sends it) and source_url.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 13, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0])
  const realFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    fetched.push(url)
    if (url === 'https://files.oaiusercontent.com/file-abc?sig=1') {
      return new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) } })
    }
    if (url === 'https://cdn.example.com/reports/q3.pdf') return new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } })
    if (url === 'https://cdn.example.com/img/hero') return new Response(WEBP, { headers: { 'Content-Type': 'image/webp' } })
    if (url === 'https://cdn.example.com/huge.pdf') {
      const big = new Uint8Array(6_000_000)
      return new Response(big, { headers: { 'Content-Type': 'application/pdf' } })
    }
    return realFetch(input, init)
  }
  try {
    const viaRef = await tool(token(), 'save', {
      file_ref: { download_url: 'https://files.oaiusercontent.com/file-abc?sig=1', file_id: 'file-abc', file_name: 'chart.png', mime_type: 'image/png' },
      title: 'Revenue chart'
    })
    const refBytes = storedBytesFor(viaRef.structuredContent?.artifact_id)
    check('a ChatGPT file_ref is downloaded and saved as the real file',
      viaRef.isError === false && refBytes?.length === PNG.length, viaRef.content?.[0]?.text)

    const viaUrl = await tool(token(), 'save', { source_url: 'https://cdn.example.com/reports/q3.pdf' })
    check('a public source_url saves, named from the URL',
      viaUrl.isError === false && /q3/i.test(viaUrl.structuredContent?.title ?? ''), viaUrl.content?.[0]?.text)

    const noExt = await tool(token(), 'save', { source_url: 'https://cdn.example.com/img/hero', title: 'Hero' })
    const noExtRow = db.sqlite.prepare('SELECT extension FROM artifacts WHERE id = ?').get(noExt.structuredContent?.artifact_id)
    check('a URL without an extension takes it from Content-Type (webp)', noExt.isError === false && noExtRow?.extension === 'webp',
      `${noExt.content?.[0]?.text} ext=${noExtRow?.extension}`)

    const tooBig = await tool(token(), 'save', { source_url: 'https://cdn.example.com/huge.pdf' })
    check('a download over the size limit is refused', tooBig.isError === true && /limit/.test(tooBig.content?.[0]?.text ?? ''))

    const before = fetched.length
    for (const u of ['http://cdn.example.com/a.pdf', 'https://127.0.0.1/a.pdf', 'https://localhost/a.pdf', 'https://10.0.0.5/a.pdf', 'https://intranet/a.pdf']) {
      const r = await tool(token(), 'save', { source_url: u })
      check(`refuses to fetch ${u}`, r.isError === true)
    }
    check('no request was made for any refused URL', fetched.length === before)

    const version = await tool(token(), 'create_version', {
      artifact: htmlArtifactId, content: HTML_PAGE.replace('Q4', 'Q1'), change_summary: 'Moved to Q1'
    })
    check('create_version on an HTML artifact accepts the new page as content', version.isError === false, version.content?.[0]?.text)
    check('create_version returns an absolute canonical URL for an id reference',
      version.structuredContent?.canonical_url === `${ORIGIN}/a/${htmlArtifactId}`, version.structuredContent?.canonical_url)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------
section('6b. Large files: upload_part and the PUT link')
// ---------------------------------------------------------------

{
  const staged = () => [...R2.store.keys()].filter((k) => k.startsWith('staging/'))

  // A page far bigger than one tool call, sent in pieces split mid-tag.
  const rows = Array.from({ length: 4000 }, (_, i) => `<tr><td>Row ${i}</td><td>Aurora ✓ ${i * 7}</td></tr>`).join('\n')
  const BIG = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Big report</title></head><body><h1>Aurora big report</h1><table>${rows}</table></body></html>`
  const pieces = []
  for (let i = 0; i < BIG.length; i += 20000) pieces.push(BIG.slice(i, i + 20000))
  check('the test page needs several parts', pieces.length > 5, String(pieces.length))

  const first = await tool(token(), 'upload_part', { content: pieces[0] })
  const uploadId = first.structuredContent?.upload_id
  check('the first part opens an upload and returns its id', first.isError === false && /^upl_/.test(uploadId ?? ''), first.content?.[0]?.text)
  check('it also returns a PUT link', first.structuredContent?.put_url === `${ORIGIN}/api/v1/uploads/${uploadId}`)
  check('the upload id is not used as a storage key', staged().every((k) => !k.includes(uploadId)))

  for (let i = 1; i < pieces.length; i++) {
    const r = await tool(token(), 'upload_part', { upload_id: uploadId, content: pieces[i] })
    if (r.isError) check(`part ${i + 1} is accepted`, false, r.content?.[0]?.text)
  }
  const retry = await tool(token(), 'upload_part', { upload_id: uploadId, part: 2, content: pieces[1] })
  check('resending a part number replaces it instead of duplicating it',
    retry.isError === false && retry.structuredContent?.parts_received === pieces.length, JSON.stringify(retry.structuredContent))

  const mixed = await tool(token(), 'upload_part', { upload_id: uploadId, content_base64: 'QUJD' })
  check('mixing text and base64 parts in one upload is refused', mixed.isError === true)

  const saved = await tool(token(), 'save', { upload_id: uploadId, title: 'Big report', tags: ['Aurora'] })
  const bytes = storedBytesFor(saved.structuredContent?.artifact_id)
  check('save with upload_id stores the page reassembled exactly', saved.isError === false && bytes &&
    new TextDecoder().decode(bytes) === BIG, saved.content?.[0]?.text)
  const row = db.sqlite.prepare('SELECT extension FROM artifacts WHERE id = ?').get(saved.structuredContent?.artifact_id)
  check('an HTML upload with no file name is saved as .html', row?.extension === 'html', row?.extension)
  check('tags given with the upload are applied', (saved.structuredContent?.applied_tags ?? []).includes('Aurora'))
  check('the staged parts are deleted after saving', staged().length === 0, staged().join(','))

  const again = await tool(token(), 'save', { upload_id: uploadId })
  check('a used upload_id cannot be saved twice', again.isError === true)

  // Gaps are caught rather than saving a corrupt file.
  const g1 = await tool(token(), 'upload_part', { content: '<html><body>a' })
  await tool(token(), 'upload_part', { upload_id: g1.structuredContent.upload_id, part: 3, content: 'c</body></html>' })
  const gap = await tool(token(), 'save', { upload_id: g1.structuredContent.upload_id, file: 'gap.html' })
  check('a missing part is reported by number', gap.isError === true && /Part 2/.test(gap.content?.[0]?.text ?? ''), gap.content?.[0]?.text)

  // Binary in base64 parts.
  const PDF = new TextEncoder().encode('%PDF-1.4\n' + 'x'.repeat(3000) + '\n%%EOF\n')
  const b64 = Buffer.from(PDF).toString('base64')
  const b1 = await tool(token(), 'upload_part', { content_base64: b64.slice(0, 2000) })
  await tool(token(), 'upload_part', { upload_id: b1.structuredContent.upload_id, content_base64: b64.slice(2000) })
  const noName = await tool(token(), 'save', { upload_id: b1.structuredContent.upload_id })
  check('a binary upload without a file name asks for one', noName.isError === true && /file/.test(noName.content?.[0]?.text ?? ''))
  const pdf = await tool(token(), 'save', { upload_id: b1.structuredContent.upload_id, file: 'long.pdf', title: 'Long PDF' })
  const pdfBytes = storedBytesFor(pdf.structuredContent?.artifact_id)
  check('base64 parts reassemble into the exact binary', pdf.isError === false && pdfBytes?.length === PDF.length, pdf.content?.[0]?.text)

  // One-request upload through the link.
  const open = await tool(token(), 'upload_part', {})
  const putUrl = open.structuredContent?.put_url
  check('calling with nothing returns an empty upload and its link', open.isError === false && !!putUrl)
  const put = await call(new URL(putUrl).pathname, { method: 'PUT', body: PDF })
  check('PUT to the link accepts the whole file without a token', put.status === 200, String(put.status))
  const viaPut = await tool(token(), 'save', { upload_id: open.structuredContent.upload_id, file: 'put.pdf' })
  check('save picks up the PUT file', viaPut.isError === false && storedBytesFor(viaPut.structuredContent?.artifact_id)?.length === PDF.length,
    viaPut.content?.[0]?.text)

  const bogus = await call('/api/v1/uploads/upl_' + 'A'.repeat(32), { method: 'PUT', body: PDF })
  check('PUT to an unknown upload id is refused', bogus.status === 400, String(bogus.status))
  const forged = await tool(token(), 'save', { upload_id: 'upl_' + 'B'.repeat(32), file: 'x.pdf' })
  check('save with an unknown upload id is refused', forged.isError === true)

  const tooBig = await call(new URL((await tool(token(), 'upload_part', {})).structuredContent.put_url).pathname, {
    method: 'PUT', body: new Uint8Array(6_000_000)
  })
  check('a PUT over the size limit is refused', tooBig.status === 400, String(tooBig.status))

  const v = await tool(token(), 'upload_part', { content: BIG.replace('Aurora big', 'Aurora bigger') })
  const ver = await tool(token(), 'create_version', { artifact: saved.structuredContent.artifact_id, upload_id: v.structuredContent.upload_id })
  check('create_version accepts an upload_id too', ver.isError === false, ver.content?.[0]?.text)
}

// ---------------------------------------------------------------
section('7. Search and share')
// ---------------------------------------------------------------

{
  const s = await tool(token(), 'search', { query: 'Aurora launch' })
  const hit = (s.structuredContent?.results ?? []).find((r) => r.artifact_id === htmlArtifactId)
  check('search finds the saved page', !!hit, JSON.stringify(s.structuredContent)?.slice(0, 300))
  check('search links use the real origin, not "null"', hit?.canonical_url === `${ORIGIN}/a/${htmlArtifactId}`, hit?.canonical_url)

  const g = await tool(token(), 'get', { artifact: htmlArtifactId })
  check('get links use the real origin too', g.structuredContent?.canonical_url === `${ORIGIN}/a/${htmlArtifactId}`, g.structuredContent?.canonical_url)

  const pub = await tool(token(), 'share', { artifact: htmlArtifactId, public: true })
  check('a public share first asks for confirmation',
    pub.isError !== true && !!pub.structuredContent?.confirmation_id, JSON.stringify(pub.structuredContent)?.slice(0, 200))
  const done = await tool(token(), 'share', { artifact: htmlArtifactId, public: true, confirmation_id: pub.structuredContent?.confirmation_id })
  check('with the confirmation it returns a link', done.isError !== true && /https?:\/\//.test(JSON.stringify(done.structuredContent ?? {})),
    JSON.stringify(done.structuredContent)?.slice(0, 200))
}

// ---------------------------------------------------------------
section('8. Expiry, refresh rotation, disconnect')
// ---------------------------------------------------------------

{
  db.sqlite.prepare("UPDATE integration_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE oauth_client_id = ?").run(chatgptClient.client_id)
  const expired = await mcp(token(), 'ping')
  check('an expired access token is 401 invalid_token',
    expired.status === 401 && /invalid_token/.test(expired.headers.get('WWW-Authenticate') ?? ''))

  const oldRefresh = tokens.refresh_token
  const res = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: chatgptClient.client_id })
  })
  const next = await json(res)
  check('refresh issues a new access and refresh token',
    res.status === 200 && next?.access_token && next.access_token !== tokens.access_token && next.refresh_token !== oldRefresh,
    JSON.stringify(next))
  tokens = next
  const ping = await mcp(token(), 'ping')
  check('the refreshed token works', ping.status === 200)

  const reuse = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: chatgptClient.client_id })
  })
  check('the old refresh token no longer works (rotation)', reuse.status === 400 && (await json(reuse))?.error === 'invalid_grant')

  const wrongClient = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'oac_nope' })
  })
  check('a refresh token is bound to its client', wrongClient.status === 401 || wrongClient.status === 400)

  const grantId = db.sqlite.prepare("SELECT id FROM integration_grants WHERE oauth_client_id = ? AND status = 'ACTIVE'").get(chatgptClient.client_id)?.id
  const disc = await call(`/api/v1/integrations/grants/${grantId}`, { method: 'DELETE', headers: { Cookie: COOKIE } })
  check('Disconnect in Settings succeeds', disc.status === 200, String(disc.status))
  const after = await mcp(token(), 'ping')
  check('after disconnect the access token is rejected', after.status === 401)
  const afterRefresh = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: chatgptClient.client_id })
  })
  check('after disconnect refresh fails, so the app asks the user to sign in again', afterRefresh.status === 400)
}

// ---------------------------------------------------------------
section('9. Manual confidential client (Gemini Enterprise / Copilot Studio Manual)')
// ---------------------------------------------------------------

{
  const REDIRECT = 'https://vertexaisearch.cloud.google.com/oauth-redirect'
  const created = await call('/api/v1/integrations/oauth-clients', {
    method: 'POST',
    headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gemini Enterprise', provider: 'GEMINI', redirect_uris: [REDIRECT] })
  })
  const c = (await json(created))?.data
  check('a signed-in user can create a client id + secret', created.status === 201 && c?.client_id && c?.client_secret, JSON.stringify(c))
  check('the response includes the URLs to paste', c?.authorization_url === `${ORIGIN}/oauth/authorize` && c?.token_url === `${ORIGIN}/oauth/token`)

  const anon = await call('/api/v1/integrations/oauth-clients', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT] })
  })
  check('creating a client requires a signed-in user', anon.status === 401)

  // Confidential clients may omit PKCE; the secret is their proof.
  const approve = await call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: COOKIE, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ response_type: 'code', client_id: c.client_id, redirect_uri: REDIRECT, state: 's', decision: 'approve' })
  })
  const mcode = new URL(approve.headers.get('Location') ?? 'https://x').searchParams.get('code')
  check('a confidential client can authorize without PKCE', !!mcode, approve.headers.get('Location'))

  const bad = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.client_id}:wrong`).toString('base64')}` },
    body: form({ grant_type: 'authorization_code', code: mcode, redirect_uri: REDIRECT })
  })
  check('a wrong client secret is 401 invalid_client', bad.status === 401 && (await json(bad))?.error === 'invalid_client')

  const good = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}` },
    body: form({ grant_type: 'authorization_code', code: mcode, redirect_uri: REDIRECT })
  })
  const gt = await json(good)
  check('client_secret_basic exchanges the code', good.status === 200 && !!gt?.access_token, JSON.stringify(gt))
  check('it received the default Find/Save/Share scopes', /artifact\.write/.test(gt?.scope ?? '') && /team\.read/.test(gt?.scope ?? ''), gt?.scope)
  const who = db.sqlite.prepare("SELECT integration_id FROM integration_grants WHERE oauth_client_id = ? AND status='ACTIVE'").get(c.client_id)
  check('the grant is attributed to Gemini', who?.integration_id === 'int_gemini', who?.integration_id)
  const ok = await mcp(gt.access_token, 'tools/list')
  check('the Gemini token can call MCP', ok.status === 200)
}

// ---------------------------------------------------------------
section('10. Pasted tokens keep working')
// ---------------------------------------------------------------

{
  const res = await call('/api/v1/integrations/int_other/connect', {
    method: 'POST',
    headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes: ['artifact.read', 'artifact.write'] })
  })
  const t = (await json(res))?.data?.token
  check('the Settings token flow still issues a token', res.status === 201 && !!t)
  const r = await mcp(t, 'tools/list')
  check('a pasted token (no expiry) still calls MCP', r.status === 200)
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
