"use client";

import { useEffect, useState, useCallback } from "react";

interface LogEntry {
  id: string;
  actor_email: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_COLOR: Record<string, string> = {
  "user.plan_changed":  "bg-blue-100 text-blue-700",
  "user.updated":       "bg-indigo-100 text-indigo-700",
  "document.deleted":   "bg-red-100 text-red-700",
  "document.updated":   "bg-amber-100 text-amber-700",
  "setting.updated":    "bg-purple-100 text-purple-700",
};

function actionColor(action: string) {
  return ACTION_COLOR[action] ?? "bg-slate-100 text-slate-600";
}

export default function AdminAuditLogPage() {
  const [logs, setLogs]       = useState<LogEntry[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [action, setAction]   = useState("");
  const [targetType, setTargetType] = useState("");
  const [from, setFrom]       = useState("");
  const [to, setTo]           = useState("");
  const [page, setPage]       = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), action, target_type: targetType, from, to });
    fetch(`/api/admin/audit-logs?${params}`)
      .then((r) => r.json())
      .then((d) => { setLogs(d.logs ?? []); setTotal(d.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, action, targetType, from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Audit Log</h1>
        <p className="text-xs text-slate-500 mt-0.5">{total} total entries — every admin action is recorded</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          placeholder="Filter by action…"
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 w-48"
        />
        <select
          value={targetType}
          onChange={(e) => { setTargetType(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          <option value="">All targets</option>
          <option value="user">User</option>
          <option value="document">Document</option>
          <option value="setting">Setting</option>
          <option value="waitlist">Waitlist</option>
        </select>
        <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        {(action || targetType || from || to) && (
          <button onClick={() => { setAction(""); setTargetType(""); setFrom(""); setTo(""); setPage(1); }}
            className="text-xs text-slate-500 hover:text-slate-700 underline">
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center">
            <span className="material-symbols-outlined text-slate-300 block mb-2" style={{ fontSize: 32 }}>history</span>
            <p className="text-xs text-slate-400">No audit log entries yet</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-slate-100">
              <tr className="text-left text-slate-500">
                <th className="px-5 py-3 font-medium">Time</th>
                <th className="px-5 py-3 font-medium">Actor</th>
                <th className="px-5 py-3 font-medium">Action</th>
                <th className="px-5 py-3 font-medium">Target</th>
                <th className="px-5 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {logs.map((log) => (
                <>
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 text-slate-400 whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className="px-5 py-3 text-slate-600 max-w-[160px] truncate">{log.actor_email ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold font-mono ${actionColor(log.action)}`}>
                        {log.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-500">
                      {log.target_type && <span className="text-slate-400">{log.target_type}/</span>}
                      <span className="font-mono text-[10px]">{log.target_id?.slice(0, 8) ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3">
                      {log.details && (
                        <button onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                          className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium">
                          {expanded === log.id ? "Hide" : "Show"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === log.id && log.details && (
                    <tr key={`${log.id}-detail`} className="bg-slate-50">
                      <td colSpan={5} className="px-5 py-3">
                        <pre className="text-[10px] font-mono text-slate-600 whitespace-pre-wrap">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > 100 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Showing {Math.min((page - 1) * 100 + 1, total)}–{Math.min(page * 100, total)} of {total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Previous</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={page * 100 >= total} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
