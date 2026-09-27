/**
 * Authentication routes — PRD §5.
 *
 * Passwordless email OTP / magic link:
 *   POST /auth/request-code   → issue a code (rate limited per email + IP)
 *   POST /auth/verify-code    → redeem it, create the session
 *   POST /auth/logout         → revoke the current session
 *   GET  /auth/me             → current identity + workspaces + organizations
 *
 * Response shape note: when running without an email provider the code is
 * echoed back as `devCode`. That is safe because dev mode is only reachable
 * when EMAIL_API_KEY is absent, and it makes the app testable end-to-end
 * before an email provider is wired up.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import {
  createSession,
  devCodeMode,
  findOrCreateUser,
  issueOtp,
  pruneExpired,
  revokeSession,
  verifyOtp
} from '../lib/auth'
import {
  badRequest,
  clearSessionCookie,
  ok,
  readJson,
  readSessionCookie,
  setSessionCookie
} from '../lib/http'
import { isValidEmail, normalizeEmail } from '../lib/validate'
import { all, first } from '../lib/db'
import { recordAudit } from '../lib/audit'
import { readableWorkspaces } from '../lib/principal'
import { connectedIntegrations } from '../lib/ai'

const auth = new Hono<AppEnv>()

auth.post(
  '/request-code',
  rateLimit({ bucket: 'otp:email', limit: 5, windowSeconds: 300 }),
  guarded(async (c) => {
    const body = await readJson<{ email?: string }>(c)
    const raw = (body.email ?? '').trim()

    if (!isValidEmail(raw)) throw badRequest('Enter a valid email address')
    const email = normalizeEmail(raw)

    const result = await issueOtp(c.env, email, 'LOGIN')

    return ok(c, {
      email,
      deliveredVia: result.deliveredVia,
      devCode: result.devCode,
      devMode: devCodeMode(c.env),
      expiresInMinutes: 10
    })
  })
)

auth.post(
  '/verify-code',
  rateLimit({ bucket: 'otp:verify', limit: 20, windowSeconds: 300 }),
  guarded(async (c) => {
    const body = await readJson<{ email?: string; code?: string }>(c)
    const raw = (body.email ?? '').trim()
    const code = (body.code ?? '').trim()

    if (!isValidEmail(raw)) throw badRequest('Enter a valid email address')
    if (!/^\d{4,8}$/.test(code)) throw badRequest('Enter the numeric code from your email')

    const email = normalizeEmail(raw)

    const verification = await verifyOtp(c.env.DB, email, code, 'LOGIN')
    if (!verification.ok) throw badRequest(verification.reason)

    const { user, created } = await findOrCreateUser(c.env.DB, email)
    const session = await createSession(c.env.DB, user.id, c.req.header('User-Agent') ?? null)

    setSessionCookie(c, session.token)

    await recordAudit(c.env.DB, {
      actorUserId: user.id,
      actorType: 'USER',
      action: 'LOGIN',
      targetType: 'user',
      targetId: user.id,
      metadata: { created, emailDomain: email.split('@')[1] ?? null }
    })

    // Opportunistic housekeeping — there is no cron trigger on Pages, so
    // expired rows are reaped on the login path instead.
    if (created) void pruneExpired(c.env.DB).catch(() => {})

    return ok(c, {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at
      },
      isNewUser: created,
      expiresAt: session.expiresAt
    })
  })
)

auth.post(
  '/logout',
  guarded(async (c) => {
    const token = readSessionCookie(c)
    if (token) {
      await revokeSession(c.env.DB, token)
      const principal = c.get('principal')
      if (principal?.userId) {
        await recordAudit(c.env.DB, {
          actorUserId: principal.userId,
          actorType: 'USER',
          action: 'LOGOUT',
          targetType: 'user',
          targetId: principal.userId
        })
      }
    }
    clearSessionCookie(c)
    return ok(c, { loggedOut: true })
  })
)

auth.get(
  '/me',
  guarded(async (c) => {
    const principal = c.get('principal')

    if (!principal?.user) {
      return ok(c, {
        authenticated: false,
        devMode: devCodeMode(c.env)
      })
    }

    const workspaces = await readableWorkspaces(c.env.DB, principal)

    const organizations = await all<{ id: string; name: string; slug: string; plan: string; role: string }>(
      c.env.DB,
      `SELECT o.id, o.name, o.slug, o.plan, om.role
         FROM organizations o
         JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = ? AND om.status = 'ACTIVE'
        ORDER BY o.name ASC`,
      [principal.userId]
    )

    // Only the caller's own grants are ever returned, so a connector list can
    // never be used to enumerate another user's access (§60).
    const integrations = await connectedIntegrations(c.env.DB, principal.userId!)

    const counts = await first<{ artifacts: number; shares: number }>(
      c.env.DB,
      `SELECT
         (SELECT COUNT(*) FROM artifacts a
            JOIN workspace_members wm ON wm.workspace_id = a.workspace_id
           WHERE wm.user_id = ? AND a.deleted_at IS NULL) AS artifacts,
         (SELECT COUNT(*) FROM shares s
           WHERE s.created_by_user_id = ? AND s.status = 'ACTIVE') AS shares`,
      [principal.userId, principal.userId]
    )

    return ok(c, {
      authenticated: true,
      user: {
        id: principal.user.id,
        email: principal.user.email,
        displayName: principal.user.display_name,
        avatarUrl: principal.user.avatar_url,
        createdAt: principal.user.created_at
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        type: w.workspace_type,
        organizationId: w.organization_id,
        role: principal.workspaceRoles[w.id] ?? (w.owner_user_id === principal.userId ? 'WORKSPACE_ADMIN' : null)
      })),
      organizations: organizations.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan,
        role: o.role
      })),
      integrations,
      counts: { artifacts: counts?.artifacts ?? 0, shares: counts?.shares ?? 0 },
      devMode: devCodeMode(c.env)
    })
  })
)

/** Lightweight probe used by the client to decide whether to show login. */
auth.get(
  '/session',
  guarded(async (c) => {
    const principal = c.get('principal')
    return ok(c, {
      authenticated: !!principal?.userId,
      devMode: devCodeMode(c.env)
    })
  })
)

export default auth
export { requirePrincipal }
