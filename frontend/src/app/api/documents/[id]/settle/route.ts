import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/documents/[id]/settle
//
// The "check again" button behind the top-up wall. The document has already
// been processed and its row count recorded; this only re-tries the charge now
// that the balance may have changed.
//
// It calls settle_job_self, which takes nothing but the job id: the row count
// comes from the job row, and ownership is checked against auth.uid() inside
// the function. There is no amount for the client to tamper with.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Cheap call, but it is a button a frustrated person will hammer.
  if (!(await rateLimit(`settle:${user.id}`, 20, 60 * 1000))) {
    return NextResponse.json(
      { error: "محاولات كثيرة. انتظر قليلاً." },
      { status: 429 },
    );
  }

  const { data, error } = await supabase.rpc("settle_job_self", { p_job_id: params.id });

  if (error) {
    console.error("[Settle]", error.message);
    return NextResponse.json({ error: "تعذر التحقق من الرصيد" }, { status: 500 });
  }

  const result = (data ?? {}) as {
    status?: string; cost_cents?: number; balance_cents?: number; shortfall_cents?: number;
  };

  if (result.status === "not_found") {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  return NextResponse.json({
    status:          result.status ?? "unknown",
    paid:            result.status === "paid",
    cost_cents:      result.cost_cents ?? null,
    balance_cents:   result.balance_cents ?? null,
    shortfall_cents: result.shortfall_cents ?? null,
  });
}
