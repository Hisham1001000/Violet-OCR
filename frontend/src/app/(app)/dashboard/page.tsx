"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { TopUpModal } from "@/components/TopUpModal";
import { formatUsd } from "@/lib/billing";
import type { UsageResponse } from "@/lib/types";
import { notifyBalanceChanged } from "@/lib/balance-events";
import Link from "next/link";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";
import { addNotification } from "@/lib/notifications";

// Pages-per-upload limit per plan
// Per-upload page limits are gone: billing is per extracted row, so a longer
// document simply costs more rather than being refused.
const PLAN_ORDER:   Record<string, number> = { free: 0, starter: 1, standard: 2, pro: 3   };

// Reads the first 150 KB of a PDF and extracts the /Count field (total page count).
// Returns null if the file is not a PDF or the count can't be determined.
async function getPdfPageCount(file: File): Promise<number | null> {
  if (!file.name.toLowerCase().endsWith(".pdf")) return 1; // images are always 1 page
  try {
    const slice = await file.slice(0, Math.min(file.size, 150_000)).arrayBuffer();
    const text  = new TextDecoder("latin1").decode(slice);
    const m     = text.match(/\/Count\s+(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

interface RecentJob {
  id: string;
  document_name: string;
  status: string;
  created_at: string;
  structured_data: unknown[] | null;
}

const STATUS_DOT: Record<string, string> = {
  completed:  "bg-emerald-500",
  processing: "bg-blue-500 animate-pulse",
  pending:    "bg-amber-400",
  failed:     "bg-red-500",
};

export default function DashboardPage() {
  const router = useRouter();
  const { lang } = useLang();
  const t = T.dashboard;
  const ts = T.status;

  const [uploading, setUploading]   = useState(false);
  const [progress, setProgress]     = useState(0);
  const [fileName, setFileName]     = useState<string | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [dragOver, setDragOver]     = useState(false);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [usage, setUsage]           = useState<UsageResponse | null>(null);
  const [userEmail, setUserEmail]   = useState<string | undefined>();
  const [topUpOpen, setTopUpOpen]       = useState(false);
  const inputRef      = useRef<HTMLInputElement>(null);
  const cameraRef     = useRef<HTMLInputElement>(null);
  const galleryRef    = useRef<HTMLInputElement>(null);
  // AbortController lives across renders so the Cancel button can call abort()
  const abortRef      = useRef<AbortController | null>(null);

  function cancelUpload() {
    abortRef.current?.abort();
    abortRef.current = null;
    setUploading(false);
    setProgress(0);
    setFileName(null);
    setError(null);
  }

  useEffect(() => {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => setRecentJobs((d.jobs ?? []).slice(0, 5)))
      .catch(() => {});

    fetch("/api/usage")
      .then((r) => r.json())
      .then((d: UsageResponse & { is_admin?: boolean; is_trainer?: boolean }) => {
        setUsage(d);
        // The plan-upgrade notification lived here. There are no plans to be
        // upgraded between any more -- the balance strip below shows what a
        // person actually needs to know about their account.

        // ── Role-grant notification ───────────────────────────────────────
        // Same pattern as the plan upgrade: only fires once per role grant
        // (uses localStorage flag, AND addNotification's own dedup window).
        // Fires only when the role flips from false → true. Going the other
        // way (revoke) is silent — no need to surface it to the user here.
        const lastAdmin   = localStorage.getItem("violet_role_admin")   === "1";
        const lastTrainer = localStorage.getItem("violet_role_trainer") === "1";
        if (d.is_admin && !lastAdmin) {
          addNotification(
            lang === "ar"
              ? "🛡️ تم منحك صلاحيات المسؤول (Admin)"
              : "🛡️ You've been granted Admin access"
          );
        }
        if (d.is_trainer && !lastTrainer) {
          addNotification(
            lang === "ar"
              ? "🎓 تم منحك صلاحيات المُدرّب (Trainer)"
              : "🎓 You've been granted Trainer access"
          );
        }
        localStorage.setItem("violet_role_admin",   d.is_admin   ? "1" : "0");
        localStorage.setItem("violet_role_trainer", d.is_trainer ? "1" : "0");
      })
      .catch(() => {});

    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setUserEmail(d?.user?.email))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(file: File) {
    if (uploading) return;

    // Only that there IS credit. What the document costs cannot be known until
    // it has been read, so a sheet bigger than the balance is processed and
    // then held on its own page rather than refused here.
    if (usage && !usage.can_upload) {
      setTopUpOpen(true);
      return;
    }
    setError(null);

    setUploading(true);
    setError(null);
    setFileName(file.name);
    setProgress(15);

    const form = new FormData();
    form.append("file", file);

    const controller  = new AbortController();
    abortRef.current  = controller;

    try {
      setProgress(45);
      const res = await fetch("/api/upload", { method: "POST", body: form, signal: controller.signal });
      setProgress(85);
      const data = await res.json();
      if (res.status === 402 || data.insufficient_balance) {
        setUploading(false);
        setProgress(0);
        notifyBalanceChanged();   // TopBar refetches; no second call from here
        setTopUpOpen(true);
        return;
      }
      // Duplicate file (same SHA-256 already uploaded by this user) — open the
      // original job instead of creating a copy.
      if (res.status === 409 && data.duplicate && data.job_id) {
        router.push(`/documents/${data.job_id}`);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setProgress(100);
      abortRef.current = null;
      router.push(`/documents/${data.job_id}`);
    } catch (err: unknown) {
      // User-initiated cancel — already cleaned up by cancelUpload(); skip silently.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unexpected error");
      setUploading(false);
      setProgress(0);
      abortRef.current = null;
    }
  }

  function statusLabel(s: string) {
    const map: Record<string, string> = {
      completed:  ts.completed[lang],
      processing: ts.processing[lang],
      pending:    ts.pending[lang],
      failed:     ts.failed[lang],
    };
    return map[s] ?? s;
  }

  const balance = usage?.balance_cents ?? 0;
  const noCredit = !!usage && balance <= 0;
  const lowCredit = !!usage && balance > 0 && balance < 25;

  return (
    <>
      <TopUpModal
        open={topUpOpen}
        onClose={() => {
          setTopUpOpen(false);
          notifyBalanceChanged();
        }}
        balanceCents={balance}
        userEmail={userEmail}
      />
      <div className="max-w-5xl mx-auto space-y-8">

        {/* Upload zone */}
        <section>
          <div
            className={`relative group rounded-2xl border-2 border-dashed transition-all duration-300 cursor-pointer
              ${dragOver
                ? "border-primary/60 bg-primary/5"
                : "border-outline-variant/30 hover:border-primary/40 bg-surface-container-lowest"
              }`}
            onClick={() => !uploading && inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            <div className="absolute -inset-3 bg-gradient-to-tr from-primary/8 via-transparent to-tertiary/8 rounded-2xl blur-2xl opacity-0 group-hover:opacity-100 transition duration-700 pointer-events-none" />

            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ""; } }}
              disabled={uploading}
            />
            {/* Mobile: camera capture */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ""; } }}
              disabled={uploading}
            />
            {/* Mobile: gallery / files */}
            <input
              ref={galleryRef}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = ""; } }}
              disabled={uploading}
            />

            <div className="relative flex flex-col items-center py-8 sm:py-12 px-4 sm:px-8">
              <div className={`w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex items-center justify-center mb-3 sm:mb-4 transition-transform duration-300 ${dragOver ? "scale-110 bg-primary/15" : "bg-primary/10 group-hover:scale-105"}`}>
                <span className="material-symbols-outlined text-primary" style={{ fontSize: 26 }}>upload_file</span>
              </div>

              <h3 className="font-headline font-semibold text-base sm:text-lg text-on-background mb-1 text-center">
                {uploading ? `${t.uploading[lang]} ${fileName}…` : t.uploadDoc[lang]}
              </h3>
              <p className="text-xs text-on-surface-variant mb-4 sm:mb-5 text-center">
                {dragOver ? t.dropNow[lang] : t.dragDrop[lang]}
              </p>

              {!uploading && (
                <>
                  {/* Desktop: single browse button */}
                  <div className="hidden sm:block bg-gradient-to-r from-primary to-primary-dim text-white text-xs font-semibold px-5 py-2 rounded-full shadow-md shadow-primary/20 hover:shadow-primary/30 transition-all active:scale-95">
                    {t.browse[lang]}
                  </div>
                  {/* Mobile: gallery + camera split */}
                  <div className="flex sm:hidden gap-2 w-full max-w-xs">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-gradient-to-r from-primary to-primary-dim text-white text-xs font-semibold px-3 py-2.5 rounded-full shadow-md shadow-primary/20 active:scale-95"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>photo_library</span>
                      {lang === "ar" ? "المعرض" : "Gallery"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-primary/30 text-primary text-xs font-semibold px-3 py-2.5 rounded-full active:scale-95"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>photo_camera</span>
                      {lang === "ar" ? "الكاميرا" : "Camera"}
                    </button>
                  </div>
                </>
              )}

              {uploading && (
                <div className="w-full max-w-sm mt-2">
                  <div className="flex justify-between text-[10px] text-on-surface-variant mb-1.5">
                    <span className="truncate max-w-[180px]">{fileName}</span>
                    <span className="text-primary font-bold">{progress}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-surface-container rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-primary-dim rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); cancelUpload(); }}
                    className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant hover:text-error transition-colors"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>close</span>
                    {t.cancel[lang]}
                  </button>
                </div>
              )}

              <div className="mt-5 flex items-center gap-1.5 text-[10px] text-on-surface-variant/50 uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 12 }}>lock</span>
                {t.encrypted[lang]}
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-xs text-error bg-error/5 border border-error/15 rounded-xl px-4 py-2.5 text-center">
              {error}
            </p>
          )}

        </section>

        {/* Balance */}
        {usage && (
          <section
            className={`rounded-2xl border p-4 flex items-center gap-4 ${
              noCredit
                ? "bg-red-50 border-red-200"
                : lowCredit
                ? "bg-amber-50 border-amber-200"
                : "bg-surface-container-lowest border-outline-variant/10 editorial-shadow"
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-[11px] font-medium text-on-surface-variant">
                  {lang === "ar" ? "الرصيد" : "Balance"}
                </span>
                <span dir="ltr" className={`text-[13px] font-bold ${noCredit ? "text-red-600" : "text-on-background"}`}>
                  {formatUsd(balance)}
                </span>
              </div>
              <p className="text-[11px] text-on-surface-variant">
                {noCredit
                  ? (lang === "ar" ? "أضف رصيداً لمعالجة المستندات" : "Add credit to process documents")
                  : (lang === "ar"
                      ? `يكفي لنحو ${usage.rows_affordable.toLocaleString()} صف`
                      : `Enough for about ${usage.rows_affordable.toLocaleString()} rows`)}
              </p>
            </div>
            {(noCredit || lowCredit) && (
              <button
                onClick={() => setTopUpOpen(true)}
                className={`shrink-0 text-[11px] font-semibold px-3.5 py-2 rounded-xl transition-colors whitespace-nowrap ${
                  noCredit
                    ? "bg-slate-800 text-white hover:bg-slate-700"
                    : "border border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100"
                }`}
              >
                {lang === "ar" ? "إضافة رصيد" : "Add credit"}
              </button>
            )}
          </section>
        )}

        {/* Recent files */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-on-background">{t.recentFiles[lang]}</h2>
            <Link href="/documents" className="text-[11px] text-primary hover:underline flex items-center gap-1">
              {t.viewAll[lang]}
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>arrow_forward</span>
            </Link>
          </div>

          {recentJobs.length === 0 ? (
            <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 py-10 text-center">
              <span className="material-symbols-outlined text-on-surface-variant/30 mb-2 block" style={{ fontSize: 32 }}>inbox</span>
              <p className="text-xs text-on-surface-variant">{t.noFiles[lang]}</p>
            </div>
          ) : (
            <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/10 editorial-shadow overflow-hidden divide-y divide-outline-variant/10">
              {recentJobs.map((job) => {
                const dot = STATUS_DOT[job.status] ?? "bg-gray-400";
                return (
                  <Link
                    key={job.id}
                    href={`/documents/${job.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-surface-container-low transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-primary/8 flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-primary" style={{ fontSize: 15 }}>description</span>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-on-background truncate max-w-[220px]">{job.document_name}</p>
                        <p className="text-[10px] text-on-surface-variant mt-0.5">
                          {new Date(job.created_at).toLocaleDateString("en-GB")}
                          {job.structured_data?.length ? ` · ${job.structured_data.length} ${t.participants[lang]}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                      <span className="text-[10px] text-on-surface-variant">{statusLabel(job.status)}</span>
                      <span className="material-symbols-outlined text-on-surface-variant/40" style={{ fontSize: 14 }}>chevron_right</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </>
  );
}
