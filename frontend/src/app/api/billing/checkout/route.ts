import { NextResponse } from "next/server";

// Billing not yet configured — payment provider pending.
// Returns a clear error instead of a silent 404.
export async function POST() {
  return NextResponse.json(
    { error: "الدفع غير متاح حالياً. سيتم تفعيله قريباً." },
    { status: 503 }
  );
}
