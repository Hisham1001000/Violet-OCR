import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ROW_PRICE_TENTHS, rowsAffordable } from "@/lib/billing";

// GET /api/billing — balance plus the statement behind it.
export async function GET() {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  const [{ data: profile }, { data: txns }] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("balance_cents, rows_used_total")
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("billing_transactions")
      .select("id, kind, amount_cents, rows, job_id, balance_after, note, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const balance_cents = profile?.balance_cents ?? 0;

  // Documents processed but held for want of credit — the thing a user landing
  // on this page after hitting the wall is actually looking for.
  const { data: held } = await supabase
    .from("document_jobs")
    .select("id, document_name, row_count, cost_cents")
    .eq("user_id", user.id)
    .eq("payment_status", "unpaid")
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    balance_cents,
    rows_used_total: profile?.rows_used_total ?? 0,
    rows_affordable: rowsAffordable(balance_cents),
    row_price_cents: ROW_PRICE_TENTHS / 10,
    transactions:    txns ?? [],
    held:            held ?? [],
  });
}
