-- ── Migration 023: Two-stage trainer → admin review queue ────────────────────
-- Trainer "verified" is no longer final. It now means "awaiting admin review".
-- Admin then approves (final, exportable) or rejects (kept for audit).
--
-- New status lifecycle:
--   pending   → trainer reviews
--   verified  → trainer marked good, awaiting admin
--   approved  → admin approved, FINAL, exported in CSV
--   rejected  → admin rejected (kept for audit, hidden from trainers)

-- 1. Drop the old CHECK constraint and add the new lifecycle ----------------
-- Postgres doesn't support direct CHECK rename; drop + re-add.
ALTER TABLE training_dataset
  DROP CONSTRAINT IF EXISTS training_dataset_status_check;

ALTER TABLE training_dataset
  ADD CONSTRAINT training_dataset_status_check
  CHECK (status IN ('pending', 'verified', 'approved', 'rejected'));

-- 2. Audit columns for trainer + admin actions ------------------------------
-- reviewed_at/reviewed_by were ambiguous — split into trainer + admin steps.
-- Old column is kept for backward compatibility but will not be written to.
ALTER TABLE training_dataset
  ADD COLUMN IF NOT EXISTS verified_by      UUID,
  ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by      UUID,
  ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by      UUID,
  ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS training_dataset_verified_by ON training_dataset (verified_by);
CREATE INDEX IF NOT EXISTS training_dataset_approved_by ON training_dataset (approved_by);
CREATE INDEX IF NOT EXISTS training_dataset_review_queue
  ON training_dataset (verified_at) WHERE status = 'verified';

COMMENT ON COLUMN training_dataset.verified_by IS 'Trainer who marked status=verified';
COMMENT ON COLUMN training_dataset.approved_by IS 'Admin who marked status=approved (final)';
COMMENT ON COLUMN training_dataset.rejected_by IS 'Admin who marked status=rejected';
