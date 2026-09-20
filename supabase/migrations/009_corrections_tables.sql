-- Corrections tables — power the two-layer correction system.
--
-- field_corrections: every individual cell edit a user makes in the review table.
--   Logged unconditionally; used as few-shot examples in the Gemini prompt.
--
-- ocr_corrections: confirmed, stable text find-and-replace rules applied to raw
--   OCR text BEFORE Gemini structuring. Only promoted when the same original→corrected
--   pair has been confirmed in at least 2 DISTINCT uploaded files (distinct job_ids).
--   Prevents a single accidental edit from corrupting future extractions.
--
-- HOW TO APPLY: paste this entire file into the Supabase SQL Editor and run it.

-- ── field_corrections ────────────────────────────────────────────────────────
-- Individual cell corrections logged per job / participant / field.

CREATE TABLE IF NOT EXISTS field_corrections (
    id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at         TIMESTAMPTZ DEFAULT NOW(),

    -- NOTE (2026-09-20): production has this column as uuid, not text --
    -- it was altered by hand and never recorded in a migration. Policies
    -- that join on it cast both sides (see 040) so they work either way.
    job_id             TEXT        NOT NULL,   -- document_jobs.id
    participant_index  INT         NOT NULL,   -- 0-based row index within the job
    field_name         TEXT        NOT NULL,   -- column name (Arabic header)
    original_value     TEXT        NOT NULL,   -- value before user edit
    corrected_value    TEXT        NOT NULL    -- value after user edit
);

CREATE INDEX IF NOT EXISTS field_corrections_job_id ON field_corrections (job_id);
CREATE INDEX IF NOT EXISTS field_corrections_pair   ON field_corrections (original_value, corrected_value);
CREATE INDEX IF NOT EXISTS field_corrections_created ON field_corrections (created_at DESC);

-- Row-level security: users can insert their own corrections; admins can read all.
ALTER TABLE field_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own corrections"
    ON field_corrections FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Service role can read all corrections"
    ON field_corrections FOR SELECT
    USING (true);


-- ── ocr_corrections ──────────────────────────────────────────────────────────
-- Confirmed, stable text replacement rules applied to raw OCR output.
-- original_text must be unique — a given wrong spelling has exactly one correction.

CREATE TABLE IF NOT EXISTS ocr_corrections (
    id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at         TIMESTAMPTZ DEFAULT NOW(),

    original_text      TEXT        NOT NULL UNIQUE,   -- misspelled/garbled text
    corrected_text     TEXT        NOT NULL,           -- correct replacement
    frequency          INT         DEFAULT 2           -- number of distinct files that confirmed this
);

CREATE INDEX IF NOT EXISTS ocr_corrections_original ON ocr_corrections (original_text);
CREATE INDEX IF NOT EXISTS ocr_corrections_freq     ON ocr_corrections (frequency DESC);

-- Row-level security: all authenticated users can read; service role can write.
ALTER TABLE ocr_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All users can read ocr_corrections"
    ON ocr_corrections FOR SELECT
    USING (true);

CREATE POLICY "Service role can write ocr_corrections"
    ON ocr_corrections FOR ALL
    USING (true)
    WITH CHECK (true);
