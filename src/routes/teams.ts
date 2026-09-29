/**
 * Teams — HTTP surface for reusable named sharing audiences.
 *
 * Mirrors lib/teams.ts, which owns every rule. Handlers here only parse input,
 * delegate, and present. No authorization decision is made in this file.
 *
 * Mounted at /api/v1 (teams live beside workspaces and collections).
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, requirePrincipal } from '../middleware'
import { badRequest, notFound, ok, readJson } from '../lib/http'
import { all, first } from '../lib/db'
import {
  activeMemberEmails,
  addTeamMember,
  assertTeamReadable,
  createTeam,
  listTeams,
  loadTeam,
  removeTeamMember,
  resolveTeamByName,
  setTeamStatus,
  teamMemberViews,
  teamSummary
} from '../lib/teams'

const teams = new Hono<AppEnv>()

/** List teams the caller can address. */
teams.get(
  '/teams',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.query('workspaceId') ?? undefined
    const includeInactive = c.req.query('includeInactive') === '1'

    const rows = await listTeams(c.env.DB, principal, { workspaceId, includeInactive })

    return ok(c, {
      teams: rows.map((team) => teamSummary(team, principal))
    })
  })
)

teams.post(
  '/teams',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{
      name?: string
      description?: string
      scope?: 'ORGANIZATION' | 'WORKSPACE'
      organizationId?: string
      workspaceId?: string
      members?: string[]
    }>(c)

    // Default the organization to the caller's own when there is exactly one,
    // so the common case does not require the client to know its org id.
    const orgIds = Object.keys(principal.orgRoles)
    const organizationId = body.organizationId ?? (orgIds.length === 1 ? orgIds[0] : undefined)
    if (!organizationId) {
      throw badRequest(
        'organizationId is required (you belong to more than one organization, so it cannot be inferred)'
      )
    }

    const team = await createTeam(c.env.DB, principal, {
      name: body.name ?? '',
      description: body.description ?? null,
      scope: body.scope,
      organizationId,
      workspaceId: body.workspaceId ?? null,
      members: body.members
    })

    const withCount = await first<{ member_count: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS member_count FROM team_members WHERE team_id = ? AND status = 'ACTIVE'`,
      [team.id]
    )

    return ok(
      c,
      { team: teamSummary({ ...team, member_count: withCount?.member_count ?? 0 }, principal) },
      201
    )
  })
)

teams.get(
  '/teams/:teamId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const team = await loadTeam(c.env.DB, c.req.param('teamId'))
    if (!team) throw notFound('Team not found')
    await assertTeamReadable(c.env.DB, principal, team)

    const members = await teamMemberViews(c.env.DB, team.id)

    return ok(c, {
      team: {
        ...teamSummary({ ...team, member_count: members.length }, principal),
        members
      }
    })
  })
)

teams.post(
  '/teams/:teamId/members',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ email?: string; role?: 'ADMIN' | 'MEMBER' }>(c)
    if (!body.email) throw badRequest('email is required')

    const result = await addTeamMember(
      c.env.DB,
      principal,
      c.req.param('teamId'),
      body.email,
      body.role === 'ADMIN' ? 'ADMIN' : 'MEMBER'
    )

    return ok(c, result, result.added ? 201 : 200)
  })
)

teams.delete(
  '/teams/:teamId/members/:email',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    await removeTeamMember(
      c.env.DB,
      principal,
      c.req.param('teamId'),
      decodeURIComponent(c.req.param('email'))
    )
    return ok(c, { removed: true })
  })
)

teams.patch(
  '/teams/:teamId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ status?: 'ACTIVE' | 'INACTIVE' }>(c)
    if (body.status !== 'ACTIVE' && body.status !== 'INACTIVE') {
      throw badRequest('status must be ACTIVE or INACTIVE')
    }

    await setTeamStatus(c.env.DB, principal, c.req.param('teamId'), body.status)
    return ok(c, { updated: true, status: body.status })
  })
)

/**
 * Resolve a name to a team, for the UI's share dialog.
 *
 * Returns the candidates rather than a pick when ambiguous, so the share form
 * shows the same disambiguation the MCP tool demands.
 */
teams.get(
  '/teams/resolve',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const name = c.req.query('name') ?? ''

    const resolution = await resolveTeamByName(c.env.DB, principal, name)

    if (resolution.status === 'FOUND') {
      const members = await activeMemberEmails(c.env.DB, resolution.team.id)
      return ok(c, {
        status: 'FOUND',
        team: teamSummary(resolution.team, principal),
        member_count: members.length
      })
    }

    if (resolution.status === 'AMBIGUOUS') {
      return ok(c, {
        status: 'AMBIGUOUS',
        candidates: resolution.candidates,
        message: `More than one team matches "${name}". Choose one by team_id — sharing with a guess could send this to the wrong audience.`
      })
    }

    return ok(c, { status: 'NOT_FOUND' })
  })
)

/** Teams a specific artifact could be shared with (same organization, active). */
teams.get(
  '/artifacts/:artifactId/shareable-teams',
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const artifact = await first<{
      id: string
      organization_id: string | null
      workspace_id: string
    }>(
      c.env.DB,
      `SELECT id, organization_id, workspace_id FROM artifacts WHERE id = ? AND deleted_at IS NULL`,
      [c.req.param('artifactId')]
    )
    if (!artifact) throw notFound('Artifact not found')

    if (!artifact.organization_id) {
      return ok(c, {
        teams: [],
        reason: 'This artifact is in a personal workspace, so there is no team audience.'
      })
    }

    const rows = await listTeams(c.env.DB, principal, { workspaceId: artifact.workspace_id })
    const eligible = rows.filter((team) => team.organization_id === artifact.organization_id)

    const withMembers = await all<{ team_id: string }>(
      c.env.DB,
      `SELECT DISTINCT team_id FROM team_members WHERE status = 'ACTIVE'`
    )
    const hasMembers = new Set(withMembers.map((r) => r.team_id))

    return ok(c, {
      teams: eligible.map((team) => ({
        ...teamSummary(team, principal),
        shareable: team.member_count > 0 && hasMembers.has(team.id)
      }))
    })
  })
)

export default teams
