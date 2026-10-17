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
import { EXTENSION_MIME, TEXT_MIME, isTextExtension } from './validate'
import { getObject } from './storage'
import {
  MAX_DERIVED_FROM,
  MAX_HANDOFF_ARTIFACTS,
  addLineage,
  createHandoff,
  handoffArtifacts,
  lineageFor,
  listHandoffs,
  listProjects,
  loadHandoffFor,
  madeByLabel,
  markPickedUp,
  presentHandoff,
  recentReads,
  recordAiRead,
  resolveReadableRefs,
  stampClient
} from './handoffs'
import type { LineageEntry } from './handoffs'
import { UploadError, appendPart, assembleUpload, discardUpload, startUpload } from './uploads'
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
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  /** OAuth scope required to invoke the tool (§58). */
  requiredScope: string
  /**
   * MCP tool annotations. Clients use them to decide what needs the user's
   * approval: ChatGPT and Claude ask before a non-read-only call, so marking
   * the lookups read-only removes a confirmation click on every search.
   */
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  /** Client-specific extensions passed through verbatim in tools/list. */
  _meta?: Record<string, unknown>
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

/**
 * A file handed over by the chat app itself. ChatGPT fills this in for any
 * parameter listed under `openai/fileParams`: the user's uploaded or generated
 * file arrives as a short-lived download URL, so the model never has to
 * base64-encode bytes into its own output.
 */
const FILE_REF_SCHEMA = {
  type: 'object',
  description:
    'A file from the conversation. ChatGPT fills this automatically for uploaded or generated files; ' +
    'other clients may pass { download_url, file_name }.',
  properties: {
    download_url: { type: 'string' },
    file_id: { type: 'string' },
    file_name: { type: 'string' },
    mime_type: { type: 'string' }
  },
  required: ['download_url']
}

const UPLOAD_ID_SCHEMA = {
  type: 'string',
  description: 'An upload_id from upload_part: saves the file assembled from the parts sent there'
}

const SOURCE_URL_SCHEMA = {
  type: 'string',
  description: 'Public https URL Artifactry downloads the file from (pptx, docx, pdf, png, jpg, webp, gif, html)'
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
    title: 'Search artifacts',
    annotations: READ_ONLY,
    description:
      'Find source material in the library. Natural-language query with optional filters for ' +
      'workspace, artifact type, tags, collection/team, owner and date range. Uses the same hybrid ' +
      'lexical + semantic engine as the app. Only artifacts the signed-in user may access are ever returned. ' +
      'Results say which tool made each artifact (made_by).',
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
        made_by: {
          type: 'string',
          description: 'Which tool made it, e.g. "Claude", "ChatGPT", "Cursor", "Gemini", or "web" for files a person uploaded'
        },
        project: { type: 'string', description: 'Project name or id (see list_projects)' },
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
    title: 'Get an artifact',
    annotations: READ_ONLY,
    description:
      'Retrieve one artifact by id or canonical URL, including its tags, workspace, current version, which tool ' +
      'made it, and what it was built from and used in. Text and code files (md, txt, json, csv, py, ts, …) come ' +
      'back whole as file.name + file.content, ready to write to disk. Other formats return their extracted text; ' +
      'binary formats without a text layer return metadata and the canonical URL instead of inlining bytes.',
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
    title: 'Save to Artifactry',
    annotations: WRITES,
    _meta: { 'openai/fileParams': ['file_ref'] },
    description:
      'Persist what the AI has just produced: HTML pages, slide decks (pptx), documents (docx, pdf), ' +
      'images (png, jpg, webp, gif), and text or code files (md, txt, json, csv, yaml, py, ts, js, sql, …). Pick ONE source: ' +
      '(1) an HTML page or a text/code file — pass the full text as content with file "name.html" / "spec.md" / ' +
      '"main.py"; it is stored exactly as given. ' +
      'If the file is too big to write into one call: when it already exists as a file where you can run code ' +
      '(a sandbox, the desktop app), call upload_part with no arguments and upload it with curl -T to the put_url it ' +
      'returns (never through a third-party file host); otherwise send it in pieces with upload_part. Then pass upload_id here. ' +
      '(2) a file from the conversation — file_ref (ChatGPT fills it automatically). ' +
      '(3) a file at a public URL — source_url. ' +
      '(4) small binaries — content_base64 with file. ' +
      '(5) plain text to turn into a document — content with format "pdf" or "html". ' +
      'Saves into a workspace, optionally a collection, applies any tags given and proposes more from the ' +
      "artifact's actual content. Use create_version to revise an artifact that already exists. " +
      'Pass derived_from with the artifacts this was built from, so the next person or tool can trace it.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filename including a supported extension, e.g. "q3-summary.html"' },
        upload_id: UPLOAD_ID_SCHEMA,
        file_ref: FILE_REF_SCHEMA,
        source_url: SOURCE_URL_SCHEMA,
        content_base64: { type: 'string', description: 'Base64 file bytes (small binary files only)' },
        content: {
          type: 'string',
          description: 'A complete HTML document (stored verbatim), or plain text to convert when format is given'
        },
        format: {
          type: 'string',
          description: 'Convert plain-text content into this format: pdf or html. Or md / txt to store it as a text file'
        },
        title: { type: 'string' },
        description: { type: 'string' },
        workspace: { type: 'string', description: 'Target workspace name or id' },
        collection: { type: 'string', description: 'Optional collection name or id' },
        project: { type: 'string', description: 'Optional project name or id (a collection marked as a project)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to apply and confirm' },
        derived_from: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Artifacts (ids or URLs) this was built from, e.g. the research note a spec came from. ' +
            'If omitted, artifacts you read with get or get_handoff shortly before are linked automatically; pass [] to link none'
        },
        source_conversation_reference: { type: 'string' }
      }
    }
  },
  {
    name: 'create_version',
    title: 'Save a new version',
    annotations: WRITES,
    _meta: { 'openai/fileParams': ['file_ref'] },
    description:
      'Add a new version to an existing artifact, preserving all prior versions. Use this instead of save ' +
      'when the AI is revising something already in the library.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: ARTIFACT_REF },
        file: { type: 'string' },
        upload_id: UPLOAD_ID_SCHEMA,
        file_ref: FILE_REF_SCHEMA,
        source_url: SOURCE_URL_SCHEMA,
        content_base64: { type: 'string' },
        content: { type: 'string', description: 'New full text, for HTML, text and code artifacts' },
        change_summary: { type: 'string' },
        derived_from: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Artifacts (ids or URLs) this was built from, e.g. the research note a spec came from. ' +
            'If omitted, artifacts you read with get or get_handoff shortly before are linked automatically; pass [] to link none'
        },
      },
      required: ['artifact']
    }
  },
  {
    name: 'upload_part',
    title: 'Upload a large file in parts',
    annotations: WRITES,
    description:
      'Get a file that is too large for a single save call into Artifactry. ' +
      'BEST for large or binary files that already exist on disk where you can run code (for example a multi-MB HTML ' +
      'page with embedded media): call with no arguments, then run curl -sS -T <file> "<put_url>" in your code ' +
      'environment, then call save with upload_id. No auth header is needed; the link is private to this upload. ' +
      'Your code environment must be allowed to reach this server; if the request is blocked, tell the user to add ' +
      'this server\'s domain to the allowed network domains in their AI app settings. ' +
      'OTHERWISE send the content one piece at a time. First call: omit upload_id ' +
      'and pass the first piece; keep the returned upload_id and pass it with every following piece, in order. ' +
      'Text files such as HTML go in content, split anywhere (about 20,000 characters per piece works well); ' +
      'binary files go in content_base64, split at a multiple of 4 characters. Then call save (or ' +
      'create_version) with upload_id, file, title and tags. Nothing is saved until then. ' +
      'Uploads expire after 24 hours.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        upload_id: { type: 'string', description: 'Omit on the first piece; then the id returned by the first call' },
        part: { type: 'number', description: 'Piece number from 1 (default: the next one). Resending a number replaces that piece' },
        content: { type: 'string', description: 'The next piece of a text file (HTML, markdown, csv, json…)' },
        content_base64: { type: 'string', description: 'The next piece of a binary file, as base64' }
      }
    }
  },
  {
    name: 'share',
    title: 'Share an artifact',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    title: 'Revoke a share',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    title: 'List workspaces',
    annotations: READ_ONLY,
    description: 'List the workspaces the signed-in user can access, with their role.',
    requiredScope: 'workspace.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_teams',
    title: 'List teams',
    annotations: READ_ONLY,
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
    title: 'List tags',
    annotations: READ_ONLY,
    description:
      'List tags in use. Confirmed tags are the library vocabulary; suggestions are shown for a specific ' +
      'artifact via get, not here.',
    requiredScope: 'tags.read',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_tags',
    title: 'Update tags',
    annotations: WRITES,
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
  },
  {
    name: 'handoff',
    title: 'Hand work to another tool',
    annotations: WRITES,
    description:
      'Leave a handoff for the next AI tool: a brief plus the artifacts it needs, e.g. hand a research report ' +
      'and a spec from Claude to Cursor to build, or code and notes from Cursor to Gemini to turn into a deck. ' +
      'Save the artifacts first. Returns a handoff id and a one-line prompt the user pastes into the next tool, ' +
      'which opens it with get_handoff. Handoffs stay in the workspace, so everyone there can see them.',
    requiredScope: 'artifact.write',
    inputSchema: {
      type: 'object',
      properties: {
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact ids or URLs to hand over, in the order the next tool should read them (max 20)'
        },
        brief: {
          type: 'string',
          description: 'What the next tool should do, with any context it needs. Written to that tool, not the user'
        },
        title: { type: 'string', description: 'Short name, e.g. "Build the pricing page"' },
        to: { type: 'string', description: 'Which tool it is for, if known, e.g. "Cursor"' },
        workspace: { type: 'string', description: "Workspace name or id (default: the first artifact's workspace)" }
      },
      required: ['artifacts', 'brief']
    }
  },
  {
    name: 'get_handoff',
    title: 'Open a handoff',
    annotations: READ_ONLY,
    description:
      'Open a handoff another tool or person left: its brief and every artifact in it, with text and code ' +
      'files inlined so you can work on them directly. Use when the user says "open my Artifactry handoff" or ' +
      'pastes a handoff id (hof_…) or link. With no handoff given, opens the newest open one. When you save ' +
      'what you make from it, those artifacts are linked as its sources automatically.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        handoff: { type: 'string', description: 'Handoff id (hof_…) or link; omit for the newest open handoff' },
        include_text: { type: 'boolean', description: 'Inline text and code (default true)' }
      }
    }
  },
  {
    name: 'list_handoffs',
    title: 'List handoffs',
    annotations: READ_ONLY,
    description: 'List handoffs waiting in the workspaces the user can read, newest first.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or id' },
        include_closed: { type: 'boolean', description: 'Include closed handoffs (default false)' }
      }
    }
  },
  {
    name: 'list_projects',
    title: 'List projects',
    annotations: READ_ONLY,
    description:
      'List projects: collections marked as the home of one piece of work (e.g. "Q4 launch"). Pass a project ' +
      'name to save to file the artifact there, and to search to look only inside it.',
    requiredScope: 'artifact.read',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name or id' } }
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
 * Versions this server speaks. The transport is plain request/response JSON,
 * which is unchanged across these revisions, so echoing the client's version
 * when it is one of them avoids a pointless downgrade negotiation.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

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
  'Artifactry is also how the user moves work between AI tools. When you build on artifacts, pass ' +
  'derived_from when you save. When the user wants another tool to continue, save the work and call ' +
  'handoff with a brief written to that tool; when the user asks you to open a handoff (hof_…), call ' +
  'get_handoff. Text and code files are saved and returned whole. ' +
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

/**
 * One audit row per tool call, under the person the credential belongs to,
 * keyed by the grant so Settings can show what each connection or token did.
 * Arguments are deliberately left out: they can hold whole documents.
 */
async function auditToolCall(
  db: D1Database,
  principal: Principal,
  tool: string,
  outcome: 'ok' | 'error' | 'denied'
): Promise<void> {
  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'AI_TOOL_CALL',
    targetType: 'grant',
    targetId: principal.grantId ?? null,
    metadata: {
      tool,
      outcome,
      credential: principal.grantKind ?? 'CONNECTOR',
      integrationId: principal.integrationId ?? null,
      provider: principal.provider ?? null,
      client: principal.clientName ?? null
    }
  })
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
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(String(request.params?.protocolVersion))
              ? String(request.params?.protocolVersion)
              : PROTOCOL_VERSION,
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
              ...(tool.title ? { title: tool.title } : {}),
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
              ...(tool._meta ? { _meta: tool._meta } : {})
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

        try {
          assertScope(principal, tool)
        } catch (err) {
          await auditToolCall(env.DB, principal, name, 'denied')
          throw err
        }

        const outcome = await callJobTool(env, principal, name, args, origin)
        await auditToolCall(env.DB, principal, name, outcome.isError === true ? 'error' : 'ok')
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
        return await toolSearch(env, principal, args, origin)
      case 'get':
        return await toolGet(env, principal, args, origin)
      case 'save':
        return await toolSave(env, principal, args, origin)
      case 'create_version':
        return await toolCreateVersion(env, principal, args, origin)
      case 'upload_part':
        return await toolUploadPart(env, principal, args, origin)
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
      case 'handoff':
        return await toolHandoff(env, principal, args, origin)
      case 'get_handoff':
        return await toolGetHandoff(env, principal, args, origin)
      case 'list_handoffs':
        return await toolListHandoffs(env, principal, args, origin)
      case 'list_projects':
        return await toolListProjects(env, principal, args)
      default:
        return { text: `Tool not implemented: ${name}`, isError: true }
    }
  } catch (err) {
    if (err instanceof UploadError) return { text: err.message, isError: true }
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
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50)
  const includeExcerpt = args.include_excerpt !== false

  const workspaceIds = await resolveWorkspaceScope(db, principal, args.workspace)
  if (!workspaceIds.length) {
    return { text: 'No accessible workspace matches that filter.', structured: { results: [] } }
  }

  const tagSlugs = await resolveTagFilters(db, args.tags)
  // A project is a collection, so either name narrows the same way.
  const collectionIds = await resolveCollectionFilters(
    db,
    principal,
    typeof args.collection === 'string' && args.collection.trim() ? args.collection : args.project,
    workspaceIds
  )
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
      updatedTo: isoOrUndefined(args.updated_before),
      madeBy: typeof args.made_by === 'string' ? args.made_by.slice(0, 60) : undefined
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
    made_by: madeByLabel(hit.artifact.source_provider, hit.artifact.source_client),
    updated_at: hit.artifact.updated_at,
    match: hit.matchSource,
    score: Number(hit.score.toFixed(4)),
    ...(includeExcerpt && hit.excerpt ? { excerpt: hit.excerpt } : {})
  }))

  const summary = results
    .map(
      (r) =>
        `- ${r.title} (${r.type ?? 'file'}, ${r.workspace ?? 'workspace'}` +
        `${r.made_by ? `, made by ${r.made_by}` : ''}) — ${r.canonical_url}`
    )
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
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'artifact.read')

  const tags = await artifactTagViews(db, artifact.id)
  const versions = await all<{ id: string; version_number: number; created_at: string; source_provider: string | null; source_client: string | null }>(
    db,
    `SELECT id, version_number, created_at, source_provider, source_client FROM artifact_versions
      WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY version_number DESC`,
    [artifact.id]
  )
  const lineage = await lineageFor(db, principal, artifact.id, origin)
  const body = args.include_text !== false ? await artifactBody(env, principal, artifact) : null

  return {
    text: `${artifact.title} — ${origin}/a/${artifact.id}` + (body?.file ? `\n\n${body.file.content}` : ''),
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
      made_by: madeByLabel(artifact.source_provider, artifact.source_client),
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
        made_by: madeByLabel(v.source_provider, v.source_client),
        created_at: v.created_at
      })),
      built_from: lineage.builtFrom.map(lineageOut),
      used_in: lineage.usedIn.map(lineageOut),
      ...(body ?? {})
    }
  }
}

function lineageOut(entry: LineageEntry) {
  return {
    artifact_id: entry.artifactId,
    title: entry.title,
    made_by: entry.madeBy,
    canonical_url: entry.canonicalUrl,
    how: entry.origin === 'INFERRED' ? 'inferred' : entry.origin === 'USER' ? 'added by a person' : 'declared'
  }
}

/** Largest text or code file returned whole; larger ones come back as extracted text. */
const MAX_INLINE_FILE_BYTES = 1_000_000

/**
 * The content an AI reads: a text or code file whole (exact bytes, ready to
 * write to disk), otherwise the extracted text layer. Reading it is recorded
 * as an AI reference and remembered for lineage inference.
 */
async function artifactBody(
  env: Env,
  principal: Principal,
  artifact: ArtifactRow,
  maxChars = 100_000
): Promise<{ file?: { name: string; content: string; truncated: boolean }; text?: string; truncated?: boolean; note?: string } | null> {
  const db = env.DB
  if (!artifact.current_version_id) return null

  let out: { file?: { name: string; content: string; truncated: boolean }; text?: string; truncated?: boolean; note?: string }
  const version = await first<{ extracted_text: string | null; r2_object_key: string; size_bytes: number; filename: string }>(
    db,
    `SELECT extracted_text, r2_object_key, size_bytes, filename FROM artifact_versions WHERE id = ?`,
    [artifact.current_version_id]
  )
  if (!version) return null

  const ext = (artifact.extension ?? '').toLowerCase()
  const object = isTextExtension(ext) && version.size_bytes <= MAX_INLINE_FILE_BYTES
    ? await getObject(env, version.r2_object_key)
    : null

  if (object) {
    const content = new TextDecoder().decode(await object.arrayBuffer())
    const truncated = content.length > maxChars
    out = { file: { name: version.filename, content: content.slice(0, maxChars), truncated } }
  } else if (version.extracted_text) {
    out = { text: version.extracted_text.slice(0, maxChars), truncated: version.extracted_text.length > maxChars }
  } else {
    out = {
      note: 'No text layer is stored for this artifact, so its content cannot be inlined. ' +
        'Binary formats are not inlined; open the canonical URL instead.'
    }
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
    metadata: { provider: principal.provider ?? 'API', client: principal.clientName ?? null, operation: 'get' }
  })

  await recordAiRead(db, principal, artifact.id).catch(() => {})
  return out
}

// ---------------------------------------------------------------
// File sources for save / create_version
// ---------------------------------------------------------------

const FETCH_TIMEOUT_MS = 20_000

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : ''
}

function fileBase(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  )
}

/** A full HTML document, as opposed to prose that merely mentions a tag. */
export function looksLikeHtmlDocument(content: string): boolean {
  const head = content.replace(/^\uFEFF/, '').trimStart().slice(0, 1024).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || (head.includes('<head') && head.includes('<body'))
}

function extensionForMime(mime: string | null | undefined): string {
  if (!mime) return ''
  const bare = mime.split(';')[0].trim().toLowerCase()
  if (bare === 'image/webp') return 'webp'
  for (const [ext, m] of Object.entries(EXTENSION_MIME)) if (m === bare) return ext
  return ''
}

/**
 * Hosts a server-side fetch must never be pointed at. Workers egress to the
 * public internet only, so this is defence in depth against a URL naming a
 * loopback, link-local or private address, or a bare internal hostname.
 */
function forbiddenFetchHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (!h.includes('.') && !h.includes(':')) return true
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

/**
 * Download a file named by `file_ref` (filled by ChatGPT) or `source_url`.
 * Returns null when neither is present. The size is capped while streaming,
 * so a huge or endless body is cut off rather than buffered.
 */
async function fileFromReference(
  env: Env,
  args: Record<string, unknown>
): Promise<{ bytes: Uint8Array; filename: string } | { error: string } | null> {
  const ref = args.file_ref && typeof args.file_ref === 'object' ? (args.file_ref as Record<string, unknown>) : null
  const rawUrl =
    ref && typeof ref.download_url === 'string'
      ? ref.download_url
      : typeof args.source_url === 'string' && args.source_url.trim()
        ? args.source_url.trim()
        : null
  if (!rawUrl) return null

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { error: 'The file URL is not a valid URL.' }
  }
  if (url.protocol !== 'https:') return { error: 'Only https URLs can be fetched.' }
  if (url.username || url.password) return { error: 'URLs with credentials are not accepted.' }
  if (forbiddenFetchHost(url.hostname)) return { error: 'That host cannot be fetched.' }

  const limit = Number(env.MAX_UPLOAD_BYTES || 26214400)
  let response: Response
  try {
    response = await fetch(url.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: '*/*', 'User-Agent': 'Artifactry-Fetch/1.0' }
    })
  } catch (err) {
    return { error: `Could not download the file: ${err instanceof Error ? err.message : 'network error'}` }
  }
  if (!response.ok || !response.body) {
    return { error: `Could not download the file (HTTP ${response.status}).` }
  }
  const declared = Number(response.headers.get('Content-Length') ?? '0')
  if (declared > limit) return { error: `The file is larger than the ${limit}-byte limit.` }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return { error: `The file is larger than the ${limit}-byte limit.` }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }

  // Name: what the caller said, else what the chat app said, else the URL's
  // last path segment, else the content type.
  const refName = ref && typeof ref.file_name === 'string' ? ref.file_name.trim() : ''
  const urlName = decodeURIComponent(url.pathname.split('/').pop() ?? '').trim()
  let filename = refName || urlName || 'file'
  if (!extensionOf(filename)) {
    const mime = (ref && typeof ref.mime_type === 'string' ? ref.mime_type : null) ?? response.headers.get('Content-Type')
    const ext = extensionForMime(mime)
    if (ext) filename = `${filename}.${ext}`
  }
  return { bytes, filename }
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

  const fileExt = extensionOf(fileArg)
  const htmlTarget = fileExt === 'html' || fileExt === 'htm' || format === 'html' || format === 'htm'
  // A text or code file named by `file`, or plain text asked to be stored as one.
  const textTarget = isTextExtension(fileExt) ? fileExt : isTextExtension(format) ? format : null

  // Sources, most specific first. Each one yields the artifact's real bytes;
  // only the last (format conversion) produces something Artifactry authored.
  const uploadId = typeof args.upload_id === 'string' && args.upload_id.trim() ? args.upload_id.trim() : null
  const fetched = uploadId ? null : await fileFromReference(env, args)
  if (fetched && 'error' in fetched) return { text: fetched.error, isError: true }

  if (uploadId) {
    const staged = await assembleUpload(env, principal, uploadId)
    bytes = staged.bytes
    if (fileArg && extensionOf(fileArg)) {
      filename = fileArg
    } else if (staged.text !== null && looksLikeHtmlDocument(staged.text)) {
      filename = `${fileBase(fileArg || title || 'Untitled')}.html`
    } else {
      return { text: 'Provide file (a filename with extension, e.g. "deck.pptx") alongside upload_id.', isError: true }
    }
    const ext = extensionOf(filename)
    if (ext === 'html' || ext === 'htm') mimeType = 'text/html'
  } else if (fetched) {
    bytes = fetched.bytes
    filename = fileArg || fetched.filename
  } else if (typeof args.content_base64 === 'string' && args.content_base64.trim()) {
    bytes = decodeBytes(args)
    if (!bytes) return { text: 'content_base64 is not valid base64.', isError: true }
    if (!fileArg) {
      return { text: 'Provide file (a filename with extension) alongside content_base64.', isError: true }
    }
  } else if (rawContent !== null && htmlTarget && (fileExt === 'html' || fileExt === 'htm' || looksLikeHtmlDocument(rawContent))) {
    // An HTML page the AI wrote is saved exactly as written. Wrapping it in
    // the text-to-document template would escape the markup and store its
    // source code instead of the page.
    bytes = new TextEncoder().encode(rawContent)
    filename = fileExt === 'html' || fileExt === 'htm' ? fileArg : `${fileBase(title ?? 'Untitled')}.html`
    mimeType = 'text/html'
  } else if (rawContent !== null && textTarget) {
    // Notes, specs, data and code are stored exactly as written.
    bytes = new TextEncoder().encode(rawContent)
    filename = fileExt === textTarget ? fileArg : `${fileBase(title ?? 'Untitled')}.${textTarget}`
    mimeType = TEXT_MIME
  } else if (format) {
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
  } else {
    return {
      text:
        'Nothing to save. Pass an HTML page or a text/code file as content with file "name.html" / "notes.md", a conversation file as ' +
        'file_ref, a public URL as source_url, bytes as content_base64 with file, plain text as ' +
        'content with format "pdf", or an upload_id from upload_part for a file too large for one call.',
      isError: true
    }
  }

  if (!bytes) return { text: 'Nothing to save.', isError: true }

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

  if (uploadId) await discardUpload(env, uploadId).catch(() => {})
  await stampClient(db, principal, { artifactId: result.artifactId, versionId: result.versionId })

  const artifact = await loadArtifact(db, result.artifactId)
  if (!artifact) {
    return { text: 'Artifact was created but could not be read back.', structured: { artifact_id: result.artifactId } }
  }

  const lineage = await recordSources(db, principal, artifact, result.versionId, args.derived_from)

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

  const collectionNote = await attachToCollection(
    db,
    principal,
    artifact,
    typeof args.collection === 'string' && args.collection.trim() ? args.collection : args.project,
    workspace.id
  )

  const tagViews = await artifactTagViews(db, artifact.id)
  const indexing = await indexingStateFor(db, artifact.id)

  return {
    text:
      `Saved "${artifact.title}" to ${workspace.name}. ${result.canonicalUrl}` +
      (suggestions.proposed.length
        ? `\nProposed tags (not yet applied): ${suggestions.proposed.join(', ')}. ` +
          `Ask the user which to keep, then call update_tags.`
        : '') +
      (collectionNote ? `\n${collectionNote}` : '') +
      lineage.note,
    structured: {
      artifact_id: artifact.id,
      title: artifact.title,
      canonical_url: result.canonicalUrl,
      made_by: madeByLabel(artifact.source_provider, artifact.source_client),
      built_from: lineage.linked,
      ...(lineage.skipped.length ? { derived_from_skipped: lineage.skipped } : {}),
      workspace: { id: workspace.id, name: workspace.name },
      status: result.status,
      detail: result.detail,
      indexing,
      applied_tags: tagViews.filter((t) => t.state === 'CONFIRMED').map((t) => t.name),
      proposed_tags: suggestions.proposed,
      tag_note: suggestions.note,
      collection: collectionNote
        ? (typeof args.collection === 'string' && args.collection.trim() ? args.collection : args.project)
        : null
    }
  }
}

/**
 * Record what a new artifact or version was built from.
 *
 * `derived_from` given (even empty): exactly those, as DECLARED.
 * Omitted: whatever this connection read in the last couple of hours, as
 * INFERRED, so lineage exists even when the model forgets to declare it.
 */
async function recordSources(
  db: D1Database,
  principal: Principal,
  artifact: ArtifactRow,
  versionId: string | null,
  derivedFrom: unknown
): Promise<{
  linked: Array<{ artifact_id: string; title: string; how: 'declared' | 'inferred' }>
  skipped: string[]
  note: string
}> {
  const declared = Array.isArray(derivedFrom)
  const resolved = declared
    ? await resolveReadableRefs(db, principal, derivedFrom as unknown[], MAX_DERIVED_FROM)
    : { artifacts: await recentReads(db, principal, artifact.id), skipped: [] as string[] }

  const linked = await addLineage(db, principal, {
    fromArtifact: artifact,
    fromVersionId: versionId,
    sources: resolved.artifacts,
    origin: declared ? 'DECLARED' : 'INFERRED'
  })
  const how = declared ? ('declared' as const) : ('inferred' as const)

  const note =
    (linked.length
      ? `\nBuilt from: ${linked.map((a) => `"${a.title}"`).join(', ')}` +
        (declared ? '.' : ' (you read these just before saving; pass derived_from to set this yourself).')
      : '') +
    (resolved.skipped.length ? `\nNot linked (not found or not accessible): ${resolved.skipped.join(', ')}.` : '')

  return {
    linked: linked.map((a) => ({ artifact_id: a.id, title: a.title, how })),
    skipped: resolved.skipped,
    note
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

  // An artifact is in one collection only: this moves it out of any other.
  const { placeInCollection } = await import('./collections')
  await placeInCollection(db, artifact.id, collection.id, principal.userId)

  return `Added to collection "${collection.name}".`
}

// ---------------------------------------------------------------
// create_version
// ---------------------------------------------------------------

async function toolCreateVersion(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  const artifact = await loadArtifactByRef(db, args.artifact, originOf(args))
  if (!artifact) return { text: 'Artifact not found.', isError: true }
  await assertCan(principal, artifact, 'artifact.version.create')

  const uploadId = typeof args.upload_id === 'string' && args.upload_id.trim() ? args.upload_id.trim() : null
  const staged = uploadId ? await assembleUpload(env, principal, uploadId) : null
  const fetched = uploadId ? null : await fileFromReference(env, args)
  if (fetched && 'error' in fetched) return { text: fetched.error, isError: true }
  const bytes = staged ? staged.bytes : fetched ? fetched.bytes : decodeBytes(args)
  const rawContent = typeof args.content === 'string' ? args.content : null
  const ext = artifact.extension?.toLowerCase() ?? ''

  if (!bytes && rawContent === null) {
    return { text: 'Provide upload_id, file_ref, source_url, content_base64 or content.', isError: true }
  }

  let payload = bytes
  let filename =
    typeof args.file === 'string' && args.file.trim()
      ? args.file.trim()
      : fetched?.filename ?? artifact.filename ?? 'version'

  // Text content is only writable in the format the artifact already is when
  // that format is text-based; otherwise the caller must send real bytes, since
  // silently re-encoding would misrepresent what was stored.
  if (!payload && rawContent !== null) {
    if (ext === 'html' || ext === 'htm' || isTextExtension(ext)) {
      payload = new TextEncoder().encode(rawContent)
    } else {
      return {
        text:
          `This artifact is a .${ext} file, so new content must be sent as bytes with content_base64. ` +
          `Raw text can only be versioned into an HTML, text or code artifact.`,
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
  if (uploadId) await discardUpload(env, uploadId).catch(() => {})
  await stampClient(db, principal, { versionId: result.versionId })

  const suggestions = await generateSuggestionsFor(env, artifact.id)
  const lineage = await recordSources(db, principal, artifact, result.versionId, args.derived_from)

  return {
    text:
      `Added version ${result.versionNumber} to "${artifact.title}" (${result.status}).` +
      (suggestions.proposed.length
        ? `\nNew content produced new tag suggestions: ${suggestions.proposed.join(', ')}.`
        : '') +
      lineage.note,
    structured: {
      artifact_id: artifact.id,
      version_id: result.versionId,
      version_number: result.versionNumber,
      status: result.status,
      built_from: lineage.linked,
      ...(lineage.skipped.length ? { derived_from_skipped: lineage.skipped } : {}),
      canonical_url: `${origin}/a/${artifact.id}`,
      proposed_tags: suggestions.proposed,
      indexing: await indexingStateFor(db, artifact.id)
    }
  }
}

// ---------------------------------------------------------------
// upload_part
// ---------------------------------------------------------------

async function toolUploadPart(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  // Uploads land in the caller's own staging area; save re-checks the
  // workspace permission when the file becomes an artifact.
  if (!principal.userId) return { text: 'Sign in first.', isError: true }

  const hasContent = [args.content, args.content_base64].some((v) => typeof v === 'string' && v.length > 0)
  const hasId = typeof args.upload_id === 'string' && args.upload_id.trim()
  if (!hasContent && !hasId) {
    const opened = await startUpload(env, principal, origin)
    return {
      text:
        `Upload ready: upload_id ${opened.upload_id}. Upload the whole file from your code environment with ` +
        `curl -sS -T <file> "${opened.put_url}" (or send pieces with upload_part), then call save with this ` +
        `upload_id, file, title and tags.`,
      structured: opened
    }
  }
  if (!hasContent) return { text: 'Pass the next piece as content or content_base64.', isError: true }

  const receipt = await appendPart(env, principal, args, origin)
  return {
    text:
      `Received part ${receipt.part} (${receipt.parts_received} so far, ${receipt.bytes_received} bytes). ` +
      `Send the next piece with upload_id ${receipt.upload_id}, or call save with upload_id when done.`,
    structured: receipt
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

// ---------------------------------------------------------------
// handoffs and projects
// ---------------------------------------------------------------

async function toolHandoff(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  const refs = Array.isArray(args.artifacts)
    ? (args.artifacts as unknown[])
    : typeof args.artifacts === 'string'
      ? [args.artifacts]
      : []
  if (!refs.length) return { text: 'Pass artifacts: the ids or links of what the next tool needs. Save them first.', isError: true }

  const { artifacts, skipped } = await resolveReadableRefs(db, principal, refs, MAX_HANDOFF_ARTIFACTS)
  if (!artifacts.length) {
    return { text: `None of those artifacts could be found or opened: ${skipped.join(', ')}.`, isError: true }
  }

  const readable = await readableWorkspaces(db, principal)
  const workspace =
    typeof args.workspace === 'string' && args.workspace.trim()
      ? readable.find((w) => w.id === args.workspace || w.name.toLowerCase() === String(args.workspace).trim().toLowerCase())
      : readable.find((w) => w.id === artifacts[0].workspace_id)
  if (!workspace) return { text: 'No workspace you can use matches that.', isError: true }

  const handoff = await createHandoff(db, principal, {
    workspace,
    artifacts,
    brief: typeof args.brief === 'string' ? args.brief : '',
    title: typeof args.title === 'string' ? args.title : null,
    toTool: typeof args.to === 'string' ? args.to : null
  })
  const view = presentHandoff(handoff, origin)

  return {
    text:
      `Handoff ready in ${workspace.name}: "${view.title}" with ${artifacts.length} artifact(s). ${view.url}\n` +
      `Tell the user to paste this into ${view.toTool ?? 'the next tool'}:\n${view.pickupPrompt}` +
      (skipped.length ? `\nLeft out (not found or not accessible): ${skipped.join(', ')}.` : ''),
    structured: {
      handoff_id: view.id,
      title: view.title,
      url: view.url,
      workspace: { id: workspace.id, name: workspace.name },
      to: view.toTool,
      artifacts: artifacts.map((a) => ({ artifact_id: a.id, title: a.title, canonical_url: `${origin}/a/${a.id}` })),
      pickup_prompt: view.pickupPrompt,
      ...(skipped.length ? { skipped } : {})
    }
  }
}

/** Total characters of artifact content one get_handoff returns inline. */
const HANDOFF_TEXT_BUDGET = 200_000

async function toolGetHandoff(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const db = env.DB
  let ref: unknown = args.handoff
  if (typeof ref !== 'string' || !ref.trim()) {
    const [latest] = await listHandoffs(db, principal, { limit: 1 })
    if (!latest) return { text: 'There are no open handoffs. Ask the user for the handoff id (hof_…).', isError: true }
    ref = latest.id
  }

  const { handoff, workspace } = await loadHandoffFor(db, principal, ref)
  const { artifacts, hidden } = await handoffArtifacts(db, principal, handoff.id)
  const includeText = args.include_text !== false

  const items: Record<string, unknown>[] = []
  let budget = HANDOFF_TEXT_BUDGET
  for (const artifact of artifacts) {
    const body = includeText && budget > 0 ? await artifactBody(env, principal, artifact, budget) : null
    // Every artifact in an opened handoff counts as read, inlined or not, so
    // what the tool saves next is linked to all of them.
    if (!body) await recordAiRead(db, principal, artifact.id).catch(() => {})
    const used = body?.file?.content.length ?? body?.text?.length ?? 0
    budget -= used
    items.push({
      artifact_id: artifact.id,
      title: artifact.title,
      type: artifact.extension,
      made_by: madeByLabel(artifact.source_provider, artifact.source_client),
      canonical_url: `${origin}/a/${artifact.id}`,
      ...(body ?? {}),
      ...(includeText && !body && budget <= 0 ? { note: 'Not inlined: this handoff is too large to return at once. Call get with this artifact.' } : {})
    })
  }

  await markPickedUp(db, principal, handoff)
  const view = presentHandoff(handoff, origin)

  const listing = items
    .map((i, n) => `${n + 1}. ${i.title} (${i.type ?? 'file'}${i.made_by ? `, made by ${i.made_by}` : ''}) — ${i.canonical_url}`)
    .join('\n')

  return {
    text:
      `Handoff "${view.title}" from ${view.from}, in ${workspace.name}.\n\nBrief:\n${view.brief}\n\n` +
      `Artifacts:\n${listing}` +
      (hidden ? `\n(${hidden} more you do not have access to.)` : '') +
      `\n\nWhen you save what you make from this, it is linked to these artifacts automatically.`,
    structured: {
      handoff_id: view.id,
      title: view.title,
      brief: view.brief,
      from: view.from,
      to: view.toTool,
      status: view.status,
      workspace: { id: workspace.id, name: workspace.name },
      url: view.url,
      artifacts: items,
      ...(hidden ? { hidden_artifacts: hidden } : {})
    }
  }
}

async function toolListHandoffs(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>,
  origin: string
): Promise<ToolOutcome> {
  const workspaceIds =
    typeof args.workspace === 'string' && args.workspace.trim()
      ? await resolveWorkspaceScope(env.DB, principal, args.workspace)
      : undefined
  if (workspaceIds && !workspaceIds.length) return { text: 'No accessible workspace matches that.', structured: { handoffs: [] } }

  const rows = await listHandoffs(env.DB, principal, {
    workspaceIds,
    status: args.include_closed === true ? 'ALL' : 'OPEN'
  })
  const handoffs = rows.map((r) => presentHandoff(r, origin))
  if (!handoffs.length) return { text: 'No handoffs waiting.', structured: { handoffs: [] } }

  return {
    text:
      `${handoffs.length} handoff(s):\n` +
      handoffs
        .map((h) => `- ${h.id}: "${h.title}" from ${h.from}${h.toTool ? ` for ${h.toTool}` : ''}, ${h.artifactCount} artifact(s), ${h.status.toLowerCase().replace('_', ' ')}`)
        .join('\n'),
    structured: {
      handoffs: handoffs.map((h) => ({
        handoff_id: h.id,
        title: h.title,
        from: h.from,
        to: h.toTool,
        status: h.status,
        workspace: h.workspaceName,
        artifact_count: h.artifactCount,
        created_at: h.createdAt,
        url: h.url
      }))
    }
  }
}

async function toolListProjects(
  env: Env,
  principal: Principal,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const workspaceIds =
    typeof args.workspace === 'string' && args.workspace.trim()
      ? await resolveWorkspaceScope(env.DB, principal, args.workspace)
      : undefined
  if (workspaceIds && !workspaceIds.length) return { text: 'No accessible workspace matches that.', structured: { projects: [] } }

  const projects = await listProjects(env.DB, principal, workspaceIds)
  if (!projects.length) {
    return {
      text: 'No projects yet. A person can mark any collection as a project in the Artifactry app.',
      structured: { projects: [] }
    }
  }
  return {
    text: projects.map((p) => `- ${p.name} (${p.workspace_name}, ${p.artifact_count} artifact(s))`).join('\n'),
    structured: {
      projects: projects.map((p) => ({
        project_id: p.id,
        name: p.name,
        description: p.description,
        workspace: p.workspace_name,
        artifact_count: p.artifact_count
      }))
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
