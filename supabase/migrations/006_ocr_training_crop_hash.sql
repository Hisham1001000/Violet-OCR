-- Cross-job dedup: ensure each unique crop image is stored only once.
--
-- Same PDF uploaded N times = N different job_ids but identical crop_b64.
-- For training we want unique crops, not duplicate samples. This migration:
--   1. Adds crop_sha1 column (SHA1 hex of crop_b64)
--   2. Backfills it for existing rows
--   3. Dedups: keep oldest row per crop_sha1
--   4. Adds UNIQUE constraint so future inserts auto-skip duplicates

-- 1. Column
ALTER TABLE ocr_training_data
  ADD COLUMN IF NOT EXISTS crop_sha1 TEXT;

-- 2. Backfill (encode crop_b64 as bytes -> sha1 -> hex)
UPDATE ocr_training_data
   SET crop_sha1 = encode(digest(crop_b64, 'sha1'), 'hex')
 WHERE crop_sha1 IS NULL;

-- digest() needs pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE ocr_training_data
   SET crop_sha1 = encode(digest(crop_b64, 'sha1'), 'hex')
 WHERE crop_sha1 IS NULL;

-- 3. Dedup: keep oldest row per crop_sha1
DELETE FROM ocr_training_data a
USING ocr_training_data b
WHERE a.crop_sha1 = b.crop_sha1
  AND (a.created_at > b.created_at
       OR (a.created_at = b.created_at AND a.id > b.id));

-- 4. Enforce uniqueness for the future
ALTER TABLE ocr_training_data
  ALTER COLUMN crop_sha1 SET NOT NULL;

ALTER TABLE ocr_training_data
  ADD CONSTRAINT uniq_training_crop UNIQUE (crop_sha1);
