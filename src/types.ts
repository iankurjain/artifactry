/**
 * Shared domain types for Artifactry.
 * Mirrors the D1 schema in migrations/0001_initial_schema.sql
 */

export interface Env {
  DB: D1Database
  R2: R2Bucket
  APP_NAME: string
  MAX_UPLOAD_BYTES: string

  // Optional: semantic search (PRD §31, §32).
  // Present only on accounts where these bindings are provisioned.
  VECTORIZE?: VectorizeIndex
  AI?: Ai

  // Optional: real email delivery for OTP / magic links (PRD §5, §37).
  // When absent the app runs in dev-code mode (see routes/auth.ts).
  EMAIL_API_KEY?: string
  EMAIL_FROM?: string
  DEV_LOGIN_MODE?: string

  // Interactive HTML preview on an isolated origin.
  //
  // PREVIEW_ORIGIN is the origin that serves script-executing HTML artifacts,
  // e.g. https://preview.artifactry.app. It must be a DIFFERENT hostname from
  // the application: cookies here are host-only, and localStorage is
  // per-origin, so a distinct host is what actually isolates an artifact.
  //
  // PREVIEW_TOKEN_SECRET signs the short-lived access tokens that origin
  // accepts. It is a secret (wrangler secret / .dev.vars), never a committed
  // var.
  //
  // BOTH are required before Interactive Preview can serve. If either is
  // missing the mode degrades to Safe Preview (JavaScript disabled) rather
  // than serving executing HTML unauthenticated — see lib/htmlpreview.ts.
  PREVIEW_ORIGIN?: string
  PREVIEW_TOKEN_SECRET?: string

  // APP_ORIGIN is the canonical application origin, e.g. https://artifactry.app.
  //
  // A preview token carries the origin permitted to frame the document
  // (`frame-ancestors`). When APP_ORIGIN is set, the preview origin requires
  // that signed value to match it exactly, so a token minted for any other
  // origin is refused rather than served with a foreign framing allow-list. The
  // app origin derives that value from the request URL, so this check also
  // closes the case where a spoofed Host header could otherwise choose who is
  // allowed to frame an artifact. Unset means the check is skipped.
  APP_ORIGIN?: string

  // Custom share domains (lib/sharedomains.ts). All four are required before
  // an organization can put its share links on its own hostname.
  //
  // SHARE_EDGE_SECRET is shared with the share-edge Worker, which forwards
  // customer-hostname traffic here; it proves the forwarded hostname header is
  // genuine. CF_API_TOKEN (Zone > SSL and Certificates > Edit) and CF_ZONE_ID
  // register customer hostnames with Cloudflare for SaaS on the app's zone.
  // SHARE_DOMAIN_CNAME_TARGET is the hostname customers point their CNAME at.
  // The two credentials are secrets, never committed vars.
  SHARE_EDGE_SECRET?: string
  CF_API_TOKEN?: string
  CF_ZONE_ID?: string
  SHARE_DOMAIN_CNAME_TARGET?: string
}

// ---------------------------------------------------------------
// Enumerations (PRD §15, §21, §28, §34, §49)
// ---------------------------------------------------------------

export type ArtifactStatus =
  | 'UPLOADING'
  | 'PROCESSING'
  | 'READY'
  | 'PROCESSING_FAILED'
  | 'QUARANTINED'
  | 'DELETED'

export type SourceType = 'WEB_UPLOAD' | 'CHATGPT' | 'CLAUDE' | 'GEMINI' | 'COPILOT' | 'API' | 'IMPORT'
export type SourceProvider = 'CHATGPT' | 'CLAUDE' | 'GEMINI' | 'COPILOT' | 'WEB' | 'API'

export type AccessType = 'PUBLIC_LINK' | 'EMAIL' | 'DOMAIN'
export type ShareStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED'
export type ShareTargetType = 'ARTIFACT' | 'COLLECTION'

export type WorkspaceType = 'PERSONAL' | 'ORGANIZATION'
export type OrgRole = 'ORG_OWNER' | 'ORG_ADMIN' | 'MEMBER'
export type WorkspaceRole = 'WORKSPACE_ADMIN' | 'CONTRIBUTOR' | 'VIEWER'

export type AccessChannel = 'INTERNAL' | 'PUBLIC_LINK' | 'EMAIL' | 'DOMAIN' | 'AI'
export type ActorType = 'USER' | 'ANONYMOUS' | 'AI' | 'SYSTEM'

export type AiScope =
  | 'artifact.read'
  | 'artifact.write'
  | 'artifact.share'
  | 'artifact.analytics.read'
  | 'workspace.read'
  | 'team.read'
  | 'tags.read'
  | 'profile.read'

export const AI_SCOPES: AiScope[] = [
  'artifact.read',
  'artifact.write',
  'artifact.share',
  'artifact.analytics.read',
  'workspace.read',
  'team.read',
  'tags.read',
  'profile.read'
]

// ---------------------------------------------------------------
// Tag decision model (migration 0006)
// ---------------------------------------------------------------

/**
 * A tag association records a *decision*, not merely a link.
 *
 *   SUGGESTED — machine-proposed from the artifact's content; shown to the user
 *   CONFIRMED — accepted by a person, or added by one directly
 *   REJECTED  — explicitly declined by a person. The row is retained so the
 *               same suggestion is never re-offered against unchanged content.
 */
export type TagState = 'SUGGESTED' | 'CONFIRMED' | 'REJECTED'

/** Who caused the association. Only these three, deliberately. */
export type TagProvenance = 'AI' | 'USER' | 'ADMIN'

// ---------------------------------------------------------------
// Teams — reusable named sharing audiences (migration 0006)
// ---------------------------------------------------------------

export type TeamScope = 'ORGANIZATION' | 'WORKSPACE'
export type TeamStatus = 'ACTIVE' | 'INACTIVE'
export type TeamMemberRole = 'ADMIN' | 'MEMBER'

export interface TeamRow {
  id: string
  organization_id: string
  workspace_id: string | null
  scope: TeamScope
  name: string
  slug: string
  description: string | null
  owner_user_id: string
  status: TeamStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface TeamMemberRow {
  id: string
  team_id: string
  user_id: string | null
  email_normalized: string
  display_name: string | null
  role: TeamMemberRole
  status: string
  created_at: string
  created_by: string | null
}

// ---------------------------------------------------------------
// Permission model — the single source of truth for authorization.
// The browser is never the security boundary (PRD §29).
// ---------------------------------------------------------------

export type Permission =
  | 'artifact.read'
  | 'artifact.download'
  | 'artifact.create'
  | 'artifact.update'
  | 'artifact.delete'
  | 'artifact.version.create'
  | 'artifact.tag.apply'
  | 'collection.manage'
  | 'share.create'
  | 'share.revoke'
  | 'analytics.read.artifact'
  | 'analytics.read.workspace'
  | 'analytics.read.organization'
  | 'workspace.manage'
  | 'member.manage'
  | 'tag.manage'
  | 'team.read'
  | 'team.manage'

/**
 * Permissions a custom access tier may contain. Administration (workspace and
 * member management) is deliberately absent: that is what the Admin tier is
 * for, and keeping it out means a custom tier can never be an admin in
 * disguise.
 */
export const CUSTOMIZABLE_PERMISSIONS: Permission[] = [
  'artifact.read',
  'artifact.download',
  'artifact.create',
  'artifact.update',
  'artifact.version.create',
  'artifact.tag.apply',
  'artifact.delete',
  'collection.manage',
  'share.create',
  'share.revoke',
  'analytics.read.artifact',
  'analytics.read.workspace',
  'team.read',
  'team.manage'
]

const VIEWER_PERMS: Permission[] = ['artifact.read', 'artifact.download', 'team.read']

const CONTRIBUTOR_PERMS: Permission[] = [
  ...VIEWER_PERMS,
  'artifact.create',
  'artifact.update',
  'artifact.version.create',
  'artifact.tag.apply',
  'collection.manage',
  'share.create',
  'share.revoke'
]

const WORKSPACE_ADMIN_PERMS: Permission[] = [
  ...CONTRIBUTOR_PERMS,
  'artifact.delete',
  'analytics.read.artifact',
  'analytics.read.workspace',
  'workspace.manage',
  'member.manage',
  'team.manage'
]

const ORG_ADMIN_PERMS: Permission[] = [
  ...WORKSPACE_ADMIN_PERMS,
  'analytics.read.organization',
  'tag.manage'
]

export const ROLE_PERMISSIONS: Record<OrgRole | WorkspaceRole, Permission[]> = {
  ORG_OWNER: [...ORG_ADMIN_PERMS, 'workspace.manage', 'member.manage'],
  ORG_ADMIN: ORG_ADMIN_PERMS,
  MEMBER: VIEWER_PERMS,
  WORKSPACE_ADMIN: WORKSPACE_ADMIN_PERMS,
  CONTRIBUTOR: CONTRIBUTOR_PERMS,
  VIEWER: VIEWER_PERMS
}

// ---------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------

export interface UserRow {
  id: string
  email: string
  email_normalized: string
  email_verified_at: string | null
  display_name: string | null
  avatar_url: string | null
  /** Migration 0009: uploaded profile picture (320x320, <= 1 MB) in R2. */
  avatar_r2_key?: string | null
  avatar_updated_at?: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface WorkspaceRow {
  id: string
  organization_id: string | null
  owner_user_id: string
  workspace_type: WorkspaceType
  name: string
  description: string | null
  created_at: string
  created_by: string | null
  archived_at: string | null
  /** Migration 0009: regional + invitation settings, and the uploaded logo. */
  settings_json?: string
  logo_r2_key?: string | null
  logo_updated_at?: string | null
}

export interface ArtifactRow {
  seq?: number
  id: string
  organization_id: string | null
  workspace_id: string
  owner_user_id: string
  title: string
  description: string | null
  canonical_slug: string | null
  filename: string | null
  extension: string | null
  mime_type: string | null
  size_bytes: number
  checksum: string | null
  current_version_id: string | null
  version_count: number
  source_type: SourceType
  source_provider: SourceProvider | null
  status: ArtifactStatus
  status_detail: string | null
  metadata_json: string
  /**
   * HTML rendering mode — migration 0005.
   *   0 (default) — Safe Preview: HTML + CSS render, JavaScript never executes.
   *   1           — Interactive Preview: JavaScript executes, but only on the
   *                 isolated preview origin.
   * Default 0 is a security posture, not a preference; only an explicit,
   * audited owner action sets it to 1.
   */
  interactive_html?: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface VersionRow {
  id: string
  artifact_id: string
  version_number: number
  r2_object_key: string
  filename: string
  mime_type: string
  extension: string | null
  size_bytes: number
  checksum: string | null
  source_type: SourceType
  source_provider: SourceProvider | null
  change_summary: string | null
  extracted_text: string | null
  created_by_user_id: string | null
  created_at: string
  deleted_at: string | null
}

export interface TagRow {
  id: string
  organization_id: string | null
  scope: 'PERSONAL' | 'ORGANIZATION'
  name: string
  slug: string
  description: string | null
  color: string | null
  status: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ShareRow {
  id: string
  organization_id: string | null
  workspace_id: string | null
  created_by_user_id: string
  target_type: ShareTargetType
  target_id: string
  access_type: AccessType
  allow_view: number
  allow_download: number
  include_new_items: number
  starts_at: string | null
  expires_at: string | null
  token_hash: string
  token_prefix: string
  status: ShareStatus
  title: string | null
  note: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

/** Resolved authorization context for the current request (PRD §29). */
export interface Principal {
  kind: 'SESSION' | 'AI_GRANT' | 'NONE'
  userId: string | null
  user: UserRow | null
  /** Organization roles keyed by organization_id */
  orgRoles: Record<string, OrgRole>
  /** Workspace roles keyed by workspace_id */
  workspaceRoles: Record<string, WorkspaceRole>
  /**
   * Permissions of a custom access tier, keyed by workspace_id, for members
   * assigned one. They replace the built-in role's permissions in that
   * workspace (never for its owner or an organization owner/admin).
   */
  customPermissions?: Record<string, Permission[]>
  /** AI grant scopes, when kind === 'AI_GRANT' */
  scopes: AiScope[]
  integrationId?: string
  provider?: SourceProvider
  grantId?: string
  /**
   * The AI application that reported itself when the grant was issued, e.g.
   * "Claude Desktop". Recorded on every artifact the connection produces and
   * on every MCP call, so "which AI did what, on whose behalf" is answerable
   * rather than inferred from the provider alone (§59).
   */
  clientName?: string
  clientVersion?: string
}

export interface ApiError {
  error: string
  message: string
  details?: unknown
}
