-- ================================================================
-- Local development seed data
-- Idempotent: safe to re-run via `npm run db:seed`
-- ================================================================

-- Demo user (auth is passwordless; this user signs in with a dev code)
INSERT OR IGNORE INTO users (id, email, email_normalized, email_verified_at, display_name, status, created_at, updated_at)
VALUES (
  'usr_demo0001',
  'demo@artifactlibrary.dev',
  'demo@artifactlibrary.dev',
  '2026-09-01T09:00:00.000Z',
  'Demo User',
  'ACTIVE',
  '2026-09-01T09:00:00.000Z',
  '2026-09-01T09:00:00.000Z'
);

-- Personal workspace (auto-created on registration in the real flow, §6)
INSERT OR IGNORE INTO workspaces (id, organization_id, owner_user_id, workspace_type, name, description, created_at, created_by)
VALUES (
  'ws_personal_demo',
  NULL,
  'usr_demo0001',
  'PERSONAL',
  'Personal',
  'Your private workspace',
  '2026-09-01T09:00:00.000Z',
  'usr_demo0001'
);

INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by)
VALUES (
  'wsm_demo_owner',
  'ws_personal_demo',
  'usr_demo0001',
  'WORKSPACE_ADMIN',
  '2026-09-01T09:00:00.000Z',
  'usr_demo0001'
);

-- Demo organization with two workspaces (§7, §27)
INSERT OR IGNORE INTO organizations (id, name, slug, plan, max_upload_bytes, settings_json, status, created_by, created_at, updated_at)
VALUES (
  'org_acme0001',
  'Acme Corporation',
  'acme',
  'TEAM',
  26214400,
  '{"showVerifiedExternalViewerIdentity":false}',
  'ACTIVE',
  'usr_demo0001',
  '2026-09-02T09:00:00.000Z',
  '2026-09-02T09:00:00.000Z'
);

INSERT OR IGNORE INTO organization_members (id, organization_id, user_id, role, created_at, created_by, status)
VALUES (
  'orgm_demo_owner',
  'org_acme0001',
  'usr_demo0001',
  'ORG_OWNER',
  '2026-09-02T09:00:00.000Z',
  'usr_demo0001',
  'ACTIVE'
);

INSERT OR IGNORE INTO workspaces (id, organization_id, owner_user_id, workspace_type, name, description, created_at, created_by)
VALUES
  ('ws_acme_strategy', 'org_acme0001', 'usr_demo0001', 'ORGANIZATION', 'Strategy', 'Board and strategy material', '2026-09-02T09:05:00.000Z', 'usr_demo0001'),
  ('ws_acme_marketing', 'org_acme0001', 'usr_demo0001', 'ORGANIZATION', 'Marketing', 'Campaign and brand artifacts', '2026-09-02T09:06:00.000Z', 'usr_demo0001');

INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role, created_at, created_by)
VALUES
  ('wsm_acme_strat_owner', 'ws_acme_strategy', 'usr_demo0001', 'WORKSPACE_ADMIN', '2026-09-02T09:05:00.000Z', 'usr_demo0001'),
  ('wsm_acme_mkt_owner', 'ws_acme_marketing', 'usr_demo0001', 'WORKSPACE_ADMIN', '2026-09-02T09:06:00.000Z', 'usr_demo0001');

-- Admin-governed tag taxonomy (§24) — personal scope
INSERT OR IGNORE INTO tags (id, organization_id, scope, name, slug, description, color, status, created_by, created_at, updated_at)
VALUES
  ('tag_ai',        NULL, 'PERSONAL', 'AI',         'ai',         'Artifacts produced with or about AI', 'violet', 'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_energy',    NULL, 'PERSONAL', 'Energy',     'energy',     'Energy sector material',              'amber',  'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_strategy',  NULL, 'PERSONAL', 'Strategy',   'strategy',   'Strategy and planning',               'blue',   'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_proposal',  NULL, 'PERSONAL', 'Proposal',   'proposal',   'Commercial proposals',                'emerald','ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_malaysia',  NULL, 'PERSONAL', 'Malaysia',   'malaysia',   'Malaysia related',                    'rose',   'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_board',     NULL, 'PERSONAL', 'Board',      'board',      'Board-level material',                'slate',  'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_customer',  NULL, 'PERSONAL', 'Customer',   'customer',   'Customer-facing artifacts',           'cyan',   'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
  ('tag_product',   NULL, 'PERSONAL', 'Product',    'product',    'Product material',                    'indigo', 'ACTIVE', 'usr_demo0001', '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z');

-- Platform-defined AI connectors (§50, §60)
INSERT OR IGNORE INTO integrations (id, organization_id, user_id, provider, name, description, status, created_at, updated_at)
VALUES
  ('int_chatgpt', NULL, NULL, 'CHATGPT', 'ChatGPT', 'OpenAI / ChatGPT connector via MCP', 'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
  ('int_claude',  NULL, NULL, 'CLAUDE',  'Claude',  'Anthropic Claude connector via MCP', 'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
  ('int_gemini',  NULL, NULL, 'GEMINI',  'Gemini',  'Google Gemini connector via MCP',    'ACTIVE', '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z');
