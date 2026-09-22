import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Fetch job to get the storage path
  const { data: job, error: fetchError } = await supabase
    .from("document_jobs")
    .select("id, document_url")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !job) {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  // Delete file from Supabase Storage (ignore errors — file may already be gone).
  // Service role, because a landing-page upload (migration 042) keeps its file
  // in the guest folder after it is claimed. Ownership was checked above.
  if (job.document_url) {
    await createAdminClient().storage.from("documents").remove([job.document_url]).catch(() => {});
  }

  // Delete DB row (cascades to document_pages, field_corrections)
  const { error: deleteError } = await supabase
    .from("document_jobs")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Service role, because migration 032 revokes SELECT on the extracted-content
  // columns from `authenticated` — otherwise the browser could read them
  // directly with the anon key and skip the top-up wall entirely.
  //
  // That bypasses RLS, so the .eq("user_id") below IS the ownership check now,
  // not a convenience filter. It must stay.
  let reader;
  try {
    reader = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { data, error } = await reader
    .from("document_jobs")
    .select("id, user_id, document_name, status, document_url, fields_json, structured_data, column_order, error_message, created_at, completed_at, row_count, cost_cents, payment_status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  // ── Withhold the extraction until it is paid for ──────────────────────────
  // The row count is only knowable after OCR, so a document can finish and turn
  // out to cost more than the balance. The work is kept — the customer paid for
  // it with our Azure and GPU time and will want it the moment they top up —
  // but the rows themselves are stripped from the response rather than merely
  // hidden by the page. A paywall enforced only in the client is not a paywall:
  // the data is one devtools tab away.
  if (data.payment_status === "unpaid") {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("balance_cents")
      .eq("user_id", user.id)
      .single();

    const balance = profile?.balance_cents ?? 0;
    const cost    = data.cost_cents ?? 0;

    return NextResponse.json(
      {
        ...data,
        structured_data: null,
        full_text:       null,
        fields_json:     null,
        column_order:    null,
        locked:          true,
        balance_cents:   balance,
        shortfall_cents: Math.max(0, cost - balance),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // ── Was it charged by THIS run? ───────────────────────────────────────────
  // The document page announces "Charged $X" once per charge. Every run is
  // charged (migration 037), so one document can have several charges; only
  // the newest can belong to the run that just finished, and only if the ledger
  // wrote it as that run finished — settle_job runs seconds before the flip to
  // 'completed' — and recently. Without this, opening a document charged weeks
  // ago announced that old charge as if it had just been taken.
  let just_charged = false;
  let charged_at: string | null = null;
  if (data.payment_status === "paid" && (data.cost_cents ?? 0) > 0 && data.completed_at) {
    const { data: charge } = await reader
      .from("billing_transactions")
      .select("created_at")
      .eq("job_id", data.id)
      .eq("kind", "charge")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (charge?.created_at) {
      charged_at        = charge.created_at;
      const chargedAt   = Date.parse(charge.created_at);
      const completedAt = Date.parse(data.completed_at);
      just_charged = Math.abs(completedAt - chargedAt) < 5 * 60_000
                  && Date.now() - chargedAt < 30 * 60_000;
    }
  }

  return NextResponse.json({ ...data, just_charged, charged_at }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  const body = await req.json();
  const { structured_data, column_order: bodyColumnOrder } = body;

  if (!Array.isArray(structured_data)) {
    return NextResponse.json({ error: "structured_data must be an array" }, { status: 400 });
  }

  // Strip _-prefixed internal metadata keys (e.g. _suggestions) before persisting
  const cleanData = structured_data.map((row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("_")))
  );

  // Build the update payload.
  // IMPORTANT: never regenerate column_order from Object.keys(row) — PostgreSQL JSONB
  // stores dict keys in alphabetical order, so Object.keys() would scramble the display.
  // Instead: use the explicit order sent by the frontend (e.g. after drag-and-drop),
  // or omit the field entirely so the DB keeps its existing correct value.
  const updatePayload: Record<string, unknown> = { structured_data: cleanData };
  if (Array.isArray(bodyColumnOrder) && bodyColumnOrder.length > 0) {
    updatePayload.column_order = bodyColumnOrder;
  }

  const { error } = await supabase
    .from("document_jobs")
    .update(updatePayload)
    .eq("id", params.id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
