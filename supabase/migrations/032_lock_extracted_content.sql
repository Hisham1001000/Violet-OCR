-- ── Migration 032: the paywall has to hold in the database ──────────────────
--
-- document_jobs carries "Users see own jobs FOR ALL USING (auth.uid() =
-- user_id)" from migration 001, and the anon key ships to every browser. So a
-- signed-in user can read their own row directly:
--
--   supabase.from('document_jobs').select('structured_data').eq('id', jobId)
--
-- which walks straight past the "add credit to unlock" screen and the API route
-- behind it. A paywall enforced only in an API route the client does not have
-- to use is decoration.
--
-- Postgres has no column filtering inside an RLS policy, so the fix is column
-- privileges: the four columns holding the extraction are simply not readable
-- by anon or authenticated. Everything else on the row stays readable, which is
-- what the documents list, the status poller and the lock screen itself need.
--
-- The three API routes that legitimately serve this content now read it with
-- the service role, having checked ownership (and payment) themselves:
--   GET  /api/documents/[id]
--   POST /api/documents/[id]/export
--   GET  /api/admin/documents/[id]
--
-- UPDATE is deliberately NOT revoked: saving a corrected table writes
-- structured_data, and that policy's USING clause only looks at user_id.

REVOKE SELECT (structured_data, full_text, fields_json, column_order)
  ON document_jobs FROM anon, authenticated;

-- Realtime subscribes to document_jobs to nudge the page when a job finishes.
-- The subscription payload is ignored — the page refetches through the API — so
-- a filtered or dropped payload costs nothing, and the poller is the backstop
-- either way.
