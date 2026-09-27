/**
 * Taxonomy and collections — PRD §23–§26, §110.
 *
 * Tags are admin-governed (§24): users may apply and remove existing tags but
 * cannot create new ones. That rule is enforced here, not in the UI — a
 * regular user calling POST /tags is rejected regardless of what the client
 * sends.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, requirePrincipal } from '../middleware'
import { can, assertWorkspaceAccess, effectiveWorkspaceRole, readableWorkspaces } from '../lib/principal'
import { all, first, nowIso, run } from '../lib/db'
import { prefixed, slugify, ulid } from '../lib/ids'
import { badRequest, conflict, forbidden, notFound, ok, readJson } from '../lib/http'
import { assignTags } from '../lib/artifacts'
import { recordAudit } from '../lib/audit'
import { indexArtifact } from '../lib/search'

const taxonomy = new Hono<AppEnv>()

// ---------------------------------------------------------------
// Tags (§100, §110)
// ---------------------------------------------------------------

taxonomy.get(
  '/tags',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const includeInactive = c.req.query('includeInactive') === '1'

    // A user sees platform/personal tags plus the tags of orgs they belong to.
    const orgIds = Object.keys(principal.orgRoles)

    const orgClause = orgIds.length
      ? `OR (t.scope = 'ORGANIZATION' AND t.organization_id IN (${orgIds.map(() => '?').join(',')}))`
      : ''

    const rows = await all<{
      id: string
      name: string
      slug: string
      description: string | null
      color: string | null
      scope: string
      organization_id: string | null
      status: string
      usage_count: number
    }>(
      c.env.DB,
      `SELECT t.id, t.name, t.slug, t.description, t.color, t.scope, t.organization_id, t.status,
              (SELECT COUNT(*) FROM artifact_tags at WHERE at.tag_id = t.id) AS usage_count
         FROM tags t
        WHERE (t.scope = 'PERSONAL' ${orgClause})
          ${includeInactive ? '' : "AND t.status = 'ACTIVE'"}
        ORDER BY t.name ASC`,
      orgIds
    )

    return ok(c, {
      tags: rows.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        description: t.description,
        color: t.color,
        scope: t.scope,
        organizationId: t.organization_id,
        status: t.status,
        usageCount: t.usage_count
      }))
    })
  })
)

/** Create a tag. Admin-governed (§24) — personal scope requires an org-admin
 * role in at least one org, or ownership of the personal taxonomy. */
taxonomy.post(
  '/tags',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{
      name?: string
      description?: string
      color?: string
      scope?: 'PERSONAL' | 'ORGANIZATION'
      organizationId?: string
    }>(c)

    const name = (body.name ?? '').trim()
    if (!name) throw badRequest('Tag name is required')
    if (name.length > 40) throw badRequest('Tag names must be 40 characters or fewer')

    const scope = body.scope ?? 'PERSONAL'
    const organizationId = scope === 'ORGANIZATION' ? (body.organizationId ?? null) : null

    if (scope === 'ORGANIZATION') {
      if (!organizationId) throw badRequest('organizationId is required for an organization tag')
      const role = principal.orgRoles[organizationId]
      if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') {
        throw forbidden('Only organization admins can manage organization tags')
      }
    } else {
      // Personal taxonomy is platform-governed; allow it for org admins so a
      // team can standardise its own classification without waiting on us.
      const isAnyAdmin = Object.values(principal.orgRoles).some(
        (r) => r === 'ORG_OWNER' || r === 'ORG_ADMIN'
      )
      if (!isAnyAdmin) {
        throw forbidden(
          'Tags are admin-governed. Ask an organization admin to create new tags, or apply an existing one.'
        )
      }
    }

    const slug = slugify(name, 48)

    const existing = await first<{ id: string }>(
      c.env.DB,
      `SELECT id FROM tags WHERE scope = ? AND COALESCE(organization_id, '') = COALESCE(?, '') AND slug = ?`,
      [scope, organizationId, slug]
    )
    if (existing) throw conflict('A tag with that name already exists')

    const tagId = prefixed('tag', ulid())
    const timestamp = nowIso()

    await run(
      c.env.DB,
      `INSERT INTO tags
         (id, organization_id, scope, name, slug, description, color, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      [
        tagId,
        organizationId,
        scope,
        name,
        slug,
        body.description ?? null,
        body.color ?? null,
        principal.userId,
        timestamp,
        timestamp
      ]
    )

    await recordAudit(c.env.DB, {
      organizationId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'TAG_CREATE',
      targetType: 'tag',
      targetId: tagId,
      metadata: { name, slug, scope }
    })

    return ok(c, { tag: { id: tagId, name, slug, scope, organizationId, status: 'ACTIVE' } }, 201)
  })
)

taxonomy.patch(
  '/tags/:tagId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const tagId = c.req.param('tagId')

    const tag = await first<{ id: string; scope: string; organization_id: string | null }>(
      c.env.DB,
      `SELECT id, scope, organization_id FROM tags WHERE id = ?`,
      [tagId]
    )
    if (!tag) throw notFound('Tag not found')

    if (tag.scope === 'ORGANIZATION') {
      const role = tag.organization_id ? principal.orgRoles[tag.organization_id] : null
      if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') throw forbidden()
    } else {
      const isAnyAdmin = Object.values(principal.orgRoles).some(
        (r) => r === 'ORG_OWNER' || r === 'ORG_ADMIN'
      )
      if (!isAnyAdmin) throw forbidden('Tags are admin-governed')
    }

    const body = await readJson<{
      name?: string
      description?: string
      color?: string
      status?: 'ACTIVE' | 'INACTIVE'
    }>(c)

    const sets: string[] = []
    const params: unknown[] = []

    if (typeof body.name === 'string' && body.name.trim()) {
      sets.push('name = ?', 'slug = ?')
      params.push(body.name.trim().slice(0, 40), slugify(body.name.trim(), 48))
    }
    if (typeof body.description === 'string') {
      sets.push('description = ?')
      params.push(body.description.slice(0, 500))
    }
    if (typeof body.color === 'string') {
      sets.push('color = ?')
      params.push(body.color.slice(0, 24))
    }
    if (body.status === 'ACTIVE' || body.status === 'INACTIVE') {
      sets.push('status = ?')
      params.push(body.status)
    }

    if (!sets.length) throw badRequest('Nothing to update')

    sets.push('updated_at = ?')
    params.push(nowIso())

    await run(c.env.DB, `UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, [...params, tagId])

    await recordAudit(c.env.DB, {
      organizationId: tag.organization_id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'TAG_UPDATE',
      targetType: 'tag',
      targetId: tagId
    })

    return ok(c, { updated: true, tagId })
  })
)

/**
 * Delete a tag. The PRD restricts this to *unused* tags (§24); deactivating
 * is the path for a tag that has history, so the assignment count is checked
 * rather than silently orphaning artifact_tags rows.
 */
taxonomy.delete(
  '/tags/:tagId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const tagId = c.req.param('tagId')

    const tag = await first<{ id: string; scope: string; organization_id: string | null; name: string }>(
      c.env.DB,
      `SELECT id, scope, organization_id, name FROM tags WHERE id = ?`,
      [tagId]
    )
    if (!tag) throw notFound('Tag not found')

    if (tag.scope === 'ORGANIZATION') {
      const role = tag.organization_id ? principal.orgRoles[tag.organization_id] : null
      if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') throw forbidden()
    } else {
      const isAnyAdmin = Object.values(principal.orgRoles).some(
        (r) => r === 'ORG_OWNER' || r === 'ORG_ADMIN'
      )
      if (!isAnyAdmin) throw forbidden('Tags are admin-governed')
    }

    const usage = await first<{ n: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS n FROM artifact_tags WHERE tag_id = ?`,
      [tagId]
    )

    if ((usage?.n ?? 0) > 0) {
      throw conflict(
        `"${tag.name}" is used by ${usage?.n} artifact(s). Deactivate it instead of deleting, so history is preserved.`
      )
    }

    await run(c.env.DB, `DELETE FROM tags WHERE id = ?`, [tagId])

    await recordAudit(c.env.DB, {
      organizationId: tag.organization_id,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'TAG_DELETE',
      targetType: 'tag',
      targetId: tagId,
      metadata: { name: tag.name }
    })

    return ok(c, { deleted: true, tagId })
  })
)

/** Apply tags to an artifact (users may do this, §24). */
taxonomy.post(
  '/artifacts/:artifactId/tags',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')

    const { assertArtifactPermission } = await import('../lib/access')
    await assertArtifactPermission(c.env.DB, principal, artifactId, 'artifact.tag.apply')

    const body = await readJson<{ tags?: string[] }>(c)
    const slugs = Array.isArray(body.tags) ? body.tags.map(String) : []
    if (!slugs.length) throw badRequest('Provide at least one tag slug')

    const allTags = await all<{ id: string; slug: string; name: string }>(
      c.env.DB,
      `SELECT id, slug, name FROM tags WHERE status = 'ACTIVE'`
    )
    const unknown = slugs.filter((s) => !allTags.some((t) => t.slug === s))
    if (unknown.length) {
      throw badRequest(
        `Unknown tag(s): ${unknown.join(', ')}. Tags are admin-governed — only existing tags can be applied.`
      )
    }

    const ids = allTags.filter((t) => slugs.includes(t.slug)).map((t) => t.id)
    const outcome = await assignTags(c.env.DB, artifactId, ids, principal.userId!)

    return ok(c, { applied: slugs, added: outcome.added })
  })
)

/** Remove a single tag from an artifact. */
taxonomy.delete(
  '/artifacts/:artifactId/tags/:slug',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const artifactId = c.req.param('artifactId')
    const slug = c.req.param('slug')

    const { assertArtifactPermission } = await import('../lib/access')
    await assertArtifactPermission(c.env.DB, principal, artifactId, 'artifact.tag.apply')

    const tag = await first<{ id: string }>(c.env.DB, `SELECT id FROM tags WHERE slug = ?`, [slug])
    if (!tag) throw notFound('Tag not found')

    await run(c.env.DB, `DELETE FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`, [
      artifactId,
      tag.id
    ])
    await indexArtifact(c.env.DB, artifactId)

    return ok(c, { removed: slug })
  })
)

// ---------------------------------------------------------------
// Collections (§26)
// ---------------------------------------------------------------

taxonomy.get(
  '/collections',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const workspaceId = c.req.query('workspaceId')

    const workspaces = await readableWorkspaces(c.env.DB, principal)
    const ids = workspaces.map((w) => w.id)
    if (!ids.length) return ok(c, { collections: [] })

    const scope = workspaceId ? ids.filter((id) => id === workspaceId) : ids
    if (!scope.length) return ok(c, { collections: [] })

    const rows = await all<{
      id: string
      name: string
      description: string | null
      workspace_id: string
      artifact_count: number
      updated_at: string
    }>(
      c.env.DB,
      `SELECT c.id, c.name, c.description, c.workspace_id,
              (SELECT COUNT(*) FROM collection_artifacts ca
                JOIN artifacts a ON a.id = ca.artifact_id AND a.deleted_at IS NULL
               WHERE ca.collection_id = c.id) AS artifact_count,
              c.updated_at
         FROM collections c
        WHERE c.workspace_id IN (${scope.map(() => '?').join(',')})
          AND c.archived_at IS NULL
        ORDER BY c.updated_at DESC`,
      scope
    )

    const wsName = new Map(workspaces.map((w) => [w.id, w.name]))

    return ok(c, {
      collections: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        workspaceId: row.workspace_id,
        workspaceName: wsName.get(row.workspace_id) ?? null,
        artifactCount: row.artifact_count,
        updatedAt: row.updated_at
      }))
    })
  })
)

taxonomy.post(
  '/collections',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{
      name?: string
      description?: string
      workspaceId?: string
      artifactIds?: string[]
    }>(c)

    const name = (body.name ?? '').trim()
    if (!name) throw badRequest('Collection name is required')
    if (!body.workspaceId) throw badRequest('workspaceId is required')

    await assertWorkspaceAccess(c.env.DB, principal, body.workspaceId, 'collection.manage')

    const collectionId = prefixed('col', ulid())
    const timestamp = nowIso()

    await run(
      c.env.DB,
      `INSERT INTO collections
         (id, organization_id, workspace_id, name, description, created_by, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        collectionId,
        null,
        body.workspaceId,
        name.slice(0, 120),
        body.description?.slice(0, 500) ?? null,
        principal.userId,
        timestamp,
        timestamp
      ]
    )

    // Set organization_id from the workspace so tenant scoping stays consistent
    await run(
      c.env.DB,
      `UPDATE collections SET organization_id =
         (SELECT organization_id FROM workspaces WHERE id = ?) WHERE id = ?`,
      [body.workspaceId, collectionId]
    )

    if (Array.isArray(body.artifactIds) && body.artifactIds.length) {
      for (const artifactId of body.artifactIds.slice(0, 200)) {
        await run(
          c.env.DB,
          `INSERT OR IGNORE INTO collection_artifacts (id, collection_id, artifact_id, added_by, added_at)
           VALUES (?, ?, ?, ?, ?)`,
          [prefixed('ca', ulid()), collectionId, artifactId, principal.userId, timestamp]
        )
      }
    }

    return ok(c, { collection: { id: collectionId, name, workspaceId: body.workspaceId } }, 201)
  })
)

taxonomy.get(
  '/collections/:collectionId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const collectionId = c.req.param('collectionId')

    const collection = await first<{
      id: string
      name: string
      description: string | null
      workspace_id: string
      organization_id: string | null
      created_by: string | null
      created_at: string
      updated_at: string
    }>(c.env.DB, `SELECT * FROM collections WHERE id = ? AND archived_at IS NULL`, [collectionId])
    if (!collection) throw notFound('Collection not found')

    await assertWorkspaceAccess(c.env.DB, principal, collection.workspace_id, 'artifact.read')

    const artifacts = await all<Record<string, unknown>>(
      c.env.DB,
      `SELECT a.*, ca.added_at FROM collection_artifacts ca
         JOIN artifacts a ON a.id = ca.artifact_id
        WHERE ca.collection_id = ? AND a.deleted_at IS NULL
        ORDER BY ca.added_at DESC`,
      [collectionId]
    )

    return ok(c, {
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        workspaceId: collection.workspace_id,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      },
      artifacts: artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        filename: a.filename,
        extension: a.extension,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        status: a.status,
        updatedAt: a.updated_at,
        addedAt: a.added_at
      }))
    })
  })
)

taxonomy.patch(
  '/collections/:collectionId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const collectionId = c.req.param('collectionId')

    const collection = await first<{ id: string; workspace_id: string }>(
      c.env.DB,
      `SELECT id, workspace_id FROM collections WHERE id = ? AND archived_at IS NULL`,
      [collectionId]
    )
    if (!collection) throw notFound('Collection not found')

    await assertWorkspaceAccess(c.env.DB, principal, collection.workspace_id, 'collection.manage')

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

    sets.push('updated_at = ?')
    params.push(nowIso())

    await run(c.env.DB, `UPDATE collections SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      collectionId
    ])

    return ok(c, { updated: true, collectionId })
  })
)

taxonomy.post(
  '/collections/:collectionId/artifacts',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const collectionId = c.req.param('collectionId')

    const collection = await first<{ id: string; workspace_id: string }>(
      c.env.DB,
      `SELECT id, workspace_id FROM collections WHERE id = ? AND archived_at IS NULL`,
      [collectionId]
    )
    if (!collection) throw notFound('Collection not found')

    await assertWorkspaceAccess(c.env.DB, principal, collection.workspace_id, 'collection.manage')

    const body = await readJson<{ artifactIds?: string[] }>(c)
    const ids = Array.isArray(body.artifactIds) ? body.artifactIds.map(String) : []
    if (!ids.length) throw badRequest('Provide artifactIds')

    let added = 0
    for (const artifactId of ids.slice(0, 200)) {
      // Only artifacts in the same workspace can join the collection
      const artifact = await first<{ id: string }>(
        c.env.DB,
        `SELECT id FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        [artifactId, collection.workspace_id]
      )
      if (!artifact) continue

      const result = await run(
        c.env.DB,
        `INSERT OR IGNORE INTO collection_artifacts (id, collection_id, artifact_id, added_by, added_at)
         VALUES (?, ?, ?, ?, ?)`,
        [prefixed('ca', ulid()), collectionId, artifactId, principal.userId, nowIso()]
      )
      if ((result.meta?.changes ?? 0) > 0) added++
    }

    await run(c.env.DB, `UPDATE collections SET updated_at = ? WHERE id = ?`, [
      nowIso(),
      collectionId
    ])

    return ok(c, { added, collectionId })
  })
)

taxonomy.delete(
  '/collections/:collectionId/artifacts/:artifactId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const collectionId = c.req.param('collectionId')
    const artifactId = c.req.param('artifactId')

    const collection = await first<{ id: string; workspace_id: string }>(
      c.env.DB,
      `SELECT id, workspace_id FROM collections WHERE id = ?`,
      [collectionId]
    )
    if (!collection) throw notFound('Collection not found')

    await assertWorkspaceAccess(c.env.DB, principal, collection.workspace_id, 'collection.manage')

    await run(
      c.env.DB,
      `DELETE FROM collection_artifacts WHERE collection_id = ? AND artifact_id = ?`,
      [collectionId, artifactId]
    )

    return ok(c, { removed: true })
  })
)

/**
 * Collection analytics for the owner view.
 * Uses the same event table as artifact analytics so numbers are consistent.
 */
taxonomy.get(
  '/collections/:collectionId/analytics',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const collectionId = c.req.param('collectionId')

    const collection = await first<{
      id: string
      workspace_id: string
      organization_id: string | null
      created_by: string | null
    }>(c.env.DB, `SELECT id, workspace_id, organization_id, created_by FROM collections WHERE id = ?`, [
      collectionId
    ])
    if (!collection) throw notFound('Collection not found')

    const workspace = await assertWorkspaceAccess(
      c.env.DB,
      principal,
      collection.workspace_id,
      'artifact.read'
    )

    const role = effectiveWorkspaceRole(principal, workspace)
    const isCreator = collection.created_by === principal.userId
    const mayRead = isCreator || role === 'WORKSPACE_ADMIN' || can(principal, 'analytics.read.workspace', workspace)

    if (!mayRead) {
      return ok(c, { permitted: false })
    }

    const totals = await first<{
      views: number
      downloads: number
      ai_references: number
      artifacts: number
    }>(
      c.env.DB,
      `SELECT
         COALESCE(SUM(m.views), 0) AS views,
         COALESCE(SUM(m.downloads), 0) AS downloads,
         COALESCE(SUM(m.ai_references), 0) AS ai_references,
         COUNT(DISTINCT a.id) AS artifacts
       FROM collection_artifacts ca
       JOIN artifacts a ON a.id = ca.artifact_id AND a.deleted_at IS NULL
       LEFT JOIN artifact_daily_metrics m ON m.artifact_id = a.id
      WHERE ca.collection_id = ?`,
      [collectionId]
    )

    return ok(c, {
      permitted: true,
      views: totals?.views ?? 0,
      downloads: totals?.downloads ?? 0,
      aiReferences: totals?.ai_references ?? 0,
      artifactCount: totals?.artifacts ?? 0
    })
  })
)

export default taxonomy
