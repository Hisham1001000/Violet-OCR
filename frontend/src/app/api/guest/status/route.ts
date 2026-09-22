import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/guest";

// Progress of a landing-page upload, for the visitor holding its claim token.
// Status and row count only -- never the rows: those belong to whoever claims it.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (!(await rateLimit(`guest-status:${ip}`, 120, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const jobId = req.nextUrl.searchParams.get("job") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ state: "gone" }, { status: 404 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { data: job } = await admin
    .from("document_jobs")
    .select("status, row_count, guest_expires_at")
    .eq("id", jobId)
    .eq("guest_claim_hash", await sha256Hex(token))
    .maybeSingle();

  if (!job || (job.guest_expires_at && Date.parse(job.guest_expires_at) < Date.now())) {
    return NextResponse.json({ state: "gone" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { state: job.status, rows: job.status === "completed" ? job.row_count ?? null : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
