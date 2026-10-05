/**
 * The shared state between AI tools: who made what, what it was built from,
 * and handoffs from one tool to the next (migration 0010).
 *
 *   Provenance  every artifact and version records the client name the saving
 *               connection reported ("Cursor", "Claude"), shown as "made by".
 *   Lineage     "A was built from B" links. An AI declares them with
 *               derived_from; when it declares nothing, the artifacts the same
 *               connection read shortly before saving are linked as INFERRED.
 *   Handoffs    a brief plus a set of artifacts left in a workspace for the next
 *               tool: "Claude researched this, Cursor, build it".
 *   Projects    collections marked as the home of one multi-tool piece of work.
 *
 * Authorization follows the rest of the library: everything is re-derived from
 * the principal, and an artifact the caller may not read is never returned,
 * linked to, or counted.
 */

import type { ArtifactRow, Principal, SourceProvider, WorkspaceRow } from '../types'
import { all, first, nowIso, run } from './db'
import { badRequest, forbidden, notFound } from './http'
import { prefixed, ulid } from './ids'
import { can, loadWorkspace, readableWorkspaces } from './principal'
import { recordAudit } from './audit'

export const MAX_HANDOFF_ARTIFACTS = 20
export const MAX_DERIVED_FROM = 20
export const MAX_BRIEF_CHARS = 8000
/** How far back a save looks for what the same connection read. */
export const INFERENCE_WINDOW_MINUTES = 120
export const MAX_INFERRED_SOURCES = 5

export type LinkOrigin = 'DECLARED' | 'INFERRED' | 'USER'
export type HandoffStatus = 'OPEN' | 'PICKED_UP' | 'CLOSED'

// ---------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------

const PROVIDER_LABELS: Partial<Record<SourceProvider, string>> = {
  CHATGPT: 'ChatGPT',
  CLAUDE: 'Claude',
  GEMINI: 'Gemini',
  COPILOT: 'Copilot'
}

/**
 * Client names as tools report them are inconsistent ("claude-ai",
 * "cursor-vscode", "Claude Desktop"). The known ones are folded to the name a
 * person would use; anything else is shown as reported.
 */
const CLIENT_LABELS: Array<[RegExp, string]> = [
  [/cursor/i, 'Cursor'],
  [/claude[\s_-]*code/i, 'Claude Code'],
  [/claude/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/codex/i, 'Codex'],
  [/gemini/i, 'Gemini'],
  [/copilot/i, 'Copilot'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/vs\s*code|vscode|visual studio code/i, 'VS Code']
]

/** The tool a person would say made this, or null for a person's own upload. */
export function madeByLabel(
  provider: string | null | undefined,
  client: string | null | undefined
): string | null {
  const name = (client ?? '').trim()
  if (name) {
    for (const [pattern, label] of CLIENT_LABELS) if (pattern.test(name)) return label
    return name.slice(0, 60)
  }
  if (!provider || provider === 'WEB') return null
  return PROVIDER_LABELS[provider as SourceProvider] ?? (provider === 'API' ? 'An AI tool' : provider)
}

/**
 * A "made by" filter as SQL over the artifacts alias `a`. Matches the provider
 * bucket for the big four and the reported client name for everything else,
 * so "cursor" and "Claude" both work. "web" or "me" means uploaded by a person.
 */
export function madeByCondition(madeBy: string): { sql: string; params: unknown[] } | null {
  const needle = madeBy.trim().toLowerCase()
  if (!needle) return null
  if (['web', 'me', 'upload', 'person', 'manual'].includes(needle)) {
    return { sql: `a.source_provider = 'WEB'`, params: [] }
  }
  const provider =
    needle === 'chatgpt' || needle === 'openai'
      ? 'CHATGPT'
      : needle === 'claude'
        ? 'CLAUDE'
        : needle === 'gemini'
          ? 'GEMINI'
          : needle === 'copilot'
            ? 'COPILOT'
            : null
  const like = `%${needle.replace(/[%_\\]/g, '')}%`
  return provider
    ? { sql: `(a.source_provider = ? OR lower(coalesce(a.source_client, '')) LIKE ?)`, params: [provider, like] }
    : { sql: `lower(coalesce(a.source_client, '')) LIKE ?`, params: [like] }
}

/** Stamp the reporting client onto an artifact and/or version just written. */
export async function stampClient(
  db: D1Database,
  principal: Principal,
  ids: { artifactId?: string; versionId?: string }
): Promise<void> {
  const client = principal.clientName?.trim()
  if (!client) return
  if (ids.artifactId) {
    await run(db, `UPDATE artifacts SET source_client = ? WHERE id = ?`, [client, ids.artifactId])
  }
  if (ids.versionId) {
    await run(db, `UPDATE artifact_versions SET source_client = ? WHERE id = ?`, [client, ids.versionId])
  }
}

// ---------------------------------------------------------------
// Reads and access
// ---------------------------------------------------------------

export function mayReadArtifact(principal: Principal, artifact: ArtifactRow): boolean {
  if (artifact.deleted_at) return false
  if (artifact.owner_user_id === principal.userId) return true
  return can(principal, 'artifact.read', {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  })
}

function mayWriteArtifact(principal: Principal, artifact: ArtifactRow): boolean {
  if (artifact.owner_user_id === principal.userId) return true
  return can(principal, 'artifact.update', {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  })
}

/** Remember that this AI connection read an artifact (get, get_handoff). */
export async function recordAiRead(db: D1Database, principal: Principal, artifactId: string): Promise<void> {
  if (principal.kind !== 'AI_GRANT' || !principal.grantId) return
  await run(
    db,
    `INSERT INTO ai_reads (grant_id, artifact_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT (grant_id, artifact_id) DO UPDATE SET read_at = excluded.read_at`,
    [principal.grantId, artifactId, nowIso()]
  )
}

/** Artifacts this connection read within the inference window, newest first. */
export async function recentReads(
  db: D1Database,
  principal: Principal,
  excludeArtifactId: string
): Promise<ArtifactRow[]> {
  if (principal.kind !== 'AI_GRANT' || !principal.grantId) return []
  const since = new Date(Date.now() - INFERENCE_WINDOW_MINUTES * 60_000).toISOString()
  const rows = await all<ArtifactRow>(
    db,
    `SELECT a.* FROM ai_reads r JOIN artifacts a ON a.id = r.artifact_id
      WHERE r.grant_id = ? AND r.read_at >= ? AND r.artifact_id != ? AND a.deleted_at IS NULL
      ORDER BY r.read_at DESC LIMIT ?`,
    [principal.grantId, since, excludeArtifactId, MAX_INFERRED_SOURCES]
  )
  return rows.filter((a) => mayReadArtifact(principal, a))
}

/** An artifact id from an id or a canonical URL (…/a/art_…). */
export function artifactIdFromRef(ref: unknown): string | null {
  const raw = String(ref ?? '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    const match = /\/a\/([A-Za-z0-9_-]+)/.exec(raw)
    return match ? match[1] : null
  }
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null
}

/**
 * Resolve references the caller supplied. Each one either resolves to an
 * artifact the caller may read or is reported back as skipped; an unreadable
 * artifact is reported exactly like a missing one, so ids cannot be probed.
 */
export async function resolveReadableRefs(
  db: D1Database,
  principal: Principal,
  refs: unknown[],
  max: number
): Promise<{ artifacts: ArtifactRow[]; skipped: string[] }> {
  const artifacts: ArtifactRow[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const ref of refs.slice(0, max)) {
    const id = artifactIdFromRef(ref)
    if (!id) {
      skipped.push(String(ref))
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const artifact = await first<ArtifactRow>(db, `SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL`, [id])
    if (!artifact || !mayReadArtifact(principal, artifact)) {
      skipped.push(String(ref))
      continue
    }
    artifacts.push(artifact)
  }
  if (refs.length > max) skipped.push(`${refs.length - max} more (limit ${max})`)
  return { artifacts, skipped }
}

// ---------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------

export interface LineageEntry {
  linkId: string
  artifactId: string
  title: string
  extension: string | null
  madeBy: string | null
  origin: LinkOrigin
  linkedAt: string
  canonicalUrl: string
}

/** Record that `fromArtifactId` was built from each of `sources`. */
export async function addLineage(
  db: D1Database,
  principal: Principal,
  input: {
    fromArtifact: ArtifactRow
    fromVersionId?: string | null
    sources: ArtifactRow[]
    origin: LinkOrigin
  }
): Promise<ArtifactRow[]> {
  const linked: ArtifactRow[] = []
  for (const source of input.sources) {
    if (source.id === input.fromArtifact.id) continue
    if (!mayReadArtifact(principal, source)) continue
    // A link is never re-labelled: a declared link stays declared even if the
    // same pair is later inferred, and vice versa.
    await run(
      db,
      `INSERT OR IGNORE INTO artifact_links
         (id, from_artifact_id, to_artifact_id, from_version_id, kind, origin,
          source_provider, source_client, created_by, created_at)
       VALUES (?, ?, ?, ?, 'DERIVED_FROM', ?, ?, ?, ?, ?)`,
      [
        prefixed('lnk', ulid()),
        input.fromArtifact.id,
        source.id,
        input.fromVersionId ?? null,
        input.origin,
        principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : 'WEB',
        principal.clientName ?? null,
        principal.userId,
        nowIso()
      ]
    )
    linked.push(source)
  }
  if (linked.length) {
    await recordAudit(db, {
      organizationId: input.fromArtifact.organization_id,
      workspaceId: input.fromArtifact.workspace_id,
      actorUserId: principal.userId,
      actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
      action: 'LINEAGE_ADD',
      targetType: 'artifact',
      targetId: input.fromArtifact.id,
      metadata: { sources: linked.map((a) => a.id), origin: input.origin, client: principal.clientName ?? null }
    })
  }
  return linked
}

type LinkedRow = ArtifactRow & { link_id: string; link_origin: LinkOrigin; linked_at: string }

/** What an artifact was built from, and what was built from it. */
export async function lineageFor(
  db: D1Database,
  principal: Principal,
  artifactId: string,
  origin: string
): Promise<{ builtFrom: LineageEntry[]; usedIn: LineageEntry[] }> {
  const select = (joinOn: string, where: string) =>
    all<LinkedRow>(
      db,
      `SELECT a.*, l.id AS link_id, l.origin AS link_origin, l.created_at AS linked_at
         FROM artifact_links l JOIN artifacts a ON a.id = ${joinOn}
        WHERE ${where} = ? AND a.deleted_at IS NULL
        ORDER BY l.created_at DESC LIMIT 50`,
      [artifactId]
    )
  const present = (rows: LinkedRow[]) =>
    rows
      .filter((a) => mayReadArtifact(principal, a))
      .map((a) => ({
        linkId: a.link_id,
        artifactId: a.id,
        title: a.title,
        extension: a.extension,
        madeBy: madeByLabel(a.source_provider, a.source_client),
        origin: a.link_origin,
        linkedAt: a.linked_at,
        canonicalUrl: `${origin}/a/${a.id}`
      }))

  const [from, used] = await Promise.all([
    select('l.to_artifact_id', 'l.from_artifact_id'),
    select('l.from_artifact_id', 'l.to_artifact_id')
  ])
  return { builtFrom: present(from), usedIn: present(used) }
}

/**
 * Remove one lineage link. Either side's editor may remove it: the newer
 * artifact's editor because it is their claim, the source's editor because it
 * names their work.
 */
export async function removeLineage(
  db: D1Database,
  principal: Principal,
  artifact: ArtifactRow,
  linkId: string
): Promise<void> {
  const link = await first<{ id: string; from_artifact_id: string; to_artifact_id: string }>(
    db,
    `SELECT id, from_artifact_id, to_artifact_id FROM artifact_links
      WHERE id = ? AND (from_artifact_id = ? OR to_artifact_id = ?)`,
    [linkId, artifact.id, artifact.id]
  )
  if (!link) throw notFound('Link not found')
  if (!mayWriteArtifact(principal, artifact)) throw forbidden('You cannot change this artifact')
  await run(db, `DELETE FROM artifact_links WHERE id = ?`, [link.id])
  await recordAudit(db, {
    organizationId: artifact.organization_id,
    workspaceId: artifact.workspace_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'LINEAGE_REMOVE',
    targetType: 'artifact',
    targetId: artifact.id,
    metadata: { linkId: link.id, from: link.from_artifact_id, to: link.to_artifact_id }
  })
}

// ---------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------

export interface HandoffRow {
  id: string
  organization_id: string | null
  workspace_id: string
  title: string
  brief: string
  to_tool: string | null
  status: HandoffStatus
  created_by: string
  source_provider: string | null
  source_client: string | null
  picked_up_by_client: string | null
  picked_up_at: string | null
  created_at: string
  updated_at: string
}

export async function createHandoff(
  db: D1Database,
  principal: Principal,
  input: {
    workspace: WorkspaceRow
    artifacts: ArtifactRow[]
    brief: string
    title?: string | null
    toTool?: string | null
  }
): Promise<HandoffRow> {
  const brief = input.brief.trim()
  if (!brief) throw badRequest('A handoff needs a brief: what the next tool should do with these artifacts.')
  if (brief.length > MAX_BRIEF_CHARS) throw badRequest(`Keep the brief under ${MAX_BRIEF_CHARS} characters.`)
  if (!input.artifacts.length) throw badRequest('A handoff needs at least one artifact you can read.')
  if (input.artifacts.length > MAX_HANDOFF_ARTIFACTS) {
    throw badRequest(`A handoff holds at most ${MAX_HANDOFF_ARTIFACTS} artifacts.`)
  }
  if (!can(principal, 'artifact.create', input.workspace)) {
    throw forbidden('You cannot leave handoffs in that workspace.')
  }

  const title =
    (input.title ?? '').trim().slice(0, 160) ||
    brief.split('\n')[0].replace(/\s+/g, ' ').slice(0, 80) ||
    input.artifacts[0].title
  const id = prefixed('hof', ulid())
  const now = nowIso()

  await run(
    db,
    `INSERT INTO handoffs
       (id, organization_id, workspace_id, title, brief, to_tool, status, created_by,
        source_provider, source_client, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace.organization_id,
      input.workspace.id,
      title,
      brief,
      (input.toTool ?? '').trim().slice(0, 60) || null,
      principal.userId,
      principal.kind === 'AI_GRANT' ? (principal.provider ?? 'API') : 'WEB',
      principal.kind === 'AI_GRANT' ? (principal.clientName ?? null) : null,
      now,
      now
    ]
  )
  let position = 0
  for (const artifact of input.artifacts) {
    await run(
      db,
      `INSERT OR IGNORE INTO handoff_artifacts (handoff_id, artifact_id, position) VALUES (?, ?, ?)`,
      [id, artifact.id, position++]
    )
  }

  await recordAudit(db, {
    organizationId: input.workspace.organization_id,
    workspaceId: input.workspace.id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'HANDOFF_CREATE',
    targetType: 'handoff',
    targetId: id,
    metadata: { artifacts: input.artifacts.map((a) => a.id), client: principal.clientName ?? null }
  })

  return (await first<HandoffRow>(db, `SELECT * FROM handoffs WHERE id = ?`, [id]))!
}

/** A handoff id from an id or a link (…/h/hof_…). */
export function handoffIdFromRef(ref: unknown): string | null {
  const raw = String(ref ?? '').trim()
  if (!raw) return null
  const match = /(hof_[A-Za-z0-9]+)/.exec(raw)
  return match ? match[1] : null
}

/** Load a handoff the principal may see: anyone who can read its workspace. */
export async function loadHandoffFor(
  db: D1Database,
  principal: Principal,
  ref: unknown
): Promise<{ handoff: HandoffRow; workspace: WorkspaceRow }> {
  const id = handoffIdFromRef(ref)
  const handoff = id ? await first<HandoffRow>(db, `SELECT * FROM handoffs WHERE id = ?`, [id]) : null
  const workspace = handoff ? await loadWorkspace(db, handoff.workspace_id) : null
  if (!handoff || !workspace || !can(principal, 'artifact.read', workspace)) {
    throw notFound('Handoff not found')
  }
  return { handoff, workspace }
}

/** The handoff's artifacts the principal may read, in order, plus how many are hidden. */
export async function handoffArtifacts(
  db: D1Database,
  principal: Principal,
  handoffId: string
): Promise<{ artifacts: ArtifactRow[]; hidden: number }> {
  const rows = await all<ArtifactRow>(
    db,
    `SELECT a.* FROM handoff_artifacts h JOIN artifacts a ON a.id = h.artifact_id
      WHERE h.handoff_id = ? ORDER BY h.position ASC`,
    [handoffId]
  )
  const artifacts = rows.filter((a) => mayReadArtifact(principal, a))
  return { artifacts, hidden: rows.length - artifacts.length }
}

export async function listHandoffs(
  db: D1Database,
  principal: Principal,
  opts: { workspaceIds?: string[]; status?: 'OPEN' | 'ALL'; limit?: number } = {}
): Promise<Array<HandoffRow & { workspace_name: string; artifact_count: number }>> {
  const readable = (await readableWorkspaces(db, principal)).filter((w) => can(principal, 'artifact.read', w))
  const ids = opts.workspaceIds?.length
    ? readable.filter((w) => opts.workspaceIds!.includes(w.id)).map((w) => w.id)
    : readable.map((w) => w.id)
  if (!ids.length) return []
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
  const statusClause = opts.status === 'ALL' ? '' : `AND h.status != 'CLOSED'`
  return all(
    db,
    `SELECT h.*, w.name AS workspace_name,
            (SELECT COUNT(*) FROM handoff_artifacts x WHERE x.handoff_id = h.id) AS artifact_count
       FROM handoffs h JOIN workspaces w ON w.id = h.workspace_id
      WHERE h.workspace_id IN (${ids.map(() => '?').join(',')}) ${statusClause}
      ORDER BY h.created_at DESC LIMIT ?`,
    [...ids, limit]
  )
}

/** The first pickup by an AI tool moves an open handoff to PICKED_UP. */
export async function markPickedUp(db: D1Database, principal: Principal, handoff: HandoffRow): Promise<void> {
  if (handoff.status !== 'OPEN' || principal.kind !== 'AI_GRANT') return
  const client = madeByLabel(principal.provider, principal.clientName) ?? 'An AI tool'
  const now = nowIso()
  await run(
    db,
    `UPDATE handoffs SET status = 'PICKED_UP', picked_up_by_client = ?, picked_up_at = ?, updated_at = ?
      WHERE id = ? AND status = 'OPEN'`,
    [client, now, now, handoff.id]
  )
  handoff.status = 'PICKED_UP'
  handoff.picked_up_by_client = client
  handoff.picked_up_at = now
  await recordAudit(db, {
    organizationId: handoff.organization_id,
    workspaceId: handoff.workspace_id,
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'HANDOFF_PICKUP',
    targetType: 'handoff',
    targetId: handoff.id,
    metadata: { client }
  })
}

/** Close or reopen. The creator or anyone who may edit in the workspace. */
export async function setHandoffStatus(
  db: D1Database,
  principal: Principal,
  handoff: HandoffRow,
  workspace: WorkspaceRow,
  status: 'OPEN' | 'CLOSED'
): Promise<void> {
  if (handoff.created_by !== principal.userId && !can(principal, 'artifact.update', workspace)) {
    throw forbidden('Only the person who left this handoff, or a workspace editor, can change it.')
  }
  await run(db, `UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?`, [status, nowIso(), handoff.id])
  handoff.status = status
  await recordAudit(db, {
    organizationId: handoff.organization_id,
    workspaceId: handoff.workspace_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'HANDOFF_STATUS',
    targetType: 'handoff',
    targetId: handoff.id,
    metadata: { status }
  })
}

/** The sentence a person pastes into the next tool. */
export function pickupPrompt(handoff: Pick<HandoffRow, 'id' | 'title'>): string {
  return `Open my Artifactry handoff ${handoff.id} ("${handoff.title}") and do what its brief asks.`
}

export function presentHandoff(
  handoff: HandoffRow & { workspace_name?: string; artifact_count?: number },
  origin: string
) {
  return {
    id: handoff.id,
    title: handoff.title,
    brief: handoff.brief,
    toTool: handoff.to_tool,
    status: handoff.status,
    workspaceId: handoff.workspace_id,
    ...(handoff.workspace_name ? { workspaceName: handoff.workspace_name } : {}),
    ...(handoff.artifact_count !== undefined ? { artifactCount: handoff.artifact_count } : {}),
    from: madeByLabel(handoff.source_provider, handoff.source_client) ?? 'You',
    pickedUpBy: handoff.picked_up_by_client,
    pickedUpAt: handoff.picked_up_at,
    createdAt: handoff.created_at,
    url: `${origin}/h/${handoff.id}`,
    pickupPrompt: pickupPrompt(handoff)
  }
}

// ---------------------------------------------------------------
// Projects
// ---------------------------------------------------------------

export interface ProjectRow {
  id: string
  name: string
  description: string | null
  workspace_id: string
  workspace_name: string
  artifact_count: number
  updated_at: string
}

export async function listProjects(
  db: D1Database,
  principal: Principal,
  workspaceIds?: string[]
): Promise<ProjectRow[]> {
  const readable = (await readableWorkspaces(db, principal)).filter((w) => can(principal, 'artifact.read', w))
  const ids = workspaceIds?.length
    ? readable.filter((w) => workspaceIds.includes(w.id)).map((w) => w.id)
    : readable.map((w) => w.id)
  if (!ids.length) return []
  return all<ProjectRow>(
    db,
    `SELECT c.id, c.name, c.description, c.workspace_id, w.name AS workspace_name, c.updated_at,
            (SELECT COUNT(*) FROM collection_artifacts ca JOIN artifacts a ON a.id = ca.artifact_id
              WHERE ca.collection_id = c.id AND a.deleted_at IS NULL) AS artifact_count
       FROM collections c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.is_project = 1 AND c.archived_at IS NULL
        AND c.workspace_id IN (${ids.map(() => '?').join(',')})
      ORDER BY c.updated_at DESC LIMIT 100`,
    ids
  )
}

/** Mark a collection as a project, or back to a plain collection. */
export async function setCollectionProject(
  db: D1Database,
  principal: Principal,
  collectionId: string,
  isProject: boolean
): Promise<void> {
  const collection = await first<{ id: string; workspace_id: string; organization_id: string | null }>(
    db,
    `SELECT id, workspace_id, organization_id FROM collections WHERE id = ? AND archived_at IS NULL`,
    [collectionId]
  )
  const workspace = collection ? await loadWorkspace(db, collection.workspace_id) : null
  if (!collection || !workspace || !can(principal, 'artifact.read', workspace)) throw notFound('Collection not found')
  if (!can(principal, 'collection.manage', workspace)) throw forbidden('You cannot manage collections in this workspace.')
  await run(db, `UPDATE collections SET is_project = ?, updated_at = ? WHERE id = ?`, [
    isProject ? 1 : 0,
    nowIso(),
    collection.id
  ])
  await recordAudit(db, {
    organizationId: collection.organization_id,
    workspaceId: collection.workspace_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'COLLECTION_PROJECT',
    targetType: 'collection',
    targetId: collection.id,
    metadata: { isProject }
  })
}
