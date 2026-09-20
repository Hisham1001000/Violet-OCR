-- ── Migration 025: non-destructive crop editing (context region) ────────────
-- The inline crop editor used to re-crop the already-cropped thumbnail and
-- overwrite it, which (a) zoomed/shifted the image on every edit and (b) made
-- it impossible to recover a cut-off word (the missing pixels weren't in the
-- thumbnail). The fix: alongside each tight training crop we also store a wider
-- CONTEXT crop (the cell + a margin from the original page) and the tight box's
-- position within it. The editor loads the stable context, starts the box at
-- the tight region, and lets the trainer expand/tighten — re-cropping from the
-- context (never the shrinking result), so editing is non-destructive.

ALTER TABLE training_dataset
  ADD COLUMN IF NOT EXISTS context_path TEXT,          -- storage path of the wide context PNG
  ADD COLUMN IF NOT EXISTS context_box  JSONB;         -- {x,y,w,h}: tight crop's rect within the context (px)

COMMENT ON COLUMN training_dataset.context_path IS
  'training_crops path of the wider context image the inline editor edits against.';
COMMENT ON COLUMN training_dataset.context_box IS
  'Tight crop rectangle within the context image, in context pixels: {x,y,w,h}.';
