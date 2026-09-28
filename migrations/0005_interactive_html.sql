-- Interactive HTML preview (per-artifact rendering mode).
--
-- Two explicit modes:
--   OFF (0) — "Safe Preview": HTML and CSS render, JavaScript never executes.
--   ON  (1) — "Interactive Preview": JavaScript executes, but only on the
--             separate preview origin (PREVIEW_ORIGIN), never on the main
--             application origin.
--
-- Default 0 is the security posture, not a UI preference: an artifact can only
-- become script-executing by an explicit, audited owner action. Every write
-- path that flips this flag also records an audit event.
--
-- INTEGER rather than BOOLEAN: D1/SQLite has no native boolean, and existing
-- flags in this schema (allow_view, allow_download, include_new_items) are all
-- INTEGER with a numeric default, so this stays consistent with them.
ALTER TABLE artifacts ADD COLUMN interactive_html INTEGER NOT NULL DEFAULT 0;

-- The setting is only ever read per-artifact, and only after the artifact row
-- is already loaded by primary key, so no index is warranted here.
