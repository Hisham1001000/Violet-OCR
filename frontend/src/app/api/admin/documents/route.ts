import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin } from "@/lib/admin";

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") ?? "";
  const search = searchParams.get("search")?.trim() ?? "";
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit  = 50;
  const offset = (page - 1) * limit;

  // Step 1: fetch the documents page WITHOUT trying to embed user_profiles.
  // PostgREST can't auto-resolve `user_profiles!inner(email)` here because the
  // FK on document_jobs.user_id points to auth.users, not user_profiles —
  // which made the embedded join 500. Doing this in two queries also lets
  // documents whose owner is missing a profile row still appear in the list.
  let query = supabase
    .from("document_jobs")
    .select("id, user_id, document_name, status, created_at, completed_at, error_message", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (search) query = query.ilike("document_name", `%${search}%`);

  const { data: docs, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Step 2: hydrate owner emails from user_profiles in one batched query.
  const userIds = Array.from(new Set((docs ?? []).map((d) => d.user_id).filter(Boolean)));
  const emailByUserId: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("user_id, email")
      .in("user_id", userIds);
    for (const p of profiles ?? []) {
      if (p.user_id && p.email) emailByUserId[p.user_id] = p.email;
    }
  }

  const documents = (docs ?? []).map((d) => ({
    ...d,
    user_profiles: emailByUserId[d.user_id] ? { email: emailByUserId[d.user_id] } : null,
  }));

  return NextResponse.json({ documents, total: count ?? 0, page, limit });
}
