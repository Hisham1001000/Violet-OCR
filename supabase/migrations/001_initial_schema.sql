-- Phase 1 MVP Schema: Arabic Handwriting → Excel
-- Run this in the Supabase SQL Editor or via: supabase db push

-- ── Table 1: Document Jobs ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users NOT NULL,
  document_name   text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  document_url    text,
  full_text       text,        -- raw Vision full-text output
  fields_json     jsonb,       -- parsed fields array [{field_name, value}]
  error_message   text,
  created_at      timestamptz DEFAULT now(),
  completed_at    timestamptz
);

-- ── Table 2: Raw OCR Debug Storage ────────────────────────────────────────────
-- One row per page — stores full Vision API JSON for debugging

CREATE TABLE IF NOT EXISTS document_pages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid REFERENCES document_jobs ON DELETE CASCADE NOT NULL,
  page_number          int NOT NULL,
  raw_vision_response  jsonb,   -- full Vision API JSON response
  full_text            text,
  UNIQUE (job_id, page_number)
);

-- ── Row-Level Security ─────────────────────────────────────────────────────────

ALTER TABLE document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;

-- Users can only access their own jobs
CREATE POLICY "Users see own jobs"
  ON document_jobs FOR ALL
  USING (auth.uid() = user_id);

-- Users can access pages belonging to their jobs
CREATE POLICY "Users see own pages"
  ON document_pages FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM document_jobs j
      WHERE j.id = job_id AND j.user_id = auth.uid()
    )
  );

-- ── Indexes ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_document_jobs_user_created
  ON document_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_pages_job_id
  ON document_pages (job_id);

-- ── Validation Queries (run these to confirm schema is correct) ────────────────
--
-- 1. Test CHECK constraint (must fail):
--    INSERT INTO document_jobs (user_id, document_name, status)
--    VALUES (gen_random_uuid(), 'x', 'invalid');
--
-- 2. Test UNIQUE constraint on document_pages (must fail on second insert):
--    INSERT INTO document_pages (job_id, page_number)
--    VALUES ('[some-uuid]', 1);
--    INSERT INTO document_pages (job_id, page_number)
--    VALUES ('[same-uuid]', 1);  -- must fail: duplicate key
