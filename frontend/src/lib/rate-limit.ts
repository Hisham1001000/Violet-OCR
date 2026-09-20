// Importing this from a client component is a build error, not a code review
// comment: holds the Upstash Redis token.
import "server-only";

/**
 * Rate limiter with a shared backend and a graceful in-memory fallback.
 *
 * On serverless (Vercel) each instance has its own memory, so an in-memory-only
 * limiter is per-instance and easily bypassed under load. When Upstash Redis is
 * configured (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), counters are
 * shared across all instances via the Upstash REST API (no extra npm
 * dependency). If those env vars are absent — or Upstash is unreachable — we
 * fall back to the in-memory limiter so the app keeps working.
 */

interface RateLimitRecord { count: number; reset: number }
const store = new Map<string, RateLimitRecord>();

// Prune expired entries periodically to bound memory on long-lived instances.
// (No-op effect on short-lived serverless invocations, which is fine.)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    store.forEach((v, k) => {
      if (now > v.reset) store.delete(k);
    });
  }, 5 * 60 * 1000);
}

function inMemoryAllow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = store.get(key);
  if (!rec || now > rec.reset) {
    store.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (rec.count >= max) return false;
  rec.count++;
  return true;
}

/**
 * Try the shared Upstash counter. Returns the decision, or null when Upstash is
 * not configured / unreachable (so the caller falls back to memory).
 */
async function upstashAllow(key: string, max: number, windowMs: number): Promise<boolean | null> {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const incRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!incRes.ok) return null;
    const { result: count } = (await incRes.json()) as { result: number };

    // First hit in this window — set the TTL so the counter resets.
    if (count === 1) {
      await fetch(`${url}/pexpire/${encodeURIComponent(key)}/${windowMs}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }).catch(() => {});
    }
    return count <= max;
  } catch {
    return null; // network/Upstash error → fall back to in-memory
  }
}

/**
 * Returns true if the request is allowed, false if rate-limited.
 * @param key       Unique key (e.g. "upload:1.2.3.4")
 * @param max       Max requests allowed in the window
 * @param windowMs  Window duration in ms
 */
export async function rateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const shared = await upstashAllow(key, max, windowMs);
  if (shared !== null) return shared;
  return inMemoryAllow(key, max, windowMs);
}

/** Extract client IP from Next.js request headers */
export function getClientIp(req: { headers: { get: (k: string) => string | null } }): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
