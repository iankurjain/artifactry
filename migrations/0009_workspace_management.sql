-- ---------------------------------------------------------------------------
-- 0009 — Workspace management and profile pictures
-- ---------------------------------------------------------------------------
--
-- Workspace settings (identity, regional, invitation controls), custom access
-- tiers, invitations, and uploaded pictures for users and workspaces.

-- Identity and preferences. settings_json holds:
--   regional:    { timeZone, dateFormat, language }
--   invitations: { allowedDomains: string[], requireApproval: bool,
--                  defaultRole, defaultCustomRoleId }
ALTER TABLE workspaces ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workspaces ADD COLUMN logo_r2_key TEXT;
ALTER TABLE workspaces ADD COLUMN logo_updated_at TEXT;

-- Profile pictures: 1:1, 320x320, at most 1 MB, stored in R2.
ALTER TABLE users ADD COLUMN avatar_r2_key TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

-- A member on a custom tier keeps a built-in role in workspace_members.role
-- (CONTRIBUTOR or VIEWER, never WORKSPACE_ADMIN) for anything that asks "is
-- this person an admin", while their permissions come from the tier.
--
-- workspace_members.status is now one of:
--   ACTIVE | PENDING_APPROVAL (joined, waiting for an admin) | REMOVED (deactivated)
ALTER TABLE workspace_members ADD COLUMN custom_role_id TEXT;

CREATE TABLE IF NOT EXISTS workspace_custom_roles (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  name               TEXT NOT NULL,
  permissions_json   TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_custom_roles_ws ON workspace_custom_roles(workspace_id, archived_at);

-- Invitations. An EMAIL invitation is for one address and one use; a LINK
-- invitation is for anyone who has it (subject to the workspace's allowed
-- domains), up to max_uses. Only the hash of the token is stored.
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  kind                TEXT NOT NULL,              -- EMAIL | LINK
  email_normalized    TEXT,
  token_hash          TEXT NOT NULL UNIQUE,
  token_prefix        TEXT NOT NULL,
  role                TEXT NOT NULL,              -- WORKSPACE_ADMIN | CONTRIBUTOR | VIEWER
  custom_role_id      TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ACCEPTED | REVOKED
  max_uses            INTEGER,
  use_count           INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  created_by_user_id  TEXT,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT,
  accepted_by_user_id TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invitations_ws ON workspace_invitations(workspace_id, status);
