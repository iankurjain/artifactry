/**
 * Shared domain types for the Artifact Library.
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

export type SourceType = 'WEB_UPLOAD' | 'CHATGPT' | 'CLAUDE' | 'GEMINI' | 'API' | 'IMPORT'
export type SourceProvider = 'CHATGPT' | 'CLAUDE' | 'GEMINI' | 'WEB' | 'API'

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
  | 'tags.read'
  | 'profile.read'

export const AI_SCOPES: AiScope[] = [
  'artifact.read',
  'artifact.write',
  'artifact.share',
  'artifact.analytics.read',
  'workspace.read',
  'tags.read',
  'profile.read'
]

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

const VIEWER_PERMS: Permission[] = ['artifact.read', 'artifact.download']

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
  'member.manage'
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
  /** AI grant scopes, when kind === 'AI_GRANT' */
  scopes: AiScope[]
  integrationId?: string
  provider?: SourceProvider
  grantId?: string
}

export interface ApiError {
  error: string
  message: string
  details?: unknown
}
