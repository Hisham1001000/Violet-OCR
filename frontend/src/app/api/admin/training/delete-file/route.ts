import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// POST /api/admin/training/delete-file
// Body: { job_id: "uuid" }
//
// Admin-only. Permanently removes a training file and everything derived from
// it: the training_dataset rows, the cropped images in the training_crops
// bucket, the document_jobs row, and the original uploaded file in the
// documents bucket.
//
// This is destructive and irreversible — hence admin-only (not trainers) and a
// hard confirmation in the UI.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, adminEmail } = guard;

  const body  = await req.json().catch(() => ({}));
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!jobId) {
    return NextResponse.json({ error: "Missing job_id" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up the job so we can also remove its original file.
  const { data: job } = await admin
    .from("document_jobs")
    .select("id, document_url, document_name")
    .eq("id", jobId)
    .single();

  const removed = { crops: 0, rows: 0 };

  // 1) Remove the cropped images under training_crops/{job_id}/
  try {
    const { data: objs } = await admin.storage.from("training_crops").list(jobId, { limit: 1000 });
    const paths = (objs ?? []).map((o) => `${jobId}/${o.name}`);
    if (paths.length > 0) {
      await admin.storage.from("training_crops").remove(paths);
      removed.crops = paths.length;
    }
  } catch {
    // Non-fatal — DB rows are the source of truth; orphan images are harmless.
  }

  // 2) Delete the training_dataset rows
  const { data: delRows, error: delErr } = await admin
    .from("training_dataset")
    .delete()
    .eq("job_id", jobId)
    .select("id");
  if (delErr) {
    return NextResponse.json({ error: `Could not delete training rows: ${delErr.message}` }, { status: 500 });
  }
  removed.rows = delRows?.length ?? 0;

  // 4) Remove the original uploaded file from the documents bucket
  if (job?.document_url) {
    await admin.storage.from("documents").remove([job.document_url]).catch(() => {});
  }

  // 5) Delete the document_jobs row itself
  const { error: jobDelErr } = await admin.from("document_jobs").delete().eq("id", jobId);
  if (jobDelErr) {
    return NextResponse.json(
      { error: `Removed crops/rows but could not delete the job record: ${jobDelErr.message}`, removed },
      { status: 500 },
    );
  }

  await logAudit(supabase, user.id, adminEmail, "training.delete_file", "document_jobs", jobId, {
    document_name: job?.document_name ?? null,
    crops_removed: removed.crops,
    rows_removed:  removed.rows,
  });

  return NextResponse.json({ success: true, removed });
}
