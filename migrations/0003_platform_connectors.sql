-- ================================================================
-- Platform-defined AI connectors (§50, §58, §60)
--
-- These three rows are *reference data*, not demo data: the
-- integration_grants and MCP tool surface are unusable without them,
-- because connectIntegration() resolves the connector by id before it
-- will issue a scoped grant.
--
-- They live in a migration (rather than seed.sql) so that a fresh
-- production database — which receives schema migrations but never
-- demo seed data — still comes up with a working connector catalog.
--
-- organization_id and user_id are NULL, which is what marks a
-- connector as platform-defined rather than tenant-owned.
-- ================================================================

INSERT OR IGNORE INTO integrations
  (id, organization_id, user_id, provider, name, description, status, created_at, updated_at)
VALUES
  ('int_chatgpt', NULL, NULL, 'CHATGPT', 'ChatGPT', 'OpenAI / ChatGPT connector via MCP', 'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
  ('int_claude',  NULL, NULL, 'CLAUDE',  'Claude',  'Anthropic Claude connector via MCP', 'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
  ('int_gemini',  NULL, NULL, 'GEMINI',  'Gemini',  'Google Gemini connector via MCP',    'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z');
