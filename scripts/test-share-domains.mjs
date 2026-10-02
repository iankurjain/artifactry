/**
 * Custom share domains — end to end.
 *
 * Drives the REAL application (src/index.tsx) and the REAL preview Worker
 * (src/preview-worker.ts), bundled, through `app.fetch` against a real SQLite
 * built from the migration files. Outbound fetch is replaced by a fake that
 * answers DNS-over-HTTPS and the Cloudflare custom hostname API, so the whole
 * admin flow runs without a network:
 *
 *   1. availability: no config → the feature is off and nothing changes
 *   2. admin API: who may set a domain, hostname rules, DNS records shown
 *   3. verification: TXT missing → found → Cloudflare pending → active
 *   4. share links are issued on the domain (and only for that org)
 *   5. the custom hostname serves only the recipient surface, anonymously,
 *      and only that org's shares; forged edge headers are ignored
 *   6. Interactive Preview accepts the domain as framer for that org only
 *   7. hostname conflicts, removal, and fail-soft link issuing
 *   8. the share-edge Worker forwards only what it should, with proof
 *
 * Run: node scripts/test-share-domains.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
// Bundle the real app, the preview Worker and the token minting helper
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
const common = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx',
  logLevel: 'error'
}
writeFileSync('/tmp/build/sd-tokens-entry.ts', `export { mintPreviewToken } from '${process.cwd()}/src/lib/htmlpreview'\n`)
await build({ ...common, entryPoints: ['src/index.tsx'], outfile: '/tmp/build/app-sd.mjs' })
await build({ ...common, entryPoints: ['src/preview-worker.ts'], outfile: '/tmp/build/preview-sd.mjs' })
await build({ ...common, entryPoints: ['/tmp/build/sd-tokens-entry.ts'], outfile: '/tmp/build/tokens-sd.mjs' })
await build({ ...common, entryPoints: ['src/share-edge-worker.ts'], outfile: '/tmp/build/edge-sd.mjs' })
const { default: app } = await import(pathToFileURL('/tmp/build/app-sd.mjs').href)
const { default: previewApp } = await import(pathToFileURL('/tmp/build/preview-sd.mjs').href)
const { mintPreviewToken } = await import(pathToFileURL('/tmp/build/tokens-sd.mjs').href)
const { default: edgeWorker } = await import(pathToFileURL('/tmp/build/edge-sd.mjs').href)

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
    async put(key, value) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      store.set(key, bytes)
    },
    async get(key) {
      const bytes = store.get(key)
      if (!bytes) return null
      return {
        body: new Response(bytes).body,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer,
        httpMetadata: {},
        size: bytes.byteLength
      }
    },
    async head(key) {
      const bytes = store.get(key)
      return bytes ? { size: bytes.byteLength, httpMetadata: {} } : null
    },
    async delete() {}
  }
}

const db = makeDB()
const R2 = makeR2()
const T = '2026-01-01T00:00:00.000Z'
const APP = 'https://artifactry.test'
const PREVIEW = 'https://preview.artifactry.test'
const EDGE_SECRET = 'edge-secret-for-tests-0123456789'
const HOST = 'share.acme.test'

const baseEnv = {
  DB: db,
  R2,
  APP_NAME: 'artifactry',
  MAX_UPLOAD_BYTES: '5000000',
  APP_ORIGIN: APP,
  PREVIEW_ORIGIN: PREVIEW,
  PREVIEW_TOKEN_SECRET: 'preview-secret-for-tests'
}
const env = {
  ...baseEnv,
  SHARE_EDGE_SECRET: EDGE_SECRET,
  CF_API_TOKEN: 'cf-token',
  CF_ZONE_ID: 'zone123',
  SHARE_DOMAIN_CNAME_TARGET: 'shares.artifactry.test'
}

// Two organizations, an owner for each, a plain member of Acme, and a
// personal workspace for the Acme owner.
for (const [id, email] of [['usr_a', 'owner@acme.test'], ['usr_m', 'member@acme.test'], ['usr_b', 'owner@beta.test']]) {
  db.insert('users', { id, email, email_normalized: email, display_name: id, status: 'ACTIVE', created_at: T, updated_at: T })
}
for (const [id, name, owner] of [['org_a', 'Acme', 'usr_a'], ['org_b', 'Beta', 'usr_b']]) {
  db.insert('organizations', {
    id, name, slug: name.toLowerCase(), plan: 'FREE', max_upload_bytes: 5000000,
    settings_json: '{}', status: 'ACTIVE', created_by: owner, created_at: T, updated_at: T
  })
  db.insert('workspaces', {
    id: `ws_${id}`, organization_id: id, owner_user_id: owner, workspace_type: 'ORGANIZATION',
    name, description: null, created_at: T, created_by: owner, archived_at: null
  })
}
// A second Acme workspace without a domain: same org, different links.
db.insert('workspaces', {
  id: 'ws_org_a2', organization_id: 'org_a', owner_user_id: 'usr_a', workspace_type: 'ORGANIZATION',
  name: 'Acme Internal', description: null, created_at: T, created_by: 'usr_a', archived_at: null
})
db.insert('workspaces', {
  id: 'ws_personal', organization_id: null, owner_user_id: 'usr_a', workspace_type: 'PERSONAL',
  name: 'My Files', description: null, created_at: T, created_by: 'usr_a', archived_at: null
})
for (const [id, org, user, role] of [
  ['om_a', 'org_a', 'usr_a', 'ORG_OWNER'],
  ['om_m', 'org_a', 'usr_m', 'MEMBER'],
  ['om_b', 'org_b', 'usr_b', 'ORG_OWNER']
]) {
  db.insert('organization_members', { id, organization_id: org, user_id: user, role, created_at: T, created_by: user, status: 'ACTIVE' })
}

const cookies = {}
for (const user of ['usr_a', 'usr_m', 'usr_b']) {
  const token = `session-${user}`
  db.insert('auth_sessions', {
    id: `ses_${user}`, user_id: user,
    token_hash: createHash('sha256').update(`session:v1:${token}`).digest('hex'),
    created_at: T, expires_at: '2099-01-01T00:00:00.000Z', last_seen_at: T, revoked_at: null, user_agent: null
  })
  cookies[user] = `al_session=${token}`
}

function addArtifact({ id, workspaceId, orgId, html = false, interactive = false }) {
  const mime = html ? 'text/html' : 'text/plain'
  const ext = html ? 'html' : 'txt'
  const body = html ? '<!doctype html><h1>Hello</h1><script>1</script>' : 'hello world'
  db.insert('artifacts', {
    id, organization_id: orgId, workspace_id: workspaceId, owner_user_id: orgId === 'org_b' ? 'usr_b' : 'usr_a',
    title: id, description: null, canonical_slug: id, filename: `${id}.${ext}`, extension: ext,
    mime_type: mime, size_bytes: body.length, checksum: 'x', current_version_id: `${id}_v1`, version_count: 1,
    source_type: 'UPLOAD', source_provider: null, status: 'READY', status_detail: null, metadata_json: '{}',
    created_at: T, updated_at: T, deleted_at: null, interactive_html: interactive ? 1 : 0
  })
  db.insert('artifact_versions', {
    id: `${id}_v1`, artifact_id: id, version_number: 1, r2_object_key: `k/${id}`, filename: `${id}.${ext}`,
    mime_type: mime, extension: ext, size_bytes: body.length, checksum: 'x', source_type: 'UPLOAD',
    source_provider: null, change_summary: null, extracted_text: body, created_by_user_id: 'usr_a',
    created_at: T, deleted_at: null
  })
  R2.store.set(`k/${id}`, new TextEncoder().encode(body))
}
addArtifact({ id: 'art_a', workspaceId: 'ws_org_a', orgId: 'org_a' })
addArtifact({ id: 'art_a_html', workspaceId: 'ws_org_a', orgId: 'org_a', html: true, interactive: true })
addArtifact({ id: 'art_p', workspaceId: 'ws_personal', orgId: null })
addArtifact({ id: 'art_a2', workspaceId: 'ws_org_a2', orgId: 'org_a' })
addArtifact({ id: 'art_b', workspaceId: 'ws_org_b', orgId: 'org_b' })
addArtifact({ id: 'art_b_html', workspaceId: 'ws_org_b', orgId: 'org_b', html: true, interactive: true })

// ---------------------------------------------------------------
// Fake network: DNS over HTTPS and the Cloudflare custom hostname API
// ---------------------------------------------------------------

const dns = new Map() // name -> [txt values]
const cf = { hostnames: new Map(), seq: 0, calls: [] }
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const method = (init.method || 'GET').toUpperCase()
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.hostname === 'cloudflare-dns.com') {
    const name = url.searchParams.get('name')
    return json({ Status: 0, Answer: (dns.get(name) ?? []).map((v) => ({ name, type: 16, data: `"${v}"` })) })
  }
  if (url.hostname === 'api.cloudflare.com') {
    cf.calls.push(`${method} ${url.pathname}${url.search}`)
    if (init.headers?.Authorization !== 'Bearer cf-token') return json({ success: false, errors: [{ code: 10000, message: 'auth' }] }, 403)
    const id = url.pathname.split('/custom_hostnames')[1]?.replace(/^\//, '')
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      if ([...cf.hostnames.values()].some((h) => h.hostname === body.hostname)) {
        return json({ success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }] }, 409)
      }
      const h = { id: `ch_${++cf.seq}`, hostname: body.hostname, status: 'pending', ssl: { status: 'initializing' } }
      cf.hostnames.set(h.id, h)
      return json({ success: true, result: h })
    }
    if (method === 'GET' && !id) {
      const hn = url.searchParams.get('hostname')
      return json({ success: true, result: [...cf.hostnames.values()].filter((h) => h.hostname === hn) })
    }
    if (method === 'GET') {
      const h = cf.hostnames.get(id)
      return h ? json({ success: true, result: h }) : json({ success: false, errors: [{ code: 1436, message: 'not found' }] }, 404)
    }
    if (method === 'DELETE') {
      cf.hostnames.delete(id)
      return json({ success: true, result: { id } })
    }
  }
  return realFetch(input, init)
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const ctx = { waitUntil() {}, passThroughOnException() {} }
async function call(path, { user, body, method, headers = {}, useEnv = env } = {}) {
  const init = { method: method ?? (body ? 'POST' : 'GET'), headers: { ...headers } }
  if (user) init.headers.Cookie = cookies[user]
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return app.fetch(new Request(`${APP}${path}`, init), useEnv, ctx)
}
/** A request as the share-edge Worker forwards it for `host`. */
async function onDomain(path, { host = HOST, secret = EDGE_SECRET, ip = '203.0.113.7', method, body, headers = {}, useEnv = env } = {}) {
  return call(path, {
    method,
    body,
    useEnv,
    headers: {
      'X-Artifactry-Share-Host': host,
      'X-Artifactry-Client-IP': ip,
      ...(secret ? { 'X-Artifactry-Edge-Auth': secret } : {}),
      ...headers
    }
  })
}
const data = async (res) => (await res.json().catch(() => null))?.data ?? null
const domainRow = (org) => db.sqlite.prepare('SELECT * FROM workspace_share_domains WHERE workspace_id = ?').get(org)
async function share(user, targetId, extra = {}) {
  const res = await call('/api/v1/shares', { user, body: { targetType: 'ARTIFACT', targetId, accessType: 'PUBLIC_LINK', ...extra } })
  return data(res)
}

// ---------------------------------------------------------------
section('1. Off unless configured')
// ---------------------------------------------------------------

{
  const got = await data(await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_a', useEnv: baseEnv }))
  check('GET reports the feature unavailable', got?.available === false && got?.domain === null, JSON.stringify(got))
  const put = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_a', method: 'PUT', body: { hostname: HOST }, useEnv: baseEnv })
  check('PUT is refused with 503', put.status === 503, String(put.status))
  const s = await share('usr_a', 'art_a')
  check('share links stay on the app origin', s?.url?.startsWith(`${APP}/s/`), s?.url)
  const forged = await onDomain(`/s/${s.token}`, { useEnv: baseEnv })
  check('edge headers mean nothing without SHARE_EDGE_SECRET (normal app request)', forged.status === 200)
}

// ---------------------------------------------------------------
section('2. Admin API')
// ---------------------------------------------------------------

{
  const member = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_m' })
  check('a member who is not a workspace admin is refused', member.status === 403, String(member.status))
  const other = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_b' })
  check('another org\'s owner is refused', other.status === 403, String(other.status))
  const personalPut = await call('/api/v1/workspaces/ws_personal/share-domain', { user: 'usr_a', method: 'PUT', body: { hostname: 'me.acme.test' } })
  check('a personal workspace cannot have a domain', personalPut.status === 400, String(personalPut.status))
  const personalGet = await data(await call('/api/v1/workspaces/ws_personal/share-domain', { user: 'usr_a' }))
  check('a personal workspace reports not eligible', personalGet?.eligible === false, JSON.stringify(personalGet))
  const anon = await call('/api/v1/workspaces/ws_org_a/share-domain')
  check('signed out gets 401', anon.status === 401, String(anon.status))

  for (const [bad, why] of [
    ['localhost', 'single label'],
    ['10.0.0.1', 'IP literal'],
    ['share.artifactry.test', 'app domain'],
    ['x.preview.artifactry.test', 'preview domain'],
    ['acme.pages.dev', 'pages.dev'],
    ['share.acme.test:8443', 'port'],
    ['sh@re.acme.test', 'bad characters']
  ]) {
    const res = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_a', method: 'PUT', body: { hostname: bad } })
    check(`rejects ${bad} (${why})`, res.status === 400, String(res.status))
  }

  const res = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_a', method: 'PUT', body: { hostname: 'HTTPS://Share.Acme.test./' } })
  const got = await data(res)
  check('PUT normalizes the hostname and returns 201', res.status === 201 && got?.domain?.hostname === HOST, JSON.stringify(got))
  check('starts in PENDING_DNS', got?.domain?.status === 'PENDING_DNS')
  const cname = got?.domain?.records?.find((r) => r.type === 'CNAME')
  const txt = got?.domain?.records?.find((r) => r.type === 'TXT')
  check('shows the CNAME record', cname?.name === HOST && cname?.value === 'shares.artifactry.test', JSON.stringify(cname))
  check('shows the TXT challenge', txt?.name === `_artifactry-challenge.${HOST}` && /^artifactry-verify=.{20,}$/.test(txt?.value ?? ''), JSON.stringify(txt))
  check('audit records the claim', !!db.sqlite.prepare(`SELECT 1 FROM audit_events WHERE action = 'SHARE_DOMAIN_SET' AND organization_id = 'org_a'`).get())

  const s = await share('usr_a', 'art_a')
  check('a pending domain does not change share links', s?.url?.startsWith(`${APP}/s/`), s?.url)
  const served = await onDomain(`/s/${s.token}`)
  check('a pending domain serves nothing', served.status === 404, String(served.status))
}

// ---------------------------------------------------------------
section('3. Verification and activation')
// ---------------------------------------------------------------

{
  const checkNow = () => call('/api/v1/workspaces/ws_org_a/share-domain/check', { user: 'usr_a', method: 'POST' })

  let got = await data(await checkNow())
  check('no TXT record: stays PENDING_DNS with a reason', got?.domain?.status === 'PENDING_DNS' && /TXT record/.test(got?.domain?.lastError ?? ''), JSON.stringify(got?.domain))
  check('no Cloudflare call before ownership is proven', cf.calls.length === 0, cf.calls.join(', '))

  dns.set(`_artifactry-challenge.${HOST}`, ['some-other=value'])
  got = await data(await checkNow())
  check('a wrong TXT value does not verify', got?.domain?.status === 'PENDING_DNS')

  const txt = got.domain.records.find((r) => r.type === 'TXT').value
  dns.set(`_artifactry-challenge.${HOST}`, ['some-other=value', txt])
  got = await data(await checkNow())
  check('TXT found: moves to PENDING_CERT', got?.domain?.status === 'PENDING_CERT', JSON.stringify(got?.domain))
  check('registered with Cloudflare for SaaS', cf.hostnames.size === 1 && [...cf.hostnames.values()][0].hostname === HOST)
  check('verifiedAt is set', !!got?.domain?.verifiedAt)
  check('reports what Cloudflare is waiting on', /pending/.test(got?.domain?.lastError ?? ''), got?.domain?.lastError)

  const s = await share('usr_a', 'art_a')
  check('links stay on the app origin until the certificate is active', s?.url?.startsWith(`${APP}/s/`), s?.url)

  const h = [...cf.hostnames.values()][0]
  h.status = 'active'
  h.ssl.status = 'active'
  got = await data(await checkNow())
  check('Cloudflare active: domain is ACTIVE', got?.domain?.status === 'ACTIVE' && got?.domain?.url === `https://${HOST}`, JSON.stringify(got?.domain))
  check('audit records activation once', db.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'SHARE_DOMAIN_ACTIVATED'`).get().n === 1)
  await checkNow()
  check('a second check does not re-record activation', db.sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'SHARE_DOMAIN_ACTIVATED'`).get().n === 1)
}

// ---------------------------------------------------------------
section('4. Share links use the domain')
// ---------------------------------------------------------------

let acmeToken
let acmeHtmlToken
let personalToken
let siblingToken
let betaToken
{
  const s = await share('usr_a', 'art_a')
  check('Acme share link is on the custom domain', s?.url === `https://${HOST}/s/${s?.token}`, s?.url)
  acmeToken = s.token
  acmeHtmlToken = (await share('usr_a', 'art_a_html')).token

  const p = await share('usr_a', 'art_p')
  check('a personal-workspace share stays on the app origin', p?.url?.startsWith(`${APP}/s/`), p?.url)
  personalToken = p.token

  const b = await share('usr_b', 'art_b')
  check('another organization\'s links stay on the app origin', b?.url?.startsWith(`${APP}/s/`), b?.url)
  betaToken = b.token

  const sibling = await share('usr_a', 'art_a2')
  check('another workspace in the same org stays on the app origin', sibling?.url?.startsWith(`${APP}/s/`), sibling?.url)
  siblingToken = sibling.token

  const list = await data(await call('/api/v1/shares', { user: 'usr_a' }))
  const acmeRow = list?.shares?.find((r) => r.targetId === 'art_a')
  const personalRow = list?.shares?.find((r) => r.targetId === 'art_p')
  check('share list shows Acme links on the domain', acmeRow?.urlPrefix?.startsWith(`https://${HOST}/s/`), acmeRow?.urlPrefix)
  check('share list shows personal links on the app origin', personalRow?.urlPrefix?.startsWith(`${APP}/s/`), personalRow?.urlPrefix)

  const legacy = await call(`/s/${acmeToken}`)
  check('the same token still opens on the app origin', legacy.status === 200)
}

// ---------------------------------------------------------------
section('5. The custom hostname serves only the recipient surface')
// ---------------------------------------------------------------

{
  const page = await onDomain(`/s/${acmeToken}`)
  const html = await page.text()
  check('/s/:token renders the recipient page', page.status === 200 && html.includes('boot-data'), String(page.status))
  check('HSTS on the customer host does not claim its subdomains', page.headers.get('Strict-Transport-Security') === 'max-age=31536000', page.headers.get('Strict-Transport-Security'))

  const meta = await data(await onDomain(`/api/v1/shares/${acmeToken}/meta`))
  check('share meta works', meta?.exists === true, JSON.stringify(meta))
  const view = await data(await onDomain(`/api/v1/shares/${acmeToken}/view`))
  check('share view works and hands back URLs on the custom domain',
    view?.accessible === true && view?.view?.contentUrl === `https://${HOST}/api/v1/shares/${acmeToken}/content`, JSON.stringify(view?.view?.contentUrl))
  const content = await onDomain(`/api/v1/shares/${acmeToken}/content`)
  check('content downloads', content.status === 200 && (await content.text()) === 'hello world')
  const guide = await onDomain('/guide')
  check('the public guide linked from the page footer is served', guide.status === 200)

  for (const [path, opts] of [
    ['/', {}],
    ['/library', {}],
    ['/admin', {}],
    ['/a/art_a', {}],
    ['/api/v1/auth/me', {}],
    ['/api/v1/shares', {}],
    ['/api/v1/shares', { method: 'POST', body: { targetId: 'art_a' } }],
    ['/api/v1/artifacts', {}],
    ['/api/v1/mcp', { method: 'POST', body: {} }],
    ['/oauth/authorize', {}],
    ['/.well-known/oauth-authorization-server', {}],
    ['/api/v1/workspaces/ws_org_a/share-domain', {}],
    [`/api/v1/shares/${acmeToken}/view`, { method: 'POST', body: {} }]
  ]) {
    const res = await onDomain(path, opts)
    check(`${opts.method ?? 'GET'} ${path} is 404 on the custom host`, res.status === 404, String(res.status))
  }

  // A signed-in session must be invisible on the customer's host.
  const withSession = await onDomain(`/s/${acmeToken}`, { headers: { Cookie: cookies.usr_a } })
  const boot = JSON.parse(/<script id="boot-data" type="application\/json">([\s\S]*?)<\/script>/.exec(await withSession.text())?.[1] ?? '{}')
  check('a session cookie is never resolved on the custom host', boot.authenticated === false, JSON.stringify(boot))

  const other = await data(await onDomain(`/api/v1/shares/${betaToken}/meta`))
  check('another org\'s share does not exist on this host', other?.exists === false, JSON.stringify(other))
  const otherView = await onDomain(`/api/v1/shares/${betaToken}/content`)
  check('another org\'s content is 404 on this host', otherView.status === 404, String(otherView.status))
  const sib = await data(await onDomain(`/api/v1/shares/${siblingToken}/meta`))
  check('a share from a sibling workspace of the same org does not exist on this host', sib?.exists === false, JSON.stringify(sib))
  const personal = await data(await onDomain(`/api/v1/shares/${personalToken}/meta`))
  check('a personal share does not exist on this host', personal?.exists === false)
  const viewer = await onDomain(`/s/${betaToken}/artifact/art_b`)
  check('another org\'s viewer page says the link is not valid', /Link not valid/.test(await viewer.text()))

  const wrongSecret = await onDomain(`/library`, { secret: 'not-the-secret' })
  check('a wrong edge secret is an ordinary app request (not trusted)', wrongSecret.status === 200)
  const unknownHost = await onDomain(`/s/${acmeToken}`, { host: 'evil.example.test' })
  check('a valid secret for a hostname with no ACTIVE domain is 404', unknownHost.status === 404, String(unknownHost.status))

  const rl = db.sqlite.prepare(`SELECT key FROM app_kv WHERE key LIKE 'rl:share:meta:203.0.113.7:%'`).get()
  check('rate limits key on the visitor IP the edge forwarded', !!rl)
}

// ---------------------------------------------------------------
section('6. Interactive Preview on the custom domain')
// ---------------------------------------------------------------

{
  const wrapper = await onDomain(`/s/${acmeHtmlToken}/artifact/art_a_html`)
  const html = await wrapper.text()
  const src = /<iframe[\s\S]*?src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&')
  check('the viewer frames the isolated preview origin', src?.startsWith(`${PREVIEW}/p/`), src)
  check('the wrapper CSP allows that frame', (wrapper.headers.get('Content-Security-Policy') ?? '').includes(`frame-src 'self' ${PREVIEW}`))

  const pv = await previewApp.fetch(new Request(src), env, ctx)
  check('the preview origin serves the document for the custom-domain framer', pv.status === 200, String(pv.status))
  check('frame-ancestors names the custom domain', (pv.headers.get('Content-Security-Policy') ?? '').includes(`frame-ancestors https://${HOST}`), pv.headers.get('Content-Security-Policy'))

  const viewData = await data(await onDomain(`/api/v1/shares/${acmeHtmlToken}/view`))
  check('the SPA view descriptor is minted for the custom domain too', viewData?.view?.preview?.url?.startsWith(`${PREVIEW}/p/`), JSON.stringify(viewData?.view?.preview))

  // A token naming Acme's domain as framer for another org's artifact.
  const foreign = await mintPreviewToken(env, {
    artifactId: 'art_b_html', versionId: 'art_b_html_v1', mode: 'INTERACTIVE', appOrigin: `https://${HOST}`
  })
  const refused = await previewApp.fetch(new Request(`${PREVIEW}/p/${foreign}`), env, ctx)
  check('Acme\'s domain cannot frame another org\'s artifact', refused.status === 403, String(refused.status))

  const arbitrary = await mintPreviewToken(env, {
    artifactId: 'art_a_html', versionId: 'art_a_html_v1', mode: 'INTERACTIVE', appOrigin: 'https://evil.example.test'
  })
  const refused2 = await previewApp.fetch(new Request(`${PREVIEW}/p/${arbitrary}`), env, ctx)
  check('an origin that is not an active share domain is still refused', refused2.status === 403, String(refused2.status))

  const appMinted = await mintPreviewToken(env, {
    artifactId: 'art_a_html', versionId: 'art_a_html_v1', mode: 'INTERACTIVE', appOrigin: APP
  })
  const okApp = await previewApp.fetch(new Request(`${PREVIEW}/p/${appMinted}`), env, ctx)
  check('the app origin is still accepted', okApp.status === 200, String(okApp.status))
}

// ---------------------------------------------------------------
section('7. Conflicts, removal and fail-soft issuing')
// ---------------------------------------------------------------

{
  const claim = await call('/api/v1/workspaces/ws_org_b/share-domain', { user: 'usr_b', method: 'PUT', body: { hostname: HOST } })
  check('another org cannot claim a verified hostname', claim.status === 409, String(claim.status))

  // Beta claims a different name first, then both race for one unverified name.
  const raceHost = 'docs.contested.test'
  await call('/api/v1/workspaces/ws_org_b/share-domain', { user: 'usr_b', method: 'PUT', body: { hostname: raceHost } })
  const bRow = domainRow('ws_org_b')
  check('an unverified hostname can be claimed (nobody can squat a name)', bRow?.hostname === raceHost)

  // Removing a domain releases it at Cloudflare and puts links back on the app.
  const cfId = domainRow('ws_org_a').cf_custom_hostname_id
  const del = await call('/api/v1/workspaces/ws_org_a/share-domain', { user: 'usr_a', method: 'DELETE' })
  check('DELETE succeeds', del.status === 200, String(del.status))
  check('the Cloudflare hostname is removed', !cf.hostnames.has(cfId))
  check('the row is gone', !domainRow('ws_org_a'))
  const after = await share('usr_a', 'art_a')
  check('new links are back on the app origin', after?.url?.startsWith(`${APP}/s/`), after?.url)
  const gone = await onDomain(`/s/${acmeToken}`)
  check('the removed hostname serves nothing', gone.status === 404, String(gone.status))

  // Now Beta can verify the hostname Acme gave up.
  await call('/api/v1/workspaces/ws_org_b/share-domain', { user: 'usr_b', method: 'PUT', body: { hostname: HOST } })
  const bTxt = (await data(await call('/api/v1/workspaces/ws_org_b/share-domain', { user: 'usr_b' }))).domain.records.find((r) => r.type === 'TXT').value
  dns.set(`_artifactry-challenge.${HOST}`, [bTxt])
  const bCheck = await data(await call('/api/v1/workspaces/ws_org_b/share-domain/check', { user: 'usr_b', method: 'POST' }))
  check('a released hostname can be verified by its new owner', bCheck?.domain?.status === 'PENDING_CERT', JSON.stringify(bCheck?.domain))

  // Issuing must never depend on the share-domain table.
  db.exec('ALTER TABLE workspace_share_domains RENAME TO osd_hidden')
  const soft = await share('usr_b', 'art_b')
  check('sharing still works if the share-domain table is missing', soft?.url?.startsWith(`${APP}/s/`), JSON.stringify(soft))
  db.exec('ALTER TABLE osd_hidden RENAME TO workspace_share_domains')
}

// ---------------------------------------------------------------
section('8. Share-edge Worker')
// ---------------------------------------------------------------

{
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init)
    seen.push({ url: req.url, headers: Object.fromEntries(req.headers), method: req.method, redirect: init.redirect })
    return new Response('upstream', { status: 200 })
  }
  const edgeEnv = { APP_ORIGIN: APP, SHARE_EDGE_SECRET: EDGE_SECRET, PASSTHROUGH_HOSTS: 'preview.artifactry.test' }
  const edge = (url, headers = {}, method = 'GET') => edgeWorker.fetch(new Request(url, { method, headers }), edgeEnv)

  let res = await edge(`https://${HOST}/s/abc?x=1`, {
    'CF-Connecting-IP': '198.51.100.9',
    'X-Artifactry-Edge-Auth': 'forged',
    'X-Artifactry-Share-Host': 'forged.test',
    Cookie: 'al_share=1'
  })
  const fwd = seen.at(-1)
  check('forwards /s/* to the app origin, path and query intact', res.status === 200 && fwd?.url === `${APP}/s/abc?x=1`, fwd?.url)
  check('sets the visitor hostname, overriding anything the client sent', fwd?.headers['x-artifactry-share-host'] === HOST)
  check('sets the real secret, overriding a forged one', fwd?.headers['x-artifactry-edge-auth'] === EDGE_SECRET)
  check('forwards the visitor IP', fwd?.headers['x-artifactry-client-ip'] === '198.51.100.9')
  check('forwards cookies (the share grant lives on the customer host)', fwd?.headers.cookie === 'al_share=1')
  check('does not follow upstream redirects', fwd?.redirect === 'manual')

  const before = seen.length
  res = await edge(`https://${HOST}/library`)
  check('drops paths outside the recipient surface without calling the app', res.status === 404 && seen.length === before)
  res = await edge(`http://${HOST}/s/abc`)
  check('plain HTTP is redirected to HTTPS', res.status === 301 && res.headers.get('Location') === `https://${HOST}/s/abc`)

  await edge(`${APP}/library`)
  check('the app hostname passes straight through, untouched', seen.at(-1)?.url === `${APP}/library` && !seen.at(-1)?.headers['x-artifactry-edge-auth'])
  await edge(`${PREVIEW}/p/x`)
  check('listed passthrough hosts are untouched', seen.at(-1)?.url === `${PREVIEW}/p/x` && !seen.at(-1)?.headers['x-artifactry-edge-auth'])
  await edge(`https://${HOST}/.well-known/acme-challenge/tok`)
  check('certificate validation paths pass through', seen.at(-1)?.url === `https://${HOST}/.well-known/acme-challenge/tok` && !seen.at(-1)?.headers['x-artifactry-edge-auth'])
}

globalThis.fetch = realFetch
console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('FAILED')
  process.exit(1)
}
console.log('ALL SHARE DOMAIN CHECKS PASSED')
