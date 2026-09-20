import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/admin";

// GET /api/admin/training/trainer-stats
//
// Per-trainer activity overview for admins.
//
// Returns one row per trainer who has touched any training_dataset rows:
//   { user_id, email, total_verified, awaiting_review, approved, rejected,
//     last_activity, last_7_days_verified }
//
// Source columns added by migration 023: verified_by, verified_at.
// Trainers who never verified anything do not appear (no audit signal).
export async function GET() {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;

  const admin = createAdminClient();

  // Pull every row that has a verified_by — this is the audit signal.
  // Status drives which bucket (awaiting/approved/rejected) it counts in.
  const { data: rows, error } = await admin
    .from("training_dataset")
    .select("verified_by, status, verified_at")
    .not("verified_by", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Stats = {
    user_id: string;
    total_verified:        number;   // any status (overall throughput)
    awaiting_review:       number;   // status = verified
    approved:              number;
    rejected:              number;
    last_activity:         string;
    last_7_days_verified:  number;
  };
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const byTrainer = new Map<string, Stats>();
  for (const r of rows ?? []) {
    const uid = r.verified_by as string;
    if (!uid) continue;
    let s = byTrainer.get(uid);
    if (!s) {
      s = {
        user_id: uid,
        total_verified: 0, awaiting_review: 0, approved: 0, rejected: 0,
        last_activity: r.verified_at ?? "",
        last_7_days_verified: 0,
      };
      byTrainer.set(uid, s);
    }
    s.total_verified++;
    if (r.status === "verified") s.awaiting_review++;
    if (r.status === "approved") s.approved++;
    if (r.status === "rejected") s.rejected++;
    if (r.verified_at && r.verified_at > s.last_activity) s.last_activity = r.verified_at;
    if (r.verified_at && Date.parse(r.verified_at) >= sevenDaysAgo) {
      s.last_7_days_verified++;
    }
  }

  // Hydrate emails (and optionally full_name) for the trainer ids.
  const ids = Array.from(byTrainer.keys());
  const profileById = new Map<string, { email: string; full_name: string | null; is_trainer: boolean; is_admin: boolean }>();
  if (ids.length > 0) {
    const { data: profs } = await admin
      .from("user_profiles")
      .select("user_id, email, full_name, is_trainer, is_admin")
      .in("user_id", ids);
    for (const p of profs ?? []) {
      if (p.user_id) {
        profileById.set(p.user_id, {
          email:      p.email ?? "",
          full_name:  p.full_name ?? null,
          is_trainer: !!p.is_trainer,
          is_admin:   !!p.is_admin,
        });
      }
    }
  }

  const trainers = Array.from(byTrainer.values()).map((s) => {
    const p = profileById.get(s.user_id);
    return {
      ...s,
      email:      p?.email     ?? "(unknown)",
      full_name:  p?.full_name ?? null,
      is_trainer: p?.is_trainer ?? false,
      is_admin:   p?.is_admin   ?? false,
    };
  });

  // Sort by recent activity, descending.
  trainers.sort((a, b) =>
    (a.last_activity > b.last_activity ? -1 : a.last_activity < b.last_activity ? 1 : 0),
  );

  // Totals across all trainers — useful header metric.
  const totals = {
    trainers:        trainers.length,
    total_verified:  trainers.reduce((n, t) => n + t.total_verified, 0),
    awaiting_review: trainers.reduce((n, t) => n + t.awaiting_review, 0),
    approved:        trainers.reduce((n, t) => n + t.approved, 0),
    rejected:        trainers.reduce((n, t) => n + t.rejected, 0),
  };

  return NextResponse.json({ trainers, totals });
}
