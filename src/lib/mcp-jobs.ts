/**
 * Job-oriented MCP tools — Find → Save → Share.
 *
 * An agent should be able to do three things naturally:
 *
 *     artifactry.search("Q3 board deck", workspace="Finance")
 *     artifactry.save(file="board-qna.docx", workspace="Finance")
 *     artifactry.share(".../a/board-qna-4hd2", team="Board prep")
 *
 * So the exposed surface is those three jobs plus the small number of things
 * they unavoidably need (get, create_version, the three list_* lookups,
 * update_tags, revoke_share). Low-level storage primitives stay behind the
 * service layer — they remain reachable as REST, but an agent is not invited to
 * reason in them.
 *
 * Three invariants hold across every tool here:
 *
 *   1. Authorization is re-derived from the principal on every call. No
 *      identifier supplied in the arguments is ever trusted; a workspace or team
 *      named by the caller is resolved *within* what the caller may already see
 *      (§64).
 *   2. AI permission never exceeds the user's. `can()` re-checks the user's real
 *      role in addition to the grant's scopes (§59).
 *   3. Every call is recorded with user, AI client, operation, artifact and
 *      timestamp, so "which AI did what, on whose behalf" is answerable.
 */

import type { ArtifactRow, Env, Principal } from '../types'
import {
  createArtifact,
  createVersion,
  loadArtifact,
  normalizeTitle,
  assignTags
} from './artifacts'
import { searchArtifacts, resolveSemanticProvider } from './search'
import { createShare, revokeShare } from './sharing'
import { convertContent, ConversionUnsupported } from './convert'
import { all, first, nowIso, run } from './db'
import { badRequest, forbidden, notFound } from './http'
import { recordAudit } from './audit'
import { recordEvent } from './analytics'
import { can, effectiveWorkspaceRole, readableWorkspaces } from './principal'
import {
  activeMemberEmails,
  assertTeamUsableForArtifact,
  resolveTeamByName,
  teamSummary
} from './teams'
import {
  addTagToArtifact,
  applyTagDecisions,
  artifactTagViews,
  confirmedTagNames,
  findTagBySlug,
  resolveOrCreateTag
} from './tags'
import type { TagDecisionResult } from './tags'
import { filterSuggestions, suggestTags, MAX_TAGS, MIN_TAGS } from './autotag'
import {
  CONFIRM_MESSAGES,
  consumeConfirmation,
  confirmationPrompt,
  createConfirmation
} from './confirmations'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** OAuth scope required to invoke the tool (§58). */
  requiredScope: string
}

export interface ToolOutcome {
  text: string
  structured?: unknown
  isError?: boolean
}

const ARTIFACT_REF =
  'An artifact id (art_…) or a canonical Artifactry URL (https://…/a/art_…)'

// ---------------------------------------------------------------
// Tool catalogue — the user-facing jobs
// ---------------------------------------------------------------

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'search',
    description:
      'Find source material in the library. Natural-language query with optional filters for ' +
      'workspace, artifact type, tags, collection/team, owner and date range. Uses the same hybrid ' +
      'lexical + semantic engine as the app. Only artifacts the signed-in user may access are ever returned.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query' },
        workspace: { type: 'string', description: 'Workspace name or id' },
        type: { type: 'string', description: 'File extension, e.g. pptx, pdf, docx' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names or slugs to require' },
        collection: { type: 'string', description: 'Collection name or id' },
        team: { type: 'string', description: "Named audience whose shared artifacts to include" },
        owner: { type: 'string', description: 'Owner email, for artifacts owned by someone else' },
        created_after: { type: 'string', description: 'ISO date; artifacts created on/after' },
        created_before: { type: 'string', description: 'ISO date; artifacts created on/before' },
        updated_after: { type: 'string', description: 'ISO date; artifacts updated on/after' },
        updated_before: { type: 'string', description: 'ISO date; artifacts updated on/before' },
        sort: { type: 'string', enum: ['relevance', 'updated', 'created', 'title'] },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        include_excerpt: {
          type: 'boolean',
          description: 'Include a short authorized text excerpt per result (default true)'
        }
      },
      required: []
    }
  },
  {
    name: 'get',
    description:
      'Retrieve one artifact by id or canonical URL, including its tags, workspace and current version. ' +
      'Returns the extracted text when the artifact has a text layer; binary formats return metadata and ' +
      'the canonical URL instead of inlining bytes.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: ARTIFACT_REF },
        include_text: { type: 'boolean', description: 'Include extracted text (default true)' }
      },
      required: ['artifact']
    }
  },
  {
    name: 'save',
    description:
      'Persist what the AI has just produced. Provide a binary file (base64) or structured text plus a ' +
      'target format. Saves into a workspace, optionally into a collection, and proposes tags from the ' +
      "artifact's actual content. Use create_version to add a version to an artifact that already exists.",
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename including a supported extension' },
        content_base64: { type: 'string', description: 'Base64 file bytes (for binary formats)' },
        content: { type: 'string', description: 'Raw text content, converted when format is given' },
        format: { type: 'string', description: 'Target format when saving text: pdf or html' },
        title: { type: 'string' },
        description: { type: 'string' },
        workspace: { type: 'string', description: 'Target workspace name or id' },
        collection: { type: 'string', description: 'Optional collection name or id' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to apply and confirm' },
        source_conversation_reference: { type: 'string' }
      }
    }
  },
  {
    name: 'create_version',
    description:
      'Add a new version to an existing artifact, preserving all prior versions. Use this instead of save ' +
      'when the AI is revising something already in the library.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: ARTIFACT_REF },
        file: { type: 'string' },
        content_base64: { type: 'string' },
        content: { type: 'string' },
        change_summary: { type: 'string' }
      },
      required: ['artifact']
    }
  },
  {
    name: 'share',
    description:
      'Share an existing artifact with its intended audience: a named team, a workspace, specific email ' +
      'addresses, an email domain, or a public link, with optional expiry and view/download permission. ' +
      'An audience that takes the content outside the organization (public link, raw addresses, email ' +
      'domain) requires explicit user confirmation first: the call returns a confirmation request and ' +
      'nothing is shared until the user agrees.',
    requiredScope: 'artifact.share',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: ARTIFACT_REF },
        team: { type: 'string', description: 'Named audience, e.g. "Board prep"' },
        workspace: { type: 'string', description: 'Share with everyone in a workspace' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Specific recipients' },
        domain: { type: 'string', description: 'Recipient email domain' },
        public: { type: 'boolean', description: 'Create a public link' },
        permission: { type: 'string', enum: ['view', 'download'], description: 'Default: view' },
        expires_in_days: { type: 'number', description: 'Expiry in days' },
        team_id: { type: 'string', description: 'Disambiguate when a team name matches several teams' },
        confirmation_id: { type: 'string', description: 'From a previous confirmation request' }
      },
      required: ['artifact']
    }
  },
  {
    name: 'revoke_share',
    description: 'Revoke a share so its link stops working immediately.',
    requiredScope: 'artifact.share',
    inputSchema: {
      type: 'object',
      properties: { share_id: { type: 'string' }, share_url: { type: 'string' } },
      required: []
    }
  },
  {
    name: 'list_workspaces',
    description: 'List the workspaces the signed-in user can access, with their role.',
    requiredScope: 'workspace.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_teams',
    description:
      'List reusable named audiences (teams) the signed-in user can share with, with member counts. ' +
      'Use a team name with share to address an audience without supplying individual addresses.',
    requiredScope: 'team.read',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Filter to teams usable in a workspace' } }
    }
  },
  {
    name: 'list_tags',
    description:
      'List tags in use. Confirmed tags are the library vocabulary; suggestions are shown for a specific ' +
      'artifact via get, not here.',
    requiredScope: 'tags.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_tags',
    description:
      'Change the tags on an artifact: accept a suggested tag, reject one, add a new one, or remove one. ' +
      'Tags are case-insensitively deduplicated, and a rejected tag is remembered so it is not offered ' +
      'again unless the content changes.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: ARTIFACT_REF },
        accept: { type: 'array', items: { type: 'string' }, description: 'Suggested tags to confirm' },
        reject: { type: 'array', items: { type: 'string' }, description: 'Tags to decline' },
        add: { type: 'array', items: { type: 'string' }, description: 'New or existing tags to add and confirm' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to detach entirely' }
      },
      required: ['artifact']
    }
  }
]

export function jobToolByName(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name)
}

// ---------------------------------------------------------------
// JSON-RPC transport (MCP protocol 2025-06-18)
// ---------------------------------------------------------------

export interface McpRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface McpResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2025-06-18'

/**
 * Server instructions are the agent's orientation, so they describe the jobs
 * this surface is built around rather than listing primitives. The share
 * confirmation rule is stated here as well as in the tool description because a
 * model that jumps straight to `share` still needs to know that an audience
 * reaching outside the organization requires the user's agreement first.
 */
const SERVER_INSTRUCTIONS =
  "Artifactry is the user's persistent artifact library. Work in three jobs: " +
  'search to find source material, save to store what you have produced (or create_version ' +
  'to revise something already saved), and share to put it in front of an audience — a named ' +
  'team, a workspace, specific people, an email domain, or a public link. Every artifact gets ' +
  'suggested tags derived from its own content; use update_tags to accept, reject or add. ' +
  'Sharing beyond the organization needs the user to agree first: the share call returns a ' +
  'confirmation request and NOTHING is shared until you pass that confirmation_id back. ' +
  'Only artifacts the user may access are ever returned.'

/** Guard: a grant may only call tools its scopes cover (§58, §59). */
function assertScope(principal: Principal, tool: McpToolDefinition): void {
  if (principal.kind !== 'AI_GRANT') {
    throw forbidden('MCP tool calls require an AI access token')
  }
  if (!principal.scopes.includes(tool.requiredScope)) {
    throw forbidden(
      `This connection lacks the "${tool.requiredScope}" scope required by ${tool.name}`
    )
  }
}

/**
 * Record the identity the connection reports during `initialize` (§59).
 *
 * The client name is what makes AI provenance legible — "Claude Desktop" is an
 * answerable fact in a way that "ANTHROPIC" is not — and it is only ever what
 * the client says about itself, never guessed from a user agent. It is written
 * onto the grant so every later call, and every artifact this connection saves,
 * carries it.
 */
async function recordClientIdentity(
  db: D1Database,
  principal: Principal,
  params: Record<string, unknown>
): Promise<void> {
  if (!principal.grantId) return

  const info = params.clientInfo as { name?: unknown; version?: unknown } | undefined
  const name = typeof info?.name === 'string' ? info.name.trim().slice(0, 120) : ''
  const version = typeof info?.version === 'string' ? info.version.trim().slice(0, 60) : ''
  if (!name) return

  await run(
    db,
    `UPDATE integration_grants SET client_name = ?, client_version = ? WHERE id = ?`,
    [name, version || null, principal.grantId]
  )

  // Keep this request's principal aligned with what was just stored, so a tool
  // call arriving in the same batch also records the client name.
  principal.clientName = name
  if (version) principal.clientVersion = version
}

export async function handleMcpRequest(
  env: Env,
  principal: Principal,
  request: McpRequest,
  origin: string
): Promise<McpResponse> {
  const id = request.id ?? null

  if (request.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } }
  }

  try {
    switch (request.method) {
      case 'initialize': {
        await recordClientIdentity(env.DB, principal, request.params ?? {})
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'artifactry', version: '1.0.0', title: 'Artifactry' },
            instructions: SERVER_INSTRUCTIONS,
            clientInfo: {
              name: principal.clientName ?? null,
              version: principal.clientVersion ?? null
            }
          }
        }
      }

      case 'notifications/initialized':
      case 'initialized':
        return { jsonrpc: '2.0', id, result: {} }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        }

      case 'tools/call': {
        const params = request.params ?? {}
        const name = String(params.name ?? '')
        const args = (params.arguments ?? {}) as Record<string, unknown>

        const tool = jobToolByName(name)
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${name}` }
          }
        }

        assertScope(principal, tool)

        const outcome = await callJobTool(env, principal, name, args, origin)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text' as const, text: outcome.text }],
            ...(outcome.structured !== undefined
              ? { structuredContent: outcome.structured }
              : {}),
            isError: outcome.isError === true
          }
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported method: ${request.method}` }
        }
    }
  } catch (err) {
    // A transport-level failure (unknown tool, missing scope) is an MCP error.
    // Tool-level failures were already converted to results by callJobTool, so a
    // provider can show the model why its call failed instead of dying.
    const message = err instanceof Error ? err.message : 'Unexpected MCP error'
    return { jsonrpc: '2.0', id, error: { code: -32000, message } }
  }
}

// ---------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------

export async function callJobTool(
  env: Env,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'search':
        return await toolSearch(env, principal, args)
      case 'get':
        return await toolGet(env, principal, args)
      case 'save':
        return await toolSave(env, principal, args, origin)
      case 'create_version':
        return await toolCreateVersion(env, principal, args)
      case 'share':
        return await toolShare(env, principal, args, origin)
      case 'revoke_share':
        return await toolRevokeShare(env, principal, args)
      case 'list_workspaces':
        return await toolListWorkspaces(env, principal)
      case 'list_teams':
        return await toolListTeams(env, principal, args)
      case 'list_tags':
        return await toolListTags(env, principal)
      case 'update_tags':
        return await toolUpdateTags(env, principal, args)
      default:
        return { text: `Tool not implemented: ${name}`, isError: true }
    }
  } catch (err) {
    // Tool failures are returned as results, not thrown, so a provider can show
    // the model why its call failed instead of ending the session.
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return { text: message, isError: true }
  }
}

// ---------------------------------------------------------------
// search
// ---------------------------------------------------------------

async function toolSearch(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50)
  const includeExcerpt = args.include_excerpt !== false

  const workspaceIds = await resolveWorkspaceScope(db, principal, args.workspace)
  if (!workspaceIds.length) {
    return { text: 'No accessible workspace matches that filter.', structured: { results: [] } }
  }

  const tagSlugs = await resolveTagFilters(db, args.tags)
  const collectionIds = await resolveCollectionFilters(db, principal, args.collection, workspaceIds)
  const ownerIds = await resolveOwnerFilter(db, args.owner)
  const types = Array.isArray(args.type)
    ? (args.type as unknown[]).map((t) => String(t).replace(/^\./, ''))
    : typeof args.type === 'string' && args.type.trim()
      ? [args.type.trim().replace(/^\./, '')]
      : undefined

  const sort = (['relevance', 'updated', 'created', 'title'] as const).includes(args.sort as never)
    ? (args.sort as 'relevance' | 'updated' | 'created' | 'title')
    : 'relevance'

  const response = await searchArtifacts(
    db,
    principal,
    {
      query: typeof args.query === 'string' ? args.query : '',
      limit,
      workspaceIds,
      types,
      tagSlugs,
      collectionIds,
      ownerIds,
      sort,
      createdFrom: isoOrUndefined(args.created_after),
      createdTo: isoOrUndefined(args.created_before),
      updatedFrom: isoOrUndefined(args.updated_after),
      updatedTo: isoOrUndefined(args.updated_before)
    },
    resolveSemanticProvider(env)
  )

  // Retrieval by an AI application is an analytics event (§57) and provenance
  // is recorded per call (§59).
  for (const hit of response.hits) {
    await recordEvent(db, {
      artifactId: hit.artifact.id,
      workspaceId: hit.artifact.workspace_id,
      organizationId: hit.artifact.organization_id,
      eventType: 'artifact_ai_retrieved',
      actorType: 'AI',
      actorUserId: principal.userId,
      aiProvider: principal.provider ?? 'API',
      accessChannel: 'AI'
    }).catch(() => {})
  }

  if (!response.hits.length) {
    return {
      text: 'No artifacts found.',
      structured: {
        results: [],
        engine: response.engine,
        total: 0,
        hint: 'Try a broader query, or omit the workspace filter.'
      }
    }
  }

  const results = response.hits.map((hit) => ({
    artifact_id: hit.artifact.id,
    title: hit.artifact.title,
    type: hit.artifact.extension,
    canonical_url: `${origin}/a/${hit.artifact.id}`,
    workspace: hit.workspaceName,
    tags: hit.tags,
    updated_at: hit.artifact.updated_at,
    match: hit.matchSource,
    score: Number(hit.score.toFixed(4)),
    ...(includeExcerpt && hit.excerpt ? { excerpt: hit.excerpt } : {})
  }))

  const summary = results
    .map((r) => `- ${r.title} (${r.type ?? 'file'}, ${r.workspace ?? 'workspace'}) — ${r.canonical_url}`)
    .join('\n')

  return {
    text: `Found ${results.length} artifact(s):\n${summary}`,
    structured: { results, total: response.total, engine: response.engine }
  }
}

// ---------------------------------------------------------------
// get
// ---------------------------------------------------------------

async function toolGet(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'artifact.read')

  const tags = await artifactTagViews(db, artifact.id)
  const versions = await all<{ id: string; version_number: number; created_at: string }>(
    db,
    `SELECT id, version_number, created_at FROM artifact_versions
      WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY version_number DESC`,
    [artifact.id]
  )

  const includeText = args.include_text !== false
  let text: string | null = null
  let truncated = false

  if (includeText && artifact.current_version_id) {
    const version = await first<{ extracted_text: string | null }>(
      db,
      `SELECT extracted_text FROM artifact_versions WHERE id = ?`,
      [artifact.current_version_id]
    )
    if (version?.extracted_text) {
      truncated = version.extracted_text.length > 100_000
      text = version.extracted_text.slice(0, 100_000)
    }

    await recordEvent(db, {
      artifactId: artifact.id,
      workspaceId: artifact.workspace_id,
      organizationId: artifact.organization_id,
      eventType: 'artifact_ai_referenced',
      actorType: 'AI',
      actorUserId: principal.userId,
      aiProvider: principal.provider ?? 'API',
      accessChannel: 'AI'
    }).catch(() => {})

    await recordAudit(db, {
      organizationId: artifact.organization_id,
      workspaceId: artifact.workspace_id,
      actorUserId: principal.userId,
      actorType: 'AI',
      action: 'AI_FETCH',
      targetType: 'artifact',
      targetId: artifact.id,
      metadata: { provider: principal.provider ?? 'API', operation: 'get' }
    })
  }

  return {
    text: `${artifact.title} — ${origin}/a/${artifact.id}`,
    structured: {
      artifact_id: artifact.id,
      title: artifact.title,
      description: artifact.description,
      filename: artifact.filename,
      type: artifact.extension,
      mime_type: artifact.mime_type,
      size_bytes: artifact.size_bytes,
      status: artifact.status,
      workspace_id: artifact.workspace_id,
      canonical_url: `${origin}/a/${artifact.id}`,
      version_count: artifact.version_count,
      current_version_id: artifact.current_version_id,
      updated_at: artifact.updated_at,
      tags: tags.map((t) => ({
        name: t.name,
        slug: t.slug,
        state: t.state,
        provenance: t.provenance
      })),
      suggested_tags: tags.filter((t) => t.state === 'SUGGESTED').map((t) => t.name),
      versions: versions.map((v) => ({
        version_id: v.id,
        version_number: v.version_number,
        created_at: v.created_at
      })),
      ...(text ? { text, truncated } : {}),
      ...(!text && includeText
        ? {
            note: 'No text layer is stored for this artifact, so its content cannot be inlined. ' +
              'Binary formats are not inlined; open the canonical URL instead.'
          }
        : {})
    }
  }
}

// ---------------------------------------------------------------
// save
// ---------------------------------------------------------------

function decodeBytes(args: Record<string, unknown>): Uint8Array | null {
  if (typeof args.content_base64 === 'string' && args.content_base64.trim()) {
    try {
      const binary = atob(args.content_base64.replace(/\s+/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    } catch {
      return null
    }
  }
  return null
}

async function toolSave(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  const workspace = await resolveSingleWorkspace(db, principal, args.workspace)
  if (!workspace) return { text: 'No writable workspace is available.', isError: true }
  if (!can(principal, 'artifact.create', workspace)) {
    return { text: 'You do not have permission to create artifacts in that workspace.', isError: true }
  }

  const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
  const rawContent = typeof args.content === 'string' ? args.content : null
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null
  const fileArg = typeof args.file === 'string' ? args.file.trim() : ''

  let bytes: Uint8Array | null = null
  let filename = fileArg
  let mimeType: string | undefined

  // Either a binary the provider produced, or text Artifactry converts.
  if (fileArg && !format) {
    bytes = decodeBytes(args)
    if (!bytes) {
      return {
        text:
          'Provide content_base64 with file for a binary upload, or content with format to have ' +
          'Artifactry convert structured text.',
        isError: true
      }
    }
  } else {
    if (!format) {
      return { text: 'Provide either file (+ content_base64) or content (+ format).', isError: true }
    }
    if (rawContent === null) {
      return { text: 'Provide content to convert.', isError: true }
    }
    try {
      const converted = convertContent(format, title ?? 'Untitled', rawContent)
      bytes = converted.bytes
      filename = converted.filename
      mimeType = converted.mimeType
    } catch (err) {
      if (err instanceof ConversionUnsupported) return { text: err.message, isError: true }
      throw err
    }
  }

  const result = await createArtifact(
    env,
    {
      workspaceId: workspace.id,
      organizationId: workspace.organization_id,
      ownerUserId: principal.userId!,
      title: normalizeTitle(title ?? undefined, filename),
      description: (args.description as string | undefined) ?? null,
      filename,
      mimeType,
      bytes,
      sourceType: 'API',
      sourceProvider: principal.provider ?? 'API',
      metadata: {
        aiProvenance: {
          provider: principal.provider ?? 'API',
          clientName: principal.clientName ?? null,
          integrationId: principal.integrationId ?? null,
          createdByUser: principal.userId,
          sourceConversationReference: args.source_conversation_reference ?? null
        }
      },
      createdBy: principal.userId!
    },
    origin
  )

  const artifact = await loadArtifact(db, result.artifactId)
  if (!artifact) {
    return { text: 'Artifact was created but could not be read back.', structured: { artifact_id: result.artifactId } }
  }

  // Explicitly supplied tags are a user-facing decision, so they are confirmed.
  const appliedTags: string[] = []
  if (Array.isArray(args.tags)) {
    for (const raw of args.tags as unknown[]) {
      const applied = await addTagToArtifact(
        db,
        principal,
        artifact.id,
        String(raw),
        artifact.organization_id
      ).catch(() => null)
      if (applied) appliedTags.push(applied.name)
    }
  }

  // Auto-tagging runs as part of the save pipeline, producing SUGGESTED only.
  const suggestions = await generateSuggestionsFor(env, artifact.id)

  const collectionNote = await attachToCollection(db, principal, artifact, args.collection, workspace.id)

  const tagViews = await artifactTagViews(db, artifact.id)
  const indexing = await indexingStateFor(db, artifact.id)

  return {
    text:
      `Saved "${artifact.title}" to ${workspace.name}. ${result.canonicalUrl}` +
      (suggestions.proposed.length
        ? `\nProposed tags (not yet applied): ${suggestions.proposed.join(', ')}. ` +
          `Ask the user which to keep, then call update_tags.`
        : '') +
      (collectionNote ? `\n${collectionNote}` : ''),
    structured: {
      artifact_id: artifact.id,
      title: artifact.title,
      canonical_url: result.canonicalUrl,
      workspace: { id: workspace.id, name: workspace.name },
      status: result.status,
      detail: result.detail,
      indexing,
      applied_tags: tagViews.filter((t) => t.state === 'CONFIRMED').map((t) => t.name),
      proposed_tags: suggestions.proposed,
      tag_note: suggestions.note,
      collection: collectionNote ? args.collection : null
    }
  }
}

async function generateSuggestionsFor(
  env: Env,
  artifactId: string
): Promise<{ proposed: string[]; note: string }> {
  const db = env.DB
  const artifact = await first<{
    title: string
    description: string | null
    extension: string | null
    current_version_id: string | null
    workspace_id: string
  }>(
    db,
    `SELECT title, description, extension, current_version_id, workspace_id FROM artifacts WHERE id = ?`,
    [artifactId]
  )
  if (!artifact) return { proposed: [], note: 'Artifact not found.' }

  const workspace = await first<{ name: string }>(db, `SELECT name FROM workspaces WHERE id = ?`, [
    artifact.workspace_id
  ])

  let text: string | null = null
  if (artifact.current_version_id) {
    const version = await first<{ extracted_text: string | null }>(
      db,
      `SELECT extracted_text FROM artifact_versions WHERE id = ?`,
      [artifact.current_version_id]
    )
    text = version?.extracted_text ?? null
  }

  const outcome = await suggestTags(env, {
    title: artifact.title,
    description: artifact.description,
    extension: artifact.extension,
    workspaceName: workspace?.name ?? null,
    text
  })

  const { kept } = filterSuggestions(outcome.suggestions.map((s) => s.name))
  if (!kept.length) return { proposed: [], note: outcome.note }

  const proposed: string[] = []
  for (const name of kept.slice(0, MAX_TAGS)) {
    const resolved = await resolveOrCreateTag(db, { userId: null } as Principal, name, {
      organizationId: null,
      provenance: 'AI'
    }).catch(() => null)
    if (!resolved) continue

    // Respect an earlier rejection unless the content changed.
    const existing = await first<{ state: string; source_version_id: string | null }>(
      db,
      `SELECT state, source_version_id FROM artifact_tags WHERE artifact_id = ? AND tag_id = ?`,
      [artifactId, resolved.tag.id]
    )
    if (existing?.state === 'CONFIRMED') continue
    if (
      existing?.state === 'REJECTED' &&
      existing.source_version_id === artifact.current_version_id
    ) {
      continue // the user declined this for exactly this content
    }

    await runUpsertSuggestion(db, artifactId, resolved.tag.id, artifact.current_version_id)
    proposed.push(resolved.tag.name)
  }

  return { proposed, note: outcome.note }
}

async function runUpsertSuggestion(
  db: D1Database,
  artifactId: string,
  tagId: string,
  versionId: string | null
): Promise<void> {
  const { applySuggestions } = await import('./tags')
  // applySuggestions re-checks suggestionAllowed(), so the rejection memory is
  // enforced in one place rather than duplicated here.
  await applySuggestions(db, artifactId, [{ tagId, name: '' }], versionId)
}

async function indexingStateFor(
  db: D1Database,
  artifactId: string
): Promise<{ state: string; note: string; extraction: string | null; semantic: string }> {
  const jobs = await all<{ job_type: string; status: string; last_error: string | null }>(
    db,
    `SELECT job_type, status, last_error FROM processing_jobs WHERE artifact_id = ?`,
    [artifactId]
  )
  const byType = new Map(jobs.map((j) => [j.job_type, j]))

  const extract = byType.get('EXTRACT')
  const embed = byType.get('EMBED')

  const semantic =
    embed?.status === 'INDEXED' || embed?.status === 'DONE'
      ? 'indexed'
      : embed?.status === 'PARTIAL'
        ? 'partial'
        : embed
          ? 'not indexed'
          : 'unknown'

  return {
    state: extract?.status ?? 'PENDING',
    note: extract?.status === 'DONE'
      ? 'Text extracted and searchable.'
      : extract?.status === 'PARTIAL'
        ? 'Parsed, but no usable text layer was recovered (e.g. a scanned document). Title, filename and tags remain searchable.'
        : extract?.status === 'SKIPPED'
          ? 'No text extractor exists for this format; metadata remains searchable.'
          : 'Extraction has not completed.',
    extraction: extract?.status ?? null,
    semantic
  }
}

async function attachToCollection(
  db: D1Database,
  principal: Principal,
  artifact: ArtifactRow,
  collectionArg: unknown,
  workspaceId: string
): Promise<string | null> {
  if (typeof collectionArg !== 'string' || !collectionArg.trim()) return null
  if (!can(principal, 'collection.manage', {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  })) {
    return 'Not added to a collection: you lack collection.manage in that workspace.'
  }

  const needle = collectionArg.trim()
  const collection = await first<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM collections
      WHERE workspace_id = ? AND archived_at IS NULL AND (id = ? OR lower(name) = lower(?))
      LIMIT 1`,
    [workspaceId, needle, needle]
  )
  if (!collection) {
    return `No collection named "${needle}" exists in that workspace, so none was used. Create it in the app first.`
  }

  const { prefixed, ulid } = await import('./ids')
  await db
    .prepare(
      `INSERT OR IGNORE INTO collection_artifacts (id, collection_id, artifact_id, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(prefixed('ca', ulid()), collection.id, artifact.id, principal.userId, nowIso())
    .run()

  return `Added to collection "${collection.name}".`
}

// ---------------------------------------------------------------
// create_version
// ---------------------------------------------------------------

async function toolCreateVersion(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'artifact.version.create')

  const bytes = decodeBytes(args)
  const rawContent = typeof args.content === 'string' ? args.content : null
  const ext = artifact.extension?.toLowerCase() ?? ''

  if (!bytes && rawContent === null) {
    return { text: 'Provide content_base64 or content.', isError: true }
  }

  let payload = bytes
  let filename = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : artifact.filename ?? 'version'

  // Text content is only writable in the format the artifact already is when
  // that format is text-based; otherwise the caller must send real bytes, since
  // silently re-encoding would misrepresent what was stored.
  if (!payload && rawContent !== null) {
    if (ext === 'html') {
      payload = new TextEncoder().encode(rawContent)
    } else {
      return {
        text:
          `This artifact is a .${ext} file, so new content must be sent as bytes with content_base64. ` +
          `Raw text can only be versioned into an HTML artifact.`,
        isError: true
      }
    }
  }

  const result = await createVersion(env, {
    artifactId: artifact.id,
    bytes: payload as Uint8Array,
    filename,
    sourceType: 'API',
    sourceProvider: principal.provider ?? 'API',
    changeSummary: (args.change_summary as string | undefined) ?? null,
    createdBy: principal.userId!
  })

  const suggestions = await generateSuggestionsFor(env, artifact.id)

  return {
    text:
      `Added version ${result.versionNumber} to "${artifact.title}" (${result.status}).` +
      (suggestions.proposed.length
        ? `\nNew content produced new tag suggestions: ${suggestions.proposed.join(', ')}.`
        : ''),
    structured: {
      artifact_id: artifact.id,
      version_id: result.versionId,
      version_number: result.versionNumber,
      status: result.status,
      canonical_url: `${originOf(args) ?? ''}/a/${artifact.id}`,
      proposed_tags: suggestions.proposed,
      indexing: await indexingStateFor(db, artifact.id)
    }
  }
}

// ---------------------------------------------------------------
// share — the confirmation gate lives here
// ---------------------------------------------------------------

interface AudiencePlan {
  accessType: 'PUBLIC_LINK' | 'EMAIL' | 'DOMAIN'
  recipients: Array<{ type: 'EMAIL' | 'DOMAIN'; value: string }>
  teamIds: string[]
  description: string
  requiresConfirmation: boolean
  reason: string
}

async function planAudience(
  env: Env,
  principal: Principal,
  artifact: ArtifactRow,
  args: Record<string, unknown>
): Promise<AudiencePlan> {
  const db = env.DB

  if (args.public === true || args.public_link === true) {
    return {
      accessType: 'PUBLIC_LINK',
      recipients: [],
      teamIds: [],
      description: 'anyone with the link',
      requiresConfirmation: true,
      reason:
        'A public link removes the recipient gate entirely: it can be opened by anyone who obtains the URL, ' +
        'including people outside your organization.'
    }
  }

  if (typeof args.team === 'string' && args.team.trim()) {
    const teamId = typeof args.team_id === 'string' ? args.team_id.trim() : ''
    const resolution = teamId
      ? await resolveTeamByName(db, principal, teamId)
      : await resolveTeamByName(db, principal, args.team)

    if (resolution.status === 'NOT_FOUND') {
      return planFailure(
        `No team named "${args.team}" is available to you. Use list_teams to see the audiences you can share with.`
      )
    }
    if (resolution.status === 'AMBIGUOUS') {
      return planFailure(
        `More than one team matches "${args.team}". Ask the user which one, then call share again with ` +
          `team set to the chosen name and team_id set to its id. Candidates: ` +
          resolution.candidates
            .map((c) => `${c.name} (team_id ${c.team_id}, org ${c.organization_id}${c.workspace_id ? `, workspace ${c.workspace_id}` : ''})`)
            .join('; '),
        resolution.candidates
      )
    }

    const team = resolution.team
    await assertTeamUsableForArtifact(db, principal, team, artifact)
    const members = await activeMemberEmails(db, team.id)

    return {
      accessType: 'EMAIL',
      recipients: members.map((value) => ({ type: 'EMAIL' as const, value })),
      teamIds: [team.id],
      description: `team "${team.name}" (${members.length} member${members.length === 1 ? '' : 's'})`,
      // Inside the same organization this does not broaden past the tenant, so
      // it proceeds without an extra prompt.
      requiresConfirmation: false,
      reason: 'Internal audience within the same organization.'
    }
  }

  if (typeof args.workspace === 'string' && args.workspace.trim()) {
    const workspace = await resolveSingleWorkspace(db, principal, args.workspace)
    if (!workspace) return planFailure(`No workspace you can access matches "${args.workspace}".`)
    if (workspace.organization_id !== artifact.organization_id) {
      return planFailure(
        'That workspace belongs to a different organization than this artifact, so it cannot be used as an audience.'
      )
    }
    const emails = await workspaceMemberEmails(db, workspace.id)
    if (!emails.length) return planFailure(`"${workspace.name}" has no members to share with.`)

    return {
      accessType: 'EMAIL',
      recipients: emails.map((value) => ({ type: 'EMAIL' as const, value })),
      teamIds: [],
      description: `workspace "${workspace.name}" (${emails.length} member${emails.length === 1 ? '' : 's'})`,
      requiresConfirmation: false,
      reason: 'Internal audience within the same organization.'
    }
  }

  const emails = Array.isArray(args.emails)
    ? (args.emails as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : typeof args.emails === 'string' && args.emails.trim()
      ? [args.emails.trim()]
      : []

  if (emails.length) {
    return {
      accessType: 'EMAIL',
      recipients: emails.map((value) => ({ type: 'EMAIL' as const, value })),
      teamIds: [],
      description: emails.join(', '),
      requiresConfirmation: true,
      reason:
        'Sharing to specific addresses can send this outside your organization. Each recipient must also ' +
        'verify control of their address before the artifact is shown.'
    }
  }

  if (typeof args.domain === 'string' && args.domain.trim()) {
    const value = args.domain.trim().replace(/^@/, '')
    return {
      accessType: 'DOMAIN',
      recipients: [{ type: 'DOMAIN', value }],
      teamIds: [],
      description: `anyone with an @${value} address`,
      requiresConfirmation: true,
      reason:
        'A domain share grants access to every verified address at that domain, which is wider than naming ' +
        'individual recipients.'
    }
  }

  return planFailure(
    'Specify an audience: team, workspace, emails, domain, or public: true.'
  )
}

function planFailure(message: string, candidates?: unknown): never {
  const error = new Error(message) as Error & { candidates?: unknown }
  error.candidates = candidates
  throw error
}

async function toolShare(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB

  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'share.create')

  const plan = await planAudience(env, principal, artifact, args)

  const permission = args.permission === 'download' ? 'download' : 'view'
  const allowDownload = permission === 'download'
  const days = Number(args.expires_in_days ?? 0)
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null

  // The confirmation is keyed on the normalised *request*, so a model cannot
  // obtain consent for one audience and then execute a different one.
  const requestParams = {
    artifact_id: artifact.id,
    access_type: plan.accessType,
    audience: plan.description,
    recipients: plan.recipients,
    team_ids: plan.teamIds,
    permission,
    expires_in_days: days > 0 ? days : null
  }

  if (plan.requiresConfirmation) {
    const confirmationId = typeof args.confirmation_id === 'string' ? args.confirmation_id.trim() : ''

    if (!confirmationId) {
      const row = await createConfirmation(db, principal, {
        tool: 'share',
        params: requestParams,
        summary:
          `Share "${artifact.title}" with ${plan.description}` +
          `${expiresAt ? ` for ${days} day(s)` : ''}, ${permission} only.`,
        audienceNote: plan.reason
      })
      return {
        text:
          `This share needs the user's explicit confirmation before it is created.\n\n` +
          `Action: share "${artifact.title}" with ${plan.description}` +
          `${expiresAt ? `, expiring in ${days} day(s)` : ''}, ${permission} permission.\n` +
          `Why: ${plan.reason}\n\n` +
          `Nothing has been shared yet. Ask the user to confirm, then call share again with the same ` +
          `arguments plus confirmation_id="${row.id}".`,
        structured: confirmationPrompt(row)
      }
    }

    const consumed = await consumeConfirmation(db, principal, confirmationId, 'share', requestParams)
    if (!consumed.ok) {
      return {
        text: CONFIRM_MESSAGES[consumed.reason] ?? 'That confirmation could not be used.',
        isError: true,
        structured: { confirmation_error: consumed.reason }
      }
    }
  }

  const created = await createShare(
    db,
    principal,
    {
      targetType: 'ARTIFACT',
      targetId: artifact.id,
      accessType: plan.accessType,
      allowView: true,
      allowDownload,
      includeNewItems: true,
      expiresAt,
      recipients: plan.recipients,
      teamIds: plan.teamIds,
      title: artifact.title,
      note: `Shared via AI connection (${principal.provider ?? 'API'})`
    },
    origin
  )

  const audienceParts: string[] = [plan.description]
  if (plan.recipients.length) {
    audienceParts.push(
      plan.recipients.map((r) => r.value).join(', ')
    )
  }

  return {
    text:
      `Shared "${artifact.title}" with ${plan.description}.\n` +
      `Share URL: ${created.url}\n` +
      `Permission: ${permission}${allowDownload ? ' (recipients can download)' : ' (no download)'}\n` +
      `Expiry: ${expiresAt ?? 'no expiry'}`,
    structured: {
      share_id: created.share.id,
      share_url: created.url,
      artifact_id: artifact.id,
      canonical_url: `${origin}/a/${artifact.id}`,
      audience: audienceParts,
      audience_type: plan.accessType,
      teams: plan.teamIds,
      recipient_count: plan.recipients.filter((r) => r.type === 'EMAIL').length,
      permission,
      allow_download: allowDownload,
      expires_at: expiresAt,
      verified_recipients_note:
        plan.accessType === 'PUBLIC_LINK'
          ? 'Anyone with the URL can open this.'
          : 'Recipients must verify control of their email address before the artifact is shown.'
    }
  }
}

async function toolRevokeShare(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  let shareId = typeof args.share_id === 'string' ? args.share_id.trim() : ''

  if (!shareId && typeof args.share_url === 'string') {
    const match = /\/s\/([A-Za-z0-9_-]+)/.exec(args.share_url)
    if (!match) return { text: 'That does not look like a share URL.', isError: true }
    const { hashShareToken } = await import('./crypto')
    const row = await first<{ id: string }>(db, `SELECT id FROM shares WHERE token_hash = ?`, [
      await hashShareToken(match[1])
    ])
    if (!row) return { text: 'No share matches that URL.', isError: true }
    shareId = row.id
  }

  if (!shareId) return { text: 'Provide share_id or share_url.', isError: true }

  const share = await first<{ id: string; created_by_user_id: string; target_id: string }>(
    db,
    `SELECT id, created_by_user_id, target_id FROM shares WHERE id = ?`,
    [shareId]
  )
  if (!share) return { text: 'Share not found.', isError: true }
  if (share.created_by_user_id !== principal.userId) {
    return { text: 'Only the person who created a share can revoke it.', isError: true }
  }

  await revokeShare(db, share.id)
  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'SHARE_REVOKE',
    targetType: 'share',
    targetId: share.id,
    metadata: { operation: 'revoke_share' }
  })

  return {
    text: 'Share revoked. The link no longer grants access.',
    structured: { share_id: share.id, revoked: true }
  }
}

// ---------------------------------------------------------------
// listings
// ---------------------------------------------------------------

async function toolListWorkspaces(env: Env, principal: Principal): Promise<ToolOutcome> {
  const workspaces = await readableWorkspaces(env.DB, principal)
  const payload = workspaces.map((w) => ({
    workspace_id: w.id,
    name: w.name,
    type: w.workspace_type,
    organization_id: w.organization_id,
    role: effectiveWorkspaceRole(principal, w),
    can_create: can(principal, 'artifact.create', w)
  }))

  return {
    text: payload.map((w) => `- ${w.name} (${w.type}, role: ${w.role})`).join('\n') || 'No workspaces.',
    structured: { workspaces: payload }
  }
}

async function toolListTeams(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  let workspaceId: string | undefined
  if (typeof args.workspace === 'string' && args.workspace.trim()) {
    const resolved = await resolveWorkspaceScope(db, principal, args.workspace)
    workspaceId = resolved[0]
  }

  const { listTeams } = await import('./teams')
  const teams = await listTeams(db, principal, { workspaceId })

  return {
    text:
      teams.map((t) => `- ${t.name} (${t.member_count} member(s), ${t.scope})`).join('\n') ||
      'No teams are available. Teams are created in the Artifactry app.',
    structured: { teams: teams.map((t) => teamSummary(t, principal)) }
  }
}

async function toolListTags(env: Env, principal: Principal): Promise<ToolOutcome> {
  const db = env.DB
  const orgIds = Object.keys(principal.orgRoles)
  const orgClause = orgIds.length
    ? `OR (t.scope = 'ORGANIZATION' AND t.organization_id IN (${orgIds.map(() => '?').join(',')}))`
    : ''

  const rows = await all<{ name: string; slug: string; scope: string; usage_count: number }>(
    db,
    `SELECT t.name, t.slug, t.scope,
            (SELECT COUNT(*) FROM artifact_tags at WHERE at.tag_id = t.id AND at.state = 'CONFIRMED') AS usage_count
       FROM tags t
      WHERE (t.scope = 'PERSONAL' ${orgClause}) AND t.status = 'ACTIVE'
      ORDER BY t.name ASC`,
    orgIds
  )

  return {
    text: rows.map((t) => `- ${t.name} (${t.usage_count} artifact(s))`).join('\n') || 'No tags yet.',
    structured: {
      tags: rows.map((t) => ({ name: t.name, slug: t.slug, scope: t.scope, usage_count: t.usage_count })),
      note: 'Only confirmed tags are counted. Suggested tags are shown per artifact via get.'
    }
  }
}

// ---------------------------------------------------------------
// update_tags
// ---------------------------------------------------------------

async function toolUpdateTags(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const db = env.DB
  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'artifact.tag.apply')

  const list = (value: unknown): string[] =>
    Array.isArray(value) ? (value as unknown[]).map(String).filter((s) => s.trim()) : []

  const accept = list(args.accept)
  const reject = list(args.reject)
  const add = list(args.add)
  const remove = list(args.remove)

  if (!accept.length && !reject.length && !add.length && !remove.length) {
    return {
      text: 'Provide at least one of accept, reject, add or remove.',
      isError: true
    }
  }

  /**
   * The decision itself belongs to the shared tag service.
   *
   * REST and MCP calling the same function is the entire point: a second copy of
   * these rules drifts, and the copy that drifts becomes a hole — one surface
   * would refuse a case-duplicate that the other happily created. This tool now
   * differs from the REST endpoint only in how it reports the outcome, never in
   * what it accepts or what it writes.
   */
  let decision: TagDecisionResult
  try {
    decision = await applyTagDecisions(db, principal, artifact, {
      accept,
      reject,
      add,
      remove
    })
  } catch (err) {
    // Service-level refusals — a sensitive manual tag, or a pending suggestion
    // passed to `remove` — are the model's error to see and correct, so they are
    // returned as a tool result instead of ending the session on the transport.
    return { text: err instanceof Error ? err.message : 'Tag update failed', isError: true }
  }

  await recordAudit(db, {
    organizationId: artifact.organization_id,
    workspaceId: artifact.workspace_id,
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'TAG_UPDATE',
    targetType: 'artifact',
    targetId: artifact.id,
    metadata: { operation: 'update_tags', ...decision }
  })

  const parts: string[] = []
  if (decision.accepted.length) parts.push(`accepted: ${decision.accepted.join(', ')}`)
  if (decision.added.length) parts.push(`added: ${decision.added.join(', ')}`)
  if (decision.rejected.length) parts.push(`rejected: ${decision.rejected.join(', ')}`)
  if (decision.removed.length) parts.push(`removed: ${decision.removed.join(', ')}`)
  if (decision.not_found.length) parts.push(`not found: ${decision.not_found.join(', ')}`)

  return {
    text: parts.length ? `Tags updated — ${parts.join('; ')}.` : 'No tags changed.',
    structured: {
      artifact_id: artifact.id,
      accepted: decision.accepted,
      rejected: decision.rejected,
      added: decision.added,
      removed: decision.removed,
      not_found: decision.not_found,
      confirmed_tags: decision.confirmed,
      suggested_tags: decision.suggested,
      rejected_tags: decision.rejectedTags,
      note: 'A rejected tag will not be suggested again for this content.'
    }
  }
}

function slugOf(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

// ---------------------------------------------------------------
// Resolution + authorization helpers
// ---------------------------------------------------------------

function originOf(args: Record<string, unknown>): string | null {
  const url = typeof args.artifact_url === 'string' ? args.artifact_url : typeof args.artifact === 'string' ? args.artifact : ''
  const match = /^https?:\/\/[^/]+/.exec(url)
  return match ? match[0] : null
}

/**
 * Resolve an artifact from either an id or a canonical URL.
 *
 * A URL is reduced to its artifact id and then loaded through the same path as
 * an id, so a URL grants nothing that an id would not.
 */
async function loadArtifactByRef(
  db: D1Database,
  ref: unknown,
  _origin: string | null
): Promise<ArtifactRow | null> {
  const raw = String(ref ?? '').trim()
  if (!raw) return null

  let id = raw
  if (/^https?:\/\//i.test(raw)) {
    const match = /\/a\/([A-Za-z0-9_-]+)/.exec(raw)
    if (!match) return null
    id = match[1]
  }
  return loadArtifact(db, id)
}

/** ACL-bounded workspace ids. A caller may narrow scope but never widen it. */
async function resolveWorkspaceScope(
  db: D1Database,
  principal: Principal,
  workspace: unknown
): Promise<string[]> {
  const readable = await readableWorkspaces(db, principal)
  if (typeof workspace !== 'string' || !workspace.trim()) return readable.map((w) => w.id)

  const needle = workspace.trim().toLowerCase()
  return readable
    .filter((w) => w.id === workspace || w.name.toLowerCase() === needle)
    .map((w) => w.id)
}

async function resolveSingleWorkspace(
  db: D1Database,
  principal: Principal,
  workspace: unknown
): Promise<{ id: string; name: string; organization_id: string | null; owner_user_id: string } | null> {
  const readable = await readableWorkspaces(db, principal)
  if (!readable.length) return null

  if (typeof workspace === 'string' && workspace.trim()) {
    const needle = workspace.trim().toLowerCase()
    return readable.find((w) => w.id === workspace || w.name.toLowerCase() === needle) ?? null
  }

  const writable = readable.filter((w) => can(principal, 'artifact.create', w))
  const personal = writable.find((w) => w.workspace_type === 'PERSONAL')
  return personal ?? writable[0] ?? null
}

/** Tags arrive as names or slugs; resolve to slugs the filter understands. */
async function resolveTagFilters(db: D1Database, tags: unknown): Promise<string[] | undefined> {
  if (!Array.isArray(tags) || !tags.length) return undefined
  const requested = (tags as unknown[]).map(String).map(slugOf).filter(Boolean)
  if (!requested.length) return undefined
  // Pass through as slugs: the query compares t.slug, and a tag that does not
  // exist simply matches nothing rather than being silently ignored.
  return requested
}

async function resolveCollectionFilters(
  db: D1Database,
  principal: Principal,
  collection: unknown,
  workspaceIds: string[]
): Promise<string[] | undefined> {
  if (typeof collection !== 'string' || !collection.trim()) return undefined
  const needle = collection.trim()

  const rows = await all<{ id: string }>(
    db,
    `SELECT id FROM collections
      WHERE archived_at IS NULL
        AND workspace_id IN (${workspaceIds.map(() => '?').join(',')})
        AND (id = ? OR lower(name) = lower(?))`,
    [...workspaceIds, needle, needle]
  )
  // No match yields an explicit empty-but-present filter, which returns nothing
  // rather than everything — a filter that silently does nothing is worse than
  // no results.
  return rows.length ? rows.map((r) => r.id) : ['__none__']
}

async function resolveOwnerFilter(db: D1Database, owner: unknown): Promise<string[] | undefined> {
  if (typeof owner !== 'string' || !owner.trim()) return undefined
  const value = owner.trim()
  if (value.startsWith('usr_')) return [value]

  const { normalizeEmail } = await import('./validate')
  const row = await first<{ id: string }>(db, `SELECT id FROM users WHERE email_normalized = ?`, [
    normalizeEmail(value)
  ])
  return row ? [row.id] : ['__none__']
}

async function workspaceMemberEmails(db: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await all<{ email_normalized: string }>(
    db,
    `SELECT DISTINCT u.email_normalized
       FROM workspaces w
       JOIN users u ON (
            u.id = w.owner_user_id
         OR u.id IN (SELECT user_id FROM workspace_members
                      WHERE workspace_id = w.id AND status = 'ACTIVE')
         OR (w.organization_id IS NOT NULL AND u.id IN (
               SELECT user_id FROM organization_members
                WHERE organization_id = w.organization_id AND status = 'ACTIVE'))
       )
      WHERE w.id = ? AND u.status = 'ACTIVE'`,
    [workspaceId]
  )
  return rows.map((r) => r.email_normalized)
}

type Permission =
  | 'artifact.read'
  | 'artifact.update'
  | 'artifact.version.create'
  | 'artifact.tag.apply'
  | 'collection.manage'
  | 'share.create'

/** Re-derive authorization from the principal; never trust the arguments. */
async function assertCan(
  principal: Principal,
  artifact: ArtifactRow,
  permission: Permission
): Promise<void> {
  const ref = {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  }
  if (artifact.owner_user_id === principal.userId) return
  if (can(principal, permission, ref)) return
  throw forbidden(`You do not have permission to ${permission} this artifact`)
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString()
}

export { badRequest, notFound, MIN_TAGS, MAX_TAGS, confirmedTagNames, assignTags, findTagBySlug }
