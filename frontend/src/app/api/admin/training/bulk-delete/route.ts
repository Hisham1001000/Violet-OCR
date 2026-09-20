import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// POST /api/admin/training/bulk-delete
// Body: { job_ids: string[] }
//
// Admin-only. Same destructive removal as delete-file, but for many files in a
// single request — deliberately server-side so a trainer on a flaky connection
// makes ONE round-trip instead of N. Each job is deleted independently and the
// per-job outcome is reported, so one failure doesn't abort the rest.
type Admin = ReturnType<typeof createAdminClient>;

async function deleteOne(admin: Admin, jobId: string): Promise<{ job_id: string; ok: boolean; crops: number; rows: number; name: string | null; error?: string }> {
  const { data: job } = await admin
    .from("document_jobs")
    .select("id, document_url, document_name")
    .eq("id", jobId)
    .single();

  let crops = 0;
  // 1) cropped images under training_crops/{job_id}/
  try {
    const { data: objs } = await admin.storage.from("training_crops").list(jobId, { limit: 1000 });
    const paths = (objs ?? []).map((o) => `${jobId}/${o.name}`);
    if (paths.length > 0) {
      await admin.storage.from("training_crops").remove(paths);
      crops = paths.length;
    }
  } catch {
    // non-fatal — DB rows are the source of truth
  }

  // 2) training_dataset rows
  const { data: delRows, error: delErr } = await admin
    .from("training_dataset")
    .delete()
    .eq("job_id", jobId)
    .select("id");
  if (delErr) {
    return { job_id: jobId, ok: false, crops, rows: 0, name: job?.document_name ?? null, error: `training rows: ${delErr.message}` };
  }

  // 4) original uploaded file
  if (job?.document_url) {
    await admin.storage.from("documents").remove([job.document_url]).catch(() => {});
  }

  // 5) the document_jobs row
  const { error: jobDelErr } = await admin.from("document_jobs").delete().eq("id", jobId);
  if (jobDelErr) {
    return { job_id: jobId, ok: false, crops, rows: delRows?.length ?? 0, name: job?.document_name ?? null, error: `job record: ${jobDelErr.message}` };
  }

  return { job_id: jobId, ok: true, crops, rows: delRows?.length ?? 0, name: job?.document_name ?? null };
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, adminEmail } = guard;

  const body = await req.json().catch(() => ({}));
  const jobIds: string[] = Array.isArray(body.job_ids)
    ? body.job_ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "Missing job_ids" }, { status: 400 });
  }
  // Guard against runaway payloads.
  if (jobIds.length > 500) {
    return NextResponse.json({ error: "Too many files in one request (max 500)" }, { status: 400 });
  }

  const admin = createAdminClient();
  const results = [];
  for (const jid of jobIds) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await deleteOne(admin, jid));
  }

  const deleted = results.filter((r) => r.ok);
  const failed  = results.filter((r) => !r.ok);

  await logAudit(supabase, user.id, adminEmail, "training.bulk_delete_files", "document_jobs", undefined, {
    requested: jobIds.length,
    deleted:   deleted.length,
    failed:    failed.length,
    crops_removed: deleted.reduce((n, r) => n + r.crops, 0),
    rows_removed:  deleted.reduce((n, r) => n + r.rows, 0),
    job_ids: jobIds,
  });

  return NextResponse.json({
    success: failed.length === 0,
    deleted: deleted.length,
    failed:  failed.length,
    results,
  });
}
