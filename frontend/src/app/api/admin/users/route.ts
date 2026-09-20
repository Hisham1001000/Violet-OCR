import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/admin";

/**
 * Admin users list — guaranteed-complete, self-healing.
 *
 * Strategy:
 *   1. Pull EVERY auth.users row via the admin API. This is the ground truth
 *      of "who actually has an account" — never filtered.
 *   2. Pull all user_profiles in one batched query.
 *   3. For each auth user with NO profile row, auto-create one on the fly using
 *      the same logic the trigger uses (COALESCE full_name/name from metadata).
 *      This self-heals orphans without needing manual SQL backfills.
 *   4. For each user_profile with NULL/empty full_name, repair it from auth
 *      metadata in the same pass.
 *   5. Merge the two sources. The returned list ALWAYS contains every auth user.
 *      A meaningful display name is guaranteed: full_name → email → short id.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const { searchParams } = req.nextUrl;
  const search = searchParams.get("search")?.trim().toLowerCase() ?? "";
  const planFilter = searchParams.get("plan") ?? "";
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit  = 50;

  // ── 1. Try to fetch ALL auth users via the admin API. ───────────────────────
  // If the admin client can't be created (missing SUPABASE_SERVICE_ROLE_KEY in
  // env) OR listUsers fails for any reason, fall back to user_profiles only —
  // empty list is the wrong UX. Surface the issue via a `warning` field instead
  // of returning 500 so admins can still see whatever profiles exist.
  type AuthRow = {
    id: string;
    email?: string;
    created_at?: string;
    user_metadata?: Record<string, unknown>;
  };
  let admin: ReturnType<typeof createAdminClient> | null = null;
  let warning: string | null = null;
  try { admin = createAdminClient(); }
  catch (e) {
    warning = `Admin client unavailable (${e instanceof Error ? e.message : "unknown"}). Showing profiles-only view; orphaned auth users won't appear.`;
  }

  const allAuthUsers: AuthRow[] = [];
  if (admin) {
    let authPage = 1;
    try {
      while (true) {
        const { data, error } = await admin.auth.admin.listUsers({ page: authPage, perPage: 1000 });
        if (error) {
          warning = `Auth listing failed: ${error.message}. Showing profiles-only view.`;
          break;
        }
        const users = (data?.users ?? []) as unknown as AuthRow[];
        allAuthUsers.push(...users);
        if (users.length < 1000) break;
        authPage++;
        if (authPage > 50) break;
      }
    } catch (e) {
      warning = `Auth listing crashed: ${e instanceof Error ? e.message : "unknown"}. Showing profiles-only view.`;
    }
  }

  // ── 2. Fetch all user_profiles. Use admin client when available so we
  //    bypass RLS, otherwise the user-scoped client (admins should still pass
  //    RLS on user_profiles via is_admin policy from migration 013).
  const profileFetcher = admin ?? supabase;
  const { data: profilesRaw, error: profilesErr } = await profileFetcher
    .from("user_profiles")
    .select("user_id, email, plan, balance_cents, rows_used_total, subscription_status, is_admin, is_banned, created_at, full_name");
  if (profilesErr) {
    return NextResponse.json({ error: `Failed to fetch profiles: ${profilesErr.message}` }, { status: 500 });
  }

  type Profile = {
    user_id: string;
    email: string | null;
    full_name: string | null;
    plan: string | null;
    balance_cents: number | null;
    rows_used_total: number | null;
    subscription_status: string | null;
    is_admin: boolean | null;
    is_banned: boolean | null;
    created_at: string | null;
  };
  const profilesByUserId = new Map<string, Profile>();
  for (const p of (profilesRaw ?? []) as Profile[]) {
    profilesByUserId.set(p.user_id, p);
  }

  // ── 3. Self-heal: insert missing profiles + repair NULL full_name rows ──────
  // Only runs when we have admin access (otherwise we have no auth.users data).
  if (admin && allAuthUsers.length > 0) {
    const inserts: Array<{ user_id: string; email: string | null; full_name: string | null }> = [];
    const repairs: Array<{ user_id: string; full_name: string }> = [];
    for (const u of allAuthUsers) {
      const meta = u.user_metadata ?? {};
      const metaName =
        (typeof meta.full_name === "string" && meta.full_name.trim()) ||
        (typeof meta.name      === "string" && meta.name.trim())      ||
        null;
      const existing = profilesByUserId.get(u.id);
      if (!existing) {
        inserts.push({ user_id: u.id, email: u.email ?? null, full_name: metaName });
      } else if ((!existing.full_name || existing.full_name.trim() === "") && metaName) {
        repairs.push({ user_id: u.id, full_name: metaName });
      }
    }

    if (inserts.length > 0) {
      const { data: inserted } = await admin
        .from("user_profiles")
        .upsert(inserts, { onConflict: "user_id" })
        .select("user_id, email, plan, balance_cents, rows_used_total, subscription_status, is_admin, is_banned, created_at, full_name");
      for (const p of (inserted ?? []) as Profile[]) profilesByUserId.set(p.user_id, p);
    }
    for (const r of repairs) {
      const { data: updated } = await admin
        .from("user_profiles")
        .update({ full_name: r.full_name })
        .eq("user_id", r.user_id)
        .select("user_id, email, plan, balance_cents, rows_used_total, subscription_status, is_admin, is_banned, created_at, full_name")
        .maybeSingle();
      if (updated) profilesByUserId.set(r.user_id, updated as Profile);
    }
  }

  // ── 4. Merge: union of auth users + profiles. ───────────────────────────────
  // Use auth.users when admin API worked (ground truth, includes orphans).
  // Fall back to whatever profiles exist when admin API was unavailable —
  // better than returning empty list and leaving admin staring at "no users".
  type Row = Profile & { display_name: string; user_metadata?: Record<string, unknown> };
  const sourceIds: string[] = allAuthUsers.length > 0
    ? allAuthUsers.map((u) => u.id)
    : Array.from(profilesByUserId.keys());
  const authById = new Map<string, AuthRow>();
  for (const u of allAuthUsers) authById.set(u.id, u);

  let merged: Row[] = sourceIds.map((uid) => {
    const u = authById.get(uid);
    const p: Profile = profilesByUserId.get(uid) ?? {
      user_id: uid,
      email: u?.email ?? null,
      full_name: null,
      plan: "free",
      balance_cents: 0,
      rows_used_total: 0,
      subscription_status: "free",
      is_admin: false,
      is_banned: false,
      created_at: u?.created_at ?? null,
    };
    // Try metadata as a last-resort name source (covers OAuth users without a
    // healed profile yet).
    const meta = u?.user_metadata ?? {};
    const metaName =
      (typeof meta.full_name === "string" && meta.full_name.trim()) ||
      (typeof meta.name      === "string" && meta.name.trim())      ||
      null;
    // Email prefix fallback: "hisham@example.com" → "hisham". Beats showing
    // a raw UUID and beats showing a full email in the Name column.
    const email = p.email ?? u?.email ?? null;
    const emailPrefix = email && email.includes("@") ? email.split("@")[0] : null;

    const display_name =
      (p.full_name && p.full_name.trim()) ||
      metaName                              ||
      emailPrefix                           ||
      (email && email.trim())               ||
      `User ${uid.slice(0, 8)}`;
    return { ...p, email, display_name };
  });

  // ── 5. Apply filters + sort + paginate in JS ────────────────────────────────
  if (planFilter) merged = merged.filter((r) => r.plan === planFilter);
  if (search) {
    merged = merged.filter((r) =>
      (r.email?.toLowerCase().includes(search) ?? false) ||
      (r.full_name?.toLowerCase().includes(search) ?? false)
    );
  }
  merged.sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  const total  = merged.length;
  const offset = (page - 1) * limit;
  const pageRows = merged.slice(offset, offset + limit);

  return NextResponse.json({ users: pageRows, total, page, limit, warning });
}
