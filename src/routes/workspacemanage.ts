/**
 * Workspace management — the settings screen behind the left-rail icon.
 *
 *   GET    /api/v1/workspaces/:id/manage                  → everything the screen needs
 *   PATCH  /api/v1/workspaces/:id/settings                → identity, regional, invitation controls
 *   PUT    /api/v1/workspaces/:id/logo                    → upload a logo (raw image body, <= 1 MB)
 *   DELETE /api/v1/workspaces/:id/logo
 *   GET    /api/v1/workspaces/:id/logo                    → the logo (public: share pages show it)
 *
 *   GET    /api/v1/workspaces/:id/directory               → active, pending, deactivated
 *   POST   /api/v1/workspaces/:id/members/:userId/status  → { status: ACTIVE | REMOVED }
 *
 *   GET    /api/v1/workspaces/:id/roles                   → built-in and custom tiers
 *   POST   /api/v1/workspaces/:id/roles                   → { name, permissions }
 *   PATCH  /api/v1/workspaces/:id/roles/:roleId
 *   DELETE /api/v1/workspaces/:id/roles/:roleId
 *
 *   GET    /api/v1/workspaces/:id/invitations
 *   POST   /api/v1/workspaces/:id/invitations             → { kind: EMAIL | LINK, convertToShared?, ... }
 *   DELETE /api/v1/workspaces/:id/invitations/:inviteId
 *
 *   GET    /api/v1/invitations/:token                     → public summary for the join page
 *   POST   /api/v1/invitations/:token/accept              → join (signed in)
 *
 *   PUT    /api/v1/profile/avatar                         → upload your profile picture (<= 1 MB)
 *   DELETE /api/v1/profile/avatar
 *   GET    /api/v1/users/:id/avatar                       → a profile picture (signed in)
 *
 * Who may do what:
 *   - reading settings and tiers: anyone who can read the workspace
 *   - identity, regional, logo:   workspace.manage
 *   - directory, tiers, invites:  member.manage
 * Both are held by workspace admins, the workspace owner and the organization's
 * owners and admins. An AI connector can never change any of it.
 *
 * Workspace types: a personal workspace is one person; a shared workspace
 * (stored as ORGANIZATION, with its own organization) has a team. Both have
 * identity, regional settings and invitations. Custom URL, team directory and
 * roles are for shared workspaces only. The first invitation from a personal
 * workspace converts it to shared, and only once its owner has confirmed.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import { assertWorkspaceAccess, can, effectiveWorkspaceRole, loadWorkspace } from '../lib/principal'
import { all, batch, first, nowIso, ps, run } from '../lib/db'
import { badRequest, conflict, forbidden, HttpError, notFound, ok, readJson } from '../lib/http'
import { prefixed, randomToken, slugify, ulid } from '../lib/ids'
import { hashShareToken, tokenPrefix } from '../lib/crypto'
import { recordAudit } from '../lib/audit'
import { devCodeMode, sendEmail } from '../lib/auth'
import { isValidEmail, normalizeEmail } from '../lib/validate'
import { assertPicture, pictureHeaders, readPictureBody } from '../lib/images'
import {
  DATE_FORMATS,
  emailAllowed,
  mergeWorkspaceSettings,
  parseWorkspaceSettings
} from '../lib/workspacesettings'
import type { SettingsPatch } from '../lib/workspacesettings'
import type { Permission, Principal, WorkspaceRole, WorkspaceRow } from '../types'
import { CUSTOMIZABLE_PERMISSIONS } from '../types'

const manage = new Hono<AppEnv>()

/** Built-in tiers as people see them. The owner is the workspace's owner_user_id. */
export const BUILT_IN_TIERS: Array<{ id: string; role: WorkspaceRole | 'OWNER'; name: string; description: string }> = [
  { id: 'OWNER', role: 'OWNER', name: 'Owner', description: 'Created the workspace. Full control; cannot be removed.' },
  { id: 'WORKSPACE_ADMIN', role: 'WORKSPACE_ADMIN', name: 'Admin', description: 'Manages settings, members, tiers and invitations.' },
  { id: 'CONTRIBUTOR', role: 'CONTRIBUTOR', name: 'Member', description: 'Adds, edits and shares artifacts.' },
  { id: 'VIEWER', role: 'VIEWER', name: 'Guest', description: 'Views and downloads artifacts.' }
]

const JOIN_ROLES: WorkspaceRole[] = ['WORKSPACE_ADMIN', 'CONTRIBUTOR', 'VIEWER']

/** Human labels for the permissions a custom tier can hold. */
export const PERMISSION_LABELS: Partial<Record<Permission, string>> = {
  'artifact.read': 'View artifacts',
  'artifact.download': 'Download artifacts',
  'artifact.create': 'Add artifacts',
  'artifact.update': 'Edit artifacts',
  'artifact.version.create': 'Upload new versions',
  'artifact.tag.apply': 'Tag artifacts',
  'artifact.delete': 'Delete artifacts',
  'collection.manage': 'Manage collections',
  'share.create': 'Share artifacts',
  'share.revoke': 'Revoke shares',
  'analytics.read.artifact': 'View artifact analytics',
  'analytics.read.workspace': 'View workspace analytics',
  'team.read': 'See teams',
  'team.manage': 'Manage teams'
}

const WRITE_PERMS: Permission[] = [
  'artifact.create',
  'artifact.update',
  'artifact.version.create',
  'artifact.tag.apply',
  'artifact.delete',
  'collection.manage',
  'share.create',
  'share.revoke',
  'team.manage'
]

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function sessionPrincipal(c: Context<AppEnv>): Principal {
  const principal = requirePrincipal(c)
  if (principal.kind === 'AI_GRANT') throw forbidden('Workspace settings are managed in the app')
  return principal
}

function requireOrgWorkspace(workspace: WorkspaceRow) {
  if (!workspace.organization_id) {
    throw new HttpError(
      400,
      'PERSONAL_WORKSPACE',
      'This is available in shared workspaces.'
    )
  }
}

/**
 * Turn a personal workspace into a shared one: give it an organization of its
 * own, owned by the workspace owner, and move everything the workspace holds
 * into that organization. Running it twice, or twice at once, converts once:
 * every write is guarded on the workspace still being personal.
 */
async function convertToShared(c: Context<AppEnv>, workspace: WorkspaceRow, actorId: string): Promise<WorkspaceRow> {
  const db = c.env.DB
  const orgId = prefixed('org', ulid())
  const timestamp = nowIso()
  let slug = slugify(workspace.name, 48) || 'workspace'
  const clash = await first<{ id: string }>(db, `SELECT id FROM organizations WHERE slug = ?`, [slug])
  if (clash) slug = `${slug}-${ulid().slice(-6).toLowerCase()}`

  const stillPersonal = `EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND organization_id IS NULL)`
  const orgOfWorkspace = `(SELECT organization_id FROM workspaces WHERE id = ?)`
  await batch(db, [
    ps(
      db,
      `INSERT INTO organizations
         (id, name, slug, plan, max_upload_bytes, settings_json, status, created_by, created_at, updated_at)
       SELECT ?, ?, ?, 'FREE', ?, '{"showVerifiedExternalViewerIdentity":false}', 'ACTIVE', ?, ?, ?
        WHERE ${stillPersonal}`,
      [orgId, workspace.name, slug, Number(c.env.MAX_UPLOAD_BYTES || 26214400), actorId, timestamp, timestamp, workspace.id]
    ),
    ps(
      db,
      `INSERT INTO organization_members (id, organization_id, user_id, role, created_at, created_by, status)
       SELECT ?, id, ?, 'ORG_OWNER', ?, ?, 'ACTIVE' FROM organizations WHERE id = ?`,
      [prefixed('orgm', ulid()), workspace.owner_user_id, timestamp, actorId, orgId]
    ),
    ps(
      db,
      `UPDATE workspaces SET organization_id = ?, workspace_type = 'ORGANIZATION'
        WHERE id = ? AND organization_id IS NULL AND EXISTS (SELECT 1 FROM organizations WHERE id = ?)`,
      [orgId, workspace.id, orgId]
    ),
    ps(db, `UPDATE artifacts SET organization_id = ${orgOfWorkspace} WHERE workspace_id = ?`, [workspace.id, workspace.id]),
    ps(db, `UPDATE collections SET organization_id = ${orgOfWorkspace} WHERE workspace_id = ?`, [workspace.id, workspace.id]),
    ps(db, `UPDATE shares SET organization_id = ${orgOfWorkspace} WHERE workspace_id = ?`, [workspace.id, workspace.id]),
    ps(db, `UPDATE artifact_embeddings SET organization_id = ${orgOfWorkspace} WHERE workspace_id = ?`, [workspace.id, workspace.id])
  ])

  const converted = await loadWorkspace(db, workspace.id)
  if (!converted?.organization_id) throw new HttpError(500, 'CONVERT_FAILED', 'The workspace could not be made shared. Try again.')

  if (converted.organization_id === orgId) {
    await recordAudit(db, {
      organizationId: orgId,
      workspaceId: workspace.id,
      actorUserId: actorId,
      actorType: 'USER',
      action: 'WORKSPACE_CONVERT_SHARED',
      targetType: 'workspace',
      targetId: workspace.id,
      metadata: { from: 'PERSONAL', to: 'SHARED' }
    })
  }
  return converted
}

export function logoUrl(w: Pick<WorkspaceRow, 'id' | 'logo_r2_key' | 'logo_updated_at'>): string | null {
  return w.logo_r2_key ? `/api/v1/workspaces/${encodeURIComponent(w.id)}/logo?v=${encodeURIComponent(w.logo_updated_at ?? '')}` : null
}

export function avatarUrl(u: { id: string; avatar_r2_key?: string | null; avatar_updated_at?: string | null }): string | null {
  return u.avatar_r2_key ? `/api/v1/users/${encodeURIComponent(u.id)}/avatar?v=${encodeURIComponent(u.avatar_updated_at ?? '')}` : null
}

interface CustomRoleRow {
  id: string
  workspace_id: string
  name: string
  permissions_json: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

function parsePermissions(json: string): Permission[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((p) => CUSTOMIZABLE_PERMISSIONS.includes(p)) : []
  } catch {
    return []
  }
}

function presentRole(r: CustomRoleRow, memberCount = 0) {
  return { id: r.id, name: r.name, permissions: parsePermissions(r.permissions_json), memberCount, custom: true }
}

async function customRoles(db: D1Database, workspaceId: string): Promise<CustomRoleRow[]> {
  return all<CustomRoleRow>(
    db,
    `SELECT * FROM workspace_custom_roles WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC`,
    [workspaceId]
  )
}

async function loadCustomRole(db: D1Database, workspaceId: string, roleId: string): Promise<CustomRoleRow> {
  const row = await first<CustomRoleRow>(
    db,
    `SELECT * FROM workspace_custom_roles WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
    [roleId, workspaceId]
  )
  if (!row) throw badRequest('That access tier does not exist in this workspace')
  return row
}

/** Validate a tier's permission list: known, customizable, always able to view. */
function cleanPermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) throw badRequest('permissions must be a list')
  const unknown = input.find((p) => !CUSTOMIZABLE_PERMISSIONS.includes(p as Permission))
  if (unknown !== undefined) throw badRequest(`"${String(unknown)}" cannot be part of a custom tier`)
  return [...new Set<Permission>(['artifact.read', ...(input as Permission[])])]
}

/** The built-in role stored alongside a custom tier: never admin. */
export function baseRoleFor(permissions: Permission[]): WorkspaceRole {
  return permissions.some((p) => WRITE_PERMS.includes(p)) ? 'CONTRIBUTOR' : 'VIEWER'
}

/**
 * Resolve the tier a joiner or member gets: a built-in role, or a custom tier
 * (stored as its base role + custom_role_id).
 */
async function resolveTier(
  db: D1Database,
  workspaceId: string,
  role: unknown,
  customRoleId: unknown
): Promise<{ role: WorkspaceRole; customRoleId: string | null }> {
  if (typeof customRoleId === 'string' && customRoleId) {
    const tier = await loadCustomRole(db, workspaceId, customRoleId)
    return { role: baseRoleFor(parsePermissions(tier.permissions_json)), customRoleId: tier.id }
  }
  if (!JOIN_ROLES.includes(role as WorkspaceRole)) throw badRequest('Choose Admin, Member, Guest or a custom tier')
  return { role: role as WorkspaceRole, customRoleId: null }
}

function tierLabel(role: string, customName: string | null, isOwner: boolean): string {
  if (isOwner) return 'Owner'
  if (customName) return customName
  return BUILT_IN_TIERS.find((t) => t.role === role)?.name ?? role
}

// ---------------------------------------------------------------
// Settings and identity
// ---------------------------------------------------------------

manage.get(
  '/workspaces/:id/manage',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'artifact.read')
    const settings = parseWorkspaceSettings(workspace.settings_json)
    const roles = await customRoles(c.env.DB, workspace.id)

    const counts = await all<{ custom_role_id: string; n: number }>(
      c.env.DB,
      `SELECT custom_role_id, COUNT(*) AS n FROM workspace_members
        WHERE workspace_id = ? AND status = 'ACTIVE' AND custom_role_id IS NOT NULL
        GROUP BY custom_role_id`,
      [workspace.id]
    )
    const countOf = new Map(counts.map((r) => [r.custom_role_id, r.n]))

    return ok(c, {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        type: workspace.workspace_type,
        organizationId: workspace.organization_id,
        logoUrl: logoUrl(workspace),
        role: effectiveWorkspaceRole(principal, workspace),
        isOwner: workspace.owner_user_id === principal.userId,
        canManageSettings: can(principal, 'workspace.manage', workspace),
        canManageMembers: can(principal, 'member.manage', workspace)
      },
      settings,
      tiers: {
        builtIn: BUILT_IN_TIERS,
        custom: roles.map((r) => presentRole(r, countOf.get(r.id) ?? 0))
      },
      options: {
        dateFormats: DATE_FORMATS,
        permissions: CUSTOMIZABLE_PERMISSIONS.map((p) => ({ id: p, label: PERMISSION_LABELS[p] ?? p }))
      }
    })
  })
)

manage.patch(
  '/workspaces/:id/settings',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'workspace.manage')

    const body = await readJson<{ name?: string; description?: string } & SettingsPatch>(c)

    if (body.invitations?.defaultCustomRoleId) {
      await loadCustomRole(c.env.DB, workspace.id, body.invitations.defaultCustomRoleId)
    }
    const settings = mergeWorkspaceSettings(parseWorkspaceSettings(workspace.settings_json), {
      regional: body.regional,
      invitations: body.invitations
    })

    let name = workspace.name
    if (body.name !== undefined) {
      name = String(body.name).trim()
      if (!name) throw badRequest('Workspace name cannot be empty')
      if (name.length > 120) throw badRequest('Workspace name is too long')
    }
    const description = body.description !== undefined ? String(body.description).slice(0, 500) : workspace.description

    await run(c.env.DB, `UPDATE workspaces SET name = ?, description = ?, settings_json = ? WHERE id = ?`, [
      name,
      description,
      JSON.stringify(settings),
      workspace.id
    ])

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'WORKSPACE_UPDATE',
      targetType: 'workspace',
      targetId: workspace.id,
      metadata: { name: name !== workspace.name ? name : undefined, settings }
    })

    return ok(c, { workspace: { id: workspace.id, name, description }, settings })
  })
)

manage.put(
  '/workspaces/:id/logo',
  rateLimit({ bucket: 'workspace:logo', limit: 30, windowSeconds: 3600 }),
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'workspace.manage')
    const bytes = await readPictureBody(c.req.raw)
    const type = assertPicture(bytes)

    const key = `logos/${workspace.id}/${randomToken(12)}`
    await c.env.R2.put(key, bytes, { httpMetadata: { contentType: type } })
    const timestamp = nowIso()
    await run(c.env.DB, `UPDATE workspaces SET logo_r2_key = ?, logo_updated_at = ? WHERE id = ?`, [
      key,
      timestamp,
      workspace.id
    ])
    if (workspace.logo_r2_key) await c.env.R2.delete(workspace.logo_r2_key).catch(() => {})

    return ok(c, { logoUrl: logoUrl({ id: workspace.id, logo_r2_key: key, logo_updated_at: timestamp }) })
  })
)

manage.delete(
  '/workspaces/:id/logo',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'workspace.manage')
    await run(c.env.DB, `UPDATE workspaces SET logo_r2_key = NULL, logo_updated_at = ? WHERE id = ?`, [
      nowIso(),
      workspace.id
    ])
    if (workspace.logo_r2_key) await c.env.R2.delete(workspace.logo_r2_key).catch(() => {})
    return ok(c, { logoUrl: null })
  })
)

/**
 * The logo is public: it appears on the workspace's share pages and invitation
 * page, which recipients open without an account. It names nothing beyond the
 * workspace's own branding.
 */
manage.get('/workspaces/:id/logo', async (c) => {
  const workspace = await loadWorkspace(c.env.DB, c.req.param('id'))
  if (!workspace?.logo_r2_key) return c.notFound()
  const object = await c.env.R2.get(workspace.logo_r2_key)
  if (!object) return c.notFound()
  return new Response(object.body, {
    headers: pictureHeaders(object.httpMetadata?.contentType ?? 'application/octet-stream', 'public, max-age=300')
  })
})

// ---------------------------------------------------------------
// Team directory
// ---------------------------------------------------------------

manage.get(
  '/workspaces/:id/directory',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')

    const rows = await all<{
      user_id: string
      role: string
      status: string
      created_at: string
      custom_role_id: string | null
      custom_name: string | null
      email: string
      display_name: string | null
      avatar_r2_key: string | null
      avatar_updated_at: string | null
    }>(
      c.env.DB,
      `SELECT wm.user_id, wm.role, wm.status, wm.created_at, wm.custom_role_id, cr.name AS custom_name,
              u.email, u.display_name, u.avatar_r2_key, u.avatar_updated_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         LEFT JOIN workspace_custom_roles cr ON cr.id = wm.custom_role_id AND cr.archived_at IS NULL
        WHERE wm.workspace_id = ?
        ORDER BY COALESCE(u.display_name, u.email) ASC`,
      [workspace.id]
    )

    const person = (r: (typeof rows)[number]) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      avatarUrl: avatarUrl({ id: r.user_id, avatar_r2_key: r.avatar_r2_key, avatar_updated_at: r.avatar_updated_at }),
      role: r.user_id === workspace.owner_user_id ? 'OWNER' : r.role,
      customRoleId: r.custom_name ? r.custom_role_id : null,
      tier: tierLabel(r.role, r.custom_name, r.user_id === workspace.owner_user_id),
      since: r.created_at,
      isOwner: r.user_id === workspace.owner_user_id
    })

    // The owner always appears as active, whether or not they have a member row.
    const active = rows.filter((r) => r.status === 'ACTIVE').map(person)
    if (!active.some((p) => p.isOwner)) {
      const owner = await first<{ id: string; email: string; display_name: string | null; avatar_r2_key: string | null; avatar_updated_at: string | null }>(
        c.env.DB,
        `SELECT id, email, display_name, avatar_r2_key, avatar_updated_at FROM users WHERE id = ?`,
        [workspace.owner_user_id]
      )
      if (owner) {
        active.unshift({
          userId: owner.id,
          email: owner.email,
          displayName: owner.display_name,
          avatarUrl: avatarUrl(owner),
          role: 'OWNER',
          customRoleId: null,
          tier: 'Owner',
          since: workspace.created_at,
          isOwner: true
        })
      }
    }

    const invitations = await all<InvitationRow>(
      c.env.DB,
      `SELECT * FROM workspace_invitations WHERE workspace_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC`,
      [workspace.id]
    )
    const tiers = new Map((await customRoles(c.env.DB, workspace.id)).map((r) => [r.id, r.name]))

    return ok(c, {
      active,
      awaitingApproval: rows.filter((r) => r.status === 'PENDING_APPROVAL').map(person),
      invitations: invitations.filter((i) => !invitationExpired(i)).map((i) => presentInvitation(i, tiers)),
      deactivated: rows.filter((r) => r.status === 'REMOVED').map(person)
    })
  })
)

/**
 * Approve, reactivate (ACTIVE) or deactivate (REMOVED) a member. Deactivating
 * removes their access to this workspace only; their account and their other
 * workspaces are untouched.
 */
manage.post(
  '/workspaces/:id/members/:userId/status',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const userId = c.req.param('userId')
    const body = await readJson<{ status?: string }>(c)
    if (body.status !== 'ACTIVE' && body.status !== 'REMOVED') throw badRequest('status must be ACTIVE or REMOVED')
    if (userId === workspace.owner_user_id) throw badRequest('The workspace owner cannot be deactivated')
    if (userId === principal.userId && body.status === 'REMOVED') throw badRequest('You cannot deactivate yourself')

    const member = await first<{ id: string; status: string }>(
      c.env.DB,
      `SELECT id, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      [workspace.id, userId]
    )
    if (!member) throw notFound('That person is not in this workspace')

    if (body.status === 'ACTIVE' && workspace.organization_id) {
      await ensureOrgMembership(c.env.DB, workspace.organization_id, userId, principal.userId)
    }

    await run(c.env.DB, `UPDATE workspace_members SET status = ? WHERE id = ?`, [body.status, member.id])

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: body.status === 'ACTIVE' ? 'MEMBER_ADD' : 'MEMBER_REMOVE',
      targetType: 'user',
      targetId: userId,
      metadata: { from: member.status, to: body.status }
    })

    return ok(c, { userId, status: body.status })
  })
)

/**
 * An organization workspace's members must belong to the organization. Joining
 * through an invitation adds them as a plain MEMBER; someone the organization
 * itself has removed is not let back in through a workspace.
 */
async function ensureOrgMembership(db: D1Database, orgId: string, userId: string, actorId: string | null) {
  const existing = await first<{ status: string }>(
    db,
    `SELECT status FROM organization_members WHERE organization_id = ? AND user_id = ?`,
    [orgId, userId]
  )
  if (existing?.status === 'ACTIVE') return
  if (existing) throw forbidden('This person was removed from the organization. An organization admin has to add them back first.')
  await run(
    db,
    `INSERT INTO organization_members (id, organization_id, user_id, role, created_at, created_by, status)
     VALUES (?, ?, ?, 'MEMBER', ?, ?, 'ACTIVE')`,
    [prefixed('om', ulid()), orgId, userId, nowIso(), actorId]
  )
}

// ---------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------

manage.get(
  '/workspaces/:id/roles',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'artifact.read')
    return ok(c, {
      builtIn: BUILT_IN_TIERS,
      custom: (await customRoles(c.env.DB, workspace.id)).map((r) => presentRole(r))
    })
  })
)

manage.post(
  '/workspaces/:id/roles',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const body = await readJson<{ name?: string; permissions?: unknown }>(c)
    const name = String(body.name ?? '').trim()
    if (!name) throw badRequest('Give the tier a name')
    if (name.length > 40) throw badRequest('Tier names are at most 40 characters')
    if (BUILT_IN_TIERS.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`"${name}" is a built-in tier`)
    }
    const permissions = cleanPermissions(body.permissions ?? [])
    const clash = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM workspace_custom_roles WHERE workspace_id = ? AND lower(name) = lower(?) AND archived_at IS NULL`,
      [workspace.id, name]
    )
    if (clash) throw conflict('A tier with that name already exists')

    const id = prefixed('wcr', ulid())
    const timestamp = nowIso()
    await run(
      c.env.DB,
      `INSERT INTO workspace_custom_roles (id, workspace_id, name, permissions_json, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspace.id, name, JSON.stringify(permissions), principal.userId, timestamp, timestamp]
    )
    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ROLE_CHANGE',
      targetType: 'custom_role',
      targetId: id,
      metadata: { created: true, name, permissions }
    })
    return ok(c, { tier: { id, name, permissions, memberCount: 0, custom: true } }, 201)
  })
)

manage.patch(
  '/workspaces/:id/roles/:roleId',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const tier = await loadCustomRole(c.env.DB, workspace.id, c.req.param('roleId'))
    const body = await readJson<{ name?: string; permissions?: unknown }>(c)

    const name = body.name !== undefined ? String(body.name).trim() : tier.name
    if (!name || name.length > 40) throw badRequest('Tier names are 1 to 40 characters')
    const permissions = body.permissions !== undefined ? cleanPermissions(body.permissions) : parsePermissions(tier.permissions_json)

    await run(c.env.DB, `UPDATE workspace_custom_roles SET name = ?, permissions_json = ?, updated_at = ? WHERE id = ?`, [
      name,
      JSON.stringify(permissions),
      nowIso(),
      tier.id
    ])
    // Keep each member's stored base role in step with what the tier allows.
    await run(c.env.DB, `UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND custom_role_id = ?`, [
      baseRoleFor(permissions),
      workspace.id,
      tier.id
    ])
    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ROLE_CHANGE',
      targetType: 'custom_role',
      targetId: tier.id,
      metadata: { name, permissions }
    })
    return ok(c, { tier: { id: tier.id, name, permissions, custom: true } })
  })
)

/** Delete a tier. Its members fall back to the tier's base role (Member or Guest). */
manage.delete(
  '/workspaces/:id/roles/:roleId',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const tier = await loadCustomRole(c.env.DB, workspace.id, c.req.param('roleId'))
    const timestamp = nowIso()
    await run(c.env.DB, `UPDATE workspace_custom_roles SET archived_at = ?, updated_at = ? WHERE id = ?`, [timestamp, timestamp, tier.id])
    await run(c.env.DB, `UPDATE workspace_members SET custom_role_id = NULL WHERE workspace_id = ? AND custom_role_id = ?`, [workspace.id, tier.id])
    await run(
      c.env.DB,
      `UPDATE workspace_invitations SET custom_role_id = NULL WHERE workspace_id = ? AND custom_role_id = ?`,
      [workspace.id, tier.id]
    )
    const settings = parseWorkspaceSettings(workspace.settings_json)
    if (settings.invitations.defaultCustomRoleId === tier.id) {
      settings.invitations.defaultCustomRoleId = null
      await run(c.env.DB, `UPDATE workspaces SET settings_json = ? WHERE id = ?`, [JSON.stringify(settings), workspace.id])
    }
    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'ROLE_CHANGE',
      targetType: 'custom_role',
      targetId: tier.id,
      metadata: { deleted: true, name: tier.name }
    })
    return ok(c, { deleted: true })
  })
)

// ---------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------

interface InvitationRow {
  id: string
  workspace_id: string
  kind: 'EMAIL' | 'LINK'
  email_normalized: string | null
  token_hash: string
  token_prefix: string
  role: WorkspaceRole
  custom_role_id: string | null
  status: 'ACTIVE' | 'ACCEPTED' | 'REVOKED'
  max_uses: number | null
  use_count: number
  expires_at: string | null
  created_by_user_id: string | null
  created_at: string
  last_used_at: string | null
  accepted_by_user_id: string | null
}

function invitationExpired(i: InvitationRow): boolean {
  if (i.expires_at && Date.parse(i.expires_at) <= Date.now()) return true
  if (i.max_uses !== null && i.use_count >= i.max_uses) return true
  return false
}

function presentInvitation(i: InvitationRow, tiers: Map<string, string>) {
  return {
    id: i.id,
    kind: i.kind,
    email: i.email_normalized,
    tier: tierLabel(i.role, i.custom_role_id ? (tiers.get(i.custom_role_id) ?? null) : null, false),
    role: i.role,
    customRoleId: i.custom_role_id,
    tokenPrefix: i.token_prefix,
    maxUses: i.max_uses,
    useCount: i.use_count,
    expiresAt: i.expires_at,
    createdAt: i.created_at
  }
}

const hashInviteToken = (token: string) => hashShareToken(`invite:${token}`)

manage.get(
  '/workspaces/:id/invitations',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const rows = await all<InvitationRow>(
      c.env.DB,
      `SELECT * FROM workspace_invitations WHERE workspace_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC`,
      [workspace.id]
    )
    const tiers = new Map((await customRoles(c.env.DB, workspace.id)).map((r) => [r.id, r.name]))
    return ok(c, { invitations: rows.filter((r) => !invitationExpired(r)).map((r) => presentInvitation(r, tiers)) })
  })
)

manage.post(
  '/workspaces/:id/invitations',
  rateLimit({ bucket: 'workspace:invite', limit: 60, windowSeconds: 3600 }),
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    let workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const settings = parseWorkspaceSettings(workspace.settings_json)

    const body = await readJson<{
      kind?: 'EMAIL' | 'LINK'
      email?: string
      role?: WorkspaceRole
      customRoleId?: string | null
      expiresInDays?: number
      maxUses?: number | null
      convertToShared?: boolean
    }>(c)
    const kind = body.kind === 'LINK' ? 'LINK' : 'EMAIL'
    const personal = !workspace.organization_id

    let email: string | null = null
    if (kind === 'EMAIL') {
      email = normalizeEmail(body.email ?? '')
      if (!isValidEmail(email)) throw badRequest('Enter a valid email address')
      if (!emailAllowed(settings, email)) {
        throw badRequest(`This workspace only accepts people from ${settings.invitations.allowedDomains.join(', ')}`)
      }
      const already = await first<{ status: string }>(
        c.env.DB,
        `SELECT wm.status FROM workspace_members wm JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = ? AND u.email_normalized = ?`,
        [workspace.id, email]
      )
      if (already?.status === 'ACTIVE') throw conflict('That person is already a member of this workspace')
    }

    // Default tier comes from Invitation Controls unless the invite names one.
    const tier =
      body.role === undefined && body.customRoleId === undefined
        ? await resolveTier(c.env.DB, workspace.id, settings.invitations.defaultRole, settings.invitations.defaultCustomRoleId)
        : await resolveTier(c.env.DB, workspace.id, body.role, body.customRoleId)

    // Admin is never handed out by a reusable link: anyone holding it would get it.
    if (kind === 'LINK' && tier.role === 'WORKSPACE_ADMIN') {
      throw badRequest('Invite links cannot grant Admin. Invite admins by email.')
    }

    const days = Number.isFinite(body.expiresInDays) && (body.expiresInDays as number) > 0
      ? Math.min(Math.floor(body.expiresInDays as number), 90)
      : kind === 'EMAIL' ? 14 : 7
    const maxUses = kind === 'EMAIL'
      ? 1
      : body.maxUses === null || body.maxUses === undefined
        ? null
        : Math.max(1, Math.min(Math.floor(Number(body.maxUses)), 1000))

    // Inviting someone into a personal workspace makes it shared, which counts
    // as a separate workspace for billing later. Its owner must say yes first.
    if (personal) {
      if (workspace.owner_user_id !== principal.userId) {
        throw forbidden('Only the owner of a personal workspace can invite people to it')
      }
      if (body.convertToShared !== true) {
        throw new HttpError(
          409,
          'CONVERT_TO_SHARED',
          'Inviting someone turns this personal workspace into a shared workspace. Confirm to continue.'
        )
      }
      workspace = await convertToShared(c, workspace, principal.userId!)
    }

    const token = randomToken(24)
    const id = prefixed('inv', ulid())
    const timestamp = nowIso()
    const expiresAt = new Date(Date.now() + days * 86400_000).toISOString()

    // An earlier pending email invite to the same address is superseded.
    if (email) {
      await run(
        c.env.DB,
        `UPDATE workspace_invitations SET status = 'REVOKED'
          WHERE workspace_id = ? AND kind = 'EMAIL' AND email_normalized = ? AND status = 'ACTIVE'`,
        [workspace.id, email]
      )
    }

    await run(
      c.env.DB,
      `INSERT INTO workspace_invitations
         (id, workspace_id, kind, email_normalized, token_hash, token_prefix, role, custom_role_id,
          status, max_uses, use_count, expires_at, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 0, ?, ?, ?)`,
      [id, workspace.id, kind, email, await hashInviteToken(token), tokenPrefix(token), tier.role, tier.customRoleId, maxUses, expiresAt, principal.userId, timestamp]
    )

    const origin = c.env.APP_ORIGIN?.trim() || new URL(c.req.url).origin
    const url = `${origin}/join/${token}`

    // The invitation exists whether or not the email goes out; the admin can
    // always copy the link instead.
    let delivered: 'EMAIL' | 'NOT_SENT' | 'FAILED' = 'NOT_SENT'
    if (email && !devCodeMode(c.env)) {
      const inviter = principal.user?.display_name || principal.user?.email || 'A teammate'
      delivered = await sendEmail(
        c.env,
        email,
        `${inviter} invited you to ${workspace.name} on Artifactry`,
        `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(workspace.name)}</strong> on Artifactry.</p>
         <p><a href="${url}">Accept the invitation</a></p>
         <p style="color:#5a6066;font-size:13px">This link expires in ${days} days.</p>`
      ).then(
        () => 'EMAIL' as const,
        () => 'FAILED' as const
      )
    }

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'INVITATION_CREATE',
      targetType: 'invitation',
      targetId: id,
      metadata: { kind, email, role: tier.role, customRoleId: tier.customRoleId, expiresAt, maxUses }
    })

    const tiers = new Map((await customRoles(c.env.DB, workspace.id)).map((r) => [r.id, r.name]))
    const row = await first<InvitationRow>(c.env.DB, `SELECT * FROM workspace_invitations WHERE id = ?`, [id])
    // The raw link is returned exactly once, here, like a share token.
    return ok(c, { invitation: presentInvitation(row!, tiers), url, delivered, convertedToShared: personal }, 201)
  })
)

manage.delete(
  '/workspaces/:id/invitations/:inviteId',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const workspace = await assertWorkspaceAccess(c.env.DB, principal, c.req.param('id'), 'member.manage')
    const inviteId = c.req.param('inviteId')
    const row = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM workspace_invitations WHERE id = ? AND workspace_id = ?`,
      [inviteId, workspace.id]
    )
    if (!row) throw notFound('Invitation not found')
    await run(c.env.DB, `UPDATE workspace_invitations SET status = 'REVOKED' WHERE id = ?`, [inviteId])
    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'INVITATION_REVOKE',
      targetType: 'invitation',
      targetId: inviteId
    })
    return ok(c, { revoked: true })
  })
)

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

// ---------------------------------------------------------------
// Joining
// ---------------------------------------------------------------

type InviteCheck =
  | { ok: true; invitation: InvitationRow; workspace: WorkspaceRow }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' | 'USED' }

async function checkInvitation(db: D1Database, token: string): Promise<InviteCheck> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return { ok: false, reason: 'NOT_FOUND' }
  const invitation = await first<InvitationRow>(
    db,
    `SELECT * FROM workspace_invitations WHERE token_hash = ?`,
    [await hashInviteToken(token)]
  )
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' }
  if (invitation.status === 'REVOKED') return { ok: false, reason: 'REVOKED' }
  if (invitation.status === 'ACCEPTED') return { ok: false, reason: 'USED' }
  if (invitation.expires_at && Date.parse(invitation.expires_at) <= Date.now()) return { ok: false, reason: 'EXPIRED' }
  if (invitation.max_uses !== null && invitation.use_count >= invitation.max_uses) return { ok: false, reason: 'USED' }
  const workspace = await loadWorkspace(db, invitation.workspace_id)
  if (!workspace) return { ok: false, reason: 'NOT_FOUND' }
  return { ok: true, invitation, workspace }
}

/** Mask an invited address for the join page: a***@acme.com. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`
}

manage.get(
  '/invitations/:token',
  rateLimit({ bucket: 'invite:meta', limit: 120, windowSeconds: 300 }),
  guarded(async (c) => {
    const check = await checkInvitation(c.env.DB, c.req.param('token'))
    if (!check.ok) return ok(c, { valid: false, reason: check.reason })
    const { invitation, workspace } = check
    const settings = parseWorkspaceSettings(workspace.settings_json)
    const inviter = invitation.created_by_user_id
      ? await first<{ display_name: string | null; email: string }>(
          c.env.DB,
          `SELECT display_name, email FROM users WHERE id = ?`,
          [invitation.created_by_user_id]
        )
      : null
    return ok(c, {
      valid: true,
      workspace: { name: workspace.name, logoUrl: logoUrl(workspace) },
      invitedBy: inviter?.display_name || inviter?.email || null,
      kind: invitation.kind,
      emailHint: invitation.email_normalized ? maskEmail(invitation.email_normalized) : null,
      allowedDomains: settings.invitations.allowedDomains,
      requiresApproval: settings.invitations.requireApproval
    })
  })
)

manage.post(
  '/invitations/:token/accept',
  rateLimit({ bucket: 'invite:accept', limit: 30, windowSeconds: 600 }),
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const user = principal.user!
    const check = await checkInvitation(c.env.DB, c.req.param('token'))
    if (!check.ok) {
      const copy = {
        NOT_FOUND: 'This invitation is not valid.',
        EXPIRED: 'This invitation has expired. Ask for a new one.',
        REVOKED: 'This invitation was withdrawn.',
        USED: 'This invitation has already been used.'
      }[check.reason]
      throw new HttpError(410, `INVITATION_${check.reason}`, copy)
    }
    const { invitation, workspace } = check
    const settings = parseWorkspaceSettings(workspace.settings_json)
    const email = user.email_normalized

    if (invitation.kind === 'EMAIL' && invitation.email_normalized !== email) {
      throw forbidden(`This invitation was sent to ${maskEmail(invitation.email_normalized ?? '')}. Sign in with that address to accept it.`)
    }
    if (!emailAllowed(settings, email)) {
      throw forbidden(`This workspace only accepts people from ${settings.invitations.allowedDomains.join(', ')}.`)
    }

    const existing = await first<{ id: string; status: string }>(
      c.env.DB,
      `SELECT id, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      [workspace.id, user.id]
    )
    if (existing?.status === 'ACTIVE' || workspace.owner_user_id === user.id) {
      return ok(c, { status: 'ACTIVE', workspaceId: workspace.id, alreadyMember: true })
    }
    if (existing?.status === 'PENDING_APPROVAL') {
      return ok(c, { status: 'PENDING_APPROVAL', workspaceId: workspace.id })
    }
    // A deactivated person comes back only through an invitation addressed to them.
    if (existing?.status === 'REMOVED' && invitation.kind !== 'EMAIL') {
      throw forbidden('Your access to this workspace was turned off. Ask an admin to invite you by email.')
    }

    const status = settings.invitations.requireApproval ? 'PENDING_APPROVAL' : 'ACTIVE'
    if (status === 'ACTIVE' && workspace.organization_id) {
      await ensureOrgMembership(c.env.DB, workspace.organization_id, user.id, invitation.created_by_user_id)
    }

    // A tier deleted since the invite was sent falls back to its base role.
    let customRoleId = invitation.custom_role_id
    if (customRoleId) {
      const live = await first<{ id: string }>(
        c.env.DB,
        `SELECT id FROM workspace_custom_roles WHERE id = ? AND archived_at IS NULL`,
        [customRoleId]
      )
      if (!live) customRoleId = null
    }

    if (existing) {
      await run(c.env.DB, `UPDATE workspace_members SET status = ?, role = ?, custom_role_id = ? WHERE id = ?`, [
        status,
        invitation.role,
        customRoleId,
        existing.id
      ])
    } else {
      await run(
        c.env.DB,
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by, status, custom_role_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [prefixed('wsm', ulid()), workspace.id, user.id, invitation.role, nowIso(), invitation.created_by_user_id, status, customRoleId]
      )
    }

    await run(
      c.env.DB,
      `UPDATE workspace_invitations
          SET use_count = use_count + 1, last_used_at = ?,
              status = CASE WHEN kind = 'EMAIL' THEN 'ACCEPTED' ELSE status END,
              accepted_by_user_id = CASE WHEN kind = 'EMAIL' THEN ? ELSE accepted_by_user_id END
        WHERE id = ?`,
      [nowIso(), user.id, invitation.id]
    )

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorType: 'USER',
      action: 'INVITATION_ACCEPT',
      targetType: 'invitation',
      targetId: invitation.id,
      metadata: { status, role: invitation.role, customRoleId }
    })

    return ok(c, { status, workspaceId: workspace.id })
  })
)

// ---------------------------------------------------------------
// Profile pictures
// ---------------------------------------------------------------

/**
 * Any PNG, JPEG, WebP or GIF up to 1 MB is accepted whatever its shape or
 * size; the app crops it to fill a circle.
 */
manage.put(
  '/profile/avatar',
  rateLimit({ bucket: 'profile:avatar', limit: 30, windowSeconds: 3600 }),
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const user = principal.user!
    const bytes = await readPictureBody(c.req.raw)
    const type = assertPicture(bytes)

    const key = `avatars/${user.id}/${randomToken(12)}`
    await c.env.R2.put(key, bytes, { httpMetadata: { contentType: type } })
    const timestamp = nowIso()
    const url = avatarUrl({ id: user.id, avatar_r2_key: key, avatar_updated_at: timestamp })
    await run(c.env.DB, `UPDATE users SET avatar_r2_key = ?, avatar_updated_at = ?, avatar_url = ?, updated_at = ? WHERE id = ?`, [
      key,
      timestamp,
      url,
      timestamp,
      user.id
    ])
    if (user.avatar_r2_key) await c.env.R2.delete(user.avatar_r2_key).catch(() => {})

    await recordAudit(c.env.DB, {
      actorUserId: user.id,
      actorType: 'USER',
      action: 'PROFILE_UPDATE',
      targetType: 'user',
      targetId: user.id,
      metadata: { avatar: 'set', bytes: bytes.byteLength, type }
    })
    return ok(c, { avatarUrl: url })
  })
)

manage.delete(
  '/profile/avatar',
  guarded(async (c) => {
    const principal = sessionPrincipal(c)
    const user = principal.user!
    const timestamp = nowIso()
    await run(
      c.env.DB,
      `UPDATE users SET avatar_r2_key = NULL, avatar_updated_at = ?, avatar_url = NULL, updated_at = ? WHERE id = ?`,
      [timestamp, timestamp, user.id]
    )
    if (user.avatar_r2_key) await c.env.R2.delete(user.avatar_r2_key).catch(() => {})
    return ok(c, { avatarUrl: null })
  })
)

/** Profile pictures are visible to anyone signed in, like display names in a member list. */
manage.get(
  '/users/:id/avatar',
  guarded(async (c) => {
    requirePrincipal(c)
    const row = await first<{ avatar_r2_key: string | null }>(c.env.DB, `SELECT avatar_r2_key FROM users WHERE id = ?`, [
      c.req.param('id')
    ])
    if (!row?.avatar_r2_key) throw notFound('No picture')
    const object = await c.env.R2.get(row.avatar_r2_key)
    if (!object) throw notFound('No picture')
    return new Response(object.body, {
      headers: pictureHeaders(object.httpMetadata?.contentType ?? 'application/octet-stream', 'private, max-age=300')
    })
  })
)

export default manage
