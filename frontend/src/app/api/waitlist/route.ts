import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // 5 attempts per IP per 10 minutes
  if (!(await rateLimit(`waitlist:${getClientIp(req)}`, 5, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name  = (body.name ?? "").trim() || null;
  const email = (body.email ?? user.email ?? "").trim();

  if (!email) {
    return NextResponse.json({ error: "البريد الإلكتروني مطلوب" }, { status: 400 });
  }

  // ── Spam prevention: check if this email is already registered ──────────
  const { data: existingByEmail } = await supabase
    .from("waitlist")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existingByEmail) {
    return NextResponse.json(
      { error: "اسمك موجود مسبقاً في قائمة الانتظار ولا يمكن إضافتك مرة أخرى.", already_joined: true },
      { status: 409 }
    );
  }

  // Insert (first time for this email)
  const { error: insertError } = await supabase
    .from("waitlist")
    .insert({ user_id: user.id, email, name });

  if (insertError) {
    // Handle duplicate key race condition gracefully
    if (insertError.message.toLowerCase().includes("duplicate") ||
        insertError.message.toLowerCase().includes("unique")) {
      return NextResponse.json(
        { error: "اسمك موجود مسبقاً في قائمة الانتظار ولا يمكن إضافتك مرة أخرى.", already_joined: true },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
