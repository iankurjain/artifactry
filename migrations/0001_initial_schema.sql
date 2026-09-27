-- ================================================================
-- AI-Native Artifact Library — D1 core schema
-- Covers PRD §94–§104 plus identity/session + AI-token tables.
-- ================================================================

-- ----------------------------------------------------------------
-- Identity (§95)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_normalized  TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  display_name      TEXT,
  avatar_url        TEXT,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | SUSPENDED
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email_norm ON users(email_normalized);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT,
  revoked_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON auth_sessions(token_hash);

-- One-time codes: login (§5) and share recipient verification (§37, §38)
CREATE TABLE IF NOT EXISTS auth_otp (
  id                TEXT PRIMARY KEY,
  email_normalized  TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  purpose           TEXT NOT NULL,          -- LOGIN | SHARE_ACCESS
  share_id          TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 6,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  consumed_at       TEXT,
  delivered_via     TEXT                     -- EMAIL | DEV_CONSOLE
);
CREATE INDEX IF NOT EXISTS idx_otp_lookup ON auth_otp(email_normalized, purpose, consumed_at);

-- ----------------------------------------------------------------
-- Tenancy (§4, §7)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  plan           TEXT NOT NULL DEFAULT 'FREE',      -- FREE | TEAM | ENTERPRISE
  max_upload_bytes INTEGER NOT NULL DEFAULT 26214400,
  settings_json  TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,             -- ORG_OWNER | ORG_ADMIN | MEMBER
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_orgmembers_user ON organization_members(user_id);

-- ----------------------------------------------------------------
-- Workspaces (§6, §27, §96, §97)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,                      -- NULL => personal workspace
  owner_user_id   TEXT NOT NULL,
  workspace_type  TEXT NOT NULL,             -- PERSONAL | ORGANIZATION
  name            TEXT NOT NULL,
  description     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  archived_at     TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,                -- WORKSPACE_ADMIN | CONTRIBUTOR | VIEWER
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wsmembers_user ON workspace_members(user_id);

-- ----------------------------------------------------------------
-- Artifacts (§10, §11, §98)
-- seq drives the FTS5 rowid mapping (deterministic index maintenance).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,     -- ULID, canonical (§12)
  organization_id   TEXT,
  workspace_id      TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,

  title             TEXT NOT NULL,
  description       TEXT,
  canonical_slug    TEXT,

  -- mirrored from current version for list/render performance
  filename          TEXT,
  extension         TEXT,
  mime_type         TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  checksum          TEXT,

  current_version_id TEXT,
  version_count     INTEGER NOT NULL DEFAULT 0,

  source_type       TEXT NOT NULL DEFAULT 'WEB_UPLOAD', -- §15
  source_provider   TEXT,                               -- CHATGPT | CLAUDE | GEMINI | WEB | API
  status            TEXT NOT NULL DEFAULT 'UPLOADING',  -- §21
  status_detail     TEXT,

  metadata_json     TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_org ON artifacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON artifacts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);

-- ----------------------------------------------------------------
-- Versions (§13, §99)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_versions (
  id                 TEXT PRIMARY KEY,
  artifact_id        TEXT NOT NULL,
  version_number     INTEGER NOT NULL,

  r2_object_key      TEXT NOT NULL,          -- internal only (§65)
  filename           TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  extension          TEXT,
  size_bytes         INTEGER NOT NULL,
  checksum           TEXT,

  source_type        TEXT NOT NULL DEFAULT 'WEB_UPLOAD',
  source_provider    TEXT,
  change_summary     TEXT,

  extracted_text     TEXT,

  created_by_user_id TEXT,
  created_at         TEXT NOT NULL,
  deleted_at         TEXT,
  UNIQUE (artifact_id, version_number),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_versions_artifact ON artifact_versions(artifact_id, version_number DESC);

-- ----------------------------------------------------------------
-- Tags (§23, §24, §25, §100) — admin-governed taxonomy
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,                       -- NULL => personal/platform scope
  scope           TEXT NOT NULL DEFAULT 'PERSONAL', -- PERSONAL | ORGANIZATION
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  color           TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | INACTIVE
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (scope, organization_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_tags_scope ON tags(scope, organization_id, status);

CREATE TABLE IF NOT EXISTS artifact_tags (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  UNIQUE (artifact_id, tag_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_tags_tag ON artifact_tags(tag_id);

-- ----------------------------------------------------------------
-- Collections (§26)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collections_workspace ON collections(workspace_id);

CREATE TABLE IF NOT EXISTS collection_artifacts (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  added_by      TEXT,
  added_at      TEXT NOT NULL,
  UNIQUE (collection_id, artifact_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------
-- Sharing (§34–§41, §101, §102)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shares (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT,
  workspace_id      TEXT,

  created_by_user_id TEXT NOT NULL,

  target_type       TEXT NOT NULL,            -- ARTIFACT | COLLECTION
  target_id         TEXT NOT NULL,

  access_type       TEXT NOT NULL,            -- PUBLIC_LINK | EMAIL | DOMAIN

  allow_view        INTEGER NOT NULL DEFAULT 1,
  allow_download    INTEGER NOT NULL DEFAULT 0,

  include_new_items INTEGER NOT NULL DEFAULT 1,  -- §41 collection share default

  starts_at         TEXT,
  expires_at        TEXT,

  token_hash        TEXT NOT NULL UNIQUE,     -- §36 raw token never stored
  token_prefix      TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | REVOKED | EXPIRED
  title             TEXT,
  note              TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  revoked_at        TEXT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token_hash);
CREATE INDEX IF NOT EXISTS idx_shares_creator ON shares(created_by_user_id);

CREATE TABLE IF NOT EXISTS share_recipients (
  id              TEXT PRIMARY KEY,
  share_id        TEXT NOT NULL,
  recipient_type  TEXT NOT NULL,              -- EMAIL | DOMAIN
  recipient_value TEXT NOT NULL,              -- normalized
  created_at      TEXT NOT NULL,
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_recipients_share ON share_recipients(share_id);

-- Records a recipient identity that passed verification against a share (§38)
CREATE TABLE IF NOT EXISTS share_access_grants (
  id            TEXT PRIMARY KEY,
  share_id      TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  session_hash  TEXT NOT NULL UNIQUE,
  last_used_at  TEXT,
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_grants_share ON share_access_grants(share_id);

-- ----------------------------------------------------------------
-- AI integrations (§50, §58, §60)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrations (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id         TEXT,                       -- NULL => platform-defined connector
  provider        TEXT NOT NULL,              -- CHATGPT | CLAUDE | GEMINI | CUSTOM
  name            TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_grants (
  id             TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  organization_id TEXT,
  scopes         TEXT NOT NULL,               -- JSON array, §58
  token_hash     TEXT NOT NULL UNIQUE,
  token_prefix   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | REVOKED
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON integration_grants(user_id, status);
CREATE INDEX IF NOT EXISTS idx_grants_token ON integration_grants(token_hash);

-- ----------------------------------------------------------------
-- Analytics (§49, §103, §104)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_events (
  id                TEXT PRIMARY KEY,
  artifact_id       TEXT,
  workspace_id      TEXT,
  organization_id   TEXT,
  collection_id     TEXT,
  share_id          TEXT,

  event_type        TEXT NOT NULL,
  actor_type        TEXT NOT NULL,            -- USER | ANONYMOUS | AI | SYSTEM
  actor_user_id     TEXT,
  actor_label       TEXT,                     -- verified email or "Anonymous viewer"

  ai_provider       TEXT,
  access_channel    TEXT NOT NULL,            -- INTERNAL | PUBLIC_LINK | EMAIL | DOMAIN | AI
  session_hash      TEXT,

  metadata_json     TEXT NOT NULL DEFAULT '{}',
  occurred_at       TEXT NOT NULL,
  metric_date       TEXT NOT NULL             -- YYYY-MM-DD for rollups
);
CREATE INDEX IF NOT EXISTS idx_events_artifact ON artifact_events(artifact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_rollup ON artifact_events(artifact_id, metric_date);
CREATE INDEX IF NOT EXISTS idx_events_share ON artifact_events(share_id);
CREATE INDEX IF NOT EXISTS idx_events_workspace ON artifact_events(workspace_id, metric_date);

CREATE TABLE IF NOT EXISTS artifact_daily_metrics (
  id                    TEXT PRIMARY KEY,
  artifact_id           TEXT NOT NULL,
  metric_date           TEXT NOT NULL,

  views                 INTEGER NOT NULL DEFAULT 0,
  unique_viewers        INTEGER NOT NULL DEFAULT 0,
  downloads             INTEGER NOT NULL DEFAULT 0,
  unique_downloaders    INTEGER NOT NULL DEFAULT 0,

  internal_views        INTEGER NOT NULL DEFAULT 0,
  external_views        INTEGER NOT NULL DEFAULT 0,
  public_link_views     INTEGER NOT NULL DEFAULT 0,
  email_views           INTEGER NOT NULL DEFAULT 0,
  domain_views          INTEGER NOT NULL DEFAULT 0,

  ai_references         INTEGER NOT NULL DEFAULT 0,
  share_opens           INTEGER NOT NULL DEFAULT 0,
  denied_requests       INTEGER NOT NULL DEFAULT 0,

  UNIQUE (artifact_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_metrics_artifact ON artifact_daily_metrics(artifact_id, metric_date);

-- Distinct viewer/downer tracking so "unique" is a real count, not a guess (§45)
CREATE TABLE IF NOT EXISTS artifact_viewer_keys (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  metric_date  TEXT NOT NULL,
  viewer_key   TEXT NOT NULL,                 -- user id, or hashed session key (§45)
  kind         TEXT NOT NULL,                 -- VIEW | DOWNLOAD
  created_at   TEXT NOT NULL,
  UNIQUE (artifact_id, metric_date, viewer_key, kind)
);

-- ----------------------------------------------------------------
-- Audit trail (§70) — separate from product analytics
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY,
  organization_id TEXT,
  workspace_id    TEXT,
  actor_user_id   TEXT,
  actor_type      TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  ip_country      TEXT,
  occurred_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_type, target_id);

-- ----------------------------------------------------------------
-- Processing pipeline (§22, §21) — synchronous in-request jobs
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing_jobs (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version_id  TEXT,
  job_type    TEXT NOT NULL,               -- EXTRACT | INDEX | THUMBNAIL | EMBED | SCAN
  status      TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | RUNNING | DONE | FAILED | SKIPPED
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_artifact ON processing_jobs(artifact_id, job_type);

-- ----------------------------------------------------------------
-- Lexical search index (§30, §32) — FTS5, rowid == artifacts.seq
-- ----------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(
  title,
  filename,
  description,
  tags,
  extracted_text,
  tokenize = 'porter unicode61'
);

-- ----------------------------------------------------------------
-- AI / semantic search provider state (§31, §32)
-- Populated only when a Vectorize binding is available; otherwise the
-- search layer falls back to lexical-only. Embeddings are optional.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_embeddings (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  version_id   TEXT,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  chunk_text   TEXT NOT NULL,
  vector_id    TEXT,
  provider     TEXT NOT NULL DEFAULT 'NONE',  -- NONE | WORKERS_AI
  status       TEXT NOT NULL DEFAULT 'PENDING',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_artifact ON artifact_embeddings(artifact_id);

-- Simple key/value store (dedupe markers, rollup watermarks, counters)
CREATE TABLE IF NOT EXISTS app_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
