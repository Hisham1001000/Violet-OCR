-- ── Migration 030: pay-per-row billing ──────────────────────────────────────
--
-- Replaces the monthly page plans with a prepaid balance charged per extracted
-- row. One row costs one cent, so a 15-row sheet costs 15 cents.
--
-- Money is stored as INTEGER CENTS everywhere. Never a float, never a numeric
-- with a fractional part: 0.1 + 0.2 is not 0.3 in binary floating point, and a
-- balance that drifts by a fraction of a cent per transaction is a bug nobody
-- notices until it is thousands of rows old.
--
-- The row count is only known AFTER OCR has run, so a job can legitimately cost
-- more than the balance holds. Rather than refuse the work or let the balance
-- go negative, the job completes and is held: payment_status = 'unpaid' and the
-- document page shows the result locked behind a top-up prompt. Nothing is
-- destroyed, and nothing is given away.

-- ── Balance on the profile ──────────────────────────────────────────────────
-- 50 cents = 50 free rows for a new account, roughly three typical sheets.
-- Change the DEFAULT to 0 to stop granting a trial.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS balance_cents   INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS rows_used_total INTEGER NOT NULL DEFAULT 0;

-- ── Per-job billing outcome ─────────────────────────────────────────────────
-- 'pending' until OCR finishes and the row count is known, then 'paid' or
-- 'unpaid'. The frontend gates the extracted table on this.
ALTER TABLE document_jobs
  ADD COLUMN IF NOT EXISTS row_count      INTEGER,
  ADD COLUMN IF NOT EXISTS cost_cents     INTEGER,
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';

-- Everything already processed was paid for under the old plan model. Leaving
-- it 'pending' would lock documents the user has already been charged for.
UPDATE document_jobs SET payment_status = 'paid' WHERE status = 'completed';

-- ── Ledger ──────────────────────────────────────────────────────────────────
-- Every movement of money, so a balance can always be explained rather than
-- just asserted. amount_cents is signed: positive credits, negative debits.
CREATE TABLE IF NOT EXISTS billing_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('grant', 'topup', 'charge', 'refund', 'adjust')),
  amount_cents  INTEGER NOT NULL,
  rows          INTEGER,
  job_id        UUID REFERENCES document_jobs(id) ON DELETE SET NULL,
  balance_after INTEGER NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_transactions_user_idx
  ON billing_transactions(user_id, created_at DESC);

-- A document is charged for exactly once, ever. Reprocessing a sheet you have
-- already paid for is free: the alternative is billing a customer twice for one
-- page because our first attempt was poor, which is indefensible.
CREATE UNIQUE INDEX IF NOT EXISTS billing_one_charge_per_job
  ON billing_transactions(job_id) WHERE kind = 'charge';

ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own transactions" ON billing_transactions;
CREATE POLICY "Users read own transactions" ON billing_transactions
  FOR SELECT USING (user_id = auth.uid());
-- No INSERT/UPDATE/DELETE policy: only the service role writes the ledger.

-- ── Settle a finished job ───────────────────────────────────────────────────
-- Called by the pipeline once the row count is final. Atomic: the profile row
-- is locked for the read-modify-write so two jobs finishing at the same moment
-- cannot both spend the same balance.
CREATE OR REPLACE FUNCTION settle_job(p_job_id UUID, p_user_id UUID, p_rows INTEGER)
RETURNS JSONB AS $$
DECLARE
  v_cost    INTEGER;
  v_balance INTEGER;
  v_status  TEXT;
BEGIN
  v_cost := GREATEST(COALESCE(p_rows, 0), 0);   -- 1 cent per row

  SELECT payment_status INTO v_status FROM document_jobs WHERE id = p_job_id;
  IF v_status = 'paid' THEN
    SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'paid', 'cost_cents', v_cost,
                              'balance_cents', COALESCE(v_balance, 0), 'already', true);
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
       SET balance_cents   = balance_cents - v_cost,
           rows_used_total = rows_used_total + p_rows,
           updated_at      = now()
     WHERE user_id = p_user_id
     RETURNING balance_cents INTO v_balance;

    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', -v_cost, p_rows, p_job_id, v_balance,
              p_rows || ' rows')
    ON CONFLICT (job_id) WHERE kind = 'charge' DO NOTHING;

    UPDATE document_jobs
       SET row_count = p_rows, cost_cents = v_cost, payment_status = 'paid'
     WHERE id = p_job_id;

    RETURN jsonb_build_object('status', 'paid', 'cost_cents', v_cost,
                              'balance_cents', v_balance);
  END IF;

  -- Not affordable: the work is kept and held, not thrown away.
  UPDATE document_jobs
     SET row_count = p_rows, cost_cents = v_cost, payment_status = 'unpaid'
   WHERE id = p_job_id;

  RETURN jsonb_build_object('status', 'unpaid', 'cost_cents', v_cost,
                            'balance_cents', COALESCE(v_balance, 0),
                            'shortfall_cents', v_cost - COALESCE(v_balance, 0));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Credit a balance ────────────────────────────────────────────────────────
-- Top-ups and admin grants. Returns the new balance.
CREATE OR REPLACE FUNCTION add_balance(
  p_user_id UUID, p_amount_cents INTEGER,
  p_kind TEXT DEFAULT 'topup', p_note TEXT DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE v_balance INTEGER;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents = 0 THEN
    SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = p_user_id;
    RETURN COALESCE(v_balance, 0);
  END IF;

  INSERT INTO user_profiles (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  UPDATE user_profiles
     SET balance_cents = balance_cents + p_amount_cents, updated_at = now()
   WHERE user_id = p_user_id
   RETURNING balance_cents INTO v_balance;

  INSERT INTO billing_transactions
    (user_id, kind, amount_cents, balance_after, note)
    VALUES (p_user_id, p_kind, p_amount_cents, v_balance, p_note);

  RETURN v_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Who may call the money functions ────────────────────────────────────────
-- Both are SECURITY DEFINER, and PostgREST exposes every function in the public
-- schema at /rest/v1/rpc/<name>. Left executable by `authenticated`, any logged
-- in user could POST to add_balance and credit their own account, or call
-- settle_job for their own document with p_rows = 0 and have it marked paid for
-- nothing. Both are service-role only.
REVOKE ALL ON FUNCTION settle_job(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION settle_job(UUID, UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION add_balance(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION add_balance(UUID, INTEGER, TEXT, TEXT) TO service_role;

-- ── The "check again" button ────────────────────────────────────────────────
-- Safe to expose: it takes no amount and no row count. It re-settles ONE job
-- the caller owns, using the row count already recorded on that job by the
-- pipeline, so there is no number for the caller to lie about.
CREATE OR REPLACE FUNCTION settle_job_self(p_job_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_owner  UUID;
  v_rows   INTEGER;
  v_status TEXT;
BEGIN
  SELECT user_id, row_count, payment_status
    INTO v_owner, v_rows, v_status
    FROM document_jobs WHERE id = p_job_id;

  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_status = 'paid' THEN
    RETURN jsonb_build_object('status', 'paid', 'already', true);
  END IF;

  -- Never settled at all (the pipeline's billing call failed): nothing to
  -- charge against, so leave it for the pipeline rather than guessing a count.
  IF v_rows IS NULL THEN
    RETURN jsonb_build_object('status', 'pending');
  END IF;

  RETURN settle_job(p_job_id, v_owner, v_rows);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION settle_job_self(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION settle_job_self(UUID) TO authenticated;

-- ── Record the signup grant in the ledger ───────────────────────────────────
-- The DEFAULT on balance_cents already gives the credit; this makes it show up
-- on the user's own statement instead of appearing from nowhere.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE v_balance INTEGER;
BEGIN
  INSERT INTO user_profiles (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = NEW.id;
  IF COALESCE(v_balance, 0) > 0 THEN
    INSERT INTO billing_transactions
      (user_id, kind, amount_cents, balance_after, note)
      VALUES (NEW.id, 'grant', v_balance, v_balance, 'رصيد ترحيبي');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Retire the monthly counter ──────────────────────────────────────────────
-- pages_used_this_month, usage_reset_at and the plan column are deliberately
-- LEFT IN PLACE. Dropping them would break the admin panel's reads in the same
-- deploy that changes billing, and they cost nothing sitting there. Nothing
-- reads them for quota any more.
DROP TRIGGER IF EXISTS trg_reset_monthly_usage ON user_profiles;

CREATE OR REPLACE FUNCTION touch_user_profile()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_user_profile
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_user_profile();
