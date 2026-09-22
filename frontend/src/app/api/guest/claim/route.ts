import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/guest";

// Move a landing-page upload into the signed-in account (migration 042).
// claim_guest_job checks the token, moves the job and prices it for this
// account in one transaction, so a retry can never charge twice.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (!(await rateLimit(`guest-claim:${ip}`, 20, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  let body: { job_id?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  const jobId = body.job_id ?? "";
  const token = body.token ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ result: "invalid" }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { data, error } = await admin.rpc("claim_guest_job", {
    p_job_id:     jobId,
    p_claim_hash: await sha256Hex(token),
    p_user_id:    user.id,
  });

  if (error) {
    console.error("[GuestClaim]", error.message);
    return NextResponse.json({ error: "تعذر نقل الملف إلى حسابك" }, { status: 500 });
  }

  const result = (data as { result?: string } | null)?.result ?? "invalid";
  return NextResponse.json(
    { result, job_id: jobId },
    { status: result === "claimed" ? 200 : 410, headers: { "Cache-Control": "no-store" } },
  );
}
