-- ================================================================
-- 0002: per-user search history
--
-- Recent searches are scoped to one user, never global (§83). Kept in its
-- own migration so 0001 stays as the original baseline.
-- ================================================================

CREATE TABLE IF NOT EXISTS search_history (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  query      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);

-- Per-user, per-artifact favourites (listed under V1.1 in §116; the table
-- exists so the UI can ship without a further migration)
CREATE TABLE IF NOT EXISTS artifact_favorites (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (artifact_id, user_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
