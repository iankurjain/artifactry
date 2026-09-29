-- ---------------------------------------------------------------------------
-- 0006 — Job-oriented MCP surface: teams, tag states, and confirmations
-- ---------------------------------------------------------------------------
--
-- Three related changes, all of which exist to support the Find → Save → Share
-- mental model rather than low-level storage primitives:
--
--   1. TEAMS — a reusable named audience, so an agent can share with
--      "Board prep" instead of repeating individual email addresses.
--   2. TAG STATES — tags become AI-suggested and human-decided. A decision
--      (confirmed / rejected) has to be *remembered*, which is why rejection is
--      a stored state and not a deleted row.
--   3. CONFIRMATIONS — a share that broadens access past the organization must
--      be explicitly confirmed by the user, and that confirmation is recorded
--      server-side against the exact request it authorised.
--
-- Nothing here changes the existing authorization model. Teams resolve to
-- emails that still prove control via OTP; tag states only narrow what the
-- search index contains; confirmations gate an action that already required
-- the share.create permission.

-- ------------------------------------------------------------------ teams ---
--
-- Scope mirrors the existing tenancy model. An ORGANIZATION team belongs to an
-- organization (required); a WORKSPACE team is additionally pinned to one
-- workspace. organization_id is what bounds every team share at evaluation
-- time, so it is NOT NULL by design — a team with no tenant would be
-- unscopeable and is not expressible.
CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  workspace_id    TEXT,                          -- set for WORKSPACE-scoped teams
  scope           TEXT NOT NULL DEFAULT 'ORGANIZATION',  -- ORGANIZATION | WORKSPACE
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  owner_user_id   TEXT NOT NULL,                 -- owner/admin of the audience
  status          TEXT NOT NULL DEFAULT 'ACTIVE',-- ACTIVE | INACTIVE
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (organization_id, slug),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id);
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);

-- Membership is keyed by normalized email because a named audience must be
-- expressible before every member has an account. When the address does
-- correspond to a user, user_id is filled in so the UI can show a person rather
-- than a string. UNIQUE(team_id, email_normalized) is what makes membership
-- idempotent — adding the same person twice converges instead of duplicating.
CREATE TABLE IF NOT EXISTS team_members (
  id               TEXT PRIMARY KEY,
  team_id          TEXT NOT NULL,
  user_id          TEXT,                         -- NULL until the address signs up
  email_normalized TEXT NOT NULL,
  display_name     TEXT,
  role             TEXT NOT NULL DEFAULT 'MEMBER', -- ADMIN | MEMBER
  status           TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | INACTIVE
  created_at       TEXT NOT NULL,
  created_by       TEXT,
  UNIQUE (team_id, email_normalized),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id, status);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email_normalized);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Links a share to the team it was addressed to.
--
-- The individual member emails are ALSO materialised into share_recipients at
-- creation time, so the existing EMAIL access path works with no change and the
-- audience that existed at share time is preserved on the record. This table
-- additionally makes membership live: evaluateShareAccess() accepts a verified
-- email that is a current active member of a linked team, so "share with Board
-- prep" keeps meaning "whoever is on Board prep" — adding or removing a member
-- changes access without re-issuing the link.
CREATE TABLE IF NOT EXISTS share_teams (
  id         TEXT PRIMARY KEY,
  share_id   TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (share_id, team_id),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_share_teams_share ON share_teams(share_id);
CREATE INDEX IF NOT EXISTS idx_share_teams_team ON share_teams(team_id);

-- ------------------------------------------------------------- tag states ---
--
-- A tag association is now a *decision record*, not just a link. The state
-- lives on the association because the same tag can be confirmed on one
-- artifact and rejected on another.
--
-- Existing rows are backfilled to CONFIRMED / USER: every association that
-- exists today was made deliberately by a person through the API, so treating
-- it as decided is the only faithful reading. Defaulting them to SUGGESTED
-- would retroactively demote real user decisions to machine guesses and, worse,
-- drop them out of the search index (which indexes confirmed tags only).
ALTER TABLE artifact_tags ADD COLUMN state TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE artifact_tags ADD COLUMN provenance TEXT NOT NULL DEFAULT 'USER';
-- Which version's content produced a suggestion. Compared against the current
-- version to decide whether a previously rejected tag may be offered again:
-- re-suggesting on unchanged content ignores the user's decision, so it is
-- disallowed; a materially new version is a new basis and may re-suggest.
ALTER TABLE artifact_tags ADD COLUMN source_version_id TEXT;
ALTER TABLE artifact_tags ADD COLUMN decided_by TEXT;
ALTER TABLE artifact_tags ADD COLUMN decided_at TEXT;

CREATE INDEX IF NOT EXISTS idx_artifact_tags_state ON artifact_tags(artifact_id, state);

-- -------------------------------------------------------- confirmations -----
--
-- A pending confirmation is stored server-side and bound to a hash of the exact
-- normalised request that will execute. That binding is the point: without it a
-- model could obtain confirmation for a share to two colleagues and then
-- execute a public link, because the "confirm" flag would be the only thing
-- carried forward. Re-presenting a different request cannot consume this
-- confirmation.
CREATE TABLE IF NOT EXISTS mcp_confirmations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  grant_id      TEXT,
  tool          TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  summary       TEXT NOT NULL,                   -- human-readable, shown to the user
  audience_note TEXT,                            -- why confirmation is required
  status        TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CONSUMED | CANCELLED | EXPIRED
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_confirmations_user ON mcp_confirmations(user_id, status, expires_at);

-- ---------------------------------------------------------- provenance ------
--
-- The MCP client name ("Claude Desktop", "ChatGPT") is reported once in the
-- initialize handshake. Storing it on the grant lets every subsequent tool call
-- record which AI application acted, which §59-style provenance requires and
-- which analytics needs in order to attribute AI activity to a client.
ALTER TABLE integration_grants ADD COLUMN client_name TEXT;
ALTER TABLE integration_grants ADD COLUMN client_version TEXT;

-- Organization-level tag policy.
--
-- The taxonomy change lets users create their own tags. An organization can
-- turn that off without losing the admin-managed canonical set, so the flag is
-- read per organization rather than being global. Absent (or not exactly false)
-- means allowed — the permissive default is deliberate, because the product
-- decision was to let users tag their own work.
UPDATE organizations
   SET settings_json = json_set(settings_json, '$.allowUserTags', json('true'))
 WHERE json_extract(settings_json, '$.allowUserTags') IS NULL;
