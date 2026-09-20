"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface Doc {
  id: string;
  user_id: string;
  document_name: string;
  status: string;
  created_at: string;
  error_message: string | null;
  user_profiles: { email: string } | null;
}

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  completed:  { dot: "bg-emerald-500",            label: "Completed" },
  processing: { dot: "bg-blue-500 animate-pulse", label: "Processing" },
  pending:    { dot: "bg-amber-400",              label: "Pending" },
  failed:     { dot: "bg-red-500",               label: "Failed" },
};

export default function AdminDocumentsPage() {
  const [docs, setDocs]     = useState<Doc[]>([]);
  const [total, setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage]     = useState(1);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), status, search });
    fetch(`/api/admin/documents?${params}`)
      .then((r) => r.json())
      .then((d) => { setDocs(d.documents ?? []); setTotal(d.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, status, search]);

  useEffect(() => { load(); }, [load]);

  async function deleteDoc(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(id);
    await fetch(`/api/admin/documents/${id}`, { method: "DELETE" });
    setDeleting(null);
    load();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Documents</h1>
          <p className="text-xs text-slate-500 mt-0.5">{total} total documents</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search by document name…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 w-64"
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">No documents found</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-slate-100">
              <tr className="text-left text-slate-500">
                <th className="px-5 py-3 font-medium">Document</th>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {docs.map((d) => {
                const s = STATUS_STYLES[d.status] ?? STATUS_STYLES.pending;
                const isFailed = d.status === "failed";
                return (
                  <tr key={d.id} className={`transition-colors ${isFailed ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-slate-50"}`}>
                    <td className="px-5 py-3">
                      <p className={`font-medium truncate max-w-[220px] ${isFailed ? "text-red-800" : "text-slate-800"}`}>
                        {d.document_name}
                      </p>
                      {d.error_message && (
                        <p
                          className="text-[10px] text-red-600 mt-0.5 truncate max-w-[280px] cursor-help"
                          title={d.error_message}
                        >
                          <span className="material-symbols-outlined align-middle mr-0.5" style={{ fontSize: 10 }}>error</span>
                          {d.error_message}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      <Link href={`/admin/users/${d.user_id}`} className="hover:text-indigo-600 transition-colors">
                        {(d.user_profiles as { email: string } | null)?.email ?? d.user_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
                        <span className={isFailed ? "text-red-600 font-semibold" : ""}>{s.label}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-400">{new Date(d.created_at).toLocaleDateString("en-GB")}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/admin/documents/${d.id}`}
                          className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => deleteDoc(d.id, d.document_name)}
                          disabled={deleting === d.id}
                          className="text-[11px] text-red-500 hover:text-red-700 font-medium disabled:opacity-40 transition-colors"
                        >
                          {deleting === d.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Showing {Math.min((page - 1) * 50 + 1, total)}–{Math.min(page * 50, total)} of {total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Previous</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={page * 50 >= total} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
