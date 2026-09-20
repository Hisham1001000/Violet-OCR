-- ── Migration 031: user feedback ────────────────────────────────────────────
--
-- Asked once per document, a minute or two after the result is on screen, so
-- the rating describes a table the person has actually looked at rather than a
-- progress bar that just finished.

CREATE TABLE IF NOT EXISTS feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id     UUID REFERENCES document_jobs(id) ON DELETE SET NULL,
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  -- NULL means the notification email has not gone out. Kept so a mail outage
  -- is visible and re-sendable rather than silently losing the feedback.
  emailed_at TIMESTAMPTZ,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rating per document. A second submission for the same job updates it
-- rather than piling up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS feedback_one_per_job
  ON feedback(job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback(created_at DESC);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own feedback" ON feedback;
CREATE POLICY "Users insert own feedback" ON feedback
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users read own feedback" ON feedback;
CREATE POLICY "Users read own feedback" ON feedback
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users update own feedback" ON feedback;
CREATE POLICY "Users update own feedback" ON feedback
  FOR UPDATE USING (user_id = auth.uid());
