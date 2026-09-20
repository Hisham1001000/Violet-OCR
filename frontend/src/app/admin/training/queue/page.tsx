"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { InlineCropper } from "@/components/InlineCropper";

// Tab bar (mirror of the one on /admin/training). Both tabs always shown
// here because reaching this page already requires admin (API-gated).
function TrainingTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/training",             label: "Files" },
    { href: "/admin/training/queue",       label: "Review Queue" },
    { href: "/admin/training/trainers",    label: "Trainer Activity" },
    { href: "/admin/training/leaderboard", label: "Leaderboard" },
  ];
  return (
    <div className="border-b border-slate-200 -mb-px overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="flex gap-2 sm:gap-4 min-w-max">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={
                "text-xs sm:text-sm font-semibold py-3 px-1 -mb-px border-b-2 transition-colors whitespace-nowrap " +
                (active
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-slate-500 hover:text-slate-700")
              }
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

interface QueueItem {
  id: string;
  job_id: string;
  document_name: string | null;
  participant_index: number;
  field_name: string;
  crop_path: string;
  crop_url:  string | null;
  context_url: string | null;
  context_box: { x: number; y: number; w: number; h: number } | null;
  ocr_output: string | null;
  label: string | null;
  status: string;
  verified_at: string | null;
  verified_by: string | null;
  verified_by_email: string | null;
}

export default function AdminReviewQueuePage() {
  const [items, setItems]     = useState<QueueItem[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [edits, setEdits]     = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/admin/training/queue?limit=100")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(d.error ?? `HTTP ${r.status}`);
          setItems([]);
          return;
        }
        setItems(d.items ?? []);
        setTotal(d.total ?? 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Network error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function setBusy(id: string, on: boolean) {
    setBusyIds((cur) => {
      const next = new Set(cur);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function decide(id: string, decision: "approve" | "reject") {
    const editedLabel = edits[id];
    const reason = decision === "reject"
      ? (window.prompt("Optional rejection reason (visible in audit log):") ?? "")
      : "";
    setBusy(id, true);
    try {
      const body: Record<string, unknown> = { id, decision };
      if (decision === "approve" && typeof editedLabel === "string") body.label = editedLabel;
      if (decision === "reject"  && reason.trim()) body.reason = reason.trim();
      const res = await fetch("/api/admin/training/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(d.error ?? `Failed: HTTP ${res.status}`);
        return;
      }
      // Optimistic remove
      setItems((cur) => cur.filter((x) => x.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } finally {
      setBusy(id, false);
    }
  }

  return (
    <div className="space-y-5">
      <TrainingTabs />

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Review Queue</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Items verified by trainers, awaiting your final approval. Approve to make
            them eligible for CSV export. Reject to keep for audit only.
          </p>
        </div>
        <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full font-semibold">
          {total} pending review
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
      ) : items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl py-16 text-center px-6">
          <span className="material-symbols-outlined text-emerald-300 mb-3 inline-block" style={{ fontSize: 48 }}>
            inbox
          </span>
          <h2 className="text-sm font-semibold text-slate-700 mb-1">Queue is empty</h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Nothing waiting for review. When trainers verify items, they appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => {
            const editedValue = edits[item.id] ?? (item.label ?? "");
            const isBusy = busyIds.has(item.id);
            return (
              <div key={item.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden flex flex-col">
                {/* Crop editor — the admin can fix a mis-cropped region that a
                   trainer verified. Non-destructive: edits against the wider
                   context image (drag to move/resize; auto-saves). */}
                <InlineCropper
                  cropId={item.id}
                  cropUrl={item.crop_url}
                  contextUrl={item.context_url}
                  contextBox={item.context_box}
                />

                {/* Body */}
                <div className="p-3 flex flex-col gap-2 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-400 truncate" title={item.document_name ?? ""}>
                      {item.document_name ?? "—"}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      #{item.participant_index}
                    </span>
                  </div>

                  {/* OCR original (read-only context) */}
                  <p className="text-[10px] text-slate-400 truncate" title={item.ocr_output ?? ""}>
                    OCR: <span className="text-slate-600">{item.ocr_output ?? "—"}</span>
                  </p>

                  {/* Editable label (admin can fix typos before approving) */}
                  <input
                    dir="rtl"
                    value={editedValue}
                    disabled={isBusy}
                    onChange={(e) =>
                      setEdits((cur) => ({ ...cur, [item.id]: e.target.value }))
                    }
                    className="w-full text-xs px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />

                  {item.verified_by_email && (
                    <p className="text-[10px] text-slate-400">
                      Verified by <span className="text-slate-600">{item.verified_by_email}</span>
                      {item.verified_at && (
                        <> · {new Date(item.verified_at).toLocaleString("en-GB", {
                          dateStyle: "short", timeStyle: "short",
                        })}</>
                      )}
                    </p>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={() => decide(item.id, "approve")}
                      disabled={isBusy}
                      className="flex-1 text-[11px] font-semibold bg-emerald-500 text-white py-1.5 rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors"
                    >
                      {isBusy ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => decide(item.id, "reject")}
                      disabled={isBusy}
                      className="flex-1 text-[11px] font-semibold bg-white border border-red-300 text-red-700 py-1.5 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
