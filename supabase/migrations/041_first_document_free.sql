-- ── Migration 041: the first document is free, whatever it costs ────────────
--
-- Why this exists. A new account is granted 50 cents, which at 1.5c a row buys
-- 33 rows. Real forms are bigger than that. A customer uploaded a sheet, the
-- pipeline read it in full, and the result was then held behind a paywall
-- because their grant could not cover it -- so their first and only experience
-- of Violet was being asked for money for work they could not see. They left.
--
-- A fixed grant cannot fix this, because there is no amount that covers every
-- sheet: a 200-row register costs $3.00. So the first document is free by
-- COUNT, not by value. Every new account gets one complete result, at any size,
-- before it is ever asked to pay.
--
-- How "first" is decided: the billing ledger. A user is on their first document
-- while they have no 'charge' row for any OTHER job. That choice matters:
--
--   * It is idempotent. The free document writes its own zero-value charge row,
--     so the allowance is spent exactly once, and settling the same job twice
--     cannot spend it twice.
--   * Re-running the first document stays free. The check excludes the current
--     job, so a reprocess of the same sheet does not count as a prior document.
--   * It is retroactive. A job sitting at 'unpaid' right now belongs to a user
--     with no charge row at all, so the next settle -- the customer's own
--     "check again" click -- releases it. No manual repair, no data edits.
--
-- A sheet with no readable rows still costs nothing AND does not spend the
-- allowance: the zero-row branch returns before this one. Nobody burns their
-- free document on a page Violet could not read.
--
-- Known trade-off, accepted deliberately: one free document per ACCOUNT, and
-- accounts are free to create. This is the usual first-hit-free exposure. The
-- alternative -- charging for the first result -- costs more, in customers who
-- never see the product work at all.
--
-- One transaction. If any statement fails nothing is applied, so the pipeline
-- and the website can never disagree about what a document cost.

BEGIN;

-- ── Is this the customer's first document? ──────────────────────────────────
-- Reads the ledger rather than document_jobs, because the ledger is the record
-- of money actually moving. A job row can be rewritten by a re-run; a charge
-- that happened cannot be un-happened.
--
-- job_id IS NULL counts as a prior document on purpose: billing_transactions
-- .job_id is ON DELETE SET NULL, so a deleted document leaves a charge row
-- with no job. That charge still happened, and deleting a document must not
-- hand back a fresh free one.
CREATE OR REPLACE FUNCTION user_has_prior_document(p_user_id UUID, p_job_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM billing_transactions
     WHERE user_id = p_user_id
       AND kind    = 'charge'
       AND (job_id IS NULL OR job_id <> p_job_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Settle a finished job (called by the pipeline) ──────────────────────────
-- Unchanged from 035 except for the first-document branch, which sits after
-- the zero-row branch and before the affordability test.
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
  v_cost := (v_rows * 3 + 1) / 2;

  SELECT payment_status, row_count, cost_cents
    INTO v_status, v_held_rows, v_held_cost
    FROM document_jobs WHERE id = p_job_id
    FOR UPDATE;

  IF v_status = 'paid' THEN
    SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', COALESCE(v_held_cost, v_cost),
                              'balance_cents', COALESCE(v_balance, 0), 'already', true);
  END IF;

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

  -- A sheet with no readable rows is not charged for, and does not spend the
  -- free document either.
  IF v_cost = 0 THEN
    UPDATE document_jobs
       SET row_count = 0, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0));
  END IF;

  -- ── The first document is free, at any size ───────────────────────────────
  IF NOT user_has_prior_document(p_user_id, p_job_id) THEN
    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', 0, v_rows, p_job_id, COALESCE(v_balance, 0),
              'first document free (' || v_rows || ' rows, ' || v_cost || 'c waived)');

    UPDATE document_jobs
       SET row_count = v_rows, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0),
                              'first_free', true, 'waived_cents', v_cost);
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
              v_rows || ' rows');

    UPDATE document_jobs
       SET row_count = v_rows, cost_cents = v_cost, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', v_cost,
                              'balance_cents', v_balance);
  END IF;

  UPDATE document_jobs
     SET row_count = v_rows, cost_cents = v_cost, payment_status = 'unpaid'
   WHERE id = p_job_id;

  RETURN jsonb_build_object('status', 'unpaid', 'cost_cents', v_cost,
                            'balance_cents', COALESCE(v_balance, 0),
                            'shortfall_cents', v_cost - COALESCE(v_balance, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Charge a job at an already-quoted price ─────────────────────────────────
-- Reached from settle_job_self, which is what the locked page's "check again"
-- calls. This is the path that releases the documents held right now.
CREATE OR REPLACE FUNCTION apply_job_charge(p_job_id UUID, p_user_id UUID,
                                            p_rows INTEGER, p_cost INTEGER)
RETURNS JSONB AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  SELECT balance_cents INTO v_balance
    FROM user_profiles WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO user_profiles (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
    SELECT balance_cents INTO v_balance
      FROM user_profiles WHERE user_id = p_user_id FOR UPDATE;
  END IF;

  IF p_cost = 0 THEN
    UPDATE document_jobs
       SET row_count = p_rows, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0));
  END IF;

  -- ── The first document is free, at any size ───────────────────────────────
  IF NOT user_has_prior_document(p_user_id, p_job_id) THEN
    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', 0, p_rows, p_job_id, COALESCE(v_balance, 0),
              'first document free (' || p_rows || ' rows, ' || p_cost || 'c waived)');

    UPDATE document_jobs
       SET row_count = p_rows, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0),
                              'first_free', true, 'waived_cents', p_cost);
  END IF;

  IF COALESCE(v_balance, 0) >= p_cost THEN
    UPDATE user_profiles
       SET balance_cents     = balance_cents - p_cost,
           rows_used_total   = rows_used_total + p_rows,
           cents_spent_total = cents_spent_total + p_cost,
           updated_at        = now()
     WHERE user_id = p_user_id
     RETURNING balance_cents INTO v_balance;

    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', -p_cost, p_rows, p_job_id, v_balance,
              p_rows || ' rows');

    UPDATE document_jobs
       SET row_count = p_rows, cost_cents = p_cost, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', p_cost,
                              'balance_cents', v_balance);
  END IF;

  UPDATE document_jobs
     SET row_count = p_rows, cost_cents = p_cost, payment_status = 'unpaid'
   WHERE id = p_job_id;

  RETURN jsonb_build_object('status', 'unpaid', 'cost_cents', p_cost,
                            'balance_cents', COALESCE(v_balance, 0),
                            'shortfall_cents', p_cost - COALESCE(v_balance, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Privileges ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps existing grants, but these are restated so this file
-- tells the whole truth on its own. See docs/security-model.md: every function
-- in the public schema is reachable at /rest/v1/rpc/<name>, so a SECURITY
-- DEFINER function that is not revoked is a hole shaped like whatever it does.
-- A user who could call apply_job_charge directly could mark any job paid.
REVOKE ALL ON FUNCTION user_has_prior_document(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION apply_job_charge(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION settle_job(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION settle_job(UUID, UUID, INTEGER) TO service_role;

-- settle_job_self is the one a signed-in customer may call. It is unchanged by
-- this migration and keeps its grant; restated so the grant is visible here.
REVOKE ALL ON FUNCTION settle_job_self(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION settle_job_self(UUID) TO authenticated;

COMMIT;

-- ── After running ───────────────────────────────────────────────────────────
-- Documents still held from before this migration, which the next "check
-- again" will release for free:
--
--   SELECT j.id, j.user_id, j.row_count, j.cost_cents, j.created_at
--     FROM document_jobs j
--    WHERE j.payment_status = 'unpaid'
--      AND NOT user_has_prior_document(j.user_id, j.id)
--    ORDER BY j.created_at DESC;
--
-- To release one immediately instead of waiting for the customer to click,
-- run as the service role:
--
--   SELECT apply_job_charge(j.id, j.user_id, j.row_count, j.cost_cents)
--     FROM document_jobs j WHERE j.id = '<job id>';
