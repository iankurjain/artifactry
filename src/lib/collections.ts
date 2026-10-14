/**
 * Collections an artifact belongs to, filing an artifact into collections at
 * save time, and the per-person "recently viewed" list.
 *
 * A collection lives in one workspace and an artifact sits in at most one of
 * them (migration 0012 enforces it). Filing an artifact into a collection moves
 * it out of any other. Anyone with collection.manage in the workspace (Members
 * and Admins, plus custom tiers that include it) can file artifacts.
 */

import type { Principal } from '../types'
import { can } from './principal'
import { all, first, nowIso, run } from './db'
import { prefixed, ulid } from './ids'

export interface CollectionRef {
  id: string
  name: string
}

/**
 * Puts the artifact in `collectionId`, or in no collection when it is null,
 * leaving any other membership behind. One batch, so the artifact is never
 * briefly in two collections or in none. Callers check workspace and
 * permission; this only writes.
 */
export async function placeInCollection(
  db: D1Database,
  artifactId: string,
  collectionId: string | null,
  userId: string | null | undefined
): Promise<void> {
  const timestamp = nowIso()
  const statements = [
    collectionId
      ? db
          .prepare(`DELETE FROM collection_artifacts WHERE artifact_id = ? AND collection_id != ?`)
          .bind(artifactId, collectionId)
      : db.prepare(`DELETE FROM collection_artifacts WHERE artifact_id = ?`).bind(artifactId)
  ]
  if (collectionId) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO collection_artifacts (id, collection_id, artifact_id, added_by, added_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(prefixed('ca', ulid()), collectionId, artifactId, userId ?? null, timestamp),
      db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).bind(timestamp, collectionId)
    )
  }
  await db.batch(statements)
}

/** artifact id → the live collection it belongs to (a list of at most one). */
export async function collectionsOf(
  db: D1Database,
  artifactIds: string[]
): Promise<Map<string, CollectionRef[]>> {
  const map = new Map<string, CollectionRef[]>()
  if (!artifactIds.length) return map
  const rows = await all<{ artifact_id: string; id: string; name: string }>(
    db,
    `SELECT ca.artifact_id, c.id, c.name FROM collection_artifacts ca
       JOIN collections c ON c.id = ca.collection_id AND c.archived_at IS NULL
      WHERE ca.artifact_id IN (${artifactIds.map(() => '?').join(',')})
      ORDER BY c.name COLLATE NOCASE ASC`,
    artifactIds
  )
  for (const row of rows) {
    const list = map.get(row.artifact_id) ?? []
    list.push({ id: row.id, name: row.name })
    map.set(row.artifact_id, list)
  }
  return map
}

/**
 * Files a just-saved artifact into the first of `collectionIds` that is a live
 * collection of the artifact's workspace; an artifact is in one collection
 * only. Nothing is filed without collection.manage there. Returns the
 * collection it joined, as a list of at most one.
 */
export async function fileIntoCollections(
  db: D1Database,
  principal: Principal,
  artifact: { id: string; workspace_id: string },
  collectionIds: string[]
): Promise<CollectionRef[]> {
  const ids = [...new Set(collectionIds.map(String).filter(Boolean))].slice(0, 50)
  if (!ids.length) return []
  const workspace = await first<{ id: string; organization_id: string | null; owner_user_id: string }>(
    db,
    `SELECT id, organization_id, owner_user_id FROM workspaces WHERE id = ?`,
    [artifact.workspace_id]
  )
  if (!workspace || !can(principal, 'collection.manage', workspace)) return []

  const valid = await all<CollectionRef>(
    db,
    `SELECT id, name FROM collections
      WHERE workspace_id = ? AND archived_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [artifact.workspace_id, ...ids]
  )
  const chosen = ids.map((id) => valid.find((c) => c.id === id)).find(Boolean)
  if (!chosen) return []
  await placeInCollection(db, artifact.id, chosen.id, principal.userId)
  return [chosen]
}

/**
 * Remembers that this person opened the artifact. Never fails the request:
 * before migration 0011 is applied the table is missing and this is a no-op.
 */
export async function noteRecentView(db: D1Database, userId: string, artifactId: string): Promise<void> {
  try {
    await run(
      db,
      `INSERT INTO artifact_recent_views (user_id, artifact_id, viewed_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, artifact_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
      [userId, artifactId, nowIso()]
    )
  } catch (err) {
    console.error('[recent-views] not recorded', err)
  }
}

/**
 * The artifacts matching `where` that this person opened, most recent first.
 * Returns an empty list (not an error) before migration 0011 is applied.
 */
export async function recentlyViewed(
  db: D1Database,
  userId: string,
  where: string[],
  params: unknown[],
  limit: number,
  offset: number
): Promise<Record<string, unknown>[]> {
  try {
    return await all<Record<string, unknown>>(
      db,
      `SELECT a.*, rv.viewed_at AS last_viewed_at FROM artifacts a
         JOIN artifact_recent_views rv ON rv.artifact_id = a.id AND rv.user_id = ?
        WHERE ${where.join(' AND ')}
        ORDER BY rv.viewed_at DESC
        LIMIT ? OFFSET ?`,
      [userId, ...params, limit, offset]
    )
  } catch (err) {
    console.error('[recent-views] unavailable', err)
    return []
  }
}
