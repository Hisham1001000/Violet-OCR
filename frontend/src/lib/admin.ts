// Importing this from a client component is a build error, not a code review
// comment: reads user_profiles.is_admin and writes audit_logs.
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export type SupabaseServerClient = ReturnType<typeof createClient>;

/**
 * Shared guard for all admin API routes.
 * Returns { user, adminEmail } on success, or a 401/403 NextResponse on failure.
 */
export async function assertAdmin(
  supabase: SupabaseServerClient
): Promise<{ user: { id: string; email?: string }; adminEmail: string } | NextResponse> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_admin, email")
    .eq("user_id", user.id)
    .single();

  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return { user, adminEmail: profile.email ?? user.email ?? "" };
}

/**
 * Guard for training-section routes. Allows full admins AND trainers.
 * Trainers are scoped: can use /admin/training endpoints but not other admin
 * routes (those still call assertAdmin which rejects trainer-only users).
 */
export async function assertTrainerOrAdmin(
  supabase: SupabaseServerClient
): Promise<{ user: { id: string; email?: string }; email: string; adminEmail: string; isAdmin: boolean; isTrainer: boolean } | NextResponse> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_admin, is_trainer, email")
    .eq("user_id", user.id)
    .single();
  const isAdmin   = !!profile?.is_admin;
  const isTrainer = !!profile?.is_trainer;
  if (!isAdmin && !isTrainer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // `adminEmail` mirrors assertAdmin's field name so both guards expose the same
  // key; `email` is kept for backward compatibility with existing callers.
  const email = profile?.email ?? user.email ?? "";
  return { user, email, adminEmail: email, isAdmin, isTrainer };
}

/**
 * Write an entry to audit_logs.
 * Call after every admin action that modifies data.
 */
export async function logAudit(
  supabase: SupabaseServerClient,
  actorId: string,
  actorEmail: string,
  action: string,
  targetType?: string,
  targetId?: string,
  details?: Record<string, unknown>
) {
  await supabase.from("audit_logs").insert({
    actor_id:    actorId,
    actor_email: actorEmail,
    action,
    target_type: targetType ?? null,
    target_id:   targetId   ?? null,
    details:     details    ?? null,
  });
}
