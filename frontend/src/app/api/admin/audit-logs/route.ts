import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin } from "@/lib/admin";

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const { searchParams } = req.nextUrl;
  const action     = searchParams.get("action") ?? "";
  const targetType = searchParams.get("target_type") ?? "";
  const from       = searchParams.get("from") ?? "";
  const to         = searchParams.get("to") ?? "";
  const page       = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit      = 100;
  const offset     = (page - 1) * limit;

  let query = supabase
    .from("audit_logs")
    .select("id, actor_id, actor_email, action, target_type, target_id, details, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (action)     query = query.ilike("action", `%${action}%`);
  if (targetType) query = query.eq("target_type", targetType);
  if (from)       query = query.gte("created_at", from);
  if (to)         query = query.lte("created_at", to);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ logs: data ?? [], total: count ?? 0, page, limit });
}
