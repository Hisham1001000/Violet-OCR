-- ── Migration 033: actually revoke the extracted content ────────────────────
--
-- Migration 032 ran without error and changed nothing. Verified against the
-- live database with the anon key: selecting structured_data still returned a
-- result set instead of "permission denied for column".
--
-- Why 032 was a no-op: Supabase grants TABLE-level SELECT on public tables to
-- anon and authenticated. A table-level grant covers every column, and
-- REVOKE SELECT (col) cannot carve a hole in one -- Postgres just raises a
-- "no privileges could be revoked" NOTICE and moves on. Column privileges only
-- bite when the table-level grant is gone and the readable columns are granted
-- back one by one, which is what this does.
--
-- Column privileges are checked BEFORE row security, so this holds even for a
-- query that would have matched no rows: the request fails on the column, not
-- on the policy.

REVOKE SELECT ON document_jobs FROM anon, authenticated;

-- Everything a signed-in user still needs: the documents list, the status
-- poller, and the "your file is ready, add credit" screen, which has to show
-- the row count and the cost of a document it is not allowed to show.
GRANT SELECT (
  id,
  user_id,
  document_name,
  status,
  document_url,
  error_message,
  file_hash,
  created_at,
  completed_at,
  row_count,
  cost_cents,
  payment_status
) ON document_jobs TO anon, authenticated;

-- Deliberately NOT granted: structured_data, full_text, fields_json,
-- column_order, cell_polygons. The first four are the extraction itself;
-- cell_polygons carries the per-cell text the training cropper labels from, so
-- leaving it readable would hand over the same table by another route.
--
-- These five are served only by routes that check ownership and payment first
-- and read with the service role:
--   GET  /api/documents/[id]
--   POST /api/documents/[id]/export
--   GET  /api/admin/documents/[id]
--   POST /api/admin/training/recrop        (cell_polygons)
--
-- UPDATE is untouched -- saving a corrected table writes structured_data, and
-- both the RLS policy and the PATCH's own filter only read user_id and id.
--
-- One consequence worth knowing: `select("*")` on this table now fails for
-- anon and authenticated, because * means every column. Any such query has to
-- name its columns or run as the service role. /api/admin/stats was the only
-- one and has been switched to the service role.


-- ── Explain the balance the existing 93 accounts woke up with ───────────────
-- ADD COLUMN ... DEFAULT 50 backfilled every existing row, which is what we
-- wanted, but it happened outside the ledger: those users see $0.50 on their
-- statement page with nothing above it accounting for where it came from.
-- The grant trigger only fires for new signups, so this writes the same row
-- retroactively. Idempotent -- a second run adds nothing.
INSERT INTO billing_transactions (user_id, kind, amount_cents, balance_after, note, created_at)
SELECT p.user_id, 'grant', p.balance_cents, p.balance_cents, 'رصيد ترحيبي', p.created_at
  FROM user_profiles p
 WHERE p.balance_cents > 0
   AND NOT EXISTS (
     SELECT 1 FROM billing_transactions t
      WHERE t.user_id = p.user_id AND t.kind = 'grant'
   );
