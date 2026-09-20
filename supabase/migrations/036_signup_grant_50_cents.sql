-- ── Migration 036: free credit stays $0.50 ──────────────────────────────────
--
-- Migration 035 raised the signup grant to 75 cents, to keep "50 free rows" at
-- the new 1.5-cent price. The owner wants the free credit to stay $0.50 in
-- dollars instead (33 rows at 1.5 cents), so the default goes back to 50.
--
-- handle_new_user() records whatever this default gives, so it needs no change.
-- Existing balances are untouched.

ALTER TABLE user_profiles ALTER COLUMN balance_cents SET DEFAULT 50;

-- Check after running (expect 50):
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name = 'user_profiles' AND column_name = 'balance_cents';
