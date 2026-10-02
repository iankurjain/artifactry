/**
 * Workspace settings stored in workspaces.settings_json (migration 0009).
 *
 * Every read goes through `parseWorkspaceSettings`, so a missing, partial or
 * malformed blob always yields complete, valid settings with defaults; every
 * write goes through `mergeWorkspaceSettings`, which validates each field and
 * rejects what it does not recognise rather than storing it.
 */

import type { WorkspaceRole } from '../types'
import { badRequest } from './http'

export const DATE_FORMATS = ['D MMM YYYY', 'MMM D, YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

const JOIN_ROLES: WorkspaceRole[] = ['WORKSPACE_ADMIN', 'CONTRIBUTOR', 'VIEWER']

export interface WorkspaceSettings {
  regional: {
    /** IANA zone, e.g. "Asia/Kolkata"; "UTC" by default. */
    timeZone: string
    dateFormat: DateFormat
  }
  invitations: {
    /** Email domains allowed to join through an invite link; empty means any. */
    allowedDomains: string[]
    /** New joiners wait for an admin to approve them. */
    requireApproval: boolean
    /** Access tier given to people who join, unless the invitation says otherwise. */
    defaultRole: WorkspaceRole
    defaultCustomRoleId: string | null
  }
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  regional: { timeZone: 'UTC', dateFormat: 'D MMM YYYY' },
  invitations: { allowedDomains: [], requireApproval: false, defaultRole: 'VIEWER', defaultCustomRoleId: null }
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

function normalizeDomain(raw: string): string {
  return String(raw ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
}

export function parseWorkspaceSettings(json: string | null | undefined): WorkspaceSettings {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(json || '{}')
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    raw = {}
  }
  const regional = (raw.regional ?? {}) as Record<string, unknown>
  const inv = (raw.invitations ?? {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS

  return {
    regional: {
      timeZone: typeof regional.timeZone === 'string' && isValidTimeZone(regional.timeZone) ? regional.timeZone : d.regional.timeZone,
      dateFormat: DATE_FORMATS.includes(regional.dateFormat as DateFormat) ? (regional.dateFormat as DateFormat) : d.regional.dateFormat
    },
    invitations: {
      allowedDomains: Array.isArray(inv.allowedDomains)
        ? inv.allowedDomains.map((x) => normalizeDomain(String(x))).filter((x) => DOMAIN_RE.test(x))
        : [],
      requireApproval: inv.requireApproval === true,
      defaultRole: JOIN_ROLES.includes(inv.defaultRole as WorkspaceRole) ? (inv.defaultRole as WorkspaceRole) : d.invitations.defaultRole,
      defaultCustomRoleId: typeof inv.defaultCustomRoleId === 'string' ? inv.defaultCustomRoleId : null
    }
  }
}

export interface SettingsPatch {
  regional?: Partial<WorkspaceSettings['regional']>
  invitations?: Partial<WorkspaceSettings['invitations']>
}

/** Apply a validated patch. Throws 400 on the first invalid field. */
export function mergeWorkspaceSettings(current: WorkspaceSettings, patch: SettingsPatch): WorkspaceSettings {
  const next: WorkspaceSettings = {
    regional: { ...current.regional },
    invitations: { ...current.invitations, allowedDomains: [...current.invitations.allowedDomains] }
  }

  const r = patch.regional
  if (r) {
    if (r.timeZone !== undefined) {
      if (typeof r.timeZone !== 'string' || !isValidTimeZone(r.timeZone)) throw badRequest('Choose a valid time zone')
      next.regional.timeZone = r.timeZone
    }
    if (r.dateFormat !== undefined) {
      if (!DATE_FORMATS.includes(r.dateFormat as DateFormat)) throw badRequest('Choose a supported date format')
      next.regional.dateFormat = r.dateFormat as DateFormat
    }
  }

  const i = patch.invitations
  if (i) {
    if (i.allowedDomains !== undefined) {
      if (!Array.isArray(i.allowedDomains)) throw badRequest('Allowed domains must be a list')
      const domains = [...new Set(i.allowedDomains.map((x) => normalizeDomain(String(x))).filter(Boolean))]
      const bad = domains.find((x) => !DOMAIN_RE.test(x))
      if (bad) throw badRequest(`"${bad}" is not a valid email domain`)
      if (domains.length > 50) throw badRequest('At most 50 allowed domains')
      next.invitations.allowedDomains = domains
    }
    if (i.requireApproval !== undefined) next.invitations.requireApproval = i.requireApproval === true
    if (i.defaultRole !== undefined) {
      if (!JOIN_ROLES.includes(i.defaultRole as WorkspaceRole)) throw badRequest('Choose a valid default access tier')
      next.invitations.defaultRole = i.defaultRole as WorkspaceRole
    }
    if (i.defaultCustomRoleId !== undefined) {
      next.invitations.defaultCustomRoleId = i.defaultCustomRoleId || null
    }
  }

  return next
}

/** Whether an email may join under the workspace's domain restriction. */
export function emailAllowed(settings: WorkspaceSettings, email: string): boolean {
  const list = settings.invitations.allowedDomains
  if (!list.length) return true
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return list.includes(domain)
}
