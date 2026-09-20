import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Where Supabase sends people back to: Google sign-in, and the links in
 * confirmation and password-reset emails.
 *
 * Two kinds of arrival:
 *
 *   ?code=...        Google. Exchanged for a session, which needs the matching
 *                    token this browser stored when the person left for Google.
 *
 *   ?token_hash=...  An email link. Verified server-side, so it does NOT need
 *                    anything stored in the browser -- which is what makes it
 *                    work when the email opens in a different browser from the
 *                    one used to sign up. On a phone that is the normal case,
 *                    and before this it failed every time.
 *
 * A failure sends a short reason back to /auth so the person is told what to
 * do, instead of being dropped on a blank form.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code       = searchParams.get("code");
  const tokenHash  = searchParams.get("token_hash");
  const otpType    = searchParams.get("type");
  const next       = searchParams.get("next") ?? "/dashboard";
  const error      = searchParams.get("error");

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/auth?error=oauth_failed&reason=${reason}`);

  // OAuth provider returned an error
  if (error) {
    return NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent(error)}`);
  }

  if (code || tokenHash) {
    const cookieStore = cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    let failure: { message?: string } | null = null;
    if (tokenHash) {
      // Email link: verified against the server, no browser state needed.
      const { error: otpError } = await supabase.auth.verifyOtp({
        type: (otpType as "signup" | "recovery" | "invite" | "email_change" | "magiclink") ?? "email",
        token_hash: tokenHash,
      });
      failure = otpError;
    } else {
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code!);
      failure = exchangeError;
    }

    if (!failure) {
      // OAuth sign-in is server-side — it can't set sessionStorage directly.
      // Redirect through /auth/session-init which sets violet_session on the
      // client, then forwards to the real destination. Without this, SessionGuard
      // sees neither flag and immediately signs the user out.
      const initUrl = new URL(`${origin}/auth/session-init`);
      initUrl.searchParams.set("next", next);
      return NextResponse.redirect(initUrl.toString());
    }

    // Log the real sentence: "was it the browser or the link?" is otherwise a
    // guess, and this page is where people give up.
    const msg = (failure.message ?? "").toLowerCase();
    console.error("[AuthCallback] sign-in failed:", failure.message);
    if (msg.includes("code verifier") || msg.includes("pkce")) return fail("other_browser");
    if (msg.includes("expired") || msg.includes("invalid") || msg.includes("used")) return fail("expired");
    return fail("unknown");
  }

  return fail("no_code");
}
