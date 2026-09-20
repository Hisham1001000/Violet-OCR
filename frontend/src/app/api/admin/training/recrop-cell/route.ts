import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin, logAudit } from "@/lib/admin";

// POST /api/admin/training/recrop-cell
//
// Overwrite a single crop image with a trainer-tightened version.
// Body: { id: "uuid", image_base64: "iVBORw0KGgo..." }   (raw base64, no data: prefix)
//
// The trainer's CropAdjustModal extracts a sub-region from the existing crop
// via HTMLCanvasElement and sends the resulting PNG bytes here. We upload
// to the same storage path (overwrite) so the crop_path on the row stays
// valid and downstream caches (signed URLs) auto-refresh on next load.
//
// Returns: { success: true, crop_path }
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, email } = guard;

  const body = await req.json().catch(() => ({}));
  const id   = typeof body.id === "string" ? body.id : "";
  const b64  = typeof body.image_base64 === "string" ? body.image_base64 : "";
  // Optional: the box (in context pixels) that produced this crop. Persisted so
  // the NEXT viewer (e.g. the admin reviewing) sees the crop the editor made,
  // not the original auto-detected region.
  const rawBox = body.box;
  const editBox =
    rawBox && typeof rawBox === "object" &&
    (["x", "y", "w", "h"] as const).every((k) => typeof rawBox[k] === "number")
      ? { x: rawBox.x, y: rawBox.y, w: rawBox.w, h: rawBox.h }
      : null;
  if (!id || !b64) {
    return NextResponse.json({ error: "Missing id or image_base64" }, { status: 400 });
  }

  // Hard cap on payload — guards against runaway uploads.
  // 5 MB raw bytes ≈ 6.7 MB base64; cap inputs at 8 MB string.
  if (b64.length > 8 * 1024 * 1024) {
    return NextResponse.json({ error: "Image too large (max ~5 MB raw)" }, { status: 413 });
  }

  let bytes: Buffer;
  try {
    // Strip optional data: prefix and decode.
    const cleaned = b64.replace(/^data:image\/\w+;base64,/, "");
    bytes = Buffer.from(cleaned, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid base64" }, { status: 400 });
  }
  // Sanity check — must look like a PNG (89 50 4E 47).
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return NextResponse.json({ error: "Decoded bytes are not a PNG" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up the row to get its crop_path.
  const { data: row, error: rowErr } = await admin
    .from("training_dataset")
    .select("id, crop_path, status")
    .eq("id", id)
    .single();
  if (rowErr || !row) {
    return NextResponse.json({ error: "Row not found" }, { status: 404 });
  }
  // Don't let trainers re-crop already-approved rows — admin owns final state.
  if (row.status === "approved") {
    return NextResponse.json(
      { error: "Cannot re-crop an approved row. Ask an admin to reopen it first." },
      { status: 403 },
    );
  }

  // Overwrite the existing storage object.
  const { error: upErr } = await admin.storage
    .from("training_crops")
    .upload(row.crop_path, bytes, {
      contentType: "image/png",
      upsert: true,
    });
  if (upErr) {
    return NextResponse.json({ error: `Storage upload failed: ${upErr.message}` }, { status: 500 });
  }

  // Bump reviewed_at (marks "just touched") and, when provided, persist the
  // adjusted box so the next viewer starts from the crop this editor made.
  const upd: Record<string, unknown> = { reviewed_at: new Date().toISOString() };
  if (editBox) upd.context_box = editBox;
  const { error: updErr } = await admin.from("training_dataset").update(upd).eq("id", id);
  if (updErr && /context_box/.test(updErr.message)) {
    // migration 025 not applied — fall back to touching reviewed_at only.
    await admin.from("training_dataset").update({ reviewed_at: new Date().toISOString() }).eq("id", id);
  }

  await logAudit(supabase, user.id, email, "training.recrop_cell", "training_dataset", id, {
    bytes: bytes.length,
  });

  return NextResponse.json({ success: true, crop_path: row.crop_path });
}
