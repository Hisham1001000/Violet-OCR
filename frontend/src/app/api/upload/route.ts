import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ACCEPTED_MIME_TYPES, MAX_FILE_SIZE_MB } from "@/lib/constants";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { pipelineHeaders } from "@/lib/pipeline";

export async function POST(req: NextRequest) {
  // ── Rate limit: 10 uploads / 10 min per IP ──────────────────
  const ip = getClientIp(req);
  if (!(await rateLimit(`upload:${ip}`, 10, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests. Please wait." }, { status: 429 });
  }

  const supabase = createClient();

  // ── Auth ─────────────────────────────────────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // ── Per-user rate limit: 5 uploads / minute ──────────────────
  if (!(await rateLimit(`upload:user:${user.id}`, 5, 60 * 1000))) {
    return NextResponse.json({ error: "Too many uploads. Please wait a minute." }, { status: 429 });
  }

  // ── Balance check ────────────────────────────────────────────
  // Only that there IS credit, not that it covers this document: the price is
  // rows × 1c and the row count does not exist until the page has been read.
  // A document that turns out to cost more than the balance is processed and
  // then held — see settle_job in migration 030.
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("balance_cents")
    .eq("user_id", user.id)
    .single();

  const balance_cents = profile?.balance_cents ?? 0;

  if (balance_cents <= 0) {
    return NextResponse.json(
      {
        error: "رصيدك لا يكفي لبدء المعالجة. أضف رصيداً للمتابعة.",
        insufficient_balance: true,
        balance_cents,
      },
      { status: 402 }
    );
  }

  // ── Parse form data ──────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "لم يتم تحديد ملف" }, { status: 400 });
  }

  // ── Validate MIME + size ─────────────────────────────────────
  // Verify MIME against allowlist (don't trust client-supplied type alone)
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: `نوع الملف غير مدعوم: ${file.type}` }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `الملف أكبر من ${MAX_FILE_SIZE_MB} ميغابايت` }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "الملف فارغ" }, { status: 400 });
  }

  // ── Per-upload page limit — removed ──────────────────────────
  // Pages per upload was a plan allowance. Under per-row pricing a ten-page
  // document just costs ten pages' worth of rows, so there is nothing to cap.

  // ── Sanitize filename (strip path traversal / special chars) ─
  const safeName = file.name.replace(/[^a-zA-Z0-9._\-\u0600-\u06FF ]/g, "_").slice(0, 200);
  const ext      = safeName.split(".").pop()?.toLowerCase() ?? "bin";

  // ── Read file bytes + compute SHA-256 for dedup ──────────────
  const fileBytes = await file.arrayBuffer();
  const hashBuf   = await crypto.subtle.digest("SHA-256", fileBytes);
  const fileHash  = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // ── Same user + same hash = re-run it ────────────────────────
  // Uploading a file you have uploaded before now RE-PROCESSES it rather than
  // showing the old result. It used to return 409 and send the user straight to
  // the original job, which meant a document processed weeks ago could never
  // benefit from a pipeline improvement — a sheet re-uploaded today came back
  // with a table produced by code from three weeks earlier, instantly and with
  // no indication anything was stale.
  //
  // The existing job is reused: same id, same URL, same stored file. Nothing is
  // uploaded twice, so this costs no extra storage — which matters, since the
  // training crops already push against the storage quota. The run is charged
  // like any other (migration 037).
  //
  // Set UPLOAD_DEDUP_ENABLED=0 to skip this and let every upload create a fresh
  // job instead.
  if (process.env.UPLOAD_DEDUP_ENABLED !== "0") {
    try {
      const { data: existing } = await supabase
        .from("document_jobs")
        .select("id, document_name, document_url, status")
        .eq("user_id", user.id)
        .eq("file_hash", fileHash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Still running: hand back the run in progress rather than starting a
      // second one. Every run is charged, so the same sheet uploaded twice in
      // quick succession would otherwise be billed twice for one result.
      if (existing && (existing.status === "pending" || existing.status === "processing")) {
        return NextResponse.json({
          job_id:        existing.id,
          success:       true,
          reprocessed:   false,
          document_name: existing.document_name,
        });
      }

      if (existing?.document_url) {
        const { data: reSigned } = await supabase.storage
          .from("documents")
          .createSignedUrl(existing.document_url, 3600);

        if (reSigned?.signedUrl && process.env.MODAL_PROCESS_DOCUMENT_URL) {
          await supabase
            .from("document_jobs")
            .update({ status: "pending", error_message: null, completed_at: null })
            .eq("id", existing.id);

          // Awaited, not fire-and-forget: Vercel kills in-flight fetches the
          // moment the handler returns, which would leave the job at 'pending'
          // forever with Modal never hearing about it.
          const ctl = new AbortController();
          const t   = setTimeout(() => ctl.abort(), 10_000);
          try {
            const res = await fetch(process.env.MODAL_PROCESS_DOCUMENT_URL, {
              method:  "POST",
              headers: pipelineHeaders(),
              body: JSON.stringify({
                job_id:       existing.id,
                document_url: reSigned.signedUrl,
                user_id:      user.id,
              }),
              signal: ctl.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await supabase
              .from("document_jobs")
              .update({ status: "failed", error_message: `Pipeline unreachable: ${reason.slice(0, 200)}` })
              .eq("id", existing.id);
            return NextResponse.json({ error: reason, job_id: existing.id }, { status: 502 });
          } finally {
            clearTimeout(t);
          }

          return NextResponse.json({
            job_id:        existing.id,
            success:       true,
            reprocessed:   true,
            document_name: existing.document_name,
          });
        }
      }
    } catch {
      // file_hash column not yet present — fall through and upload as new
      // (migration 022 pending)
    }
  }

  // ── Upload to Supabase Storage ───────────────────────────────
  const storagePath = `${user.id}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, fileBytes, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: `فشل رفع الملف: ${uploadError.message}` }, { status: 500 });
  }

  // ── Signed URL + job row in parallel (both independent of each other) ───────
  // file_hash insert is best-effort: if the column doesn't exist yet (migration
  // 022 not run), retry without it so uploads still work.
  const insertJob = async () => {
    const payload: Record<string, unknown> = {
      user_id:       user.id,
      document_name: safeName,
      status:        "pending",
      document_url:  storagePath,
      file_hash:     fileHash,
    };
    const r = await supabase.from("document_jobs").insert(payload).select("id").single();
    if (r.error && r.error.message?.includes("file_hash")) {
      delete payload.file_hash;
      return supabase.from("document_jobs").insert(payload).select("id").single();
    }
    return r;
  };
  const [signedResult, jobResult] = await Promise.all([
    supabase.storage.from("documents").createSignedUrl(storagePath, 3600),
    insertJob(),
  ]);

  const { data: signedData, error: signedError } = signedResult;
  const { data: job,        error: jobError     } = jobResult;

  if (signedError || !signedData?.signedUrl) {
    return NextResponse.json({ error: "فشل إنشاء رابط الملف" }, { status: 500 });
  }
  if (jobError || !job) {
    return NextResponse.json({ error: `فشل إنشاء المهمة: ${jobError?.message}` }, { status: 500 });
  }

  // ── Trigger OCR pipeline (fire and forget, single attempt) ────
  // No retry: a retry would start a second pipeline run for the same job,
  // which looks like a phantom "second upload" to the user.
  //
  // Failure handling (fail-loud):
  //   • Missing MODAL_PROCESS_DOCUMENT_URL → mark job failed immediately so the
  //     UI shows a real error instead of sitting at "Processing..." forever.
  //   • fetch() rejects or returns non-2xx → mark job failed with the reason.
  //   • fetch() queued OK → return to user; the Modal side drives the rest of
  //     the status lifecycle.
  const modalUrl = process.env.MODAL_PROCESS_DOCUMENT_URL;
  if (!modalUrl) {
    await supabase
      .from("document_jobs")
      .update({
        status:        "failed",
        error_message: "Pipeline trigger not configured (MODAL_PROCESS_DOCUMENT_URL missing). Contact support.",
      })
      .eq("id", job.id);
    return NextResponse.json(
      { error: "Server not configured to process documents.", job_id: job.id },
      { status: 500 },
    );
  }

  // ── Trigger pipeline AND AWAIT the spawn-ack ──────────────────────────────
  // We must AWAIT here, not fire-and-forget. Vercel serverless functions kill
  // in-flight fetches the moment the handler returns — that was leaving every
  // upload stuck at status='pending' because Modal never received the trigger.
  //
  // The Modal endpoint returns 202 Accepted in <1 second after spawning the
  // heavy work as a background Modal function, so awaiting is fast and safe.
  // We also wrap in AbortController with a 10s timeout so a slow Modal cold
  // start surfaces as 'failed' instead of forever-pending.
  const controller = new AbortController();
  const triggerTimeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const triggerRes = await fetch(modalUrl, {
      method:  "POST",
      headers: pipelineHeaders(),
      body: JSON.stringify({
        job_id:       job.id,
        document_url: signedData.signedUrl,
        user_id:      user.id,
      }),
      signal: controller.signal,
    });
    if (!triggerRes.ok) {
      const errBody = await triggerRes.text().catch(() => "");
      const detail  = `Pipeline trigger returned HTTP ${triggerRes.status}: ${errBody.slice(0, 200)}`;
      console.error("[Upload]", detail);
      await supabase
        .from("document_jobs")
        .update({ status: "failed", error_message: detail })
        .eq("id", job.id);
      return NextResponse.json({ error: detail, job_id: job.id }, { status: 502 });
    }
  } catch (err) {
    const reason = err instanceof Error
      ? (err.name === "AbortError" ? "Pipeline trigger timed out after 10s" : err.message)
      : String(err);
    console.error("[Upload] Pipeline trigger failed:", reason);
    await supabase
      .from("document_jobs")
      .update({ status: "failed", error_message: `Pipeline unreachable: ${reason.slice(0, 200)}` })
      .eq("id", job.id);
    return NextResponse.json({ error: reason, job_id: job.id }, { status: 502 });
  } finally {
    clearTimeout(triggerTimeout);
  }

  return NextResponse.json({ job_id: job.id, success: true });
}
