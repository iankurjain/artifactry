/**
 * Authorization engine — PRD §29, §47, §59, §64.
 *
 *   Authenticated Identity → Tenant → Workspace Membership → Role →
 *   Artifact Permission → Share Policy → Allowed / Denied
 *
 * Every rule here is evaluated server-side. A client-supplied
 * organization_id or workspace_id is never trusted; scopes are always
 * derived from the authenticated principal.
 */

import type { Context } from 'hono'
import type {
  AiScope,
  ArtifactRow,
  OrgRole,
  Permission,
  Principal,
  ROLE_PERMISSIONS,
  UserRow,
  WorkspaceRole,
  WorkspaceRow
} from '../types'
import { ROLE_PERMISSIONS as ROLE_PERMS } from '../types'
import { all, first, nowIso } from './db'
import { forbidden, readBearer, readSessionCookie, unauthorized } from './http'
import { hashGrantToken, hashSessionToken } from './crypto'

export const EMPTY_PRINCIPAL: Principal = {
  kind: 'NONE',
  userId: null,
  user: null,
  orgRoles: {},
  workspaceRoles: {},
  scopes: []
}

interface SessionRow {
  id: string
  user_id: string
  expires_at: string
  revoked_at: string | null
}

interface GrantRow {
  id: string
  integration_id: string
  user_id: string
  scopes: string
  status: string
  client_name: string | null
  client_version: string | null
}

/**
 * Resolve the caller.
 *
 * Order matters: an explicit Bearer token (an AI connector acting on behalf
 * of a user) takes precedence over an ambient browser cookie, because a
 * connector must never silently inherit more authority from a browser
 * session (PRD §59 — AI permission <= authenticated user's permission).
 */
export async function resolvePrincipal(c: Context): Promise<Principal> {
  const db = c.env.DB as D1Database

  const bearer = readBearer(c)
  if (bearer) {
    const grant = await resolveAiGrant(db, bearer)
    if (grant) return grant
    throw unauthorized('Invalid or expired access token')
  }

  const cookie = readSessionCookie(c)
  if (!cookie) return EMPTY_PRINCIPAL

  const tokenHash = await hashSessionToken(cookie)
  const session = await first<SessionRow>(
    db,
    `SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?`,
    [tokenHash]
  )
  if (!session) return EMPTY_PRINCIPAL
  if (session.revoked_at) return EMPTY_PRINCIPAL
  if (new Date(session.expires_at).getTime() <= Date.now()) return EMPTY_PRINCIPAL

  const user = await first<UserRow>(db, `SELECT * FROM users WHERE id = ?`, [session.user_id])
  if (!user || user.status !== 'ACTIVE') return EMPTY_PRINCIPAL

  // Touch last_seen without blocking the request path semantics
  await db
    .prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(nowIso(), session.id)
    .run()

  const { orgRoles, workspaceRoles } = await loadRoles(db, user.id)

  return {
    kind: 'SESSION',
    userId: user.id,
    user,
    orgRoles,
    workspaceRoles,
    scopes: []
  }
}

async function resolveAiGrant(db: D1Database, rawToken: string): Promise<Principal | null> {
  const tokenHash = await hashGrantToken(rawToken)
  const grant = await first<GrantRow>(
    db,
    `SELECT id, integration_id, user_id, scopes, status, client_name, client_version
       FROM integration_grants WHERE token_hash = ?`,
    [tokenHash]
  )
  if (!grant || grant.status !== 'ACTIVE') return null

  const user = await first<UserRow>(db, `SELECT * FROM users WHERE id = ?`, [grant.user_id])
  if (!user || user.status !== 'ACTIVE') return null

  const integration = await first<{ provider: string }>(
    db,
    `SELECT provider FROM integrations WHERE id = ?`,
    [grant.integration_id]
  )

  const { orgRoles, workspaceRoles } = await loadRoles(db, user.id)

  await db
    .prepare(`UPDATE integration_grants SET last_used_at = ? WHERE id = ?`)
    .bind(nowIso(), grant.id)
    .run()

  let scopes: AiScope[] = []
  try {
    const parsed = JSON.parse(grant.scopes)
    if (Array.isArray(parsed)) scopes = parsed as AiScope[]
  } catch {
    scopes = []
  }

  return {
    kind: 'AI_GRANT',
    userId: user.id,
    user,
    orgRoles,
    workspaceRoles,
    scopes,
    integrationId: grant.integration_id,
    grantId: grant.id,
    provider: (integration?.provider as Principal['provider']) ?? undefined,
    // Reported by the client during `initialize`; null until it has connected
    // once. Only ever what the client says about itself.
    clientName: grant.client_name ?? undefined,
    clientVersion: grant.client_version ?? undefined
  }
}

async function loadRoles(db: D1Database, userId: string) {  const orgRows = await all<{ organization_id: string; role: OrgRole }>(
    db,
    `SELECT organization_id, role FROM organization_members
      WHERE user_id = ? AND status = 'ACTIVE'`,
    [userId]
  )
  const wsRows = await all<{ workspace_id: string; role: WorkspaceRole }>(
    db,
    `SELECT workspace_id, role FROM workspace_members
      WHERE user_id = ? AND status = 'ACTIVE'`,
    [userId]
  )

  const orgRoles: Record<string, OrgRole> = {}
  for (const row of orgRows) orgRoles[row.organization_id] = row.role

  const workspaceRoles: Record<string, WorkspaceRole> = {}
  for (const row of wsRows) workspaceRoles[row.workspace_id] = row.role

  return { orgRoles, workspaceRoles }
}

export function requireAuth(principal: Principal): Principal {
  if (!principal.userId || !principal.user) throw unauthorized()
  return principal
}

/**
 * Effective role for a workspace, resolving inherited organization roles.
 * An ORG_OWNER/ORG_ADMIN implicitly administers every workspace in the org.
 */
export function effectiveWorkspaceRole(
  principal: Principal,
  workspace: Pick<WorkspaceRow, 'id' | 'organization_id' | 'owner_user_id'>
): WorkspaceRole | null {
  if (!principal.userId) return null

  // Workspace owner always retains administrative control (PRD §6)
  if (workspace.owner_user_id === principal.userId) return 'WORKSPACE_ADMIN'

  const direct = principal.workspaceRoles[workspace.id]
  if (direct) return direct

  if (workspace.organization_id && workspace.organization_id in principal.orgRoles) {
    const role = principal.orgRoles[workspace.organization_id]
    if (role === 'ORG_OWNER' || role === 'ORG_ADMIN') return 'WORKSPACE_ADMIN'
    // Plain org membership grants read-only visibility of org workspaces
    if (role === 'MEMBER') return 'VIEWER'
  }

  return null
}

export function permissionsForRole(role: WorkspaceRole | OrgRole | null): Permission[] {
  if (!role) return []
  return (ROLE_PERMS as Record<string, Permission[]>)[role] ?? []
}

export function can(
  principal: Principal,
  permission: Permission,
  workspace?: Pick<WorkspaceRow, 'id' | 'organization_id' | 'owner_user_id'>
): boolean {
  if (!principal.userId) return false

  // AI grants are additionally constrained by their OAuth scopes (PRD §58)
  if (!aiScopeAllows(principal, permission)) return false

  if (!workspace) return true
  const role = effectiveWorkspaceRole(principal, workspace)
  return permissionsForRole(role).includes(permission)
}

/** Map an artifact-facing permission onto the AI scope vocabulary. */
function aiScopeAllows(principal: Principal, permission: Permission): boolean {
  if (principal.kind !== 'AI_GRANT') return true
  const scopes = principal.scopes

  switch (permission) {
    case 'artifact.read':
    case 'artifact.download':
      return scopes.includes('artifact.read')
    case 'artifact.create':
    case 'artifact.update':
    case 'artifact.delete':
    case 'artifact.version.create':
    case 'artifact.tag.apply':
    case 'collection.manage':
      return scopes.includes('artifact.write')
    case 'share.create':
    case 'share.revoke':
      return scopes.includes('artifact.share')
    case 'analytics.read.artifact':
    case 'analytics.read.workspace':
    case 'analytics.read.organization':
      return scopes.includes('artifact.analytics.read')
    case 'workspace.manage':
    case 'member.manage':
      return scopes.includes('workspace.read')
    case 'tag.manage':
      return scopes.includes('tags.read')
    // Teams are readable by a connector so it can address an audience by name
    // ("share with Board prep"); managing an audience is a UI/administrative act
    // and is deliberately NOT reachable from an AI grant (there is no team.write
    // scope), so this falls through to false.
    case 'team.read':
      return scopes.includes('team.read')
    default:
      return false
  }
}

/** Workspaces the principal may read, used to scope every search query. */
export async function readableWorkspaces(
  db: D1Database,
  principal: Principal
): Promise<WorkspaceRow[]> {
  if (!principal.userId) return []

  const memberRows = await all<WorkspaceRow>(
    db,
    `SELECT DISTINCT w.* FROM workspaces w
       LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ? AND wm.status = 'ACTIVE'
       LEFT JOIN organization_members om ON om.organization_id = w.organization_id AND om.user_id = ? AND om.status = 'ACTIVE'
      WHERE w.archived_at IS NULL
        AND (w.owner_user_id = ? OR wm.user_id IS NOT NULL OR om.user_id IS NOT NULL)
      ORDER BY w.workspace_type ASC, w.name ASC`,
    [principal.userId, principal.userId, principal.userId]
  )
  return memberRows
}

export async function loadWorkspace(
  db: D1Database,
  workspaceId: string
): Promise<WorkspaceRow | null> {
  return first<WorkspaceRow>(db, `SELECT * FROM workspaces WHERE id = ? AND archived_at IS NULL`, [
    workspaceId
  ])
}

/** Assert read/write access to a workspace, else 403 (never 404-leak here). */
export async function assertWorkspaceAccess(
  db: D1Database,
  principal: Principal,
  workspaceId: string,
  permission: Permission = 'artifact.read'
): Promise<WorkspaceRow> {
  requireAuth(principal)
  const workspace = await loadWorkspace(db, workspaceId)
  if (!workspace) throw forbidden()
  if (!can(principal, permission, workspace)) throw forbidden()
  return workspace
}

export function isAiPrincipal(principal: Principal): boolean {
  return principal.kind === 'AI_GRANT'
}
