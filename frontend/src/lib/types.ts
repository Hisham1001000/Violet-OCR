export interface DocumentJob {
  id: string;
  user_id: string;
  document_name: string;
  status: "pending" | "processing" | "completed" | "failed";
  document_url: string | null;
  full_text: string | null;
  fields_json: Array<{ field_name: string; value: string }> | null;
  structured_data: Array<Record<string, string | null>> | null;
  column_order: string[] | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;

  // ── Billing (migration 030) ───────────────────────────────────────────────
  row_count?: number | null;
  cost_cents?: number | null;
  payment_status?: "pending" | "paid" | "unpaid";
  // Only present when payment_status is 'unpaid': the API withholds the rows
  // and sends what the person needs in order to unlock them instead.
  locked?: boolean;
  balance_cents?: number;
  shortfall_cents?: number;
  // True only when the newest ledger charge was written by the run that just
  // finished; charged_at is that charge's time. Opening an old document
  // leaves just_charged false.
  just_charged?: boolean;
  charged_at?: string | null;
}

// ── GET /api/usage ────────────────────────────────────────────────────────────
// The balance summary behind the top bar's credit pill and the dashboard's
// upload gate. Both used to declare their own subset of this shape, so a field
// renamed in the route stayed green in the compiler and arrived as `undefined`
// at runtime. One interface, one place to change.
export interface UsageResponse {
  balance_cents: number;
  spent_cents: number;
  /** balance + everything ever spent — the denominator of the "X of Y" bar. */
  lifetime_cents: number;
  rows_used_total: number;
  rows_affordable: number;
  /** Whole cents. ROW_PRICE_TENTHS is the source; this is it divided by 10. */
  row_price_cents: number;
  can_upload: boolean;
  is_admin: boolean;
  is_trainer: boolean;
}
