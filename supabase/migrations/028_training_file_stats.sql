-- ── Migration 028: aggregate the Files overview in the database ─────────────
-- The admin Files overview needed per-file counts, a thumbnail and the last
-- trainer to touch each file. It computed those by reading EVERY row of
-- training_dataset (9.4k rows and growing) in 1000-row pages on every page
-- load — 10 round trips, ~15 s, and the main recurring Disk IO source now that
-- several trainers refresh the page while reviewing.
--
-- This function does the same work as one grouped scan and returns ONE row per
-- job (~370), so the API transfers ~25x less and Postgres reads the index
-- rather than the whole heap.

CREATE OR REPLACE FUNCTION training_file_stats()
RETURNS TABLE (
  job_id        UUID,
  total         BIGINT,
  pending       BIGINT,
  verified      BIGINT,
  approved      BIGINT,
  rejected      BIGINT,
  last_activity TIMESTAMPTZ,
  thumb_path    TEXT,
  worker_id     UUID,
  worker_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.job_id,
    COUNT(*)                                              AS total,
    COUNT(*) FILTER (WHERE t.status = 'pending')          AS pending,
    COUNT(*) FILTER (WHERE t.status = 'verified')         AS verified,
    COUNT(*) FILTER (WHERE t.status = 'approved')         AS approved,
    COUNT(*) FILTER (WHERE t.status = 'rejected')         AS rejected,
    MAX(t.created_at)                                     AS last_activity,
    -- thumbnail: any crop belonging to the job
    (ARRAY_AGG(t.crop_path ORDER BY t.created_at))[1]     AS thumb_path,
    -- most recent trainer to verify a crop on this file, and when
    (ARRAY_AGG(t.verified_by ORDER BY t.verified_at DESC NULLS LAST)
       FILTER (WHERE t.verified_by IS NOT NULL))[1]       AS worker_id,
    MAX(t.verified_at)                                    AS worker_at
  FROM training_dataset t
  GROUP BY t.job_id;
$$;

-- Callable by the app's authenticated roles; the API route additionally gates
-- on assertTrainerOrAdmin before it ever reaches this.
GRANT EXECUTE ON FUNCTION training_file_stats() TO authenticated, service_role;

COMMENT ON FUNCTION training_file_stats() IS
  'Per-file aggregates for the admin training overview — replaces a full-table scan of training_dataset on every page load.';
