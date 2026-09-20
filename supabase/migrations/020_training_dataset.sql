-- ── Migration 020: Image-crop training dataset ──────────────────────────────
-- Foundation for "upload → process → crop names → label → train" pipeline.
--
-- Three additions:
--   1. document_jobs.cell_polygons   — per-cell bounding polygons from Azure
--      layout extraction. Lets us crop the original image at any time without
--      re-running OCR.
--   2. training_dataset table         — one row per name crop. Stores the
--      image URL, OCR's guess, and the human-verified label.
--   3. training_crops storage bucket  — holds the cropped name images.

-- 1. Cell polygons on document_jobs ------------------------------------------
ALTER TABLE document_jobs
  ADD COLUMN IF NOT EXISTS cell_polygons JSONB;
COMMENT ON COLUMN document_jobs.cell_polygons IS
  'Per-cell bounding polygons for the structured table. Format: '
  '[{participant_index, field_name, page, polygon: [x1,y1,...,x4,y4]}]. '
  'Coordinates are in inches (Azure layout convention).';

-- 2. Training dataset table --------------------------------------------------
CREATE TABLE IF NOT EXISTS training_dataset (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID         NOT NULL REFERENCES document_jobs(id) ON DELETE CASCADE,
  participant_index INTEGER      NOT NULL,
  field_name        TEXT         NOT NULL,

  -- Storage path inside the `training_crops` bucket
  crop_path         TEXT         NOT NULL,

  -- What the OCR pipeline produced
  ocr_output        TEXT,

  -- Verified label (initially copied from ocr_output; admin edits to fix)
  label             TEXT,

  -- Lifecycle: pending = needs review; verified = label confirmed by admin;
  -- rejected = bad crop, exclude from training
  status            TEXT         NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'verified', 'rejected')),

  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       UUID,

  -- Don't double-crop the same cell on a re-run
  UNIQUE (job_id, participant_index, field_name)
);

CREATE INDEX IF NOT EXISTS training_dataset_status   ON training_dataset (status);
CREATE INDEX IF NOT EXISTS training_dataset_job      ON training_dataset (job_id);
CREATE INDEX IF NOT EXISTS training_dataset_pending  ON training_dataset (created_at) WHERE status = 'pending';

-- Service role only — never exposed to end users
ALTER TABLE training_dataset ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to training_dataset"
  ON training_dataset FOR ALL
  USING (true)
  WITH CHECK (true);

-- 3. Storage bucket ----------------------------------------------------------
-- Buckets aren't created by SQL migrations in Supabase. Create it manually:
--   Dashboard → Storage → New bucket
--     Name:    training_crops
--     Public:  OFF (use signed URLs)
--     File size limit: 5 MB
--     Allowed MIME types: image/png, image/jpeg
