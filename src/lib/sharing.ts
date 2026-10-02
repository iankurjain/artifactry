/**
 * Sharing — PRD §34–§41, §101, §102.
 *
 * Rules enforced here, all server-side:
 *   - Share tokens are cryptographically random and stored only as hashes (§36).
 *   - PUBLIC_LINK is off unless deliberately created; nothing is shared by
 *     default (§35, §63 "private by default").
 *   - EMAIL and DOMAIN shares require proof of control of the address before
 *     any artifact is rendered (§37, §38).
 *   - Expiry is evaluated on every access, and expired tokens stay on record
 *     for audit but grant nothing (§39).
 */

import type { AccessType, ArtifactRow, Principal, ShareRow, ShareTargetType } from '../types'
import { all, first, nowIso, run } from './db'
import { hashShareToken, tokenPrefix } from './crypto'
import { prefixed, randomToken, ulid } from './ids'
import { badRequest, forbidden, notFound } from './http'
import { emailDomain, isValidEmail, normalizeEmail } from './validate'
import { recordAudit } from './audit'
import { shareOriginForWorkspace } from './sharedomains'

export interface CreateShareInput {
  targetType: ShareTargetType
  targetId: string
  accessType: AccessType
  allowView: boolean
  allowDownload: boolean
  includeNewItems: boolean
  startsAt?: string | null
  expiresAt?: string | null
  recipients?: Array<{ type: 'EMAIL' | 'DOMAIN'; value: string }>
  title?: string | null
  note?: string | null
  /**
   * Named audiences this share is addressed to. Member addresses are ALSO
   * written into share_recipients (so the existing EMAIL path works unchanged),
   * while these links additionally keep access live: a current active member of
   * a linked team is accepted by evaluateShareAccess(), so adding someone to
   * "Board prep" grants them access without re-issuing the link.
   */
  teamIds?: string[]
}

export interface CreatedShare {
  share: ShareRow
  /** Raw token — returned exactly once, at creation, and never persisted. */
  token: string
  url: string
}

/**
 * Create a share and return its URL. The raw token exists only in this
 * response; only its SHA-256 hash is stored. `origin` is the fallback origin
 * for the link when the share's workspace has no active share domain.
 */
export async function createShare(
  db: D1Database,
  principal: Principal,
  input: CreateShareInput,
  origin: string
): Promise<CreatedShare> {
  if (!principal.userId) throw forbidden()

  if (!input.allowView && !input.allowDownload) {
    throw badRequest('Select at least View or Download')
  }

  if (input.accessType !== 'PUBLIC_LINK') {
    if (!input.recipients?.length) {
      throw badRequest(
        input.accessType === 'EMAIL'
          ? 'Add at least one email address'
          : 'Add at least one email domain'
      )
    }
  }

  if (input.startsAt && input.expiresAt && new Date(input.expiresAt) <= new Date(input.startsAt)) {
    throw badRequest('Expiry must be after the start time')
  }

  const normalizedRecipients = normalizeRecipients(input.accessType, input.recipients ?? [])

  // A share's organization is inherited from its target, never from the client
  const target = await resolveTarget(db, input.targetType, input.targetId)

  const token = randomToken(32)
  const tokenHash = await hashShareToken(token)
  const timestamp = nowIso()

  const shareId = prefixed('shr', ulid())

  const orgId =
    input.targetType === 'ARTIFACT'
      ? target.organizationId
      : ((target as { organizationId?: string | null }).organizationId ?? null)

  await run(
    db,
    `INSERT INTO shares
       (id, organization_id, workspace_id, created_by_user_id, target_type, target_id,
        access_type, allow_view, allow_download, include_new_items, starts_at, expires_at,
        token_hash, token_prefix, status, title, note, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, NULL)`,
    [
      shareId,
      orgId,
      target.workspaceId,
      principal.userId,
      input.targetType,
      input.targetId,
      input.accessType,
      input.allowView ? 1 : 0,
      input.allowDownload ? 1 : 0,
      input.includeNewItems ? 1 : 0,
      input.startsAt ?? timestamp,
      input.expiresAt ?? null,
      tokenHash,
      tokenPrefix(token),
      input.title ?? null,
      input.note ?? null,
      timestamp,
      timestamp
    ]
  )

  for (const recipient of normalizedRecipients) {
    await run(
      db,
      `INSERT INTO share_recipients (id, share_id, recipient_type, recipient_value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [prefixed('shr', ulid()), shareId, recipient.type, recipient.value, timestamp]
    )
  }

  for (const teamId of [...new Set(input.teamIds ?? [])]) {
    await run(
      db,
      `INSERT OR IGNORE INTO share_teams (id, share_id, team_id, created_at) VALUES (?, ?, ?, ?)`,
      [prefixed('sht', ulid()), shareId, teamId, timestamp]
    )
  }

  const share = await first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, [shareId])
  if (!share) throw new Error('Failed to create share')

  await recordAudit(db, {
    organizationId: orgId,
    workspaceId: target.workspaceId,
    actorUserId: principal.userId,
    actorType: principal.kind === 'AI_GRANT' ? 'AI' : 'USER',
    action: 'SHARE_CREATE',
    targetType: input.targetType.toLowerCase(),
    targetId: input.targetId,
    metadata: {
      shareId,
      accessType: input.accessType,
      allowView: input.allowView,
      allowDownload: input.allowDownload,
      expiresAt: input.expiresAt ?? null,
      recipientCount: normalizedRecipients.length,
      teamIds: input.teamIds ?? []
    }
  })

  // A workspace with an active custom share domain issues its links there;
  // every other workspace uses the caller's origin.
  const linkOrigin = (await shareOriginForWorkspace(db, target.workspaceId)) ?? origin

  return { share, token, url: `${linkOrigin}/s/${token}` }
}

function normalizeRecipients(
  accessType: AccessType,
  recipients: Array<{ type: 'EMAIL' | 'DOMAIN'; value: string }>
): Array<{ type: 'EMAIL' | 'DOMAIN'; value: string }> {
  const out: Array<{ type: 'EMAIL' | 'DOMAIN'; value: string }> = []
  const seen = new Set<string>()

  for (const raw of recipients) {
    const value = raw.value.trim().toLowerCase().replace(/^@/, '')
    if (!value) continue

    if (accessType === 'EMAIL') {
      const email = normalizeEmail(value)
      if (!isValidEmail(email)) throw badRequest(`"${raw.value}" is not a valid email address`)
      const key = `EMAIL:${email}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: 'EMAIL', value: email })
    } else if (accessType === 'DOMAIN') {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) {
        throw badRequest(`"${raw.value}" is not a valid email domain`)
      }
      const key = `DOMAIN:${value}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ type: 'DOMAIN', value })
    }
  }

  return out
}

interface TargetInfo {
  workspaceId: string
  organizationId: string | null
  title: string
}

async function resolveTarget(
  db: D1Database,
  targetType: ShareTargetType,
  targetId: string
): Promise<TargetInfo> {
  if (targetType === 'ARTIFACT') {
    const artifact = await first<ArtifactRow & { workspace_name: string | null }>(
      db,
      `SELECT a.*, NULL AS workspace_name FROM artifacts a WHERE a.id = ? AND a.deleted_at IS NULL`,
      [targetId]
    )
    if (!artifact) throw notFound('Artifact not found')
    return {
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      title: artifact.title
    }
  }

  const collection = await first<{
    id: string
    workspace_id: string
    organization_id: string | null
    name: string
  }>(db, `SELECT * FROM collections WHERE id = ? AND archived_at IS NULL`, [targetId])
  if (!collection) throw notFound('Collection not found')
  return {
    workspaceId: collection.workspace_id,
    organizationId: collection.organization_id,
    title: collection.name
  }
}

// ---------------------------------------------------------------
// Resolution + authorization of an incoming share link
// ---------------------------------------------------------------

export type ShareDenialReason =
  | 'NOT_FOUND'
  | 'REVOKED'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'VERIFICATION_REQUIRED'
  | 'EMAIL_MISMATCH'

export interface ShareResolution {
  allowed: boolean
  reason?: ShareDenialReason
  share?: ShareRow
  /** Recipient email that has proven control, when applicable */
  verifiedEmail?: string
}

/** Effective status, folding in the time window (§39). */
export function shareEffectiveStatus(share: ShareRow, at: Date = new Date()): ShareRow['status'] {
  if (share.status === 'REVOKED') return 'REVOKED'
  if (share.expires_at && new Date(share.expires_at).getTime() <= at.getTime()) return 'EXPIRED'
  return 'ACTIVE'
}

export async function findShareByToken(db: D1Database, token: string): Promise<ShareRow | null> {
  const tokenHash = await hashShareToken(token)
  return first<ShareRow>(db, `SELECT * FROM shares WHERE token_hash = ?`, [tokenHash])
}

/**
 * Decide whether a visitor may open a share.
 *
 * `verifiedEmail` comes from a share-access grant cookie, i.e. the visitor has
 * already proven control of that address via OTP. Merely typing an address
 * never grants access (§38).
 */
export async function evaluateShareAccess(
  db: D1Database,
  share: ShareRow,
  verifiedEmail: string | null
): Promise<ShareResolution> {
  const status = shareEffectiveStatus(share)

  if (status === 'REVOKED') return { allowed: false, reason: 'REVOKED', share }
  if (share.starts_at && new Date(share.starts_at).getTime() > Date.now()) {
    return { allowed: false, reason: 'NOT_STARTED', share }
  }
  if (status === 'EXPIRED') return { allowed: false, reason: 'EXPIRED', share }

  if (share.access_type === 'PUBLIC_LINK') {
    return { allowed: true, share }
  }

  if (!verifiedEmail) {
    return { allowed: false, reason: 'VERIFICATION_REQUIRED', share }
  }

  const normalized = normalizeEmail(verifiedEmail)

  if (share.access_type === 'EMAIL') {
    const match = await first<{ id: string }>(
      db,
      `SELECT id FROM share_recipients
        WHERE share_id = ? AND recipient_type = 'EMAIL' AND recipient_value = ?`,
      [share.id, normalized]
    )
    if (match) return { allowed: true, share, verifiedEmail: normalized }

    // Named-audience membership. The share may have been addressed to a team
    // whose membership has changed since; a person who is on that team now is a
    // legitimate recipient, and one who has been removed is not. Access is
    // therefore evaluated against current membership rather than a snapshot.
    if (await isActiveMemberOfLinkedTeam(db, share.id, normalized)) {
      return { allowed: true, share, verifiedEmail: normalized }
    }

    return { allowed: false, reason: 'EMAIL_MISMATCH', share }
  }

  if (share.access_type === 'DOMAIN') {
    const domain = emailDomain(normalized)
    const match = await first<{ id: string }>(
      db,
      `SELECT id FROM share_recipients
        WHERE share_id = ? AND recipient_type = 'DOMAIN' AND recipient_value = ?`,
      [share.id, domain]
    )
    if (!match) return { allowed: false, reason: 'EMAIL_MISMATCH', share }
    return { allowed: true, share, verifiedEmail: normalized }
  }

  return { allowed: false, reason: 'NOT_FOUND', share }
}

/**
 * Is this verified address a current active member of a team linked to the share?
 *
 * Only ACTIVE teams count: deactivating an audience must withdraw the access it
 * conferred, which is the whole point of making membership live.
 */
async function isActiveMemberOfLinkedTeam(
  db: D1Database,
  shareId: string,
  emailNormalized: string
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT m.id FROM share_teams st
       JOIN teams t ON t.id = st.team_id AND t.status = 'ACTIVE'
       JOIN team_members m ON m.team_id = t.id
      WHERE st.share_id = ?
        AND m.email_normalized = ?
        AND m.status = 'ACTIVE'
      LIMIT 1`,
    [shareId, emailNormalized]
  )
  return !!row
}

export async function listShares(
  db: D1Database,
  filter: { createdBy?: string; targetType?: ShareTargetType; targetId?: string },
  limit = 100
): Promise<Array<ShareRow & { target_title: string | null; open_count: number }>> {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.createdBy) {
    where.push('s.created_by_user_id = ?')
    params.push(filter.createdBy)
  }
  if (filter.targetType) {
    where.push('s.target_type = ?')
    params.push(filter.targetType)
  }
  if (filter.targetId) {
    where.push('s.target_id = ?')
    params.push(filter.targetId)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  return all(
    db,
    `SELECT s.*,
            COALESCE(a.title, c.name) AS target_title,
            (SELECT COUNT(*) FROM artifact_events e
              WHERE e.share_id = s.id AND e.event_type IN ('share_opened','artifact_viewed')) AS open_count
       FROM shares s
       LEFT JOIN artifacts a ON s.target_type = 'ARTIFACT' AND a.id = s.target_id
       LEFT JOIN collections c ON s.target_type = 'COLLECTION' AND c.id = s.target_id
       ${clause}
      ORDER BY s.created_at DESC
      LIMIT ?`,
    [...params, limit]
  )
}

export async function revokeShare(db: D1Database, shareId: string): Promise<void> {
  await run(db, `UPDATE shares SET status = 'REVOKED', revoked_at = ?, updated_at = ? WHERE id = ?`, [
    nowIso(),
    nowIso(),
    shareId
  ])
}

export async function updateShare(
  db: D1Database,
  shareId: string,
  patch: {
    allowView?: boolean
    allowDownload?: boolean
    expiresAt?: string | null
    includeNewItems?: boolean
  }
): Promise<ShareRow | null> {
  const sets: string[] = []
  const params: unknown[] = []

  if (patch.allowView !== undefined) {
    sets.push('allow_view = ?')
    params.push(patch.allowView ? 1 : 0)
  }
  if (patch.allowDownload !== undefined) {
    sets.push('allow_download = ?')
    params.push(patch.allowDownload ? 1 : 0)
  }
  if (patch.expiresAt !== undefined) {
    sets.push('expires_at = ?')
    params.push(patch.expiresAt)
  }
  if (patch.includeNewItems !== undefined) {
    sets.push('include_new_items = ?')
    params.push(patch.includeNewItems ? 1 : 0)
  }

  if (!sets.length) return first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, [shareId])

  sets.push('updated_at = ?')
  params.push(nowIso())

  await run(db, `UPDATE shares SET ${sets.join(', ')} WHERE id = ?`, [...params, shareId])
  return first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, [shareId])
}

/**
 * Expand a collection share into its member artifacts.
 *
 * New artifacts added after the share was created are included when
 * include_new_items is set — the documented V1 default (§41), and the UI
 * states this explicitly.
 */
export async function artifactsForCollectionShare(
  db: D1Database,
  collectionId: string,
  includeNewItems: boolean
): Promise<ArtifactRow[]> {
  if (!includeNewItems) return []
  return all<ArtifactRow>(
    db,
    `SELECT a.* FROM collection_artifacts ca
       JOIN artifacts a ON a.id = ca.artifact_id
      WHERE ca.collection_id = ? AND a.deleted_at IS NULL
      ORDER BY ca.added_at DESC`,
    [collectionId]
  )
}

/** External recipients see only the shared item — no internal context (§42). */
export function externalShareView(
  share: ShareRow,
  target: { kind: 'ARTIFACT'; artifact: ArtifactRow } | { kind: 'COLLECTION'; items: ArtifactRow[] }
) {
  const base = {
    accessType: share.access_type,
    allowView: !!share.allow_view,
    allowDownload: !!share.allow_download,
    expiresAt: share.expires_at,
    sharedAt: share.created_at
  }

  if (target.kind === 'ARTIFACT') {
    const a = target.artifact
    return {
      ...base,
      kind: 'ARTIFACT' as const,
      item: {
        id: a.id,
        title: a.title,
        description: a.description,
        filename: a.filename,
        extension: a.extension,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        updatedAt: a.updated_at
      }
    }
  }

  return {
    ...base,
    kind: 'COLLECTION' as const,
    items: target.items.map((a) => ({
      id: a.id,
      title: a.title,
      filename: a.filename,
      extension: a.extension,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      updatedAt: a.updated_at
    }))
  }
}

/** Resolve which artifacts a share exposes, without leaking internal fields. */
export async function shareCoversArtifact(
  db: D1Database,
  share: ShareRow,
  artifactId: string
): Promise<boolean> {
  if (share.target_type === 'ARTIFACT') return share.target_id === artifactId

  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM collection_artifacts WHERE collection_id = ? AND artifact_id = ?`,
    [share.target_id, artifactId]
  )
  return !!row
}
