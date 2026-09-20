import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin } from "@/lib/admin";

// GET /api/admin/waitlist — list all waitlist entries with current plan + full_name
export async function GET(request: Request) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  // Optional name/email search filter
  const { searchParams } = new URL(request.url);
  const nameQuery = searchParams.get("name")?.toLowerCase().trim() ?? "";

  // Step 1: fetch waitlist entries
  const { data: entries, error } = await supabase
    .from("waitlist")
    .select("id, email, name, created_at, contacted, upgraded, user_id")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userIds = (entries ?? []).map((e) => e.user_id).filter(Boolean) as string[];
  let planMap: Record<string, string> = {};
  let nameMap: Record<string, string> = {};

  if (userIds.length > 0) {
    // Step 2: fetch plan + full_name for all linked users
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("user_id, plan, full_name")
      .in("user_id", userIds);

    planMap = Object.fromEntries(
      (profiles ?? []).map((p) => [p.user_id, p.plan ?? "free"])
    );
    nameMap = Object.fromEntries(
      (profiles ?? []).map((p) => [p.user_id, p.full_name ?? ""])
    );
  }

  // Step 3: deduplicate by email + attach plan + full_name
  const seen = new Set<string>();
  let merged = (entries ?? [])
    .filter((e) => {
      if (seen.has(e.email)) return false;
      seen.add(e.email);
      return true;
    })
    .map((e) => ({
      ...e,
      current_plan: e.user_id ? (planMap[e.user_id] ?? "free") : null,
      full_name:    e.user_id ? (nameMap[e.user_id] ?? e.name ?? null) : (e.name ?? null),
    }));

  // Step 4: apply search filter (name or email)
  if (nameQuery) {
    merged = merged.filter((e) => {
      const n = (e.full_name ?? e.name ?? "").toLowerCase();
      const em = e.email.toLowerCase();
      return n.includes(nameQuery) || em.includes(nameQuery);
    });
  }

  return NextResponse.json({ entries: merged });
}
