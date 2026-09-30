/**
 * Tag decision tests — REST service and MCP tool.
 *
 * The bug this suite exists for: tags were generated and stored as SUGGESTED,
 * but nothing could CONFIRM or REJECT one except the MCP `update_tags` tool.
 * `decideTags` was reachable from REST, yet no route ever passed `accept` or
 * `reject`, so from the web UI a suggestion was permanent.
 *
 * The fix is a single implementation (`applyTagDecisions` in lib/tags.ts) that
 * both the new REST endpoint and the MCP tool call. Two copies of these rules
 * drift, and the copy that drifts becomes a hole — one surface would refuse a
 * case-duplicate that the other happily created. So this suite tests BOTH:
 *
 *   A. the decision service — accept / reject / add / remove semantics,
 *      case-dedup, rejection memory, and the refusals;
 *   B. the MCP transport — that `update_tags` reaches that same behaviour and
 *      reports a refusal to the model instead of ending the session;
 *   C. structural guards — that neither surface has re-inlined its own copy.
 *
 * Real service modules run against a real SQLite built from the actual
 * migration files, so a defect in the SQL or the state machine fails here.
 *
 * Run: node scripts/test-tag-decisions.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
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

function section(title) {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------
// Bundle the real modules
// ---------------------------------------------------------------

mkdirSync('/tmp/build', { recursive: true })
await build({
  stdin: {
    contents: `
      export * as tags from './src/lib/tags.ts'
      export * as mcp from './src/lib/mcp-jobs.ts'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'tag-decisions-entry.ts',
    loader: 'ts'
  },
  outfile: '/tmp/build/tag-decisions.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const mod = await import(pathToFileURL('/tmp/build/tag-decisions.mjs').href)
const { tags, mcp } = mod

// ---------------------------------------------------------------
// Schema straight from the migrations
// ---------------------------------------------------------------

function makeDB() {
  const sqlite = new DatabaseSync(':memory:')
  const files = readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'))

  function statement(sql, bound) {
    return {
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
      const values = bound.map((v) => (v === undefined ? null : v))
      for (const v of values) {
        if (typeof v === 'object' && v !== null) {
          throw new Error(
            `non-primitive bound as a SQL value (${JSON.stringify(v).slice(0, 80)}) in: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`
          )
        }
      }
      return sqlite.prepare(sql).all(...values)
    }
  }

  return {
    sqlite,
    prepare: (sql) => statement(sql, []),
    async batch() {
      return []
    },
    exec: (sql) => sqlite.exec(sql),
    insert: (table, row) => {
      const keys = Object.keys(row)
      sqlite
        .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => row[k]))
    }
  }
}

const T = '2026-01-01T00:00:00.000Z'

function principalFor(userId, opts = {}) {
  return {
    kind: opts.kind ?? 'SESSION',
    userId,
    user: { id: userId, email: `${userId}@example.com`, display_name: userId },
    orgRoles: opts.orgRoles ?? {},
    workspaceRoles: opts.workspaceRoles ?? {},
    scopes: opts.scopes ?? [],
    integrationId: opts.integrationId,
    grantId: opts.grantId,
    provider: opts.provider,
    clientName: opts.clientName
  }
}

/** One org, one workspace, one artifact owned by the admin. */
function seedBase() {
  const db = makeDB()

  for (const [id, name] of [
    ['usr_admin', 'Amara Admin'],
    ['usr_member', 'Mo Member']
  ]) {
    db.insert('users', {
      id,
      email: `${id}@example.com`,
      email_normalized: `${id}@example.com`,
      display_name: name,
      status: 'ACTIVE',
      created_at: T,
      updated_at: T
    })
  }

  db.insert('organizations', {
    id: 'org_a',
    name: 'Acme',
    slug: 'acme',
    plan: 'FREE',
    max_upload_bytes: 1000000,
    settings_json: '{}',
    status: 'ACTIVE',
    created_by: 'usr_admin',
    created_at: T,
    updated_at: T
  })
  db.insert('organization_members', {
    id: 'om_1', organization_id: 'org_a', user_id: 'usr_admin',
    role: 'ORG_OWNER', created_at: T, created_by: 'usr_admin', status: 'ACTIVE'
  })
  db.insert('workspaces', {
    id: 'ws_fin', organization_id: 'org_a', owner_user_id: 'usr_admin',
    workspace_type: 'ORGANIZATION', name: 'Finance', description: null,
    created_at: T, created_by: 'usr_admin', archived_at: null
  })

  return db
}

function addArtifact(db, id, body = 'quarterly budget planning notes') {
  db.insert('artifacts', {
    id,
    organization_id: 'org_a',
    workspace_id: 'ws_fin',
    owner_user_id: 'usr_admin',
    title: `Artifact ${id}`,
    description: null,
    canonical_slug: id,
    filename: `${id}.txt`,
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: body.length,
    checksum: 'x',
    current_version_id: `${id}_v1`,
    version_count: 1,
    source_type: 'UPLOAD',
    source_provider: null,
    status: 'READY',
    status_detail: null,
    metadata_json: '{}',
    created_at: T,
    updated_at: T,
    deleted_at: null,
    interactive_html: 0
  })
  db.insert('artifact_versions', {
    id: `${id}_v1`,
    artifact_id: id,
    version_number: 1,
    r2_object_key: `k/${id}`,
    filename: `${id}.txt`,
    mime_type: 'text/plain',
    extension: 'txt',
    size_bytes: body.length,
    checksum: 'x',
    source_type: 'UPLOAD',
    source_provider: null,
    change_summary: null,
    extracted_text: body,
    created_by_user_id: 'usr_admin',
    created_at: T,
    deleted_at: null
  })
}

const admin = principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } })

function refOf(db, id) {
  const row = db.sqlite
    .prepare(`SELECT organization_id, workspace_id, current_version_id FROM artifacts WHERE id = ?`)
    .get(id)
  return {
    id,
    organization_id: row.organization_id,
    workspace_id: row.workspace_id,
    current_version_id: row.current_version_id
  }
}

async function views(db, id) {
  return await tags.artifactTagViews(db, id, { includeRejected: true })
}

function stateOf(rows, name) {
  const hit = rows.find((r) => r.name.toLowerCase() === name.toLowerCase())
  return hit ? `${hit.state}/${hit.provenance}` : null
}

async function expectThrow(fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ---------------------------------------------------------------
section('A. Decision service — add')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, 'art_a')

  const added = await tags.applyTagDecisions(db, admin, refOf(db, 'art_a'), { add: ['Board prep'] })
  check('a manual add is reported back', added.added.length === 1 && added.added[0].toLowerCase() === 'board prep',
    JSON.stringify(added.added))

  const rows = await views(db, 'art_a')
  check('a manual add lands as CONFIRMED with USER provenance',
    stateOf(rows, 'Board prep') === 'CONFIRMED/USER', String(stateOf(rows, 'Board prep')))
  check('the confirmed set is echoed for the client',
    added.confirmed.some((n) => n.toLowerCase() === 'board prep'), JSON.stringify(added.confirmed))
}

{
  // Case-duplicate prevention is the rule that most needs one implementation:
  // "AI", "ai" and "Ai" are one tag, or the vocabulary fills with near-copies.
  const db = seedBase()
  addArtifact(db, 'art_case')

  await tags.applyTagDecisions(db, admin, refOf(db, 'art_case'), { add: ['Finance'] })
  const second = await tags.applyTagDecisions(db, admin, refOf(db, 'art_case'), { add: ['finance'] })

  const rows = await views(db, 'art_case')
  const financeRows = rows.filter((r) => r.name.toLowerCase() === 'finance')
  check('a case-variant add is not a duplicate', financeRows.length === 1,
    `rows: ${JSON.stringify(rows.map((r) => r.name))}`)
  check('the case-variant add reports the existing tag name', second.added.length === 1,
    JSON.stringify(second.added))
}

// ---------------------------------------------------------------
section('B. Decision service — accept')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, 'art_accept')

  // A suggestion arrives the way the tagger leaves it: SUGGESTED, provenance AI.
  const { tag } = await tags.resolveOrCreateTag(db, admin, 'Budget planning', {
    organizationId: 'org_a',
    provenance: 'USER'
  })
  await tags.applySuggestions(db, 'art_accept', [{ tagId: tag.id, name: tag.name }], 'art_accept_v1')

  const before = stateOf(await views(db, 'art_accept'), 'Budget planning')
  check('a pending suggestion starts SUGGESTED with AI provenance', before === 'SUGGESTED/AI', String(before))

  const accepted = await tags.applyTagDecisions(db, admin, refOf(db, 'art_accept'), {
    accept: ['Budget planning']
  })
  check('accepting a suggestion is reported as accepted', accepted.accepted.length === 1,
    JSON.stringify(accepted))
  check('accepting turns it into CONFIRMED with USER provenance',
    stateOf(await views(db, 'art_accept'), 'Budget planning') === 'CONFIRMED/USER',
    String(stateOf(await views(db, 'art_accept'), 'Budget planning')))
}

{
  // Accepting something that was never on the artifact must NOT invent a tag.
  // Creating one is `add`, so a client typo stays a typo instead of becoming a
  // permanent entry in the shared vocabulary.
  const db = seedBase()
  addArtifact(db, 'art_ghost')

  const outcome = await tags.applyTagDecisions(db, admin, refOf(db, 'art_ghost'), {
    accept: ['Never suggested']
  })
  check('accepting an unknown name is reported as not_found',
    outcome.not_found.length === 1 && !outcome.accepted.length, JSON.stringify(outcome))
  check('accepting an unknown name does not create the tag',
    (await views(db, 'art_ghost')).length === 0,
    JSON.stringify((await views(db, 'art_ghost')).map((r) => r.name)))
}

// ---------------------------------------------------------------
section('C. Decision service — reject and rejection memory')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, 'art_rej')

  const { tag } = await tags.resolveOrCreateTag(db, admin, 'Vendor risk', {
    organizationId: 'org_a',
    provenance: 'USER'
  })
  await tags.applySuggestions(db, 'art_rej', [{ tagId: tag.id, name: tag.name }], 'art_rej_v1')

  const rejected = await tags.applyTagDecisions(db, admin, refOf(db, 'art_rej'), { reject: ['Vendor risk'] })
  check('rejecting a suggestion is reported as rejected', rejected.rejected.length === 1,
    JSON.stringify(rejected))
  check('rejecting records REJECTED with USER provenance',
    stateOf(await views(db, 'art_rej'), 'Vendor risk') === 'REJECTED/USER',
    String(stateOf(await views(db, 'art_rej'), 'Vendor risk')))

  const after = await views(db, 'art_rej')
  const row = db.sqlite
    .prepare(`SELECT source_version_id FROM artifact_tags WHERE artifact_id = 'art_rej' AND tag_id = ?`)
    .get(tag.id)
  check('the rejection is bound to the version it judged',
    row.source_version_id === 'art_rej_v1', String(row.source_version_id))

  // Requirement: reprocessing must not immediately re-offer a rejected tag.
  const sameVersion = await tags.applySuggestions(
    db, 'art_rej', [{ tagId: tag.id, name: tag.name }], 'art_rej_v1'
  )
  check('the same content does not re-offer a rejected tag', sameVersion.length === 0,
    JSON.stringify(sameVersion))
  check('the rejection survives a reprocessing pass',
    stateOf(await views(db, 'art_rej'), 'Vendor risk') === 'REJECTED/USER',
    String(stateOf(await views(db, 'art_rej'), 'Vendor risk')))

  // A rejection is a judgement about content, not a permanent ban on a word:
  // genuinely new content may propose it again.
  db.insert('artifact_versions', {
    id: 'art_rej_v2',
    artifact_id: 'art_rej',
    version_number: 2,
    r2_object_key: 'k/art_rej_v2',
    filename: 'art_rej.txt',
    mime_type: 'text/plain',
    extension: 'txt',
    size_bytes: 10,
    checksum: 'y',
    source_type: 'UPLOAD',
    source_provider: null,
    change_summary: null,
    extracted_text: 'rewritten',
    created_by_user_id: 'usr_admin',
    created_at: T,
    deleted_at: null
  })
  db.sqlite.prepare(`UPDATE artifacts SET current_version_id = 'art_rej_v2' WHERE id = 'art_rej'`).run()

  const newVersion = await tags.applySuggestions(
    db, 'art_rej', [{ tagId: tag.id, name: tag.name }], 'art_rej_v2'
  )
  check('a new version may propose the rejected tag again', newVersion.length === 1,
    JSON.stringify(newVersion))
}

// ---------------------------------------------------------------
section('D. Decision service — remove and refusals')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, 'art_rm')

  await tags.applyTagDecisions(db, admin, refOf(db, 'art_rm'), { add: ['Legacy'] })
  const removed = await tags.applyTagDecisions(db, admin, refOf(db, 'art_rm'), { remove: ['Legacy'] })
  check('removing a confirmed tag is reported', removed.removed.length === 1, JSON.stringify(removed))
  check('the tag association is gone', (await views(db, 'art_rm')).length === 0,
    JSON.stringify((await views(db, 'art_rm')).map((r) => r.name)))
}

{
  // A pending AI suggestion is not the user's to delete silently: rejecting it
  // is the meaningful action, and the refusal says so.
  const db = seedBase()
  addArtifact(db, 'art_pending')

  const { tag } = await tags.resolveOrCreateTag(db, admin, 'Pending idea', {
    organizationId: 'org_a',
    provenance: 'USER'
  })
  await tags.applySuggestions(db, 'art_pending', [{ tagId: tag.id, name: tag.name }], 'art_pending_v1')

  const message = await expectThrow(() =>
    tags.applyTagDecisions(db, admin, refOf(db, 'art_pending'), { remove: ['Pending idea'] })
  )
  check('removing a pending suggestion is refused', typeof message === 'string', String(message))
  check('the refusal explains that rejecting is the right action',
    typeof message === 'string' && /reject/i.test(message), String(message))
  check('the refused suggestion is left untouched',
    stateOf(await views(db, 'art_pending'), 'Pending idea') === 'SUGGESTED/AI',
    String(stateOf(await views(db, 'art_pending'), 'Pending idea')))
}

{
  const db = seedBase()
  addArtifact(db, 'art_empty')
  const message = await expectThrow(() => tags.applyTagDecisions(db, admin, refOf(db, 'art_empty'), {}))
  check('an empty decision is refused', typeof message === 'string', String(message))
}

{
  // The tag itself is the leak, so an explicit personal attribute is refused
  // even when a person types it by hand.
  const db = seedBase()
  addArtifact(db, 'art_sens')
  const message = await expectThrow(() =>
    tags.applyTagDecisions(db, admin, refOf(db, 'art_sens'), { add: ['religion'] })
  )
  check('a sensitive manual add is refused', typeof message === 'string', String(message))
  check('the refused sensitive tag was not created',
    !(await views(db, 'art_sens')).some((r) => r.name.toLowerCase() === 'religion'),
    JSON.stringify((await views(db, 'art_sens')).map((r) => r.name)))
}

// ---------------------------------------------------------------
section('E. MCP update_tags — same behaviour as REST')
// ---------------------------------------------------------------

function aiPrincipal() {
  return principalFor('usr_admin', {
    kind: 'AI_GRANT',
    orgRoles: { org_a: 'ORG_OWNER' },
    scopes: ['artifact.read', 'artifact.write'],
    grantId: 'grt_tag',
    provider: 'ANTHROPIC'
  })
}

async function callUpdateTags(db, args) {
  const env = { DB: db, R2: {}, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '1000000' }
  try {
    return await mcp.handleMcpRequest(env, aiPrincipal(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'update_tags', arguments: args }
    })
  } catch (err) {
    return { transportError: err instanceof Error ? err.message : String(err) }
  }
}

function toolText(result) {
  const content = result?.content
  if (Array.isArray(content) && content.length) return String(content[0]?.text ?? '')
  return String(result?.text ?? '')
}

{
  const db = seedBase()
  addArtifact(db, 'art_mcp')

  const res = await callUpdateTags(db, { artifact: 'art_mcp', add: ['Roadmap'] })

  check('the MCP transport does not fail', res.transportError === undefined, String(res.transportError))
  check('update_tags succeeds for a write-scoped grant', res.result?.isError === false,
    JSON.stringify(res.result?.structuredContent ?? res.error ?? res.result))
  check('MCP add writes the same CONFIRMED/USER state REST does',
    stateOf(await views(db, 'art_mcp'), 'Roadmap') === 'CONFIRMED/USER',
    String(stateOf(await views(db, 'art_mcp'), 'Roadmap')))
  check('MCP reports the confirmed set back to the model',
    (res.result?.structuredContent?.confirmed_tags || []).some((n) => n.toLowerCase() === 'roadmap'),
    JSON.stringify(res.result?.structuredContent?.confirmed_tags))
}

{
  // Accept through MCP must match REST exactly — including refusing a name that
  // is not on the artifact rather than inventing a tag.
  const db = seedBase()
  addArtifact(db, 'art_mcp_accept')

  const { tag } = await tags.resolveOrCreateTag(db, admin, 'Forecast', {
    organizationId: 'org_a',
    provenance: 'USER'
  })
  await tags.applySuggestions(db, 'art_mcp_accept', [{ tagId: tag.id, name: tag.name }], 'art_mcp_accept_v1')

  const ok = await callUpdateTags(db, { artifact: 'art_mcp_accept', accept: ['Forecast'] })
  check('MCP accepts a suggested tag', ok.result?.isError === false,
    JSON.stringify(ok.result?.structuredContent ?? ok.error))
  check('MCP accept produces CONFIRMED/USER like REST',
    stateOf(await views(db, 'art_mcp_accept'), 'Forecast') === 'CONFIRMED/USER',
    String(stateOf(await views(db, 'art_mcp_accept'), 'Forecast')))

  const ghost = await callUpdateTags(db, { artifact: 'art_mcp_accept', accept: ['Never suggested'] })
  check('MCP accept of an unknown name reports it as not found',
    (ghost.result?.structuredContent?.not_found || []).some((n) => n === 'Never suggested'),
    JSON.stringify(ghost.result?.structuredContent ?? ghost.error))
  check('MCP accept of an unknown name creates nothing',
    !(await views(db, 'art_mcp_accept')).some((r) => r.name === 'Never suggested'),
    JSON.stringify((await views(db, 'art_mcp_accept')).map((r) => r.name)))
}

{
  // A service refusal must reach the model as a tool result it can act on,
  // not as a transport error that ends the session.
  const db = seedBase()
  addArtifact(db, 'art_mcp_refuse')

  const { tag } = await tags.resolveOrCreateTag(db, admin, 'Pending thing', {
    organizationId: 'org_a',
    provenance: 'USER'
  })
  await tags.applySuggestions(db, 'art_mcp_refuse', [{ tagId: tag.id, name: tag.name }], 'art_mcp_refuse_v1')

  const res = await callUpdateTags(db, { artifact: 'art_mcp_refuse', remove: ['Pending thing'] })
  check('a refusal is a tool result, not a transport failure',
    res.result?.isError === true && res.error === undefined,
    JSON.stringify(res.result ?? res.error))
  check('the refusal text tells the model to reject instead',
    /reject/i.test(toolText(res.result)), toolText(res.result))
  check('the refused suggestion is unchanged',
    stateOf(await views(db, 'art_mcp_refuse'), 'Pending thing') === 'SUGGESTED/AI',
    String(stateOf(await views(db, 'art_mcp_refuse'), 'Pending thing')))
}

// ---------------------------------------------------------------
section('F. One implementation — structural guard against divergence')
// ---------------------------------------------------------------

{
  const fs = await import('node:fs')
  const mcpSrc = fs.readFileSync('src/lib/mcp-jobs.ts', 'utf8')
  const taxSrc = fs.readFileSync('src/routes/taxonomy.ts', 'utf8')
  const tagSrc = fs.readFileSync('src/lib/tags.ts', 'utf8')

  check('the MCP tool calls the shared decision service', /applyTagDecisions\(/.test(mcpSrc))

  const restCalls = (taxSrc.match(/applyTagDecisions\(/g) || []).length
  check('every REST tag-decision route calls the shared service', restCalls >= 2, `found ${restCalls}`)

  check('the MCP tool no longer writes tag state itself',
    !/removeTagFromArtifact\(/.test(mcpSrc) && !/\bdecideTag\(/.test(mcpSrc))
  check('no REST route deletes a tag association directly',
    !/DELETE FROM artifact_tags/.test(taxSrc))
  check('the service is the only place tag decisions are implemented',
    /export async function applyTagDecisions\(/.test(tagSrc) &&
      (tagSrc.match(/export async function applyTagDecisions\(/g) || []).length === 1)
  check('accept and reject are audited', /TAG_ACCEPT/.test(tagSrc) && /TAG_REJECT/.test(tagSrc))
}

// ---------------------------------------------------------------

console.log(`\n${'='.repeat(52)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures) {
  console.log('TAG DECISION TESTS FAILED')
  process.exit(1)
}
console.log('ALL TAG DECISION TESTS PASSED')
