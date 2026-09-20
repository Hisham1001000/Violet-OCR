import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

async function assertAdmin(supabase: ReturnType<typeof createClient>) {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_admin")
    .eq("user_id", user.id)
    .single();
  return profile?.is_admin ? user : null;
}

// PATCH /api/admin/waitlist/[id] — mark contacted or upgraded
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const admin = await assertAdmin(supabase);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.contacted === "boolean") updates.contacted = body.contacted;
  if (typeof body.upgraded === "boolean")  updates.upgraded  = body.upgraded;

  const { error } = await supabase
    .from("waitlist")
    .update(updates)
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
