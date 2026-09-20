"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { formatUsd } from "@/lib/billing";

interface User {
  user_id: string;
  email: string | null;
  full_name: string | null;
  /** Server-computed fallback chain: full_name → email → "User {id_short}" */
  display_name: string;
  balance_cents: number | null;
  rows_used_total: number | null;
  subscription_status: string;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
}

export default function AdminUsersPage() {
  const [users, setUsers]   = useState<User[]>([]);
  const [total, setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage]     = useState(1);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [warning, setWarning]   = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErrorMsg(null);
    setWarning(null);
    const params = new URLSearchParams({ page: String(page), search });
    fetch(`/api/admin/users?${params}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({} as Record<string, unknown>));
        if (!r.ok) {
          // Surface the real error instead of letting the UI go silent. "no
          // user available" with no explanation is one of the worst UX bugs.
          setErrorMsg(typeof d.error === "string" ? d.error : `Request failed (HTTP ${r.status})`);
          setUsers([]); setTotal(0);
          return;
        }
        setUsers((d.users as User[] | undefined) ?? []);
        setTotal((d.total as number | undefined) ?? 0);
        setWarning(typeof d.warning === "string" ? d.warning : null);
      })
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : "Network error");
        setUsers([]); setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    load();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Users</h1>
          <p className="text-xs text-slate-500 mt-0.5">{total} total users</p>
        </div>
      </div>

      {/* Filters */}
      <form onSubmit={handleSearch} className="flex gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search by email or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border border-slate-200 rounded-xl px-3.5 py-2 text-xs bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 w-64"
        />
        <button type="submit" className="bg-slate-800 text-white text-xs font-medium px-4 py-2 rounded-xl hover:bg-slate-700 transition-colors">
          Search
        </button>
      </form>

      {/* Error / warning banners — replace the silent "no users" empty state.
          errorMsg = the API failed; warning = degraded mode (e.g., admin client
          unavailable, falling back to profiles-only view). */}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load users:</span>{" "}
          {errorMsg}
        </div>
      )}
      {warning && !errorMsg && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800">
          <span className="font-semibold">Heads-up:</span> {warning}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
        ) : users.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">
            {errorMsg
              ? "Could not load users — see error above"
              : search
                ? "No users match the current filter"
                : "No users in the database yet"}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-slate-100">
              <tr className="text-left text-slate-500">
                <th className="px-5 py-3 font-medium">Email</th>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium text-right">Balance</th>
                <th className="px-5 py-3 font-medium text-right">Rows Used</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Joined</th>
                <th className="px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {users.map((u) => (
                <tr key={u.user_id} className={`hover:bg-slate-50 transition-colors ${u.is_banned ? "bg-amber-50/40" : ""}`}>
                  <td className="px-5 py-3 font-medium">
                    <Link
                      href={`/admin/users/${u.user_id}`}
                      className="text-slate-800 hover:text-indigo-700 hover:underline underline-offset-2"
                    >
                      {u.email ?? <span className="italic text-slate-400">no email</span>}
                    </Link>
                    {u.is_admin && (
                      <span className="ml-1.5 bg-red-100 text-red-600 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase">admin</span>
                    )}
                    {u.is_banned && (
                      <span className="ml-1.5 bg-amber-100 text-amber-700 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase">banned</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-500">
                    <Link href={`/admin/users/${u.user_id}`} className="hover:text-slate-700">
                      {/* Display name guaranteed: full_name → email → "User {id_short}".
                          Italic + grey when falling back so admins can spot incomplete profiles. */}
                      {u.full_name
                        ? u.full_name
                        : <span className="italic text-slate-400">{u.display_name}</span>}
                    </Link>
                  </td>
                  <td className={`px-5 py-3 text-right font-semibold tabular-nums ${(u.balance_cents ?? 0) <= 0 ? "text-red-600" : "text-slate-800"}`}>
                    {formatUsd(u.balance_cents ?? 0)}
                  </td>
                  <td className="px-5 py-3 text-right text-slate-600 tabular-nums">
                    {(u.rows_used_total ?? 0).toLocaleString()}
                  </td>
                  <td className="px-5 py-3">
                    {u.is_banned ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">banned</span>
                    ) : (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${u.subscription_status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                        {u.subscription_status}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-400">{new Date(u.created_at).toLocaleDateString("en-GB")}</td>
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/users/${u.user_id}`}
                      className="text-indigo-600 hover:text-indigo-800 font-medium text-[11px]"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > 50 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Showing {Math.min((page - 1) * 50 + 1, total)}–{Math.min(page * 50, total)} of {total}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">
              Previous
            </button>
            <button onClick={() => setPage((p) => p + 1)} disabled={page * 50 >= total} className="px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
