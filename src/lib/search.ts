/**
 * Search — PRD §30–§33.
 *
 * Architecture mirrors the PRD (§32): a lexical engine and an optional
 * semantic engine are queried, results are merged and ranked, and *then*
 * ACL filtering is applied. Authorization is part of the query scope rather
 * than a post-filter on rendered content, so inaccessible artifacts cannot
 * leak through titles, snippets, tag suggestions or match counts (§33).
 *
 * The semantic engine is behind an interface: when a Vectorize binding and
 * Workers AI are available it becomes active, otherwise search degrades
 * cleanly to lexical-only. No code path depends on it existing.
 */

import type { ArtifactRow, Env, Principal } from '../types'
import { all, first } from './db'
import { readableWorkspaces } from './principal'
import {
  isSemanticConfigured,
  publicIndexReason,
  semanticQuery
} from './embeddings'

export interface SearchFilters {
  workspaceIds?: string[]
  types?: string[] // extensions, e.g. ['pptx']
  tagSlugs?: string[]
  ownerIds?: string[]
  statuses?: string[]
  createdFrom?: string
  createdTo?: string
}

export interface SearchRequest extends SearchFilters {
  query: string
  limit?: number
  offset?: number
  sort?: 'relevance' | 'updated' | 'created' | 'title'
}

export interface SearchHit {
  artifact: ArtifactRow
  tags: string[]
  score: number
  matchSource: 'lexical' | 'semantic' | 'both'
  isOwner: boolean
  workspaceName: string | null
}

export interface SearchResponse {
  hits: SearchHit[]
  total: number
  engine: { lexical: boolean; semantic: boolean; semanticReason: string }
}

// ---------------------------------------------------------------
// Semantic provider abstraction (§31)
// ---------------------------------------------------------------

export interface SemanticRun {
  /**
   * True only when a genuine vector query executed: the query was embedded AND
   * the Vectorize lookup completed. A degraded or skipped path returns false so
   * the API can never report `semantic:true` for work that did not happen (§32).
   */
  ran: boolean
  results: Array<{ artifactId: string; score: number }>
  reason: string
}

export interface SemanticProvider {
  name: string
  available: boolean
  reason: string
  search(query: string, scopeWorkspaceIds: string[], limit: number): Promise<SemanticRun>
}

/**
 * Default provider for deployments without Vectorize/Workers AI bindings.
 * Reports itself unavailable; the merge step then skips it entirely and the
 * search API shape stays identical.
 */
export const unavailableSemantic: SemanticProvider = {
  name: 'NONE',
  available: false,
  reason: 'Semantic index not provisioned',
  async search() {
    return { ran: false, results: [], reason: 'Semantic index not provisioned' }
  }
}

/**
 * Real provider: Workers AI embeddings + Vectorize ANN lookup.
 *
 * Scope safety is layered, not single-point:
 *   1. `semanticQuery` drops any match whose metadata workspaceId is outside
 *      the caller's readable workspaces (fails closed on missing metadata).
 *   2. `searchArtifacts` re-loads every semantic-only candidate through a SQL
 *      query bounded by the same workspace ids.
 * A vector belonging to another tenant therefore cannot become a hit even if
 * the metadata filter were wrong or the index were shared.
 */
export function resolveSemanticProvider(env: Pick<Env, 'VECTORIZE' | 'AI'>): SemanticProvider {
  const configured = isSemanticConfigured(env)

  return {
    name: configured ? 'WORKERS_AI_VECTORIZE' : 'NONE',
    available: configured,
    reason: configured ? 'Semantic search available' : 'Semantic index not provisioned',
    async search(query, scopeWorkspaceIds, limit) {
      const result = await semanticQuery(env, query, scopeWorkspaceIds, limit)
      return {
        ran: result.ran,
        results: result.results.map((hit) => ({ artifactId: hit.artifactId, score: hit.score })),
        reason: result.reason
      }
    }
  }
}

// ---------------------------------------------------------------
// Lexical query construction
// ---------------------------------------------------------------

/**
 * Convert free text into a safe FTS5 MATCH expression.
 *
 * FTS5 syntax characters are stripped rather than escaped, because a user
 * typing quotes or parentheses should search for literal words, not produce
 * a syntax error. Tokens are prefix-matched to keep partial queries useful.
 */
export function buildMatchExpression(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12)

  if (!tokens.length) return null
  return tokens.map((t) => `"${t}"*`).join(' AND ')
}

/** Looser fallback used when the strict AND query returns nothing. */
function buildOrExpression(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12)

  if (tokens.length < 2) return null
  return tokens.map((t) => `"${t}"*`).join(' OR ')
}

// ---------------------------------------------------------------
// ACL scope
// ---------------------------------------------------------------

/**
 * Workspace ids the principal may search. Every query is bounded by this
 * set; an empty set yields no results rather than all results.
 */
export async function accessibleWorkspaceIds(
  db: D1Database,
  principal: Principal,
  requested?: string[]
): Promise<string[]> {
  const readable = await readableWorkspaces(db, principal)
  const readableIds = new Set(readable.map((w) => w.id))

  if (!requested?.length) return [...readableIds]

  // A caller may narrow the scope, never widen it (§64)
  return requested.filter((id) => readableIds.has(id))
}

// ---------------------------------------------------------------
// Search execution
// ---------------------------------------------------------------

export async function searchArtifacts(
  db: D1Database,
  principal: Principal,
  request: SearchRequest,
  semantic: SemanticProvider = unavailableSemantic
): Promise<SearchResponse> {
  const limit = Math.min(Math.max(request.limit ?? 25, 1), 100)
  const offset = Math.max(request.offset ?? 0, 0)

  const workspaceIds = await accessibleWorkspaceIds(db, principal, request.workspaceIds)

  const emptyResponse: SearchResponse = {
    hits: [],
    total: 0,
    // No readable workspaces means no query ran — never report semantic:true.
    engine: { lexical: true, semantic: false, semanticReason: 'No readable workspaces in scope' }
  }

  if (!workspaceIds.length) return emptyResponse

  const params: unknown[] = []
  const where: string[] = ['a.deleted_at IS NULL']

  where.push(`a.workspace_id IN (${workspaceIds.map(() => '?').join(',')})`)
  params.push(...workspaceIds)

  if (request.types?.length) {
    where.push(`a.extension IN (${request.types.map(() => '?').join(',')})`)
    params.push(...request.types.map((t) => t.toLowerCase().replace(/^\./, '')))
  }

  if (request.ownerIds?.length) {
    where.push(`a.owner_user_id IN (${request.ownerIds.map(() => '?').join(',')})`)
    params.push(...request.ownerIds)
  }

  if (request.statuses?.length) {
    where.push(`a.status IN (${request.statuses.map(() => '?').join(',')})`)
    params.push(...request.statuses)
  }

  if (request.createdFrom) {
    where.push('a.created_at >= ?')
    params.push(request.createdFrom)
  }
  if (request.createdTo) {
    where.push('a.created_at <= ?')
    params.push(request.createdTo)
  }

  if (request.tagSlugs?.length) {
    // Require every requested tag (AND semantics), matching how the filter
    // chips read on the search screen.
    where.push(`(
      SELECT COUNT(DISTINCT t.slug) FROM artifact_tags at
        JOIN tags t ON t.id = at.tag_id
       WHERE at.artifact_id = a.id
         AND t.slug IN (${request.tagSlugs.map(() => '?').join(',')})
    ) = ?`)
    params.push(...request.tagSlugs, request.tagSlugs.length)
  }

  const matchExpr = buildMatchExpression(request.query)
  const orExpr = matchExpr ? buildOrExpression(request.query) : null

  let rows: Array<ArtifactRow & { score: number }> = []

  // Which FTS expression actually produced `rows`. The count at the end of this
  // function has to use the same one: counting with the strict AND expression
  // while the rows came back from the looser OR fallback reported "0 results"
  // above a non-empty list of hits.
  let usedExpr: string | null = matchExpr

  if (matchExpr) {
    rows = await lexicalQuery(db, matchExpr, where, params, limit, offset, request.sort)
    // The relaxed expression is a recall rescue for an empty first page, not a
    // second result set: past page 1 an empty strict page means the results
    // really are exhausted, and re-running it there would re-order the tail.
    if (!rows.length && orExpr && offset === 0) {
      const relaxed = await lexicalQuery(db, orExpr, where, params, limit, offset, request.sort)
      if (relaxed.length) {
        rows = relaxed
        usedExpr = orExpr
      }
    }
  } else {
    // No usable query text: behave as a filtered browse (§83 filters only)
    rows = await browseQuery(db, where, params, limit, offset, request.sort)
  }

  // Semantic augmentation. Lexical results are already in hand, so any failure
  // here degrades to lexical-only rather than failing the request (§32).
  let semanticIds: Array<{ artifactId: string; score: number }> = []
  let semanticRan = false
  let semanticReason = semantic.reason

  if (semantic.available && request.query.trim()) {
    try {
      const run = await semantic.search(request.query, workspaceIds, limit)
      semanticIds = run.results
      semanticRan = run.ran
      semanticReason = run.reason
    } catch (err) {
      console.error('[search] semantic provider failed, using lexical only', err)
      semanticReason = 'Vector search failed — lexical results only'
    }
  }

  const semanticMap = new Map(semanticIds.map((s) => [s.artifactId, s.score]))

  // Snapshot of what the lexical engine returned, taken *before* the semantic-only
  // rows are appended below. This is what distinguishes a 'both' hit from a
  // semantic-only one; deriving it from the score cannot work, because the
  // appended rows carry their semantic score in the same field.
  const lexicalIds = new Set(rows.map((r) => r.id))
  const seen = new Set(rows.map((r) => r.id))

  // Pull in the hits that only the vector search found.
  //
  // These are re-loaded through the *same* WHERE clause the lexical query used,
  // not merely the workspace list. The workspace scope is necessary but not
  // sufficient: a caller who filtered by tag, type, owner or date would
  // otherwise have that filter side-stepped by any in-scope vector match, so a
  // vector hit could surface an artifact the filter was meant to exclude.
  const extraIds = semanticIds.map((s) => s.artifactId).filter((id) => !seen.has(id))
  let semanticOnlyCount = 0
  if (extraIds.length) {
    const extra = await all<ArtifactRow>(
      db,
      `SELECT a.* FROM artifacts a
        WHERE a.id IN (${extraIds.map(() => '?').join(',')})
          AND ${where.join(' AND ')}`,
      [...extraIds, ...params]
    )
    semanticOnlyCount = extra.length
    rows = [...rows, ...extra.map((r) => ({ ...r, score: semanticMap.get(r.id) ?? 0 }))]
  }

  const tagMap = await loadTagsFor(db, rows.map((r) => r.id))
  const workspaceNames = await loadWorkspaceNames(db, rows.map((r) => r.workspace_id))

  const hits: SearchHit[] = rows.map((row) => {
    const semScore = semanticMap.get(row.id) ?? 0
    // Tracked by origin, not inferred from the score.
    //
    // Semantic-only rows are appended above with `score` set to their *semantic*
    // score, so scoring them as `row.score > 0 && semScore > 0` always matched
    // the first branch and labelled every vector-only hit 'both'. That made
    // matchSource 'semantic' unreachable, so the UI could never show "Found by
    // meaning" for the one case it is meant to describe.
    const fromLexical = lexicalIds.has(row.id)
    const source: SearchHit['matchSource'] =
      fromLexical && semScore > 0 ? 'both' : semScore > 0 ? 'semantic' : 'lexical'
    return {
      artifact: row,
      tags: tagMap.get(row.id) ?? [],
      score: row.score + semScore,
      matchSource: source,
      isOwner: row.owner_user_id === principal.userId,
      workspaceName: workspaceNames.get(row.workspace_id) ?? null
    }
  })

  return {
    hits: hits.slice(0, limit),
    total: (await countResults(db, usedExpr, where, params)) + semanticOnlyCount,
    // `semantic` reflects whether the vector query actually ran for this
    // request — not merely whether the bindings exist.
    // Scrubbed at the single point every caller reads it, so no provider
    // wording can put a model name or index detail in front of a user.
    engine: {
      lexical: true,
      semantic: semanticRan,
      semanticReason: publicIndexReason(semanticReason)
    }
  }
}

function orderClause(sort: SearchRequest['sort']): string {
  switch (sort) {
    case 'updated':
      return 'a.updated_at DESC'
    case 'created':
      return 'a.created_at DESC'
    case 'title':
      return 'a.title COLLATE NOCASE ASC'
    default:
      return 'score DESC, a.updated_at DESC'
  }
}

async function lexicalQuery(
  db: D1Database,
  matchExpr: string,
  where: string[],
  params: unknown[],
  limit: number,
  offset: number,
  sort: SearchRequest['sort']
): Promise<Array<ArtifactRow & { score: number }>> {
  const sql = `
    SELECT a.*, bm25(artifact_search, 8.0, 5.0, 3.0, 4.0, 1.0) * -1 AS score
      FROM artifact_search
      JOIN artifacts a ON a.seq = artifact_search.rowid
     WHERE artifact_search MATCH ?
       AND ${where.join(' AND ')}
     ORDER BY ${orderClause(sort)}
     LIMIT ? OFFSET ?`

  return all<ArtifactRow & { score: number }>(db, sql, [matchExpr, ...params, limit, offset])
}

async function browseQuery(
  db: D1Database,
  where: string[],
  params: unknown[],
  limit: number,
  offset: number,
  sort: SearchRequest['sort']
): Promise<Array<ArtifactRow & { score: number }>> {
  const sql = `
    SELECT a.*, 0 AS score FROM artifacts a
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderClause(sort)}
     LIMIT ? OFFSET ?`
  return all<ArtifactRow & { score: number }>(db, sql, [...params, limit, offset])
}

/**
 * Count matches for the expression that actually produced the results.
 *
 * `expr` is that expression, or null for a filter-only browse. Semantic-only
 * hits are not in the FTS index, so the caller adds those separately.
 */
async function countResults(
  db: D1Database,
  expr: string | null,
  where: string[],
  params: unknown[]
): Promise<number> {
  if (expr) {
    const row = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM artifact_search
        JOIN artifacts a ON a.seq = artifact_search.rowid
       WHERE artifact_search MATCH ? AND ${where.join(' AND ')}`,
      [expr, ...params]
    )
    return row?.n ?? 0
  }
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM artifacts a WHERE ${where.join(' AND ')}`,
    params
  )
  return row?.n ?? 0
}

export async function loadTagsFor(
  db: D1Database,
  artifactIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!artifactIds.length) return map

  const rows = await all<{ artifact_id: string; slug: string; name: string }>(
    db,
    `SELECT at.artifact_id, t.slug, t.name
       FROM artifact_tags at
       JOIN tags t ON t.id = at.tag_id
      WHERE at.artifact_id IN (${artifactIds.map(() => '?').join(',')})
        AND t.status = 'ACTIVE'
      ORDER BY t.name ASC`,
    artifactIds
  )

  for (const row of rows) {
    const list = map.get(row.artifact_id) ?? []
    list.push(row.name)
    map.set(row.artifact_id, list)
  }
  return map
}

async function loadWorkspaceNames(
  db: D1Database,
  workspaceIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(workspaceIds)]
  if (!unique.length) return map

  const rows = await all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM workspaces WHERE id IN (${unique.map(() => '?').join(',')})`,
    unique
  )
  for (const row of rows) map.set(row.id, row.name)
  return map
}

// ---------------------------------------------------------------
// Index maintenance (§22, §30, §94)
// ---------------------------------------------------------------

/**
 * Upsert the artifact's row in the FTS index.
 *
 * artifact_search.rowid is bound to artifacts.seq, so the two stay in sync
 * without a join key on every write. Tag text is denormalised into the index
 * so tag names are searchable (§30).
 */
export async function indexArtifact(db: D1Database, artifactId: string): Promise<void> {
  const artifact = await first<ArtifactRow & { seq: number }>(
    db,
    `SELECT * FROM artifacts WHERE id = ?`,
    [artifactId]
  )
  if (!artifact) return

  const version = artifact.current_version_id
    ? await first<{ extracted_text: string | null }>(
        db,
        `SELECT extracted_text FROM artifact_versions WHERE id = ?`,
        [artifact.current_version_id]
      )
    : null

  const tagNames = await all<{ name: string }>(
    db,
    `SELECT t.name FROM artifact_tags at JOIN tags t ON t.id = at.tag_id WHERE at.artifact_id = ?`,
    [artifactId]
  )

  const tagsText = tagNames.map((t) => t.name).join(' ')
  const extracted = version?.extracted_text ?? ''

  await db
    .prepare(`DELETE FROM artifact_search WHERE rowid = ?`)
    .bind(artifact.seq)
    .run()

  await db
    .prepare(
      `INSERT INTO artifact_search (rowid, title, filename, description, tags, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      artifact.seq,
      artifact.title ?? '',
      artifact.filename ?? '',
      artifact.description ?? '',
      tagsText,
      extracted.slice(0, 200_000)
    )
    .run()
}

export async function removeFromIndex(db: D1Database, artifactSeq: number): Promise<void> {
  await db.prepare(`DELETE FROM artifact_search WHERE rowid = ?`).bind(artifactSeq).run()
}
