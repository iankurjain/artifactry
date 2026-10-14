-- An artifact belongs to at most one collection.
--
-- Until now an artifact could sit in any number of a workspace's collections.
-- For artifacts that are in several today, keep one membership: a live
-- (unarchived) collection before an archived one, then the most recently
-- added. Every write path now moves an artifact (drops its other membership)
-- rather than adding a second one, and the unique index below makes a second
-- membership impossible.

DELETE FROM collection_artifacts
 WHERE id NOT IN (
   SELECT id FROM (
     SELECT ca.id,
            ROW_NUMBER() OVER (
              PARTITION BY ca.artifact_id
              ORDER BY (c.archived_at IS NOT NULL) ASC, ca.added_at DESC, ca.id DESC
            ) AS rn
       FROM collection_artifacts ca
       LEFT JOIN collections c ON c.id = ca.collection_id
   )
   WHERE rn = 1
 );

CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_artifacts_artifact ON collection_artifacts(artifact_id);
