"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

interface AdminDoc {
  id: string;
  user_id: string;
  document_name: string;
  status: string;
  preview_url: string | null;
  /** Populated when preview_url is null — explains exactly why */
  preview_error: string | null;
  structured_data: Record<string, unknown>[] | null;
  column_order: string[] | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  user_profiles: { email: string; full_name: string | null; plan: string } | null;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  completed:  { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500",            label: "Completed"  },
  processing: { bg: "bg-blue-50",    text: "text-blue-700",    dot: "bg-blue-500 animate-pulse", label: "Processing" },
  pending:    { bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-400",              label: "Pending"    },
  failed:     { bg: "bg-red-50",     text: "text-red-700",     dot: "bg-red-500",                label: "Failed"     },
};

export default function AdminDocumentDetailPage() {
  const router  = useRouter();
  const params  = useParams<{ id: string }>();
  const id      = params?.id;
  const [doc, setDoc]         = useState<AdminDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/admin/documents/${id}`)
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((d) => { if (d) setDoc(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  async function deleteDoc() {
    if (!doc) return;
    if (!window.confirm(`Delete "${doc.document_name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const res = await fetch(`/api/admin/documents/${doc.id}`, { method: "DELETE" });
    setDeleting(false);
    if (res.ok) router.push("/admin/documents");
    else alert("Failed to delete document");
  }

  if (loading) {
    return (
      <div className="py-16 text-center text-xs text-slate-400">Loading document…</div>
    );
  }

  if (notFound || !doc) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-slate-500 mb-3">Document not found</p>
        <Link href="/admin/documents" className="text-xs text-indigo-600 hover:underline">
          ← Back to documents
        </Link>
      </div>
    );
  }

  const s = STATUS_STYLES[doc.status] ?? STATUS_STYLES.pending;
  const cols = doc.column_order
    ?? (doc.structured_data?.[0] ? Object.keys(doc.structured_data[0]) : []);
  const isImage = !!doc.preview_url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(doc.preview_url);
  const isPdf   = !!doc.preview_url && /\.pdf(\?|$)/i.test(doc.preview_url);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/admin/documents" className="text-[11px] text-slate-500 hover:text-slate-700">
            ← All documents
          </Link>
          <h1 className="text-xl font-bold text-slate-800 mt-1 truncate">{doc.document_name}</h1>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500">
            <span>Created {new Date(doc.created_at).toLocaleString("en-GB")}</span>
            {doc.completed_at && (
              <span>· Completed {new Date(doc.completed_at).toLocaleString("en-GB")}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold ${s.bg} ${s.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
            {s.label}
          </span>
          <button
            onClick={deleteDoc}
            disabled={deleting}
            className="text-[11px] text-red-600 border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg font-medium disabled:opacity-40 transition-colors"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {/* Owner card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 flex items-center justify-between">
        <div>
          <p className="text-[10px] text-slate-400 uppercase font-semibold tracking-wide mb-1">Uploaded by</p>
          <Link href={`/admin/users/${doc.user_id}`} className="text-sm font-medium text-slate-800 hover:text-indigo-700 hover:underline">
            {doc.user_profiles?.email ?? doc.user_id.slice(0, 8) + "…"}
          </Link>
          {doc.user_profiles?.full_name && (
            <p className="text-[11px] text-slate-500 mt-0.5">{doc.user_profiles.full_name}</p>
          )}
        </div>
        {doc.user_profiles?.plan && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 capitalize">
            {doc.user_profiles.plan}
          </span>
        )}
      </div>

      {/* Error banner */}
      {doc.error_message && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
          <p className="text-xs font-semibold text-red-700 mb-1.5 flex items-center gap-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>error</span>
            Processing error
          </p>
          <p className="text-[11px] font-mono text-red-600 break-words">{doc.error_message}</p>
        </div>
      )}

      {/* Two-column: preview + extracted data */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* File preview */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-700">Original Document</h2>
            {doc.preview_url && (
              <a
                href={doc.preview_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium"
              >
                Open in new tab ↗
              </a>
            )}
          </div>
          <div className="bg-slate-50" style={{ minHeight: 480 }}>
            {!doc.preview_url ? (
              <div className="py-12 px-6 text-center">
                <p className="text-xs font-semibold text-slate-600 mb-1.5">
                  Original file unavailable
                </p>
                <p className="text-[11px] text-slate-500 break-words">
                  {doc.preview_error ?? "Reason not reported by the API."}
                </p>
              </div>
            ) : isPdf ? (
              <iframe
                src={doc.preview_url}
                className="w-full"
                style={{ height: 600, border: "none" }}
                title="Document preview"
              />
            ) : isImage ? (
              <div className="flex items-center justify-center p-3" style={{ minHeight: 480 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={doc.preview_url}
                  alt={doc.document_name}
                  className="max-w-full max-h-[580px] object-contain rounded-lg"
                />
              </div>
            ) : (
              <div className="py-20 text-center text-xs text-slate-400">
                Preview not available for this file type
              </div>
            )}
          </div>
        </div>

        {/* Extracted data */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-700">Extracted Data</h2>
            <span className="text-[10px] text-slate-400">
              {doc.structured_data?.length ?? 0} rows
            </span>
          </div>
          <div className="overflow-auto" style={{ maxHeight: 600 }}>
            {!doc.structured_data || doc.structured_data.length === 0 ? (
              <div className="py-20 text-center text-xs text-slate-400">
                No extracted data
              </div>
            ) : (
              <table className="w-full text-[11px]" dir="rtl">
                <thead className="bg-slate-50 sticky top-0">
                  <tr className="text-right text-slate-500">
                    {cols.map((c) => (
                      <th key={c} className="px-3 py-2 font-medium border-b border-slate-100 whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {doc.structured_data.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50">
                      {cols.map((c) => (
                        <td key={c} className="px-3 py-2 text-slate-700 whitespace-nowrap">
                          {String(row[c] ?? "—")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
