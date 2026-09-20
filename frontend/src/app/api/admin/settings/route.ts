import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertAdmin, logAudit } from "@/lib/admin";

// GET /api/admin/settings
export async function GET() {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const { data, error } = await supabase
    .from("system_settings")
    .select("key, value, description, updated_at")
    .order("key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ settings: data ?? [] });
}

// PUT /api/admin/settings — upsert one key (update if exists, insert if not)
export async function PUT(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  const body = await req.json().catch(() => ({}));
  const { key, value } = body;

  if (!key || value === undefined) {
    return NextResponse.json({ error: "key and value are required" }, { status: 400 });
  }

  // Use UPSERT so the save always lands regardless of RLS UPDATE vs INSERT split
  const { data: saved, error } = await supabase
    .from("system_settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString(), updated_by: user.id },
      { onConflict: "key" }
    )
    .select("key, value")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!saved) return NextResponse.json({ error: "Save failed — no rows affected" }, { status: 500 });

  await logAudit(supabase, user.id, adminEmail, "setting.updated", "setting", key, { value });
  return NextResponse.json({ success: true, saved });
}
