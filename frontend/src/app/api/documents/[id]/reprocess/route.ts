import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pipelineHeaders } from "@/lib/pipeline";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // A reprocess costs exactly what an upload costs -- an Azure Layout page, an
  // Azure Read page, Gemini calls on any cell that fails validation, and GPU
  // time for the name model. It had no rate limit and did not touch the
  // monthly quota, so a user clicking it because the page felt slow spent real
  // money each time, and nothing capped it.
  const ip = getClientIp(req);
  if (!(await rateLimit(`reprocess:${ip}`, 10, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests. Please wait." }, { status: 429 });
  }

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Fetch stored document URL
  const { data: job, error: jobError } = await supabase
    .from("document_jobs")
    .select("id, document_url, status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  if (!job.document_url) {
    return NextResponse.json({ error: "ملف المستند غير متوفر لإعادة المعالجة" }, { status: 400 });
  }

  // Per-user limit, tighter than upload's 5/min. Reprocessing is for "that came
  // out wrong, try again", not a loop -- three in ten minutes covers the honest
  // case without letting an impatient click drain a free-tier Azure quota.
  if (!(await rateLimit(`reprocess:user:${user.id}`, 3, 10 * 60 * 1000))) {
    return NextResponse.json(
      { error: "لقد أعدت المعالجة عدة مرات. الرجاء الانتظار قليلاً." },
      { status: 429 },
    );
  }

  // A reprocess is a full run and is charged like one (migration 037): the
  // customer pays again for the rows it extracts. It needs credit to start for
  // the same reason an upload does, and the rate limits above stop an impatient
  // click from turning into a string of charges.
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("balance_cents")
    .eq("user_id", user.id)
    .single();

  if ((profile?.balance_cents ?? 0) <= 0) {
    return NextResponse.json(
      { error: "رصيدك لا يكفي لإعادة المعالجة. أضف رصيداً للمتابعة.", insufficient_balance: true },
      { status: 402 },
    );
  }

  if (job.status === "processing" || job.status === "pending") {
    return NextResponse.json({ error: "المستند قيد المعالجة بالفعل" }, { status: 400 });
  }

  // Get a signed URL for the stored file. Signed with the service role: a
  // document uploaded from the landing page (migration 042) keeps its file in
  // the guest account's folder after it is claimed, which the customer's own
  // storage policy may not reach. Ownership was checked above.
  const { data: signedData, error: signedErr } = await createAdminClient().storage
    .from("documents")
    .createSignedUrl(job.document_url, 3600);

  if (signedErr || !signedData?.signedUrl) {
    return NextResponse.json({ error: "تعذر الوصول إلى ملف المستند" }, { status: 500 });
  }

  // Reset job status to pending. Scope by user_id too (defense-in-depth on top
  // of RLS) so a job can only ever be reset by its owner.
  await supabase
    .from("document_jobs")
    .update({ status: "pending", error_message: null, structured_data: null })
    .eq("id", params.id)
    .eq("user_id", user.id);

  // Trigger pipeline. MUST await — Vercel kills fire-and-forget fetches.
  // Modal returns 202 in <1s after spawning the heavy work, so this is fast.
  const pythonUrl = process.env.MODAL_PROCESS_DOCUMENT_URL ?? "http://localhost:8001";
  const target    = pythonUrl.includes("modal.run") ? pythonUrl : `${pythonUrl}/process`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(target, {
      method: "POST",
      headers: pipelineHeaders(),
      body: JSON.stringify({
        job_id: job.id,
        document_url: signedData.signedUrl,
        user_id: user.id,
      }),
      signal: controller.signal,
    });
  } catch {
    // Pipeline trigger failed — surface so user can retry. Status was already
    // reset to pending above; mark it failed so the UI doesn't sit on pending.
    await supabase
      .from("document_jobs")
      .update({ status: "failed", error_message: "Pipeline unreachable" })
      .eq("id", params.id);
    return NextResponse.json({ error: "Pipeline trigger failed" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  return NextResponse.json({ success: true });
}
