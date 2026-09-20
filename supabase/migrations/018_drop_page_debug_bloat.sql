-- ── Migration 018: Drop per-page OCR debug bloat from document_pages ─────────
-- The pipeline previously saved raw_vision_response (full Vision API JSON) and
-- full_text per page into document_pages "for debugging". Nothing in the
-- production codebase ever read these fields, so they were pure storage waste —
-- often 100–500 KB per page across hundreds of jobs.
--
-- The pipeline has been updated to skip these writes going forward (Phase 3.8).
-- This migration reclaims the space already occupied.
--
-- Strategy: NULL out the heavy fields rather than dropping the rows themselves.
-- Keeping the rows preserves the (job_id, page_number) UNIQUE keys in case any
-- future feature wants to re-attach data per page.

UPDATE document_pages
SET
  raw_vision_response = NULL,
  full_text           = NULL
WHERE raw_vision_response IS NOT NULL
   OR full_text           IS NOT NULL;

-- Reclaim the freed space (Postgres MVCC keeps dead rows until VACUUM).
-- Run manually if you want immediate disk reclaim:
--   VACUUM FULL document_pages;
