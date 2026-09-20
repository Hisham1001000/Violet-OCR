-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 040 — close the PostgREST surface that 009/010/011/019/028 left open
--
-- Threat model, unchanged since 024: NEXT_PUBLIC_SUPABASE_ANON_KEY ships inside
-- every browser that loads violetocr.com. Anything in the `public` schema that
-- has RLS off, a USING (true) policy, or is a SECURITY DEFINER function without
-- a REVOKE, is reachable by anyone on the internet at /rest/v1/ — no account
-- required. Migrations 030/033/037/039 applied that reasoning to the money
-- path; these six objects predate it and were never revisited.
--
-- Every object below was grepped for callers first. The only one with a live
-- user-token caller is upsert_ocr_corrections, called from
-- frontend/src/app/api/documents/[id]/corrections/route.ts. That route was
-- switched to the service role in the deploy that PRECEDES this migration.
--
--   DO NOT APPLY THIS BEFORE THAT DEPLOY IS LIVE, or saving a corrected cell
--   stops propagating to future documents (silently — the route logs and
--   continues, by design, so the user still sees their edit saved).
--
-- Verify with: python scripts/verify_security.py   (expects every row CLOSED)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. extracted_names (019) ────────────────────────────────────────────────
-- Created without `security_invoker`, so it would run with its OWNER's
-- privileges and ignore the RLS of the tables underneath: one anonymous GET
-- would return every user's extracted names, document_name and document_url,
-- routing around the column revokes in 032/033/039. Zero callers in the app.
--
-- Probed on 2026-09-20 with both the anon and the service key: the view does
-- NOT exist in this database (PGRST205), i.e. migration 019 was never applied,
-- so nothing was exposed. 019 itself now creates it safely. This block is
-- conditional so the migration is correct either way — and so it does not
-- abort on a database where 019 never ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'extracted_names') THEN
    EXECUTE 'ALTER VIEW public.extracted_names SET (security_invoker = on)';
    EXECUTE 'REVOKE ALL ON public.extracted_names FROM anon, authenticated';
  END IF;
END $$;

-- ── 2. upsert_ocr_corrections (011) ─────────────────────────────────────────
-- SECURITY DEFINER with no REVOKE. PostgREST publishes every public function,
-- so anyone could rewrite the global find-and-replace table that
-- execution/process_document.py applies to every future document, for every
-- customer. The highest-leverage hole in the database: unauthenticated,
-- persistent poisoning of other people's OCR output.
ALTER FUNCTION public.upsert_ocr_corrections(JSONB) SET search_path = public;
REVOKE ALL ON FUNCTION public.upsert_ocr_corrections(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_ocr_corrections(JSONB) TO service_role;

-- ── 3. training_file_stats (028) ────────────────────────────────────────────
-- SECURITY DEFINER over training_dataset — a table 024 deliberately locked to
-- the service role — but granted to `authenticated`. The comment in 028 says
-- the API route gates it with assertTrainerOrAdmin; there is no such route
-- (zero callers in the whole tree), and PostgREST exposes the RPC directly.
REVOKE ALL ON FUNCTION public.training_file_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.training_file_stats() TO service_role;

-- ── 4. increment_pages_used (003) ───────────────────────────────────────────
-- SECURITY DEFINER, no REVOKE, no search_path. Belonged to the monthly-page
-- plan that 030 replaced with pay-per-row; no caller since. Left callable, it
-- lets any account inflate another account's usage counter.
ALTER FUNCTION public.increment_pages_used(UUID, INTEGER) SET search_path = public;
REVOKE ALL ON FUNCTION public.increment_pages_used(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_pages_used(UUID, INTEGER) TO service_role;

-- ── 5. reset_monthly_usage (003) ────────────────────────────────────────────
-- Its trigger was dropped in 030_pay_per_row.sql and nothing calls it. Not a
-- privilege hole (SECURITY INVOKER), removed because dead SQL in a public repo
-- reads as live SQL to anyone auditing it.
DROP FUNCTION IF EXISTS public.reset_monthly_usage() CASCADE;

-- ── 6. field_corrections (009) ──────────────────────────────────────────────
-- "Service role can read all corrections ... USING (true)" — the service role
-- bypasses RLS entirely, so this policy never did anything FOR the service
-- role. What it actually did was grant every signed-in user SELECT over every
-- cell every customer has ever corrected: original and corrected personal
-- names, side by side. Nothing in the app reads this table with a user token;
-- the pipeline reads it with the service role.
DROP POLICY IF EXISTS "Service role can read all corrections" ON public.field_corrections;

-- The insert policy asked only "are you signed in?", so any account could write
-- corrections against any job_id. Bind it to the caller's own job.
--
-- Both sides are cast to text on purpose. 009 declares job_id as TEXT, but the
-- live database has it as uuid — the schema was altered by hand at some point
-- and the migrations never recorded it. Casting both sides works on either
-- shape, so this migration applies to production and to a fresh install built
-- from these files.
DROP POLICY IF EXISTS "Users can insert their own corrections" ON public.field_corrections;
CREATE POLICY "Users insert corrections on their own jobs"
  ON public.field_corrections FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.document_jobs j
     WHERE j.id::text = field_corrections.job_id::text
       AND j.user_id  = auth.uid()
  ));

-- ── 7. ocr_corrections (009) ────────────────────────────────────────────────
-- SELECT USING (true) plus FOR ALL USING (true) WITH CHECK (true): global read
-- AND global write/delete of the correction rules themselves. Only Python
-- touches this table, always with the service role.
DROP POLICY IF EXISTS "All users can read ocr_corrections"     ON public.ocr_corrections;
DROP POLICY IF EXISTS "Service role can write ocr_corrections" ON public.ocr_corrections;
REVOKE ALL ON public.ocr_corrections FROM anon, authenticated;

-- ── 8. name_candidates (010) ────────────────────────────────────────────────
-- FOR ALL USING (true) WITH CHECK (true) — full read/write/delete of the name
-- dictionary staging table. Written only by execution/grow_name_dict.py and
-- read by execution/ocr_voter.py, both with the service role.
DROP POLICY IF EXISTS "Service role full access to name_candidates" ON public.name_candidates;
REVOKE ALL ON public.name_candidates FROM anon, authenticated;

-- ── 9. Belt and braces for 024 ──────────────────────────────────────────────
-- 024 enabled RLS on the training tables but left the table-level grants in
-- place. RLS with no permissive policy already denies them; removing the
-- privilege too means a future accidental policy cannot quietly re-open them.
REVOKE ALL ON public.training_dataset FROM anon, authenticated;

COMMIT;
