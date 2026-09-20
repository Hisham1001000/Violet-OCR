-- ── Migration 024: RLS hardening for training tables ────────────────────────
-- Closes two data-exposure holes found in the pre-beta security review.
--
-- Threat model: NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the browser. Any table
-- in the public schema that is either (a) RLS-disabled, or (b) RLS-enabled with
-- a permissive `USING (true)` policy, is therefore readable/writable by anyone
-- on the internet via the PostgREST endpoint. Both training tables contain
-- personal data extracted from EVERY user's documents (names + cropped images),
-- so they must be reachable only by the service role (the pipeline + admin API
-- routes, which already use SUPABASE_SERVICE_ROLE_KEY and bypass RLS entirely).
--
-- This migration is additive and safe to run on a live database: the admin UI
-- and pipeline use the service-role client, which is unaffected by RLS.

-- ── C1: ocr_training_data had NO row-level security at all ──────────────────
-- Created in migration 004 without ENABLE ROW LEVEL SECURITY, so it was fully
-- exposed to the anon/authenticated roles. Enabling RLS with no permissive
-- policy means only the service role can touch it.
ALTER TABLE ocr_training_data ENABLE ROW LEVEL SECURITY;

-- Defensively drop any policy that might have been added by hand.
DROP POLICY IF EXISTS "Public read ocr_training_data"    ON ocr_training_data;
DROP POLICY IF EXISTS "Anyone can read ocr_training_data" ON ocr_training_data;

-- ── C2: training_dataset had a permissive `USING (true)` policy ─────────────
-- Migration 020 added "Service role full access ... USING (true) WITH CHECK
-- (true)". The service role bypasses RLS regardless, so the only practical
-- effect of that policy was granting full read/update/DELETE to every
-- authenticated (and anon) user. Drop it. With RLS still enabled and no
-- permissive policy remaining, end users are locked out and the service role
-- continues to work.
DROP POLICY IF EXISTS "Service role full access to training_dataset" ON training_dataset;

-- training_dataset already has RLS enabled (migration 020); assert it in case
-- this runs against a database where that was rolled back.
ALTER TABLE training_dataset ENABLE ROW LEVEL SECURITY;

-- ── Verification (run manually after applying) ──────────────────────────────
-- With the anon key, both queries MUST return zero rows / permission denied:
--   SELECT count(*) FROM ocr_training_data;
--   SELECT count(*) FROM training_dataset;
-- With the service-role key (pipeline + admin routes), both still work.
