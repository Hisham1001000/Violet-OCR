import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin } from "@/lib/admin";

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const { searchParams } = req.nextUrl;
  // Plans are gone (migration 030); the only filter that still means anything
  // is the email search and "who is out of credit".
  const empty  = searchParams.get("empty") === "1";
  const search = searchParams.get("search")?.trim() ?? "";
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  let query = supabase
    .from("user_profiles")
    .select("user_id, email, full_name, balance_cents, rows_used_total, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (empty)  query = query.lte("balance_cents", 0);
  if (search) query = query.ilike("email", `%${search}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ subscriptions: data ?? [], total: count ?? 0, page, limit });
}
