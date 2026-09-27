/**
 * Remote MCP layer — PRD §51, §53, §54.
 *
 * Exposes the Universal Artifact API as MCP tools so ChatGPT, Claude, Gemini
 * and future agents can search, retrieve, create and share artifacts on a
 * user's behalf.
 *
 * Transport: JSON-RPC 2.0 over HTTP (the "streamable HTTP" MCP transport).
 * Every tool call resolves a Principal from the caller's Bearer grant, so an
 * AI application is never able to exceed the authority of the user who
 * connected it (§59).
 */

import type { Env, Principal } from '../types'
import { AI_SCOPES, type AiScope } from '../types'
import {
  createArtifact,
  createVersion,
  listVersions,
  loadArtifact,
  normalizeTitle,
  assignTags
} from './artifacts'
import { searchArtifacts, resolveSemanticProvider } from './search'
import { createShare, listShares, revokeShare } from './sharing'
import { artifactTotals, recentActivity, sourceBreakdown, actorDisplay } from './analytics'
import { all, first, nowIso } from './db'
import { forbidden, notFound } from './http'
import { recordAudit } from './audit'
import { convertContent, ConversionUnsupported } from './convert'
import { readableWorkspaces, can, effectiveWorkspaceRole } from './principal'
import { recordEvent } from './analytics'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** OAuth scope required to invoke the tool (§58). */
  requiredScope: AiScope
}

/**
 * Tool catalogue. Declared in full even where a provider cannot yet call a
 * tool, so capability and provider UI remain decoupled (§52).
 */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'search_artifacts',
    description:
      'Search the user\'s artifact library. Returns artifact ids, titles, types, tags and canonical URLs. Only artifacts the user is authorized to see are ever returned.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query' },
        workspace: { type: 'string', description: 'Workspace name or id to narrow the search' },
        type: { type: 'string', description: 'File extension filter, e.g. pptx, pdf, png' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag slugs to require' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_artifacts',
    description: 'List artifacts in the library, newest first, with optional filters.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        type: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'get_artifact',
    description: 'Get one artifact by id, including tags, workspace and current version.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id']
    }
  },
  {
    name: 'get_artifact_metadata',
    description: 'Get metadata for an artifact: version history, size, checksum, provenance.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id']
    }
  },
  {
    name: 'get_artifact_content',
    description:
      'Retrieve the text content of an artifact for use as model context. Text is available for HTML artifacts; binary Office/PDF formats return metadata and a short-lived download URL instead.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id']
    }
  },
  {
    name: 'create_artifact',
    description:
      'Save a file the AI has already generated into the library. Provide the binary as base64 for binary formats, or raw text for HTML.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        filename: { type: 'string', description: 'Must use a supported extension' },
        workspace: { type: 'string', description: 'Target workspace name or id' },
        content_base64: { type: 'string', description: 'Base64-encoded file bytes' },
        content_text: { type: 'string', description: 'Raw text, for HTML artifacts' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source_conversation_reference: { type: 'string' }
      },
      required: ['filename']
    }
  },
  {
    name: 'create_artifact_from_content',
    description:
      'Convert conversational content into an artifact. Supported target formats: pdf, html. DOCX/PPTX cannot be generated server-side; send a binary instead.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        format: { type: 'string', enum: ['pdf', 'html'] },
        workspace: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'content', 'format']
    }
  },
  {
    name: 'create_artifact_version',
    description: 'Add a new version to an existing artifact, preserving prior versions.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        filename: { type: 'string' },
        content_base64: { type: 'string' },
        content_text: { type: 'string' },
        change_summary: { type: 'string' }
      },
      required: ['artifact_id', 'filename']
    }
  },
  {
    name: 'update_artifact_metadata',
    description: 'Update an artifact title or description.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['artifact_id']
    }
  },
  {
    name: 'list_tags',
    description: 'List the approved tag taxonomy. Users cannot create new tags.',
    requiredScope: 'tags.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'apply_tags',
    description: 'Apply existing tags to an artifact.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['artifact_id', 'tags']
    }
  },
  {
    name: 'remove_tags',
    description: 'Remove tags from an artifact.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['artifact_id', 'tags']
    }
  },
  {
    name: 'list_workspaces',
    description: 'List workspaces the user can access.',
    requiredScope: 'workspace.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_collections',
    description: 'List collections in the accessible workspaces.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string' } }
    }
  },
  {
    name: 'create_share',
    description:
      'Create a share link for an artifact or collection. Requires the artifact.share scope.',
    requiredScope: 'artifact.share',
    inputSchema: {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['ARTIFACT', 'COLLECTION'] },
        target_id: { type: 'string' },
        access_type: { type: 'string', enum: ['PUBLIC_LINK', 'EMAIL', 'DOMAIN'] },
        recipients: { type: 'array', items: { type: 'string' } },
        allow_download: { type: 'boolean' },
        expires_in_days: { type: 'number' }
      },
      required: ['target_type', 'target_id', 'access_type']
    }
  },
  {
    name: 'revoke_share',
    description: 'Revoke an existing share so its link stops working immediately.',
    requiredScope: 'artifact.share',
    inputSchema: {
      type: 'object',
      properties: { share_id: { type: 'string' } },
      required: ['share_id']
    }
  },
  {
    name: 'get_artifact_analytics',
    description:
      'Get usage analytics for an artifact: views, unique viewers, downloads and AI references. Obeys owner/admin permissions.',
    requiredScope: 'artifact.analytics.read',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        period: { type: 'string', enum: ['7d', '30d', '90d', 'all'] }
      },
      required: ['artifact_id']
    }
  }
]

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

function toolByName(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name)
}

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
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'artifact-library',
              version: '1.0.0',
              title: 'Artifact Library'
            },
            instructions:
              'Persistent artifact library for the signed-in user. Use search_artifacts to find ' +
              'artifacts, get_artifact_content to load them as context, and create_artifact or ' +
              'create_artifact_from_content to save new output. Only artifacts the user may ' +
              'access are ever returned.'
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

        const tool = toolByName(name)
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${name}` }
          }
        }

        assertScope(principal, tool)

        const result = await callTool(env, principal, name, args, origin)
        return { jsonrpc: '2.0', id, result }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unsupported method: ${request.method}` }
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected MCP error'
    // Tool-level failures are returned as MCP error results, not thrown, so a
    // provider can surface them to the model rather than failing the session.
    return { jsonrpc: '2.0', id, error: { code: -32000, message } }
  }
}

function textResult(text: string, structured?: unknown) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
    isError: false
  }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/**
 * Execute a tool. Every branch re-derives authorization from the principal;
 * none of them trust identifiers supplied in the arguments (§64).
 */
async function callTool(
  env: Env,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
  origin: string
): Promise<unknown> {
  const db = env.DB

  switch (name) {
    case 'search_artifacts':
    case 'list_artifacts': {
      const query = typeof args.query === 'string' ? args.query : ''
      const limit = Math.min(Number(args.limit ?? 10) || 10, 50)

      const workspaceIds = await resolveWorkspaceScope(db, principal, args.workspace)
      if (!workspaceIds.length) {
        return textResult('No accessible workspaces match that filter.', { artifacts: [] })
      }

      const tags = Array.isArray(args.tags) ? (args.tags as string[]).map(String) : undefined
      const type = typeof args.type === 'string' ? args.type.replace(/^\./, '') : undefined

      const response = await searchArtifacts(
        db,
        principal,
        {
          query,
          limit,
          workspaceIds,
          types: type ? [type] : undefined,
          tagSlugs: tags
        },
        resolveSemanticProvider(env)
      )

      // Retrieval by an AI application is an analytics event (§57)
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
        })
      }

      if (!response.hits.length) {
        return textResult('No artifacts found.', { artifacts: [] })
      }

      const artifacts = response.hits.map((hit) => ({
        artifact_id: hit.artifact.id,
        title: hit.artifact.title,
        type: hit.artifact.extension,
        size_bytes: hit.artifact.size_bytes,
        updated_at: hit.artifact.updated_at,
        tags: hit.tags,
        workspace: hit.workspaceName,
        canonical_url: `${origin}/a/${hit.artifact.id}`
      }))

      const summary = artifacts
        .map(
          (a) =>
            `- ${a.title} (${a.type ?? 'file'}, ${a.workspace ?? 'workspace'}) — ${a.canonical_url}`
        )
        .join('\n')

      return textResult(`Found ${artifacts.length} artifact(s):\n${summary}`, { artifacts })
    }

    case 'get_artifact': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanRead(db, principal, artifact)

      const tags = await all<{ name: string; slug: string }>(
        db,
        `SELECT t.name, t.slug FROM artifact_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.artifact_id = ?`,
        [artifactId]
      )

      const payload = {
        artifact_id: artifact.id,
        title: artifact.title,
        description: artifact.description,
        filename: artifact.filename,
        extension: artifact.extension,
        mime_type: artifact.mime_type,
        size_bytes: artifact.size_bytes,
        status: artifact.status,
        source_provider: artifact.source_provider,
        version_count: artifact.version_count,
        created_at: artifact.created_at,
        updated_at: artifact.updated_at,
        tags: tags.map((t) => t.name),
        canonical_url: `${origin}/a/${artifact.id}`
      }

      return textResult(`${artifact.title} — ${payload.canonical_url}`, payload)
    }

    case 'get_artifact_metadata': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanRead(db, principal, artifact)

      const versions = await listVersions(db, artifactId)

      return textResult(
        `${artifact.title}: ${versions.length} version(s), ${artifact.size_bytes} bytes.`,
        {
          artifact_id: artifact.id,
          title: artifact.title,
          checksum: artifact.checksum,
          status: artifact.status,
          metadata: safeJson(artifact.metadata_json),
          versions: versions.map((v) => ({
            version_id: v.id,
            version_number: v.version_number,
            filename: v.filename,
            size_bytes: v.size_bytes,
            checksum: v.checksum,
            source_provider: v.source_provider,
            created_at: v.created_at,
            change_summary: v.change_summary
          }))
        }
      )
    }

    case 'get_artifact_content': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanRead(db, principal, artifact)

      if (!artifact.current_version_id) return errorResult('Artifact has no content yet.')

      const version = await first<{ extracted_text: string | null; filename: string }>(
        db,
        `SELECT extracted_text, filename FROM artifact_versions WHERE id = ?`,
        [artifact.current_version_id]
      )

      // Referencing an artifact as model context is the event the analytics
      // screen reports as "AI references" (§44, §57)
      await recordEvent(db, {
        artifactId: artifact.id,
        workspaceId: artifact.workspace_id,
        organizationId: artifact.organization_id,
        eventType: 'artifact_ai_referenced',
        actorType: 'AI',
        actorUserId: principal.userId,
        aiProvider: principal.provider ?? 'API',
        accessChannel: 'AI'
      })

      await recordAudit(db, {
        organizationId: artifact.organization_id,
        workspaceId: artifact.workspace_id,
        actorUserId: principal.userId,
        actorType: 'AI',
        action: 'AI_FETCH',
        targetType: 'artifact',
        targetId: artifact.id,
        metadata: { provider: principal.provider ?? 'API' }
      })

      if (version?.extracted_text) {
        return textResult(version.extracted_text.slice(0, 100_000), {
          artifact_id: artifact.id,
          title: artifact.title,
          text: version.extracted_text.slice(0, 100_000),
          truncated: version.extracted_text.length > 100_000
        })
      }

      // Binary formats cannot be inlined as text; hand back a gated URL.
      return textResult(
        `"${artifact.title}" is a ${artifact.extension?.toUpperCase()} file, so its content cannot be ` +
          `inlined as text. Ask the user to open it, or use the artifact URL: ${origin}/a/${artifact.id}`,
        {
          artifact_id: artifact.id,
          mime_type: artifact.mime_type,
          size_bytes: artifact.size_bytes,
          canonical_url: `${origin}/a/${artifact.id}`,
          note: 'Binary content is not inlined; text extraction is available for HTML artifacts only.'
        }
      )
    }

    case 'create_artifact': {
      const workspace = await resolveSingleWorkspace(db, principal, args.workspace)
      if (!workspace) return errorResult('No writable workspace available.')
      if (!can(principal, 'artifact.create', workspace)) {
        return errorResult('You do not have permission to create artifacts in that workspace.')
      }

      const filename = String(args.filename ?? '')
      if (!filename) return errorResult('filename is required.')

      const bytes = decodeContent(args)
      if (!bytes) return errorResult('Provide content_base64 or content_text.')

      const result = await createArtifact(
        env,
        {
          workspaceId: workspace.id,
          organizationId: workspace.organization_id,
          ownerUserId: principal.userId!,
          title: normalizeTitle(args.title as string | undefined, filename),
          description: (args.description as string | undefined) ?? null,
          filename,
          sourceType: 'API',
          sourceProvider: principal.provider ?? 'API',
          bytes,
          metadata: {
            aiProvenance: {
              provider: principal.provider ?? 'API',
              integrationId: principal.integrationId ?? null,
              createdByUser: principal.userId,
              sourceConversationReference: args.source_conversation_reference ?? null
            }
          },
          createdBy: principal.userId!
        },
        origin
      )

      if (typeof args.tags !== 'undefined') {
        await applyTagSlugs(db, principal, result.artifactId, args.tags)
      }

      return textResult(`Saved "${filename}" to ${workspace.name}. ${result.canonicalUrl}`, {
        artifact_id: result.artifactId,
        status: result.status,
        canonical_url: result.canonicalUrl,
        workspace: workspace.name,
        detail: result.detail
      })
    }

    case 'create_artifact_from_content': {
      const format = String(args.format ?? '').toLowerCase()
      try {
        const title = String(args.title ?? 'Untitled')
        const content = String(args.content ?? '')
        const converted = convertContent(format, title, content)

        const workspace = await resolveSingleWorkspace(db, principal, args.workspace)
        if (!workspace) return errorResult('No writable workspace available.')
        if (!can(principal, 'artifact.create', workspace)) {
          return errorResult('You do not have permission to create artifacts in that workspace.')
        }

        const result = await createArtifact(
          env,
          {
            workspaceId: workspace.id,
            organizationId: workspace.organization_id,
            ownerUserId: principal.userId!,
            title,
            description: null,
            filename: converted.filename,
            mimeType: converted.mimeType,
            bytes: converted.bytes,
            sourceType: 'API',
            sourceProvider: principal.provider ?? 'API',
            metadata: {
              aiProvenance: {
                provider: principal.provider ?? 'API',
                createdByUser: principal.userId,
                convertedFrom: 'structured_content',
                targetFormat: format
              }
            },
            createdBy: principal.userId!
          },
          origin
        )

        if (typeof args.tags !== 'undefined') {
          await applyTagSlugs(db, principal, result.artifactId, args.tags)
        }

        return textResult(
          `Created ${converted.filename} and saved it to ${workspace.name}. ${result.canonicalUrl}`,
          {
            artifact_id: result.artifactId,
            status: result.status,
            canonical_url: result.canonicalUrl,
            format: converted.extension
          }
        )
      } catch (err) {
        if (err instanceof ConversionUnsupported) return errorResult(err.message)
        throw err
      }
    }

    case 'create_artifact_version': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanWrite(db, principal, artifact)

      const bytes = decodeContent(args)
      if (!bytes) return errorResult('Provide content_base64 or content_text.')

      const filename = String(args.filename ?? artifact.filename ?? 'version')
      const result = await createVersion(env, {
        artifactId,
        bytes,
        filename,
        sourceType: 'API',
        sourceProvider: principal.provider ?? 'API',
        changeSummary: (args.change_summary as string | undefined) ?? null,
        createdBy: principal.userId!
      })

      return textResult(
        `Added version ${result.versionNumber} to "${artifact.title}" (${result.status}).`,
        { artifact_id: artifactId, version_id: result.versionId, version_number: result.versionNumber }
      )
    }

    case 'update_artifact_metadata': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanWrite(db, principal, artifact)

      const sets: string[] = []
      const params: unknown[] = []
      if (typeof args.title === 'string' && args.title.trim()) {
        sets.push('title = ?')
        params.push(args.title.trim().slice(0, 200))
      }
      if (typeof args.description === 'string') {
        sets.push('description = ?')
        params.push(args.description)
      }
      if (!sets.length) return errorResult('Provide a title or description to update.')

      sets.push('updated_at = ?')
      params.push(nowIso())
      await db
        .prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...params, artifactId)
        .run()

      return textResult('Metadata updated.', { artifact_id: artifactId })
    }

    case 'list_tags': {
      const tags = await all<{ name: string; slug: string; description: string | null }>(
        db,
        `SELECT name, slug, description FROM tags WHERE status = 'ACTIVE' ORDER BY name ASC`
      )
      return textResult(
        tags.map((t) => `- ${t.name} (${t.slug})`).join('\n') || 'No tags defined.',
        { tags }
      )
    }

    case 'apply_tags':
    case 'remove_tags': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')
      await assertCanWrite(db, principal, artifact)

      const slugs = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : []
      if (!slugs.length) return errorResult('Provide at least one tag.')

      const current = await all<{ id: string; slug: string }>(
        db,
        `SELECT t.id, t.slug FROM artifact_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.artifact_id = ?`,
        [artifactId]
      )

      const target = new Set(current.map((t) => t.slug))
      for (const slug of slugs) {
        if (name === 'apply_tags') target.add(slug)
        else target.delete(slug)
      }

      const resolved = await all<{ id: string; slug: string }>(
        db,
        `SELECT id, slug FROM tags WHERE status = 'ACTIVE'`,
        []
      )
      const known = new Set(resolved.map((t) => t.slug))
      const unknown = [...target].filter((s) => !known.has(s))
      if (unknown.length) {
        return errorResult(
          `Unknown tag(s): ${unknown.join(', ')}. Tags are admin-governed — use list_tags to see the approved taxonomy.`
        )
      }

      const tagIds = resolved.filter((t) => target.has(t.slug)).map((t) => t.id)
      const outcome = await assignTags(db, artifactId, tagIds, principal.userId!)

      return textResult(
        `${name === 'apply_tags' ? 'Applied' : 'Removed'} tags. Now on "${artifact.title}": ${
          [...target].join(', ') || 'none'
        }.`,
        { artifact_id: artifactId, tags: [...target], added: outcome.added, removed: outcome.removed }
      )
    }

    case 'list_workspaces': {
      const workspaces = await readableWorkspaces(db, principal)
      const payload = workspaces.map((w) => ({
        workspace_id: w.id,
        name: w.name,
        type: w.workspace_type,
        organization_id: w.organization_id,
        role: effectiveWorkspaceRole(principal, w)
      }))
      return textResult(payload.map((w) => `- ${w.name} (${w.type}, role: ${w.role})`).join('\n'), {
        workspaces: payload
      })
    }

    case 'list_collections': {
      const workspaceIds = await resolveWorkspaceScope(db, principal, args.workspace)
      if (!workspaceIds.length) return textResult('No accessible workspaces.', { collections: [] })

      const collections = await all<{ id: string; name: string; workspace_id: string; artifact_count: number }>(
        db,
        `SELECT c.id, c.name, c.workspace_id,
                (SELECT COUNT(*) FROM collection_artifacts ca WHERE ca.collection_id = c.id) AS artifact_count
           FROM collections c
          WHERE c.workspace_id IN (${workspaceIds.map(() => '?').join(',')})
            AND c.archived_at IS NULL
          ORDER BY c.updated_at DESC`,
        workspaceIds
      )

      return textResult(
        collections.map((c) => `- ${c.name} (${c.artifact_count} artifact(s))`).join('\n') ||
          'No collections.',
        { collections }
      )
    }

    case 'create_share': {
      const targetType = String(args.target_type ?? 'ARTIFACT') as 'ARTIFACT' | 'COLLECTION'
      const targetId = String(args.target_id ?? '')
      const accessType = String(args.access_type ?? 'PUBLIC_LINK') as
        | 'PUBLIC_LINK'
        | 'EMAIL'
        | 'DOMAIN'

      if (targetType === 'ARTIFACT') {
        const artifact = await loadArtifact(db, targetId)
        if (!artifact) return errorResult('Artifact not found.')
        await assertCan(db, principal, artifact, 'share.create')
      }

      const recipients = Array.isArray(args.recipients)
        ? (args.recipients as unknown[]).map((v) => ({
            type: accessType === 'DOMAIN' ? ('DOMAIN' as const) : ('EMAIL' as const),
            value: String(v)
          }))
        : []

      const days = Number(args.expires_in_days ?? 0)
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null

      const created = await createShare(
        db,
        principal,
        {
          targetType,
          targetId,
          accessType,
          allowView: true,
          allowDownload: args.allow_download === true,
          includeNewItems: true,
          expiresAt,
          recipients
        },
        origin
      )

      return textResult(`Share created: ${created.url}`, {
        share_id: created.share.id,
        url: created.url,
        access_type: accessType,
        expires_at: expiresAt,
        allow_download: args.allow_download === true
      })
    }

    case 'revoke_share': {
      const shareId = String(args.share_id ?? '')
      const share = await first<{ id: string; created_by_user_id: string }>(
        db,
        `SELECT id, created_by_user_id FROM shares WHERE id = ?`,
        [shareId]
      )
      if (!share) return errorResult('Share not found.')
      if (share.created_by_user_id !== principal.userId) {
        return errorResult('Only the person who created a share can revoke it.')
      }

      await revokeShare(db, shareId)
      await recordAudit(db, {
        actorUserId: principal.userId,
        actorType: 'AI',
        action: 'SHARE_REVOKE',
        targetType: 'share',
        targetId: shareId
      })

      return textResult('Share revoked. The link no longer grants access.', { share_id: shareId })
    }

    case 'get_artifact_analytics': {
      const artifactId = String(args.artifact_id ?? '')
      const artifact = await loadArtifact(db, artifactId)
      if (!artifact) return errorResult('Artifact not found.')

      // Analytics obeys owner/admin permission, including for AI callers (§53)
      const role = effectiveWorkspaceRole(principal, {
        id: artifact.workspace_id,
        organization_id: artifact.organization_id,
        owner_user_id: artifact.owner_user_id
      })
      const isOwner = artifact.owner_user_id === principal.userId
      const mayRead =
        isOwner ||
        can(principal, 'analytics.read.artifact', {
          id: artifact.workspace_id,
          organization_id: artifact.organization_id,
          owner_user_id: artifact.owner_user_id
        })

      if (!mayRead) {
        return errorResult(
          'You do not have permission to view analytics for this artifact. Only the owner or a workspace admin can.'
        )
      }

      const period = (['7d', '30d', '90d', 'all'] as const).includes(args.period as never)
        ? (args.period as '7d' | '30d' | '90d' | 'all')
        : '30d'

      const [totals, sources, activity] = await Promise.all([
        artifactTotals(db, artifactId, period),
        sourceBreakdown(db, artifactId, period),
        recentActivity(db, artifactId, 8)
      ])

      return textResult(
        `"${artifact.title}" — ${totals.views} views, ${totals.uniqueViewers} unique viewers, ` +
          `${totals.downloads} downloads, ${totals.aiReferences} AI references (${period}).`,
        {
          artifact_id: artifactId,
          period,
          role,
          totals,
          sources,
          recent_activity: activity.map((a) => ({
            event: a.event_type,
            actor: actorDisplay(a),
            channel: a.access_channel,
            at: a.occurred_at
          }))
        }
      )
    }

    default:
      return errorResult(`Tool not implemented: ${name}`)
  }
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function decodeContent(args: Record<string, unknown>): Uint8Array | null {
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
  if (typeof args.content_text === 'string') {
    return new TextEncoder().encode(args.content_text)
  }
  return null
}

/** Resolve an optional workspace filter into an ACL-bounded id list. */
async function resolveWorkspaceScope(
  db: D1Database,
  principal: Principal,
  workspace: unknown
): Promise<string[]> {
  const readable = await readableWorkspaces(db, principal)
  if (typeof workspace !== 'string' || !workspace.trim()) return readable.map((w) => w.id)

  const needle = workspace.trim().toLowerCase()
  const match = readable.filter(
    (w) => w.id === workspace || w.name.toLowerCase() === needle
  )
  return match.map((w) => w.id)
}

/** Pick a writable workspace, defaulting to the user's personal one (§6). */
async function resolveSingleWorkspace(
  db: D1Database,
  principal: Principal,
  workspace: unknown
): Promise<{ id: string; name: string; organization_id: string | null; owner_user_id: string } | null> {
  const readable = await readableWorkspaces(db, principal)
  if (!readable.length) return null

  if (typeof workspace === 'string' && workspace.trim()) {
    const needle = workspace.trim().toLowerCase()
    const match = readable.find((w) => w.id === workspace || w.name.toLowerCase() === needle)
    return match ?? null
  }

  const writable = readable.filter((w) => can(principal, 'artifact.create', w))
  const personal = writable.find((w) => w.workspace_type === 'PERSONAL')
  const chosen = personal ?? writable[0]
  return chosen ?? null
}

async function applyTagSlugs(
  db: D1Database,
  principal: Principal,
  artifactId: string,
  rawTags: unknown
): Promise<void> {
  const slugs = Array.isArray(rawTags) ? rawTags.map(String) : []
  if (!slugs.length) return

  const tags = await all<{ id: string; slug: string }>(
    db,
    `SELECT id, slug FROM tags WHERE status = 'ACTIVE'`,
    []
  )
  const tagIds = tags.filter((t) => slugs.includes(t.slug)).map((t) => t.id)
  if (tagIds.length) await assignTags(db, artifactId, tagIds, principal.userId!)
}

type LoadedArtifact = {
  id: string
  workspace_id: string
  organization_id: string | null
  owner_user_id: string
}

async function assertCan(
  db: D1Database,
  principal: Principal,
  artifact: LoadedArtifact,
  permission:
    | 'artifact.read'
    | 'artifact.update'
    | 'artifact.version.create'
    | 'share.create'
): Promise<void> {
  const workspace = {
    id: artifact.workspace_id,
    organization_id: artifact.organization_id,
    owner_user_id: artifact.owner_user_id
  }
  const isOwner = artifact.owner_user_id === principal.userId
  if (permission === 'artifact.read') {
    if (isOwner || can(principal, 'artifact.read', workspace)) return
  } else if (can(principal, permission, workspace)) {
    return
  }
  throw forbidden()
}

async function assertCanRead(
  db: D1Database,
  principal: Principal,
  artifact: LoadedArtifact
): Promise<void> {
  await assertCan(db, principal, artifact, 'artifact.read')
}

async function assertCanWrite(
  db: D1Database,
  principal: Principal,
  artifact: LoadedArtifact
): Promise<void> {
  await assertCan(db, principal, artifact, 'artifact.update')
}
