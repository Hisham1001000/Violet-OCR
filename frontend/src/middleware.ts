import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/auth", "/policy"];
const API_PREFIX   = "/api";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── One address for the whole site ────────────────────────────────────────
  // Signing in with Google stores a one-time token against the address the
  // person started on. Start on a *.vercel.app address, come back to
  // violetocr.com, and the exchange fails with nothing to show for it -- which
  // is the `?error=oauth_failed` page Clarity caught someone sitting on.
  const canonical = process.env.NEXT_PUBLIC_SITE_URL;
  if (canonical) {
    const host = request.headers.get("host") ?? "";
    const wanted = new URL(canonical).host;
    if (host.endsWith(".vercel.app") && host !== wanted) {
      return NextResponse.redirect(new URL(pathname + request.nextUrl.search, canonical), 308);
    }
  }

  // "/" is the landing page: anyone may see it. Exact match only -- a prefix
  // test on "/" would make every route public.
  const isPublic = pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  const isApi    = pathname.startsWith(API_PREFIX);

  // If env vars are missing, pass through rather than crash
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return addSecurityHeaders(NextResponse.next());
  }

  // Supabase requires the response to be recreated inside setAll so downstream
  // route handlers receive the refreshed token in their request cookies.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          // Update request cookies so downstream handlers see the refreshed token
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // Recreate response with updated request so the route handler inherits them
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
          );
        },
      },
    }
  );

  try {
    // ── API routes: refresh the session, do not re-verify it ────────────────
    //
    // getUser() calls Supabase's /auth/v1/user to verify the JWT. Measured from
    // here that is a 1020ms median round trip — and for /api/* the answer was
    // thrown away a few lines later, while the route handler then paid the SAME
    // 1s calling getUser() itself. Every API request was buying the same
    // verification twice and using one.
    //
    // getSession() reads the token from the cookie and only touches the network
    // when it has actually expired, which is the one thing middleware is still
    // needed for here: refreshing the cookie so route handlers get a live
    // token. It does NOT verify the signature — which is fine, because it is
    // not making an authorization decision. Every API route still calls
    // getUser() and returns its own 401.
    if (isApi) {
      await supabase.auth.getSession();
      return addSecurityHeaders(response);
    }

    const { data: { user } } = await supabase.auth.getUser();

    if (isPublic) {
      return addSecurityHeaders(response);
    }

    if (!user) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/auth";
      if (/^\/[a-zA-Z0-9/_-]*$/.test(pathname)) {
        redirectUrl.searchParams.set("next", pathname);
      }
      return NextResponse.redirect(redirectUrl);
    }

    // Block banned accounts (deletion is hard — deleted users have no session)
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("is_banned")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profile?.is_banned) {
      await supabase.auth.signOut();
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/auth";
      redirectUrl.searchParams.set("banned", "1");
      return NextResponse.redirect(redirectUrl);
    }
  } catch {
    if (!isPublic && !isApi) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/auth";
      return NextResponse.redirect(redirectUrl);
    }
    return addSecurityHeaders(response);
  }

  return addSecurityHeaders(response);
}

function addSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Frame-Options",        "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-XSS-Protection",       "1; mode=block");
  res.headers.set("Referrer-Policy",        "strict-origin-when-cross-origin");
  // Conservative CSP: blocks clickjacking and <base>/plugin injection without
  // restricting scripts/styles/fonts/images/connections (the app relies on
  // inline styles, Google Fonts, Supabase, and signed image URLs), so it can't
  // break existing functionality.
  res.headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
