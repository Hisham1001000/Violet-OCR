-- ── Migration 042: upload from the landing page, before signing up ──────────
--
-- Why this exists. Every visitor from the ads landed on a page that asked them
-- to make an account before they could try anything, and nearly all of them
-- left. Now a visitor can drop a sheet on the landing page and it starts
-- processing at once. While it runs we ask them to sign up, and when they do
-- the finished document is waiting in their account.
--
-- How it works, and why it needs so little new machinery:
--
--   * A guest upload belongs to ONE fixed guest account (guest_user_id()),
--     not to the visitor, because the pipeline needs a real user id and has
--     no notion of "nobody". The guest account cannot sign in (random password,
--     banned), holds no money, and already has a charge on its ledger -- so
--     settle_job always ends a guest job at 'unpaid' with its quoted cost, and
--     nothing is ever charged to anyone while the visitor is anonymous.
--   * The visitor's browser keeps a random claim token. Only its SHA-256 is
--     stored here (guest_claim_hash), so a database read cannot claim a job.
--   * After they sign up or sign in, claim_guest_job() moves the job to their
--     account and prices it for THEM through apply_job_charge -- so a new
--     account's first-document-free (041) covers it, and an existing account
--     is charged exactly as if they had uploaded it from the dashboard. A job
--     claimed while still processing is priced when the pipeline finishes: the
--     pipeline's settle_job leaves it 'unpaid', and the document page settles
--     it once on mount (LockedDocument), which is the same path.
--   * An unclaimed guest job expires (guest_expires_at). The website deletes
--     expired ones and their files.
--
-- None of the new columns are granted to anon/authenticated: 033 and 039
-- replaced the table grants with per-column grants, so a new column is
-- invisible to them by default. Only the service role (the website's server
-- routes) reads or writes them.

BEGIN;

ALTER TABLE document_jobs
  ADD COLUMN IF NOT EXISTS guest_claim_hash TEXT,
  ADD COLUMN IF NOT EXISTS guest_ip_hash    TEXT,
  ADD COLUMN IF NOT EXISTS guest_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS document_jobs_guest_idx
  ON document_jobs (guest_expires_at)
  WHERE guest_expires_at IS NOT NULL;

-- ── The guest account ───────────────────────────────────────────────────────
-- Created by the website on first use (auth.admin.createUser), found by email.
-- The .invalid domain can never receive mail, so no email is ever sent to it.
CREATE OR REPLACE FUNCTION guest_user_id()
RETURNS UUID AS $$
  SELECT id FROM auth.users WHERE email = 'guest@violetocr.invalid' LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp;

-- Makes the guest account unable to pay for anything, so settle_job can only
-- ever hold its jobs. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION prepare_guest_user(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  IF p_user_id IS DISTINCT FROM guest_user_id() THEN
    RAISE EXCEPTION 'not the guest account';
  END IF;

  INSERT INTO user_profiles (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_cents INTO v_balance FROM user_profiles WHERE user_id = p_user_id FOR UPDATE;

  -- Take back the signup grant, on the ledger, so the books still add up.
  IF COALESCE(v_balance, 0) <> 0 THEN
    INSERT INTO billing_transactions (user_id, kind, amount_cents, balance_after, note)
      VALUES (p_user_id, 'adjust', -v_balance, 0, 'guest account holds no credit');
  END IF;

  UPDATE user_profiles
     SET balance_cents = 0, is_banned = TRUE, updated_at = now()
   WHERE user_id = p_user_id;

  -- A charge on the ledger means user_has_prior_document() is always true for
  -- the guest, so no guest job is ever settled as someone's free first document.
  IF NOT EXISTS (SELECT 1 FROM billing_transactions
                  WHERE user_id = p_user_id AND kind = 'charge') THEN
    INSERT INTO billing_transactions (user_id, kind, amount_cents, rows, job_id, balance_after, note)
      VALUES (p_user_id, 'charge', 0, 0, NULL, 0,
              'guest account: holds landing-page uploads, never charged');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Hand a guest job to the person who uploaded it ──────────────────────────
CREATE OR REPLACE FUNCTION claim_guest_job(p_job_id UUID, p_claim_hash TEXT, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_guest  UUID := guest_user_id();
  v_owner  UUID;
  v_hash   TEXT;
  v_exp    TIMESTAMPTZ;
  v_status TEXT;
  v_rows   INTEGER;
  v_cost   INTEGER;
  v_settle JSONB;
BEGIN
  IF v_guest IS NULL OR p_user_id IS NULL OR p_user_id = v_guest THEN
    RETURN jsonb_build_object('result', 'invalid');
  END IF;

  SELECT user_id, guest_claim_hash, guest_expires_at, status, row_count
    INTO v_owner, v_hash, v_exp, v_status, v_rows
    FROM document_jobs WHERE id = p_job_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Claimed already by this person (a second tab, a retry after a dropped
  -- connection): not an error.
  IF v_owner = p_user_id THEN
    RETURN jsonb_build_object('result', 'claimed', 'job_status', v_status, 'already', true);
  END IF;

  IF v_owner <> v_guest OR v_hash IS NULL OR v_hash <> p_claim_hash THEN
    RETURN jsonb_build_object('result', 'invalid');
  END IF;

  IF v_exp IS NOT NULL AND v_exp < now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;

  UPDATE document_jobs
     SET user_id = p_user_id, guest_claim_hash = NULL, guest_expires_at = NULL
   WHERE id = p_job_id;

  -- Finished already: price it for its new owner now. Whatever the guest
  -- settle recorded is discarded -- the guest never pays.
  IF v_status = 'completed' THEN
    v_rows := GREATEST(COALESCE(v_rows, 0), 0);
    v_cost := (v_rows * 3 + 1) / 2;
    UPDATE document_jobs
       SET row_count = v_rows, cost_cents = v_cost, payment_status = 'unpaid'
     WHERE id = p_job_id;
    v_settle := apply_job_charge(p_job_id, p_user_id, v_rows, v_cost);
  END IF;

  RETURN jsonb_build_object('result', 'claimed', 'job_status', v_status, 'settle', v_settle);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Service role only. Every public function is published at /rest/v1/rpc/, and
-- claim_guest_job takes the user id as an argument -- callable by a customer,
-- it would let them claim a job into someone else's account.
REVOKE ALL ON FUNCTION guest_user_id()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION prepare_guest_user(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_guest_job(UUID, TEXT, UUID)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION guest_user_id()                   TO service_role;
GRANT EXECUTE ON FUNCTION prepare_guest_user(UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION claim_guest_job(UUID, TEXT, UUID) TO service_role;

COMMIT;
