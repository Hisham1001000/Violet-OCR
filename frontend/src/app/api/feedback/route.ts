import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { sendMail } from "@/lib/mail";

// Where feedback is delivered: the Violet inbox, overridable with
// FEEDBACK_EMAIL_TO. The feedback itself is in the database either way, so a
// misconfigured address loses a notification, not the rating.
const FEEDBACK_TO = process.env.FEEDBACK_EMAIL_TO || "violetocr4@gmail.com";

/** Escape for interpolation into the notification HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function POST(req: NextRequest) {
  // Per connection: wide, only to stop a flood.
  if (!(await rateLimit(`feedback:ip:${getClientIp(req)}`, 30, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Per ACCOUNT: mobile networks here put many customers behind one address, so
  // an IP-only limit let strangers use up each other's allowance.
  if (!(await rateLimit(`feedback:user:${user.id}`, 10, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const body    = await req.json().catch(() => ({}));
  const rating  = Number(body.rating);
  const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";
  const jobId   = typeof body.job_id === "string" ? body.job_id : null;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "التقييم مطلوب" }, { status: 400 });
  }

  // Only a job the caller owns. Without this, a job id from someone else's
  // account would be stamped on this feedback row.
  let jobName: string | null = null;
  let jobRows: number | null = null;
  if (jobId) {
    const { data: job } = await supabase
      .from("document_jobs")
      .select("id, document_name, row_count")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .single();
    if (!job) {
      return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
    }
    jobName = job.document_name;
    jobRows = job.row_count;
  }

  // Storing comes first and email second, on purpose. The database is the
  // record; the email is a notification. A mail outage must not throw away
  // something a customer took the trouble to write.
  //
  // Insert, and treat a second rating for the same document as an edit.
  //
  // This deliberately does NOT use upsert/onConflict. feedback_one_per_job is a
  // PARTIAL unique index (WHERE job_id IS NOT NULL), and Postgres will only
  // infer a partial index when the statement repeats its predicate — which
  // PostgREST's upsert cannot send. It failed every submission with
  // "no unique or exclusion constraint matching the ON CONFLICT
  // specification". Catching 23505 keeps the constraint doing its job and is
  // race-safe: whoever loses the insert falls through to the update.
  let saved: { id: string } | null = null;

  const inserted = await supabase
    .from("feedback")
    .insert({ user_id: user.id, job_id: jobId, rating, comment: comment || null })
    .select("id")
    .single();

  if (!inserted.error) {
    saved = inserted.data;
  } else if (inserted.error.code === "23505" && jobId) {
    const updated = await supabase
      .from("feedback")
      .update({ rating, comment: comment || null, emailed_at: null, email_error: null })
      .eq("job_id", jobId)
      .eq("user_id", user.id)
      .select("id")
      .single();

    if (updated.error) {
      console.error("[Feedback] update failed:", updated.error.message);
      return NextResponse.json({ error: "تعذر حفظ التقييم" }, { status: 500 });
    }
    saved = updated.data;
  } else {
    console.error("[Feedback] save failed:", inserted.error.message);
    return NextResponse.json({ error: "تعذر حفظ التقييم" }, { status: 500 });
  }

  if (!saved) {
    return NextResponse.json({ error: "تعذر حفظ التقييم" }, { status: 500 });
  }

  // ── Notify ────────────────────────────────────────────────────────────────
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#7c3aed;margin-bottom:4px">تقييم جديد — Violet OCR</h2>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0"/>
      <p style="font-size:22px;letter-spacing:2px;color:#f59e0b;margin:6px 0">${stars}</p>
      <p style="margin:4px 0"><strong>Rating:</strong> ${rating} / 5</p>
      <p style="margin:4px 0"><strong>From:</strong> ${esc(user.email ?? "—")}</p>
      <p style="margin:4px 0"><strong>User ID:</strong> ${esc(user.id)}</p>
      ${jobName ? `<p style="margin:4px 0"><strong>Document:</strong> ${esc(jobName)}${jobRows != null ? ` (${jobRows} rows)` : ""}</p>` : ""}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0"/>
      ${comment
        ? `<p style="white-space:pre-wrap;color:#374151;line-height:1.7">${esc(comment)}</p>`
        : `<p style="color:#94a3b8">(لا يوجد تعليق)</p>`}
    </div>
  `;

  // Awaited, not fire-and-forget.
  //
  // It used to be sent after the response, to save the person ~6 seconds of
  // "Sending…". That works on a long-lived server and fails on this one: the
  // serverless instance is frozen the moment the response is returned, so on
  // 2026-09-11 a real rating was stored with email_error "Timeout" and never
  // arrived. A few seconds of waiting is the price of the notification
  // actually being sent. The row is committed before this, so a failure still
  // only costs the notification -- and `emailed_at IS NULL` marks exactly
  // which rows to re-send.
  const feedbackId = saved.id;
  try {
    await sendMail({
      to:           FEEDBACK_TO,
      replyTo:      user.email ?? undefined,
      subject:      `[Violet] تقييم ${rating}/5${jobName ? ` — ${jobName}` : ""}`,
      html,
      fallbackName: "Violet Feedback",
    });
    await supabase.from("feedback")
      .update({ emailed_at: new Date().toISOString(), email_error: null })
      .eq("id", feedbackId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "send failed";
    console.error("[Feedback] email failed:", msg);
    await supabase.from("feedback")
      .update({ email_error: msg.slice(0, 300) })
      .eq("id", feedbackId);
  }

  return NextResponse.json({ success: true });
}
