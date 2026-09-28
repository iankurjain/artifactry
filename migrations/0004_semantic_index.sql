-- ---------------------------------------------------------------
-- 0004 — Semantic search bookkeeping (PRD §31, §32, §94)
--
-- Vectorize has no delete-by-metadata, so D1 is the authoritative mirror of
-- every vector we have written: stale vectors are deleted by id, looked up
-- from here. Tenant identifiers are denormalised onto each row so an index
-- audit can prove which workspace a vector belongs to without reading the
-- vector store.
--
-- Index contract (also documented in README.md and wrangler.jsonc):
--   index      artifact-library-embeddings
--   model      @cf/baai/bge-base-en-v1.5
--   dimensions 768
--   metric     cosine
--   vector id  {artifactId}__{versionId}__{chunkIndex}
-- ---------------------------------------------------------------

ALTER TABLE artifact_embeddings ADD COLUMN workspace_id    TEXT;
ALTER TABLE artifact_embeddings ADD COLUMN organization_id TEXT;
ALTER TABLE artifact_embeddings ADD COLUMN chunk_total     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_embeddings ADD COLUMN updated_at      TEXT;

-- Reconciling the index for one artifact is the hot path (every upload,
-- every new version, every delete), so it is indexed on artifact_id and
-- version_id together.
CREATE INDEX IF NOT EXISTS idx_embeddings_artifact_version
  ON artifact_embeddings(artifact_id, version_id);

-- Scoping audit: "which vectors exist for these workspaces?"
CREATE INDEX IF NOT EXISTS idx_embeddings_workspace
  ON artifact_embeddings(workspace_id);

-- Per-artifact indexing state is derived from the latest EMBED job.
CREATE INDEX IF NOT EXISTS idx_jobs_artifact_type
  ON processing_jobs(artifact_id, job_type, updated_at DESC);
