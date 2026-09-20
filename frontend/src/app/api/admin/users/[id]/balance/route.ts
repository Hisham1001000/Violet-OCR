import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// POST /api/admin/users/[id]/balance  { amount_cents, note? }
//
// The only way credit enters an account, until a payment provider is wired up.
// add_balance is service-role only (migration 030) precisely so this route is
// the single door: a user-callable credit function would let anyone top
// themselves up from the browser console.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();

  // The shared guard, not a hand-rolled copy: this is the highest-value
  // endpoint in the app, so it is the one that should be on the audited path
  // every other admin route uses.
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  const body = await req.json().catch(() => ({}));
  const amount = Number(body.amount_cents);

  if (!Number.isInteger(amount) || amount === 0) {
    return NextResponse.json(
      { error: "amount_cents must be a non-zero integer number of cents" },
      { status: 400 },
    );
  }
  // A fat-fingered extra zero on a manual grant is money given away, and a
  // large negative is an account wiped out. Both stay recoverable at this size.
  if (Math.abs(amount) > 100_000) {
    return NextResponse.json(
      { error: "amount_cents is limited to ±$1,000 per operation" },
      { status: 400 },
    );
  }

  const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 },
    );
  }

  const { data, error } = await admin.rpc("add_balance", {
    p_user_id:      params.id,
    p_amount_cents: amount,
    p_kind:         amount > 0 ? "topup" : "adjust",
    p_note:         note ?? `by admin ${user.email ?? user.id}`,
  });

  if (error) {
    console.error("[AdminBalance]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Every other admin mutation writes an audit row; granting money did not.
  // Without it there is no record of who credited whom, or how much.
  await logAudit(
    supabase, user.id, adminEmail,
    amount > 0 ? "user.balance_topup" : "user.balance_adjust",
    "user", params.id,
    { amount_cents: amount, note, balance_after_cents: data as number },
  );

  return NextResponse.json({ success: true, balance_cents: data as number });
}
