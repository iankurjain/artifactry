/**
 * Identity: passwordless email OTP / magic link (PRD §5), session management,
 * and the personal-workspace bootstrap that every new user receives (§6).
 *
 * Email delivery is an abstraction. When EMAIL_API_KEY is present we call a
 * transactional provider; otherwise the app runs in **dev-code mode**, where
 * the code is returned in the API response and written to processing logs.
 * Dev-code mode is refused automatically once an API key is configured, so it
 * cannot be left on by accident in production.
 */

import type { Env, UserRow } from '../types'
import { addDays, batch, first, nowIso, ps, run } from './db'
import { hashOtp, hashSessionToken } from './crypto'
import { otpCode, prefixed, randomToken, ulid } from './ids'
import { badRequest, forbidden } from './http'
import { normalizeEmail } from './validate'

export const OTP_TTL_MINUTES = 10
export const OTP_MAX_ATTEMPTS = 6
export const OTP_RESEND_COOLDOWN_SECONDS = 30

export function devCodeMode(env: Env): boolean {
  // A real email provider always wins; dev mode is impossible once configured.
  if (env.EMAIL_API_KEY) return false
  if (env.DEV_LOGIN_MODE === 'false') return false
  return true
}

/**
 * The fixed code for the directory-review account, or null when that sign-in
 * is off or `email` is not the reviewer's. Only an 8-digit code switches it on,
 * so a short or mistyped secret can never become an easy-to-guess login.
 */
export function reviewerCode(env: Env, emailNormalized: string): string | null {
  const reviewer = (env.REVIEWER_EMAIL ?? '').trim().toLowerCase()
  const code = (env.REVIEWER_CODE ?? '').trim()
  if (!reviewer || !/^\d{8}$/.test(code)) return null
  return emailNormalized === reviewer ? code : null
}

export interface DeliverResult {
  deliveredVia: 'EMAIL' | 'DEV_CONSOLE' | 'REVIEWER'
  devCode?: string
}

/**
 * Send a transactional email through the configured provider.
 * Implemented against Resend's HTTP API; swap the body for another provider
 * without touching callers.
 */
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string
): Promise<DeliverResult> {
  // Reached only when dev-code mode is off. If that happened without an API
  // key (e.g. DEV_LOGIN_MODE=false but no provider configured), failing loudly
  // is the only honest outcome — silently reporting success would tell the
  // caller a code was emailed when nothing was sent.
  if (!env.EMAIL_API_KEY) {
    console.error('[email] no provider configured but dev-code mode is disabled')
    throw badRequest('Email delivery is not configured. Please contact the administrator.')
  }

  const from = env.EMAIL_FROM ?? 'Artifactry <no-reply@artifactry.app>'
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error('[email] provider rejected send', response.status, detail)
    throw badRequest('Could not send email. Please try again shortly.')
  }

  return { deliveredVia: 'EMAIL' }
}

/**
 * Issue a one-time code for LOGIN or SHARE_ACCESS.
 * Any previously outstanding code for the same purpose is invalidated so
 * only the newest code can be redeemed.
 */
export async function issueOtp(
  env: Env,
  emailNormalized: string,
  purpose: 'LOGIN' | 'SHARE_ACCESS',
  shareId: string | null = null
): Promise<DeliverResult> {
  const db = env.DB

  const recent = await first<{ created_at: string }>(
    db,
    `SELECT created_at FROM auth_otp
      WHERE email_normalized = ? AND purpose = ?
      ORDER BY created_at DESC LIMIT 1`,
    [emailNormalized, purpose]
  )
  if (recent) {
    const elapsed = (Date.now() - new Date(recent.created_at).getTime()) / 1000
    if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
      throw badRequest(
        `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed)}s before requesting another code.`
      )
    }
  }

  // The directory-review account signs in with its fixed code and gets no
  // email: reviewers cannot read an inbox we control.
  const fixed = purpose === 'LOGIN' ? reviewerCode(env, emailNormalized) : null
  const code = fixed ?? otpCode(6)
  const codeHash = await hashOtp(emailNormalized, code, purpose)
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString()
  const mode = devCodeMode(env)

  // Deliver first; mutate state second.
  //
  // `delivered_via` has to describe what actually happened. Previously the row
  // was written before the provider was called and hard-coded to 'EMAIL', so a
  // rejected send still produced a row claiming email delivery. It also burned
  // the resend cooldown and invalidated any code the recipient already had,
  // even though nothing reached them.
  //
  // sendEmail() throws on a provider rejection, so a failed send now leaves the
  // database untouched: no false record, no cooldown consumed, and a code
  // already sitting in the recipient's inbox keeps working.
  let deliveredVia: 'EMAIL' | 'DEV_CONSOLE' | 'REVIEWER'

  if (fixed) {
    deliveredVia = 'REVIEWER'
  } else if (mode) {
    console.log(`[dev-code] ${purpose} code for ${emailNormalized}: ${code}`)
    deliveredVia = 'DEV_CONSOLE'
  } else {
    const subject =
      purpose === 'LOGIN'
        ? 'Your Artifactry sign-in code'
        : 'Verify your email to open this share'
    const html = `
    <div style="font-family:Inter,system-ui,-apple-system,sans-serif;max-width:480px">
      <div style="font-size:13px;font-weight:620;color:#4e7a00;letter-spacing:.01em;margin:0 0 18px">Artifactry</div>
      <h2 style="font-size:18px;margin:0 0 12px;color:#12151c">Your verification code</h2>
      <p style="font-size:24px;letter-spacing:4px;font-weight:700;margin:0 0 16px;color:#12151c">${code}</p>
      <p style="color:#5a6066;font-size:14px">
        This code expires in ${OTP_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.
      </p>
    </div>`

    await sendEmail(env, emailNormalized, subject, html)
    deliveredVia = 'EMAIL'
  }

  // Delivery is confirmed, so it is now safe to consume the previous code and
  // record the new one — guaranteeing the newest delivered code is the only
  // live one.
  await run(
    db,
    `UPDATE auth_otp SET consumed_at = ?
      WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL`,
    [nowIso(), emailNormalized, purpose]
  )

  await run(
    db,
    `INSERT INTO auth_otp
       (id, email_normalized, code_hash, purpose, share_id, attempts, max_attempts,
        created_at, expires_at, consumed_at, delivered_via)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)`,
    [
      prefixed('otp', ulid()),
      emailNormalized,
      codeHash,
      purpose,
      shareId,
      OTP_MAX_ATTEMPTS,
      nowIso(),
      expiresAt,
      deliveredVia
    ]
  )

  return deliveredVia === 'DEV_CONSOLE'
    ? { deliveredVia, devCode: code }
    : { deliveredVia }
}

/**
 * Redeem a code. Attempts are counted so a code cannot be brute-forced
 * within its validity window.
 */
export async function verifyOtp(
  db: D1Database,
  emailNormalized: string,
  code: string,
  purpose: 'LOGIN' | 'SHARE_ACCESS'
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await first<{
    id: string
    code_hash: string
    attempts: number
    max_attempts: number
    expires_at: string
    consumed_at: string | null
  }>(
    db,
    `SELECT id, code_hash, attempts, max_attempts, expires_at, consumed_at
       FROM auth_otp
      WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [emailNormalized, purpose]
  )

  if (!row) return { ok: false, reason: 'No active code. Request a new one.' }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'That code has expired. Request a new one.' }
  }
  if (row.attempts >= row.max_attempts) {
    return { ok: false, reason: 'Too many attempts. Request a new code.' }
  }

  const candidate = await hashOtp(emailNormalized, code.trim(), purpose)
  if (candidate !== row.code_hash) {
    await run(db, `UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ?`, [row.id])
    const remaining = row.max_attempts - (row.attempts + 1)
    return {
      ok: false,
      reason: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Too many attempts.'
    }
  }

  await run(db, `UPDATE auth_otp SET consumed_at = ? WHERE id = ?`, [nowIso(), row.id])
  return { ok: true }
}

/**
 * Find the user for an email, creating it (and its personal workspace) on
 * first sign-in. Registration is implicit — verifying the address *is*
 * registration, which keeps the flow to the four steps in PRD §3.4.
 */
export async function findOrCreateUser(
  db: D1Database,
  emailNormalized: string
): Promise<{ user: UserRow; created: boolean }> {
  const existing = await first<UserRow>(db, `SELECT * FROM users WHERE email_normalized = ?`, [
    emailNormalized
  ])

  if (existing) {
    if (existing.status !== 'ACTIVE') throw forbidden('This account is suspended.')
    // Mark verified on first successful code redemption
    if (!existing.email_verified_at) {
      await run(db, `UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?`, [
        nowIso(),
        nowIso(),
        existing.id
      ])
      existing.email_verified_at = nowIso()
    }
    return { user: existing, created: false }
  }

  const userId = prefixed('usr', ulid())
  const workspaceId = prefixed('ws', ulid())
  const timestamp = nowIso()
  const localPart = emailNormalized.split('@')[0]
  const displayName = localPart.charAt(0).toUpperCase() + localPart.slice(1)

  await batch(db, [
    ps(
      db,
      `INSERT INTO users
         (id, email, email_normalized, email_verified_at, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [userId, emailNormalized, emailNormalized, timestamp, displayName, timestamp, timestamp]
    ),
    // Personal Workspace, automatically created (PRD §6)
    ps(
      db,
      `INSERT INTO workspaces
         (id, organization_id, owner_user_id, workspace_type, name, description, created_at, created_by)
       VALUES (?, NULL, ?, 'PERSONAL', 'Personal', 'Your private workspace', ?, ?)`,
      [workspaceId, userId, timestamp, userId]
    ),
    ps(
      db,
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by)
       VALUES (?, ?, ?, 'WORKSPACE_ADMIN', ?, ?)`,
      [prefixed('wsm', ulid()), workspaceId, userId, timestamp, userId]
    )
  ])

  const user = await first<UserRow>(db, `SELECT * FROM users WHERE id = ?`, [userId])
  if (!user) throw new Error('Failed to create user')
  return { user, created: true }
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32)
  const tokenHash = await hashSessionToken(token)
  const expiresAt = addDays(new Date(), 30).toISOString()

  await run(
    db,
    `INSERT INTO auth_sessions
       (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [prefixed('ses', ulid()), userId, tokenHash, nowIso(), expiresAt, nowIso(), userAgent]
  )

  return { token, expiresAt }
}

export async function revokeSession(db: D1Database, rawToken: string): Promise<void> {
  const tokenHash = await hashSessionToken(rawToken)
  await run(db, `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`, [
    nowIso(),
    tokenHash
  ])
}

/** Housekeeping: drop expired sessions and consumed codes. */
export async function pruneExpired(db: D1Database): Promise<void> {
  const now = nowIso()
  await run(db, `DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL`, [now])
  await run(db, `DELETE FROM auth_otp WHERE expires_at < ?`, [now])
}

export function assertOtpInput(email: string, code: string) {
  if (!email) throw badRequest('Email is required')
  if (!code || !/^\d{4,8}$/.test(code.trim())) throw badRequest('Enter the numeric code')
}
