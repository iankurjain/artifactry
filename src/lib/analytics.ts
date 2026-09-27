/**
 * Product analytics — PRD §43–§49, §104.
 *
 * Design constraints taken directly from the PRD:
 *   - Raw events are retained for the activity feed, but page loads must never
 *     aggregate millions of rows. Daily rollups are maintained incrementally
 *     on write (§104).
 *   - "Unique viewer" is a real distinct count, tracked via a uniqueness key
 *     table — not an estimate (§45).
 *   - Anonymous public-link viewers get session-level uniqueness only, with a
 *     daily-rotating key. No fingerprinting (§45, §48).
 */

import type { AccessChannel, ActorType } from '../types'
import { all, first, metricDate, nowIso, ps, run } from './db'
import { viewerKey } from './crypto'
import { prefixed, ulid } from './ids'

export type EventType =
  | 'artifact_viewed'
  | 'artifact_downloaded'
  | 'artifact_shared'
  | 'share_opened'
  | 'share_access_granted'
  | 'share_access_denied'
  | 'artifact_ai_retrieved'
  | 'artifact_ai_referenced'
  | 'artifact_version_created'

export interface EventInput {
  artifactId?: string | null
  workspaceId?: string | null
  organizationId?: string | null
  collectionId?: string | null
  shareId?: string | null
  eventType: EventType
  actorType: ActorType
  actorUserId?: string | null
  actorLabel?: string | null
  aiProvider?: string | null
  accessChannel: AccessChannel
  /** Stable per-visit identifier used to derive the privacy-safe viewer key. */
  sessionSeed?: string | null
  metadata?: Record<string, unknown>
}

interface CounterDelta {
  views?: number
  uniqueViewers?: number
  downloads?: number
  uniqueDownloaders?: number
  internalViews?: number
  externalViews?: number
  publicLinkViews?: number
  emailViews?: number
  domainViews?: number
  aiReferences?: number
  shareOpens?: number
  deniedRequests?: number
}

/**
 * Record an event and fold it into the artifact's daily rollup.
 *
 * Rollup writes are skipped for artifact-less events (logins, share creation),
 * which still land in the raw event table for the audit/activity views.
 */
export async function recordEvent(db: D1Database, input: EventInput): Promise<void> {
  const occurredAt = nowIso()
  const day = metricDate()
  const sessionSeed = input.sessionSeed ?? null

  try {
    await run(
      db,
      `INSERT INTO artifact_events
         (id, artifact_id, workspace_id, organization_id, collection_id, share_id,
          event_type, actor_type, actor_user_id, actor_label, ai_provider,
          access_channel, session_hash, metadata_json, occurred_at, metric_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prefixed('evt', ulid()),
        input.artifactId ?? null,
        input.workspaceId ?? null,
        input.organizationId ?? null,
        input.collectionId ?? null,
        input.shareId ?? null,
        input.eventType,
        input.actorType,
        input.actorUserId ?? null,
        input.actorLabel ?? null,
        input.aiProvider ?? null,
        input.accessChannel,
        sessionSeed,
        JSON.stringify(input.metadata ?? {}),
        occurredAt,
        day
      ]
    )

    if (!input.artifactId) return

    const delta = await computeDelta(db, input, day, sessionSeed)
    if (!delta) return

    await ensureRollupRow(db, input.artifactId, day)
    await applyDelta(db, input.artifactId, day, delta)
  } catch (err) {
    // Analytics must never break the user's request
    console.error('[analytics] failed to record event', input.eventType, err)
  }
}

async function computeDelta(
  db: D1Database,
  input: EventInput,
  day: string,
  sessionSeed: string | null
): Promise<CounterDelta | null> {
  const delta: CounterDelta = {}

  const isInternal = input.accessChannel === 'INTERNAL'

  switch (input.eventType) {
    case 'artifact_viewed': {
      delta.views = 1
      if (isInternal) delta.internalViews = 1
      else delta.externalViews = 1
      if (input.accessChannel === 'PUBLIC_LINK') delta.publicLinkViews = 1
      if (input.accessChannel === 'EMAIL') delta.emailViews = 1
      if (input.accessChannel === 'DOMAIN') delta.domainViews = 1
      if (await claimViewer(db, input.artifactId!, day, input, sessionSeed, 'VIEW')) {
        delta.uniqueViewers = 1
      }
      break
    }
    case 'artifact_downloaded': {
      delta.downloads = 1
      if (isInternal) delta.internalViews = 0
      if (await claimViewer(db, input.artifactId!, day, input, sessionSeed, 'DOWNLOAD')) {
        delta.uniqueDownloaders = 1
      }
      break
    }
    case 'share_opened':
      delta.shareOpens = 1
      break
    case 'share_access_denied':
      delta.deniedRequests = 1
      break
    case 'artifact_ai_retrieved':
    case 'artifact_ai_referenced':
      delta.aiReferences = 1
      break
    default:
      return null
  }

  return Object.keys(delta).length ? delta : null
}

/**
 * Claim a distinct-viewer slot for the day. Returns true only on first claim,
 * so increments to `unique_viewers` are exactly-once per artifact/day/viewer.
 */
async function claimViewer(
  db: D1Database,
  artifactId: string,
  day: string,
  input: EventInput,
  sessionSeed: string | null,
  kind: 'VIEW' | 'DOWNLOAD'
): Promise<boolean> {
  let key: string
  if (input.actorType === 'ANONYMOUS') {
    // Privacy-conscious: daily-rotating derivation from the visit seed only
    key = sessionSeed ? await viewerKey(sessionSeed, day) : `anon_${ulid()}`
  } else {
    key = input.actorUserId ?? sessionSeed ?? `sys_${ulid()}`
  }

  const result = await run(
    db,
    `INSERT OR IGNORE INTO artifact_viewer_keys
       (id, artifact_id, metric_date, viewer_key, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [prefixed('avk', ulid()), artifactId, day, key, kind, nowIso()]
  )

  return (result.meta?.changes ?? 0) > 0
}

async function ensureRollupRow(db: D1Database, artifactId: string, day: string): Promise<void> {
  await run(
    db,
    `INSERT INTO artifact_daily_metrics (id, artifact_id, metric_date)
     VALUES (?, ?, ?)
     ON CONFLICT(artifact_id, metric_date) DO NOTHING`,
    [prefixed('adm', `${artifactId}_${day}`), artifactId, day]
  )
}

async function applyDelta(
  db: D1Database,
  artifactId: string,
  day: string,
  delta: CounterDelta
): Promise<void> {
  const columns: string[] = []
  const values: unknown[] = []

  const map: Array<[keyof CounterDelta, string]> = [
    ['views', 'views'],
    ['uniqueViewers', 'unique_viewers'],
    ['downloads', 'downloads'],
    ['uniqueDownloaders', 'unique_downloaders'],
    ['internalViews', 'internal_views'],
    ['externalViews', 'external_views'],
    ['publicLinkViews', 'public_link_views'],
    ['emailViews', 'email_views'],
    ['domainViews', 'domain_views'],
    ['aiReferences', 'ai_references'],
    ['shareOpens', 'share_opens'],
    ['deniedRequests', 'denied_requests']
  ]

  for (const [prop, column] of map) {
    const value = delta[prop]
    if (typeof value === 'number' && value !== 0) {
      columns.push(`${column} = ${column} + ?`)
      values.push(value)
    }
  }

  if (!columns.length) return

  await run(
    db,
    `UPDATE artifact_daily_metrics SET ${columns.join(', ')}
      WHERE artifact_id = ? AND metric_date = ?`,
    [...values, artifactId, day]
  )
}

// ---------------------------------------------------------------
// Read models
// ---------------------------------------------------------------

export interface AnalyticsTotals {
  views: number
  uniqueViewers: number
  downloads: number
  uniqueDownloaders: number
  aiReferences: number
  shareOpens: number
  deniedRequests: number
  firstViewedAt: string | null
  lastViewedAt: string | null
}

export type Period = '7d' | '30d' | '90d' | 'all'

export function periodStart(period: Period): string | null {
  if (period === 'all') return null
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return metricDate(start)
}

export async function artifactTotals(
  db: D1Database,
  artifactId: string,
  period: Period
): Promise<AnalyticsTotals> {
  const start = periodStart(period)
  const where = start ? 'AND metric_date >= ?' : ''
  const params = start ? [artifactId, start] : [artifactId]

  const totals = await first<{
    views: number
    unique_viewers: number
    downloads: number
    unique_downloaders: number
    ai_references: number
    share_opens: number
    denied_requests: number
  }>(
    db,
    `SELECT
       COALESCE(SUM(views), 0) AS views,
       COALESCE(SUM(unique_viewers), 0) AS unique_viewers,
       COALESCE(SUM(downloads), 0) AS downloads,
       COALESCE(SUM(unique_downloaders), 0) AS unique_downloaders,
       COALESCE(SUM(ai_references), 0) AS ai_references,
       COALESCE(SUM(share_opens), 0) AS share_opens,
       COALESCE(SUM(denied_requests), 0) AS denied_requests
     FROM artifact_daily_metrics
     WHERE artifact_id = ? ${where}`,
    params
  )

  // Unique viewers across the window must be counted distinctly, not summed,
  // otherwise a returning viewer inflates the figure once per day (§45).
  const distinct = await first<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT viewer_key) AS n
       FROM artifact_viewer_keys
      WHERE artifact_id = ? AND kind = 'VIEW' ${start ? 'AND metric_date >= ?' : ''}`,
    params
  )
  const distinctDownloaders = await first<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT viewer_key) AS n
       FROM artifact_viewer_keys
      WHERE artifact_id = ? AND kind = 'DOWNLOAD' ${start ? 'AND metric_date >= ?' : ''}`,
    params
  )

  const bounds = await first<{ first_at: string | null; last_at: string | null }>(
    db,
    `SELECT MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
       FROM artifact_events
      WHERE artifact_id = ? AND event_type = 'artifact_viewed' ${start ? 'AND metric_date >= ?' : ''}`,
    params
  )

  return {
    views: totals?.views ?? 0,
    uniqueViewers: distinct?.n ?? totals?.unique_viewers ?? 0,
    downloads: totals?.downloads ?? 0,
    uniqueDownloaders: distinctDownloaders?.n ?? totals?.unique_downloaders ?? 0,
    aiReferences: totals?.ai_references ?? 0,
    shareOpens: totals?.share_opens ?? 0,
    deniedRequests: totals?.denied_requests ?? 0,
    firstViewedAt: bounds?.first_at ?? null,
    lastViewedAt: bounds?.last_at ?? null
  }
}

export interface SourceBreakdown {
  internal: number
  publicLink: number
  email: number
  domain: number
  ai: number
}

export async function sourceBreakdown(
  db: D1Database,
  artifactId: string,
  period: Period
): Promise<SourceBreakdown> {
  const start = periodStart(period)
  const params = start ? [artifactId, start] : [artifactId]

  // Views by channel plus AI references, expressed in the same unit space so
  // the percentages on the analytics screen are meaningful (§46).
  const rows = await all<{ bucket: string; n: number }>(
    db,
    `SELECT bucket, SUM(n) AS n FROM (
       SELECT 'internal'   AS bucket, internal_views    AS n FROM artifact_daily_metrics WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
       UNION ALL
       SELECT 'publicLink' AS bucket, public_link_views AS n FROM artifact_daily_metrics WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
       UNION ALL
       SELECT 'email'      AS bucket, email_views       AS n FROM artifact_daily_metrics WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
       UNION ALL
       SELECT 'domain'     AS bucket, domain_views      AS n FROM artifact_daily_metrics WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
       UNION ALL
       SELECT 'ai'         AS bucket, ai_references     AS n FROM artifact_daily_metrics WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
     ) GROUP BY bucket`,
    start
      ? [artifactId, start, artifactId, start, artifactId, start, artifactId, start, artifactId, start]
      : [artifactId, artifactId, artifactId, artifactId, artifactId]
  )

  const out: SourceBreakdown = { internal: 0, publicLink: 0, email: 0, domain: 0, ai: 0 }
  for (const row of rows) {
    if (row.bucket in out) out[row.bucket as keyof SourceBreakdown] = row.n ?? 0
  }
  return out
}

export async function dailySeries(
  db: D1Database,
  artifactId: string,
  period: Period
): Promise<Array<{ date: string; views: number; downloads: number }>> {
  const start = periodStart(period)
  const rows = await all<{ metric_date: string; views: number; downloads: number }>(
    db,
    `SELECT metric_date, views, downloads
       FROM artifact_daily_metrics
      WHERE artifact_id = ? ${start ? 'AND metric_date >= ?' : ''}
      ORDER BY metric_date ASC`,
    start ? [artifactId, start] : [artifactId]
  )
  return rows.map((r) => ({ date: r.metric_date, views: r.views, downloads: r.downloads }))
}

export interface ActivityRow {
  event_type: string
  actor_label: string | null
  actor_type: string
  ai_provider: string | null
  access_channel: string
  occurred_at: string
}

export async function recentActivity(
  db: D1Database,
  artifactId: string,
  limit = 12
): Promise<ActivityRow[]> {
  return all<ActivityRow>(
    db,
    `SELECT event_type, actor_label, actor_type, ai_provider, access_channel, occurred_at
       FROM artifact_events
      WHERE artifact_id = ?
        AND event_type IN ('artifact_viewed','artifact_downloaded','artifact_ai_referenced','artifact_version_created')
      ORDER BY occurred_at DESC
      LIMIT ?`,
    [artifactId, limit]
  )
}

/**
 * Label for an actor in the activity feed, honouring the tenant privacy
 * setting: anonymous public-link viewers are never guessed at (§48).
 */
export function actorDisplay(row: ActivityRow): string {
  if (row.actor_type === 'AI') return row.ai_provider ?? 'AI application'
  if (row.actor_type === 'ANONYMOUS' || !row.actor_label) return 'Anonymous viewer'
  return row.actor_label
}

/** Workspace-level aggregation for workspace admins (§47). */
export async function workspaceTotals(
  db: D1Database,
  workspaceId: string,
  period: Period
): Promise<{ views: number; downloads: number; aiReferences: number; artifactCount: number }> {
  const start = periodStart(period)
  const params = start ? [workspaceId, start] : [workspaceId]

  const totals = await first<{ views: number; downloads: number; ai_references: number }>(
    db,
    `SELECT
       COALESCE(SUM(m.views), 0) AS views,
       COALESCE(SUM(m.downloads), 0) AS downloads,
       COALESCE(SUM(m.ai_references), 0) AS ai_references
     FROM artifact_daily_metrics m
     JOIN artifacts a ON a.id = m.artifact_id
    WHERE a.workspace_id = ? AND a.deleted_at IS NULL ${start ? 'AND m.metric_date >= ?' : ''}`,
    params
  )

  const artifactCount = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM artifacts
      WHERE workspace_id = ? AND deleted_at IS NULL`,
    [workspaceId]
  )

  return {
    views: totals?.views ?? 0,
    downloads: totals?.downloads ?? 0,
    aiReferences: totals?.ai_references ?? 0,
    artifactCount: artifactCount?.n ?? 0
  }
}

/** Used by the share gate to log a denied attempt without an artifact id. */
export async function recordDeniedAccess(
  db: D1Database,
  input: Omit<EventInput, 'eventType' | 'accessChannel'> & { accessChannel: AccessChannel }
): Promise<void> {
  await recordEvent(db, { ...input, eventType: 'share_access_denied' })
}

export { ps }
