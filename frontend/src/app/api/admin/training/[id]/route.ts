import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin, logAudit } from "@/lib/admin";

// PATCH /api/admin/training/[id] — save a label edit and/or change status
// Body:
//   { label?: string, status?: "verified" | "rejected" | "pending" }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, email } = guard;

  const body = await req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.label === "string")  updates.label  = body.label.trim();
  if (typeof body.status === "string" && ["pending", "verified", "rejected"].includes(body.status)) {
    updates.status = body.status;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }
  if (updates.status && updates.status !== "pending") {
    updates.reviewed_at = new Date().toISOString();
    updates.reviewed_by = user.id;
  }

  const admin = createAdminClient();
  const { error } = await admin.from("training_dataset").update(updates).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, user.id, email, "training.labelled", "training_dataset", params.id, updates);
  return NextResponse.json({ success: true });
}

// DELETE /api/admin/training/[id] — remove a row + its crop file from storage
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, email } = guard;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("training_dataset")
    .select("crop_path")
    .eq("id", params.id)
    .maybeSingle();

  const { error } = await admin.from("training_dataset").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (row?.crop_path) {
    await admin.storage.from("training_crops").remove([row.crop_path]).catch(() => {});
  }
  await logAudit(supabase, user.id, email, "training.deleted", "training_dataset", params.id);
  return NextResponse.json({ success: true });
}
