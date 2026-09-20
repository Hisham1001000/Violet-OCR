-- RPC: upsert_ocr_corrections
-- Batch-upserts multiple OCR correction pairs in a single round-trip,
-- replacing the N×(select+insert/update) loop in the corrections API route.
--
-- pairs: JSON array of {original_text, corrected_text} objects
-- ON CONFLICT: if original_text already exists, update corrected_text and increment frequency.
--
-- HOW TO APPLY: paste this entire file into the Supabase SQL Editor and run it.

CREATE OR REPLACE FUNCTION upsert_ocr_corrections(
    pairs JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    pair JSONB;
BEGIN
    FOR pair IN SELECT * FROM jsonb_array_elements(pairs)
    LOOP
        INSERT INTO ocr_corrections (original_text, corrected_text, frequency)
        VALUES (
            pair->>'original_text',
            pair->>'corrected_text',
            1
        )
        ON CONFLICT (original_text) DO UPDATE
            SET corrected_text = EXCLUDED.corrected_text,
                frequency      = ocr_corrections.frequency + 1;
    END LOOP;
END;
$$;
