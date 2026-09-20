import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/admin";

// GET /api/admin/training/queue
//
// Admin-only review queue. Returns every training_dataset row currently in
// status='verified' (i.e. trainer marked it good, awaiting admin approval).
// Each row carries a fresh signed crop URL plus the trainer who verified it.
//
// Pagination:
//   ?page=1&limit=50  (defaults: page=1, limit=50, max=200)
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertAdmin(supabase);
  if (guard instanceof NextResponse) return guard;

  const { searchParams } = req.nextUrl;
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit  = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const offset = (page - 1) * limit;

  const admin = createAdminClient();

  // Pull verified rows, oldest first (FIFO so trainers' work doesn't sit forever).
  // Prefer the context columns (so the admin gets the non-destructive editor);
  // fall back if migration 025 hasn't been applied yet.
  const COLS_CTX  = "id, job_id, participant_index, field_name, crop_path, context_path, context_box, ocr_output, label, status, verified_at, verified_by, created_at";
  const COLS_BASE = "id, job_id, participant_index, field_name, crop_path, ocr_output, label, status, verified_at, verified_by, created_at";
  const runQuery = (cols: string) =>
    admin
      .from("training_dataset")
      .select(cols, { count: "exact" })
      .eq("status", "verified")
      .order("verified_at", { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1);
  let res = await runQuery(COLS_CTX);
  if (res.error && /context_/.test(res.error.message ?? "")) res = await runQuery(COLS_BASE);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  type Row = {
    id: string; job_id: string; participant_index: number; field_name: string;
    crop_path: string; context_path?: string | null; context_box?: unknown;
    ocr_output: string | null; label: string | null; status: string;
    verified_at: string | null; verified_by: string | null; created_at: string;
  };
  const rows  = (res.data ?? []) as unknown as Row[];
  const count = res.count;

  // Sign crop + context URLs in batches of 100.
  const urlByPath = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const paths = slice.flatMap((r) => (r.context_path ? [r.crop_path, r.context_path] : [r.crop_path]));
    const { data: signed } = await admin.storage
      .from("training_crops")
      .createSignedUrls(paths, 3600);
    for (const s of signed ?? []) {
      if (s?.path && s?.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
  }

  // Hydrate trainer email per verified_by (single batched lookup so the queue
  // can show "Verified by alice@example.com 2h ago" instead of a UUID).
  const trainerIds = Array.from(
    new Set(rows.map((r) => r.verified_by).filter((v): v is string => !!v)),
  );
  const trainerEmailById = new Map<string, string>();
  if (trainerIds.length > 0) {
    // Pull profiles for any trainer that has acted on a queued row.
    const { data: profiles } = await admin
      .from("user_profiles")
      .select("user_id, email")
      .in("user_id", trainerIds);
    for (const p of profiles ?? []) {
      if (p.user_id && p.email) trainerEmailById.set(p.user_id, p.email);
    }
  }

  // Hydrate document_name per job_id so the admin sees which file each crop came from.
  const jobIds = Array.from(new Set(rows.map((r) => r.job_id)));
  const jobNameById = new Map<string, string>();
  if (jobIds.length > 0) {
    const { data: jobs } = await admin
      .from("document_jobs")
      .select("id, document_name")
      .in("id", jobIds);
    for (const j of jobs ?? []) {
      if (j.id) jobNameById.set(j.id, j.document_name ?? "");
    }
  }

  const items = rows.map((r) => ({
    ...r,
    crop_url:        urlByPath.get(r.crop_path) ?? null,
    context_url:     r.context_path ? (urlByPath.get(r.context_path) ?? null) : null,
    verified_by_email: r.verified_by ? trainerEmailById.get(r.verified_by) ?? null : null,
    document_name:   jobNameById.get(r.job_id) ?? null,
  }));

  return NextResponse.json({ items, total: count ?? 0, page, limit });
}
