/**
 * AI connector management, MCP transport and profile routes.
 *
 *   GET    /api/v1/integrations                 → available connectors (§60)
 *   POST   /api/v1/integrations/:id/connect     → issue a scoped grant (§58)
 *   DELETE /api/v1/integrations/grants/:grantId → disconnect (§60)
 *   POST   /api/v1/mcp                          → JSON-RPC 2.0 MCP endpoint (§51, §53)
 *   GET    /api/v1/mcp                          → capability discovery (405 for SSE)
 *   PUT    /api/v1/uploads/:uploadId            → whole file for a staged upload (upload_part)
 *   POST   /api/v1/integrations/oauth-clients   → client id + secret for manual OAuth setup
 *   GET    /api/v1/access                       → OAuth connections + personal access tokens
 *   GET    /api/v1/access/:grantId/activity     → recent tool calls by one of them
 *   POST   /api/v1/tokens                       → create a personal access token (shown once)
 *   DELETE /api/v1/tokens/:grantId              → revoke one token
 *   GET    /api/v1/activity                     → cross-artifact activity feed
 *   GET    /api/v1/profile                      → profile + settings summary (§89)
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requireAiPrincipal, requirePrincipal } from '../middleware'
import {
  connectIntegration,
  connectedIntegrations,
  disconnectIntegration,
  listIntegrations,
  validateScopes
} from '../lib/ai'
import { handleMcpRequest, MCP_TOOLS, type McpRequest } from '../lib/mcp-jobs'
import { OAuthError, createManualClient } from '../lib/oauth'
import { UploadError, putBody } from '../lib/uploads'
import { all, first, nowIso, run } from '../lib/db'
import { badRequest, notFound, ok, readBearer, readJson } from '../lib/http'
import { tokenPrefix } from '../lib/crypto'
import { AI_SCOPES } from '../types'
import { effectiveWorkspaceRole, readableWorkspaces } from '../lib/principal'
import { actorDisplay } from '../lib/analytics'
import { recordAudit } from '../lib/audit'
import { madeByLabel } from '../lib/handoffs'
import {
  DEFAULT_PAT_EXPIRY_DAYS,
  DEFAULT_PAT_SCOPES,
  PAT_EXPIRY_DAYS,
  createPersonalAccessToken,
  grantActivity,
  listAccess
} from '../lib/tokens'

const integrations = new Hono<AppEnv>()

// ---------------------------------------------------------------
// Connector management (§60)
// ---------------------------------------------------------------

integrations.get(
  '/integrations',
  guarded(async (c) => {
    const principal = requirePrincipal(c)

    const [available, mine, grants] = await Promise.all([
      listIntegrations(c.env.DB),
      connectedIntegrations(c.env.DB, principal.userId!),
      all<{ provider: string; client_name: string | null; last_used_at: string | null }>(
        c.env.DB,
        `SELECT i.provider, g.client_name, g.last_used_at
           FROM integration_grants g JOIN integrations i ON i.id = g.integration_id
          WHERE g.user_id = ? AND g.status = 'ACTIVE'`,
        [principal.userId]
      )
    ])

    // Which tools are connected, by the name a person would use ("Cursor"),
    // so the Connect screen can mark each tool's card.
    const connectedTools = new Map<string, string | null>()
    for (const g of grants) {
      const label = madeByLabel(g.provider, g.client_name)
      if (!label) continue
      const seen = connectedTools.get(label)
      if (seen === undefined || (g.last_used_at && (!seen || g.last_used_at > seen))) {
        connectedTools.set(label, g.last_used_at)
      }
    }

    return ok(c, {
      availableScopes: AI_SCOPES,
      integrations: mine.length
        ? mine
        : available.map((i) => ({
            integrationId: i.id,
            provider: i.provider,
            name: i.name,
            description: i.description,
            connected: false,
            scopes: [],
            tokenPrefix: null,
            grantId: null,
            lastUsedAt: null
          })),
      mcpEndpoint: `${new URL(c.req.url).origin}/api/v1/mcp`,
      toolCount: MCP_TOOLS.length,
      connectedTools: [...connectedTools].map(([name, lastUsedAt]) => ({ name, lastUsedAt }))
    })
  })
)

integrations.post(
  '/integrations/:integrationId/connect',
  rateLimit({ bucket: 'ai:connect', limit: 20, windowSeconds: 600 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const integrationId = c.req.param('integrationId')

    const body = await readJson<{ scopes?: unknown }>(c)
    const scopes = validateScopes(body.scopes)

    const result = await connectIntegration(c.env.DB, principal, integrationId, scopes)

    return ok(
      c,
      {
        grantId: result.grantId,
        provider: result.provider,
        scopes: result.scopes,
        // Returned exactly once. The UI must not expect to fetch it again.
        token: result.token,
        mcpEndpoint: `${new URL(c.req.url).origin}/api/v1/mcp`,
        note:
          'Copy this token into your AI application now — it is stored only as a hash and cannot be shown again.'
      },
      201
    )
  })
)

integrations.delete(
  '/integrations/grants/:grantId',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    await disconnectIntegration(c.env.DB, principal, c.req.param('grantId'))
    return ok(c, { disconnected: true })
  })
)

// ---------------------------------------------------------------
// MCP transport (§51, §53, §54)
// ---------------------------------------------------------------

/**
 * Capability discovery, so a connector can be verified without a session.
 *
 * Streamable HTTP clients open GET with `Accept: text/event-stream` to ask for
 * a server-initiated stream. This server never pushes, and the spec's answer
 * for that is 405 — returning a JSON 200 there makes strict clients treat the
 * endpoint as broken.
 */
integrations.get(
  '/mcp',
  guarded(async (c) => {
    if ((c.req.header('Accept') ?? '').includes('text/event-stream')) {
      c.header('Allow', 'POST')
      return c.body(null, 405)
    }
    const origin = new URL(c.req.url).origin
    return ok(c, {
      protocol: 'mcp',
      transport: 'streamable-http (JSON responses)',
      endpoint: `${origin}/api/v1/mcp`,
      authentication: {
        oauth: `${origin}/.well-known/oauth-protected-resource/api/v1/mcp`,
        bearer: 'Bearer <AI access token from POST /api/v1/integrations/:id/connect>'
      },
      tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.requiredScope }))
    })
  })
)

/** Sessions are not used, so there is nothing to terminate. */
integrations.delete('/mcp', (c) => {
  c.header('Allow', 'POST')
  return c.body(null, 405)
})

/** A JSON-RPC notification has no id and gets no response body (202). */
function isNotification(req: McpRequest): boolean {
  return (req as { id?: unknown }).id === undefined && typeof req.method === 'string'
}

integrations.post(
  '/mcp',
  // Keyed by connection, not IP: every ChatGPT or Claude user reaches us from
  // the same few provider egress addresses, so a per-IP budget would be shared
  // by all of them. The token prefix is already stored on the grant row.
  rateLimit({
    bucket: 'mcp',
    limit: 600,
    windowSeconds: 300,
    keyFrom: (c) => {
      const bearer = readBearer(c)
      // Long enough to get past a personal access token's fixed art_pat_ prefix.
      return bearer ? `t:${tokenPrefix(bearer, 20)}` : `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`
    }
  }),
  guarded(async (c) => {
    // Every MCP call must carry a grant; anonymous MCP is never allowed (§59).
    // The 401 this throws carries WWW-Authenticate (see index.tsx), which is
    // how an OAuth client learns where to sign in.
    const principal = requireAiPrincipal(c)

    const payload = await readJson<McpRequest | McpRequest[]>(c)
    const origin = new URL(c.req.url).origin

    // Support batched requests, which older MCP clients use during discovery
    if (Array.isArray(payload)) {
      const responses = await Promise.all(
        payload.map(async (req) => {
          const res = await handleMcpRequest(c.env, principal, req, origin)
          return isNotification(req) ? null : res
        })
      )
      const replies = responses.filter((r) => r !== null)
      return replies.length ? c.json(replies) : c.body(null, 202)
    }

    const response = await handleMcpRequest(c.env, principal, payload, origin)
    if (isNotification(payload)) return c.body(null, 202)
    return c.json(response)
  })
)

// ---------------------------------------------------------------
// Staged uploads
//
// The other half of the upload_part tool: a client that can run code sends
// the whole file here in one request, then calls save with the upload_id.
// The id in the path is the credential (see lib/uploads.ts), so this takes no
// session or bearer token. POST is accepted too for tools that cannot PUT.
// ---------------------------------------------------------------

const receiveUpload = guarded(async (c) => {
  try {
    const bytes = await putBody(c.env, c.req.param('uploadId') ?? '', c.req.raw.body)
    return ok(c, { upload_id: c.req.param('uploadId'), bytes_received: bytes })
  } catch (err) {
    if (err instanceof UploadError) throw badRequest(err.message)
    throw err
  }
})
const uploadLimit = rateLimit({ bucket: 'upload:put', limit: 60, windowSeconds: 600 })
integrations.put('/uploads/:uploadId', uploadLimit, receiveUpload)
integrations.post('/uploads/:uploadId', uploadLimit, receiveUpload)

// ---------------------------------------------------------------
// Manual OAuth clients
//
// Gemini Enterprise and Copilot Studio ("Manual") ask for a client id and
// secret instead of registering themselves. A signed-in user creates one here
// and pastes it into that app; the secret is shown once.
// ---------------------------------------------------------------

integrations.post(
  '/integrations/oauth-clients',
  rateLimit({ bucket: 'oauth:manual-client', limit: 20, windowSeconds: 3600 }),
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    if (principal.kind !== 'SESSION') throw badRequest('Create OAuth clients from a signed-in browser session')
    const body = await readJson<{ name?: unknown; redirect_uris?: unknown; provider?: unknown }>(c)
    try {
      const created = await createManualClient(c.env.DB, principal, body)
      const origin = new URL(c.req.url).origin
      return ok(
        c,
        {
          ...created,
          authorization_url: `${origin}/oauth/authorize`,
          token_url: `${origin}/oauth/token`,
          refresh_url: `${origin}/oauth/token`,
          scopes: 'artifact.read artifact.write artifact.share workspace.read team.read tags.read',
          mcp_url: `${origin}/api/v1/mcp`,
          note: 'Copy the client secret now — it is stored only as a hash and cannot be shown again.'
        },
        201
      )
    } catch (err) {
      if (err instanceof OAuthError) throw badRequest(err.message)
      throw err
    }
  })
)

// ---------------------------------------------------------------
// Access: OAuth connections and personal access tokens
//
// Managing credentials is a person's job, so every route here needs a browser
// session: a token can neither list, mint nor revoke tokens.
// ---------------------------------------------------------------

function requireSession(c: Parameters<typeof requirePrincipal>[0]) {
  const principal = requirePrincipal(c)
  if (principal.kind !== 'SESSION') throw badRequest('Manage access from a signed-in browser session')
  return principal
}

integrations.get(
  '/access',
  guarded(async (c) => {
    const principal = requireSession(c)
    return ok(c, {
      ...(await listAccess(c.env.DB, principal.userId!)),
      availableScopes: AI_SCOPES,
      defaultTokenScopes: DEFAULT_PAT_SCOPES,
      tokenExpiryDays: PAT_EXPIRY_DAYS,
      defaultTokenExpiryDays: DEFAULT_PAT_EXPIRY_DAYS,
      mcpEndpoint: `${new URL(c.req.url).origin}/api/v1/mcp`
    })
  })
)

integrations.get(
  '/access/:grantId/activity',
  guarded(async (c) => {
    const principal = requireSession(c)
    const limit = Number(c.req.query('limit') ?? 25) || 25
    return ok(c, { activity: await grantActivity(c.env.DB, principal.userId!, c.req.param('grantId'), limit) })
  })
)

integrations.post(
  '/tokens',
  rateLimit({ bucket: 'pat:create', limit: 20, windowSeconds: 600 }),
  guarded(async (c) => {
    const principal = requireSession(c)
    const body = await readJson<{ name?: unknown; scopes?: unknown; expiresInDays?: unknown }>(c)
    const created = await createPersonalAccessToken(c.env.DB, principal, body)
    return ok(
      c,
      {
        ...created,
        mcpEndpoint: `${new URL(c.req.url).origin}/api/v1/mcp`,
        note: 'Copy this token now. It is stored only as a hash and cannot be shown again.'
      },
      201
    )
  })
)

integrations.delete(
  '/tokens/:grantId',
  guarded(async (c) => {
    const principal = requireSession(c)
    await disconnectIntegration(c.env.DB, principal, c.req.param('grantId'))
    return ok(c, { revoked: true })
  })
)

// ---------------------------------------------------------------
// Activity feed (§43–§46 owner view, used by Home and Profile)
// ---------------------------------------------------------------

integrations.get(
  '/activity',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 100)

    const workspaces = await readableWorkspaces(c.env.DB, principal)
    const ids = workspaces.map((w) => w.id)
    if (!ids.length) return ok(c, { activity: [] })

    const rows = await all<{
      event_type: string
      actor_label: string | null
      actor_type: string
      ai_provider: string | null
      access_channel: string
      occurred_at: string
      artifact_id: string | null
      title: string | null
      extension: string | null
    }>(
      c.env.DB,
      `SELECT e.event_type, e.actor_label, e.actor_type, e.ai_provider, e.access_channel,
              e.occurred_at, e.artifact_id, a.title, a.extension
         FROM artifact_events e
         LEFT JOIN artifacts a ON a.id = e.artifact_id
        WHERE e.workspace_id IN (${ids.map(() => '?').join(',')})
          AND e.event_type IN ('artifact_viewed','artifact_downloaded','artifact_ai_referenced','artifact_shared','artifact_version_created')
        ORDER BY e.occurred_at DESC
        LIMIT ?`,
      [...ids, limit]
    )

    return ok(c, {
      activity: rows.map((r) => ({
        event: r.event_type,
        actor: actorDisplay({
          event_type: r.event_type,
          actor_label: r.actor_label,
          actor_type: r.actor_type,
          ai_provider: r.ai_provider,
          access_channel: r.access_channel,
          occurred_at: r.occurred_at
        }),
        channel: r.access_channel,
        at: r.occurred_at,
        artifact: r.artifact_id
          ? { id: r.artifact_id, title: r.title, extension: r.extension }
          : null
      }))
    })
  })
)

// ---------------------------------------------------------------
// Profile (§89)
// ---------------------------------------------------------------

integrations.get(
  '/profile',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const userId = principal.userId!

    const workspaces = await readableWorkspaces(c.env.DB, principal)

    const organizations = await all<{ id: string; name: string; role: string; plan: string }>(
      c.env.DB,
      `SELECT o.id, o.name, om.role, o.plan
         FROM organizations o
         JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = ? AND om.status = 'ACTIVE'`,
      [userId]
    )

    const activeShares = await all<{
      id: string
      access_type: string
      expires_at: string | null
      created_at: string
      target_type: string
      target_id: string
      title: string | null
    }>(
      c.env.DB,
      `SELECT s.id, s.access_type, s.expires_at, s.created_at, s.target_type, s.target_id,
              COALESCE(a.title, col.name) AS title
         FROM shares s
         LEFT JOIN artifacts a ON s.target_type = 'ARTIFACT' AND a.id = s.target_id
         LEFT JOIN collections col ON s.target_type = 'COLLECTION' AND col.id = s.target_id
        WHERE s.created_by_user_id = ? AND s.status = 'ACTIVE'
        ORDER BY s.created_at DESC LIMIT 25`,
      [userId]
    )

    const usage = await first<{
      artifacts: number
      bytes: number
      downloads: number
      views: number
    }>(
      c.env.DB,
      `SELECT
         (SELECT COUNT(*) FROM artifacts a WHERE a.owner_user_id = ? AND a.deleted_at IS NULL) AS artifacts,
         (SELECT COALESCE(SUM(a.size_bytes), 0) FROM artifacts a WHERE a.owner_user_id = ? AND a.deleted_at IS NULL) AS bytes,
         (SELECT COALESCE(SUM(m.downloads), 0) FROM artifact_daily_metrics m
            JOIN artifacts a ON a.id = m.artifact_id WHERE a.owner_user_id = ?) AS downloads,
         (SELECT COALESCE(SUM(m.views), 0) FROM artifact_daily_metrics m
            JOIN artifacts a ON a.id = m.artifact_id WHERE a.owner_user_id = ?) AS views`,
      [userId, userId, userId, userId]
    )

    const integrationsList = await connectedIntegrations(c.env.DB, userId)

    return ok(c, {
      user: {
        id: principal.user!.id,
        email: principal.user!.email,
        displayName: principal.user!.display_name,
        createdAt: principal.user!.created_at
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        type: w.workspace_type,
        role: effectiveWorkspaceRole(principal, w)
      })),
      organizations,
      activeShares: activeShares.map((s) => ({
        id: s.id,
        targetType: s.target_type,
        targetId: s.target_id,
        title: s.title,
        accessType: s.access_type,
        expiresAt: s.expires_at,
        createdAt: s.created_at,
        isExpired: !!s.expires_at && new Date(s.expires_at).getTime() <= Date.now()
      })),
      usage: {
        artifacts: usage?.artifacts ?? 0,
        bytes: usage?.bytes ?? 0,
        downloads: usage?.downloads ?? 0,
        views: usage?.views ?? 0
      },
      integrations: integrationsList,
      devMode: !c.env.EMAIL_API_KEY
    })
  })
)

integrations.patch(
  '/profile',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const body = await readJson<{ displayName?: string }>(c)

    const name = (body.displayName ?? '').trim()
    if (!name) throw badRequest('Display name cannot be empty')
    if (name.length > 80) throw badRequest('Display name is too long')

    await run(c.env.DB, `UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`, [
      name,
      nowIso(),
      principal.userId
    ])

    return ok(c, { updated: true, displayName: name })
  })
)

/**
 * Organization-level privacy setting for external viewer identity (§48).
 * Default is OFF: anonymous viewers are never identified.
 */
integrations.patch(
  '/organizations/:orgId/settings',
  guarded(async (c) => {
    const principal = requirePrincipal(c)
    const orgId = c.req.param('orgId')

    const role = principal.orgRoles[orgId]
    if (role !== 'ORG_OWNER' && role !== 'ORG_ADMIN') {
      throw notFound('Organization not found')
    }

    const body = await readJson<{ showVerifiedExternalViewerIdentity?: boolean }>(c)

    const org = await first<{ settings_json: string }>(
      c.env.DB,
      `SELECT settings_json FROM organizations WHERE id = ?`,
      [orgId]
    )
    if (!org) throw notFound('Organization not found')

    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(org.settings_json)
    } catch {
      settings = {}
    }

    if (typeof body.showVerifiedExternalViewerIdentity === 'boolean') {
      settings.showVerifiedExternalViewerIdentity = body.showVerifiedExternalViewerIdentity
    }

    await run(c.env.DB, `UPDATE organizations SET settings_json = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(settings),
      nowIso(),
      orgId
    ])

    return ok(c, { settings })
  })
)

export default integrations
