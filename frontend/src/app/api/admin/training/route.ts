import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertTrainerOrAdmin } from "@/lib/admin";

// GET /api/admin/training — file-grouped overview of the training dataset.
//
// Returns one row per JOB (file) instead of one per crop, so trainers can
// browse files like a queue. Each entry carries counts (pending/verified/
// rejected) and a thumbnail of the first crop.
//
// Pass ?flat=1 to get the old per-crop list (used by the file detail page).
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const guard = await assertTrainerOrAdmin(supabase);
  if (guard instanceof NextResponse) return guard;

  const { searchParams } = req.nextUrl;
  const flat = searchParams.get("flat") === "1";

  const admin = createAdminClient();

  // ── FLAT MODE ─────────────────────────────────────────────────────────────
  if (flat) {
    const status = searchParams.get("status") ?? "pending";
    const jobId  = searchParams.get("job_id");
    const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit  = Math.min(200, parseInt(searchParams.get("limit") ?? "50", 10));
    const offset = (page - 1) * limit;

    type Row = {
      id: string; job_id: string; participant_index: number; field_name: string;
      crop_path: string; context_path?: string | null; context_box?: unknown;
      ocr_output: string | null; label: string | null; status: string;
      created_at: string; reviewed_at: string | null;
    };
    const buildQuery = (cols: string) => {
      let q = admin
        .from("training_dataset")
        .select(cols, { count: "exact" })
        .order("participant_index", { ascending: true })
        .range(offset, offset + limit - 1);
      if (status && status !== "all") q = q.eq("status", status);
      if (jobId) q = q.eq("job_id", jobId);
      return q;
    };
    // Prefer the context columns (non-destructive editor); fall back if migration
    // 025 hasn't been applied yet so the detail page never breaks.
    const CTX  = "id, job_id, participant_index, field_name, crop_path, context_path, context_box, ocr_output, label, status, created_at, reviewed_at";
    const BASE = "id, job_id, participant_index, field_name, crop_path, ocr_output, label, status, created_at, reviewed_at";
    let res = await buildQuery(CTX);
    if (res.error && /context_/.test(res.error.message ?? "")) {
      res = await buildQuery(BASE);
    }
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

    const rows = (res.data ?? []) as unknown as Row[];
    // Sign URLs in batches so the response time scales reasonably. Each crop
    // signs both its tight crop and (if present) its wider context image.
    const signed: Array<Row & { crop_url: string | null; context_url: string | null }> = [];
    for (let i = 0; i < rows.length; i += 100) {
      const slice = rows.slice(i, i + 100);
      const paths = slice.flatMap((r) => (r.context_path ? [r.crop_path, r.context_path] : [r.crop_path]));
      const { data: urls } = await admin.storage
        .from("training_crops")
        .createSignedUrls(paths, 3600);
      const urlByPath = new Map<string, string>();
      for (const s of urls ?? []) {
        if (s?.path && s?.signedUrl) urlByPath.set(s.path, s.signedUrl);
      }
      for (const r of slice) {
        signed.push({
          ...r,
          crop_url:    urlByPath.get(r.crop_path) ?? null,
          context_url: r.context_path ? (urlByPath.get(r.context_path) ?? null) : null,
        });
      }
    }
    return NextResponse.json({ items: signed, total: res.count ?? 0, page, limit });
  }

  // ── GROUPED MODE (default) ────────────────────────────────────────────────
  // Show EVERY completed job — even ones with zero crops yet — so the trainer
  // can see new uploads immediately and trigger Re-crop on any that the auto-
  // cropper skipped (e.g. because the storage bucket didn't exist at the time).
  // Source of truth = document_jobs (NOT training_dataset, which would hide
  // jobs that have no crops yet).

  // Step 1: every completed job. document_url is also pulled — when it's
  // NULL the job is a manual-upload batch (no original PDF, just a wrapper).
  const { data: jobs, error: jobsErr } = await admin
    .from("document_jobs")
    .select("id, user_id, document_name, created_at, status, document_url")
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(500);   // safety cap
  if (jobsErr) return NextResponse.json({ error: jobsErr.message }, { status: 500 });

  // Step 2: every training row (status counts + thumbs), keyed by job_id.
  // PostgREST caps a single select at 1000 rows, so page through the whole
  // table — otherwise once the dataset exceeds 1000 crops, every job beyond the
  // first page wrongly shows zero crops ("No crops yet") and the totals
  // under-count.
  type TRow = { job_id: string; status: string; crop_path: string; created_at: string; verified_by: string | null; verified_at: string | null };
  const rows: TRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: batch, error: rowsErr } = await admin
      .from("training_dataset")
      // Order by job_id (not created_at) so this whole scan can be served by the
      // covering index training_dataset_overview as an index-only scan — much
      // less Disk IO than a full heap read on every page load.
      .select("job_id, status, crop_path, created_at, verified_by, verified_at")
      .order("job_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (rowsErr) return NextResponse.json({ error: rowsErr.message }, { status: 500 });
    if (!batch || batch.length === 0) break;
    rows.push(...(batch as TRow[]));
    if (batch.length < PAGE) break;
  }

  type GroupStats = {
    total: number;
    pending:  number;
    verified: number;   // trainer-verified, awaiting admin
    approved: number;   // admin-approved, final
    rejected: number;
    last_activity: string;
    thumb_path: string | null;
    worker_id: string | null;   // trainer who most recently worked this file
    worker_at: string | null;   // when they last verified a crop here
  };
  const statsByJob = new Map<string, GroupStats>();
  for (const r of rows ?? []) {
    let g = statsByJob.get(r.job_id);
    if (!g) {
      g = { total: 0, pending: 0, verified: 0, approved: 0, rejected: 0, last_activity: r.created_at, thumb_path: r.crop_path, worker_id: null, worker_at: null };
      statsByJob.set(r.job_id, g);
    }
    g.total++;
    if (r.status === "pending")  g.pending++;
    if (r.status === "verified") g.verified++;
    if (r.status === "approved") g.approved++;
    if (r.status === "rejected") g.rejected++;
    if (r.created_at > g.last_activity) g.last_activity = r.created_at;
    // Track the trainer who touched this file most recently (audit signal).
    if (r.verified_by && (!g.worker_at || (r.verified_at ?? "") > g.worker_at)) {
      g.worker_id = r.verified_by;
      g.worker_at = r.verified_at;
    }
  }

  // Resolve trainer ids -> display name/email for the "who's on this file" badge.
  const workerIds = Array.from(new Set(
    Array.from(statsByJob.values()).map((g) => g.worker_id).filter((x): x is string => !!x),
  ));
  const workerById = new Map<string, { name: string }>();
  if (workerIds.length > 0) {
    const { data: profs } = await admin
      .from("user_profiles")
      .select("user_id, email, full_name")
      .in("user_id", workerIds);
    for (const p of profs ?? []) {
      if (p.user_id) workerById.set(p.user_id, { name: (p.full_name || p.email || "trainer") as string });
    }
  }

  // Step 3: sign thumbs for jobs that have crops
  const thumbPaths = (jobs ?? [])
    .map((j) => statsByJob.get(j.id)?.thumb_path)
    .filter((p): p is string => !!p);
  const thumbUrlByPath = new Map<string, string>();
  if (thumbPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from("training_crops")
      .createSignedUrls(thumbPaths, 3600);
    for (const s of signed ?? []) {
      if (s?.path && s?.signedUrl) thumbUrlByPath.set(s.path, s.signedUrl);
    }
  }

  // Step 4: assemble the response — every job appears, even with zero crops.
  const allItems = (jobs ?? []).map((j) => {
    const s = statsByJob.get(j.id);
    return {
      job_id:        j.id,
      user_id:       (j as { user_id?: string }).user_id ?? null,
      document_name: j.document_name,
      uploaded_at:   j.created_at,
      total:         s?.total    ?? 0,
      pending:       s?.pending  ?? 0,
      verified:      s?.verified ?? 0,
      approved:      s?.approved ?? 0,
      rejected:      s?.rejected ?? 0,
      last_activity: s?.last_activity ?? j.created_at,
      thumb_url:     s?.thumb_path ? thumbUrlByPath.get(s.thumb_path) ?? null : null,
      needs_crop:    !s,
      // Who is working this file (most recent trainer to verify a crop) + when.
      worked_by:     s?.worker_id ? workerById.get(s.worker_id)?.name ?? "trainer" : null,
      worked_at:     s?.worker_at ?? null,
      // True for batches uploaded via the manual-upload flow (no source doc).
      is_manual:     !(j as { document_url?: string | null }).document_url,
    };
  });

  // Step 5: dedup the trainer view by (user_id + document_name).
  // Same user uploading the same filename multiple times collapses to ONE
  // card here — but the underlying document_jobs and training_dataset rows
  // are NOT deleted; this is purely a display filter for the trainer.
  // Tie-break: prefer the entry with the most crops (richer training data),
  // then the most recently active.
  type Item = typeof allItems[number];
  const bestByKey = new Map<string, Item>();
  for (const it of allItems) {
    const key = `${it.user_id ?? "?"}::${it.document_name}`;
    const cur = bestByKey.get(key);
    if (!cur) { bestByKey.set(key, it); continue; }
    const itScore  = it.total  * 1_000_000_000 + new Date(it.last_activity).getTime();
    const curScore = cur.total * 1_000_000_000 + new Date(cur.last_activity).getTime();
    if (itScore > curScore) bestByKey.set(key, it);
  }
  // Order: files still needing work first, fully-approved files last. A file is
  // "done" when it has crops and none are still pending or awaiting review
  // (everything has been approved/rejected by the admin). Within each group,
  // most-recent activity first.
  const isDone = (it: Item) =>
    it.total > 0 && it.pending === 0 && it.verified === 0 && it.approved > 0;
  const items = Array.from(bestByKey.values()).sort((a, b) => {
    const da = isDone(a) ? 1 : 0;
    const db = isDone(b) ? 1 : 0;
    if (da !== db) return da - db;               // not-done first, done last
    return a.last_activity > b.last_activity ? -1 : 1;
  });

  return NextResponse.json({ items, total: items.length, raw_total: allItems.length });
}
