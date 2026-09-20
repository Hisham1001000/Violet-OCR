-- ── Migration 019: Centralized "extracted names" view ─────────────────────────
-- One row per name extracted from any uploaded document. Derives live from
-- existing tables — no duplication, always up to date.
--
-- Each row:
--   final_value    = what's currently shown to the user (corrected if user
--                    edited it, otherwise the OCR output)
--   ocr_output     = what the OCR pipeline originally produced
--   was_corrected  = true if a user edited this cell
--   participant_index = which row in the structured_data array
--
-- Use this view to:
--   1. Review the extracted names manually
--   2. Export to CSV for OCR training (every row is image_source + label)

CREATE OR REPLACE VIEW extracted_names AS
WITH
  -- Step 1: explode every job's structured_data array into one row per cell
  exploded AS (
    SELECT
      j.id            AS job_id,
      j.user_id,
      j.document_name,
      j.document_url,
      j.created_at    AS job_created_at,
      participant_idx - 1 AS participant_index,   -- 0-indexed
      cell.key        AS field_name,
      cell.value::text AS extracted_value
    FROM document_jobs j
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.structured_data, '[]'::jsonb))
      WITH ORDINALITY AS p(participant, participant_idx)
    CROSS JOIN LATERAL jsonb_each_text(p.participant) AS cell
    WHERE j.status = 'completed'
      AND j.structured_data IS NOT NULL
  ),

  -- Step 2: keep only name columns (header matches اسم or "name")
  names_only AS (
    SELECT *
    FROM exploded
    WHERE field_name ~* 'اسم|name'
      AND extracted_value IS NOT NULL
      AND TRIM(BOTH '"' FROM extracted_value) <> ''
      AND TRIM(BOTH '"' FROM extracted_value) <> 'null'
  ),

  -- Step 3: latest user correction per (job, participant, field) — if any
  latest_corrections AS (
    SELECT DISTINCT ON (job_id, participant_index, field_name)
      job_id,
      participant_index,
      field_name,
      original_value,
      corrected_value,
      created_at AS corrected_at
    FROM field_corrections
    ORDER BY job_id, participant_index, field_name, created_at DESC
  )

SELECT
  n.job_id,
  n.user_id,
  n.document_name,
  n.document_url,
  n.participant_index,
  n.field_name,
  -- final_value = what the user sees right now
  COALESCE(c.corrected_value, TRIM(BOTH '"' FROM n.extracted_value)) AS final_value,
  -- ocr_output = what OCR originally produced (before any corrections)
  COALESCE(c.original_value, TRIM(BOTH '"' FROM n.extracted_value))  AS ocr_output,
  (c.corrected_value IS NOT NULL) AS was_corrected,
  n.job_created_at,
  c.corrected_at
FROM names_only n
LEFT JOIN latest_corrections c
  ON  c.job_id            = n.job_id
  AND c.participant_index = n.participant_index
  AND c.field_name        = n.field_name
ORDER BY n.job_created_at DESC, n.participant_index;

-- SECURITY (corrected 2026-09, see migration 040).
--
-- The comment that stood here claimed "the view inherits RLS from underlying
-- tables". That is only true for a view created WITH (security_invoker = on).
-- By default a Postgres view executes with its OWNER's privileges, so without
-- the line below this view would read document_jobs as the owner, ignore its
-- RLS policy, and hand every user's names, document_name and document_url to
-- anyone holding the public anon key — routing around the column revokes in
-- 032/033/039 as well.
--
-- Verified on 2026-09-20: this migration was never applied to production, so
-- nothing was ever exposed. The fix is here so that a fresh install from these
-- migrations is safe, and repeated in 040 for any database where it did run.
ALTER VIEW extracted_names SET (security_invoker = on);
REVOKE ALL ON extracted_names FROM anon, authenticated;

COMMENT ON VIEW extracted_names IS
  'Centralized list of every name extracted from every uploaded document, '
  'with the OCR output and current (possibly user-corrected) value side-by-side. '
  'Use for manual review and OCR training data export.';
