"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { formatUsd } from "@/lib/billing";

// This was the Subscriptions page. There are no subscriptions any more — every
// account holds a prepaid balance and is charged 1.5 cents per extracted row — so
// it is now where credit is added by hand, one account at a time.
interface Account {
  user_id: string;
  email: string;
  full_name: string | null;
  balance_cents: number | null;
  rows_used_total: number | null;
  created_at: string;
}

export default function AdminBalancesPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [emptyOnly, setEmpty]   = useState(false);
  const [search, setSearch]     = useState("");
  const [page, setPage]         = useState(1);

  // Which row's input is open, and what is typed in it. Kept per user id so
  // typing in one row cannot credit another.
  const [editing, setEditing]   = useState<string | null>(null);
  const [amount, setAmount]     = useState("");
  const [saving, setSaving]     = useState<string | null>(null);
  const [msg, setMsg]           = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page), search, ...(emptyOnly ? { empty: "1" } : {}),
    });
    fetch(`/api/admin/subscriptions?${params}`)
      .then((r) => r.json())
      .then((d) => { setAccounts(d.subscriptions ?? []); setTotal(d.total ?? 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search, emptyOnly]);

  useEffect(() => { load(); }, [load]);

  async function addCredit(userId: string) {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars === 0) { setMsg("Enter a non-zero amount"); return; }
    // Dollars in, integer cents out — rounded here so 10.005 cannot put a
    // fraction of a cent into the ledger.
    setSaving(userId); setMsg(null);
    const res = await fetch(`/api/admin/users/${userId}/balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: Math.round(dollars * 100) }),
    });
    const d = await res.json();
    setSaving(null);
    if (res.ok) {
      setMsg(`Credited — balance is now ${formatUsd(d.balance_cents ?? 0)}`);
      setEditing(null); setAmount("");
      load();
    } else {
      setMsg(d.error ?? "Failed");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Balances</h1>
          <p className="text-xs text-slate-500 mt-1">
            1.5 cents per extracted row. Credit is added here by hand — there is no payment provider yet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search email…"
            className="border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 w-56"
          />
          <button
            onClick={() => { setEmpty((v) => !v); setPage(1); }}
            className={`text-xs font-medium px-3 py-2 rounded-xl border transition-colors ${
              emptyOnly
                ? "border-red-300 bg-red-50 text-red-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            Out of credit
          </button>
        </div>
      </div>

      {msg && (
        <p className={`text-xs ${msg.startsWith("Credited") ? "text-emerald-600" : "text-red-600"}`}>{msg}</p>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {loading ? (
          <p className="p-8 text-center text-xs text-slate-400">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="p-8 text-center text-xs text-slate-400">No accounts.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-5 py-3 text-left font-medium">Email</th>
                <th className="px-5 py-3 text-left font-medium">Name</th>
                <th className="px-5 py-3 text-right font-medium">Balance</th>
                <th className="px-5 py-3 text-right font-medium">Rows used</th>
                <th className="px-5 py-3 text-left font-medium">Joined</th>
                <th className="px-5 py-3 text-left font-medium">Add credit</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const balance = a.balance_cents ?? 0;
                const isEditing = editing === a.user_id;
                return (
                  <tr key={a.user_id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <Link href={`/admin/users/${a.user_id}`} className="text-slate-800 hover:text-violet-600 hover:underline">
                        {a.email}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{a.full_name ?? "—"}</td>
                    <td className={`px-5 py-3 text-right font-semibold tabular-nums ${balance <= 0 ? "text-red-600" : "text-slate-800"}`}>
                      {formatUsd(balance)}
                    </td>
                    <td className="px-5 py-3 text-right text-slate-500 tabular-nums">
                      {(a.rows_used_total ?? 0).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-slate-400">
                      {new Date(a.created_at).toLocaleDateString("en-GB")}
                    </td>
                    <td className="px-5 py-3">
                      {isEditing ? (
                        <form
                          onSubmit={(e) => { e.preventDefault(); addCredit(a.user_id); }}
                          className="flex items-center gap-1.5"
                        >
                          <span className="text-slate-400">$</span>
                          <input
                            autoFocus
                            type="number"
                            step="0.01"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Escape") { setEditing(null); setAmount(""); } }}
                            placeholder="10.00"
                            className="w-20 border border-slate-300 rounded-lg px-2 py-1 text-[11px] text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-300"
                          />
                          <button
                            type="submit"
                            disabled={saving === a.user_id || !amount}
                            className="bg-slate-800 text-white text-[11px] font-medium px-2.5 py-1 rounded-lg hover:bg-slate-700 disabled:opacity-40"
                          >
                            {saving === a.user_id ? "…" : "Add"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditing(null); setAmount(""); }}
                            className="text-slate-400 hover:text-slate-600 px-1"
                          >✕</button>
                        </form>
                      ) : (
                        <button
                          onClick={() => { setEditing(a.user_id); setAmount(""); setMsg(null); }}
                          className="text-[11px] font-medium text-violet-600 hover:underline"
                        >
                          + Credit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {total > 50 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Showing {Math.min((page - 1) * 50 + 1, total)}–{Math.min(page * 50, total)} of {total}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >Previous</button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 50 >= total}
              className="px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
