// Importing this from a client component is a build error, not a code review
// comment: everything here runs with the service-role key.
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Landing-page uploads (migration 042).
 *
 * A visitor with no account can drop a sheet on the landing page. It is stored
 * and processed under one fixed guest account that cannot sign in or pay, and
 * the visitor's browser keeps a random claim token. When they sign up or sign
 * in, /api/guest/claim hands the job to their account and prices it for them.
 */

export const GUEST_EMAIL = "guest@violetocr.invalid";

/**
 * How long a claim token stays good. The file itself is KEPT either way — the
 * owner wants every sheet Violet has read to stay in the database. This is only
 * the window in which the browser that uploaded it can still pull it into a new
 * account.
 */
export const GUEST_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Uploads one visitor (by IP) may make per day before they must sign up. */
export const GUEST_PER_IP_PER_DAY = Number(process.env.GUEST_PER_IP_PER_DAY ?? 2);

/**
 * Uploads from ALL visitors per day. Each one costs real Azure, Gemini and GPU
 * time (~$0.09 a page) before anyone has signed up, so this is the ceiling on
 * what strangers and bots can spend. Raise it in the environment, not here.
 */
export const GUEST_DAILY_LIMIT = Number(process.env.GUEST_DAILY_LIMIT ?? 25);

/** Longest PDF a visitor may process without an account. */
export const GUEST_MAX_PAGES = Number(process.env.GUEST_MAX_PAGES ?? 5);

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newClaimToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The IP is never stored, only a salted hash, and only to count uploads. */
export function hashIp(ip: string): Promise<string> {
  const salt = process.env.GUEST_IP_SALT ?? (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").slice(-16);
  return sha256Hex(`${salt}:${ip}`);
}

/**
 * Page count of a PDF, read from its page objects. Returns null when the page
 * tree is inside compressed object streams and cannot be counted this way.
 */
export function countPdfPages(bytes: ArrayBuffer): number | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages > 0) return pages;
  const counts = Array.from(text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g), (m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

let cachedGuestId: string | null = null;

/** The guest account's id, creating and preparing the account on first use. */
export async function getGuestUserId(admin: SupabaseClient): Promise<string> {
  if (cachedGuestId) return cachedGuestId;

  const find = async () => {
    const { data, error } = await admin.rpc("guest_user_id");
    if (error) throw new Error(`guest_user_id: ${error.message}`);
    return (data as string | null) ?? null;
  };

  let id = await find();
  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({
      email:         GUEST_EMAIL,
      password:      newClaimToken(),   // never stored: nobody signs in as the guest
      email_confirm: true,
      user_metadata: { full_name: "Landing-page guest uploads" },
    });
    // Two first uploads at once: the loser finds the winner's account.
    id = data?.user?.id ?? (await find());
    if (!id) throw new Error(`guest account: ${error?.message ?? "not created"}`);
  }

  const { error: prepErr } = await admin.rpc("prepare_guest_user", { p_user_id: id });
  if (prepErr) throw new Error(`prepare_guest_user: ${prepErr.message}`);

  cachedGuestId = id;
  return id;
}

// Nothing here deletes an unclaimed upload. A sheet Violet has already read is
// kept — it is the owner's own record and their training data. When the claim
// window passes, the file simply stops being claimable and stays under the
// guest account, where only the service role can read it.
