/**
 * Search routes — PRD §107, §30, §33.
 *
 *   POST /api/v1/search
 *   GET  /api/v1/search/suggest
 *
 * Results are ACL-scoped inside the query (§33), so a caller can never observe
 * a count, title, snippet, tag or thumbnail for something they cannot read.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import { readableWorkspaces } from '../lib/principal'
import { all, first, run } from '../lib/db'
import { resolveSemanticProvider, searchArtifacts, accessibleWorkspaceIds } from '../lib/search'
import { madeByLabel } from '../lib/handoffs'
import { badRequest, ok, readJson } from '../lib/http'
import { prefixed, ulid } from '../lib/ids'
import { nowIso } from '../lib/db'

const search = new Hono<AppEnv>()

search.post(
  '/',
  rateLimit({ bucket: 'search', limit: 240, windowSeconds: 300 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const body = await readJson<{
      query?: string
      workspaceIds?: string[]
      types?: string[]
      tags?: string[]
      ownerIds?: string[]
      statuses?: string[]
      createdFrom?: string
      createdTo?: string
      madeBy?: string
      collectionIds?: string[]
      limit?: number
      offset?: number
      sort?: 'relevance' | 'updated' | 'created' | 'title'
    }>(c)

    const query = (body.query ?? '').trim()
    if (query.length > 300) throw badRequest('Query is too long')

    const response = await searchArtifacts(
      c.env.DB,
      principal,
      {
        query,
        workspaceIds: body.workspaceIds,
        types: body.types,
        tagSlugs: body.tags,
        ownerIds: body.ownerIds,
        statuses: body.statuses,
        createdFrom: body.createdFrom,
        createdTo: body.createdTo,
        madeBy: typeof body.madeBy === 'string' ? body.madeBy.slice(0, 60) : undefined,
        collectionIds: Array.isArray(body.collectionIds) ? body.collectionIds.map(String).slice(0, 20) : undefined,
        limit: body.limit,
        offset: body.offset,
        sort: body.sort
      },
      resolveSemanticProvider(c.env)
    )

    const origin = new URL(c.req.url).origin

    return ok(c, {
      query,
      total: response.total,
      engine: response.engine,
      results: response.hits.map((hit) => ({
        id: hit.artifact.id,
        title: hit.artifact.title,
        description: hit.artifact.description,
        filename: hit.artifact.filename,
        extension: hit.artifact.extension,
        mimeType: hit.artifact.mime_type,
        sizeBytes: hit.artifact.size_bytes,
        status: hit.artifact.status,
        tags: hit.tags,
        workspaceId: hit.artifact.workspace_id,
        workspaceName: hit.workspaceName,
        sourceProvider: hit.artifact.source_provider,
        sourceClient: hit.artifact.source_client ?? null,
        madeBy: madeByLabel(hit.artifact.source_provider, hit.artifact.source_client),
        updatedAt: hit.artifact.updated_at,
        createdAt: hit.artifact.created_at,
        isOwner: hit.isOwner,
        matchSource: hit.matchSource,
        canonicalUrl: `${origin}/a/${hit.artifact.id}`
      }))
    })
  })
)

/**
 * Filter facets for the search screen (§83): the type list, the tag list and
 * the workspace list are all ACL-scoped, but tags and workspaces are shared
 * taxonomy/context rather than artifact content, so exposing only the ones the
 * caller can actually use is both safe and more useful.
 */
search.get(
  '/filters',
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const workspaces = await readableWorkspaces(c.env.DB, principal)
    const scopeIds = await accessibleWorkspaceIds(c.env.DB, principal)

    const types = scopeIds.length
      ? await all<{ extension: string; n: number }>(
          c.env.DB,
          `SELECT extension, COUNT(*) AS n FROM artifacts
            WHERE workspace_id IN (${scopeIds.map(() => '?').join(',')})
              AND deleted_at IS NULL AND extension IS NOT NULL
            GROUP BY extension ORDER BY n DESC`,
          scopeIds
        )
      : []

    const tags = await all<{ name: string; slug: string; n: number }>(
      c.env.DB,
      `SELECT t.name, t.slug, COUNT(at.artifact_id) AS n
         FROM tags t
         LEFT JOIN artifact_tags at ON at.tag_id = t.id
         LEFT JOIN artifacts a ON a.id = at.artifact_id AND a.deleted_at IS NULL
        WHERE t.status = 'ACTIVE'
        GROUP BY t.id ORDER BY n DESC, t.name ASC`,
      []
    )

    const owners = scopeIds.length
      ? await all<{ owner_user_id: string; display_name: string | null; email: string; n: number }>(
          c.env.DB,
          `SELECT a.owner_user_id, u.display_name, u.email, COUNT(*) AS n
             FROM artifacts a JOIN users u ON u.id = a.owner_user_id
            WHERE a.workspace_id IN (${scopeIds.map(() => '?').join(',')})
              AND a.deleted_at IS NULL
            GROUP BY a.owner_user_id ORDER BY n DESC LIMIT 20`,
          scopeIds
        )
      : []

    return ok(c, {
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, type: w.workspace_type })),
      types: types.map((t) => ({ extension: t.extension, count: t.n })),
      tags: tags.map((t) => ({ name: t.name, slug: t.slug, count: t.n })),
      owners: owners.map((o) => ({
        id: o.owner_user_id,
        name: o.display_name ?? o.email,
        count: o.n
      }))
    })
  })
)

/**
 * Recent searches are stored per user, not globally, so the "Recent Searches"
 * list on the search screen (§83) never reveals another user's interests.
 */
search.get(
  '/recent',
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const rows = await all<{ query: string; created_at: string }>(
      c.env.DB,
      `SELECT query, created_at FROM search_history
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 8`,
      [principal.userId]
    )

    return ok(c, { recent: rows.map((r) => r.query) })
  })
)

search.post(
  '/recent',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ query?: string }>(c)
    const query = (body.query ?? '').trim()
    if (query.length < 2) return ok(c, { saved: false })

    await run(c.env.DB, `DELETE FROM search_history WHERE user_id = ? AND query = ?`, [
      principal.userId,
      query
    ])
    await run(
      c.env.DB,
      `INSERT INTO search_history (id, user_id, query, created_at) VALUES (?, ?, ?, ?)`,
      [prefixed('sh', ulid()), principal.userId, query.slice(0, 200), nowIso()]
    )

    // Keep the per-user history bounded
    await run(
      c.env.DB,
      `DELETE FROM search_history
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
        )`,
      [principal.userId, principal.userId]
    )

    return ok(c, { saved: true })
  })
)

/** Typeahead suggestions, drawn from titles the caller may already read. */
search.get(
  '/suggest',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const q = (c.req.query('q') ?? '').trim()
    if (q.length < 2) return ok(c, { suggestions: [] })

    const scopeIds = await accessibleWorkspaceIds(c.env.DB, principal)
    if (!scopeIds.length) return ok(c, { suggestions: [] })

    const like = `%${q.toLowerCase()}%`
    const rows = await all<{ id: string; title: string; extension: string | null }>(
      c.env.DB,
      `SELECT id, title, extension FROM artifacts
        WHERE workspace_id IN (${scopeIds.map(() => '?').join(',')})
          AND deleted_at IS NULL
          AND (LOWER(title) LIKE ? OR LOWER(filename) LIKE ?)
        ORDER BY updated_at DESC LIMIT 6`,
      [...scopeIds, like, like]
    )

    return ok(c, {
      suggestions: rows.map((r) => ({ id: r.id, title: r.title, extension: r.extension }))
    })
  })
)

export default search
