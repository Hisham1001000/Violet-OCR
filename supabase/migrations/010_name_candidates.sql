-- name_candidates — staging table for growing the Arabic name dictionaries
-- from user corrections.
--
-- Flow:
--   field_corrections (user edits a cell)
--       → grow_name_dict.py collect   (validates + inserts here)
--       → grow_name_dict.py promote   (writes accepted rows to JSON files)
--
-- status values:
--   'pending'  — passed format validation, awaiting occurrence threshold or manual review
--   'accepted' — ready to be written to arabic_names.json / arabic_family_names.json
--   'rejected' — failed validation or manually rejected; never promoted
--
-- HOW TO APPLY: paste this file into the Supabase SQL Editor and run it.

CREATE TABLE IF NOT EXISTS name_candidates (
    id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    last_seen   TIMESTAMPTZ DEFAULT NOW(),

    -- The name token itself (single token, not a full 4-part name)
    name        TEXT        NOT NULL,

    -- Normalised form used for deduplication:
    -- diacritics stripped, alef variants collapsed to bare alef (ا)
    normalized  TEXT        NOT NULL,

    -- Which dictionary this token belongs to
    name_type   TEXT        NOT NULL CHECK (name_type IN ('given', 'family')),

    -- How many distinct document jobs contributed this exact corrected_value
    occurrences INTEGER     NOT NULL DEFAULT 1,

    -- Array of job_ids that contributed (for audit / dedup)
    job_ids     TEXT[]      NOT NULL DEFAULT '{}',

    -- Promoted = written to JSON file on next promote run
    promoted    BOOLEAN     NOT NULL DEFAULT FALSE,

    status      TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'rejected')),

    -- One canonical entry per (normalized form, type) pair
    UNIQUE (normalized, name_type)
);

CREATE INDEX IF NOT EXISTS name_candidates_status   ON name_candidates (status);
CREATE INDEX IF NOT EXISTS name_candidates_type     ON name_candidates (name_type);
CREATE INDEX IF NOT EXISTS name_candidates_promoted ON name_candidates (promoted) WHERE promoted = FALSE;

-- Service role can do everything; users cannot touch this table directly
ALTER TABLE name_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to name_candidates"
    ON name_candidates FOR ALL
    USING (true)
    WITH CHECK (true);
