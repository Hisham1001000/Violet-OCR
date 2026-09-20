-- ── Migration 038: new accounts can be created again ─────────────────────────
--
-- Since migration 030, creating an account fails with "Database error creating
-- new user". The last account was created 2026-09-09 10:16 UTC. Found on
-- 2026-09-10 when the billing test could not create its throwaway account.
--
-- Why: 030 rewrote handle_new_user() — the trigger that runs when auth.users
-- gets a row — in a way that can break signup:
--
--   1. No `SET search_path`, and table names without `public.`. The trigger
--      runs inside Supabase Auth's own connection, whose search path is the
--      `auth` schema, so `user_profiles` can resolve to a table that is not
--      there. Supabase's own guidance is to pin search_path on these functions.
--   2. It dropped the EXCEPTION block that migrations 008 and 017 had put there
--      on purpose "so it NEVER blocks signup". Any error in the trigger now
--      rolls back the whole account creation — Google sign-in included.
--   3. It stopped storing email and full_name, which the admin panel shows.
--
-- This restores all three and keeps 030's addition: the welcome credit is
-- written to the statement.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  INSERT INTO public.user_profiles AS up (user_id, email, full_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name')
    )
  ON CONFLICT (user_id) DO UPDATE
    SET email     = EXCLUDED.email,
        full_name = COALESCE(up.full_name, EXCLUDED.full_name);

  -- The balance_cents DEFAULT gives the credit; this puts it on the statement.
  SELECT balance_cents INTO v_balance FROM public.user_profiles WHERE user_id = NEW.id;
  IF COALESCE(v_balance, 0) > 0 AND NOT EXISTS (
       SELECT 1 FROM public.billing_transactions WHERE user_id = NEW.id AND kind = 'grant'
     ) THEN
    INSERT INTO public.billing_transactions (user_id, kind, amount_cents, balance_after, note)
      VALUES (NEW.id, 'grant', v_balance, v_balance, 'رصيد ترحيبي');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup. A missing profile is recoverable (settle_job and
  -- add_balance both create one); a person who cannot register is not.
  RAISE WARNING 'handle_new_user failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_new_user ON auth.users;
CREATE TRIGGER trg_new_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Profiles made since 030 by settle_job/add_balance carry no email. Fill them.
UPDATE public.user_profiles up
   SET email = u.email
  FROM auth.users u
 WHERE up.user_id = u.id
   AND (up.email IS NULL OR up.email = '')
   AND u.email IS NOT NULL;

-- The same search_path pin on the money functions. They are reached through
-- PostgREST today, where the path is already `public`, but a SECURITY DEFINER
-- function without one can be steered by whoever controls the caller's path.
ALTER FUNCTION public.settle_job(UUID, UUID, INTEGER)                SET search_path = public;
ALTER FUNCTION public.settle_job_self(UUID)                          SET search_path = public;
ALTER FUNCTION public.apply_job_charge(UUID, UUID, INTEGER, INTEGER) SET search_path = public;
ALTER FUNCTION public.add_balance(UUID, INTEGER, TEXT, TEXT)         SET search_path = public;

COMMIT;
