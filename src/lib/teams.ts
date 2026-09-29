/**
 * Teams — reusable named sharing audiences (migration 0006).
 *
 * The product job this serves is `artifactry.share(artifact, team="Board prep")`:
 * an agent should be able to address an *audience* by name instead of being
 * handed a list of individual addresses to repeat on every call.
 *
 * Two rules shape everything here:
 *
 *   1. A team is always scoped to an organization. A team with no tenant would
 *      be unscopeable, so `organization_id` is required and every read is
 *      bounded by the organizations the caller actually belongs to. A team in
 *      another tenant is never visible, not even to disambiguate against.
 *
 *   2. A team name is never resolved "best effort". If more than one visible
 *      team matches, resolution FAILS with the candidates. Guessing would mean
 *      sharing a board deck with the wrong audience, which is exactly the class
 *      of mistake a named audience is supposed to prevent.
 *
 * Membership is stored by normalized email as well as user_id, because an
 * audience must be expressible before every member has signed up. When a
 * matching user exists, user_id is filled in so the UI can show a person.
 */

import type { Principal, TeamMemberRow, TeamRow } from '../types'
import { all, first, nowIso, run } from './db'
import { prefixed, slugify, ulid } from './ids'
import { badRequest, conflict, forbidden, notFound } from './http'
import { isValidEmail, normalizeEmail } from './validate'
import { recordAudit } from './audit'
import { can, effectiveWorkspaceRole } from './principal'

export interface TeamWithCounts extends TeamRow {
  member_count: number
}

export interface TeamMemberView {
  member_id: string
  email: string
  display_name: string | null
  role: string
  status: string
  user_id: string | null
  /** True once the address corresponds to a real account. */
  has_account: boolean
}

/** Organizations whose teams the caller may see. */
function visibleOrgIds(principal: Principal): string[] {
  return Object.keys(principal.orgRoles)
}

function isOrgAdmin(principal: Principal, organizationId: string): boolean {
  const role = principal.orgRoles[organizationId]
  return role === 'ORG_OWNER' || role === 'ORG_ADMIN'
}

// ---------------------------------------------------------------
// Reads
// ---------------------------------------------------------------

export async function listTeams(
  db: D1Database,
  principal: Principal,
  options: { workspaceId?: string; includeInactive?: boolean } = {}
): Promise<TeamWithCounts[]> {
  if (!principal.userId) return []
  const orgIds = visibleOrgIds(principal)
  if (!orgIds.length) return []
  // An AI grant must hold team.read; a revoked scope must not still see teams.
  if (!can(principal, 'team.read')) return []

  const where: string[] = [`t.organization_id IN (${orgIds.map(() => '?').join(',')})`]
  const params: unknown[] = [...orgIds]

  if (!options.includeInactive) where.push(`t.status = 'ACTIVE'`)

  if (options.workspaceId) {
    // A workspace filter also admits org-wide teams, since those apply there.
    where.push(`(t.workspace_id IS NULL OR t.workspace_id = ?)`)
    params.push(options.workspaceId)
  }

  return all<TeamWithCounts>(
    db,
    `SELECT t.*,
            (SELECT COUNT(*) FROM team_members m
              WHERE m.team_id = t.id AND m.status = 'ACTIVE') AS member_count
       FROM teams t
      WHERE ${where.join(' AND ')}
      ORDER BY t.scope ASC, t.name ASC`,
    params
  )
}

export async function loadTeam(db: D1Database, teamId: string): Promise<TeamRow | null> {
  return first<TeamRow>(db, `SELECT * FROM teams WHERE id = ?`, [teamId])
}

/** A team is readable by any active member of its organization. */
export async function assertTeamReadable(
  db: D1Database,
  principal: Principal,
  team: TeamRow
): Promise<void> {
  if (!principal.userId) throw forbidden()
  if (!(team.organization_id in principal.orgRoles)) {
    // Deliberately 403, not 404: the caller proved nothing about this tenant,
    // and a team id is not a secret worth a different status than "no".
    throw forbidden('You do not have access to this team')
  }
  if (!can(principal, 'team.read')) throw forbidden()
}

/**
 * Who may change a team's membership or settings.
 *
 *   ORGANIZATION-scoped: an org admin, or the team's own owner.
 *   WORKSPACE-scoped:    additionally the admin of the pinned workspace.
 *
 * The team owner can always administer their own audience even without a
 * broader admin role — someone has to be able to maintain the list they own.
 */
export async function assertTeamManageable(
  db: D1Database,
  principal: Principal,
  team: TeamRow
): Promise<void> {
  await assertTeamReadable(db, principal, team)

  // Managing an audience is a UI/administrative act, never something a
  // connector does. `can()` has no team.write scope to consult, so for an AI
  // grant this reports false and the gate is explicit rather than implied.
  if (principal.kind === 'AI_GRANT') {
    throw forbidden('An AI connection cannot change team membership; ask the user to do it.')
  }
  if (!can(principal, 'team.manage', undefined)) {
    throw forbidden('You do not have permission to manage teams')
  }
  if (team.owner_user_id === principal.userId) return
  if (isOrgAdmin(principal, team.organization_id)) return

  if (team.scope === 'WORKSPACE' && team.workspace_id) {
    const workspace = await first<{
      id: string
      organization_id: string | null
      owner_user_id: string
    }>(db, `SELECT id, organization_id, owner_user_id FROM workspaces WHERE id = ?`, [
      team.workspace_id
    ])
    if (workspace && effectiveWorkspaceRole(principal, workspace) === 'WORKSPACE_ADMIN') return
  }

  throw forbidden('Only a team owner or an organization admin can manage this team')
}

export async function teamMemberViews(
  db: D1Database,
  teamId: string
): Promise<TeamMemberView[]> {
  const rows = await all<TeamMemberRow>(
    db,
    `SELECT * FROM team_members WHERE team_id = ? AND status = 'ACTIVE'
      ORDER BY role ASC, email_normalized ASC`,
    [teamId]
  )

  return rows.map((row) => ({
    member_id: row.id,
    email: row.email_normalized,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    user_id: row.user_id,
    has_account: !!row.user_id
  }))
}

/** Active member addresses, which is what a share is materialised from. */
export async function activeMemberEmails(db: D1Database, teamId: string): Promise<string[]> {
  const rows = await all<{ email_normalized: string }>(
    db,
    `SELECT email_normalized FROM team_members WHERE team_id = ? AND status = 'ACTIVE'`,
    [teamId]
  )
  return [...new Set(rows.map((r) => r.email_normalized))]
}

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

export interface CreateTeamInput {
  name: string
  description?: string | null
  scope?: 'ORGANIZATION' | 'WORKSPACE'
  organizationId: string
  workspaceId?: string | null
  members?: string[]
}

export async function createTeam(
  db: D1Database,
  principal: Principal,
  input: CreateTeamInput
): Promise<TeamRow> {
  if (!principal.userId) throw forbidden()

  const name = (input.name ?? '').trim()
  if (!name) throw badRequest('Team name is required')
  if (name.length > 80) throw badRequest('Team names must be 80 characters or fewer')

  const organizationId = input.organizationId
  if (!organizationId) throw badRequest('organizationId is required')
  if (!(organizationId in principal.orgRoles)) {
    throw forbidden('You are not a member of that organization')
  }

  const scope = input.scope ?? 'ORGANIZATION'

  if (scope === 'ORGANIZATION') {
    // An org-wide audience affects everyone in the tenant, so it needs an
    // org-level admin rather than any contributing member.
    if (!isOrgAdmin(principal, organizationId)) {
      throw forbidden('Only organization admins can create organization-wide teams')
    }
  } else {
    if (!input.workspaceId) throw badRequest('workspaceId is required for a workspace team')
    const workspace = await first<{
      id: string
      organization_id: string | null
      owner_user_id: string
    }>(db, `SELECT id, organization_id, owner_user_id FROM workspaces WHERE id = ?`, [
      input.workspaceId
    ])
    if (!workspace || workspace.organization_id !== organizationId) {
      throw badRequest('That workspace does not belong to the organization')
    }
    if (effectiveWorkspaceRole(principal, workspace) !== 'WORKSPACE_ADMIN') {
      throw forbidden('Only workspace admins can create a workspace team')
    }
  }

  const slug = slugify(name, 48)
  const existing = await first<{ id: string }>(
    db,
    `SELECT id FROM teams WHERE organization_id = ? AND slug = ?`,
    [organizationId, slug]
  )
  if (existing) throw conflict(`A team named "${name}" already exists in this organization`)

  const teamId = prefixed('team', ulid())
  const timestamp = nowIso()

  await run(
    db,
    `INSERT INTO teams
       (id, organization_id, workspace_id, scope, name, slug, description,
        owner_user_id, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [
      teamId,
      organizationId,
      scope === 'WORKSPACE' ? (input.workspaceId ?? null) : null,
      scope,
      name,
      slug,
      input.description ?? null,
      principal.userId,
      principal.userId,
      timestamp,
      timestamp
    ]
  )

  // The creator is always a member; an audience nobody can address is useless.
  await run(
    db,
    `INSERT OR IGNORE INTO team_members
       (id, team_id, user_id, email_normalized, display_name, role, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', ?, ?)`,
    [
      prefixed('tmb', ulid()),
      teamId,
      principal.userId,
      normalizeEmail(principal.user.email ?? ''),
      principal.user.display_name,
      timestamp,
      principal.userId
    ]
  )

  for (const raw of input.members ?? []) {
    await addTeamMember(db, principal, teamId, raw).catch(() => undefined)
  }

  await recordAudit(db, {
    organizationId,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'TEAM_CREATE',
    targetType: 'team',
    targetId: teamId,
    metadata: { name, slug, scope }
  })

  const team = await loadTeam(db, teamId)
  if (!team) throw new Error('Failed to create team')
  return team
}

/** Add a member by email. Idempotent: re-adding converges on the same row. */
export async function addTeamMember(
  db: D1Database,
  principal: Principal,
  teamId: string,
  rawEmail: string,
  role: 'ADMIN' | 'MEMBER' = 'MEMBER'
): Promise<{ email: string; added: boolean }> {
  const team = await loadTeam(db, teamId)
  if (!team) throw notFound('Team not found')
  await assertTeamManageable(db, principal, team)

  const email = normalizeEmail(String(rawEmail ?? '').trim())
  if (!email || !isValidEmail(email)) throw badRequest(`"${rawEmail}" is not a valid email address`)

  const user = await first<{ id: string; display_name: string | null }>(
    db,
    `SELECT id, display_name FROM users WHERE email_normalized = ?`,
    [email]
  )

  const existing = await first<{ id: string; status: string }>(
    db,
    `SELECT id, status FROM team_members WHERE team_id = ? AND email_normalized = ?`,
    [teamId, email]
  )

  if (existing) {
    // Re-adding a removed member reactivates rather than duplicating.
    await run(
      db,
      `UPDATE team_members SET status = 'ACTIVE', user_id = ?, display_name = ?, role = ?
        WHERE id = ?`,
      [user?.id ?? null, user?.display_name ?? null, role, existing.id]
    )
    return { email, added: existing.status !== 'ACTIVE' }
  }

  await run(
    db,
    `INSERT INTO team_members
       (id, team_id, user_id, email_normalized, display_name, role, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      prefixed('tmb', ulid()),
      teamId,
      user?.id ?? null,
      email,
      user?.display_name ?? null,
      role,
      nowIso(),
      principal.userId
    ]
  )

  await recordAudit(db, {
    organizationId: team.organization_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'TEAM_MEMBER_ADD',
    targetType: 'team',
    targetId: teamId,
    metadata: { email }
  })

  return { email, added: true }
}

/**
 * Remove a member.
 *
 * Refuses to remove the last active admin, which would leave an audience that
 * nobody can maintain — and, for a team-shared link, an audience nobody can
 * add to.
 */
export async function removeTeamMember(
  db: D1Database,
  principal: Principal,
  teamId: string,
  rawEmail: string
): Promise<void> {
  const team = await loadTeam(db, teamId)
  if (!team) throw notFound('Team not found')
  await assertTeamManageable(db, principal, team)

  const email = normalizeEmail(String(rawEmail ?? '').trim())

  const target = await first<{ id: string; role: string }>(
    db,
    `SELECT id, role FROM team_members WHERE team_id = ? AND email_normalized = ?`,
    [teamId, email]
  )
  if (!target) throw notFound('That address is not on this team')

  if (target.role === 'ADMIN') {
    const admins = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM team_members
        WHERE team_id = ? AND role = 'ADMIN' AND status = 'ACTIVE' AND id != ?`,
      [teamId, target.id]
    )
    if ((admins?.n ?? 0) === 0) {
      throw conflict('A team needs at least one admin. Add another admin before removing this one.')
    }
  }

  await run(db, `UPDATE team_members SET status = 'INACTIVE' WHERE id = ?`, [target.id])

  await recordAudit(db, {
    organizationId: team.organization_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'TEAM_MEMBER_REMOVE',
    targetType: 'team',
    targetId: teamId,
    metadata: { email }
  })
}

export async function setTeamStatus(
  db: D1Database,
  principal: Principal,
  teamId: string,
  status: 'ACTIVE' | 'INACTIVE'
): Promise<void> {
  const team = await loadTeam(db, teamId)
  if (!team) throw notFound('Team not found')
  await assertTeamManageable(db, principal, team)
  await run(db, `UPDATE teams SET status = ?, updated_at = ? WHERE id = ?`, [
    status,
    nowIso(),
    teamId
  ])
  await recordAudit(db, {
    organizationId: team.organization_id,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'TEAM_UPDATE',
    targetType: 'team',
    targetId: teamId,
    metadata: { status }
  })
}

// ---------------------------------------------------------------
// Name resolution — the disambiguation rule
// ---------------------------------------------------------------

export type TeamResolution =
  | { status: 'FOUND'; team: TeamWithCounts }
  | {
      status: 'AMBIGUOUS'
      candidates: Array<{
        team_id: string
        name: string
        slug: string
        scope: string
        organization_id: string
        workspace_id: string | null
      }>
    }
  | { status: 'NOT_FOUND' }

/**
 * Resolve a user-supplied team name to exactly one team, or refuse.
 *
 * Ordering matters and is deliberate:
 *   1. an exact team id (unambiguous by construction),
 *   2. an exact slug (the canonical, already case-folded form),
 *   3. a case-insensitive exact name.
 *
 * Step 3 is where ambiguity appears: two organizations can each legitimately
 * have a "Board prep", and a user can belong to both. Returning one of them
 * would be a coin flip on who receives a confidential document, so this
 * returns AMBIGUOUS and the caller must ask.
 */
export async function resolveTeamByName(
  db: D1Database,
  principal: Principal,
  rawName: unknown
): Promise<TeamResolution> {
  const needle = String(rawName ?? '').trim()
  if (!needle) return { status: 'NOT_FOUND' }

  const teams = await listTeams(db, principal, { includeInactive: false })
  if (!teams.length) return { status: 'NOT_FOUND' }

  const byId = teams.filter((t) => t.id === needle)
  if (byId.length === 1) return { status: 'FOUND', team: byId[0] }

  const slug = slugify(needle, 48)
  const bySlug = teams.filter((t) => t.slug === slug)
  if (bySlug.length === 1) return { status: 'FOUND', team: bySlug[0] }
  if (bySlug.length > 1) return { status: 'AMBIGUOUS', candidates: bySlug.map(candidate) }

  const lowered = needle.toLowerCase()
  const byName = teams.filter((t) => t.name.toLowerCase() === lowered)
  if (byName.length === 1) return { status: 'FOUND', team: byName[0] }
  if (byName.length > 1) return { status: 'AMBIGUOUS', candidates: byName.map(candidate) }

  return { status: 'NOT_FOUND' }
}

function candidate(team: TeamWithCounts) {
  return {
    team_id: team.id,
    name: team.name,
    slug: team.slug,
    scope: team.scope,
    organization_id: team.organization_id,
    workspace_id: team.workspace_id
  }
}

/**
 * Assert a team may be used to share a specific artifact.
 *
 * The organization must match: a team is an audience inside one tenant, and
 * sharing an artifact out to a team from a different organization would cross a
 * tenant boundary that no amount of team membership should be able to open.
 */
export async function assertTeamUsableForArtifact(
  db: D1Database,
  principal: Principal,
  team: TeamRow,
  artifact: { organization_id: string | null; workspace_id: string }
): Promise<void> {
  await assertTeamReadable(db, principal, team)

  if (!artifact.organization_id) {
    throw badRequest(
      'Teams are organization-scoped. This artifact is in a personal workspace, so there is no team audience to share with.'
    )
  }
  if (team.organization_id !== artifact.organization_id) {
    throw forbidden('That team belongs to a different organization than this artifact')
  }
  if (team.status !== 'ACTIVE') {
    throw badRequest('That team is inactive')
  }

  const members = await activeMemberEmails(db, team.id)
  if (!members.length) {
    throw badRequest(`Team "${team.name}" has no active members to share with`)
  }
}

export function teamSummary(team: TeamWithCounts, principal: Principal) {
  return {
    team_id: team.id,
    name: team.name,
    slug: team.slug,
    scope: team.scope,
    organization_id: team.organization_id,
    workspace_id: team.workspace_id,
    description: team.description,
    status: team.status,
    member_count: team.member_count,
    owner: team.owner_user_id === principal.userId
  }
}
