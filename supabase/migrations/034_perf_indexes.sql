-- ── Migration 034: indexes for the pay-per-row queries ──────────────────────
--
-- Both of these are sequential scans today. At 401 document_jobs rows that
-- costs nothing measurable, which is exactly why it is worth fixing now rather
-- than after it starts hurting.

-- The billing page lists every document held for want of credit, per user.
-- Partial, because 'unpaid' is a small minority of rows and the index only ever
-- needs to answer for those.
CREATE INDEX IF NOT EXISTS document_jobs_unpaid_idx
  ON document_jobs (user_id, created_at DESC)
  WHERE payment_status = 'unpaid';

-- The admin "out of credit" filter, and any future low-balance sweep.
CREATE INDEX IF NOT EXISTS user_profiles_empty_balance_idx
  ON user_profiles (balance_cents)
  WHERE balance_cents <= 0;

-- The feedback admin view reads newest-first; feedback_created_idx from
-- migration 031 already covers that, so nothing more is needed there.
