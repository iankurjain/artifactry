/**
 * Personal access tokens, and the one list of everything that can act for a
 * person through the API.
 *
 * The auth model has two front doors:
 *
 *   1. OAuth 2.1 (lib/oauth.ts) for AI apps that can open a browser: Claude,
 *      ChatGPT, Cursor, Gemini. Short-lived access tokens, rotating refresh.
 *   2. Personal access tokens, here, for whatever cannot: scripts, scheduled
 *      agents, CI, MCP clients without OAuth. The person names the token,
 *      picks its scopes and expiry, sees it once, and can revoke it alone.
 *
 * Both are integration_grants rows (kind OAUTH or PAT), so the principal,
 * scope checks and `can()` treat them identically. Tokens pasted from the
 * older per-connector sheet are kind CONNECTOR and keep working.
 */

import type { AiScope, Principal } from '../types'
import { AI_SCOPES } from '../types'
import { all, first, nowIso, run } from './db'
import { hashGrantToken, tokenPrefix } from './crypto'
import { prefixed, randomToken, ulid } from './ids'
import { badRequest, forbidden, notFound } from './http'
import { recordAudit } from './audit'
import { validateScopes } from './ai'
import { CLIENT_LABELS } from './oauth'

/** Recognisable in logs and by secret scanners, like ghp_ or xoxb-. */
export const PAT_PREFIX = 'art_pat_'
/** How much of a token is kept in the clear to tell tokens apart. */
export const PAT_DISPLAY_PREFIX_LENGTH = PAT_PREFIX.length + 6
export const PAT_EXPIRY_DAYS = [7, 30, 90, 365] as const
export const DEFAULT_PAT_EXPIRY_DAYS = 90
export const DEFAULT_PAT_SCOPES: AiScope[] = ['artifact.read', 'artifact.write', 'artifact.share']
const MAX_ACTIVE_PATS = 50

/** PATs run as "Other MCP client", so their work is attributed to the API. */
const PAT_INTEGRATION_ID = 'int_other'

interface GrantListRow {
  id: string
  integration_id: string
  kind: string
  name: string | null
  scopes: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  client_name: string | null
  oauth_client_id: string | null
  oauth_client_name: string | null
  integration_name: string | null
}

function parseScopes(raw: string): AiScope[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s): s is AiScope => AI_SCOPES.includes(s)) : []
  } catch {
    return []
  }
}

function readExpiry(value: unknown): number | null {
  if (value === undefined) return DEFAULT_PAT_EXPIRY_DAYS
  if (value === null || value === 'never' || value === 0) return null
  const days = Number(value)
  if (!(PAT_EXPIRY_DAYS as readonly number[]).includes(days)) {
    throw badRequest(`expiresInDays must be one of ${PAT_EXPIRY_DAYS.join(', ')}, or null for no expiry`)
  }
  return days
}

/** Create a personal access token. The raw value is returned once, here only. */
export async function createPersonalAccessToken(
  db: D1Database,
  principal: Principal,
  input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown }
): Promise<{
  id: string
  name: string
  token: string
  tokenPrefix: string
  scopes: AiScope[]
  expiresAt: string | null
  createdAt: string
}> {
  // A token must never be able to mint more tokens: only a person, signed in
  // in a browser, creates one.
  if (principal.kind !== 'SESSION' || !principal.userId) {
    throw forbidden('Create access tokens from a signed-in browser session')
  }

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw badRequest('Give the token a name, such as "Nightly backup script"')
  if (name.length > 80) throw badRequest('Token name is too long (80 characters at most)')
  const scopes = validateScopes(input.scopes)
  const days = readExpiry(input.expiresInDays)

  const active = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM integration_grants
      WHERE user_id = ? AND kind = 'PAT' AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > ?)`,
    [principal.userId, nowIso()]
  )
  if ((active?.n ?? 0) >= MAX_ACTIVE_PATS) {
    throw badRequest(`You already have ${MAX_ACTIVE_PATS} active tokens. Revoke one you no longer use first.`)
  }

  const token = `${PAT_PREFIX}${randomToken(32)}`
  const id = prefixed('grt', ulid())
  const createdAt = nowIso()
  const expiresAt = days ? new Date(Date.now() + days * 86400 * 1000).toISOString() : null
  const prefix = tokenPrefix(token, PAT_DISPLAY_PREFIX_LENGTH)

  await run(
    db,
    `INSERT INTO integration_grants
       (id, integration_id, user_id, organization_id, scopes, token_hash, token_prefix,
        status, created_at, last_used_at, revoked_at, expires_at, kind, name)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, ?, 'PAT', ?)`,
    [id, PAT_INTEGRATION_ID, principal.userId, JSON.stringify(scopes), await hashGrantToken(token), prefix, createdAt, expiresAt, name]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'USER',
    action: 'TOKEN_CREATE',
    targetType: 'grant',
    targetId: id,
    metadata: { name, scopes, expiresAt }
  })

  return { id, name, token, tokenPrefix: prefix, scopes, expiresAt, createdAt }
}

/**
 * Everything that can currently act for this person: AI apps signed in with
 * OAuth (one row per app, so claude.ai and Claude Code are revoked apart),
 * personal access tokens, and tokens pasted from the older Connect sheet.
 */
export async function listAccess(db: D1Database, userId: string) {
  const rows = await all<GrantListRow>(
    db,
    `SELECT g.id, g.integration_id, g.kind, g.name, g.scopes, g.token_prefix, g.created_at,
            g.last_used_at, g.expires_at, g.client_name, g.oauth_client_id,
            oc.client_name AS oauth_client_name, i.name AS integration_name
       FROM integration_grants g
       LEFT JOIN oauth_clients oc ON oc.id = g.oauth_client_id
       LEFT JOIN integrations i ON i.id = g.integration_id
      WHERE g.user_id = ? AND g.status = 'ACTIVE'
      ORDER BY g.created_at DESC`,
    [userId]
  )
  const now = Date.now()

  const connections = rows
    .filter((r) => r.kind === 'OAUTH')
    .map((r) => ({
      id: r.id,
      app: CLIENT_LABELS[r.integration_id] ?? 'An AI app',
      // What the app reported during its MCP handshake, else what it
      // registered as ("Claude Code", "Cursor").
      client: r.client_name ?? r.oauth_client_name ?? null,
      scopes: parseScopes(r.scopes),
      connectedAt: r.created_at,
      lastUsedAt: r.last_used_at
    }))

  const tokens = rows
    .filter((r) => r.kind === 'PAT')
    .map((r) => ({
      id: r.id,
      name: r.name ?? 'Untitled token',
      tokenPrefix: r.token_prefix,
      scopes: parseScopes(r.scopes),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      expired: !!r.expires_at && Date.parse(r.expires_at) <= now
    }))

  const legacyTokens = rows
    .filter((r) => r.kind !== 'OAUTH' && r.kind !== 'PAT')
    .map((r) => ({
      id: r.id,
      name: r.integration_name ?? 'AI app',
      tokenPrefix: r.token_prefix,
      scopes: parseScopes(r.scopes),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at
    }))

  return { connections, tokens, legacyTokens }
}

/** The latest tool calls one connection or token made, from the audit trail. */
export async function grantActivity(db: D1Database, userId: string, grantId: string, limit = 25) {
  const grant = await first<{ id: string }>(
    db,
    `SELECT id FROM integration_grants WHERE id = ? AND user_id = ?`,
    [grantId, userId]
  )
  if (!grant) throw notFound('Connection not found')

  const rows = await all<{ metadata_json: string; occurred_at: string }>(
    db,
    `SELECT metadata_json, occurred_at FROM audit_events
      WHERE target_type = 'grant' AND target_id = ? AND action = 'AI_TOOL_CALL'
        AND actor_user_id = ?
      ORDER BY occurred_at DESC LIMIT ?`,
    [grantId, userId, Math.min(Math.max(limit, 1), 100)]
  )
  return rows.map((r) => {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(r.metadata_json)
    } catch {
      meta = {}
    }
    return {
      tool: typeof meta.tool === 'string' ? meta.tool : null,
      outcome: typeof meta.outcome === 'string' ? meta.outcome : null,
      client: typeof meta.client === 'string' ? meta.client : null,
      at: r.occurred_at
    }
  })
}
