import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin, logAudit } from "@/lib/admin";

// PATCH /api/admin/training/batch — apply many label edits at once.
// Powers the trainer UI's auto-save (every N edits → one round-trip).
//
// Body:
//   { updates: [{ id, label?, status? }, ...] }   (max 200 items)
//
// Returns: { success, applied, errors }
export async function PATCH(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, email } = guard;

  const body = await req.json().catch(() => ({}));
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (updates.length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }
  if (updates.length > 200) {
    return NextResponse.json({ error: "Max 200 updates per batch" }, { status: 400 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const errors: Array<{ id: string; error: string }> = [];
  let applied = 0;

  // Fire updates in parallel — they all touch different rows.
  // Trainer can ONLY move rows pending↔verified. They cannot push directly to
  // 'approved' (admin-only) or 'rejected' (admin-only — see /approve route).
  const TRAINER_ALLOWED = new Set(["pending", "verified"]);
  await Promise.all(
    updates.map(async (u: { id?: string; label?: string; status?: string }) => {
      if (!u || typeof u.id !== "string") return;
      const patch: Record<string, unknown> = {};
      if (typeof u.label === "string")  patch.label  = u.label.trim();
      if (typeof u.status === "string" && TRAINER_ALLOWED.has(u.status)) {
        patch.status = u.status;
      }
      if (Object.keys(patch).length === 0) return;
      // Trainer-side audit: stamp verified_at/verified_by when entering 'verified'.
      // Going back to 'pending' clears them (trainer changed their mind).
      if (patch.status === "verified") {
        patch.verified_at = now;
        patch.verified_by = user.id;
      } else if (patch.status === "pending") {
        patch.verified_at = null;
        patch.verified_by = null;
      }
      const { error } = await admin.from("training_dataset").update(patch).eq("id", u.id);
      if (error) {
        errors.push({ id: u.id, error: error.message });
      } else {
        applied++;
      }
    }),
  );

  // Single audit row summarising the batch (cheaper than N audit rows).
  await logAudit(supabase, user.id, email, "training.batch_labelled", "training_dataset", undefined, {
    requested: updates.length, applied, errors: errors.length,
  });

  return NextResponse.json({ success: true, applied, errors });
}
