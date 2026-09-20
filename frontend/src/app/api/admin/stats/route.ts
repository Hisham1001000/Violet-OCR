import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  // These counts use select("*"), which needs SELECT on every column. Migration
  // 033 revokes the extracted-content columns from `authenticated`, so the
  // admin's own session can no longer run them. assertAdmin above is the
  // authorisation check; the service role is only how the query is executed.
  const db = createAdminClient();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalUsers },
    { count: newUsersThisMonth },
    { count: totalDocs },
    { count: docsToday },
    { count: paidSubs },
    { data: usageData },
    { count: waitlistCount },
    { count: failedDocs },
    { count: activeToday },
    { count: activeThisWeek },
    { data: loginData },
  ] = await Promise.all([
    db.from("user_profiles").select("*", { count: "exact", head: true }),
    db.from("user_profiles").select("*", { count: "exact", head: true }).gte("created_at", monthStart),
    db.from("document_jobs").select("*", { count: "exact", head: true }),
    db.from("document_jobs").select("*", { count: "exact", head: true }).gte("created_at", todayStart),
    db.from("user_profiles").select("*", { count: "exact", head: true }).lte("balance_cents", 0),
    db.from("user_profiles").select("rows_used_total"),
    supabase.from("waitlist").select("*", { count: "exact", head: true }),
    db.from("document_jobs").select("*", { count: "exact", head: true }).eq("status", "failed"),
    db.from("user_profiles").select("*", { count: "exact", head: true }).gte("last_active_at", todayStart),
    db.from("user_profiles").select("*", { count: "exact", head: true }).gte("last_active_at", weekStart),
    db.from("user_profiles").select("login_count"),
  ]);

  // Rows, not pages: rows are what is billed. NOT revenue in cents any more --
  // the price per row changed in migration 035; cents_spent_total has the money.
  const totalRowsExtracted = (usageData ?? []).reduce(
    (sum: number, r: { rows_used_total: number }) => sum + (r.rows_used_total ?? 0), 0
  );
  const totalLogins = (loginData ?? []).reduce(
    (sum: number, r: { login_count: number }) => sum + (r.login_count ?? 0), 0
  );

  return NextResponse.json({
    total_users:          totalUsers ?? 0,
    new_users_this_month: newUsersThisMonth ?? 0,
    total_documents:      totalDocs ?? 0,
    documents_today:      docsToday ?? 0,
    accounts_out_of_credit: paidSubs ?? 0,
    total_rows_extracted:   totalRowsExtracted,
    waitlist_pending:     waitlistCount ?? 0,
    failed_documents:     failedDocs ?? 0,
    active_today:         activeToday ?? 0,
    active_this_week:     activeThisWeek ?? 0,
    total_logins:         totalLogins,
  });
}
