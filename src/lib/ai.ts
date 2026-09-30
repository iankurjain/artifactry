/**
 * AI integration layer — PRD §50–§60.
 *
 * The platform treats AI applications as first-class clients that act as a
 * *delegated* actor. Two invariants are enforced here:
 *
 *   1. AI permission <= authenticated user's permission (§59). A grant never
 *      widens authority; `can()` in lib/principal re-checks every action
 *      against the user's real role in addition to the token's scopes.
 *   2. Connector capability is separate from provider UI capability (§52).
 *      A tool exists and is documented even when a given AI client cannot
 *      currently call it.
 */

import type { AiScope, Env, Principal, SourceProvider } from '../types'
import { AI_SCOPES } from '../types'
import { all, first, nowIso, run } from './db'
import { hashGrantToken, tokenPrefix } from './crypto'
import { prefixed, randomToken, ulid } from './ids'
import { badRequest, forbidden, notFound } from './http'
import { recordAudit, type AuditAction } from './audit'

/** Provider-specific source attribution (§15, §16). */
export function sourceTypeForProvider(
  provider: SourceProvider
): 'CHATGPT' | 'CLAUDE' | 'GEMINI' | 'COPILOT' | 'API' {
  switch (provider) {
    case 'CHATGPT':
      return 'CHATGPT'
    case 'CLAUDE':
      return 'CLAUDE'
    case 'GEMINI':
      return 'GEMINI'
    case 'COPILOT':
      return 'COPILOT'
    default:
      return 'API'
  }
}

export interface IntegrationRow {
  id: string
  organization_id: string | null
  user_id: string | null
  provider: string
  name: string
  description: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface GrantRow {
  id: string
  integration_id: string
  user_id: string
  organization_id: string | null
  scopes: string
  token_prefix: string
  status: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export const PROVIDER_ACTIONS: Record<string, AuditAction> = {
  CHATGPT: 'AI_CONNECT',
  CLAUDE: 'AI_CONNECT',
  GEMINI: 'AI_CONNECT',
  COPILOT: 'AI_CONNECT'
}

export async function listIntegrations(db: D1Database): Promise<IntegrationRow[]> {
  return all<IntegrationRow>(
    db,
    `SELECT * FROM integrations WHERE status = 'ACTIVE' ORDER BY provider ASC`
  )
}

/** Connectors the user has connected, for the Settings screen (§60). */
export async function connectedIntegrations(
  db: D1Database,
  userId: string
): Promise<
  Array<{
    integrationId: string
    provider: string
    name: string
    description: string | null
    connected: boolean
    scopes: AiScope[]
    tokenPrefix: string | null
    grantId: string | null
    lastUsedAt: string | null
  }>
> {
  const integrations = await listIntegrations(db)
  const grants = await all<GrantRow>(
    db,
    `SELECT * FROM integration_grants
      WHERE user_id = ? AND status = 'ACTIVE'
      ORDER BY created_at DESC`,
    [userId]
  )

  const byIntegration = new Map<string, GrantRow>()
  for (const grant of grants) {
    if (!byIntegration.has(grant.integration_id)) byIntegration.set(grant.integration_id, grant)
  }

  return integrations.map((integration) => {
    const grant = byIntegration.get(integration.id) ?? null
    let scopes: AiScope[] = []
    if (grant) {
      try {
        const parsed = JSON.parse(grant.scopes)
        if (Array.isArray(parsed)) scopes = parsed as AiScope[]
      } catch {
        scopes = []
      }
    }
    return {
      integrationId: integration.id,
      provider: integration.provider,
      name: integration.name,
      description: integration.description,
      connected: !!grant,
      scopes,
      tokenPrefix: grant?.token_prefix ?? null,
      grantId: grant?.id ?? null,
      lastUsedAt: grant?.last_used_at ?? null
    }
  })
}

export function validateScopes(requested: unknown): AiScope[] {
  if (!Array.isArray(requested) || !requested.length) {
    throw badRequest('Select at least one scope')
  }
  const out: AiScope[] = []
  for (const scope of requested) {
    if (typeof scope !== 'string') throw badRequest('Scopes must be strings')
    if (!AI_SCOPES.includes(scope as AiScope)) {
      throw badRequest(`Unknown scope "${scope}". Supported: ${AI_SCOPES.join(', ')}`)
    }
    if (!out.includes(scope as AiScope)) out.push(scope as AiScope)
  }
  return out
}

/**
 * Connect an AI application on behalf of the signed-in user.
 * Returns the raw token exactly once; only its hash is stored.
 */
export async function connectIntegration(
  db: D1Database,
  principal: Principal,
  integrationId: string,
  scopes: AiScope[]
): Promise<{ grantId: string; token: string; provider: string; scopes: AiScope[] }> {
  if (!principal.userId) throw forbidden()

  const integration = await first<IntegrationRow>(
    db,
    `SELECT * FROM integrations WHERE id = ? AND status = 'ACTIVE'`,
    [integrationId]
  )
  if (!integration) throw notFound('Connector not found')

  // Reconnecting replaces the previous grant so old tokens stop working
  await run(
    db,
    `UPDATE integration_grants SET status = 'REVOKED', revoked_at = ?
      WHERE user_id = ? AND integration_id = ? AND status = 'ACTIVE'`,
    [nowIso(), principal.userId, integrationId]
  )

  const token = randomToken(32)
  const tokenHash = await hashGrantToken(token)
  const grantId = prefixed('grt', ulid())

  await run(
    db,
    `INSERT INTO integration_grants
       (id, integration_id, user_id, organization_id, scopes, token_hash, token_prefix,
        status, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'ACTIVE', ?, NULL, NULL)`,
    [
      grantId,
      integrationId,
      principal.userId,
      JSON.stringify(scopes),
      tokenHash,
      tokenPrefix(token),
      nowIso()
    ]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'USER',
    action: 'AI_CONNECT',
    targetType: 'integration',
    targetId: integrationId,
    metadata: { provider: integration.provider, scopes }
  })

  return { grantId, token, provider: integration.provider, scopes }
}

export async function disconnectIntegration(
  db: D1Database,
  principal: Principal,
  grantId: string
): Promise<void> {
  if (!principal.userId) throw forbidden()

  const grant = await first<GrantRow>(
    db,
    `SELECT * FROM integration_grants WHERE id = ? AND user_id = ?`,
    [grantId, principal.userId]
  )
  if (!grant) throw notFound('Connection not found')

  await run(
    db,
    `UPDATE integration_grants SET status = 'REVOKED', revoked_at = ? WHERE id = ?`,
    [nowIso(), grantId]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'USER',
    action: 'AI_DISCONNECT',
    targetType: 'integration',
    targetId: grant.integration_id,
    metadata: { grantId }
  })
}

/**
 * Provider detected from a request. Used for provenance and to bucket
 * analytics by channel (§44 "AI Usage", §49 "AI_provider").
 */
export function detectProvider(header: string | null | undefined, fallback: SourceProvider = 'API'): SourceProvider {
  if (!header) return fallback
  const value = header.toLowerCase()
  if (value.includes('chatgpt') || value.includes('openai')) return 'CHATGPT'
  if (value.includes('claude') || value.includes('anthropic')) return 'CLAUDE'
  if (value.includes('gemini') || value.includes('google')) return 'GEMINI'
  if (value.includes('copilot') || value.includes('microsoft')) return 'COPILOT'
  return fallback
}
