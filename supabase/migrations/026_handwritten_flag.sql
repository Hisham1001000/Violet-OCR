-- ── Migration 026: handwritten flag on training crops ──────────────────────
-- The name-OCR model is for HANDWRITING, so printed name lists (typed rosters,
-- distributor sheets, transcripts) must be kept OUT of the training set. Azure
-- Document Intelligence tags each text span is_handwritten; the pipeline now
-- classifies each document by the fraction of its name cells that are
-- handwritten and records it here per crop:
--   true  = handwritten (keep for training)
--   false = printed (exclude)
--   null  = unknown (crop predates handwriting capture / not yet classified)

ALTER TABLE training_dataset
  ADD COLUMN IF NOT EXISTS handwritten BOOLEAN;

COMMENT ON COLUMN training_dataset.handwritten IS
  'true=handwritten (keep), false=printed (exclude), null=unknown. From Azure is_handwritten.';

CREATE INDEX IF NOT EXISTS training_dataset_handwritten ON training_dataset (handwritten);
