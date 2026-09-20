import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/admin";

// GET /api/admin/training/export?status=approved
//
// Streams a CSV of every training_dataset row with a fresh signed image URL
// per crop. Default `status=approved` — only rows that have passed BOTH
// trainer verification AND admin approval are exported. Pass `status=all`
// to dump everything (debug/audit only).
//
// Columns:
//   id, job_id, participant_index, field_name, ocr_output, label, status, crop_url
//
// Use this CSV directly to feed an OCR training script — fetch each crop_url
// to get the image, use `label` as the ground truth.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  const status = req.nextUrl.searchParams.get("status") ?? "approved";

  const admin = createAdminClient();

  // Pull rows in pages of 1000 to handle large datasets without OOM.
  type Row = {
    id: string;
    job_id: string;
    participant_index: number;
    field_name: string;
    crop_path: string;
    ocr_output: string | null;
    label: string | null;
    status: string;
  };
  const rows: Row[] = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    let q = admin
      .from("training_dataset")
      .select("id, job_id, participant_index, field_name, crop_path, ocr_output, label, status")
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (status && status !== "all") q = q.eq("status", status);

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    if (offset > 100_000) break;  // hard safety
  }

  // Sign all crop URLs in batches of 100 (signed URL API supports an array)
  const urlByPath = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    try {
      const { data: signed } = await admin.storage
        .from("training_crops")
        .createSignedUrls(slice.map((r) => r.crop_path), 3600 * 24 * 7);  // 7-day expiry
      for (const s of signed ?? []) {
        if (s?.path && s?.signedUrl) urlByPath.set(s.path, s.signedUrl);
      }
    } catch {
      // best-effort — rows whose URL fails to sign just get an empty crop_url
    }
  }

  // Build CSV. Quote fields, escape embedded quotes, normalise newlines.
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""').replace(/\r?\n/g, " ");
    return `"${s}"`;
  };
  const header = ["id", "job_id", "participant_index", "field_name", "ocr_output", "label", "status", "crop_url"];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    const url = urlByPath.get(r.crop_path) ?? "";
    lines.push([
      escape(r.id),
      escape(r.job_id),
      escape(r.participant_index),
      escape(r.field_name),
      escape(r.ocr_output),
      escape(r.label),
      escape(r.status),
      escape(url),
    ].join(","));
  }
  const csv = lines.join("\n");

  const filename = `training_dataset_${status}_${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "no-store",
    },
  });
}
