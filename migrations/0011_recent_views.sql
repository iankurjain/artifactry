-- ---------------------------------------------------------------------------
-- 0011 — Recently viewed, per person
-- ---------------------------------------------------------------------------
--
-- Home's "Recently viewed" lists the artifacts this person last opened in the
-- app. artifact_events only records a view when bytes are fetched (an HTML
-- preview, an image, a download), so opening a PDF or PPTX left no trace.
-- One row per person and artifact; viewed_at moves forward on each open.
-- Not analytics: nothing here feeds view counts.
CREATE TABLE IF NOT EXISTS artifact_recent_views (
  user_id     TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  viewed_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, artifact_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recent_views_user ON artifact_recent_views(user_id, viewed_at DESC);
