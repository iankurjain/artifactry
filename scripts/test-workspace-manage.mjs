/**
 * Workspace management and profile pictures — end to end.
 *
 * Drives the REAL application (src/index.tsx), bundled, through `app.fetch`
 * against a real SQLite built from the migration files:
 *
 *   1. settings: identity, regional, invitation controls; who may change them
 *   2. logos and profile pictures: only the 1 MB limit and the type are enforced
 *   3. custom tiers: create, assign, permissions take effect, delete falls back
 *   4. invitations: email and link, domain restriction, approval, expiry, revoke
 *   5. the directory: active, awaiting approval, invited, deactivated
 *   6. deactivation removes inherited organization visibility too
 *   7. personal workspaces: inviting converts to shared, only once confirmed
 *
 * Run: node scripts/test-workspace-manage.mjs
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
  outfile: '/tmp/build/app-wm.mjs'
})
const { default: app } = await import(pathToFileURL('/tmp/build/app-wm.mjs').href)

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
    r2.set(key, { bytes: value, type: opts.httpMetadata?.contentType })
  },
  async get(key) {
    const o = r2.get(key)
    return o ? { body: new Response(o.bytes).body, httpMetadata: { contentType: o.type }, size: o.bytes.byteLength } : null
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
const env = { DB: db, R2, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '5000000', APP_ORIGIN: APP }

// Acme: owner, an org admin, a plain org member; two outsiders with accounts.
const people = [
  ['usr_o', 'owner@acme.test'],
  ['usr_admin', 'admin@acme.test'],
  ['usr_m', 'member@acme.test'],
  ['usr_new', 'new@acme.test'],
  ['usr_x', 'someone@other.test'],
  ['usr_b', 'owner@beta.test']
]
for (const [id, email] of people) {
  insert('users', { id, email, email_normalized: email, display_name: id, status: 'ACTIVE', created_at: T, updated_at: T })
}
for (const [id, name, owner] of [['org_a', 'Acme', 'usr_o'], ['org_b', 'Beta', 'usr_b']]) {
  insert('organizations', {
    id, name, slug: name.toLowerCase(), plan: 'FREE', max_upload_bytes: 5000000,
    settings_json: '{}', status: 'ACTIVE', created_by: owner, created_at: T, updated_at: T
  })
}
insert('workspaces', {
  id: 'ws_a', organization_id: 'org_a', owner_user_id: 'usr_o', workspace_type: 'ORGANIZATION',
  name: 'Acme', description: null, created_at: T, created_by: 'usr_o', archived_at: null
})
insert('workspaces', {
  id: 'ws_b', organization_id: 'org_b', owner_user_id: 'usr_b', workspace_type: 'ORGANIZATION',
  name: 'Beta', description: null, created_at: T, created_by: 'usr_b', archived_at: null
})
insert('workspaces', {
  id: 'ws_personal', organization_id: null, owner_user_id: 'usr_o', workspace_type: 'PERSONAL',
  name: 'My Files', description: null, created_at: T, created_by: 'usr_o', archived_at: null
})
for (const [id, org, user, role] of [
  ['om_o', 'org_a', 'usr_o', 'ORG_OWNER'],
  ['om_admin', 'org_a', 'usr_admin', 'ORG_ADMIN'],
  ['om_m', 'org_a', 'usr_m', 'MEMBER'],
  ['om_b', 'org_b', 'usr_b', 'ORG_OWNER']
]) {
  insert('organization_members', { id, organization_id: org, user_id: user, role, created_at: T, created_by: user, status: 'ACTIVE' })
}
insert('workspace_members', { id: 'wsm_m', workspace_id: 'ws_a', user_id: 'usr_m', role: 'VIEWER', created_at: T, created_by: 'usr_o', status: 'ACTIVE' })

const cookies = {}
for (const [user] of people) {
  const token = `session-${user}`
  insert('auth_sessions', {
    id: `ses_${user}`, user_id: user,
    token_hash: createHash('sha256').update(`session:v1:${token}`).digest('hex'),
    created_at: T, expires_at: '2099-01-01T00:00:00.000Z', last_seen_at: T, revoked_at: null, user_agent: null
  })
  cookies[user] = `al_session=${token}`
}

const ctx = { waitUntil() {}, passThroughOnException() {} }
async function call(path, { user, body, raw, method, headers = {}, useEnv = env } = {}) {
  const init = { method: method ?? (body || raw ? 'POST' : 'GET'), headers: { ...headers } }
  if (user) init.headers.Cookie = cookies[user]
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (raw !== undefined) {
    init.headers['Content-Type'] = 'application/octet-stream'
    init.body = raw
  }
  return app.fetch(new Request(`${APP}${path}`, init), useEnv, ctx)
}
async function json(res) {
  try {
    return await res.clone().json()
  } catch {
    return {}
  }
}
const data = async (res) => (await json(res)).data ?? {}

// Pictures of any shape; only bytes and size matter.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
const padded = (head, size) => {
  const b = new Uint8Array(size)
  b.set(head)
  return b
}

// ---------------------------------------------------------------
section('1. Settings: who may read and change them')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/workspaces/ws_a/manage', { user: 'usr_o' })
  let d = await data(res)
  check('owner reads the management screen', res.status === 200 && d.workspace?.canManageSettings && d.workspace?.canManageMembers)
  check('defaults: UTC, D MMM YYYY, Guest on join, no approval', d.settings?.regional?.timeZone === 'UTC' && d.settings?.regional?.dateFormat === 'D MMM YYYY' && d.settings?.invitations?.defaultRole === 'VIEWER' && d.settings?.invitations?.requireApproval === false)
  check('no language setting is offered', !('language' in (d.settings?.regional ?? {})))
  check('built-in tiers are Owner, Admin, Member, Guest', d.tiers?.builtIn?.map((t) => t.name).join(',') === 'Owner,Admin,Member,Guest')

  res = await call('/api/v1/workspaces/ws_a/manage', { user: 'usr_m' })
  d = await data(res)
  check('a member can read it but not manage', res.status === 200 && !d.workspace.canManageSettings && !d.workspace.canManageMembers)
  res = await call('/api/v1/workspaces/ws_a/manage', { user: 'usr_b' })
  check('another organization cannot see it', res.status === 404 || res.status === 403, `got ${res.status}`)

  res = await call('/api/v1/workspaces/ws_a/settings', { user: 'usr_m', method: 'PATCH', body: { name: 'Hacked' } })
  check('a member cannot change settings', res.status === 403)

  res = await call('/api/v1/workspaces/ws_a/settings', {
    user: 'usr_admin',
    method: 'PATCH',
    body: { name: 'Acme Design', regional: { timeZone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' } }
  })
  d = await data(res)
  check('an org admin renames and sets regional', res.status === 200 && d.workspace?.name === 'Acme Design' && d.settings?.regional?.timeZone === 'Asia/Kolkata')
  check('stored', q(`SELECT name FROM workspaces WHERE id='ws_a'`)[0].name === 'Acme Design')

  for (const [label, body] of [
    ['an unknown time zone', { regional: { timeZone: 'Mars/Olympus' } }],
    ['an unknown date format', { regional: { dateFormat: 'YY' } }],
    ['an empty name', { name: '   ' }],
    ['an invalid allowed domain', { invitations: { allowedDomains: ['not a domain'] } }],
    ['a default tier from nowhere', { invitations: { defaultCustomRoleId: 'wcr_nope' } }]
  ]) {
    res = await call('/api/v1/workspaces/ws_a/settings', { user: 'usr_o', method: 'PATCH', body })
    check(`rejects ${label}`, res.status === 400, `got ${res.status}`)
  }

  res = await call('/api/v1/workspaces/ws_personal/settings', {
    user: 'usr_o', method: 'PATCH', body: { name: 'My Files', regional: { dateFormat: 'YYYY-MM-DD' } }
  })
  check('a personal workspace owner sets identity and regional', res.status === 200 && (await data(res)).settings?.regional?.dateFormat === 'YYYY-MM-DD')
  res = await call('/api/v1/workspaces/ws_personal/manage', { user: 'usr_o' })
  check('a personal workspace opens on the management screen', res.status === 200 && (await data(res)).workspace?.canManageSettings === true)

  res = await call('/api/v1/auth/me', { user: 'usr_m' })
  d = await data(res)
  const ws = d.workspaces?.find((w) => w.id === 'ws_a')
  check('/me carries regional settings and canManage', ws?.regional?.dateFormat === 'DD/MM/YYYY' && ws?.canManage === false)
  res = await call('/api/v1/auth/me', { user: 'usr_o' })
  check('/me says the owner can manage', (await data(res)).workspaces?.find((w) => w.id === 'ws_a')?.canManage === true)
}

// ---------------------------------------------------------------
section('2. Logos and profile pictures')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/workspaces/ws_a/logo', { user: 'usr_o', method: 'PUT', raw: padded(PNG, 4000) })
  let d = await data(res)
  check('owner uploads a logo of any shape', res.status === 200 && d.logoUrl?.startsWith('/api/v1/workspaces/ws_a/logo'))
  res = await call(d.logoUrl)
  check('the logo is public (shown on share pages)', res.status === 200 && res.headers.get('Content-Type') === 'image/png')
  check('served with nosniff and a sandbox CSP', res.headers.get('X-Content-Type-Options') === 'nosniff' && /sandbox/.test(res.headers.get('Content-Security-Policy') ?? ''))
  res = await call('/api/v1/workspaces/ws_a/logo', { user: 'usr_m', method: 'PUT', raw: padded(PNG, 100) })
  check('a member cannot change the logo', res.status === 403)

  res = await call('/api/v1/profile/avatar', { user: 'usr_m', method: 'PUT', raw: padded(JPEG, 1024 * 1024) })
  d = await data(res)
  check('a picture of exactly 1 MB is accepted', res.status === 200 && !!d.avatarUrl, JSON.stringify(await json(res)))
  check('users.avatar_url points at it', q(`SELECT avatar_url FROM users WHERE id='usr_m'`)[0].avatar_url === d.avatarUrl)
  res = await call(d.avatarUrl, { user: 'usr_o' })
  check('signed-in people can see it', res.status === 200 && res.headers.get('Content-Type') === 'image/jpeg')
  res = await call(d.avatarUrl)
  check('anonymous visitors cannot', res.status === 401)

  res = await call('/api/v1/profile/avatar', { user: 'usr_m', method: 'PUT', raw: padded(JPEG, 1024 * 1024 + 1) })
  check('1 byte over 1 MB is rejected', res.status === 400 && /1 MB/.test((await json(res)).message ?? ''), res.status + JSON.stringify(await json(res)))
  res = await call('/api/v1/profile/avatar', { user: 'usr_m', method: 'PUT', raw: new TextEncoder().encode('<svg onload="alert(1)"/>') })
  check('SVG and other non-images are rejected', res.status === 400)
  res = await call('/api/v1/profile/avatar', { user: 'usr_m', method: 'PUT', raw: padded(PNG, 20) })
  check('a tiny picture is still accepted (no dimension rule)', res.status === 200)
  check('the replaced picture is removed from storage', [...r2.keys()].filter((k) => k.startsWith('avatars/usr_m/')).length === 1)

  res = await call('/api/v1/profile/avatar', { user: 'usr_m', method: 'DELETE' })
  check('a picture can be removed', res.status === 200 && q(`SELECT avatar_url FROM users WHERE id='usr_m'`)[0].avatar_url === null)
}

// ---------------------------------------------------------------
section('3. Custom tiers')
// ---------------------------------------------------------------
let reviewer
{
  let res = await call('/api/v1/workspaces/ws_a/roles', { user: 'usr_m', body: { name: 'Reviewer', permissions: [] } })
  check('a member cannot create tiers', res.status === 403)
  res = await call('/api/v1/workspaces/ws_a/roles', { user: 'usr_o', body: { name: 'Reviewer', permissions: ['member.manage'] } })
  check('a tier cannot hold member.manage', res.status === 400)
  res = await call('/api/v1/workspaces/ws_a/roles', { user: 'usr_o', body: { name: 'Admin', permissions: [] } })
  check('a tier cannot reuse a built-in name', res.status === 409)

  res = await call('/api/v1/workspaces/ws_a/roles', { user: 'usr_o', body: { name: 'Reviewer', permissions: ['artifact.download', 'share.create'] } })
  reviewer = (await data(res)).tier
  check('owner creates a custom tier', res.status === 201 && reviewer?.id)
  check('artifact.read is always included', reviewer?.permissions?.includes('artifact.read'))
  res = await call('/api/v1/workspaces/ws_a/roles', { user: 'usr_o', body: { name: 'reviewer', permissions: [] } })
  check('names are unique per workspace', res.status === 409)

  res = await call('/api/v1/workspaces/ws_a/members/usr_m', { user: 'usr_o', method: 'PATCH', body: { customRoleId: reviewer.id } })
  check('assign a member to the tier', res.status === 200 && (await data(res)).role === 'CONTRIBUTOR')

  // Effective permissions: share yes (in tier), create artifact no (not in tier).
  insert('artifacts', {
    id: 'art_1', organization_id: 'org_a', workspace_id: 'ws_a', owner_user_id: 'usr_o', title: 'Deck', description: null,
    canonical_slug: 'deck', filename: 'deck.txt', extension: 'txt', mime_type: 'text/plain', size_bytes: 5, checksum: 'x',
    current_version_id: 'art_1_v1', version_count: 1, source_type: 'UPLOAD', source_provider: null, status: 'READY',
    status_detail: null, metadata_json: '{}', created_at: T, updated_at: T, deleted_at: null
  })
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m', method: 'PATCH', body: { title: 'Renamed' } })
  check('the tier withholds what it does not grant (edit)', res.status === 403, `got ${res.status}`)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m' })
  check('the tier allows viewing', res.status === 200)

  res = await call('/api/v1/workspaces/ws_a/directory', { user: 'usr_o' })
  const m = (await data(res)).active?.find((p) => p.userId === 'usr_m')
  check('the directory shows the tier name', m?.tier === 'Reviewer')

  res = await call(`/api/v1/workspaces/ws_a/roles/${reviewer.id}`, { user: 'usr_o', method: 'PATCH', body: { permissions: ['artifact.update'] } })
  check('editing a tier updates it', res.status === 200)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m', method: 'PATCH', body: { title: 'Renamed' } })
  check('…and takes effect at once', res.status === 200, `got ${res.status}`)

  res = await call(`/api/v1/workspaces/ws_b/roles/${reviewer.id}`, { user: 'usr_b', method: 'DELETE' })
  check('another workspace cannot delete it', res.status === 400 || res.status === 404)

  res = await call(`/api/v1/workspaces/ws_a/roles/${reviewer.id}`, { user: 'usr_o', method: 'DELETE' })
  check('deleting a tier', res.status === 200)
  const row = q(`SELECT role, custom_role_id FROM workspace_members WHERE id='wsm_m'`)[0]
  check('its members fall back to the base role', row.custom_role_id === null && row.role === 'CONTRIBUTOR')
  res = await call('/api/v1/workspaces/ws_a/members/usr_m', { user: 'usr_o', method: 'PATCH', body: { role: 'VIEWER' } })
  check('back to Guest', res.status === 200)
}

// ---------------------------------------------------------------
section('4. Invitations')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_m', body: { kind: 'LINK' } })
  check('a member cannot invite', res.status === 403)
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'LINK', role: 'WORKSPACE_ADMIN' } })
  check('a link can never grant Admin', res.status === 400)

  // Email invitation to an outsider with an account.
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'EMAIL', email: 'someone@other.test', role: 'CONTRIBUTOR' } })
  let d = await data(res)
  check('email invitation created; link returned once', res.status === 201 && d.url?.startsWith(`${APP}/join/`) && d.delivered === 'NOT_SENT')
  const emailToken = d.url.split('/join/')[1]
  check('only a hash of the token is stored', q(`SELECT COUNT(*) AS n FROM workspace_invitations WHERE token_hash = ?`, emailToken)[0].n === 0)

  res = await call(`/api/v1/invitations/${emailToken}`)
  d = await data(res)
  check('the join page summary is public and masks the address', d.valid && d.workspace?.name === 'Acme Design' && d.emailHint === 's***@other.test')
  res = await call(`/api/v1/invitations/${emailToken}/accept`, { method: 'POST' })
  check('accepting needs a session', res.status === 401)
  res = await call(`/api/v1/invitations/${emailToken}/accept`, { user: 'usr_new', method: 'POST' })
  check('another address cannot use an email invitation', res.status === 403)
  res = await call(`/api/v1/invitations/${emailToken}/accept`, { user: 'usr_x', method: 'POST' })
  d = await data(res)
  check('the invited person joins as Member', res.status === 200 && d.status === 'ACTIVE')
  check('…and is added to the organization as a plain member', q(`SELECT role FROM organization_members WHERE organization_id='org_a' AND user_id='usr_x'`)[0]?.role === 'MEMBER')
  res = await call(`/api/v1/invitations/${emailToken}/accept`, { user: 'usr_x', method: 'POST' })
  check('an email invitation works once', res.status === 410)

  // Domain restriction + approval.
  res = await call('/api/v1/workspaces/ws_a/settings', {
    user: 'usr_o', method: 'PATCH', body: { invitations: { allowedDomains: ['@ACME.test'], requireApproval: true } }
  })
  check('domains are normalized', (await data(res)).settings?.invitations?.allowedDomains?.join() === 'acme.test')
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'EMAIL', email: 'x@gmail.test' } })
  check('email invitations respect allowed domains', res.status === 400)

  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'LINK', maxUses: 2, expiresInDays: 3 } })
  d = await data(res)
  const linkToken = d.url.split('/join/')[1]
  check('invite link created with the default tier (Guest)', res.status === 201 && d.invitation?.tier === 'Guest' && d.invitation?.maxUses === 2)

  res = await call(`/api/v1/invitations/${linkToken}/accept`, { user: 'usr_b', method: 'POST' })
  check('someone outside the allowed domains is refused', res.status === 403)
  res = await call(`/api/v1/invitations/${linkToken}/accept`, { user: 'usr_new', method: 'POST' })
  d = await data(res)
  check('an allowed joiner waits for approval', d.status === 'PENDING_APPROVAL')
  check('…and is not yet an organization member', q(`SELECT COUNT(*) AS n FROM organization_members WHERE organization_id='org_a' AND user_id='usr_new'`)[0].n === 0)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_new' })
  check('…and cannot see the workspace yet', res.status === 404 || res.status === 403, `got ${res.status}`)

  res = await call('/api/v1/workspaces/ws_a/directory', { user: 'usr_o' })
  d = await data(res)
  check('the directory lists them as awaiting approval', d.awaitingApproval?.some((p) => p.userId === 'usr_new'))
  check('the directory lists the open link', d.invitations?.some((i) => i.kind === 'LINK' && i.useCount === 1))

  res = await call('/api/v1/workspaces/ws_a/members/usr_new/status', { user: 'usr_o', body: { status: 'ACTIVE' } })
  check('an admin approves', res.status === 200)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_new' })
  check('…and they can see the workspace', res.status === 200, `got ${res.status}`)

  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o' })
  const link = (await data(res)).invitations?.find((i) => i.kind === 'LINK')
  res = await call(`/api/v1/workspaces/ws_a/invitations/${link.id}`, { user: 'usr_o', method: 'DELETE' })
  check('a link can be revoked', res.status === 200)
  res = await call(`/api/v1/invitations/${linkToken}`)
  check('a revoked link says so', (await data(res)).reason === 'REVOKED')

  // Expiry.
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'LINK' } })
  const oldToken = (await data(res)).url.split('/join/')[1]
  sqlite.exec(`UPDATE workspace_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE kind='LINK' AND status='ACTIVE'`)
  res = await call(`/api/v1/invitations/${oldToken}/accept`, { user: 'usr_new', method: 'POST' })
  check('an expired link is refused', res.status === 410)

  // Email delivery: sent when a provider is configured; failure keeps the link.
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: 'e1' }), { status: sent.length > 1 ? 500 : 200 })
    }
    return realFetch(input, init)
  }
  const mailEnv = { ...env, EMAIL_API_KEY: 'k' }
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', useEnv: mailEnv, body: { kind: 'EMAIL', email: 'pat@acme.test' } })
  d = await data(res)
  check('an email is sent when a provider is configured', d.delivered === 'EMAIL' && sent[0]?.to?.[0] === 'pat@acme.test' && sent[0]?.html?.includes(d.url))
  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', useEnv: mailEnv, body: { kind: 'EMAIL', email: 'pat@acme.test' } })
  d = await data(res)
  check('a failed send still returns the link to copy', res.status === 201 && d.delivered === 'FAILED' && !!d.url)
  check('the earlier invitation to the same address is superseded', q(`SELECT COUNT(*) AS n FROM workspace_invitations WHERE email_normalized='pat@acme.test' AND status='ACTIVE'`)[0].n === 1)
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------
section('5–6. Deactivation')
// ---------------------------------------------------------------
{
  let res = await call('/api/v1/workspaces/ws_a/members/usr_o/status', { user: 'usr_admin', body: { status: 'REMOVED' } })
  check('the owner cannot be deactivated', res.status === 400)

  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m' })
  check('before: the org member can see the workspace', res.status === 200)
  res = await call('/api/v1/workspaces/ws_a/members/usr_m/status', { user: 'usr_admin', body: { status: 'REMOVED' } })
  check('an org admin deactivates a member', res.status === 200)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m' })
  check('after: no access, even through organization membership', res.status === 404 || res.status === 403, `got ${res.status}`)
  res = await call('/api/v1/auth/me', { user: 'usr_m' })
  check('…and the workspace leaves their list', !(await data(res)).workspaces?.some((w) => w.id === 'ws_a'))

  res = await call('/api/v1/workspaces/ws_a/directory', { user: 'usr_o' })
  check('the directory lists them as deactivated', (await data(res)).deactivated?.some((p) => p.userId === 'usr_m'))

  res = await call('/api/v1/workspaces/ws_a/invitations', { user: 'usr_o', body: { kind: 'LINK' } })
  const link = (await data(res)).url.split('/join/')[1]
  sqlite.exec(`UPDATE workspaces SET settings_json = json_set(settings_json, '$.invitations.requireApproval', json('false')) WHERE id='ws_a'`)
  res = await call(`/api/v1/invitations/${link}/accept`, { user: 'usr_m', method: 'POST' })
  check('a deactivated person cannot rejoin through a link', res.status === 403)

  res = await call('/api/v1/workspaces/ws_a/members/usr_m/status', { user: 'usr_o', body: { status: 'ACTIVE' } })
  check('an admin can reactivate them', res.status === 200)
  res = await call('/api/v1/artifacts/art_1', { user: 'usr_m' })
  check('…and access returns', res.status === 200)
}

// ---------------------------------------------------------------
section('7. Personal workspaces become shared on the first invitation')
// ---------------------------------------------------------------
{
  insert('workspace_members', { id: 'wsm_p', workspace_id: 'ws_personal', user_id: 'usr_o', role: 'WORKSPACE_ADMIN', created_at: T, created_by: 'usr_o', status: 'ACTIVE' })
  insert('artifacts', {
    id: 'art_p', organization_id: null, workspace_id: 'ws_personal', owner_user_id: 'usr_o', title: 'Notes', description: null,
    canonical_slug: 'notes', filename: 'notes.txt', extension: 'txt', mime_type: 'text/plain', size_bytes: 5, checksum: 'x',
    current_version_id: 'art_p_v1', version_count: 1, source_type: 'UPLOAD', source_provider: null, status: 'READY',
    status_detail: null, metadata_json: '{}', created_at: T, updated_at: T, deleted_at: null
  })
  insert('collections', { id: 'col_p', organization_id: null, workspace_id: 'ws_personal', name: 'Mine', created_at: T, updated_at: T })

  let res = await call('/api/v1/workspaces/ws_personal/manage', { user: 'usr_o' })
  check('a personal workspace owner may invite', (await data(res)).workspace?.canManageMembers === true)

  res = await call('/api/v1/workspaces/ws_personal/members', { user: 'usr_o', body: { email: 'someone@other.test', role: 'VIEWER' } })
  check('members cannot be added to a personal workspace directly', res.status === 400, `got ${res.status}`)

  for (const kind of ['EMAIL', 'LINK']) {
    res = await call('/api/v1/workspaces/ws_personal/invitations', { user: 'usr_o', body: { kind, email: 'someone@other.test', role: 'VIEWER' } })
    check(`an unconfirmed ${kind.toLowerCase()} invitation asks to convert first`, res.status === 409 && (await json(res)).error === 'CONVERT_TO_SHARED', JSON.stringify(await json(res)))
  }
  check('…and nothing changed', q(`SELECT organization_id FROM workspaces WHERE id='ws_personal'`)[0].organization_id === null &&
    q(`SELECT COUNT(*) AS n FROM workspace_invitations WHERE workspace_id='ws_personal'`)[0].n === 0)

  res = await call('/api/v1/workspaces/ws_personal/invitations', {
    user: 'usr_o',
    body: { kind: 'EMAIL', email: 'someone@other.test', role: 'CONTRIBUTOR', convertToShared: true }
  })
  let d = await data(res)
  check('confirmed: the invitation is created', res.status === 201 && d.url?.startsWith(`${APP}/join/`) && d.convertedToShared === true, JSON.stringify(await json(res)))
  const ws = q(`SELECT organization_id, workspace_type FROM workspaces WHERE id='ws_personal'`)[0]
  check('the workspace is now shared, in an organization of its own', ws.workspace_type === 'ORGANIZATION' && ws.organization_id && !['org_a', 'org_b'].includes(ws.organization_id))
  const org = q(`SELECT name FROM organizations WHERE id=?`, ws.organization_id)[0]
  check('the organization is named after the workspace', org?.name === 'My Files')
  check('its owner owns the organization', q(`SELECT role FROM organization_members WHERE organization_id=? AND user_id='usr_o'`, ws.organization_id)[0]?.role === 'ORG_OWNER')
  check('its artifacts and collections moved with it',
    q(`SELECT organization_id FROM artifacts WHERE id='art_p'`)[0].organization_id === ws.organization_id &&
    q(`SELECT organization_id FROM collections WHERE id='col_p'`)[0].organization_id === ws.organization_id)
  check('the conversion is audited', q(`SELECT COUNT(*) AS n FROM audit_events WHERE action='WORKSPACE_CONVERT_SHARED' AND target_id='ws_personal'`)[0].n === 1)

  const token = d.url.split('/join/')[1]
  res = await call(`/api/v1/invitations/${token}/accept`, { user: 'usr_x', method: 'POST' })
  check('the invitee joins', res.status === 200 && (await data(res)).status === 'ACTIVE', JSON.stringify(await json(res)))
  res = await call('/api/v1/artifacts/art_p', { user: 'usr_x' })
  check('…and sees what was in the workspace', res.status === 200, `got ${res.status}`)

  res = await call('/api/v1/workspaces/ws_personal/invitations', { user: 'usr_o', body: { kind: 'LINK', role: 'VIEWER' } })
  d = await data(res)
  check('a shared workspace invites without asking again', res.status === 201 && d.convertedToShared === false)
  check('only one organization was created', q(`SELECT COUNT(*) AS n FROM organizations`)[0].n === 3)
  res = await call('/api/v1/workspaces/ws_personal/manage', { user: 'usr_o' })
  check('the screen now treats it as shared', (await data(res)).workspace?.type === 'ORGANIZATION')
}

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('FAILED')
  process.exit(1)
}
console.log('ALL WORKSPACE MANAGEMENT CHECKS PASSED')
