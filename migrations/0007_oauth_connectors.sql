-- ---------------------------------------------------------------------------
-- 0007 — OAuth 2.1 sign-in for AI connectors
-- ---------------------------------------------------------------------------
--
-- ChatGPT, Claude (web, desktop, mobile), Gemini Enterprise and Microsoft
-- Copilot Studio can only connect to a remote MCP server through OAuth (or no
-- auth at all). None of them lets a user paste a static bearer token, so the
-- copy-a-token flow in Settings is unusable from those clients.
--
-- This migration adds the minimum an OAuth 2.1 authorization server needs and
-- keeps the rest of the system unchanged: an OAuth access token IS an
-- integration_grants row, so scope checks, provenance, analytics, revocation
-- and the "AI permission <= user permission" rule all apply exactly as they do
-- to a pasted token.

-- ---------------------------------------------------------- oauth_clients ---
--
-- Clients registered through Dynamic Client Registration (RFC 7591), or by a
-- signed-in user for clients that need a manually entered client id/secret
-- (Gemini Enterprise, Copilot Studio "Manual"). A public client (PKCE only)
-- has no secret; a confidential client stores only a hash of its secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                  TEXT PRIMARY KEY,           -- the client_id
  client_name         TEXT,
  redirect_uris       TEXT NOT NULL,              -- JSON array of exact URIs
  secret_hash         TEXT,                       -- NULL => public client
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  integration_id      TEXT NOT NULL,              -- which connector row it maps to
  created_by_user_id  TEXT,                       -- NULL => self-registered via DCR
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at          TEXT NOT NULL
);

-- ------------------------------------------------------------ oauth_codes ---
--
-- Single-use authorization codes. Only the hash is stored; the code is bound
-- to the client, redirect URI, PKCE challenge, user and approved scopes.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scopes          TEXT NOT NULL,                  -- JSON array
  resource        TEXT,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_codes(expires_at);

-- ---------------------------------------------------- integration_grants ---
--
-- A pasted token has expires_at NULL and never expires, as before. An OAuth
-- grant carries a short-lived access token and a rotating refresh token.
ALTER TABLE integration_grants ADD COLUMN expires_at TEXT;
ALTER TABLE integration_grants ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE integration_grants ADD COLUMN refresh_expires_at TEXT;
ALTER TABLE integration_grants ADD COLUMN oauth_client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_grants_refresh ON integration_grants(refresh_token_hash);

-- ------------------------------------------------------------- connectors ---
--
-- Copilot joins the platform-defined catalog; "Other MCP client" is where
-- anything that does not identify as one of the four lands (Gemini CLI,
-- Cursor, a script), so provenance never guesses.
INSERT OR IGNORE INTO integrations
  (id, organization_id, user_id, provider, name, description, status, created_at, updated_at)
VALUES
  ('int_copilot', NULL, NULL, 'COPILOT', 'Microsoft Copilot', 'Microsoft Copilot Studio agent via MCP', 'ACTIVE', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z'),
  ('int_other',   NULL, NULL, 'CUSTOM',  'Other MCP client',  'Any other MCP client signed in with OAuth', 'ACTIVE', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
