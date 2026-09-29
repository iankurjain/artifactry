/**
 * Job-oriented MCP surface tests — Find → Save → Share (migration 0006).
 *
 * What makes these tests worth running is that they exercise the **real**
 * service modules against a **real SQLite engine**, with the schema built by
 * replaying the **actual migration files**. A hand-written fixture schema would
 * be a second source of truth, and the first thing to drift would be exactly
 * the columns these features depend on (`artifact_tags.state`,
 * `mcp_confirmations.request_hash`, `teams.organization_id`).
 *
 * Covered here:
 *
 *   1. Auto-tagging guardrails — 3–7 tags, generic words dropped, sensitive
 *      attributes refused, whole-word matching so "gay" cannot fire "Gaylord".
 *   2. Tag decision model — SUGGESTED / CONFIRMED / REJECTED, and the rejection
 *      memory that suppresses a re-suggestion on unchanged content.
 *   3. Case-insensitive dedupe — "AI" / "ai" / "Ai" resolve to one tag.
 *   4. Organization tag policy — `allowUserTags: false` blocks invention but
 *      not the use of existing tags.
 *   5. Search indexes CONFIRMED tags only, so a machine guess cannot silently
 *      change what the library can find.
 *   6. Teams — reusable audiences, and AMBIGUOUS name resolution returning
 *      candidates instead of picking one.
 *   7. The confirmation gate — the security property that a confirmation is
 *      bound to the exact request it authorised.
 *   8. MCP transport — tools/list, tools/call, scope enforcement, and the
 *      client identity recorded from `initialize`.
 *
 * Run: node scripts/test-mcp-jobs.mjs
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
      export * as teams from './src/lib/teams.ts'
      export * as tags from './src/lib/tags.ts'
      export * as autotag from './src/lib/autotag.ts'
      export * as confirmations from './src/lib/confirmations.ts'
      export * as search from './src/lib/search.ts'
      export * as mcp from './src/lib/mcp-jobs.ts'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'mcp-entry.ts',
    loader: 'ts'
  },
  outfile: '/tmp/build/mcp.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error'
})

const mod = await import(pathToFileURL('/tmp/build/mcp.mjs').href)
const { teams, tags, autotag, confirmations, search, mcp } = mod

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
      // node:sqlite (like D1) treats an OBJECT argument as named parameters,
      // which turns a stray object bind into a baffling "Unknown named
      // parameter 'kind'" — `kind` being the first key of a Principal. Bind
      // positions are positional here, so surface the real mistake instead.
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
        .prepare(
          `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
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

/** One organization, two members (an org admin and a plain member), one workspace. */
function seedBase() {
  const db = makeDB()
  const seed = db.insert

  for (const [id, name] of [
    ['usr_admin', 'Amara Admin'],
    ['usr_member', 'Mo Member'],
    ['usr_other', 'Otto Other'],
    ['usr_outsider', 'Una Outsider']
  ]) {
    seed('users', {
      id,
      email: `${id}@example.com`,
      email_normalized: `${id}@example.com`,
      display_name: name,
      status: 'ACTIVE',
      created_at: T,
      updated_at: T
    })
  }

  seed('organizations', {
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

  seed('organization_members', {
    id: 'om_1', organization_id: 'org_a', user_id: 'usr_admin',
    role: 'ORG_OWNER', created_at: T, created_by: 'usr_admin', status: 'ACTIVE'
  })
  seed('organization_members', {
    id: 'om_2', organization_id: 'org_a', user_id: 'usr_member',
    role: 'MEMBER', created_at: T, created_by: 'usr_admin', status: 'ACTIVE'
  })

  seed('workspaces', {
    id: 'ws_fin', organization_id: 'org_a', owner_user_id: 'usr_admin',
    workspace_type: 'ORGANIZATION', name: 'Finance', description: null,
    created_at: T, created_by: 'usr_admin', archived_at: null
  })
  seed('workspaces', {
    id: 'ws_personal', organization_id: null, owner_user_id: 'usr_member',
    workspace_type: 'PERSONAL', name: 'My Files', description: null,
    created_at: T, created_by: 'usr_member', archived_at: null
  })

  return db
}

function addArtifact(db, { id, workspaceId, orgId, ownerId, title, body = '' }) {
  db.insert('artifacts', {
    id,
    organization_id: orgId,
    workspace_id: workspaceId,
    owner_user_id: ownerId,
    title,
    description: null,
    canonical_slug: id,
    filename: `${id}.txt`,
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: body.length,
    checksum: 'x',
    current_version_id: null,
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
    created_by_user_id: ownerId,
    created_at: T,
    deleted_at: null
  })
  db.sqlite
    .prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`)
    .run(`${id}_v1`, id)
}

const noEnv = { DB: null, AI: undefined }

// ---------------------------------------------------------------
section('1. Auto-tagging guardrails (requirement 7)')
// ---------------------------------------------------------------

{
  const { kept, dropped } = autotag.filterSuggestions([
    'Q3 revenue',
    'PDF',
    'document',
    'presentation',
    'board meeting',
    'EMEA',
    'report'
  ])

  check('generic file-type words are dropped', dropped.length >= 4, `dropped: ${dropped.join(',')}`)
  check('subject tags survive', kept.includes('Q3 revenue') && kept.includes('board meeting'),
    `kept: ${kept.join(',')}`)
  check('a generic word is not also kept as a subject tag',
    !kept.some((k) => ['pdf', 'document', 'presentation', 'report'].includes(k.toLowerCase())),
    `kept: ${kept.join(',')}`)
}

{
  const { kept, dropped } = autotag.filterSuggestions(['religion', 'salary', 'board pack'])

  check('sensitive personal attributes are refused as tags',
    dropped.includes('religion') && dropped.includes('salary'), `dropped: ${dropped.join(',')}`)
  check('the sensitive rule does not swallow legitimate subject tags',
    kept.includes('board pack'), `kept: ${kept.join(',')}`)
}

{
  // Whole-word matching: the guardrail must not fire on a surname that merely
  // contains a sensitive term as a substring.
  const { kept } = autotag.filterSuggestions(['Gaylord Hotels', 'Gay agenda'])
  check('sensitive matching is whole-word, so "Gaylord" survives',
    kept.includes('Gaylord Hotels'), `kept: ${kept.join(',')}`)
  check('the same term as a real word is still refused',
    !kept.includes('Gay agenda'), `kept: ${kept.join(',')}`)
}

{
  const many = Array.from({ length: 20 }, (_, i) => `subject ${i}`)
  const { kept } = autotag.filterSuggestions(many)
  check(`the suggestion cap holds at MAX_TAGS (${autotag.MAX_TAGS})`,
    kept.length <= autotag.MAX_TAGS, `kept ${kept.length}`)
}

{
  const { kept } = autotag.filterSuggestions(['Q3 revenue', 'q3 revenue', 'Q3  REVENUE'])
  check('duplicate suggestions collapse case-insensitively', kept.length === 1, `kept: ${kept.join(',')}`)
}

{
  // The sensitive rule applies to a tag a model volunteers AND to one a person
  // types, because the tag itself is the leak either way.
  check('blockReason refuses a sensitive manual tag',
    autotag.blockReason('cancer') === 'sensitive')
  check('blockReason permits a generic manual tag, which is the user\'s prerogative',
    autotag.blockReason('document') === null)
  check('blockReason refuses an over-long name', autotag.blockReason('x'.repeat(60)) === 'too long')
}

{
  const outcome = await autotag.suggestTags(noEnv, {
    title: 'Q3 board deck', description: null, extension: 'pptx',
    workspaceName: 'Finance', text: null
  })
  check('without an AI binding the suggester reports it did not run the model',
    outcome.ran === false, String(outcome.ran))
  check('and it says the result is metadata-only rather than claiming content-based tagging',
    /title and workspace only/i.test(outcome.note) && /AI binding/i.test(outcome.note),
    outcome.note)
  check('it does not fabricate a content-derived topic it never read',
    outcome.suggestions.every((sugg) => sugg.reason === 'metadata'),
    JSON.stringify(outcome.suggestions))
}

// ---------------------------------------------------------------
section('2. Tag decision model + rejection memory (requirement 5)')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, {
    id: 'art_1', workspaceId: 'ws_fin', orgId: 'org_a', ownerId: 'usr_admin',
    title: 'Q3 board deck', body: 'Q3 revenue by region'
  })
  const member = principalFor('usr_member', { orgRoles: { org_a: 'MEMBER' } })

  // A suggestion attaches as SUGGESTED — never CONFIRMED.
  await tags.addTagToArtifact(db, member, 'art_1', 'q3 revenue', 'org_a')
  // addTagToArtifact is the manual path, so this is CONFIRMED; use the
  // suggestion path to get a SUGGESTED row.
  const tagRow = await tags.findTagBySlug(db, 'q3-revenue', 'org_a')
  await tags.decideTag(db, member, 'art_1', tagRow.id, 'REJECTED', 'USER', 'art_1_v1')

  let state = await tags.tagsByState(db, 'art_1')
  check('a rejected tag lands in the REJECTED bucket, not deleted',
    state.rejected.includes(tagRow.name), JSON.stringify(state))

  // Rejection memory: same version must not be re-offered.
  const sameVersion = await tags.suggestionAllowed(db, 'art_1', tagRow.id, 'art_1_v1')
  check('a rejected tag is NOT re-suggested against the same version', sameVersion === false)

  // A materially new version is a new basis, so it may be offered again.
  const newVersion = await tags.suggestionAllowed(db, 'art_1', tagRow.id, 'art_1_v2')
  check('a rejected tag MAY be re-suggested after a new version', newVersion === true)

  // Accepting flips the same row to CONFIRMED rather than adding a second one.
  await tags.decideTag(db, member, 'art_1', tagRow.id, 'CONFIRMED', 'USER', 'art_1_v1')
  state = await tags.tagsByState(db, 'art_1')
  check('accepting a previously rejected tag moves it to CONFIRMED',
    state.confirmed.includes(tagRow.name) && !state.rejected.includes(tagRow.name),
    JSON.stringify(state))

  const rowCount = db.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM artifact_tags WHERE artifact_id = 'art_1' AND tag_id = ?`)
    .get(tagRow.id).n
  check('one row per (artifact, tag): decisions are updates, not accumulating duplicates',
    rowCount === 1, `rows: ${rowCount}`)

  const reSuggest = await tags.suggestionAllowed(db, 'art_1', tagRow.id, 'art_1_v1')
  check('a CONFIRMED tag is never re-suggested', reSuggest === false)
}

{
  const db = seedBase()
  addArtifact(db, {
    id: 'art_2', workspaceId: 'ws_fin', orgId: 'org_a', ownerId: 'usr_admin',
    title: 'Deck', body: 'x'
  })
  const member = principalFor('usr_member', { orgRoles: { org_a: 'MEMBER' } })

  const outcome = await tags.decideTags(
    db, member,
    { id: 'art_2', organization_id: 'org_a', current_version_id: 'art_2_v1' },
    { reject: ['Not A Real Tag'] }
  )
  check('rejecting a name that is not a tag is a no-op, not an error',
    outcome.rejected.length === 0, JSON.stringify(outcome))

  let threw = false
  try {
    await tags.decideTags(
      db, member,
      { id: 'art_2', organization_id: 'org_a', current_version_id: 'art_2_v1' },
      { add: ['diagnosis'] }
    )
  } catch {
    threw = true
  }
  check('a sensitive attribute is refused even when a person types it explicitly', threw)
}

// ---------------------------------------------------------------
section('3. Case-insensitive dedupe (requirement 6)')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, {
    id: 'art_3', workspaceId: 'ws_fin', orgId: 'org_a', ownerId: 'usr_admin',
    title: 'Deck', body: 'x'
  })
  const admin = principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } })

  await tags.addTagToArtifact(db, admin, 'art_3', 'AI', 'org_a')
  const b = await tags.addTagToArtifact(db, admin, 'art_3', 'ai', 'org_a')
  const c = await tags.addTagToArtifact(db, admin, 'art_3', 'Ai', 'org_a')

  const n = db.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM tags WHERE slug = 'ai'`).get().n
  check('"AI", "ai" and "Ai" collapse to a single tag row', n === 1, `rows: ${n}`)
  check('the second and third spellings reuse the existing tag',
    b.created === false && c.created === false)

  const state = await tags.tagsByState(db, 'art_3')
  check('the artifact carries one tag, not three spellings', state.confirmed.length === 1,
    JSON.stringify(state.confirmed))
}

// ---------------------------------------------------------------
section('4. Organization tag policy (requirement 6)')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, {
    id: 'art_4', workspaceId: 'ws_fin', orgId: 'org_a', ownerId: 'usr_admin',
    title: 'Deck', body: 'x'
  })
  const member = principalFor('usr_member', { orgRoles: { org_a: 'MEMBER' } })

  check('by default a plain member may create a tag',
    (await tags.mayCreateTag(db, member, 'org_a')) === true)

  db.sqlite
    .prepare(`UPDATE organizations SET settings_json = ? WHERE id = 'org_a'`)
    .run(JSON.stringify({ allowUserTags: false }))

  check('an explicit policy of false disables user-created tags',
    (await tags.mayCreateTag(db, member, 'org_a')) === false)
  check('an organization admin is the policy, so they are unaffected',
    (await tags.mayCreateTag(db, principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } }), 'org_a')) === true)

  let threw = false
  let message = ''
  try {
    await tags.addTagToArtifact(db, member, 'art_4', 'brand new tag', 'org_a')
  } catch (e) {
    threw = true
    message = e.message
  }
  check('under the policy a member cannot invent a new tag', threw)
  check('the refusal explains that existing tags still work',
    /existing tag/i.test(message), message)

  // The policy must not take away the ability to apply what already exists.
  await tags.addTagToArtifact(db, principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } }), 'art_4', 'existing tag', 'org_a')
  const reused = await tags.addTagToArtifact(db, member, 'art_4', 'existing tag', 'org_a')
  check('the policy blocks invention but not applying an existing tag',
    reused.created === false, JSON.stringify(reused))
}

// ---------------------------------------------------------------
section('5. Search indexes CONFIRMED tags only')
// ---------------------------------------------------------------

{
  const db = seedBase()
  addArtifact(db, {
    id: 'art_5', workspaceId: 'ws_fin', orgId: 'org_a', ownerId: 'usr_admin',
    title: 'Budget forecast', body: 'revenue projections'
  })
  const admin = principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } })
  const member = principalFor('usr_member', { orgRoles: { org_a: 'MEMBER' } })

  const { tag } = await tags.resolveOrCreateTag(db, admin, 'board prep', {
    organizationId: 'org_a', provenance: 'USER'
  })

  // A SUGGESTED (machine-proposed, not yet accepted) tag must not be searchable.
  // Signature: (db, artifactId, tags[{tagId,name}], sourceVersionId).
  await tags.applySuggestions(db, 'art_5', [{ tagId: tag.id, name: tag.name }], 'art_5_v1')

  const afterSuggest = db.sqlite
    .prepare(`SELECT state FROM artifact_tags WHERE artifact_id = 'art_5' AND tag_id = ?`)
    .get(tag.id)
  check('the suggestion is stored as SUGGESTED, not CONFIRMED',
    afterSuggest?.state === 'SUGGESTED', String(afterSuggest?.state))

  await search.indexArtifact(db, 'art_5')

  let filters = await search.searchArtifacts(db, member, { query: '', tagSlugs: ['board-prep'] })
  check('a SUGGESTED tag does not make an artifact findable by that tag',
    filters.hits.length === 0, `hits: ${filters.hits.length}`)

  // Confirming it makes the tag real.
  await tags.decideTag(db, member, 'art_5', tag.id, 'CONFIRMED', 'USER', 'art_5_v1')
  await search.indexArtifact(db, 'art_5')

  filters = await search.searchArtifacts(db, member, { query: '', tagSlugs: ['board-prep'] })
  check('a CONFIRMED tag IS searchable',
    filters.hits.some((h) => h.artifact.id === 'art_5'), `hits: ${filters.hits.length}`)

  // Rejecting removes it from the index again.
  await tags.decideTag(db, member, 'art_5', tag.id, 'REJECTED', 'USER', 'art_5_v1')
  await search.indexArtifact(db, 'art_5')
  filters = await search.searchArtifacts(db, member, { query: '', tagSlugs: ['board-prep'] })
  check('a REJECTED tag leaves the search index',
    filters.hits.length === 0, `hits: ${filters.hits.length}`)
}

// ---------------------------------------------------------------
section('6. Teams as reusable audiences (requirement 4)')
// ---------------------------------------------------------------

let sharedDb = null
let finTeamId = null

{
  const db = seedBase()
  sharedDb = db
  const admin = principalFor('usr_admin', { orgRoles: { org_a: 'ORG_OWNER' } })
  const member = principalFor('usr_member', { orgRoles: { org_a: 'MEMBER' } })

  const team = await teams.createTeam(db, admin, {
    name: 'Board prep',
    organizationId: 'org_a',
    members: ['usr_member@example.com']
  })
  finTeamId = team.id

  check('creating a team adds the creator as an active admin member',
    (await teams.activeMemberEmails(db, team.id)).includes('usr_admin@example.com'))

  const found = await teams.resolveTeamByName(db, admin, 'Board prep')
  check('a team resolves by its exact name', found.status === 'FOUND' && found.team.id === team.id,
    JSON.stringify(found.status))

  const bySlug = await teams.resolveTeamByName(db, admin, 'board-prep')
  check('a team resolves by its canonical slug too',
    bySlug.status === 'FOUND' && bySlug.team.id === team.id, JSON.stringify(bySlug.status))

  const missing = await teams.resolveTeamByName(db, admin, 'Nonexistent')
  check('an unknown name is NOT_FOUND rather than the nearest match',
    missing.status === 'NOT_FOUND', JSON.stringify(missing.status))

  // A plain member cannot create an org-wide audience.
  let threw = false
  try {
    await teams.createTeam(db, member, { name: 'Shadow board', organizationId: 'org_a' })
  } catch {
    threw = true
  }
  check('only an org admin may create an organization-wide team', threw)

  // ...and cannot manage someone else's team.
  threw = false
  try {
    await teams.addTeamMember(db, member, team.id, 'usr_other@example.com')
  } catch {
    threw = true
  }
  check('a non-admin member cannot add people to another user\'s team', threw)

  // The last admin is protected, so a team cannot be left unadministrable.
  threw = false
  try {
    await teams.removeTeamMember(db, admin, team.id, 'usr_admin@example.com')
  } catch (e) {
    threw = true
  }
  check('removing the last active admin is refused', threw)
}

{
  // Ambiguity is the interesting case: two organizations may each have a
  // "Board prep", and picking one would be a coin flip on a confidential
  // document.
  const db = sharedDb
  const admin = principalFor('usr_admin', {
    orgRoles: { org_a: 'ORG_OWNER', org_b: 'ORG_OWNER' }
  })

  db.insert('organizations', {
    id: 'org_b', name: 'Beta Corp', slug: 'beta', plan: 'FREE', max_upload_bytes: 1000000,
    settings_json: '{}', status: 'ACTIVE', created_by: 'usr_admin', created_at: T, updated_at: T
  })

  // A second team with the same name in a different organization. The unique
  // index is per (organization_id, slug), so this is legitimate.
  db.insert('teams', {
    id: 'team_dup', organization_id: 'org_b', workspace_id: null, scope: 'ORGANIZATION',
    name: 'Board prep', slug: 'board-prep', description: null,
    owner_user_id: 'usr_admin', status: 'ACTIVE', created_by: 'usr_admin',
    created_at: T, updated_at: T
  })
  db.insert('team_members', {
    id: 'tmb_dup', team_id: 'team_dup', user_id: 'usr_admin',
    email_normalized: 'usr_admin@example.com', display_name: 'Amara Admin',
    role: 'ADMIN', status: 'ACTIVE', created_at: T, created_by: 'usr_admin'
  })

  const resolution = await teams.resolveTeamByName(db, admin, 'Board prep')
  check('a name matching two accessible teams returns AMBIGUOUS',
    resolution.status === 'AMBIGUOUS', JSON.stringify(resolution.status))
  check('the ambiguous result carries the candidates so the user can choose',
    resolution.status === 'AMBIGUOUS' && resolution.candidates.length === 2,
    resolution.status === 'AMBIGUOUS' ? String(resolution.candidates.length) : 'n/a')
  check('the candidates name their organization, so the choice is meaningful',
    resolution.status === 'AMBIGUOUS' &&
      resolution.candidates.every((c) => !!c.organization_id))

  // Disambiguation by id must still work.
  const pinned = await teams.resolveTeamByName(db, admin, 'team_dup')
  check('supplying the team id disambiguates', pinned.status === 'FOUND' && pinned.team.id === 'team_dup')
}

{
  // Cross-tenant safety: a team may not be used for an artifact in another org.
  const db = sharedDb
  const admin = principalFor('usr_admin', {
    orgRoles: { org_a: 'ORG_OWNER', org_b: 'ORG_OWNER' }
  })

  addArtifact(db, {
    id: 'art_personal', workspaceId: 'ws_personal', orgId: null, ownerId: 'usr_member',
    title: 'Private notes', body: 'mine'
  })

  let threw = false
  let message = ''
  try {
    const team = await teams.loadTeam(db, finTeamId)
    await teams.assertTeamUsableForArtifact(db, admin, team, {
      organization_id: null, workspace_id: 'ws_personal'
    })
  } catch (e) {
    threw = true
    message = e.message
  }
  check('a team cannot be used for an artifact in a personal workspace', threw)
  check('and the refusal explains why', /organization-scoped/i.test(message), message)

  threw = false
  try {
    const otherTeam = await teams.loadTeam(db, 'team_dup')
    await teams.assertTeamUsableForArtifact(db, admin, otherTeam, {
      organization_id: 'org_a', workspace_id: 'ws_fin'
    })
  } catch {
    threw = true
  }
  check('a team from another organization cannot be used for this artifact', threw)

  // An empty team has nobody to share with.
  const emptyTeam = await teams.createTeam(db, admin, { name: 'Empty Audience', organizationId: 'org_a' })
  db.sqlite.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(emptyTeam.id)
  threw = false
  try {
    await teams.assertTeamUsableForArtifact(db, admin, emptyTeam, {
      organization_id: 'org_a', workspace_id: 'ws_fin'
    })
  } catch {
    threw = true
  }
  check('a team with no active members cannot be shared with', threw)
}

// ---------------------------------------------------------------
section('7. Confirmation gate (requirement 3)')
// ---------------------------------------------------------------

{
  const db = sharedDb
  const user = principalFor('usr_admin', { grantId: 'grt_1' })
  const other = principalFor('usr_member')

  const P1 = { artifact_id: 'art_a', access_type: 'PUBLIC_LINK', permission: 'view', expires_in_days: 7 }
  const P2 = { artifact_id: 'art_a', access_type: 'PUBLIC_LINK', permission: 'view', expires_in_days: 30 }

  const row = await confirmations.createConfirmation(db, user, {
    tool: 'share', params: P1, summary: 'Share publicly', audienceNote: 'public link'
  })
  check('a confirmation starts PENDING', row.status === 'PENDING')

  // THE security property: consent for one request cannot execute another.
  const widened = await confirmations.consumeConfirmation(db, user, row.id, 'share', P2)
  check('a MODIFIED request cannot consume the confirmation',
    widened.ok === false && widened.reason === 'MISMATCH', JSON.stringify(widened))

  const stillPending = db.sqlite
    .prepare(`SELECT status FROM mcp_confirmations WHERE id = ?`).get(row.id).status
  check('the failed attempt left the confirmation PENDING rather than burning it',
    stillPending === 'PENDING', stillPending)

  const wrongUser = await confirmations.consumeConfirmation(db, other, row.id, 'share', P1)
  check('another user cannot consume the confirmation',
    wrongUser.ok === false && wrongUser.reason === 'WRONG_USER', JSON.stringify(wrongUser))

  const wrongTool = await confirmations.consumeConfirmation(db, user, row.id, 'save', P1)
  check('the confirmation is bound to its tool as well as its arguments',
    wrongTool.ok === false && wrongTool.reason === 'MISMATCH', JSON.stringify(wrongTool))

  // Key order must not matter: the hash is over a normalised request.
  const reordered = {
    expires_in_days: 7, permission: 'view', access_type: 'PUBLIC_LINK', artifact_id: 'art_a'
  }
  const ok = await confirmations.consumeConfirmation(db, user, row.id, 'share', reordered)
  check('an identically-meaning request with a different key order DOES consume it',
    ok.ok === true, JSON.stringify(ok))

  const again = await confirmations.consumeConfirmation(db, user, row.id, 'share', P1)
  check('a confirmation is single-use', again.ok === false && again.reason === 'ALREADY_USED',
    JSON.stringify(again))
}

{
  const db = sharedDb
  const user = principalFor('usr_admin')

  const row = await confirmations.createConfirmation(db, user, {
    tool: 'share', params: { artifact_id: 'art_a', public: true },
    summary: 'Share publicly', audienceNote: 'public link'
  })
  db.sqlite
    .prepare(`UPDATE mcp_confirmations SET expires_at = ? WHERE id = ?`)
    .run('2020-01-01T00:00:00.000Z', row.id)

  const expired = await confirmations.consumeConfirmation(
    db, user, row.id, 'share', { artifact_id: 'art_a', public: true }
  )
  check('an expired confirmation is refused with a distinct reason',
    expired.ok === false && expired.reason === 'EXPIRED', JSON.stringify(expired))

  const unknown = await confirmations.consumeConfirmation(db, user, 'cnf_nope', 'share', {})
  check('an unknown confirmation id is NOT_FOUND',
    unknown.ok === false && unknown.reason === 'NOT_FOUND', JSON.stringify(unknown))
}

{
  // The prompt itself must be unambiguous that nothing has happened yet.
  const prompt = confirmations.confirmationPrompt({
    id: 'cnf_1', user_id: 'usr_admin', grant_id: null, tool: 'share',
    request_hash: 'h', params_json: '{}', summary: 'Share "Deck" with anyone with the link',
    audience_note: 'public link', status: 'PENDING',
    created_at: T, expires_at: '2026-01-01T00:15:00.000Z', consumed_at: null
  })
  check('the confirmation prompt tells the model the state is confirmation_required',
    prompt.status === 'confirmation_required', JSON.stringify(prompt.status))
  check('the prompt states plainly that nothing has been shared yet',
    /nothing has been shared/i.test(prompt.safety), prompt.safety)
  check('the prompt carries the id needed to proceed', prompt.confirmation_id === 'cnf_1')
}

// ---------------------------------------------------------------
section('8. MCP transport + provenance (requirements 8, 9)')
// ---------------------------------------------------------------

{
  const expected = [
    'search', 'get', 'save', 'create_version', 'share',
    'list_workspaces', 'list_teams', 'list_tags', 'update_tags'
  ]
  const names = mcp.MCP_TOOLS.map((t) => t.name)
  for (const name of expected) {
    check(`tool "${name}" is exposed`, names.includes(name))
  }
  check('revoke_share is exposed so a share can be withdrawn',
    names.includes('revoke_share'))
  check('every tool declares the scope it needs',
    mcp.MCP_TOOLS.every((t) => typeof t.requiredScope === 'string' && t.requiredScope.length > 0))
  check('every tool declares an input schema',
    mcp.MCP_TOOLS.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
}

{
  const db = sharedDb
  const grant = principalFor('usr_admin', {
    kind: 'AI_GRANT', orgRoles: { org_a: 'ORG_OWNER' },
    scopes: ['artifact.read', 'workspace.read', 'team.read', 'tags.read'],
    integrationId: 'int_1', grantId: 'grt_1', provider: 'ANTHROPIC'
  })

  db.insert('integrations', {
    id: 'int_1', provider: 'ANTHROPIC', name: 'Claude', description: null,
    status: 'ACTIVE', created_at: T, updated_at: T
  })
  db.insert('integration_grants', {
    id: 'grt_1', integration_id: 'int_1', user_id: 'usr_admin', organization_id: null,
    scopes: JSON.stringify(grant.scopes), token_hash: 'th', token_prefix: 'p',
    status: 'ACTIVE', created_at: T, last_used_at: null, revoked_at: null,
    client_name: null, client_version: null
  })

  const env = { DB: db, R2: {}, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '1000000' }

  const init = await mcp.handleMcpRequest(env, grant, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'Claude Desktop', version: '1.2.3' } }
  })
  check('initialize succeeds', init.error === undefined, JSON.stringify(init.error))
  check('initialize reports the MCP protocol version',
    init.result.protocolVersion === '2025-06-18', String(init.result.protocolVersion))
  check('initialize returns server instructions describing the three jobs',
    /search/i.test(init.result.instructions) && /save/i.test(init.result.instructions) &&
      /share/i.test(init.result.instructions))
  check('the instructions warn that sharing beyond the organization needs confirmation',
    /confirm/i.test(init.result.instructions))

  const stored = db.sqlite
    .prepare(`SELECT client_name, client_version FROM integration_grants WHERE id = 'grt_1'`)
    .get()
  check('the reported AI client name is recorded on the grant (requirement 9)',
    stored.client_name === 'Claude Desktop', String(stored.client_name))
  check('the client version is recorded too', stored.client_version === '1.2.3',
    String(stored.client_version))

  const list = await mcp.handleMcpRequest(env, grant, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  check('tools/list returns the catalogue with input schemas',
    list.result.tools.length === mcp.MCP_TOOLS.length &&
      list.result.tools.every((t) => t.inputSchema && t.description))

  const ping = await mcp.handleMcpRequest(env, grant, { jsonrpc: '2.0', id: 3, method: 'ping' })
  check('ping is answered', ping.error === undefined && ping.result !== undefined)

  const badMethod = await mcp.handleMcpRequest(env, grant, { jsonrpc: '2.0', id: 4, method: 'nope' })
  check('an unsupported method returns -32601',
    badMethod.error?.code === -32601, JSON.stringify(badMethod.error))

  const unknownTool = await mcp.handleMcpRequest(env, grant, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'search_artifacts', arguments: {} }
  })
  check('a legacy/low-level tool name is no longer callable',
    unknownTool.error?.code === -32602, JSON.stringify(unknownTool.error))

  const teamsCall = await mcp.handleMcpRequest(env, grant, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'list_teams', arguments: {} }
  })
  check('list_teams runs and returns the audiences the caller can use',
    teamsCall.result?.isError === false &&
      Array.isArray(teamsCall.result.structuredContent?.teams) &&
      teamsCall.result.structuredContent.teams.some((t) => t.name === 'Board prep'),
    JSON.stringify(teamsCall.result?.structuredContent)?.slice(0, 200))
}

{
  // Scope enforcement: a grant without team.read must not reach list_teams.
  const db = sharedDb
  const narrow = principalFor('usr_admin', {
    kind: 'AI_GRANT', orgRoles: { org_a: 'ORG_OWNER' },
    scopes: ['artifact.read'], grantId: 'grt_1', provider: 'ANTHROPIC'
  })
  const env = { DB: db, R2: {}, APP_NAME: 'artifactry', MAX_UPLOAD_BYTES: '1000000' }

  const res = await mcp.handleMcpRequest(env, narrow, {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'list_teams', arguments: {} }
  })
  check('a tool call is refused when the grant lacks its scope',
    res.error !== undefined && /team\.read/.test(res.error.message), JSON.stringify(res.error))

  const save = await mcp.handleMcpRequest(env, narrow, {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'save', arguments: { file: 'x.txt', content: 'hi', format: 'pdf' } }
  })
  check('a read-only grant cannot call a write tool',
    save.error !== undefined && /artifact\.write/.test(save.error.message),
    JSON.stringify(save.error))
}

{
  // An AI grant must never manage teams: there is no team.write scope, so the
  // manage path has to fall through to a refusal rather than to `true`.
  const db = sharedDb
  const ai = principalFor('usr_admin', {
    kind: 'AI_GRANT', orgRoles: { org_a: 'ORG_OWNER' },
    scopes: ['artifact.read', 'artifact.write', 'artifact.share', 'team.read'],
    grantId: 'grt_1', provider: 'ANTHROPIC'
  })

  let threw = false
  try {
    const team = await teams.loadTeam(db, finTeamId)
    await teams.assertTeamManageable(db, ai, team)
  } catch {
    threw = true
  }
  check('an AI grant cannot manage a team even when it holds team.read', threw)
}

// ---------------------------------------------------------------

console.log(`\n${'='.repeat(52)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures) {
  console.log('MCP JOB TESTS FAILED')
  process.exit(1)
}
console.log('ALL MCP JOB TESTS PASSED')
