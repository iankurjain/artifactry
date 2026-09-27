/**
 * Artifact-level authorization helpers.
 *
 * Loads an artifact and derives what the current principal may do with it.
 * Used by every artifact-touching route so the rules live in exactly one
 * place (§29).
 */

import type { ArtifactRow, Permission, Principal } from '../types'
import { first } from './db'
import { forbidden, notFound } from './http'
import { can, requireAuth } from './principal'

export interface ArtifactAccess {
  artifact: ArtifactRow
  isOwner: boolean
  allowView: boolean
  allowDownload: boolean
  allowWrite: boolean
}

/** Load an artifact, or 404. Non-existent and inaccessible are distinct here
 * only because the caller already proved workspace membership; the route layer
 * converts disallowed reads to 404 so ids cannot be probed. */
export async function loadArtifactFor(
  db: D1Database,
  artifactId: string
): Promise<ArtifactRow | null> {
  return first<ArtifactRow>(db, `SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL`, [
    artifactId
  ])
}

export function workspaceRefOf(artifact: ArtifactRow) {
  return {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  }
}

export async function artifactAccess(
  db: D1Database,
  principal: Principal,
  artifactId: string
): Promise<ArtifactAccess> {
  requireAuth(principal)
  const artifact = await loadArtifactFor(db, artifactId)
  if (!artifact) throw notFound('Artifact not found')

  const ref = workspaceRefOf(artifact)
  const isOwner = artifact.owner_user_id === principal.userId

  const allowView = isOwner || can(principal, 'artifact.read', ref)
  if (!allowView) throw notFound('Artifact not found')

  return {
    artifact,
    isOwner,
    allowView,
    allowDownload: isOwner || can(principal, 'artifact.download', ref),
    allowWrite:
      isOwner ||
      can(principal, 'artifact.update', ref) ||
      can(principal, 'artifact.version.create', ref)
  }
}

/** Assert a specific permission on an artifact, else 403. */
export async function assertArtifactPermission(
  db: D1Database,
  principal: Principal,
  artifactId: string,
  permission: Permission
): Promise<ArtifactRow> {
  requireAuth(principal)
  const artifact = await loadArtifactFor(db, artifactId)
  if (!artifact) throw notFound('Artifact not found')

  const ref = workspaceRefOf(artifact)
  if (artifact.owner_user_id === principal.userId) return artifact
  if (!can(principal, permission, ref)) throw forbidden()

  return artifact
}

/**
 * Whether the principal may read analytics for an artifact (§47):
 * the owner, or a workspace/org admin.
 */
export function mayReadAnalytics(
  principal: Principal,
  artifact: ArtifactRow,
  workspaceRole: string | null
): boolean {
  if (artifact.owner_user_id === principal.userId) return true
  return (
    workspaceRole === 'WORKSPACE_ADMIN' ||
    principal.orgRoles[artifact.organization_id ?? ''] === 'ORG_ADMIN' ||
    principal.orgRoles[artifact.organization_id ?? ''] === 'ORG_OWNER'
  )
}
