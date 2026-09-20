/**
 * Returns the canonical base URL for the current deployment.
 *
 * Priority:
 *   1. NEXT_PUBLIC_SITE_URL   — explicit production override (Vercel env var)
 *   2. NEXT_PUBLIC_VERCEL_URL — auto-set by Vercel for preview deployments
 *   3. window.location.origin — fallback for local dev / unknown envs
 *
 * Pass to Supabase auth calls (resetPasswordForEmail, signInWithOAuth) so the
 * emailed link + OAuth callback point at the real deployment, not localhost.
 *
 * NOTE: Supabase's Site URL setting in the dashboard still governs the email
 * template's link base. Set that to the same production URL too.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(explicit);

  const vercel = process.env.NEXT_PUBLIC_VERCEL_URL;
  if (vercel) return `https://${stripTrailingSlash(vercel)}`;

  if (typeof window !== "undefined") return window.location.origin;

  return "http://localhost:3000";
}

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}
