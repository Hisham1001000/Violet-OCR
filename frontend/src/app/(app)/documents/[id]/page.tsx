"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ParticipantTable } from "@/components/ParticipantTable";
import { LockedDocument } from "@/components/LockedDocument";
import { FeedbackPrompt } from "@/components/FeedbackPrompt";
import { addNotification } from "@/lib/notifications";
import { notifyBalanceChanged, markCharged } from "@/lib/balance-events";
import { formatUsd } from "@/lib/billing";
import { DocumentJob } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { lang } = useLang();
  const td = T.docDetail;

  const [job, setJob]             = useState<DocumentJob | null>(null);
  const [loading, setLoading]     = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported]   = useState(false);   // checkmark flash after success
  const [exportError, setExportError] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  // Bumped after a successful reprocess so the polling effect restarts —
  // otherwise polling stays stopped on the previous "failed"/"completed"
  // terminal state and never picks up the new run.
  const [pollVersion, setPollVersion] = useState(0);
  const [userEmail, setUserEmail]     = useState<string | undefined>();

  // ── Tell them what this document cost ─────────────────────────────────────
  // The charge happens on the pipeline, silently, while they watch a progress
  // bar. Money leaving an account with no statement of what for is the thing
  // people rightly distrust, so the moment the job reports settled, say the
  // number: what was taken and how many rows it bought.
  //
  // markCharged keeps it to once per charge — this page polls, so without it
  // the notification would fire on every tick.
  useEffect(() => {
    if (!job || job.status !== "completed") return;
    const cost = job.cost_cents ?? 0;
    const rows = job.row_count ?? 0;

    // just_charged, not merely "paid": opening a document paid for weeks ago
    // must not announce that old charge as a new one. Keyed by the charge, not
    // the job — every run is charged, so one document can be charged again.
    if (job.payment_status === "paid" && cost > 0 && job.just_charged) {
      if (markCharged(`${job.id}:${job.charged_at ?? ""}`)) {
        addNotification(
          lang === "ar"
            ? `تم خصم ${formatUsd(cost)} — ${rows} صف من «${job.document_name}»`
            : `Charged ${formatUsd(cost)} — ${rows} rows from "${job.document_name}"`,
        );
        notifyBalanceChanged();
      }
    }

    if (job.payment_status === "unpaid") {
      if (markCharged(`${job.id}:unpaid:${job.completed_at ?? ""}`)) {
        addNotification(
          lang === "ar"
            ? `«${job.document_name}» جاهز — التكلفة ${formatUsd(cost)} ورصيدك لا يكفي`
            : `"${job.document_name}" is ready — it costs ${formatUsd(cost)} and your balance is short`,
        );
      }
      notifyBalanceChanged();
    }
  }, [job, lang]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUserEmail(d?.user?.email))
      .catch(() => {});
  }, []);

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/documents/${id}`, { cache: "no-store" });
      if (res.status === 401) { router.replace("/auth"); return; }
      if (res.ok) setJob(await res.json());
      setLoading(false);
    }

    setJob(null);
    setLoading(true);
    load();
  }, [id]);

  // Guaranteed UI update flow — does NOT depend on realtime working.
  //
  // Three layers of redundancy:
  //  1. setTimeout-chained polling (not setInterval): each tick re-schedules
  //     itself AFTER the fetch resolves, so a slow request can't pile up and
  //     browser tab-throttling can't permanently desync the loop.
  //  2. visibilitychange listener: forces an immediate refetch the moment
  //     the tab regains focus (background tabs throttle setInterval to 1/min).
  //  3. Supabase realtime subscription: best-effort — if WebSocket fails,
  //     polling still catches completion within 3 s.
  //
  // Polling stops once status reaches a terminal state (completed/failed).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestStatus: string | null = null;
    let tickCount = 0;

    async function refetch(reason: string) {
      try {
        const res = await fetch(`/api/documents/${id}?t=${Date.now()}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (cancelled) return;
        if (res.status === 401) { router.replace("/auth"); return; }
        if (res.ok) {
          const data = await res.json();
          latestStatus = data.status;
          setJob(data);
        }
      } catch (err) {
        console.warn("[poll] refetch failed, will retry", err);
      }
    }

    function schedule() {
      if (cancelled) return;
      if (latestStatus === "completed" || latestStatus === "failed") {
        return;
      }
      timer = setTimeout(async () => {
        tickCount += 1;
        await refetch(`tick #${tickCount}`);
        schedule();
      }, 3000);
    }

    function onVisibility() {
      if (document.visibilityState === "visible" &&
          latestStatus !== "completed" && latestStatus !== "failed") {
        refetch("tab focus");
      }
    }

    // Start polling FIRST — before anything that could throw.
    // If realtime setup or createClient() crashes, polling still runs.
    document.addEventListener("visibilitychange", onVisibility);
    refetch("initial");
    schedule();

    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    try {
      const supabase = createClient();
      channel = supabase
        .channel(`job-${id}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "document_jobs", filter: `id=eq.${id}` },
          () => refetch("realtime event"),
        )
        .subscribe();
    } catch (err) {
      console.warn("[realtime] setup failed — polling will still work", err);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) {
        try { createClient().removeChannel(channel); } catch {}
      }
    };
  }, [id, pollVersion]);

  async function handleReprocess() {
    if (!window.confirm(td.reprocessConfirm[lang])) return;
    setReprocessing(true);
    try {
      const res = await fetch(`/api/documents/${id}/reprocess`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reprocess failed");
      // Optimistically flip to processing so the Analyzing card appears
      // immediately, then bump pollVersion to RESTART the polling effect —
      // otherwise it stays stopped on the previous terminal state and never
      // picks up the new run.
      setJob((prev) => prev
        ? { ...prev, status: "pending", error_message: null }
        : prev
      );
      setPollVersion((v) => v + 1);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : T.common.error[lang]);
    } finally {
      setReprocessing(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/documents/${id}/export`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      // Trigger a direct download via a hidden <a download> click instead of
      // window.open. window.open is treated as a popup and gets blocked when
      // the click is "indirect" (after an async fetch). The anchor + download
      // attribute is the standard popup-safe pattern for file downloads.
      const a = document.createElement("a");
      a.href = data.excel_url;
      a.download = "";  // hint browser to download rather than navigate
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const participants  = job?.structured_data ?? null;
  const colOrderSentinel = job?.fields_json?.find((f) => f.field_name === "__column_order__");
  const columnOrder: string[] | null =
    job?.column_order ??
    (colOrderSentinel ? colOrderSentinel.value.split("||").filter(Boolean) : null);
  const isProcessing     = job?.status === "pending" || job?.status === "processing";
  // The API strips the rows from an unpaid job and sets `locked`, so this is a
  // display flag over data that is genuinely absent, not a client-side curtain
  // drawn over rows that were sent anyway.
  const locked           = job?.payment_status === "unpaid";
  const canExport        = job?.status === "completed" && !locked;
  const participantCount = participants?.length ?? 0;

  return (
    <>
      <div className="space-y-8">

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-32">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-on-surface-variant ml-4">{td.loading[lang]}</p>
          </div>
        )}

        {/* Not found */}
        {!loading && !job && (
          <div className="text-center py-32">
            <p className="text-error mb-4">{td.docNotFound[lang]}</p>
            <button onClick={() => router.push("/documents")} className="text-primary hover:underline text-sm">
              ← {td.backToDocuments[lang]}
            </button>
          </div>
        )}

        {job && (
          <>
            {/* Hero header */}
            <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="space-y-2">
                <button
                  onClick={() => router.push("/documents")}
                  className="text-xs text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1 mb-1"
                >
                  <span className="material-symbols-outlined text-sm">arrow_back</span>
                  {td.backToDocuments[lang]}
                </button>
                <h2 className="text-2xl font-headline font-light tracking-tight text-on-background">
                  {td.extractedDataset[lang]}{" "}
                  <span className="text-primary font-medium">{td.datasetWord[lang]}</span>
                </h2>
                <p className="text-sm text-on-surface-variant max-w-lg">
                  {job.document_name}
                </p>
              </div>
              <div className="flex gap-3" />
            </section>

            {/* Processing — step-based indicator */}
            {isProcessing && <ProcessingCard status={job.status} lang={lang} />}

            {/* Error banner — always shown when failed (task 1) */}
            {job.status === "failed" && (
              <div className="p-5 bg-red-50 border border-red-200 rounded-xl">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <p className="text-red-700 font-semibold mb-1.5 flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>error</span>
                      {td.processingFailed[lang]}
                    </p>
                    <p className="text-red-600 text-sm font-mono break-all">
                      {job.error_message || td.failedNoMessage[lang]}
                    </p>
                  </div>
                  <button
                    onClick={handleReprocess}
                    disabled={reprocessing}
                    className="shrink-0 text-xs font-semibold border border-red-300 text-red-600 px-3.5 py-1.5 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    {reprocessing ? "…" : td.reprocess[lang]}
                  </button>
                </div>
              </div>
            )}

            {exportError && (
              <p className="text-error text-sm">{exportError}</p>
            )}

            {/* Held for credit */}
            {!isProcessing && job.status === "completed" && locked && (
              <LockedDocument
                jobId={id}
                documentName={job.document_name}
                rowCount={job.row_count ?? null}
                costCents={job.cost_cents ?? null}
                balanceCents={job.balance_cents ?? 0}
                shortfallCents={job.shortfall_cents ?? 0}
                userEmail={userEmail}
                onUnlocked={() => setPollVersion((v) => v + 1)}
              />
            )}

            {/* Table */}
            {!isProcessing && job.status === "completed" && !locked && (
              <section className="bg-surface-container-low p-1 rounded-lg">
                {participants && participants.length > 0 ? (
                  <div className="bg-white rounded-lg shadow-sm overflow-hidden">
                    <ParticipantTable
                      key={`${id}-${job?.completed_at || ""}`}
                      jobId={id}
                      participants={participants}
                      columnOrder={columnOrder}
                      onSaved={() => {}}
                      onExport={handleExport}
                      exporting={exporting}
                      exported={exported}
                      canExport={canExport}
                    />
                  </div>
                ) : (
                  <div className="p-10 text-center">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                      <span className="material-symbols-outlined text-primary">table_view</span>
                    </div>
                    <p className="text-on-surface-variant text-sm">
                      {td.noParticipants[lang]}
                    </p>
                  </div>
                )}
              </section>
            )}

          </>
        )}
      </div>

      {/* Asked once, a minute or two after the table is on screen — never over
          it, and never for a document still behind the top-up wall. */}
      {job?.status === "completed" && !locked && participantCount > 0 && (
        <FeedbackPrompt jobId={id} ready />
      )}
    </>
  );
}

/* ── Processing step indicator ─────────────────────────────────────── */
// Circle 0 ("File Sent") is immediately done — the job exists.
// Circle 1 pulses while pending; flashes + checks when processing starts.
// Circles 2, 3 follow same pattern driven by elapsed time within processing.
// Card unmounts when backend status = "completed" or "failed".

const STEPS = [
  { en: "File Sent",   ar: "تم الإرسال",  icon: "upload_file" },
  { en: "Processing",  ar: "معالجة",      icon: "document_scanner" },
  { en: "Extracting",  ar: "استخراج",     icon: "table_chart" },
  { en: "Finalizing",  ar: "الإتمام",     icon: "task_alt" },
];
const SEG_DURATION_1 = 80000;  // ms for segment 1→2 (OCR: Vision + Azure + Gemini ~90s)
const SEG_DURATION_2 = 60000;  // ms for segment 2→3 (Structuring + Excel ~60s)

// Non-linear easing — "rush → drift → push" within each segment.
// Produces move→pause→move feel without changing total timing.
// Returns value in [0, 1.002] — slightly past 1 so completedIndex always triggers.
function segEase(t: number): number {
  if (t <= 0)  return 0;
  if (t >= 1)  return 1.002;             // slightly past circle center → triggers flash
  if (t < 0.35) return (t / 0.35) * 0.68;          // phase 1: rush to 68%
  if (t < 0.60) return 0.68 + ((t - 0.35) / 0.25) * 0.03; // phase 2: pause/drift 68→71%
  return        0.71 + ((t - 0.60) / 0.40) * 0.29; // phase 3: push 71→100%
}

function ProcessingCard({ status, lang }: { status: string; lang: string }) {
  const [processingSince, setProcessingSince] = useState<number | null>(null);
  const [progress, setProgress]               = useState(0); // 0–100
  const [flashSet, setFlashSet]               = useState<Set<number>>(new Set());
  // prevCompletedRef starts at 0: circle 0 is already done at mount, no initial flash
  const prevCompletedRef = useRef(0);

  const N   = STEPS.length;      // 4
  const SEG = 100 / (N - 1);    // 33.333…

  // completedIndex: all circles ≤ this index show a checkmark.
  // Starts at 0 (circle 0 "File Sent" is done the moment the page loads).
  const completedIndex  = Math.min(Math.floor(progress / SEG), N - 1);
  // approachingIndex: the next circle ahead of the fill — continuously pulsing.
  const approachingIndex = Math.min(completedIndex + 1, N - 1);

  // Record when status first becomes "processing"
  useEffect(() => {
    if (status === "processing" && processingSince === null) {
      setProcessingSince(Date.now());
    }
  }, [status, processingSince]);

  // Fire one-shot flash when a new circle is completed
  useEffect(() => {
    if (completedIndex > prevCompletedRef.current) {
      const justDone = completedIndex;
      prevCompletedRef.current = completedIndex;
      setFlashSet(prev => new Set(prev).add(justDone));
      setTimeout(() => setFlashSet(prev => {
        const s = new Set(prev); s.delete(justDone); return s;
      }), 480);
    }
  }, [completedIndex]);

  // 50ms ticker — backend-gated, non-linear motion
  useEffect(() => {
    if (status !== "processing" && status !== "pending") return;

    const ticker = setInterval(() => {
      if (status === "pending") {
        // Creep toward circle 1 but never reach it — backend flip will complete it
        setProgress(p => Math.min(p + 0.10, 28));
        return;
      }
      if (!processingSince) return;

      setProgress(p => {
        // If we haven't crossed circle-1 threshold yet, rush there in ~100ms
        if (p < SEG) return Math.min(p + 2.2, SEG + 0.04);

        // Non-linear eased motion through segments 1 and 2
        const elapsed = Date.now() - processingSince;
        const s1 = segEase(Math.min(elapsed / SEG_DURATION_1, 1));
        const s2 = segEase(Math.min(Math.max((elapsed - SEG_DURATION_1) / SEG_DURATION_2, 0), 1));
        const computed = SEG + s1 * SEG + s2 * SEG;

        // Monotonically increasing, capped just before circle 3 center
        return Math.min(Math.max(p, computed), 99.8);
      });
    }, 50);

    return () => clearInterval(ticker);
  }, [status, processingSince]);

  // Layout: space-between → circle 0 at left edge, circle 3 at right edge.
  // Track uses pixel offsets (left: SZ/2, right: SZ/2) so math is exact:
  // fill at 33.33% of track = circle-1 center for any container width.
  const SZ = 24;

  return (
    <div style={{
      background: "#fff",
      border: "1px solid #f1f5f9",
      borderRadius: 16,
      padding: "28px 32px 22px",
      boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
    }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", margin: "0 0 4px" }}>
          {lang === "ar" ? "جارٍ تحليل المستند…" : "Analyzing your document…"}
        </p>
        <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>
          {lang === "ar" ? "يستغرق عادةً ٢–٣ دقائق" : "This usually takes 2–3 minutes"}
        </p>
      </div>

      {/* Steps — paddingBottom reserves room for absolute labels */}
      <div style={{
        position: "relative",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        paddingBottom: 26,
        direction: "ltr",
      }}>
        {/* Single track: left = circle-0 center, right = circle-3 center (pixel-exact) */}
        <div style={{
          position: "absolute",
          top: SZ / 2 - 0.75,
          left: SZ / 2,
          right: SZ / 2,
          height: 1.5,
          background: "#ebebf5",
          overflow: "hidden",
          zIndex: 0,
        }}>
          <div style={{
            height: "100%",
            background: "linear-gradient(90deg,#8b5cf6,#a855f7)",
            width: `${progress}%`,
            transition: "width 50ms linear",
          }} />
        </div>

        {/* Circles */}
        {STEPS.map((step, i) => {
          const done        = i <= completedIndex;
          const approaching = i === approachingIndex && i > completedIndex;
          const flashing    = flashSet.has(i);

          return (
            <div key={i} style={{ position: "relative", zIndex: 1 }}>
              {/* Circle body — soft-pulse and circle-flash both on this element */}
              <div style={{
                width: SZ, height: SZ,
                borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: done
                  ? "linear-gradient(135deg,#8b5cf6,#6d28d9)"
                  : "#fff",
                border: done
                  ? "none"
                  : approaching
                  ? "1.5px solid rgba(124,58,237,0.65)"
                  : "1.5px solid #e9e9f5",
                boxShadow: flashing || approaching
                  ? "none"   // keyframe owns box-shadow during animation
                  : done
                  ? "0 1px 8px rgba(109,40,217,0.18)"
                  : "none",
                animation: flashing
                  ? "circle-flash 520ms cubic-bezier(0.22,1,0.36,1) forwards"
                  : approaching
                  ? "soft-pulse 2.4s ease-in-out infinite"
                  : "none",
                transition: flashing || approaching
                  ? "none"
                  : "background 0.45s, border-color 0.3s, box-shadow 0.3s",
              }}>
                {done
                  ? <span
                      className="material-symbols-outlined"
                      style={{
                        fontSize: 11, color: "#fff",
                        fontVariationSettings: "'FILL' 1,'wght' 700",
                        display: "block",
                        animation: flashing ? "check-in 240ms ease-out forwards" : "none",
                      }}
                    >check</span>
                  : <span className="material-symbols-outlined" style={{
                      fontSize: 11,
                      color: approaching ? "#7c3aed" : "#d4d4d8",
                      fontVariationSettings: approaching ? "'FILL' 1" : "'FILL' 0",
                      transition: "color 0.3s",
                    }}>{step.icon}</span>
                }
              </div>

              {/* Label */}
              <p style={{
                position: "absolute",
                top: SZ + 8,
                left: "50%",
                transform: "translateX(-50%)",
                whiteSpace: "nowrap",
                margin: 0,
                fontSize: 10,
                fontWeight: approaching ? 600 : done ? 500 : 400,
                color: approaching ? "#7c3aed" : done ? "#4b5563" : "#9ca3af",
                lineHeight: 1,
                transition: "color 0.3s, font-weight 0s",
              }}>
                {lang === "ar" ? step.ar : step.en}
              </p>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ paddingTop: 14, borderTop: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 11, color: "#c4b5fd" }}>verified</span>
        <p style={{ fontSize: 10, color: "#a8a8c0", margin: 0, letterSpacing: "0.01em" }}>
          {lang === "ar" ? "دقة عالية · مدعوم بالذكاء الاصطناعي" : "High accuracy · AI-powered OCR"}
        </p>
      </div>

      <style>{`
        /* Soft ring pulse on approaching circle — box-shadow expansion, no scaling */
        @keyframes soft-pulse {
          0%, 100% { box-shadow: 0 0 0 0px  rgba(124,58,237,0.42); }
          55%       { box-shadow: 0 0 0 6px  rgba(124,58,237,0.08); }
        }
        /* Bloom flash on completion — soft outward glow that fades */
        @keyframes circle-flash {
          0%   { box-shadow: 0 0 0 0px  rgba(139,92,246,0.75), 0 1px 8px rgba(109,40,217,0.22); }
          30%  { box-shadow: 0 0 0 7px  rgba(139,92,246,0.18), 0 1px 8px rgba(109,40,217,0.22); }
          100% { box-shadow: 0 0 0 14px rgba(139,92,246,0),    0 1px 8px rgba(109,40,217,0.22); }
        }
        /* Checkmark scale-in on circle completion */
        @keyframes check-in {
          from { transform: scale(0.3) rotate(-20deg); opacity: 0; }
          to   { transform: scale(1)   rotate(0deg);   opacity: 1; }
        }
      `}</style>
    </div>
  );
}
