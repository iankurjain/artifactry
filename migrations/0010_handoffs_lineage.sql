-- ---------------------------------------------------------------------------
-- 0010 — Handoffs between AI tools, lineage, and projects
-- ---------------------------------------------------------------------------
--
-- What makes Artifactry the shared state between AI tools rather than storage
-- each tool uses alone:
--
--   * which tool saved each artifact and version, by the name the tool reports
--     for itself ("Claude", "Cursor"), not only the provider bucket;
--   * which artifacts a new one was built from (lineage);
--   * a handoff: a bundle of artifacts plus a brief that one tool leaves for
--     the next one to pick up;
--   * projects: collections marked as the home of a multi-tool piece of work.

-- The client name the connection reported in `initialize`. source_provider
-- stays the coarse bucket (CLAUDE, CHATGPT, API…); a Cursor connection is
-- source_provider 'API' and source_client 'Cursor'.
ALTER TABLE artifacts ADD COLUMN source_client TEXT;
ALTER TABLE artifact_versions ADD COLUMN source_client TEXT;

-- Artifacts saved before this migration carry the client name in their
-- metadata, so it is copied rather than lost.
UPDATE artifacts
   SET source_client = json_extract(metadata_json, '$.aiProvenance.clientName')
 WHERE source_client IS NULL
   AND json_valid(metadata_json)
   AND json_extract(metadata_json, '$.aiProvenance.clientName') IS NOT NULL;

-- "A was built from B". from_artifact_id is the newer artifact.
--   kind:   DERIVED_FROM (the only kind written today)
--   origin: DECLARED  the AI passed derived_from
--           INFERRED  the AI read B through this connection shortly before
--                     saving A and declared nothing
--           USER      added by a person in the app
CREATE TABLE IF NOT EXISTS artifact_links (
  id               TEXT PRIMARY KEY,
  from_artifact_id TEXT NOT NULL,
  to_artifact_id   TEXT NOT NULL,
  from_version_id  TEXT,
  kind             TEXT NOT NULL DEFAULT 'DERIVED_FROM',
  origin           TEXT NOT NULL DEFAULT 'DECLARED',
  source_provider  TEXT,
  source_client    TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (from_artifact_id, to_artifact_id, kind),
  FOREIGN KEY (from_artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY (to_artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_links_to ON artifact_links(to_artifact_id);

-- What each AI connection has read recently (get, get_handoff), so a save that
-- declares no sources can still record what it was most likely built from.
-- One row per connection and artifact; read_at moves forward on each read.
CREATE TABLE IF NOT EXISTS ai_reads (
  grant_id    TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  PRIMARY KEY (grant_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_reads_grant_time ON ai_reads(grant_id, read_at);

-- A handoff: a brief plus an ordered set of artifacts, left in a workspace by
-- one tool (or a person) for the next tool to pick up.
--   status: OPEN | PICKED_UP | CLOSED
CREATE TABLE IF NOT EXISTS handoffs (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT,
  workspace_id        TEXT NOT NULL,
  title               TEXT NOT NULL,
  brief               TEXT NOT NULL,
  to_tool             TEXT,
  status              TEXT NOT NULL DEFAULT 'OPEN',
  created_by          TEXT NOT NULL,
  source_provider     TEXT,
  source_client       TEXT,
  picked_up_by_client TEXT,
  picked_up_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_handoffs_ws_status ON handoffs(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS handoff_artifacts (
  handoff_id  TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (handoff_id, artifact_id),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_handoff_artifacts_artifact ON handoff_artifacts(artifact_id);

-- A project is a collection people (and their AI tools) point a multi-tool
-- piece of work at, e.g. "Q4 launch".
ALTER TABLE collections ADD COLUMN is_project INTEGER NOT NULL DEFAULT 0;
