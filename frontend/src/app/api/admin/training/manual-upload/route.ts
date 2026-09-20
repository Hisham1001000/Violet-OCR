import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";
import { pipelineHeaders } from "@/lib/pipeline";

// POST /api/admin/training/manual-upload
//
// Admin-only. Uploads ONE file (PDF or image), saves the original to the
// `documents` bucket, creates a document_jobs row, and triggers the
// `train_only` pipeline mode on Modal/local-server. The pipeline runs
// Azure Layout (only) and crops every name cell into training_dataset rows.
//
// Multipart body:
//   file:        binary (PDF / JPG / PNG)
//   batch_name?: text (defaults to filename)
//   field_name?: text (defaults to "manual_upload")
//
// The frontend posts files one at a time so it can show per-file progress.
//
// Why train_only and not full OCR? Manual uploads exist precisely to skip
// OCR cost. Azure Layout (~$0.001/page) is enough to detect tables + cell
// polygons, which is all the cropper needs.
const ACCEPTED_TYPES = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg",
  "image/png", "image/webp",
]);
const MAX_BYTES = 25 * 1024 * 1024;   // 25 MB hard cap per file

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;
  const { user, adminEmail } = guard;

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Could not parse multipart body: ${e instanceof Error ? e.message : e}` },
      { status: 400 },
    );
  }

  const file       = form.get("file");
  const batchName  = (form.get("batch_name") ?? "").toString().trim();
  const fieldName  = (form.get("field_name") ?? "").toString().trim() || "manual_upload";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  // .pdf often arrives with empty MIME type from drag-and-drop; fall back to extension.
  const guessedType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
  if (!ACCEPTED_TYPES.has(guessedType)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${guessedType || "(none)"}` },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB > ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 413 },
    );
  }

  // ── Persist to storage and DB ──────────────────────────────────────────
  const admin = createAdminClient();
  const bytes = Buffer.from(await file.arrayBuffer());
  // Mirror the regular upload-route convention: {user_id}/{timestamp}.{ext}
  const ext  = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
  const path = `${user.id}/manual_${Date.now()}.${ext}`;

  const { error: upErr } = await admin.storage
    .from("documents")
    .upload(path, bytes, { contentType: guessedType, upsert: false });
  if (upErr) {
    return NextResponse.json({ error: `Storage upload failed: ${upErr.message}` }, { status: 500 });
  }

  const { data: job, error: jobErr } = await admin
    .from("document_jobs")
    .insert({
      user_id:       user.id,
      document_name: batchName || file.name,
      status:        "pending",
      document_url:  path,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    // Best-effort cleanup of the just-uploaded file so storage doesn't leak.
    await admin.storage.from("documents").remove([path]).catch(() => {});
    return NextResponse.json({ error: `DB insert failed: ${jobErr?.message}` }, { status: 500 });
  }

  // Signed URL — the pipeline downloads the file via a public URL.
  const { data: signedData, error: signedErr } = await admin.storage
    .from("documents")
    .createSignedUrl(path, 3600);
  if (signedErr || !signedData?.signedUrl) {
    return NextResponse.json(
      { error: `Could not sign URL: ${signedErr?.message}`, job_id: job.id },
      { status: 500 },
    );
  }

  // ── Trigger train_only pipeline ───────────────────────────────────────
  // Same routing as the regular upload trigger — Modal in prod, local in dev.
  const proc    = process.env.MODAL_PROCESS_DOCUMENT_URL ?? "http://localhost:8001";
  const isModal = proc.includes("modal.run");
  const target  = isModal ? proc : `${proc}/train-only`;
  const payload = isModal
    ? { mode: "train_only", job_id: job.id, document_url: signedData.signedUrl, user_id: user.id }
    : { job_id: job.id, document_url: signedData.signedUrl, user_id: user.id };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10_000);
  try {
    const triggerRes = await fetch(target, {
      method: "POST",
      headers: pipelineHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!triggerRes.ok) {
      const txt = await triggerRes.text().catch(() => "");
      const detail = `Pipeline trigger HTTP ${triggerRes.status}: ${txt.slice(0, 200)}`;
      await admin.from("document_jobs")
        .update({ status: "failed", error_message: detail })
        .eq("id", job.id);
      return NextResponse.json({ error: detail, job_id: job.id }, { status: 502 });
    }
  } catch (e) {
    const reason = e instanceof Error
      ? (e.name === "AbortError" ? "Pipeline trigger timed out after 10s" : e.message)
      : String(e);
    await admin.from("document_jobs")
      .update({ status: "failed", error_message: `Pipeline unreachable: ${reason}` })
      .eq("id", job.id);
    return NextResponse.json({ error: reason, job_id: job.id }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  await logAudit(supabase, user.id, adminEmail, "training.manual_upload", "document_jobs", job.id, {
    file_name:  file.name,
    file_bytes: file.size,
    field_name: fieldName,
    batch_name: batchName || null,
  });

  return NextResponse.json({
    success: true,
    job_id:  job.id,
    status:  "queued",
  });
}
