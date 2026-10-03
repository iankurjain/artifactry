/**
 * Custom share domain for a workspace (lib/sharedomains.ts).
 *
 *   GET    /api/v1/workspaces/:id/share-domain         → current state + DNS records
 *   PUT    /api/v1/workspaces/:id/share-domain         → claim a hostname { hostname }
 *   POST   /api/v1/workspaces/:id/share-domain/check   → re-check DNS and certificate
 *   DELETE /api/v1/workspaces/:id/share-domain         → stop using it
 *
 * Workspace admins (which includes the workspace owner and the organization's
 * owners and admins), signed in to the app: an AI connector cannot change where
 * a workspace's links point. Organization workspaces only; a personal
 * workspace gets a clear refusal rather than a hostname nobody is billed for.
 *
 * Every share token also opens on the application origin, so removing or
 * replacing a domain only breaks links that were sent with the old hostname in
 * them; new links go back to the application origin (or the new hostname once
 * it is active).
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../middleware'
import { guarded, rateLimit, requirePrincipal } from '../middleware'
import { assertWorkspaceAccess } from '../lib/principal'
import type { WorkspaceRow } from '../types'
import { first, nowIso, run } from '../lib/db'
import { conflict, forbidden, HttpError, notFound, ok, readJson } from '../lib/http'
import { prefixed, randomToken, ulid } from '../lib/ids'
import { recordAudit } from '../lib/audit'
import type { ShareDomainRow } from '../lib/sharedomains'
import {
  challengeName,
  challengeValue,
  createCustomHostname,
  customHostnameLive,
  deleteCustomHostname,
  getCustomHostname,
  lookupTxt,
  normalizeShareHostname,
  shareDomainsAvailable
} from '../lib/sharedomains'

const shareDomains = new Hono<AppEnv>()

async function requireWorkspaceAdmin(c: Context<AppEnv>, workspaceId: string) {
  const principal = requirePrincipal(c)
  if (principal.kind === 'AI_GRANT') throw forbidden('Share domains are managed in the app')
  const workspace = await assertWorkspaceAccess(c.env.DB, principal, workspaceId, 'workspace.manage')
  return { principal, workspace }
}

function requireOrgWorkspace(workspace: WorkspaceRow) {
  if (!workspace.organization_id) {
    throw new HttpError(
      400,
      'PERSONAL_WORKSPACE',
      'Custom domains are available for shared workspaces. Invite someone to this workspace to make it shared.'
    )
  }
}

function unavailable(): HttpError {
  return new HttpError(
    503,
    'SHARE_DOMAINS_UNAVAILABLE',
    'Custom share domains are not set up on this deployment yet.'
  )
}

async function loadDomain(c: Context<AppEnv>, workspaceId: string): Promise<ShareDomainRow | null> {
  return first<ShareDomainRow>(
    c.env.DB,
    `SELECT * FROM workspace_share_domains WHERE workspace_id = ?`,
    [workspaceId]
  )
}

function present(c: Context<AppEnv>, row: ShareDomainRow | null) {
  if (!row) return null
  const target = c.env.SHARE_DOMAIN_CNAME_TARGET?.trim() ?? ''
  return {
    hostname: row.hostname,
    status: row.status,
    url: row.status === 'ACTIVE' ? `https://${row.hostname}` : null,
    // Both records are shown from the start so an admin can add them in one
    // visit to their DNS provider.
    records: [
      { type: 'CNAME', name: row.hostname, value: target, purpose: 'Sends visitors to Artifactry' },
      {
        type: 'TXT',
        name: challengeName(row.hostname),
        value: challengeValue(row.verification_token),
        purpose: 'Proves you control this hostname'
      }
    ],
    lastError: row.last_error,
    verifiedAt: row.verified_at,
    activatedAt: row.activated_at,
    lastCheckedAt: row.last_checked_at
  }
}

shareDomains.get(
  '/workspaces/:id/share-domain',
  guarded(async (c) => {
    const workspaceId = c.req.param('id')
    const { workspace } = await requireWorkspaceAdmin(c, workspaceId)
    return ok(c, {
      available: shareDomainsAvailable(c.env),
      eligible: !!workspace.organization_id,
      cnameTarget: c.env.SHARE_DOMAIN_CNAME_TARGET?.trim() || null,
      domain: present(c, await loadDomain(c, workspaceId))
    })
  })
)

shareDomains.put(
  '/workspaces/:id/share-domain',
  rateLimit({ bucket: 'share-domain:set', limit: 20, windowSeconds: 3600 }),
  guarded(async (c) => {
    const workspaceId = c.req.param('id')
    const { principal, workspace } = await requireWorkspaceAdmin(c, workspaceId)
    requireOrgWorkspace(workspace)
    if (!shareDomainsAvailable(c.env)) throw unavailable()

    const body = await readJson<{ hostname?: string }>(c)
    const hostname = normalizeShareHostname(body.hostname ?? '', c.env)

    const taken = await first<{ workspace_id: string }>(
      c.env.DB,
      `SELECT workspace_id FROM workspace_share_domains
        WHERE hostname = ? AND verified_at IS NOT NULL AND workspace_id <> ?`,
      [hostname, workspaceId]
    )
    if (taken) throw conflict('That hostname is already in use by another workspace.')

    const existing = await loadDomain(c, workspaceId)
    if (existing?.hostname === hostname) {
      return ok(c, { domain: present(c, existing) })
    }

    // Replacing a hostname: release the old one at Cloudflare first, so a
    // half-finished swap can never leave two hostnames serving this workspace.
    if (existing) await releaseDomain(c, existing)

    const timestamp = nowIso()
    const row: ShareDomainRow = {
      id: prefixed('sdm', ulid()),
      workspace_id: workspaceId,
      organization_id: workspace.organization_id,
      hostname,
      status: 'PENDING_DNS',
      verification_token: randomToken(24),
      cf_custom_hostname_id: null,
      last_error: null,
      verified_at: null,
      activated_at: null,
      last_checked_at: null,
      created_by_user_id: principal.userId,
      created_at: timestamp,
      updated_at: timestamp
    }
    await run(
      c.env.DB,
      `INSERT INTO workspace_share_domains
         (id, workspace_id, organization_id, hostname, status, verification_token, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING_DNS', ?, ?, ?, ?)`,
      [row.id, workspaceId, workspace.organization_id, hostname, row.verification_token, principal.userId, timestamp, timestamp]
    )

    await recordAudit(c.env.DB, {
      organizationId: workspace.organization_id,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'SHARE_DOMAIN_SET',
      targetType: 'share_domain',
      targetId: row.id,
      metadata: { hostname, replaced: existing?.hostname ?? null }
    })

    return ok(c, { domain: present(c, row) }, 201)
  })
)

/**
 * Advance a domain as far as its DNS and certificate allow:
 *
 *   PENDING_DNS  → TXT record found → PENDING_CERT (and registered at Cloudflare)
 *   PENDING_CERT → Cloudflare reports hostname and certificate active → ACTIVE
 *   ACTIVE       → Cloudflare no longer active → back to PENDING_CERT
 *
 * Idempotent; the admin screen calls it from a "Check now" button.
 */
shareDomains.post(
  '/workspaces/:id/share-domain/check',
  rateLimit({ bucket: 'share-domain:check', limit: 60, windowSeconds: 600 }),
  guarded(async (c) => {
    const workspaceId = c.req.param('id')
    const { principal, workspace } = await requireWorkspaceAdmin(c, workspaceId)
    requireOrgWorkspace(workspace)
    if (!shareDomainsAvailable(c.env)) throw unavailable()
    const orgId = workspace.organization_id

    let row = await loadDomain(c, workspaceId)
    if (!row) throw notFound('No share domain is set for this workspace')

    const update = async (fields: Partial<ShareDomainRow>) => {
      const merged = { ...row!, ...fields, last_checked_at: nowIso(), updated_at: nowIso() }
      await run(
        c.env.DB,
        `UPDATE workspace_share_domains
            SET status = ?, cf_custom_hostname_id = ?, last_error = ?, verified_at = ?,
                activated_at = ?, last_checked_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          merged.status,
          merged.cf_custom_hostname_id,
          merged.last_error,
          merged.verified_at,
          merged.activated_at,
          merged.last_checked_at,
          merged.updated_at,
          merged.id
        ]
      )
      row = merged
    }

    if (row.status === 'PENDING_DNS') {
      let values: string[] = []
      try {
        values = await lookupTxt(challengeName(row.hostname))
      } catch {
        await update({ last_error: 'Could not look up DNS just now. Try again in a minute.' })
        return ok(c, { domain: present(c, row) })
      }
      if (!values.includes(challengeValue(row.verification_token))) {
        await update({
          last_error: `The TXT record at ${challengeName(row.hostname)} was not found yet. DNS changes can take a few minutes to appear.`
        })
        return ok(c, { domain: present(c, row) })
      }

      // Ownership is proven. Only one workspace can ever hold a verified
      // hostname; the partial unique index enforces it even under a race.
      const clash = await first<{ id: string }>(
        c.env.DB,
        `SELECT id FROM workspace_share_domains
          WHERE hostname = ? AND verified_at IS NOT NULL AND id <> ?`,
        [row.hostname, row.id]
      )
      if (clash) throw conflict('That hostname is already in use by another workspace.')
      try {
        await update({ status: 'PENDING_CERT', verified_at: nowIso(), last_error: null })
      } catch {
        throw conflict('That hostname is already in use by another workspace.')
      }

      await recordAudit(c.env.DB, {
        organizationId: orgId,
      workspaceId,
        actorUserId: principal.userId,
        actorType: 'USER',
        action: 'SHARE_DOMAIN_VERIFIED',
        targetType: 'share_domain',
        targetId: row.id,
        metadata: { hostname: row.hostname }
      })
    }

    // PENDING_CERT, ERROR or ACTIVE: make sure Cloudflare knows the hostname,
    // then report what it says.
    try {
      if (!row.cf_custom_hostname_id) {
        const created = await createCustomHostname(c.env, row.hostname)
        await update({ cf_custom_hostname_id: created.id })
      }
      const state = await getCustomHostname(c.env, row.cf_custom_hostname_id!)
      if (!state) {
        // Deleted on Cloudflare's side; register it again on the next check.
        await update({
          status: 'PENDING_CERT',
          cf_custom_hostname_id: null,
          last_error: 'The hostname needs to be registered again. Check again in a moment.'
        })
      } else if (customHostnameLive(state)) {
        const firstActivation = row.status !== 'ACTIVE'
        await update({
          status: 'ACTIVE',
          activated_at: row.activated_at ?? nowIso(),
          last_error: null
        })
        if (firstActivation) {
          await recordAudit(c.env.DB, {
            organizationId: orgId,
      workspaceId,
            actorUserId: principal.userId,
            actorType: 'USER',
            action: 'SHARE_DOMAIN_ACTIVATED',
            targetType: 'share_domain',
            targetId: row.id,
            metadata: { hostname: row.hostname }
          })
        }
      } else {
        const blocked = state.status === 'blocked' || state.status === 'moved'
        await update({
          status: blocked ? 'ERROR' : 'PENDING_CERT',
          last_error:
            state.errors[0] ??
            `Waiting for the CNAME record and certificate (Cloudflare reports ${state.status}${
              state.sslStatus ? `, certificate ${state.sslStatus}` : ''
            }).`
        })
      }
    } catch (err) {
      await update({
        last_error: `Cloudflare: ${err instanceof Error ? err.message : 'request failed'}`
      })
    }

    return ok(c, { domain: present(c, row) })
  })
)

shareDomains.delete(
  '/workspaces/:id/share-domain',
  guarded(async (c) => {
    const workspaceId = c.req.param('id')
    const { principal, workspace } = await requireWorkspaceAdmin(c, workspaceId)
    const orgId = workspace.organization_id

    const row = await loadDomain(c, workspaceId)
    if (!row) return ok(c, { removed: false })

    await releaseDomain(c, row)

    await recordAudit(c.env.DB, {
      organizationId: orgId,
      workspaceId,
      actorUserId: principal.userId,
      actorType: 'USER',
      action: 'SHARE_DOMAIN_REMOVE',
      targetType: 'share_domain',
      targetId: row.id,
      metadata: { hostname: row.hostname }
    })

    return ok(c, { removed: true })
  })
)

/**
 * Stop serving a hostname: remove it from Cloudflare, then delete the row.
 * The Cloudflare call goes first so a failure leaves the row (and the button
 * to retry) in place rather than an orphaned hostname nobody can see.
 */
async function releaseDomain(c: Context<AppEnv>, row: ShareDomainRow): Promise<void> {
  if (row.cf_custom_hostname_id) {
    if (!shareDomainsAvailable(c.env)) throw unavailable()
    try {
      await deleteCustomHostname(c.env, row.cf_custom_hostname_id)
    } catch (err) {
      const stillThere = await getCustomHostname(c.env, row.cf_custom_hostname_id).catch(() => undefined)
      if (stillThere !== null) {
        throw new HttpError(
          502,
          'CLOUDFLARE_ERROR',
          `Could not release ${row.hostname} at Cloudflare: ${err instanceof Error ? err.message : 'request failed'}`
        )
      }
    }
  }
  await run(c.env.DB, `DELETE FROM workspace_share_domains WHERE id = ?`, [row.id])
}

export default shareDomains
