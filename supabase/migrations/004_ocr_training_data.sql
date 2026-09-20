-- OCR Training Data — collects Azure line crops + text for future TrOCR fine-tuning.
-- Every document processed automatically contributes labeled training pairs here.
--
-- Schema:
--   crop_b64       — base64-encoded PNG of the Azure-cropped text line
--   azure_text     — text Azure DI read from that line (the label)
--   corrected_text — human-reviewed correction (NULL until a user reviews it)
--   is_verified    — true once corrected_text has been confirmed
--   used_in_training — true once this pair was included in a fine-tuning run
--
-- To fine-tune TrOCR: export WHERE is_verified = TRUE (or azure_text if unreviewed)
-- To export training set: SELECT crop_b64, COALESCE(corrected_text, azure_text) FROM ocr_training_data WHERE used_in_training = FALSE

CREATE TABLE IF NOT EXISTS ocr_training_data (
    id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at         TIMESTAMPTZ DEFAULT NOW(),

    job_id             TEXT        NOT NULL,
    user_id            UUID,
    page_number        INT         NOT NULL,
    line_index         INT         NOT NULL,

    azure_text         TEXT        NOT NULL,    -- label (Azure DI output)
    confidence         FLOAT,                  -- Azure word-level avg confidence for this line
    crop_b64           TEXT        NOT NULL,    -- base64 PNG of the cropped line image

    corrected_text     TEXT,                   -- human correction (NULL = unreviewed)
    is_verified        BOOLEAN     DEFAULT FALSE,
    used_in_training   BOOLEAN     DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS ocr_training_data_job_id      ON ocr_training_data (job_id);
CREATE INDEX IF NOT EXISTS ocr_training_data_training_set ON ocr_training_data (is_verified, used_in_training);
CREATE INDEX IF NOT EXISTS ocr_training_data_created_at  ON ocr_training_data (created_at DESC);
