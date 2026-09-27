/**
 * Workspaces and organizations — PRD §4, §6, §7, §27, §28, §109.
 *
 *   GET    /api/v1/workspaces
 *   POST   /api/v1/workspaces
 *   GET    /api/v1/workspaces/:id
 *   PATCH  /api/v1/workspaces/:id
 *   GET    /api/v1/workspaces/:id/members
 *   POST   /api/v1/workspaces/:id/members
 *   DELETE /api/v1/workspaces/:id/members/:userId
 *
 *   GET    /api/v1/organizations
 *   POST   /api/v1/organizations
 *   GET    /api/v1/organizations/:id/members
 *   POST   /api/v1/organizations/:id/members
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, requirePrincipal } from '../middleware'
import {
  assertWorkspaceAccess,
  can,
  effectiveWorkspaceRole,
  loadWorkspace,
  readableWorkspaces
} from '../lib/principal'
import { all, first, nowIso, run, count } from '../lib/db'
import { prefixed, slugify, ulid } from '../lib/ids'
import { badRequest, conflict, forbidden, notFound, ok, readJson } from '../lib/http'
import { recordAudit } from '../lib/audit'
import { isValidEmail, normalizeEmail } from '../lib/validate'
import { workspaceTotals } from '../lib/analytics'
import type { OrgRole, WorkspaceRole } from '../types'

const workspaces = new Hono<AppEnv>()

const WORKSPACE_ROLES: WorkspaceRole[] = ['WORKSPACE_ADMIN', 'CONTRIBUTOR', 'VIEWER']
const ORG_ROLES: OrgRole[] = ['ORG_OWNER', 'ORG_ADMIN', 'MEMBER']

// ---------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------

workspaces.get(
  '/organizations',
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const rows = await all<{
      id: string
      name: string
      slug: string
      plan: string
      role: string
      workspace_count: number
      member_count: number
    }>(
      c.env.DB,
      `SELECT o.id, o.name, o.slug, o.plan, om.role,
              (SELECT COUNT(*) FROM workspaces w WHERE w.organization_id = o.id AND w.archived_at IS NULL) AS workspace_count,
              (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'ACTIVE') AS member_count
         FROM organizations o
         JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = ? AND om.status = 'ACTIVE'
        ORDER BY o.name ASC`,
      [principal.userId]
    )

    return ok(c, {
      organizations: rows.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan,
        role: o.role,
        workspaceCount: o.workspace_count,
        memberCount: o.member_count
      }))
    })
  })
)

workspaces.post(
  '/organizations',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ name?: string }>(c)

    const name = (body.name ?? '').trim()
    if (!name) throw badRequest('Organization name is required')
    if (name.length > 120) throw badRequest('Organization name is too long')

    let slug = slugify(name, 48)
    const clash = await first<{ id: string }>(c.env.DB, `SELECT id FROM organizations WHERE slug = ?`, [
      slug
    ])
    if (clash) slug = `${slug}-${ulid().slice(-4).toLowerCase()}`

    const orgId = prefixed('org', ulid())
    const timestamp = nowIso()

    await run(
      c.env.DB,
      `INSERT INTO organizations
         (id, name, slug, plan, max_upload_bytes, settings_json, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'FREE', ?, '{"showVerifiedExternalViewerIdentity":false}', 'ACTIVE', ?, ?, ?)`,
      [orgId, name, slug, Number(c.env.MAX_UPLOAD_BYTES || 26214400), principal.userId, timestamp, timestamp]
    )

    await run(
      c.env.DB,
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at, created_by, status)
       VALUES (?, ?, ?, 'ORG_OWNER', ?, ?, 'ACTIVE')`,
      [prefixed('orgm', ulid()), orgId, principal.userId, timestamp, principal.userId]
    )

    await recordAudit(c.env.DB, {
      organizationId: orgId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ORGANIZATION_CREATE',
      targetType: 'organization',
      targetId: orgId,
      metadata: { name, slug }
    })

    return ok(c, { organization: { id: orgId, name, slug, plan: 'FREE', role: 'ORG_OWNER' } }, 201)
  })
)

workspaces.get(
  '/organizations/:orgId/members',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const orgId = c.req.param('orgId')

    const role = principal.orgRoles[orgId]
    if (!role) throw notFound('Organization not found')
    if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') throw forbidden()

    const members = await all<{
      id: string
      user_id: string
      role: string
      status: string
      created_at: string
      email: string
      display_name: string | null
      workspace_count: number
    }>(
      c.env.DB,
      `SELECT om.id, om.user_id, om.role, om.status, om.created_at,
              u.email, u.display_name,
              (SELECT COUNT(*) FROM workspace_members wm
                JOIN workspaces w ON w.id = wm.workspace_id
               WHERE wm.user_id = om.user_id AND w.organization_id = ?) AS workspace_count
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
        WHERE om.organization_id = ?
        ORDER BY om.created_at ASC`,
      [orgId, orgId]
    )

    return ok(c, {
      members: members.map((m) => ({
        id: m.id,
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        role: m.role,
        status: m.status,
        workspaceCount: m.workspace_count,
        joinedAt: m.created_at
      }))
    })
  })
)

/**
 * Add a member by email.
 *
 * The invitee must already have an account. Creating accounts on someone
 * else's behalf would let an admin claim an address the user has not proven
 * control of (§5, §38) — so an unknown email is rejected with a clear message
 * rather than silently provisioned.
 */
workspaces.post(
  '/organizations/:orgId/members',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const orgId = c.req.param('orgId')

    const role = principal.orgRoles[orgId]
    if (!role) throw notFound('Organization not found')
    if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') throw forbidden()

    const body = await readJson<{ email?: string; role?: OrgRole }>(c)
    const email = normalizeEmail(body.email ?? '')
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address')

    const requestedRole: OrgRole = ORG_ROLES.includes(body.role as OrgRole)
      ? (body.role as OrgRole)
      : 'MEMBER'

    // Only an owner may mint another owner
    if (requestedRole === 'ORG_OWNER' && role !== 'ORG_OWNER') {
      throw forbidden('Only an organization owner can add another owner')
    }

    const user = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM users WHERE email_normalized = ?`,
      [email]
    )
    if (!user) {
      throw badRequest(
        'That person does not have an account yet. Ask them to sign in once, then add them.'
      )
    }

    const existing = await first<{ id: string; status: string }>(
      c.env.DB,
      `SELECT id, status FROM organization_members WHERE organization_id = ? AND user_id = ?`,
      [orgId, user.id]
    )

    if (existing) {
      if (existing.status === 'ACTIVE') throw conflict('That person is already a member')
      await run(c.env.DB, `UPDATE organization_members SET status = 'ACTIVE', role = ? WHERE id = ?`, [
        requestedRole,
        existing.id
      ])
    } else {
      await run(
        c.env.DB,
        `INSERT INTO organization_members (id, organization_id, user_id, role, created_at, created_by, status)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [prefixed('orgm', ulid()), orgId, user.id, requestedRole, nowIso(), principal.userId]
      )
    }

    await recordAudit(c.env.DB, {
      organizationId: orgId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'MEMBER_ADD',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: requestedRole, email }
    })

    return ok(c, { added: true, userId: user.id, role: requestedRole }, 201)
  })
)

// ---------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------

workspaces.get(
  '/workspaces',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const rows = await readableWorkspaces(c.env.DB, principal)

    const orgs = await all<{ id: string; name: string }>(
      c.env.DB,
      `SELECT id, name FROM organizations`,
      []
    )
    const orgNames = new Map(orgs.map((o) => [o.id, o.name]))

    const counts = await all<{ workspace_id: string; n: number }>(
      c.env.DB,
      `SELECT workspace_id, COUNT(*) AS n FROM artifacts WHERE deleted_at IS NULL GROUP BY workspace_id`,
      []
    )
    const countMap = new Map(counts.map((c2) => [c2.workspace_id, c2.n]))

    return ok(c, {
      workspaces: rows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        type: w.workspace_type,
        organizationId: w.organization_id,
        organizationName: w.organization_id ? (orgNames.get(w.organization_id) ?? null) : null,
        role: effectiveWorkspaceRole(principal, w),
        isOwner: w.owner_user_id === principal.userId,
        artifactCount: countMap.get(w.id) ?? 0
      }))
    })
  })
)

workspaces.post(
  '/workspaces',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ name?: string; description?: string; organizationId?: string }>(c)

    const name = (body.name ?? '').trim()
    if (!name) throw badRequest('Workspace name is required')

    const organizationId = body.organizationId ?? null

    if (organizationId) {
      const role = principal.orgRoles[organizationId]
      if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') {
        throw forbidden('Only organization owners and admins can create workspaces')
      }
    }

    const workspaceId = prefixed('ws', ulid())
    const timestamp = nowIso()

    await run(
      c.env.DB,
      `INSERT INTO workspaces
         (id, organization_id, owner_user_id, workspace_type, name, description, created_at, created_by, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        workspaceId,
        organizationId,
        principal.userId,
        organizationId ? 'ORGANIZATION' : 'PERSONAL',
        name.slice(0, 120),
        body.description?.slice(0, 500) ?? null,
        timestamp,
        principal.userId
      ]
    )

    await run(
      c.env.DB,
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by, status)
       VALUES (?, ?, ?, 'WORKSPACE_ADMIN', ?, ?, 'ACTIVE')`,
      [prefixed('wsm', ulid()), workspaceId, principal.userId, timestamp, principal.userId]
    )

    await recordAudit(c.env.DB, {
      organizationId,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'WORKSPACE_CREATE',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { name }
    })

    return ok(c, { workspace: { id: workspaceId, name, organizationId, type: organizationId ? 'ORGANIZATION' : 'PERSONAL' } }, 201)
  })
)

workspaces.get(
  '/workspaces/:id',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'artifact.read')

    const artifactCount = await count(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ? AND deleted_at IS NULL`,
      [workspace.id]
    )
    const memberCount = await count(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND status = 'ACTIVE'`,
      [workspace.id]
    )
    const collectionCount = await count(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM collections WHERE workspace_id = ? AND archived_at IS NULL`,
      [workspace.id]
    )

    const organization = workspace.organization_id
      ? await first<{ id: string; name: string; plan: string }>(
          c.env.DB,
          `SELECT id, name, plan FROM organizations WHERE id = ?`,
          [workspace.organization_id]
        )
      : null

    const stats = await workspaceTotals(c.env.DB, workspace.id, '30d')

    return ok(c, {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        type: workspace.workspace_type,
        organizationId: workspace.organization_id,
        organization,
        role: effectiveWorkspaceRole(principal, workspace),
        isOwner: workspace.owner_user_id === principal.userId,
        createdAt: workspace.created_at
      },
      counts: {
        artifacts: artifactCount,
        members: memberCount,
        collections: collectionCount
      },
      usage: stats
    })
  })
)

workspaces.patch(
  '/workspaces/:id',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.param('id')
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'workspace.manage')

    const body = await readJson<{ name?: string; description?: string }>(c)
    const sets: string[] = []
    const params: unknown[] = []

    if (typeof body.name === 'string' && body.name.trim()) {
      sets.push('name = ?')
      params.push(body.name.trim().slice(0, 120))
    }
    if (typeof body.description === 'string') {
      sets.push('description = ?')
      params.push(body.description.slice(0, 500))
    }
    if (!sets.length) throw badRequest('Nothing to update')

    await run(c.env.DB, `UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      workspaceId
    ])

    return ok(c, { updated: true, workspaceId })
  })
)

workspaces.get(
  '/workspaces/:id/members',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'artifact.read')

    const members = await all<{
      id: string
      user_id: string
      role: string
      status: string
      created_at: string
      email: string
      display_name: string | null
    }>(
      c.env.DB,
      `SELECT wm.id, wm.user_id, wm.role, wm.status, wm.created_at, u.email, u.display_name
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = ?
        ORDER BY wm.created_at ASC`,
      [workspace.id]
    )

    return ok(c, {
      members: members.map((m) => ({
        id: m.id,
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        role: m.role,
        status: m.status,
        joinedAt: m.created_at,
        isWorkspaceOwner: m.user_id === workspace.owner_user_id
      }))
    })
  })
)

workspaces.post(
  '/workspaces/:id/members',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.param('id')
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'member.manage')

    const body = await readJson<{ email?: string; role?: WorkspaceRole }>(c)
    const email = normalizeEmail(body.email ?? '')
    if (!isValidEmail(email)) throw badRequest('Enter a valid email address')

    const role: WorkspaceRole = WORKSPACE_ROLES.includes(body.role as WorkspaceRole)
      ? (body.role as WorkspaceRole)
      : 'VIEWER'

    const user = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM users WHERE email_normalized = ?`,
      [email]
    )
    if (!user) {
      throw badRequest(
        'That person does not have an account yet. Ask them to sign in once, then add them.'
      )
    }

    // Organization workspaces: the person must belong to the tenant first.
    // This is the enforcement point that keeps tenants isolated (§64).
    if (workspace.organization_id) {
      const orgMember = await first<{ role: string }>(
        c.env.DB,
        `SELECT role FROM organization_members
          WHERE organization_id = ? AND user_id = ? AND status = 'ACTIVE'`,
        [workspace.organization_id, user.id]
      )
      if (!orgMember) {
        throw badRequest(
          'Add this person to the organization before adding them to one of its workspaces.'
        )
      }
    }

    const existing = await first<{ id: string; status: string }>(
      c.env.DB,
      `SELECT id, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      [workspaceId, user.id]
    )

    if (existing) {
      if (existing.status === 'ACTIVE') throw conflict('That person is already a member of this workspace')
      await run(c.env.DB, `UPDATE workspace_members SET status = 'ACTIVE', role = ? WHERE id = ?`, [
        role,
        existing.id
      ])
    } else {
      await run(
        c.env.DB,
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by, status)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [prefixed('wsm', ulid()), workspaceId, user.id, role, nowIso(), principal.userId]
      )
    }

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'MEMBER_ADD',
      targetType: 'user',
      targetId: user.id,
      metadata: { role, email }
    })

    return ok(c, { added: true, userId: user.id, role }, 201)
  })
)

workspaces.patch(
  '/workspaces/:id/members/:userId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.param('id')
    const targetUserId = c.req.param('userId')
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'member.manage')

    // The workspace owner's own membership cannot be downgraded or removed,
    // otherwise a workspace could be left with nobody able to administer it (§6)
    if (targetUserId === workspace.owner_user_id) {
      throw badRequest('The workspace owner\'s role cannot be changed')
    }

    const body = await readJson<{ role?: WorkspaceRole }>(c)
    if (!WORKSPACE_ROLES.includes(body.role as WorkspaceRole)) {
      throw badRequest(`Role must be one of: ${WORKSPACE_ROLES.join(', ')}`)
    }

    const membership = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      [workspaceId, targetUserId]
    )
    if (!membership) throw notFound('That person is not a member of this workspace')

    await run(c.env.DB, `UPDATE workspace_members SET role = ? WHERE id = ?`, [
      body.role,
      membership.id
    ])

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ROLE_CHANGE',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { role: body.role }
    })

    return ok(c, { updated: true, userId: targetUserId, role: body.role })
  })
)

workspaces.delete(
  '/workspaces/:id/members/:userId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.param('id')
    const targetUserId = c.req.param('userId')
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'member.manage')

    if (targetUserId === workspace.owner_user_id) {
      throw badRequest('The workspace owner cannot be removed')
    }

    await run(
      c.env.DB,
      `UPDATE workspace_members SET status = 'REMOVED'
        WHERE workspace_id = ? AND user_id = ?`,
      [workspaceId, targetUserId]
    )

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'MEMBER_REMOVE',
      targetType: 'user',
      targetId: targetUserId
    })

    return ok(c, { removed: true })
  })
)

// ---------------------------------------------------------------
// Organization-level analytics (§47)
// ---------------------------------------------------------------

workspaces.get(
  '/organizations/:orgId/analytics',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const orgId = c.req.param('orgId')

    const role = principal.orgRoles[orgId]
    if (!role) throw notFound('Organization not found')
    if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') {
      throw forbidden('Organization analytics are visible to organization admins only')
    }

    const requested = c.req.query('period') ?? '30d'
    const period = (['7d', '30d', '90d', 'all'] as const).includes(requested as never)
      ? (requested as '7d' | '30d' | '90d' | 'all')
      : '30d'

    const start = period === 'all' ? null : new Date(Date.now() - (period === '7d' ? 7 : period === '30d' ? 30 : 90) * 86400_000).toISOString().slice(0, 10)

    const totals = await first<{
      views: number
      unique_viewers: number
      downloads: number
      ai_references: number
      artifacts: number
    }>(
      c.env.DB,
      `SELECT
         COALESCE(SUM(m.views), 0) AS views,
         COALESCE(SUM(m.unique_viewers), 0) AS unique_viewers,
         COALESCE(SUM(m.downloads), 0) AS downloads,
         COALESCE(SUM(m.ai_references), 0) AS ai_references,
         (SELECT COUNT(*) FROM artifacts a
           JOIN workspaces w ON w.id = a.workspace_id
          WHERE w.organization_id = ? AND a.deleted_at IS NULL) AS artifacts
       FROM artifact_daily_metrics m
       JOIN artifacts a ON a.id = m.artifact_id
       JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.organization_id = ? ${start ? 'AND m.metric_date >= ?' : ''}`,
      start ? [orgId, orgId, start] : [orgId, orgId]
    )

    const byWorkspace = await all<{ id: string; name: string; views: number; artifacts: number }>(
      c.env.DB,
      `SELECT w.id, w.name,
              COALESCE(SUM(m.views), 0) AS views,
              COUNT(DISTINCT a.id) AS artifacts
         FROM workspaces w
         LEFT JOIN artifacts a ON a.workspace_id = w.id AND a.deleted_at IS NULL
         LEFT JOIN artifact_daily_metrics m ON m.artifact_id = a.id ${start ? 'AND m.metric_date >= ?' : ''}
        WHERE w.organization_id = ? AND w.archived_at IS NULL
        GROUP BY w.id ORDER BY views DESC`,
      start ? [start, orgId] : [orgId]
    )

    const byProvider = await all<{ source_provider: string | null; n: number }>(
      c.env.DB,
      `SELECT a.source_provider, COUNT(*) AS n
         FROM artifacts a
         JOIN workspaces w ON w.id = a.workspace_id
        WHERE w.organization_id = ? AND a.deleted_at IS NULL
        GROUP BY a.source_provider ORDER BY n DESC`,
      [orgId]
    )

    const memberCount = await count(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ? AND status = 'ACTIVE'`,
      [orgId]
    )

    return ok(c, {
      period,
      totals: {
        views: totals?.views ?? 0,
        uniqueViewers: totals?.unique_viewers ?? 0,
        downloads: totals?.downloads ?? 0,
        aiReferences: totals?.ai_references ?? 0,
        artifacts: totals?.artifacts ?? 0,
        members: memberCount
      },
      byWorkspace: byWorkspace.map((w) => ({
        id: w.id,
        name: w.name,
        views: w.views,
        artifacts: w.artifacts
      })),
      byProvider: byProvider.map((p) => ({ provider: p.source_provider ?? 'WEB_UPLOAD', count: p.n }))
    })
  })
)

export default workspaces
