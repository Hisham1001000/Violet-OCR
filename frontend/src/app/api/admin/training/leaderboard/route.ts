import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin } from "@/lib/admin";

// GET /api/admin/training/leaderboard
//
// Trainer-visible leaderboard (not admin-only). Ranks trainers by how many
// crops they've SENT to admin for review (every row they verified). Returns
// ONLY a display name + the sent count — never emails, and no approved/awaiting
// breakdown — so trainers just see who sent how much.
//
// SEASONS: the board counts only work verified on/after SEASON_START, so it can
// be "reset" to give newer trainers a reachable target without touching any
// data — verified_by/verified_at, approvals and the training set are untouched,
// and Trainer Activity still shows all-time numbers. To start a new season set
// LEADERBOARD_SEASON_START (ISO date) in the Vercel env; no redeploy needed.
const SEASON_START =
  process.env.LEADERBOARD_SEASON_START ?? "2026-07-31T00:00:00.000Z";

export async function GET() {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;

  const admin = createAdminClient();

  // Count each trainer's submissions (verified_by set = they sent it to admin).
  // Only verified rows carry verified_by, so this reads a small subset; paginate
  // to be safe past 1000.
  const counts = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: batch, error } = await admin
      .from("training_dataset")
      .select("verified_by")
      .not("verified_by", "is", null)
      .gte("verified_at", SEASON_START)
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      const uid = r.verified_by as string | null;
      if (uid) counts.set(uid, (counts.get(uid) ?? 0) + 1);
    }
    if (batch.length < PAGE) break;
  }

  const ids = Array.from(counts.keys());
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profs } = await admin
      .from("user_profiles")
      .select("user_id, full_name, email")
      .in("user_id", ids);
    for (const p of profs ?? []) {
      if (!p.user_id) continue;
      // Name only. Never expose the full email; fall back to its handle (the
      // part before @) so people are still distinguishable without a name set.
      const handle = (p.email ?? "").split("@")[0];
      nameById.set(p.user_id, ((p.full_name || handle || "Trainer") as string).trim());
    }
  }

  const trainers = ids
    .map((id) => ({ user_id: id, name: nameById.get(id) ?? "Trainer", sent: counts.get(id) ?? 0 }))
    .sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));

  return NextResponse.json({ trainers, season_start: SEASON_START });
}
