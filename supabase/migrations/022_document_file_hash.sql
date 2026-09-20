-- ── Migration 022: file_hash on document_jobs (upload dedup) ────────────────
-- Adds a SHA-256 hash of the uploaded file. Uploading the exact same file
-- twice as the same user is now blocked at the API layer (returns 409 with
-- the existing job_id so the UI can navigate to it instead of duplicating).
--
-- Different users uploading the same file is still allowed — that's a
-- legitimate cross-tenant scenario, not a duplicate.

ALTER TABLE document_jobs
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

COMMENT ON COLUMN document_jobs.file_hash IS
  'SHA-256 of the uploaded file bytes (lowercase hex). Used for upload dedup.';

-- Lookup index: find existing jobs by (user, hash) on every upload.
CREATE INDEX IF NOT EXISTS document_jobs_user_hash
  ON document_jobs (user_id, file_hash)
  WHERE file_hash IS NOT NULL;
