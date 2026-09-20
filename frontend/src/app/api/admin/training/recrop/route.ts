import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin } from "@/lib/admin";
import { pipelineHeaders } from "@/lib/pipeline";

// POST /api/admin/training/recrop
// Body: { job_id: "uuid" }
//
// Smart re-crop:
//   • If the job already has cell_polygons → use mode="recrop_only" (just runs
//     the cropper using the existing polygons — fast, no Azure spend).
//   • If polygons are missing (job was processed before Azure Layout was wired
//     in, or via the Gemini-only path) → use mode="train_only" which RE-RUNS
//     Azure Layout to regenerate polygons + crops in one shot.
//
// Both modes are multiplexed onto Modal's process-document endpoint to stay
// under the free-tier 8-endpoint cap. Local dev hits dedicated sub-routes.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const result = await assertTrainerOrAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const body  = await req.json().catch(() => ({}));
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!jobId) {
    return NextResponse.json({ error: "Missing job_id" }, { status: 400 });
  }

  // ── Inspect the job to decide which pipeline mode to invoke ──────────────
  const admin = createAdminClient();
  const { data: job, error: jobErr } = await admin
    .from("document_jobs")
    .select("id, document_url, cell_polygons, user_id, status")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  if (!job.document_url) {
    return NextResponse.json(
      { success: false, created: 0, reason: "The original file is no longer available in storage." },
      { status: 200 },
    );
  }

  // ── Force regeneration ────────────────────────────────────────────────────
  // Normal re-crop only ADDS missing crops, so a file cropped before a logic
  // change keeps its stale rows forever ("all N already exist — nothing new").
  // force=true clears the un-reviewed (pending) rows first so the cropper
  // recreates them with the current filtering/detection. Verified + approved
  // rows are preserved — that's reviewed training data we must never lose.
  const force = body.force === true;
  let clearedPending = 0;
  if (force) {
    const { data: del, error: delErr } = await admin
      .from("training_dataset")
      .delete()
      .eq("job_id", jobId)
      .eq("status", "pending")
      .select("id");
    if (delErr) {
      return NextResponse.json(
        { error: `Could not clear existing crops: ${delErr.message}` },
        { status: 500 },
      );
    }
    clearedPending = del?.length ?? 0;
  }

  const cellPolygons = job.cell_polygons;
  const hasPolygons  =
    Array.isArray(cellPolygons)
      ? cellPolygons.length > 0
      : !!(cellPolygons && typeof cellPolygons === "object"
           && Object.keys(cellPolygons).length > 0);

  // Regenerate (force) does a TRUE full re-crop: it re-runs Azure Layout from
  // the original document (train_only) instead of reusing the stored polygons.
  // That re-derives the table grid AND captures fresh page-angle data, so a
  // stale/incorrect polygon set or a missed upside-down page is fixed from
  // scratch — exactly what the user expects "Regenerate" to do.
  const useTrainOnly = !hasPolygons || force;

  // train_only needs a signed URL for the original file; recrop_only doesn't.
  let signedUrl: string | null = null;
  if (useTrainOnly) {
    const { data: signed, error: signErr } = await admin.storage
      .from("documents")
      .createSignedUrl(job.document_url, 3600);
    if (signErr || !signed?.signedUrl) {
      return NextResponse.json(
        { success: false, created: 0, reason: `Could not access the original file: ${signErr?.message}` },
        { status: 200 },
      );
    }
    signedUrl = signed.signedUrl;
  }

  // ── Pipeline routing ─────────────────────────────────────────────────────
  const proc    = process.env.MODAL_PROCESS_DOCUMENT_URL ?? "http://localhost:8001";
  const isModal = proc.includes("modal.run");
  const mode    = useTrainOnly ? "train_only" : "recrop_only";

  let target: string;
  let payload: Record<string, unknown>;
  if (isModal) {
    target  = proc;
    payload = useTrainOnly
      ? { mode, job_id: jobId, document_url: signedUrl, user_id: job.user_id }
      : { mode, job_id: jobId };
  } else {
    target  = useTrainOnly ? `${proc}/train-only` : `${proc}/recrop-job`;
    payload = useTrainOnly
      ? { job_id: jobId, document_url: signedUrl, user_id: job.user_id }
      : { job_id: jobId };
  }

  try {
    const res  = await fetch(target, {
      method:  "POST",
      headers: pipelineHeaders(),
      body:    JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { error?: string }).error ?? `Re-crop failed (HTTP ${res.status})` },
        { status: 500 },
      );
    }

    // For train_only the pipeline runs async; we return success=queued so the
    // UI can re-fetch the job page for crops as they appear.
    if (mode === "train_only") {
      return NextResponse.json({
        success: true,
        queued:  true,
        mode:    "train_only",
        cleared: clearedPending,
        message: "Re-running Azure Layout to regenerate polygons. New crops will appear in 10-30 s.",
      });
    }

    // recrop_only: synchronous response with crop stats.
    type CropStats = {
      success?: boolean; created?: number; error?: string;
      skipped_existing?: number; skipped_no_polygon?: number; errors?: number;
      error_samples?: string[];
      diag?: string[];
    };
    const stats = data as CropStats;
    const created = stats.created ?? 0;
    if (created === 0) {
      const skippedExisting = stats.skipped_existing ?? 0;
      let reason = stats.error ?? "Cropper found nothing to crop.";
      if (reason === "not_completed") {
        reason = "Pipeline didn't complete for this document — check its error message in /admin/documents.";
      } else if (reason === "job_not_found") {
        reason = "Job not found.";
      } else if (reason === "all_cells_empty") {
        reason =
          "A name column was found, but every cell in it was empty or contained " +
          "only noise (single characters, digits, or dashes) — so there were no " +
          "real names to crop. This usually means the name column on this page is " +
          "mostly blank, or the wrong column was matched as the name column.";
      } else if (reason === "no_name_columns_detected") {
        reason =
          "No name columns detected in this document. Azure Layout extracted " +
          "the table, but no column header looked like a name AND no column's " +
          "values were Arabic-heavy enough to auto-detect. " +
          "If this document genuinely has names, the table structure may be too " +
          "irregular for automatic detection — consider re-uploading with a " +
          "clearer scan or splitting the page.";
      } else if (reason === "rotation_mismatch") {
        const diagLine = stats.diag?.[0] ?? "";
        reason =
          "Every name cell was rejected as out-of-page even after trying all " +
          "four rotations. The polygon coordinates from Azure Layout don't " +
          "fit the rendered page in any orientation — most likely a unit or " +
          "scale mismatch (e.g. Azure returned mm/cm instead of inches, or " +
          "the page was rendered at the wrong DPI). " +
          (diagLine ? `Diagnostic: ${diagLine}` : "");
      } else if (skippedExisting > 0) {
        reason = `All ${skippedExisting} crops already exist — nothing new to add.`;
      } else if ((stats.errors ?? 0) > 0) {
        const samples = stats.error_samples ?? [];
        reason = samples.length > 0
          ? `${stats.errors} crop(s) failed. First: ${samples[0]}`
          : `${stats.errors} crop(s) failed — see server logs.`;
      }
      return NextResponse.json(
        { success: false, created: 0, cleared: clearedPending, reason, stats },
        { status: 200 },
      );
    }
    return NextResponse.json({ success: true, created, cleared: clearedPending, stats });
  } catch (e) {
    return NextResponse.json(
      { error: `Re-crop request failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503 },
    );
  }
}
