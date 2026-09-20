-- ── Migration 027: cut Disk IO for the training Files overview ──────────────
-- The admin Files overview (GET /api/admin/training) scans the whole
-- training_dataset on every load to compute per-file counts, the newest thumb,
-- and which trainer last worked each file. Without a covering index that is a
-- full heap scan — the biggest recurring Disk IO source now that the dataset is
-- a few thousand rows.
--
-- This covering index lets Postgres satisfy that read with an INDEX-ONLY scan
-- (ordered by job_id, no heap fetches), which is what the route now orders by.
-- The INCLUDE columns are exactly the ones the overview selects.

CREATE INDEX IF NOT EXISTS training_dataset_overview
  ON training_dataset (job_id)
  INCLUDE (status, created_at, verified_by, verified_at, crop_path);

-- Keep planner stats fresh so it actually chooses the index-only scan.
ANALYZE training_dataset;
