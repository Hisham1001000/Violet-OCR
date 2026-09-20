import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    return NextResponse.json({ authenticated: false, error: error?.message ?? "No session" }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    user: { id: session.user.id, email: session.user.email },
    expires_at: session.expires_at,
  });
}
