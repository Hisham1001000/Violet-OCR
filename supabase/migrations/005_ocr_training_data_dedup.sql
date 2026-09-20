-- Dedup ocr_training_data and enforce uniqueness.
--
-- Root cause fixed: collector could be called twice per run (same job/page/line),
-- and reruns of the same job duplicated every line. Result: 19.5k rows but only
-- ~1.4k unique crops. This migration:
--   1. Drops duplicate rows keeping oldest per (job_id, page_number, line_index)
--   2. Adds a UNIQUE constraint so future inserts can't duplicate
--   3. The collector also uses ON CONFLICT DO UPDATE (upsert) in Python

-- 1. Dedup existing rows (keep earliest created_at per key)
DELETE FROM ocr_training_data a
USING ocr_training_data b
WHERE a.job_id       = b.job_id
  AND a.page_number  = b.page_number
  AND a.line_index   = b.line_index
  AND a.created_at   > b.created_at;

-- Tie-breaker for identical created_at (shouldn't happen, but safe)
DELETE FROM ocr_training_data a
USING ocr_training_data b
WHERE a.job_id       = b.job_id
  AND a.page_number  = b.page_number
  AND a.line_index   = b.line_index
  AND a.created_at   = b.created_at
  AND a.id          > b.id;

-- 2. Enforce uniqueness
ALTER TABLE ocr_training_data
  ADD CONSTRAINT uniq_training_row UNIQUE (job_id, page_number, line_index);
