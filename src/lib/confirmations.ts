/**
 * Confirmation gate for MCP actions that broaden access.
 *
 * An AI agent must never be able to widen who can see a document on its own
 * judgement. Public links, raw email/domain audiences and anything else that
 * takes content outside the organization therefore require an explicit human
 * "yes" that is recorded server-side.
 *
 * The design point that matters: a confirmation is bound to a **hash of the
 * exact normalised request** it authorises. Without that binding the model
 * could ask "share this with two colleagues?", receive a yes, and then execute
 * a public link — the flag would be the only thing carried forward and it would
 * say nothing about *what* was approved. Presenting a different request cannot
 * consume the confirmation, so the user's yes means precisely one thing.
 *
 * Confirmations expire (they are consent for a specific moment, not a standing
 * grant) and are single-use.
 */

import type { Principal } from '../types'
import { first, nowIso, run } from './db'
import { prefixed, ulid } from './ids'
import { badRequest } from './http'
import { recordAudit } from './audit'

/** How long a human has to answer. Long enough to read the prompt and reply. */
export const CONFIRMATION_TTL_SECONDS = 900

export interface ConfirmationRow {
  id: string
  user_id: string
  grant_id: string | null
  tool: string
  request_hash: string
  params_json: string
  summary: string
  audience_note: string | null
  status: 'PENDING' | 'CONSUMED' | 'CANCELLED' | 'EXPIRED'
  created_at: string
  expires_at: string
  consumed_at: string | null
}

/**
 * Stable hash of a normalised request.
 *
 * Keys are sorted and undefined values dropped so that key order or an omitted
 * optional field cannot change the identity of a request — otherwise a
 * trivially re-serialised but identical request would fail to match its own
 * confirmation and the user would be asked twice for the same thing.
 */
export async function hashRequest(tool: string, params: Record<string, unknown>): Promise<string> {
  const normalized = normalizeValue(params)
  const canonical = `${tool}:${JSON.stringify(normalized)}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key]
      if (inner === undefined) continue
      out[key] = normalizeValue(inner)
    }
    return out
  }
  return value
}

export async function createConfirmation(
  db: D1Database,
  principal: Principal,
  input: {
    tool: string
    params: Record<string, unknown>
    summary: string
    audienceNote: string
  }
): Promise<ConfirmationRow> {
  if (!principal.userId) throw badRequest('A signed-in user is required')

  const requestHash = await hashRequest(input.tool, input.params)
  const now = Date.now()
  const id = prefixed('cnf', ulid())

  await run(
    db,
    `INSERT INTO mcp_confirmations
       (id, user_id, grant_id, tool, request_hash, params_json, summary, audience_note,
        status, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL)`,
    [
      id,
      principal.userId,
      principal.grantId ?? null,
      input.tool,
      requestHash,
      JSON.stringify(input.params),
      input.summary,
      input.audienceNote,
      nowIso(),
      new Date(now + CONFIRMATION_TTL_SECONDS * 1000).toISOString()
    ]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'AI_CONFIRM_REQUESTED',
    targetType: 'confirmation',
    targetId: id,
    metadata: { tool: input.tool, summary: input.summary }
  })

  const row = await first<ConfirmationRow>(db, `SELECT * FROM mcp_confirmations WHERE id = ?`, [id])
  if (!row) throw new Error('Failed to create confirmation')
  return row
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' | 'MISMATCH' | 'EXPIRED' | 'ALREADY_USED' | 'WRONG_USER' | 'NOT_PENDING' }

/**
 * Consume a confirmation for the request being executed now.
 *
 * Every failure mode is distinct so the caller can tell the user something
 * actionable ("that confirmation was for a different share") instead of a flat
 * refusal that looks like a bug.
 */
export async function consumeConfirmation(
  db: D1Database,
  principal: Principal,
  confirmationId: string,
  tool: string,
  params: Record<string, unknown>
): Promise<ConsumeResult> {
  const row = await first<ConfirmationRow>(db, `SELECT * FROM mcp_confirmations WHERE id = ?`, [
    confirmationId
  ])
  if (!row) return { ok: false, reason: 'NOT_FOUND' }
  if (row.user_id !== principal.userId) return { ok: false, reason: 'WRONG_USER' }

  if (row.status === 'CONSUMED') return { ok: false, reason: 'ALREADY_USED' }
  if (row.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await run(db, `UPDATE mcp_confirmations SET status = 'EXPIRED' WHERE id = ?`, [row.id])
    return { ok: false, reason: 'EXPIRED' }
  }

  if (row.tool !== tool) return { ok: false, reason: 'MISMATCH' }

  const expected = await hashRequest(tool, params)
  if (expected !== row.request_hash) return { ok: false, reason: 'MISMATCH' }

  await run(
    db,
    `UPDATE mcp_confirmations SET status = 'CONSUMED', consumed_at = ? WHERE id = ?`,
    [nowIso(), row.id]
  )

  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'AI_CONFIRM_GRANTED',
    targetType: 'confirmation',
    targetId: row.id,
    metadata: { tool }
  })

  return { ok: true }
}

export async function cancelConfirmation(
  db: D1Database,
  principal: Principal,
  confirmationId: string
): Promise<void> {
  const row = await first<ConfirmationRow>(db, `SELECT * FROM mcp_confirmations WHERE id = ?`, [
    confirmationId
  ])
  if (!row || row.user_id !== principal.userId) return
  if (row.status !== 'PENDING') return

  await run(db, `UPDATE mcp_confirmations SET status = 'CANCELLED' WHERE id = ?`, [row.id])
  await recordAudit(db, {
    actorUserId: principal.userId,
    actorType: 'AI',
    action: 'AI_CONFIRM_DENIED',
    targetType: 'confirmation',
    targetId: row.id
  })
}

export function confirmationPrompt(row: ConfirmationRow) {
  return {
    status: 'confirmation_required' as const,
    confirmation_id: row.id,
    expires_at: row.expires_at,
    summary: row.summary,
    why: row.audience_note,
    instruction:
      'Ask the user to confirm this exact action. If they agree, call the same tool again with ' +
      'the same arguments plus confirmation_id set to the value above. Do not change any other ' +
      'argument — a modified request cannot use this confirmation and the user will be asked again.',
    safety: 'No share has been created yet. Nothing has been shared with anyone.'
  }
}

export const CONFIRM_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'That confirmation was not found. Ask the user to confirm again.',
  MISMATCH:
    'That confirmation was issued for a different request. Ask the user to confirm the action you are about to take.',
  EXPIRED: 'That confirmation has expired. Ask the user to confirm again.',
  ALREADY_USED: 'That confirmation has already been used. Ask the user to confirm again.',
  WRONG_USER: 'That confirmation does not belong to the connected account.',
  NOT_PENDING: 'That confirmation is no longer pending. Ask the user to confirm again.'
}
