import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// GET /api/admin/users/[id] — full user detail
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const [{ data: profile }, { data: docs }, { data: waitlist }] = await Promise.all([
    supabase
      .from("user_profiles")
      .select("user_id, email, full_name, plan, subscription_status, pages_used_this_month, balance_cents, rows_used_total, is_admin, is_trainer, is_banned, created_at, usage_reset_at")
      .eq("user_id", params.id)
      .single(),

    supabase
      .from("document_jobs")
      .select("id, document_name, status, created_at, completed_at, error_message")
      .eq("user_id", params.id)
      .order("created_at", { ascending: false })
      .limit(20),

    supabase
      .from("waitlist")
      .select("id, email, name, created_at, contacted, upgraded")
      .eq("user_id", params.id)
      .maybeSingle(),
  ]);

  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 });

  return NextResponse.json({ profile, documents: docs ?? [], waitlist });
}

// PATCH /api/admin/users/[id] — update profile fields (is_admin, full_name, is_banned)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  const body = await req.json().catch(() => ({}));
  const allowed = ["is_admin", "is_trainer", "full_name", "is_banned"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in body) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Service role, after assertAdmin above. Migration 039 took UPDATE on
  // user_profiles away from `authenticated` entirely: with it, any customer
  // could set is_admin or balance_cents on their own row. So this write can no
  // longer ride on the admin's own login and the "Admins update all profiles"
  // policy — assertAdmin is the gate now.
  let db;
  try {
    db = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  const { error } = await db
    .from("user_profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("user_id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const action = "is_banned" in updates
    ? (updates.is_banned ? "user.banned" : "user.unbanned")
    : "user.updated";
  await logAudit(supabase, user.id, adminEmail, action, "user", params.id, updates as Record<string, unknown>);
  return NextResponse.json({ success: true });
}

// DELETE /api/admin/users/[id] — HARD delete: removes auth user + cascades
// user_profiles, document_jobs, etc. via FK. Email is freed, user can sign
// up again. Use Ban (PATCH is_banned=true) if you need to block re-signup.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  if (user.id === params.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  // Snapshot email for audit log (row will be gone after delete)
  const { data: targetProfile } = await supabase
    .from("user_profiles")
    .select("email")
    .eq("user_id", params.id)
    .maybeSingle();

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(
    supabase, user.id, adminEmail,
    "user.deleted", "user", params.id,
    { hard: true, email: targetProfile?.email ?? null },
  );
  return NextResponse.json({ success: true });
}
