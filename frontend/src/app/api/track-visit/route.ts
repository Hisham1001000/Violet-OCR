import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST /api/track-visit  { login?: boolean }
// Bumps the current user's last_active_at (and login_count if login=true).
// Silently no-ops when unauthenticated — safe to call from any page.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 200 });

  const body = await req.json().catch(() => ({}));
  const isLogin = body.login === true;

  await supabase.rpc("track_user_visit", { is_login: isLogin });
  return NextResponse.json({ ok: true });
}
