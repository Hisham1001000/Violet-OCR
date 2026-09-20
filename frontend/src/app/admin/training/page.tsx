"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ManualUploadModal } from "@/components/ManualUploadModal";

interface FileGroup {
  job_id: string;
  document_name: string;
  uploaded_at: string | null;
  total: number;
  pending: number;
  verified: number;
  approved: number;
  rejected: number;
  last_activity: string;
  thumb_url: string | null;
  needs_crop: boolean;
  is_manual?: boolean;
  worked_by?: string | null;
  worked_at?: string | null;
}

// Badge showing which trainer is working a file. Blue "working" if they verified
// a crop here recently, otherwise a muted "by <name>" audit trace.
function WorkerBadge({ name, at }: { name: string; at: string | null | undefined }) {
  const mins = at ? (Date.now() - Date.parse(at)) / 60000 : Infinity;
  const active = mins < 30;
  const rel =
    !at ? "" :
    mins < 1 ? "just now" :
    mins < 60 ? `${Math.round(mins)}m ago` :
    mins < 1440 ? `${Math.round(mins / 60)}h ago` :
    `${Math.round(mins / 1440)}d ago`;
  return (
    <span
      title={at ? `Last worked ${new Date(at).toLocaleString()}` : "Worked by a trainer"}
      className={
        "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-semibold max-w-full " +
        (active ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-500 border-slate-200")
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>person</span>
      <span className="truncate">{name}</span>
      <span className={active ? "text-blue-500" : "text-slate-400"}>· {active ? "working" : rel}</span>
    </span>
  );
}

export default function AdminTrainingOverview() {
  const [groups, setGroups]   = useState<FileGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Probe whether the current user is an admin (vs trainer). The queue + export
  // endpoints both gate via assertAdmin, so we use the queue endpoint as a
  // role probe — 200 means admin, 401/403 means trainer.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErrorMsg(null);
    fetch("/api/admin/training")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setErrorMsg(typeof d.error === "string" ? d.error : `HTTP ${r.status}`);
          setGroups([]);
          return;
        }
        setGroups((d.items as FileGroup[]) ?? []);
      })
      .catch((e) => setErrorMsg(e instanceof Error ? e.message : "Network error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // One-time role probe.
  useEffect(() => {
    fetch("/api/admin/training/queue?limit=1", { method: "GET" })
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, []);

  const [uploadOpen, setUploadOpen] = useState(false);

  // ── Bulk-select / delete ──────────────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [deleting, setDeleting]     = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const exitSelect = useCallback(() => { setSelectMode(false); setSelected(new Set()); }, []);

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!window.confirm(
      `Delete ${selected.size} file${selected.size === 1 ? "" : "s"} permanently?\n\n` +
      `This removes the uploaded files and ALL their crops/training rows. This cannot be undone.`,
    )) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/training/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: Array.from(selected) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`Delete failed: ${d.error ?? "unknown"}`); return; }
      if (d.failed > 0) alert(`Deleted ${d.deleted}. ${d.failed} could not be deleted — try again.`);
      exitSelect();
      load();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setDeleting(false);
    }
  }

  const totals = groups.reduce(
    (acc, g) => ({
      files:    acc.files    + 1,
      crops:    acc.crops    + g.total,
      pending:  acc.pending  + g.pending,
      verified: acc.verified + g.verified,
      approved: acc.approved + g.approved,
    }),
    { files: 0, crops: 0, pending: 0, verified: 0, approved: 0 },
  );

  return (
    <div className="space-y-5">
      {/* Tab bar — Files (always) | Review Queue (admin only) */}
      <TrainingTabs isAdmin={isAdmin === true} />

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Data Training</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {totals.files} files · {totals.crops} name crops ·
            <span className="text-amber-700 font-medium"> {totals.pending} pending</span> ·
            <span className="text-indigo-700 font-medium"> {totals.verified} awaiting review</span> ·
            <span className="text-emerald-700 font-medium"> {totals.approved} approved</span>
          </p>
        </div>
        {/* Export + Upload + Select are admin-only. */}
        {isAdmin === true && !selectMode && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelectMode(true)}
              disabled={groups.length === 0}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-white text-slate-700 border border-slate-300 px-3.5 py-2 rounded-xl hover:bg-slate-50 disabled:opacity-40 transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>checklist</span>
              Select
            </button>
            <button
              onClick={() => setUploadOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-indigo-600 text-white px-3.5 py-2 rounded-xl hover:bg-indigo-700 transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>upload</span>
              Upload manual
            </button>
            <a
              href="/api/admin/training/export?status=approved"
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-slate-800 text-white px-3.5 py-2 rounded-xl hover:bg-slate-700 transition-colors"
              download
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
              Export approved (CSV)
            </a>
          </div>
        )}
      </div>

      {/* Selection toolbar — shown while picking files to delete. */}
      {isAdmin === true && selectMode && (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 bg-slate-800 text-white rounded-xl px-3 py-2 shadow-md">
          <span className="text-xs font-semibold">{selected.size} selected</span>
          <button
            onClick={() => setSelected(new Set(groups.map((g) => g.job_id)))}
            className="text-[11px] font-medium bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-lg transition-colors"
          >
            Select all ({groups.length})
          </button>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-[11px] font-medium bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-lg transition-colors"
            >
              Clear
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={bulkDelete}
            disabled={selected.size === 0 || deleting}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold bg-red-600 text-white px-3 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-40 transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              {deleting ? "hourglass_empty" : "delete"}
            </span>
            {deleting ? "Deleting…" : `Delete ${selected.size || ""}`.trim()}
          </button>
          <button
            onClick={exitSelect}
            disabled={deleting}
            className="text-[11px] font-medium bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-lg disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {isAdmin === true && (
        <ManualUploadModal open={uploadOpen} onClose={() => { setUploadOpen(false); load(); }} />
      )}

      {errorMsg && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load:</span> {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((g) => (
            <FileCard
              key={g.job_id}
              group={g}
              onCropped={load}
              isAdmin={isAdmin === true}
              onDeleted={load}
              selectMode={selectMode}
              selected={selected.has(g.job_id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteFileButton({ jobId, name, onDeleted }: { jobId: string; name: string; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  async function del(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete "${name}" permanently?\n\nThis removes the uploaded file and ALL its crops/training rows. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/training/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { alert(`Delete failed: ${d.error ?? "unknown"}`); return; }
      onDeleted();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={del}
      disabled={busy}
      title="Delete this file and all its crops"
      className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-lg bg-white/90 border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-300 shadow-sm disabled:opacity-50"
    >
      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{busy ? "hourglass_empty" : "delete"}</span>
    </button>
  );
}

function SelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <div
      className={
        "absolute top-2 left-2 z-20 w-6 h-6 flex items-center justify-center rounded-md border shadow-sm " +
        (checked ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white/90 border-slate-300 text-transparent")
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
    </div>
  );
}

function FileCard({ group, onCropped, isAdmin, onDeleted, selectMode, selected, onToggleSelect }: {
  group: FileGroup; onCropped: () => void; isAdmin: boolean; onDeleted: () => void;
  selectMode: boolean; selected: boolean; onToggleSelect: (id: string) => void;
}) {
  const [cropping, setCropping] = useState(false);
  const [cropMsg, setCropMsg]   = useState<string | null>(null);
  // Progress from the trainer's view: a crop is "handled" once it has been
  // verified (sent for review) or approved. Pending crops are what's still left.
  const handled = group.verified + group.approved;
  const pct = group.total > 0 ? Math.round((handled / group.total) * 100) : 0;

  // In select mode, the whole card becomes a checkbox: capture the click before
  // it reaches the inner Link / Crop button so nothing navigates or fires.
  const captureSelect = selectMode
    ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(group.job_id); }
    : undefined;
  const selRing = selected ? "ring-2 ring-indigo-500 ring-offset-1" : "";

  // Cards for files that have no crops yet are NOT links — they show a "Crop
  // now" button. Without this, clicking the card would land you on an empty
  // detail page with no idea what to do.
  if (group.needs_crop) {
    // Arrow form — function declarations inside an `if` block are disallowed
    // in strict mode when targeting ES5 (Next.js default).
    const cropNow = async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCropping(true);
      setCropMsg(null);
      const res = await fetch("/api/admin/training/recrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: group.job_id }),
      });
      const d = await res.json().catch(() => ({} as { success?: boolean; queued?: boolean; created?: number; message?: string; reason?: string; error?: string }));
      setCropping(false);
      if (!res.ok) {
        setCropMsg(d.error ?? "Crop failed");
        return;
      }
      // Async path: the cropper had no polygons, so the route is re-running Azure
      // Layout in the background. Don't say "nothing to crop" — tell the user it's
      // working and auto-refresh once the crops land.
      if (d.queued) {
        setCropMsg(d.message ?? "Re-running layout — crops will appear in ~10–30 s.");
        setTimeout(onCropped, 15000);
        return;
      }
      if (d.success && (d.created ?? 0) > 0) {
        onCropped();
        return;
      }
      setCropMsg(d.reason ?? "Cropper found nothing to crop");
    };
    return (
      <div
        className={"relative bg-white border border-amber-200 rounded-2xl overflow-hidden flex flex-col " + selRing + (selectMode ? " cursor-pointer" : "")}
        onClickCapture={captureSelect}
      >
        {selectMode && <SelectCheckbox checked={selected} />}
        {isAdmin && !selectMode && <DeleteFileButton jobId={group.job_id} name={group.document_name} onDeleted={onDeleted} />}
        <div className="bg-amber-50 flex items-center justify-center" style={{ minHeight: 110 }}>
          <span className="material-symbols-outlined text-amber-400" style={{ fontSize: 40 }}>hourglass_empty</span>
        </div>
        <div className="p-3 flex flex-col gap-2 flex-1">
          <h3 className="text-xs font-semibold text-slate-800 truncate" title={group.document_name}>
            {group.document_name}
          </h3>
          <p className="text-[11px] text-amber-700">
            No crops yet — cropper hasn&apos;t produced any rows for this file.
          </p>
          <button
            onClick={cropNow}
            disabled={cropping}
            className="mt-1 text-[11px] font-semibold bg-amber-500 text-white py-1.5 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
          >
            {cropping ? "Cropping…" : "Crop now"}
          </button>
          {cropMsg && (
            <p className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5 leading-snug">
              {cropMsg}
            </p>
          )}
        </div>
      </div>
    );
  }

  // "Done" = admin has finished this file: it has crops and none are still
  // pending or awaiting review. Such files sort to the bottom and get a tick.
  const done = group.total > 0 && group.pending === 0 && group.verified === 0 && group.approved > 0;

  return (
    <div className={"relative " + selRing + (selectMode ? " cursor-pointer" : "")} onClickCapture={captureSelect}>
    {selectMode && <SelectCheckbox checked={selected} />}
    {isAdmin && !selectMode && <DeleteFileButton jobId={group.job_id} name={group.document_name} onDeleted={onDeleted} />}
    {done && !selectMode && (
      <div
        className="absolute top-2 left-2 z-10 w-7 h-7 flex items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm"
        title="Approved by admin — complete"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check</span>
      </div>
    )}
    <Link
      href={`/admin/training/${group.job_id}`}
      className={
        "bg-white border rounded-2xl overflow-hidden hover:shadow-md transition-all flex flex-col " +
        (done ? "border-emerald-300 hover:border-emerald-400" : "border-slate-200 hover:border-indigo-300")
      }
    >
      {/* Thumb */}
      <div className="bg-slate-50 flex items-center justify-center" style={{ minHeight: 110 }}>
        {group.thumb_url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={group.thumb_url} alt="" className="max-w-full max-h-[140px] object-contain p-2" />
        ) : (
          <span className="material-symbols-outlined text-slate-300" style={{ fontSize: 40 }}>image</span>
        )}
      </div>
      {/* Body */}
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {group.is_manual && (
            <span
              className="text-[9px] uppercase tracking-wider font-bold bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-md flex-shrink-0"
              title="Uploaded manually — bypassed OCR pipeline"
            >Manual</span>
          )}
          <h3 className="text-xs font-semibold text-slate-800 truncate" title={group.document_name}>
            {group.document_name}
          </h3>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {done ? (
            <span className="inline-flex items-center gap-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-full font-semibold">
              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>check</span>
              Approved ({group.approved})
            </span>
          ) : (
            <>
              <span className="bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full font-semibold">
                {group.pending} pending
              </span>
              <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded-full font-semibold">
                {group.verified} verified
              </span>
            </>
          )}
        </div>
        {group.worked_by && (
          <div className="min-w-0">
            <WorkerBadge name={group.worked_by} at={group.worked_at} />
          </div>
        )}
        {/* Progress bar — how many crops are handled vs still to do */}
        <div className="flex items-center justify-between text-[10px] font-semibold">
          <span className={pct === 100 ? "text-emerald-700" : "text-slate-600"}>
            {handled}/{group.total} done
          </span>
          {group.pending > 0
            ? <span className="text-amber-700">{group.pending} left</span>
            : <span className="text-emerald-700">complete</span>}
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={"h-full rounded-full transition-all " + (pct === 100 ? "bg-emerald-500" : "bg-indigo-500")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </Link>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl py-16 text-center px-6">
      <span className="material-symbols-outlined text-slate-300 mb-3 inline-block" style={{ fontSize: 48 }}>school</span>
      <h2 className="text-sm font-semibold text-slate-700 mb-1">No training data yet</h2>
      <p className="text-xs text-slate-500 max-w-md mx-auto">
        After a user uploads a document, the pipeline auto-crops every name cell and adds it here for review.
        If you have completed jobs but no crops appear, the pipeline may have used the Gemini-only path
        (no positional data) — open the document in <Link href="/admin/documents" className="text-indigo-600 hover:underline">Documents</Link>{" "}
        and use <strong>Re-crop</strong> from the file detail.
      </p>
    </div>
  );
}

// ── Tab bar shown atop every page in /admin/training/* ──────────────────────
function TrainingTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/training",             label: "Files",            show: true },
    { href: "/admin/training/queue",       label: "Review Queue",     show: isAdmin },
    { href: "/admin/training/trainers",    label: "Trainer Activity", show: isAdmin },
    { href: "/admin/training/leaderboard", label: "Leaderboard",      show: true },
  ];
  return (
    <div className="border-b border-slate-200 -mb-px overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="flex gap-2 sm:gap-4 min-w-max">
        {tabs.filter((t) => t.show).map((t) => {
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
