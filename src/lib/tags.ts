/**
 * Tag service — the AI-suggested / human-decided model (migration 0006).
 *
 * Replaces "tags are admin-governed, users may only apply existing ones" with:
 *
 *   * a tag association carries a STATE (SUGGESTED / CONFIRMED / REJECTED)
 *     and a PROVENANCE (AI / USER / ADMIN);
 *   * users may create new tags;
 *   * rejection is remembered, so the same suggestion is not re-offered against
 *     unchanged content.
 *
 * Case-insensitive normalization is not a new mechanism: `slugify` already
 * lowercases, and `tags` is UNIQUE(scope, organization_id, slug). So "AI",
 * "ai" and "Ai" all resolve to the same slug "ai" and therefore the same row.
 * The work is to *look up by slug* rather than by name, everywhere.
 *
 * Search indexing reads CONFIRMED tags only (see search.ts). A SUGGESTED tag is
 * a proposal the user has not acted on; making it searchable would let a
 * machine guess silently change what the library can find. A REJECTED tag is a
 * decision the user made — it must never surface in a search facet.
 */

import type { Env, Principal, TagProvenance, TagRow, TagState } from '../types'
import { all, first, nowIso, run } from './db'
import { prefixed, slugify, ulid } from './ids'
import { badRequest, forbidden } from './http'
import { recordAudit } from './audit'
import { filterSuggestions, blockReason, suggestTags, MAX_TAGS } from './autotag'

export interface ArtifactTagView {
  tag_id: string
  name: string
  slug: string
  state: TagState
  provenance: TagProvenance
  scope: string
  organization_id: string | null
  /** True when the association was decided by a person. */
  decided: boolean
}

/** States that are visible as the artifact's tags in the product UI. */
const VISIBLE_STATES: TagState[] = ['CONFIRMED', 'SUGGESTED']

// ---------------------------------------------------------------
// Reading
// ---------------------------------------------------------------

export async function artifactTagViews(
  db: D1Database,
  artifactId: string,
  options: { includeRejected?: boolean } = {}
): Promise<ArtifactTagView[]> {
  const states = options.includeRejected ? [...VISIBLE_STATES, 'REJECTED'] : VISIBLE_STATES

  const rows = await all<{
    tag_id: string
    name: string
    slug: string
    state: string
    provenance: string
    scope: string
    organization_id: string | null
    decided_at: string | null
  }>(
    db,
    `SELECT t.id AS tag_id, t.name, t.slug, at.state, at.provenance,
            t.scope, t.organization_id, at.decided_at
       FROM artifact_tags at
       JOIN tags t ON t.id = at.tag_id
      WHERE at.artifact_id = ?
        AND at.state IN (${states.map(() => '?').join(',')})
        AND t.status = 'ACTIVE'
      ORDER BY CASE at.state WHEN 'CONFIRMED' THEN 0 ELSE 1 END, t.name ASC`,
    [artifactId, ...states]
  )

  return rows.map((row) => ({
    tag_id: row.tag_id,
    name: row.name,
    slug: row.slug,
    state: row.state as TagState,
    provenance: row.provenance as TagProvenance,
    scope: row.scope,
    organization_id: row.organization_id,
    decided: row.state === 'CONFIRMED' || row.state === 'REJECTED'
  }))
}

/** Confirm-only names — what the search index and `tagsForArtifact` report. */
export async function confirmedTagNames(db: D1Database, artifactId: string): Promise<string[]> {
  const rows = await all<{ name: string }>(
    db,
    `SELECT t.name FROM artifact_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.artifact_id = ? AND at.state = 'CONFIRMED' AND t.status = 'ACTIVE'
      ORDER BY t.name ASC`,
    [artifactId]
  )
  return rows.map((r) => r.name)
}

// ---------------------------------------------------------------
// Tag resolution / creation
// ---------------------------------------------------------------

/**
 * Organization tag policy.
 *
 * Absent means allowed: the product decision was to let users tag their own
 * work, so only an explicit `false` disables it for an organization.
 */
export async function userTagsAllowed(
  db: D1Database,
  organizationId: string | null
): Promise<boolean> {
  if (!organizationId) return true
  const row = await first<{ settings_json: string }>(
    db,
    `SELECT settings_json FROM organizations WHERE id = ?`,
    [organizationId]
  )
  if (!row) return true
  try {
    const settings = JSON.parse(row.settings_json) as { allowUserTags?: unknown }
    return settings.allowUserTags !== false
  } catch {
    return true
  }
}

/**
 * Find the tag for a name, creating it if permitted.
 *
 * `scope` follows the artifact: a tag used inside an organization becomes part
 * of that organization's shared vocabulary so colleagues can reuse it, while a
 * personal-workspace tag stays personal. Matching is by slug, so a name that
 * differs only in case or punctuation resolves to the existing tag rather than
 * creating a near-duplicate.
 */
export async function resolveOrCreateTag(
  db: D1Database,
  principal: Principal,
  rawName: string,
  context: { organizationId: string | null; provenance: TagProvenance }
): Promise<{ tag: TagRow; created: boolean }> {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw badRequest('Tag name is required')
  if (name.length > 40) throw badRequest('Tag names must be 40 characters or fewer')

  const slug = slugify(name, 48)
  if (!slug) throw badRequest('Tag name must contain at least one letter or number')

  const scope = context.organizationId ? 'ORGANIZATION' : 'PERSONAL'
  const organizationId = scope === 'ORGANIZATION' ? context.organizationId : null

  // Exact-scope match first.
  const exact = await first<TagRow>(
    db,
    `SELECT * FROM tags
      WHERE scope = ? AND COALESCE(organization_id, '') = COALESCE(?, '') AND slug = ?`,
    [scope, organizationId, slug]
  )
  if (exact) {
    // Reuse of a deactivated tag is not silent reactivation.
    if (exact.status !== 'ACTIVE') {
      await run(db, `UPDATE tags SET status = 'ACTIVE', updated_at = ? WHERE id = ?`, [
        nowIso(),
        exact.id
      ])
    }
    return { tag: exact, created: false }
  }

  // An organization tag may also satisfy a request inside that organization
  // even when the artifact is in a personal workspace — a shared canonical tag
  // should not be shadowed by a personal copy.
  if (scope === 'PERSONAL') {
    const orgWide = await first<TagRow>(
      db,
      `SELECT * FROM tags WHERE scope = 'PERSONAL' AND organization_id IS NULL AND slug = ? AND status = 'ACTIVE'`,
      [slug]
    )
    if (orgWide) return { tag: orgWide, created: false }
  }

  // Creating a tag requires the policy to permit it.
  //
  // This defers to `mayCreateTag`, which is the single place the policy lives:
  // an organization admin is the policy and is always allowed, everyone else
  // depends on the organization's `allowUserTags` setting. An earlier version
  // of this check exempted only `provenance === 'ADMIN'`, which meant an org
  // admin adding a tag through the ordinary artifact path was still treated as
  // a mere user — so an organization that disabled user tags could never
  // extend its own canonical set again. The provenance of a *suggestion* has
  // no bearing on whether the *person* may define a tag.
  if (context.provenance !== 'ADMIN') {
    const allowed = await mayCreateTag(db, principal, organizationId)
    if (!allowed) {
      throw forbidden(
        'This organization has disabled user-created tags. Apply an existing tag instead.'
      )
    }
  }

  const tagId = prefixed('tag', ulid())
  const timestamp = nowIso()

  await run(
    db,
    `INSERT INTO tags
       (id, organization_id, scope, name, slug, description, color, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE', ?, ?, ?)`,
    [tagId, organizationId, scope, name, slug, principal.userId, timestamp, timestamp]
  )

  await recordAudit(db, {
    organizationId,
    actorUserId: principal.userId,
    actorType: context.provenance === 'AI' ? 'AI' : 'USER',
    action: 'TAG_CREATE',
    targetType: 'tag',
    targetId: tagId,
    metadata: { name, slug, scope, provenance: context.provenance }
  })

  const created = await first<TagRow>(db, `SELECT * FROM tags WHERE id = ?`, [tagId])
  if (!created) throw new Error('Failed to create tag')
  return { tag: created, created: true }
}

// ---------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------

/**
 * Whether a suggestion may be made for this artifact again.
 *
 * A REJECTED tag is only re-offered when the content changed materially — i.e.
 * a different version produced the suggestion. Re-proposing the same tag on the
 * same bytes would be ignoring an explicit decision, which is the behaviour the
 * product requirement calls out.
 */
export async function suggestionAllowed(
  db: D1Database,
  artifactId: string,
  tagId: string,
  currentVersionId: string | null
): Promise<boolean> {
  const existing = await first<{ state: string; source_version_id: string | null }>(
    db,
    `SELECT state, source_version_id FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`,
    [artifactId, tagId]
  )
  if (!existing) return true
  if (existing.state === 'CONFIRMED') return false // already decided; nothing to suggest

  if (existing.state === 'REJECTED') {
    // Same version (or an unknown prior source) => the user's rejection stands.
    if (!currentVersionId) return false
    return existing.source_version_id !== currentVersionId
  }

  // SUGGESTED already: refresh the source version so a later rejection is
  // correctly attributed to the content that produced it.
  return true
}

async function upsertState(
  db: D1Database,
  artifactId: string,
  tagId: string,
  state: TagState,
  provenance: TagProvenance,
  actorUserId: string | null,
  sourceVersionId: string | null
): Promise<{ changed: boolean }> {
  const timestamp = nowIso()
  const decided = state !== 'SUGGESTED'

  const existing = await first<{ id: string; state: string }>(
    db,
    `SELECT id, state FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`,
    [artifactId, tagId]
  )

  if (!existing) {
    await run(
      db,
      `INSERT INTO artifact_tags
         (id, artifact_id, tag_id, assigned_by, assigned_at, state, provenance,
          source_version_id, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prefixed('atg', ulid()),
        artifactId,
        tagId,
        actorUserId,
        timestamp,
        state,
        provenance,
        sourceVersionId,
        decided ? actorUserId : null,
        decided ? timestamp : null
      ]
    )
    return { changed: true }
  }

  if (existing.state === state) {
    // Same state: still refresh the source version for suggestions so the
    // rejection memory tracks the newest content it was derived from.
    if (state === 'SUGGESTED') {
      await run(db, `UPDATE artifact_tags SET source_version_id = ? WHERE id = ?`, [
        sourceVersionId,
        existing.id
      ])
    }
    return { changed: false }
  }

  await run(
    db,
    `UPDATE artifact_tags
        SET state = ?, provenance = ?, source_version_id = ?,
            decided_by = ?, decided_at = ?
      WHERE id = ?`,
    [
      state,
      provenance,
      sourceVersionId,
      decided ? actorUserId : null,
      decided ? timestamp : null,
      existing.id
    ]
  )
  return { changed: true }
}

export async function applySuggestions(
  db: D1Database,
  artifactId: string,
  tags: Array<{ tagId: string; name: string }>,
  sourceVersionId: string | null
): Promise<string[]> {
  const applied: string[] = []
  for (const { tagId, name } of tags) {
    if (!(await suggestionAllowed(db, artifactId, tagId, sourceVersionId))) continue
    const { changed } = await upsertState(
      db,
      artifactId,
      tagId,
      'SUGGESTED',
      'AI',
      null,
      sourceVersionId
    )
    if (changed) applied.push(name)
  }
  return applied
}

/** Accept (CONFIRMED) or reject (REJECTED) a tag on an artifact. */
export async function decideTag(
  db: D1Database,
  principal: Principal,
  artifactId: string,
  tagId: string,
  state: 'CONFIRMED' | 'REJECTED',
  provenance: TagProvenance = 'USER',
  sourceVersionId: string | null = null
): Promise<void> {
  await upsertState(db, artifactId, tagId, state, provenance, principal.userId, sourceVersionId)
  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: provenance === 'AI' ? 'AI' : 'USER',
    action: state === 'CONFIRMED' ? 'TAG_ACCEPT' : 'TAG_REJECT',
    targetType: 'artifact',
    targetId: artifactId,
    // The version the decision was made against is recorded because it is what
    // licenses re-proposing a rejected tag later: a rejection is a judgement
    // about specific content, not a permanent ban on the word.
    metadata: { tagId, state, provenance, sourceVersionId }
  })
}

/** Manual add: creating or reusing a tag and confirming it in one step. */
export async function addTagToArtifact(
  db: D1Database,
  principal: Principal,
  artifactId: string,
  rawName: string,
  organizationId: string | null
): Promise<{ name: string; created: boolean }> {
  const { tag, created } = await resolveOrCreateTag(db, principal, rawName, {
    organizationId,
    provenance: 'USER'
  })
  await upsertState(db, artifactId, tag.id, 'CONFIRMED', 'USER', principal.userId, null)
  return { name: tag.name, created }
}

export async function removeTagFromArtifact(
  db: D1Database,
  artifactId: string,
  tagId: string
): Promise<void> {
  await run(db, `DELETE FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`, [
    artifactId,
    tagId
  ])
}

export async function findTagBySlug(
  db: D1Database,
  slug: string,
  organizationId: string | null = null
): Promise<TagRow | null> {
  // Scope first: the same name may legitimately exist as both a personal and an
  // organization tag, and resolving the wrong one would attach a decision to a
  // tag the user never saw.
  const scoped = await first<TagRow>(
    db,
    `SELECT * FROM tags
      WHERE slug = ? AND status = 'ACTIVE'
        AND COALESCE(organization_id, '') = COALESCE(?, '')
      LIMIT 1`,
    [slug, organizationId]
  )
  if (scoped) return scoped

  return first<TagRow>(
    db,
    `SELECT * FROM tags WHERE slug = ? AND status = 'ACTIVE' ORDER BY organization_id IS NULL DESC LIMIT 1`,
    [slug]
  )
}

// ---------------------------------------------------------------
// Policy
// ---------------------------------------------------------------

/**
 * Whether this principal may invent a new tag right now.
 *
 * An organization admin *is* the policy, so they are always allowed. Everyone
 * else depends on the organization's `allowUserTags` setting, which defaults to
 * permitted — the product decision is that people may file their own work.
 */
export async function mayCreateTag(
  db: D1Database,
  principal: Principal,
  organizationId: string | null
): Promise<boolean> {
  if (!organizationId) return true
  const role = principal.orgRoles[organizationId]
  if (role === 'ORG_OWNER' || role === 'ORG_ADMIN') return true
  return userTagsAllowed(db, organizationId)
}

// ---------------------------------------------------------------
// The three views the product shows, and the decision endpoint
// ---------------------------------------------------------------

export interface ArtifactTags {
  confirmed: string[]
  suggested: string[]
  rejected: string[]
}

/**
 * An artifact's tags split by state.
 *
 * The UI needs all three: CONFIRMED is what the artifact is, SUGGESTED is what
 * the user is being asked about, and REJECTED is shown so a decision can be
 * reversed without the suggestion reappearing on its own.
 */
export async function tagsByState(db: D1Database, artifactId: string): Promise<ArtifactTags> {
  const rows = await artifactTagViews(db, artifactId, { includeRejected: true })

  const out: ArtifactTags = { confirmed: [], suggested: [], rejected: [] }
  for (const row of rows) {
    if (row.state === 'CONFIRMED') out.confirmed.push(row.name)
    else if (row.state === 'SUGGESTED') out.suggested.push(row.name)
    else out.rejected.push(row.name)
  }

  out.confirmed.sort((a, b) => a.localeCompare(b))
  out.suggested.sort((a, b) => a.localeCompare(b))
  out.rejected.sort((a, b) => a.localeCompare(b))
  return out
}

export interface DecideOutcome {
  accepted: string[]
  rejected: string[]
  added: string[]
}

/**
 * Apply a person's tag decisions to an artifact.
 *
 *   accept → CONFIRMED (the tag is created if the name is new to the taxonomy,
 *            because typing a name and accepting it is the same act)
 *   reject → REJECTED, bound to the current version, which is what suppresses
 *            re-suggestion until the content materially changes
 *   add    → CONFIRMED, provenance USER rather than AI
 */
export async function decideTags(
  db: D1Database,
  principal: Principal,
  artifact: { id: string; organization_id: string | null; current_version_id?: string | null },
  decision: { accept?: unknown; reject?: unknown; add?: unknown }
): Promise<DecideOutcome> {
  if (!principal.userId) throw forbidden('Sign in to change tags')

  const acceptList = Array.isArray(decision.accept) ? decision.accept.map(String) : []
  const rejectList = Array.isArray(decision.reject) ? decision.reject.map(String) : []
  const addList = Array.isArray(decision.add) ? decision.add.map(String) : []

  if (!acceptList.length && !rejectList.length && !addList.length) {
    throw badRequest('Provide at least one tag to accept, reject or add')
  }

  const result: DecideOutcome = { accepted: [], rejected: [], added: [] }
  const versionId = artifact.current_version_id ?? null

  for (const name of acceptList) {
    const { tag } = await resolveOrCreateTag(db, principal, name, {
      organizationId: artifact.organization_id,
      provenance: 'USER'
    })
    await decideTag(db, principal, artifact.id, tag.id, 'CONFIRMED', 'USER', versionId)
    result.accepted.push(tag.name)
  }

  for (const name of rejectList) {
    const existing = await findTagBySlug(db, slugify(name, 48), artifact.organization_id)
    // Rejecting a name that is not a tag has nothing to record, and silently
    // ignoring it is correct: the outcome the user asked for (not tagged)
    // already holds.
    if (!existing) continue
    await decideTag(db, principal, artifact.id, existing.id, 'REJECTED', 'USER', versionId)
    result.rejected.push(existing.name)
  }

  for (const name of addList) {
    const blocking = blockReason(name)
    // A generic word is the user's prerogative when they type it themselves —
    // they may be filing a document that is literally about folders. Inferring
    // a personal attribute is refused even for an explicit entry, because the
    // tag itself becomes the leak.
    if (blocking === 'sensitive') {
      throw badRequest(`"${String(name).trim()}" looks like a personal attribute and cannot be a tag`)
    }
    if (blocking) continue

    const { name: applied } = await addTagToArtifact(
      db,
      principal,
      artifact.id,
      name,
      artifact.organization_id
    )
    result.added.push(applied)
  }

  return result
}

// ---------------------------------------------------------------
// The suggestion pass
// ---------------------------------------------------------------

export interface AutoTagOutcome {
  /** Names newly attached as SUGGESTED by this pass. */
  created: string[]
  /** Every eligible suggestion, including ones already pending. */
  proposed: string[]
  /** Suppressed: already confirmed, or rejected against this same version. */
  skipped: string[]
  source: 'AI' | 'metadata' | 'unavailable'
  reason: string
}

/**
 * Generate suggestions for an artifact and attach the eligible ones as
 * SUGGESTED — never as CONFIRMED.
 *
 * The title, description and extracted text are read from storage rather than
 * from the caller, so a client cannot steer the tags it is handed.
 *
 * Deliberately non-throwing: tagging is an enhancement, and a model outage must
 * not fail an upload that has already succeeded. The `reason` states honestly
 * what happened instead of returning invented tags.
 */
export async function autoTagArtifact(
  env: Env,
  principal: Principal,
  artifactId: string,
  versionId?: string | null
): Promise<AutoTagOutcome> {
  const db = env.DB

  const artifact = await first<{
    id: string
    title: string
    description: string | null
    extension: string | null
    organization_id: string | null
    workspace_id: string
    current_version_id: string | null
  }>(
    db,
    `SELECT id, title, description, extension, organization_id, workspace_id, current_version_id
       FROM artifacts WHERE id = ?`,
    [artifactId]
  )

  if (!artifact) {
    return {
      created: [],
      proposed: [],
      skipped: [],
      source: 'unavailable',
      reason: 'Artifact not found.'
    }
  }

  const targetVersion = versionId ?? artifact.current_version_id
  const version = targetVersion
    ? await first<{ extracted_text: string | null }>(
        db,
        `SELECT extracted_text FROM artifact_versions WHERE id = ?`,
        [targetVersion]
      )
    : null

  const workspace = await first<{ name: string }>(
    db,
    `SELECT name FROM workspaces WHERE id = ?`,
    [artifact.workspace_id]
  )

  const outcome = await suggestTags(env, {
    title: artifact.title,
    description: artifact.description,
    extension: artifact.extension,
    workspaceName: workspace?.name ?? null,
    text: version?.extracted_text ?? null
  })

  const { kept } = filterSuggestions(outcome.suggestions.map((s) => s.name))
  const source: AutoTagOutcome['source'] = outcome.ran ? 'AI' : kept.length ? 'metadata' : 'unavailable'

  if (!kept.length) {
    return { created: [], proposed: [], skipped: [], source, reason: outcome.note }
  }

  const proposed: string[] = []
  const skipped: string[] = []
  const eligible: Array<{ tagId: string; name: string }> = []

  for (const name of kept.slice(0, MAX_TAGS)) {
    const resolved = await resolveOrCreateTag(db, principal, name, {
      organizationId: artifact.organization_id,
      provenance: 'AI'
    }).catch(() => null)
    if (!resolved) continue

    if (!(await suggestionAllowed(db, artifactId, resolved.tag.id, targetVersion))) {
      skipped.push(resolved.tag.name)
      continue
    }

    proposed.push(resolved.tag.name)
    eligible.push({ tagId: resolved.tag.id, name: resolved.tag.name })
  }

  // applySuggestions re-checks suggestionAllowed, so rejection memory is
  // enforced in one place rather than trusted from the loop above.
  const created = await applySuggestions(db, artifactId, eligible, targetVersion)

  if (created.length) {
    await recordAudit(db, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: 'TAG_SUGGEST',
      targetType: 'artifact',
      targetId: artifactId,
      metadata: { created, source: outcome.model ?? source, skipped }
    }).catch(() => {})
  }

  return { created, proposed, skipped, source, reason: outcome.note }
}

export function tagView(row: ArtifactTagView) {
  return {
    tag_id: row.tag_id,
    name: row.name,
    slug: row.slug,
    state: row.state,
    provenance: row.provenance
  }
}
