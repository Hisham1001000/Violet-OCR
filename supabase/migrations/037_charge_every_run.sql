-- ── Migration 037: every processing run is charged ──────────────────────────
--
-- Owner's decision, 2026-09-10: "any process happened to any of files, it
-- should charge them."
--
-- Until now a document was charged once, ever. Reprocessing it — or uploading
-- the same file again, which reuses the same job — was free. From now on every
-- run that finishes is charged for the rows it extracted, at the current price.
--
-- What stays free:
--   * A run that extracts no rows: there is nothing to charge for.
--   * A run that fails: settle_job is the pipeline's last step, so a run that
--     dies before the end never reaches it.
--
-- What still cannot double-charge:
--   * "Check again" on a locked document settles THAT run once. It only acts on
--     a job that is 'unpaid' and flips it to 'paid', under a row lock.
--
-- One transaction: if any statement fails, nothing is applied.

BEGIN;

-- One charge per job was enforced here. A job can now be charged once per run.
DROP INDEX IF EXISTS billing_one_charge_per_job;

-- ── Take the money for one run ──────────────────────────────────────────────
-- Shared by settle_job (the pipeline) and settle_job_self (check again). The
-- caller has already locked the job row. Not callable by users: see REVOKE.
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

  -- A run with no readable rows is not charged for. The customer got nothing.
  IF p_cost = 0 THEN
    UPDATE document_jobs
       SET row_count = p_rows, cost_cents = 0, payment_status = 'paid'
     WHERE id = p_job_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', 0,
                              'balance_cents', COALESCE(v_balance, 0));
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

  -- Not affordable: the work is kept and held, not thrown away.
  UPDATE document_jobs
     SET row_count = p_rows, cost_cents = p_cost, payment_status = 'unpaid'
   WHERE id = p_job_id;

  RETURN jsonb_build_object('status', 'unpaid', 'cost_cents', p_cost,
                            'balance_cents', COALESCE(v_balance, 0),
                            'shortfall_cents', p_cost - COALESCE(v_balance, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── The pipeline, once at the end of every run that finished ────────────────
-- Every call is a run and every run is charged: there is deliberately no
-- "already paid" early return any more.
CREATE OR REPLACE FUNCTION settle_job(p_job_id UUID, p_user_id UUID, p_rows INTEGER)
RETURNS JSONB AS $$
DECLARE
  v_rows INTEGER := GREATEST(COALESCE(p_rows, 0), 0);
BEGIN
  -- Serialise with settle_job_self on the same document.
  PERFORM 1 FROM document_jobs WHERE id = p_job_id FOR UPDATE;
  -- 1.5 cents a row, rounded up to a whole cent for the run.
  RETURN apply_job_charge(p_job_id, p_user_id, v_rows, (v_rows * 3 + 1) / 2);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── The "check again" button ────────────────────────────────────────────────
-- Settles the run that finished but could not be paid for, once. A paid job is
-- returned as-is, so pressing the button can never take money twice.
CREATE OR REPLACE FUNCTION settle_job_self(p_job_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_owner  UUID;
  v_rows   INTEGER;
  v_cost   INTEGER;
  v_status TEXT;
BEGIN
  SELECT user_id, row_count, cost_cents, payment_status
    INTO v_owner, v_rows, v_cost, v_status
    FROM document_jobs WHERE id = p_job_id
    FOR UPDATE;

  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_status = 'paid' THEN
    RETURN jsonb_build_object('status', 'paid', 'already', true);
  END IF;

  -- Never settled at all (the pipeline's billing call failed): nothing to
  -- charge against, so leave it for the pipeline rather than guessing a count.
  IF v_status <> 'unpaid' OR v_rows IS NULL THEN
    RETURN jsonb_build_object('status', 'pending');
  END IF;

  -- The locked page quoted cost_cents for this run; honour that quote.
  RETURN apply_job_charge(p_job_id, v_owner, v_rows, COALESCE(v_cost, (v_rows * 3 + 1) / 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Who may call them ───────────────────────────────────────────────────────
-- PostgREST publishes every public function at /rest/v1/rpc/<name>. A user who
-- could call apply_job_charge directly could mark any job paid for any amount.
-- It needs no grant: settle_job and settle_job_self are SECURITY DEFINER, so
-- they call it with their owner's rights.
REVOKE ALL ON FUNCTION apply_job_charge(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION settle_job(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION settle_job(UUID, UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION settle_job_self(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION settle_job_self(UUID) TO authenticated;

COMMIT;
