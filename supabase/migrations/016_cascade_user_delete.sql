-- Cascade FKs so hard-deleting an auth.users row cleans up everything.
-- Admin "Delete Account" action calls auth.admin.deleteUser(id) which should
-- remove user_profiles (already cascades), document_jobs + pages, waitlist, etc.
--
-- This migration retargets FKs that weren't cascading.

-- 1. document_jobs.user_id — was NOT NULL without ON DELETE action.
--    Change to CASCADE so delete nukes the user's docs too.
ALTER TABLE document_jobs
  DROP CONSTRAINT IF EXISTS document_jobs_user_id_fkey;

ALTER TABLE document_jobs
  ADD CONSTRAINT document_jobs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. ocr_training_data.user_id — had no FK at all. Add one with SET NULL so
--    training crops survive user deletion (training data is valuable, not PII-heavy).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ocr_training_data_user_id_fkey'
  ) THEN
    ALTER TABLE ocr_training_data
      ADD CONSTRAINT ocr_training_data_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Drop is_deleted / deleted_at — delete is now hard, row won't exist.
--    Keep is_banned. This undoes part of migration 015.
ALTER TABLE user_profiles
  DROP COLUMN IF EXISTS is_deleted,
  DROP COLUMN IF EXISTS deleted_at;

DROP INDEX IF EXISTS user_profiles_is_deleted_idx;
