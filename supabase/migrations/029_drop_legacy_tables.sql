-- 029_drop_legacy_tables.sql
--
-- Removes two tables that no longer receive writes.
--
-- document_pages
--   Migration 018 stopped writing per-page raw Vision JSON and full_text after
--   it turned out to be the dominant source of database bloat. Nothing has
--   written to the table since: 367 document_jobs exist, but only 16 rows.
--   No production code reads it.
--
-- ocr_training_data
--   Line crops collected to train TrOCR, which has been retired in favour of a
--   Qwen2.5-VL LoRA trained on training_dataset. Writes were already opt-in
--   behind OCR_LINE_TRAINING_ENABLED (never set), and the collector has now
--   been deleted from process_document.py.
--
--   Of its 1,691 rows: 0 have corrected_text, 0 have used_in_training = true.
--   Every label is Azure's own output, unverified by a human — superseded by
--   the 8,722 human-verified crops in training_dataset. The text columns were
--   exported to .tmp/backups/ocr_training_data_2026-08-24.csv before this ran;
--   the ~9.6 MB of base64 crop images were deliberately not kept.
--
-- Both are safe to drop: no code references either table any more.

DROP TABLE IF EXISTS public.ocr_training_data;
DROP TABLE IF EXISTS public.document_pages;
