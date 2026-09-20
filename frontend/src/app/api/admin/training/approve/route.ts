import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// POST /api/admin/training/approve
//
// Admin moves a trainer-verified row to its final state.
//   approve → status='approved' (final, eligible for CSV export)
//   reject  → status='rejected' (kept for audit, hidden from trainer view)
//
// Admin may edit `label` in the same call to fix small typos without bouncing
// back to the trainer. Bulk variant accepts an `ids` array.
//
// Body:
//   single: { id: "uuid", decision: "approve"|"reject", label?: string, reason?: string }
//   bulk:   { ids: ["uuid", ...], decision: "approve"|"reject", reason?: string }
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, adminEmail } = guard;

  const body = await req.json().catch(() => ({}));
  const decision = body.decision === "reject" ? "reject" : body.decision === "approve" ? "approve" : null;
  if (!decision) {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'" }, { status: 400 });
  }

  const ids: string[] =
    Array.isArray(body.ids)
      ? body.ids.filter((x: unknown) => typeof x === "string")
      : typeof body.id === "string"
        ? [body.id]
        : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Missing id or ids[]" }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: "Max 200 ids per request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = {};
  if (decision === "approve") {
    patch.status      = "approved";
    patch.approved_at = now;
    patch.approved_by = user.id;
    // Allow optional inline label edit (single-row only — bulk-edit a label
    // makes no sense across distinct crops).
    if (ids.length === 1 && typeof body.label === "string") {
      patch.label = body.label.trim();
    }
  } else {
    patch.status           = "rejected";
    patch.rejected_at      = now;
    patch.rejected_by      = user.id;
    patch.rejection_reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;
  }

  // Only act on rows currently in 'verified' — prevents accidental re-approval
  // of already-approved rows or moving rejected rows around.
  const { data, error } = await admin
    .from("training_dataset")
    .update(patch)
    .in("id", ids)
    .eq("status", "verified")
    .select("id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const applied = (data ?? []).length;

  await logAudit(supabase, user.id, adminEmail,
    decision === "approve" ? "training.approved" : "training.rejected",
    "training_dataset",
    undefined,
    { requested: ids.length, applied, reason: body.reason ?? null },
  );

  return NextResponse.json({ success: true, applied, requested: ids.length });
}
