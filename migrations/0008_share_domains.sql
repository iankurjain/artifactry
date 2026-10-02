-- ---------------------------------------------------------------------------
-- 0008 — Custom share domains
-- ---------------------------------------------------------------------------
--
-- A workspace admin can put every share link the workspace issues on a
-- hostname they control (for example share.acme.com) instead of
-- artifactry.app. People who want a link on artifactry.app keep that artifact
-- in a different workspace. The hostname only ever serves the external recipient
-- surface: /s/:token and the share APIs behind it. Sign-in, the library and
-- every other route stay on the application origin, so a session cookie never
-- reaches a customer's domain.
--
-- A domain moves through these states:
--
--   PENDING_DNS   claimed, waiting for the _artifactry-challenge TXT record
--   PENDING_CERT  ownership proven; Cloudflare is provisioning the hostname
--                 and its certificate
--   ACTIVE        share links are issued on this hostname and it serves them
--   ERROR         Cloudflare refused the hostname; last_error says why
--
-- One domain per workspace, organization workspaces only. A hostname may be
-- claimed by several workspaces while unproven (so nobody can squat a name
-- they do not own), but only one row per hostname can ever pass verification.

CREATE TABLE IF NOT EXISTS workspace_share_domains (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL UNIQUE,
  organization_id        TEXT,
  hostname               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'PENDING_DNS',
  verification_token     TEXT NOT NULL,
  cf_custom_hostname_id  TEXT,
  last_error             TEXT,
  verified_at            TEXT,
  activated_at           TEXT,
  last_checked_at        TEXT,
  created_by_user_id     TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_share_domains_verified_host
  ON workspace_share_domains(hostname) WHERE verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_share_domains_host
  ON workspace_share_domains(hostname, status);
