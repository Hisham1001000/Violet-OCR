-- ── Migration 035: 1.5 cents per row ────────────────────────────────────────
--
-- The price goes from 1 cent to 1.5 cents per extracted row (owner's decision,
-- 2026-09-10, after costing the pipeline per document).
--
-- Money stays INTEGER CENTS. A half-cent price cannot be multiplied into an
-- integer directly, so a document costs 1.5 × rows rounded UP to a whole cent:
-- (rows * 3 + 1) / 2 in integer arithmetic. 14 rows = 21¢, 15 rows = 23¢. The
-- rounding happens once per document, so it never adds more than half a cent.
-- costOfRows() in frontend/src/lib/billing.ts must give the same numbers.
--
-- What does NOT change:
--   * Existing balances. Credit already bought keeps its dollar value.
--   * Documents already paid for. Their cost_cents stays what was charged.
--   * A document already held as unpaid, while its row count is unchanged: the
--     locked page has quoted the customer a price and a shortfall, and topping
--     up exactly that shortfall must unlock it. Only a re-read that changes the
--     row count is priced afresh.
--
-- One transaction: if any statement fails, nothing is applied, so the pipeline
-- and the website can never disagree about the price halfway through.

BEGIN;

-- ── Spend counter ───────────────────────────────────────────────────────────
-- /api/usage worked out "spent" as rows_used_total × price. With two prices in
-- the history that is wrong, so spend is now counted in cents as it happens,
-- backfilled from the ledger (every charge since migration 030 is in it).
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS cents_spent_total INTEGER NOT NULL DEFAULT 0;

UPDATE user_profiles p
   SET cents_spent_total = s.spent
  FROM (SELECT user_id, (-SUM(amount_cents))::INTEGER AS spent
          FROM billing_transactions
         WHERE kind = 'charge'
         GROUP BY user_id) s
 WHERE p.user_id = s.user_id;

-- ── Signup grant ────────────────────────────────────────────────────────────
-- Still 50 free rows for a new account; at 1.5¢ a row that is 75 cents.
-- handle_new_user() records whatever this default gives, so it needs no change.
ALTER TABLE user_profiles ALTER COLUMN balance_cents SET DEFAULT 75;

-- ── Settle a finished job ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION settle_job(p_job_id UUID, p_user_id UUID, p_rows INTEGER)
RETURNS JSONB AS $$
DECLARE
  v_rows      INTEGER := GREATEST(COALESCE(p_rows, 0), 0);
  v_cost      INTEGER;
  v_balance   INTEGER;
  v_status    TEXT;
  v_held_rows INTEGER;
  v_held_cost INTEGER;
BEGIN
  -- 1.5 cents a row, rounded up to a whole cent for the document.
  v_cost := (v_rows * 3 + 1) / 2;

  -- Lock the job first. Without it, the pipeline and a "check again" click
  -- landing together could both see 'unpaid' and both deduct; the ledger's
  -- one-charge-per-job index would stop the second ledger row but not the
  -- second deduction.
  SELECT payment_status, row_count, cost_cents
    INTO v_status, v_held_rows, v_held_cost
    FROM document_jobs WHERE id = p_job_id
    FOR UPDATE;

  IF v_status = 'paid' THEN
    SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', COALESCE(v_held_cost, v_cost),
                              'balance_cents', COALESCE(v_balance, 0), 'already', true);
  END IF;

  -- Held at a quoted price: honour the quote while the row count is the same.
  IF v_status = 'unpaid' AND v_held_cost IS NOT NULL AND v_held_rows = v_rows THEN
    v_cost := v_held_cost;
  END IF;

  SELECT balance_cents INTO v_balance
    FROM user_profiles WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO user_profiles (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
    SELECT balance_cents INTO v_balance
      FROM user_profiles WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  -- A sheet with no readable rows is not charged for. The customer got nothing.
  IF v_cost = 0 THEN
    UPDATE document_jobs
       SET row_count = 0, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0));
  END IF;

  IF COALESCE(v_balance, 0) >= v_cost THEN
    UPDATE user_profiles
       SET balance_cents     = balance_cents - v_cost,
           rows_used_total   = rows_used_total + v_rows,
           cents_spent_total = cents_spent_total + v_cost,
           updated_at        = now()
     WHERE user_id = p_user_id
     RETURNING balance_cents INTO v_balance;

    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', -v_cost, v_rows, p_job_id, v_balance,
              v_rows || ' rows')
    ON CONFLICT (job_id) WHERE kind = 'charge' DO NOTHING;

    UPDATE document_jobs
       SET row_count = v_rows, cost_cents = v_cost, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', v_cost,
                              'balance_cents', v_balance);
  END IF;

  -- Not affordable: the work is kept and held, not thrown away.
  UPDATE document_jobs
     SET row_count = v_rows, cost_cents = v_cost, payment_status = 'unpaid'
   WHERE id = p_job_id;

  RETURN jsonb_build_object('status', 'unpaid', 'cost_cents', v_cost,
                            'balance_cents', COALESCE(v_balance, 0),
                            'shortfall_cents', v_cost - COALESCE(v_balance, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CREATE OR REPLACE keeps existing privileges; restated so this file is safe
-- to read on its own. settle_job stays service-role only (see migration 030).
REVOKE ALL ON FUNCTION settle_job(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION settle_job(UUID, UUID, INTEGER) TO service_role;

COMMIT;

-- Check after running (expect 21 and 23, then 75):
--   SELECT (14 * 3 + 1) / 2 AS rows_14, (15 * 3 + 1) / 2 AS rows_15;
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name = 'user_profiles' AND column_name = 'balance_cents';
