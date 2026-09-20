import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pipelineHeaders } from "@/lib/pipeline";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Auth check
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  // Fetch full job — need structured_data + full_text + fields_json + column_order for Excel regen
  // Service role: migration 032 makes the content columns unreadable by
  // `authenticated`. .eq("user_id") below is therefore the ownership check.
  let reader;
  try {
    reader = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const { data: job, error: jobError } = await reader
    .from("document_jobs")
    .select("id, status, structured_data, full_text, fields_json, document_name, column_order, payment_status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: "المستند غير موجود" }, { status: 404 });
  }

  if (job.status !== "completed") {
    return NextResponse.json(
      { error: "المستند لم يكتمل بعد. انتظر حتى تنتهي المعالجة" },
      { status: 400 }
    );
  }

  // The document page hides an unpaid document, but this route reads
  // structured_data straight from the table and hands back a spreadsheet of it.
  // Without this check the top-up wall is decoration: POST here and the rows
  // arrive in Excel.
  if (job.payment_status === "unpaid") {
    return NextResponse.json(
      { error: "هذا المستند بانتظار الرصيد. أضف رصيداً لفتحه.", locked: true },
      { status: 402 },
    );
  }

  // Call Python server to regenerate Excel from current (possibly edited) structured_data.
  //
  // Local dev: hits FastAPI sub-route on local_server.py (http://localhost:8001/generate-excel).
  // Production: each Modal endpoint has its own URL — appending "/generate-excel" to the
  // process-document URL would 404. Prefer an explicit MODAL_GENERATE_EXCEL_URL env var;
  // fall back to deriving it from the process-document URL by swapping the label suffix.
  function _genExcelUrl(): string {
    const explicit = process.env.MODAL_GENERATE_EXCEL_URL;
    if (explicit) return explicit;
    const proc = process.env.MODAL_PROCESS_DOCUMENT_URL;
    if (proc && proc.includes("modal.run")) {
      return proc.replace("process-document", "generate-excel");
    }
    // Local dev fallback
    return `${proc ?? "http://localhost:8001"}/generate-excel`;
  }
  const genUrl = _genExcelUrl();

  try {
    const genRes = await fetch(genUrl, {
      method: "POST",
      headers: pipelineHeaders(),
      body: JSON.stringify({
        job_id: job.id,
        structured_data: job.structured_data ?? null,
        full_text: job.full_text ?? "",
        document_name: job.document_name ?? "document",
        fields: job.fields_json ?? [],
        column_order: job.column_order ?? null,
      }),
    });

    if (!genRes.ok) {
      const err = await genRes.json().catch(() => ({}));
      const errMsg = (err as { error?: string; detail?: string }).error
        ?? (err as { detail?: string }).detail
        ?? `Python server returned ${genRes.status}`;
      return NextResponse.json({ error: errMsg }, { status: 500 });
    }

    const genData = await genRes.json() as { success: boolean; excel_url?: string; error?: string };
    if (!genData.success || !genData.excel_url) {
      return NextResponse.json(
        { error: genData.error ?? "فشل إنشاء ملف Excel" },
        { status: 500 }
      );
    }

    // Append ?download=<filename> so Supabase serves the file with
    // Content-Disposition: attachment. Without this the browser navigates to
    // the URL (cross-origin → "download" attribute is ignored → popup blocker
    // fires). The download param forces a real file download.
    const safeName = (job.document_name ?? "export")
      .replace(/[^a-zA-Z0-9._\-؀-ۿ ]/g, "_")
      .replace(/\.[^.]+$/, "")  // strip original extension
      .slice(0, 100) + ".xlsx";
    const sep = genData.excel_url.includes("?") ? "&" : "?";
    const downloadUrl = `${genData.excel_url}${sep}download=${encodeURIComponent(safeName)}`;

    return NextResponse.json({ excel_url: downloadUrl, success: true });
  } catch {
    return NextResponse.json(
      { error: "تعذر الاتصال بخادم المعالجة — تأكد من تشغيل local_server.py" },
      { status: 503 }
    );
  }
}
