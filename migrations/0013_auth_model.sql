-- ---------------------------------------------------------------------------
-- 0013 — Auth model: OAuth for AI apps, scoped personal access tokens for the
--        rest, Client ID Metadata Documents, and a per-call audit trail
-- ---------------------------------------------------------------------------
--
-- Every credential stays an integration_grants row, so scope checks, the
-- "AI permission <= user permission" rule, provenance and revocation keep
-- working exactly as they do today. What changes is that a row now says which
-- kind of credential it is:
--
--   CONNECTOR  a token pasted into one AI app from the old per-connector
--              Connect sheet (every row that exists before this migration
--              and was not issued by OAuth). Keeps working, never expires.
--   OAUTH      issued by /oauth/token: short-lived access token plus a
--              rotating refresh token, one grant per user per OAuth client.
--   PAT        a personal access token created by the user with a name,
--              explicit scopes and an optional expiry. A user can hold many,
--              and each one is revoked on its own.
ALTER TABLE integration_grants ADD COLUMN kind TEXT NOT NULL DEFAULT 'CONNECTOR';
ALTER TABLE integration_grants ADD COLUMN name TEXT;
UPDATE integration_grants SET kind = 'OAUTH' WHERE oauth_client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_grants_user_kind ON integration_grants(user_id, kind, status);

-- ---------------------------------------------------------- oauth_clients ---
--
-- A client may identify itself with an https URL as its client_id (Client ID
-- Metadata Document, the MCP spec's preferred registration). The document is
-- fetched from that URL and cached in this row; metadata_fetched_at says when,
-- so a stale copy is fetched again on the next sign-in.
ALTER TABLE oauth_clients ADD COLUMN metadata_fetched_at TEXT;
