import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACCEPTED_MIME_TYPES, MAX_FILE_SIZE_MB } from "@/lib/constants";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { pipelineHeaders } from "@/lib/pipeline";
import {
  GUEST_CLAIM_TTL_MS, GUEST_DAILY_LIMIT, GUEST_MAX_PAGES, GUEST_PER_IP_PER_DAY,
  countPdfPages, getGuestUserId, hashIp, newClaimToken, sha256Hex,
} from "@/lib/guest";

// Upload from the landing page, with no account (migration 042).
//
// The file is processed straight away under the guest account, and the visitor
// gets back a claim token. Nothing is shown to them from here but progress:
// the rows are only ever served to the account that claims the job.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!(await rateLimit(`guest-upload:${ip}`, 3, 60 * 60 * 1000))) {
    return NextResponse.json({ error: "محاولات كثيرة. أنشئ حساباً مجانياً للمتابعة.", code: "rate" }, { status: 429 });
  }

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
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "نوع الملف غير مدعوم. ارفع صورة أو ملف PDF." }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `الملف أكبر من ${MAX_FILE_SIZE_MB} ميغابايت` }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "الملف فارغ" }, { status: 400 });
  }

  const fileBytes = await file.arrayBuffer();

  if (file.type === "application/pdf") {
    const pages = countPdfPages(fileBytes);
    if (pages !== null && pages > GUEST_MAX_PAGES) {
      return NextResponse.json(
        { error: `الملف فيه ${pages} صفحات. جرّب ملفاً حتى ${GUEST_MAX_PAGES} صفحات، أو أنشئ حساباً لرفع الملف كاملاً.`, code: "pages" },
        { status: 400 },
      );
    }
  }

  let admin;
  let guestId: string;
  try {
    admin   = createAdminClient();
    guestId = await getGuestUserId(admin);
  } catch (err) {
    console.error("[GuestUpload] setup:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "تعذر بدء المعالجة الآن. حاول بعد قليل." }, { status: 500 });
  }

  // ── Spend caps: per visitor and for everyone ─────────────────────────────
  const since  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ipHash = await hashIp(ip);

  const [{ count: mine }, { count: all }] = await Promise.all([
    admin.from("document_jobs").select("id", { count: "exact", head: true })
      .eq("guest_ip_hash", ipHash).gte("created_at", since),
    admin.from("document_jobs").select("id", { count: "exact", head: true })
      .not("guest_ip_hash", "is", null).gte("created_at", since),
  ]);

  if ((mine ?? 0) >= GUEST_PER_IP_PER_DAY || (all ?? 0) >= GUEST_DAILY_LIMIT) {
    return NextResponse.json(
      { error: "أنشئ حساباً مجانياً لرفع كشفك — أول كشف مجاني بالكامل.", code: "signup" },
      { status: 429 },
    );
  }

  // ── Store the file and create the job ─────────────────────────────────────
  const safeName    = file.name.replace(/[^a-zA-Z0-9._\-؀-ۿ ]/g, "_").slice(0, 200);
  const ext         = safeName.split(".").pop()?.toLowerCase() ?? "bin";
  const storagePath = `${guestId}/${Date.now()}-${newClaimToken().slice(0, 8)}.${ext}`;

  const { error: uploadError } = await admin.storage
    .from("documents")
    .upload(storagePath, fileBytes, { contentType: file.type, upsert: false });
  if (uploadError) {
    console.error("[GuestUpload] storage:", uploadError.message);
    return NextResponse.json({ error: "فشل رفع الملف. حاول مرة أخرى." }, { status: 500 });
  }

  const token = newClaimToken();
  const { data: job, error: jobError } = await admin
    .from("document_jobs")
    .insert({
      user_id:          guestId,
      document_name:    safeName,
      status:           "pending",
      document_url:     storagePath,
      file_hash:        await sha256Hex(fileBytes),
      guest_claim_hash: await sha256Hex(token),
      guest_ip_hash:    ipHash,
      guest_expires_at: new Date(Date.now() + GUEST_CLAIM_TTL_MS).toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    console.error("[GuestUpload] job:", jobError?.message);
    await admin.storage.from("documents").remove([storagePath]);
    return NextResponse.json({ error: "تعذر بدء المعالجة. حاول مرة أخرى." }, { status: 500 });
  }

  // ── Start the pipeline (awaited: Vercel kills fetches once we return) ────
  const fail = async (reason: string) => {
    console.error("[GuestUpload] pipeline:", reason);
    await admin.from("document_jobs")
      .update({ status: "failed", error_message: `Pipeline unreachable: ${reason.slice(0, 200)}` })
      .eq("id", job.id);
    return NextResponse.json({ error: "تعذر بدء المعالجة. حاول مرة أخرى." }, { status: 502 });
  };

  const modalUrl = process.env.MODAL_PROCESS_DOCUMENT_URL;
  const { data: signed } = await admin.storage.from("documents").createSignedUrl(storagePath, 3600);
  if (!modalUrl || !signed?.signedUrl) {
    return fail(!modalUrl ? "MODAL_PROCESS_DOCUMENT_URL missing" : "signed URL failed");
  }

  const ctl = new AbortController();
  const t   = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(modalUrl, {
      method:  "POST",
      headers: pipelineHeaders(),
      body:    JSON.stringify({ job_id: job.id, document_url: signed.signedUrl, user_id: guestId }),
      signal:  ctl.signal,
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
  } catch (err) {
    return fail(err instanceof Error ? (err.name === "AbortError" ? "timed out after 10s" : err.message) : String(err));
  } finally {
    clearTimeout(t);
  }

  return NextResponse.json(
    { job_id: job.id, token, expires_in_ms: GUEST_CLAIM_TTL_MS },
    { headers: { "Cache-Control": "no-store" } },
  );
}
