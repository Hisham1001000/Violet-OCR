"use client";

/**
 * ManualUploadModal — admin uploads original PDFs/images directly into the
 * training pipeline (train_only mode). Server runs Azure Layout to detect
 * tables and crops every name cell into training_dataset rows. No OCR cost.
 *
 * The client just picks files and POSTs them one at a time so we can show
 * per-file progress. Each file becomes its own document_jobs row + file card
 * in /admin/training. Pages with no detected tables are auto-skipped.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

interface Props {
  open: boolean;
  onClose: () => void;
}

type FileStatus = "queued" | "uploading" | "done" | "error";
interface QueueItem {
  file:    File;
  status:  FileStatus;
  jobId?:  string;
  error?:  string;
}

const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_FILES     = 50;

export function ManualUploadModal({ open, onClose }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [batchName, setBatchName] = useState("");
  const [fieldName, setFieldName] = useState("manual_upload");
  const [items, setItems]         = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr]             = useState<string | null>(null);
  const [dragOver, setDragOver]   = useState(false);

  useEffect(() => {
    if (!open) {
      setBatchName("");
      setFieldName("manual_upload");
      setItems([]);
      setUploading(false);
      setErr(null);
      setDragOver(false);
    }
  }, [open]);

  function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (items.length + list.length > MAX_FILES) {
      setErr(`Max ${MAX_FILES} files per session.`);
      return;
    }
    setErr(null);
    const next: QueueItem[] = list.map((f) => {
      const ok = ACCEPTED_MIME.includes(f.type) ||
                 (f.type === "" && f.name.toLowerCase().endsWith(".pdf"));
      return {
        file: f,
        status: ok ? "queued" : "error",
        error:  ok ? undefined : `Unsupported (${f.type || "no MIME"})`,
      };
    });
    setItems((cur) => [...cur, ...next]);
  }

  function removeOne(i: number) {
    setItems((cur) => cur.filter((_, j) => j !== i));
  }

  async function uploadAll() {
    const queued = items.filter((it) => it.status === "queued");
    if (queued.length === 0) {
      setErr("No valid files queued.");
      return;
    }
    setUploading(true);
    setErr(null);

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.status !== "queued") continue;
      // Mark this row "uploading" before we kick off the request.
      setItems((cur) => cur.map((x, j) => j === i ? { ...x, status: "uploading" } : x));

      const fd = new FormData();
      fd.append("file", it.file);
      if (batchName.trim()) fd.append("batch_name", batchName.trim());
      fd.append("field_name", fieldName.trim() || "manual_upload");

      try {
        const res  = await fetch("/api/admin/training/manual-upload", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setItems((cur) => cur.map((x, j) => j === i
          ? { ...x, status: "done", jobId: data.job_id }
          : x,
        ));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setItems((cur) => cur.map((x, j) => j === i
          ? { ...x, status: "error", error: msg }
          : x,
        ));
      }
    }

    setUploading(false);
    // If at least one file succeeded, send admin to the Files grid where
    // the new jobs will appear (initially as "processing" cards).
    const anySuccess = items.some((it) => it.status === "done") ||
                       items.some((it) => it.status === "queued");
    if (anySuccess) {
      onClose();
      router.refresh();
      router.push("/admin/training");
    }
  }

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const queuedCount = items.filter((it) => it.status === "queued").length;
  const doneCount   = items.filter((it) => it.status === "done").length;
  const errorCount  = items.filter((it) => it.status === "error").length;

  return createPortal(
    <div
      onClick={uploading ? undefined : onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 9999, padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 16, padding: 18,
          width: "100%", maxWidth: 640,
          maxHeight: "calc(100vh - 32px)", overflowY: "auto",
          boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-slate-800">Upload training files</h2>
          <button
            onClick={onClose}
            disabled={uploading}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2 disabled:opacity-30"
          >×</button>
        </div>

        <p className="text-[11px] text-slate-500 mb-3 leading-relaxed">
          Upload original PDFs or images. Server runs Azure Layout (no OCR text)
          and auto-crops every name cell into training data. Pages with no
          tables are skipped automatically.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3">
          <div>
            <label className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Batch name (optional)</label>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="Defaults to filename"
              disabled={uploading}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Field name (label tag)</label>
            <input
              type="text"
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              disabled={uploading}
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50"
            />
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { if (uploading) return; e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (uploading) return;
            e.preventDefault(); setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => !uploading && inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#6366f1" : "#cbd5e1"}`,
            background: dragOver ? "#eef2ff" : "#f8fafc",
            borderRadius: 12, padding: 24, textAlign: "center",
            cursor: uploading ? "not-allowed" : "pointer",
            opacity: uploading ? 0.5 : 1,
            transition: "all 0.15s",
          }}
        >
          <span className="material-symbols-outlined text-slate-400 mb-1 inline-block" style={{ fontSize: 32 }}>
            cloud_upload
          </span>
          <p className="text-sm text-slate-600 font-medium">
            {dragOver ? "Drop files here" : "Tap to choose, or drag & drop"}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">PDF, JPG, PNG, or WebP — up to {MAX_FILES} files</p>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf,image/jpeg,image/png,image/webp"
            multiple
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
            style={{ display: "none" }}
          />
        </div>

        {/* Queue */}
        {items.length > 0 && (
          <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-slate-50 border border-slate-200 rounded-lg p-2">
                <StatusIcon status={it.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-800 truncate">{it.file.name}</p>
                  <p className={`text-[10px] ${it.status === "error" ? "text-red-600" : "text-slate-500"}`}>
                    {it.status === "error"
                      ? it.error
                      : it.status === "uploading"
                        ? "Uploading…"
                        : it.status === "done"
                          ? "Queued for processing ✓"
                          : `${formatBytes(it.file.size)} · ${it.file.type || "unknown"}`}
                  </p>
                </div>
                {!uploading && it.status !== "done" && (
                  <button
                    onClick={() => removeOne(i)}
                    className="text-slate-400 hover:text-red-600 text-lg px-2"
                    title="Remove"
                  >×</button>
                )}
              </div>
            ))}
          </div>
        )}

        {err && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>
        )}

        {/* Tally + actions */}
        <div className="flex flex-wrap items-center gap-2 justify-between mt-4">
          <p className="text-[11px] text-slate-500">
            {items.length > 0 && (
              <>
                {queuedCount} queued
                {doneCount  > 0 && <> · <span className="text-emerald-700 font-semibold">{doneCount} done</span></>}
                {errorCount > 0 && <> · <span className="text-red-600 font-semibold">{errorCount} failed</span></>}
              </>
            )}
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              disabled={uploading}
              className="text-sm font-semibold border border-slate-300 text-slate-700 px-4 py-2.5 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >Cancel</button>
            <button
              onClick={uploadAll}
              disabled={uploading || queuedCount === 0}
              className="text-sm font-semibold bg-indigo-600 text-white px-5 py-2.5 rounded-lg hover:bg-indigo-700 disabled:opacity-40"
            >
              {uploading ? `Uploading (${doneCount}/${items.length})…` : `Upload ${queuedCount}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusIcon({ status }: { status: FileStatus }) {
  const common = "w-8 h-8 rounded flex items-center justify-center flex-shrink-0";
  if (status === "uploading") {
    return (
      <div className={`${common} bg-indigo-100`}>
        <span className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (status === "done") {
    return (
      <div className={`${common} bg-emerald-100 text-emerald-700`}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check</span>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={`${common} bg-red-100 text-red-600`}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
      </div>
    );
  }
  return (
    <div className={`${common} bg-slate-200 text-slate-500`}>
      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>description</span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
