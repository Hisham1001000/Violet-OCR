import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/cron/reconcile-jobs
//
// Watchdog for stuck jobs. The Modal pipeline can crash or time out (900 s cap)
// after it has set status='processing', with nothing left to flip the row back.
// Those jobs would otherwise show a permanent "Processing…" spinner. This route
// fails any job left in pending/processing well past the worst-case runtime.
//
// Invoked by Vercel Cron (see frontend/vercel.json). The request must carry
// `Authorization: Bearer <CRON_SECRET>`, which Vercel Cron sends automatically.
//
// Fails CLOSED: without CRON_SECRET this answers 503 rather than running. It
// used to gate only when the secret happened to be set, which meant a deploy
// that forgot the variable left a public endpoint that mass-fails jobs.

// A legitimate job can run up to Modal's 900 s timeout; use a generous cutoff so
// we never fail an in-flight job.
const STALE_AFTER_MS = 20 * 60 * 1000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Cron not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Service role not configured" }, { status: 500 });
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await admin
    .from("document_jobs")
    .update({
      status: "failed",
      error_message: "Processing timed out and was reset by the system. Please reprocess.",
    })
    .in("status", ["pending", "processing"])
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, recovered: data?.length ?? 0 });
}
