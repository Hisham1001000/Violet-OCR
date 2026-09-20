import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { sendMail } from "@/lib/mail";

const ADMIN_EMAIL = process.env.SUPPORT_EMAIL_TO || "violetocr4@gmail.com";

export async function POST(req: NextRequest) {
  // A wide per-connection guard against a flood, before we do any work.
  if (!(await rateLimit(`support:ip:${getClientIp(req)}`, 20, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many requests. Please wait." }, { status: 429 });
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The real limit is per ACCOUNT, not per IP. Mobile networks here put many
  // customers behind one address, so an IP-only limit let strangers use up each
  // other's allowance -- and you have to be signed in to reach this anyway.
  if (!(await rateLimit(`support:user:${user.id}`, 5, 10 * 60 * 1000))) {
    return NextResponse.json({ error: "Too many messages. Please wait a few minutes." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const subject = (body.subject ?? "").trim().slice(0, 200);
  const message = (body.message ?? "").trim().slice(0, 5000);

  if (!subject || !message) {
    return NextResponse.json({ error: "Subject and message are required." }, { status: 400 });
  }

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#7c3aed;margin-bottom:4px">Support Message — Violet OCR</h2>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0"/>
      <p><strong>From:</strong> ${user.email}</p>
      <p><strong>User ID:</strong> ${user.id}</p>
      <p><strong>Subject:</strong> ${subject}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0"/>
      <p style="white-space:pre-wrap;color:#374151">${message}</p>
    </div>
  `;

  try {
    await sendMail({
      to:           ADMIN_EMAIL,
      replyTo:      user.email,
      subject:      `[Violet Support] ${subject}`,
      html,
      fallbackName: "Violet Support",
    });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Send failed";
    console.error("[Support] Email send failed:", msg);
    return NextResponse.json({ error: "Failed to send message. Please try WhatsApp." }, { status: 500 });
  }
}
