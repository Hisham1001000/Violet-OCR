import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Module-level singleton — all browser components share ONE client instance.
//
// Why this matters: @supabase/ssr uses the Web Locks API internally to
// coordinate auth-token refreshes across browser tabs. When multiple
// createBrowserClient() calls produce separate instances on the same page,
// each instance competes for the same lock. The loser gets:
//   "AbortError: Lock broken by another request with the 'steal' option"
//
// Keeping a single module-level client eliminates the race entirely.
let _client: SupabaseClient | null = null;

export function createClient(): SupabaseClient {
  if (!_client) {
    _client = createBrowserClient(
      (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
      (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
      {
        auth: {
          // Disable the Web Locks API — prevents "Lock broken by another
          // request with the 'steal' option" AbortError in dev mode when
          // multiple components mount and race for the auth lock.
          lock: async (name: string, _ac: AbortController, fn: () => Promise<unknown>) => await fn(),
        },
      }
    );
  }
  return _client;
}
