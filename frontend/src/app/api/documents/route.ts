import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const FIELDS = "id, document_name, status, created_at, completed_at, error_message";
const PAGE   = 50;

/** When the job last did something: its reprocess, or its upload. */
function lastActivity(j: { created_at: string; completed_at: string | null }) {
  return new Date(j.completed_at ?? j.created_at).getTime();
}

export async function GET() {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Re-uploading a file reuses the existing job, so its created_at stays at the
  // ORIGINAL upload. Ordering by created_at alone left a document the user had
  // just reprocessed sitting wherever it was before, looking untouched — and
  // with a 50-row window it could be pushed off the list entirely.
  //
  // Two windows, merged: the newest uploads and the newest completions. Ordering
  // by a COALESCE would need a view, and this is two indexed reads.
  const [byCreated, byCompleted] = await Promise.all([
    supabase.from("document_jobs").select(FIELDS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }).limit(PAGE),
    supabase.from("document_jobs").select(FIELDS)
      .eq("user_id", user.id)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false }).limit(PAGE),
  ]);

  const error = byCreated.error ?? byCompleted.error;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const merged = new Map<string, Record<string, unknown>>();
  for (const j of [...(byCreated.data ?? []), ...(byCompleted.data ?? [])]) {
    merged.set(j.id as string, j);
  }
  const jobs = Array.from(merged.values())
    .sort((a, b) =>
      lastActivity(b as never) - lastActivity(a as never))
    .slice(0, PAGE);

  return NextResponse.json({ jobs });
}
