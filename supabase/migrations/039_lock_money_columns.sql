-- ── Migration 039: customers cannot write money or permission columns ────────
--
-- Found 2026-09-10 by test_billing_live.py, signed in as an ordinary customer
-- with nothing but the public anon key and their own login:
--
--   PATCH /rest/v1/user_profiles  {"balance_cents": 999999}   -> balance became 999999
--   PATCH /rest/v1/document_jobs  {"payment_status": "paid"}  -> held document unlocked
--
-- Why: Supabase grants table-level INSERT/UPDATE/DELETE on public tables to
-- `authenticated`, and the row policies here only ask "is this your row?"
-- (003 "Users update own profile", 001 "Users see own jobs" FOR ALL). Every
-- column of your own row was writable — balance_cents, is_admin, is_banned,
-- is_trainer, cost_cents, payment_status. Anyone could make themselves an
-- admin, lift their own ban, or give themselves credit.
--
-- As in migration 033, a column privilege only bites once the table-level
-- grant is gone, so each table is revoked whole and the columns the website
-- legitimately writes are granted back one by one.

BEGIN;

-- ── user_profiles: no customer writes at all ────────────────────────────────
-- Nothing in the app writes a profile with a customer's login. Signup
-- (handle_new_user), visits (track_user_visit) and money (settle_job,
-- add_balance) are SECURITY DEFINER functions, and the admin panel writes
-- through the service role (api/admin/users/[id], changed alongside this).
REVOKE INSERT, UPDATE, DELETE ON user_profiles FROM anon, authenticated;
DROP POLICY IF EXISTS "Users update own profile" ON user_profiles;

-- ── document_jobs: only the columns the website writes ──────────────────────
REVOKE INSERT, UPDATE ON document_jobs FROM anon, authenticated;
REVOKE DELETE ON document_jobs FROM anon;

-- api/upload creates a job with exactly these. payment_status, cost_cents and
-- row_count take their defaults and only settle_job ever sets them.
GRANT INSERT (user_id, document_name, status, document_url, file_hash)
  ON document_jobs TO authenticated;

-- api/upload and api/documents/[id]/reprocess move status; the table editor
-- saves structured_data and column_order; admin approve/reject sets status.
GRANT UPDATE (status, error_message, completed_at, structured_data, column_order, document_name)
  ON document_jobs TO authenticated;

-- Deleting your own document (api/documents/[id] DELETE) stays allowed: the
-- table-level DELETE grant to authenticated is untouched, and the row policy
-- still limits it to your own jobs.

COMMIT;

-- Proof it holds: python test_billing_live.py, section 2.
