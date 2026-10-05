/**
 * Audit trail — PRD §70.
 *
 * Deliberately separate from product analytics (§49): audit records answer
 * "who did what", analytics answers "how is this artifact being consumed".
 * Audit rows are append-only and never aggregated away.
 */

import type { ActorType } from '../types'
import { nowIso, run } from './db'
import { prefixed, ulid } from './ids'

export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'ARTIFACT_CREATE'
  | 'ARTIFACT_VIEW'
  | 'ARTIFACT_DOWNLOAD'
  | 'ARTIFACT_DELETE'
  | 'ARTIFACT_UPDATE'
  | 'ARTIFACT_REPROCESS'
  | 'ARTIFACT_PREVIEW_MODE'
  | 'ARTIFACT_VERSION_CREATE'
  | 'SHARE_CREATE'
  | 'SHARE_ACCESS'
  | 'SHARE_ACCESS_DENIED'
  | 'SHARE_REVOKE'
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'ROLE_CHANGE'
  | 'TAG_CREATE'
  | 'TAG_UPDATE'
  | 'TAG_DELETE'
  | 'WORKSPACE_CREATE'
  | 'ORGANIZATION_CREATE'
  | 'TEAM_CREATE'
  | 'TEAM_UPDATE'
  | 'TEAM_MEMBER_ADD'
  | 'TEAM_MEMBER_REMOVE'
  | 'TAG_SUGGEST'
  | 'TAG_ACCEPT'
  | 'TAG_REJECT'
  | 'AI_CONNECT'
  | 'AI_DISCONNECT'
  | 'AI_FETCH'
  | 'AI_CREATE'
  | 'AI_CONFIRM_REQUESTED'
  | 'AI_CONFIRM_GRANTED'
  | 'AI_CONFIRM_DENIED'
  | 'SHARE_DOMAIN_SET'
  | 'SHARE_DOMAIN_VERIFIED'
  | 'SHARE_DOMAIN_ACTIVATED'
  | 'SHARE_DOMAIN_REMOVE'
  | 'WORKSPACE_UPDATE'
  | 'WORKSPACE_CONVERT_SHARED'
  | 'INVITATION_CREATE'
  | 'INVITATION_REVOKE'
  | 'INVITATION_ACCEPT'
  | 'PROFILE_UPDATE'
  | 'HANDOFF_CREATE'
  | 'HANDOFF_PICKUP'
  | 'HANDOFF_STATUS'
  | 'LINEAGE_ADD'
  | 'LINEAGE_REMOVE'
  | 'COLLECTION_PROJECT'

export interface AuditInput {
  organizationId?: string | null
  workspaceId?: string | null
  actorUserId?: string | null
  actorType: ActorType
  action: AuditAction
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown>
  ipCountry?: string | null
}

/**
 * Record an audit event. Failures are logged but never surface to the caller —
 * an audit write must not break the user's action, and the error is visible
 * in Worker logs for follow-up.
 */
export async function recordAudit(db: D1Database, input: AuditInput): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO audit_events
         (id, organization_id, workspace_id, actor_user_id, actor_type, action,
          target_type, target_id, metadata_json, ip_country, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prefixed('aud', ulid()),
        input.organizationId ?? null,
        input.workspaceId ?? null,
        input.actorUserId ?? null,
        input.actorType,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ipCountry ?? null,
        nowIso()
      ]
    )
  } catch (err) {
    console.error('[audit] failed to write audit event', input.action, err)
  }
}
