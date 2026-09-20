"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";

interface DocRow {
  id: string;
  document_name: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

// The date the row is sorted by: a re-upload reuses the job and leaves
// created_at at the original upload, so showing that made a document the user
// had just reprocessed look untouched. For a job never reprocessed the two are
// the same and nothing changes.
function activityDate(job: DocRow): string {
  return job.completed_at ?? job.created_at;
}

const STATUS_DOT: Record<string, string> = {
  completed:  "bg-emerald-500",
  processing: "bg-blue-500 animate-pulse",
  pending:    "bg-amber-400",
  failed:     "bg-red-500",
};

function DeleteButton({ jobId, onDeleted, confirmText }: { jobId: string; onDeleted: () => void; confirmText: string }) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(confirmText)) return;
    setDeleting(true);
    try {
      await fetch(`/api/documents/${jobId}`, { method: "DELETE" });
      onDeleted();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <button
      onClick={handleDelete}
      disabled={deleting}
      title="Delete document"
      className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-40"
    >
      {deleting ? (
        <span className="w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
      ) : (
        <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
      )}
    </button>
  );
}

export default function DocumentsPage() {
  const { lang } = useLang();
  const td = T.docList;
  const ts = T.status;

  const [jobs, setJobs]       = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadJobs() {
    const res = await fetch("/api/documents");
    if (res.ok) {
      const data = await res.json();
      setJobs(data.jobs ?? []);
    }
    setLoading(false);
  }

  useEffect(() => { loadJobs(); }, []);

  function statusLabel(s: string) {
    const map: Record<string, string> = {
      completed:  ts.completed[lang],
      processing: ts.processing[lang],
      pending:    ts.pending[lang],
      failed:     ts.failed[lang],
    };
    return map[s] ?? s;
  }

  return (
    <>
      <div className="max-w-4xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-headline font-semibold text-on-background truncate">{td.title[lang]}</h1>
            <p className="text-xs text-on-surface-variant mt-0.5">
              {jobs.length} {td.subtitle[lang]}
            </p>
          </div>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-white text-xs font-semibold px-3 sm:px-4 py-2 rounded-full transition-all active:scale-95 shrink-0"
            style={{ background: "linear-gradient(135deg,#7c3aed,#6d28d9)", boxShadow: "0 4px 12px rgba(109,40,217,0.25)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>upload</span>
            <span className="hidden sm:inline">{td.uploadNew[lang]}</span>
          </Link>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && jobs.length === 0 && (
          <div className="rounded-2xl bg-surface-container-low border border-outline-variant/10 py-16 text-center">
            <span className="material-symbols-outlined text-on-surface-variant/30 block mb-3" style={{ fontSize: 40 }}>description</span>
            <p className="text-sm font-medium text-on-background mb-1">{td.noFiles[lang]}</p>
            <p className="text-xs text-on-surface-variant mb-5">{td.noFilesDesc[lang]}</p>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-white text-xs font-semibold px-5 py-2 rounded-full"
              style={{ background: "linear-gradient(135deg,#7c3aed,#6d28d9)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>upload</span>
              {td.uploadDoc[lang]}
            </Link>
          </div>
        )}

        {/* File list */}
        {!loading && jobs.length > 0 && (
          <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
            {/* Column headers — hidden on mobile, layout switches to stacked cards */}
            <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-slate-50 border-b border-slate-100">
              <span className="col-span-6 text-[10px] font-bold uppercase tracking-wider text-slate-400">{td.colDocument[lang]}</span>
              <span className="col-span-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">{td.colDate[lang]}</span>
              <span className="col-span-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{td.colStatus[lang]}</span>
              <span className="col-span-1" />
            </div>

            <div className="divide-y divide-slate-50">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className={`hover:bg-violet-50/30 transition-colors group ${job.status === "failed" ? "bg-red-50/40" : ""}`}
                >
                  {/* ── Mobile layout (stacked) ───────────────────────────── */}
                  <div className="sm:hidden flex items-center gap-3 px-4 py-3">
                    <Link href={`/documents/${job.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${job.status === "failed" ? "bg-red-50" : "bg-violet-50"}`}>
                        <span className={`material-symbols-outlined ${job.status === "failed" ? "text-red-400" : "text-violet-400"}`} style={{ fontSize: 16 }}>
                          {job.status === "failed" ? "error" : "description"}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-[#35313a] truncate">{job.document_name || "Untitled"}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[job.status] ?? "bg-gray-400"}`} />
                          <span className={`text-[10px] ${job.status === "failed" ? "text-red-600 font-medium" : "text-slate-500"}`}>
                            {statusLabel(job.status)}
                          </span>
                          <span className="text-[10px] text-slate-300">•</span>
                          <span className="text-[10px] text-slate-400">
                            {new Date(activityDate(job)).toLocaleDateString("en-GB")}
                          </span>
                        </div>
                        {job.error_message && (
                          <p className="text-[10px] text-red-500 truncate mt-0.5" title={job.error_message}>{job.error_message}</p>
                        )}
                      </div>
                    </Link>
                    <DeleteButton
                      jobId={job.id}
                      confirmText={td.deleteConfirm[lang]}
                      onDeleted={() => setJobs((prev) => prev.filter((j) => j.id !== job.id))}
                    />
                  </div>

                  {/* ── Desktop layout (12-col grid) ──────────────────────── */}
                  <div className="hidden sm:grid grid-cols-12 gap-3 items-center px-5 py-3">
                    <Link href={`/documents/${job.id}`} className="col-span-6 flex items-center gap-3 min-w-0">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${job.status === "failed" ? "bg-red-50" : "bg-violet-50"}`}>
                        <span className={`material-symbols-outlined ${job.status === "failed" ? "text-red-400" : "text-violet-400"}`} style={{ fontSize: 14 }}>
                          {job.status === "failed" ? "error" : "description"}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#35313a] truncate">{job.document_name || "Untitled"}</p>
                        {job.error_message && (
                          <p className="text-[10px] text-red-500 truncate" title={job.error_message}>{job.error_message}</p>
                        )}
                      </div>
                    </Link>

                    <Link href={`/documents/${job.id}`} className="col-span-3">
                      <span className="text-xs text-slate-400">
                        {new Date(activityDate(job)).toLocaleDateString("en-GB")}
                      </span>
                    </Link>

                    <Link href={`/documents/${job.id}`} className="col-span-2 flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[job.status] ?? "bg-gray-400"}`} />
                      <span className={`text-[11px] ${job.status === "failed" ? "text-red-600 font-medium" : "text-slate-500"}`}>
                        {statusLabel(job.status)}
                      </span>
                    </Link>

                    <div className="col-span-1 flex justify-end">
                      <DeleteButton
                        jobId={job.id}
                        confirmText={td.deleteConfirm[lang]}
                        onDeleted={() => setJobs((prev) => prev.filter((j) => j.id !== job.id))}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </>
  );
}
