import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin, logAudit } from "@/lib/admin";

// GET /api/admin/documents/[id] — full document detail + signed preview URL
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;

  // Fetch the job WITHOUT embedding user_profiles — the FK target is auth.users,
  // not user_profiles, so PostgREST can't resolve the embed and 500s. We hydrate
  // owner data with a separate query below.
  // Service role: migration 032 revokes the content columns from
  // `authenticated`, and an admin is an ordinary Postgres role carrying a
  // profile flag. The assertAdmin guard above is the authorisation check.
  const contentReader = createAdminClient();
  const { data: job, error } = await contentReader
    .from("document_jobs")
    .select(
      "id, user_id, document_name, status, document_url, structured_data, column_order, fields_json, error_message, created_at, completed_at"
    )
    .eq("id", params.id)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Hydrate owner profile (may be null if profile row is missing).
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email, full_name, plan")
    .eq("user_id", job.user_id)
    .maybeSingle();

  // Generate a short-lived signed URL so the admin can preview the original
  // upload (PDF/image). MUST use the admin (service-role) client — the user-
  // scoped client can't sign URLs for files owned by other users (storage RLS
  // blocks it silently, returning null). The admin client bypasses RLS.
  // Also: surface a precise reason when preview is unavailable so admins know
  // whether it's a missing storage path, missing file, or a config issue.
  let preview_url: string | null = null;
  let preview_error: string | null = null;
  if (!job.document_url) {
    preview_error = "No file was saved for this document (document_url is empty).";
  } else {
    try {
      const admin = createAdminClient();
      const { data: signed, error: signErr } = await admin.storage
        .from("documents")
        .createSignedUrl(job.document_url, 3600);
      if (signErr) {
        preview_error = `Storage error: ${signErr.message}. Path: ${job.document_url}`;
      } else if (!signed?.signedUrl) {
        preview_error = `File not found in storage at: ${job.document_url}`;
      } else {
        preview_url = signed.signedUrl;
      }
    } catch (e) {
      preview_error = `Preview unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return NextResponse.json(
    { ...job, user_profiles: profile ?? null, preview_url, preview_error },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// DELETE /api/admin/documents/[id]
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  // Fetch document name first for audit log
  const { data: doc } = await supabase
    .from("document_jobs")
    .select("document_name, user_id")
    .eq("id", params.id)
    .single();

  const { error } = await supabase
    .from("document_jobs")
    .delete()
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, user.id, adminEmail, "document.deleted", "document", params.id, {
    document_name: doc?.document_name,
    owner_user_id: doc?.user_id,
  });

  return NextResponse.json({ success: true });
}

// PATCH /api/admin/documents/[id] — update status (approve / reject)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const result = await assertAdmin(supabase);
  if (result instanceof NextResponse) return result;
  const { user, adminEmail } = result;

  const body = await req.json().catch(() => ({}));
  const validStatuses = ["pending", "processing", "completed", "failed"];
  if (body.status && !validStatuses.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.status) updates.status = body.status;

  const { error } = await supabase
    .from("document_jobs")
    .update(updates)
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, user.id, adminEmail, "document.updated", "document", params.id, updates);
  return NextResponse.json({ success: true });
}
