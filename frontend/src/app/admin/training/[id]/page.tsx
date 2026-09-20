"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { InlineCropper } from "@/components/InlineCropper";

interface TrainingItem {
  id: string;
  job_id: string;
  participant_index: number;
  field_name: string;
  crop_path: string;
  crop_url: string | null;
  context_url: string | null;
  context_box: { x: number; y: number; w: number; h: number } | null;
  ocr_output: string | null;
  label: string | null;
  status: "pending" | "verified" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}

const AUTO_SAVE_AFTER_EDITS = 10;     // flush after this many pending edits
const AUTO_SAVE_IDLE_MS     = 5000;   // or after this idle period

export default function TrainingFileDetailPage() {
  const { id: jobId } = useParams<{ id: string }>();
  const router = useRouter();
  const [items, setItems]     = useState<TrainingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [docName, setDocName] = useState<string>("");
  const [recropping, setRecropping] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Admin probe — delete is admin-only (the endpoint enforces it too).
  useEffect(() => {
    fetch("/api/admin/training/queue?limit=1").then((r) => setIsAdmin(r.ok)).catch(() => setIsAdmin(false));
  }, []);

  async function deleteFile() {
    if (!jobId) return;
    if (!window.confirm(`Delete "${docName || "this file"}" permanently?\n\nThis removes the uploaded file and ALL its crops/training rows. This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/training/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`Delete failed: ${d.error ?? "unknown"}`); return; }
      router.push("/admin/training");
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setDeleting(false);
    }
  }

  // ── Auto-save state ────────────────────────────────────────────────────────
  // Map of id → pending updates. Flushed on threshold or idle, on unmount, and
  // before page navigation.
  const pendingRef        = useRef<Map<string, { label?: string; status?: TrainingItem["status"] }>>(new Map());
  const idleTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savingState, setSavingState] = useState<"idle" | "queued" | "saving" | "error">("idle");
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSavedAt, setLastSavedAt]   = useState<Date | null>(null);

  const load = useCallback(() => {
    if (!jobId) return;
    setLoading(true);
    setErrorMsg(null);
    Promise.all([
      fetch(`/api/admin/training?flat=1&job_id=${jobId}&status=all&limit=200`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : `HTTP ${r.status}`);
          return (d.items as TrainingItem[]) ?? [];
        }),
      // Best-effort doc-name lookup (admins only — trainers may 403, that's fine)
      fetch(`/api/admin/documents/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([list, jobDoc]) => {
        setItems(list);
        if (jobDoc?.document_name) setDocName(jobDoc.document_name);
      })
      .catch((e) => setErrorMsg(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  // ── Auto-save flush ────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    if (pendingRef.current.size === 0) return;
    const updates = Array.from(pendingRef.current, ([id, patch]) => ({ id, ...patch }));
    pendingRef.current = new Map();
    setPendingCount(0);
    setSavingState("saving");
    try {
      const res = await fetch("/api/admin/training/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof d.error === "string" ? d.error : `HTTP ${res.status}`);
      setLastSavedAt(new Date());
      setSavingState("idle");
    } catch {
      // Restore the pending edits so they aren't lost on a transient failure.
      for (const u of updates) pendingRef.current.set(u.id, u);
      setPendingCount(pendingRef.current.size);
      setSavingState("error");
    }
  }, []);

  // Queue an edit + schedule auto-save
  const queueEdit = useCallback((id: string, patch: { label?: string; status?: TrainingItem["status"] }) => {
    const prev = pendingRef.current.get(id) ?? {};
    pendingRef.current.set(id, { ...prev, ...patch });
    setPendingCount(pendingRef.current.size);
    setSavingState("queued");

    // Reset idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(flush, AUTO_SAVE_IDLE_MS);

    // Threshold flush
    if (pendingRef.current.size >= AUTO_SAVE_AFTER_EDITS) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      flush();
    }
  }, [flush]);

  // Flush on unmount + before navigation
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingRef.current.size > 0) {
        // Best-effort sync save via sendBeacon (fire-and-forget)
        const updates = Array.from(pendingRef.current, ([id, patch]) => ({ id, ...patch }));
        try {
          navigator.sendBeacon(
            "/api/admin/training/batch",
            new Blob([JSON.stringify({ updates })], { type: "application/json" }),
          );
        } catch { /* ignore */ }
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      flush();   // last attempt on unmount
    };
  }, [flush]);

  function applyEdit(id: string, patch: { label?: string; status?: TrainingItem["status"] }) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    queueEdit(id, patch);
  }

  // ── Bulk selection ─────────────────────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected]     = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function clearSelection() { setSelected(new Set()); }
  function selectAllEligible() {
    setSelected(new Set(items.filter((it) => it.status !== "approved" && it.label?.trim()).map((it) => it.id)));
  }

  // Bulk-set status for all selected rows that are eligible, then flush to the
  // server in one batch.
  async function bulkSetStatus(status: TrainingItem["status"]) {
    const ids = Array.from(selected);
    let applied = 0, skipped = 0;
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      // Verifying/approving needs a label; never touch already-approved rows.
      if (!it || it.status === "approved" || !it.label?.trim()) { skipped++; continue; }
      applyEdit(id, { status });
      applied++;
    }
    await flush();
    clearSelection();
    setSelectMode(false);
    if (skipped > 0) alert(`Updated ${applied}. Skipped ${skipped} (no label or already approved).`);
  }

  async function recropNow(force = false) {
    if (!jobId) return;
    const msg = force
      ? "Regenerate crops for this file?\n\nThis clears all un-reviewed (pending) crops and re-crops them with the latest logic. Verified and approved crops are kept."
      : "Re-crop this file now? Existing crops are kept; only missing ones will be added.";
    if (!window.confirm(msg)) return;
    setRecropping(true);
    try {
      const res = await fetch("/api/admin/training/recrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, force }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Re-crop failed: ${d.error ?? "unknown"}`);
        return;
      }
      const cleared = d.cleared ?? 0;
      if (d.queued) {
        alert(`${cleared > 0 ? `Cleared ${cleared} old crop(s). ` : ""}${d.message ?? "Re-running from the original — new crops appear in ~10–30 s."}`);
        // Crops are produced asynchronously by the re-run; reload once they land.
        setTimeout(load, 15000);
        setTimeout(load, 30000);
      } else if (d.success && (d.created ?? 0) > 0) {
        alert(`Done: ${d.created} crop(s) created${cleared > 0 ? ` (cleared ${cleared} old)` : ""}.`);
      } else if (d.reason) {
        alert(`${cleared > 0 ? `Cleared ${cleared} old crop(s), but ` : ""}${d.reason}`);
      }
      load();
    } finally {
      setRecropping(false);
    }
  }

  const verified = items.filter((i) => i.status === "verified").length;
  const approved = items.filter((i) => i.status === "approved").length;
  const pending  = items.filter((i) => i.status === "pending").length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <Link href="/admin/training" className="text-[11px] text-slate-500 hover:text-slate-700">
          ← All files
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-1">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-slate-800 truncate" title={docName}>
              {docName || "Training crops"}
            </h1>
            <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5 leading-relaxed">
              {items.length} crops · {pending} pending ·
              <span className="text-indigo-700 font-medium"> {verified} awaiting review</span> ·
              <span className="text-emerald-700 font-medium"> {approved} approved</span>
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 shrink-0 flex-wrap">
            <SaveStatus state={savingState} pendingCount={pendingCount} lastSavedAt={lastSavedAt} />
            <button
              onClick={() => { setSelectMode((v) => !v); clearSelection(); }}
              className={`text-xs font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap ${
                selectMode
                  ? "bg-slate-800 text-white hover:bg-slate-900"
                  : "border border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
              title="Select multiple crops to verify at once"
            >
              {selectMode ? "Cancel select" : "Select"}
            </button>
            <button
              onClick={() => recropNow(false)}
              disabled={recropping}
              className="text-xs font-semibold border border-slate-300 text-slate-700 px-3.5 py-2 rounded-lg hover:bg-slate-50 active:bg-slate-100 disabled:opacity-40 transition-colors whitespace-nowrap"
              title="Add crops for any cells that don't have one yet (keeps existing crops)"
            >
              {recropping ? "Working…" : "Re-crop (back-fill)"}
            </button>
            <button
              onClick={() => recropNow(true)}
              disabled={recropping}
              className="text-xs font-semibold bg-indigo-600 text-white px-3.5 py-2 rounded-lg hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-40 transition-colors whitespace-nowrap"
              title="Clear un-reviewed crops and regenerate with the latest logic (keeps verified/approved)"
            >
              {recropping ? "Working…" : "Regenerate"}
            </button>
            {isAdmin && (
              <button
                onClick={deleteFile}
                disabled={deleting || recropping}
                className="text-xs font-semibold border border-red-300 text-red-600 px-3.5 py-2 rounded-lg hover:bg-red-50 active:bg-red-100 disabled:opacity-40 transition-colors whitespace-nowrap"
                title="Permanently delete this file and all its crops"
              >
                {deleting ? "Deleting…" : "Delete file"}
              </button>
            )}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load:</span> {errorMsg}
        </div>
      )}

      {/* Bulk action bar — sticky so it stays reachable while scrolling a long list */}
      {selectMode && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 bg-slate-800 text-white rounded-xl px-3 py-2 shadow-lg">
          <span className="text-xs font-semibold">{selected.size} selected</span>
          <button
            onClick={selectAllEligible}
            className="text-[11px] font-semibold bg-white/15 hover:bg-white/25 px-2.5 py-1.5 rounded-lg"
          >
            Select all eligible
          </button>
          <button
            onClick={clearSelection}
            className="text-[11px] font-semibold bg-white/15 hover:bg-white/25 px-2.5 py-1.5 rounded-lg"
          >
            Clear
          </button>
          <div className="flex-1" />
          <button
            onClick={() => bulkSetStatus("verified")}
            disabled={selected.size === 0}
            className="text-xs font-semibold bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 px-4 py-1.5 rounded-lg"
          >
            ✓ Verify selected ({selected.size})
          </button>
          {isAdmin && (
            <button
              onClick={() => bulkSetStatus("approved")}
              disabled={selected.size === 0}
              className="text-xs font-semibold bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 px-4 py-1.5 rounded-lg"
            >
              Approve selected ({selected.size})
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-xs text-slate-400">Loading crops…</div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center bg-white rounded-2xl border border-slate-200 px-6">
          <p className="text-sm text-slate-700 font-semibold mb-1">No crops for this file</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            The pipeline either hasn&apos;t finished yet, or it used the Gemini-only path (no positional data).
            Click <strong>Regenerate</strong> above to try again — that re-runs the cropper directly.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((it) => (
            <CropCard
              key={it.id}
              item={it}
              onChange={(patch) => applyEdit(it.id, patch)}
              selectMode={selectMode}
              selected={selected.has(it.id)}
              onToggleSelect={() => toggleSelect(it.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SaveStatus({ state, pendingCount, lastSavedAt }: {
  state: "idle" | "queued" | "saving" | "error";
  pendingCount: number;
  lastSavedAt: Date | null;
}) {
  if (state === "saving") {
    return <span className="text-[11px] text-slate-500 animate-pulse">Saving {pendingCount} edits…</span>;
  }
  if (state === "queued") {
    return <span className="text-[11px] text-amber-700">{pendingCount} unsaved · auto-save soon</span>;
  }
  if (state === "error") {
    return <span className="text-[11px] text-red-600">Save failed — will retry</span>;
  }
  if (lastSavedAt) {
    return (
      <span className="text-[11px] text-emerald-700">
        ✓ Saved {lastSavedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
      </span>
    );
  }
  return <span className="text-[11px] text-slate-400">All changes saved</span>;
}

function CropCard({ item, onChange, selectMode, selected, onToggleSelect }: {
  item: TrainingItem;
  onChange: (patch: { label?: string; status?: TrainingItem["status"] }) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  // After an inline crop saves, append a timestamp to the URL so the <img>
  // re-fetches the freshly-overwritten storage object instead of serving stale.
  const [cacheBust, setCacheBust] = useState(0);
  const displayUrl = item.crop_url
    ? (cacheBust ? `${item.crop_url}${item.crop_url.includes("?") ? "&" : "?"}t=${cacheBust}` : item.crop_url)
    : null;
  // 'verified' now means "trainer-verified, awaiting admin review", not final.
  // 'approved' is the new final state, only set by an admin.
  const statusColors: Record<string, string> = {
    pending:  "bg-amber-50 text-amber-700 border-amber-200",
    verified: "bg-indigo-50 text-indigo-700 border-indigo-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-slate-100 text-slate-500 border-slate-200",
  };
  const statusLabel: Record<string, string> = {
    pending:  "pending",
    verified: "awaiting review",
    approved: "approved",
    rejected: "rejected",
  };

  // Once a crop has been sent for review (verified) or approved, the trainer is
  // done with it — lock editing and shadow the button so it's clear it's sent
  // and can't be edited or re-submitted.
  const locked = item.status === "verified" || item.status === "approved";

  return (
    <div className={`relative bg-white border rounded-2xl overflow-hidden flex flex-col ${
      selected ? "border-emerald-500 ring-2 ring-emerald-300" : "border-slate-200"
    }`}>
      {/* In select mode an overlay turns the whole card into a selection toggle
         (and the crop box is disabled so drags don't fight the tap). */}
      {selectMode && (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-label={selected ? "Deselect" : "Select"}
          className="absolute inset-0 z-20 cursor-pointer"
        >
          <span className={`absolute top-2 left-2 w-6 h-6 rounded-md border-2 flex items-center justify-center text-sm font-bold ${
            selected ? "bg-emerald-500 border-emerald-500 text-white" : "bg-white/85 border-slate-400 text-transparent"
          }`}>✓</span>
        </button>
      )}
      {/* Inline draggable crop box — auto-saves 2 s after the last drag.
         Approved rows are read-only (admin owns final state). */}
      <InlineCropper
        cropId={item.id}
        cropUrl={displayUrl}
        contextUrl={item.context_url}
        contextBox={item.context_box}
        disabled={locked || selectMode}
        onSaved={() => setCacheBust(Date.now())}
      />
      <div className="p-3 sm:p-4 flex flex-col gap-2.5 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[11px] px-2.5 py-1 rounded-full border font-semibold ${statusColors[item.status]}`}>
            {statusLabel[item.status] ?? item.status}
          </span>
          <span className="text-[10px] text-slate-400 truncate max-w-[60%]" title={item.field_name}>
            {item.field_name}
          </span>
        </div>
        <p className="text-[11px] text-slate-500">
          OCR: <span className="font-mono text-slate-700">{item.ocr_output || "—"}</span>
        </p>
        {/* Larger input — 16px font prevents iOS auto-zoom on focus, height
            comfortable for thumb tapping. */}
        <input
          type="text"
          dir="rtl"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={item.label ?? ""}
          onChange={(e) => onChange({ label: e.target.value })}
          disabled={locked}
          className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-base sm:text-sm text-slate-800 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
          placeholder="Correct name"
        />
        {/* Tall enough for a thumb (44 px+ tap target on mobile). Once sent
            (verified) or approved, the button is shadowed and inert so the
            trainer sees it's already submitted and can't edit / re-send. */}
        <button
          onClick={() => onChange({ status: "verified" })}
          disabled={!item.label?.trim() || locked}
          title={item.status === "verified"
            ? "Already sent for admin review"
            : item.status === "approved"
              ? "Already approved by admin"
              : "Send to admin review queue"}
          className={
            "mt-1 w-full text-sm font-semibold py-3 sm:py-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 " +
            (locked
              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
              : "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-40")
          }
        >
          {item.status === "approved" ? (
            <>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>verified</span>
              Approved by admin
            </>
          ) : item.status === "verified" ? (
            <>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
              Sent for review
            </>
          ) : (
            "✓ Verify & send"
          )}
        </button>
      </div>
    </div>
  );
}
