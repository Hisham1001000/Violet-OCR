"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUsd } from "@/lib/billing";

interface Stats {
  total_users: number;
  new_users_this_month: number;
  total_documents: number;
  documents_today: number;
  accounts_out_of_credit: number;
  total_rows_extracted: number;
  waitlist_pending: number;
  failed_documents: number;
  active_today: number;
  active_this_week: number;
  total_logins: number;
}

interface RecentUser {
  user_id: string;
  email: string;
  full_name: string | null;
  balance_cents: number | null;
  is_banned: boolean;
  created_at: string;
}

interface RecentDoc {
  id: string;
  document_name: string;
  status: string;
  created_at: string;
  user_profiles?: { email: string } | null;
}

const HERO_CARDS = [
  {
    key: "total_users",
    label: "Total Users",
    sub: "new_users_this_month",
    subLabel: "this month",
    icon: "people",
    gradient: "from-indigo-500 to-violet-500",
  },
  {
    key: "total_documents",
    label: "Documents",
    sub: "documents_today",
    subLabel: "today",
    icon: "description",
    gradient: "from-violet-500 to-fuchsia-500",
  },
  {
    key: "accounts_out_of_credit",
    label: "Out of Credit",
    sub: "total_rows_extracted",
    subLabel: "rows billed",
    icon: "account_balance_wallet",
    gradient: "from-amber-500 to-orange-500",
  },
  {
    key: "active_today",
    label: "Active Today",
    sub: "active_this_week",
    subLabel: "this week",
    icon: "bolt",
    gradient: "from-emerald-500 to-teal-500",
  },
] as const;

const SMALL_CARDS = [
  { key: "waitlist_pending",      label: "Waitlist",      icon: "playlist_add",   color: "#14b8a6" },
  { key: "failed_documents",      label: "Failed Jobs",   icon: "error",          color: "#ef4444" },
  { key: "total_logins",          label: "Total Logins",  icon: "login",          color: "#06b6d4" },
  { key: "total_rows_extracted",  label: "Rows Billed",   icon: "table_rows",     color: "#ec4899" },
] as const;

const STATUS_STYLE: Record<string, string> = {
  completed:  "bg-emerald-100 text-emerald-700",
  processing: "bg-blue-100 text-blue-700",
  pending:    "bg-amber-100 text-amber-700",
  failed:     "bg-red-100 text-red-600",
};

function timeAgo(iso: string): string {
  const now  = Date.now();
  const then = new Date(iso).getTime();
  const s    = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60)       return `${s}s ago`;
  if (s < 3600)     return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)    return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400*30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB");
}

export default function AdminOverviewPage() {
  const [stats, setStats]           = useState<Stats | null>(null);
  const [recentUsers, setRecentUsers] = useState<RecentUser[]>([]);
  const [recentDocs, setRecentDocs]   = useState<RecentDoc[]>([]);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/stats").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/users?page=1").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/documents?page=1").then((r) => r.json()).catch(() => null),
    ]).then(([s, u, d]) => {
      if (s) setStats(s);
      if (u?.users) setRecentUsers(u.users.slice(0, 5));
      if (d?.documents) setRecentDocs(d.documents.slice(0, 5));
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-7">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Overview</h1>
          <p className="text-xs text-slate-500 mt-0.5">Real-time platform health &amp; activity</p>
        </div>
        <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Live
        </span>
      </div>

      {/* Hero metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {HERO_CARDS.map(({ key, label, sub, subLabel, icon, gradient }) => {
          const value    = stats ? (stats[key as keyof Stats] ?? 0) : null;
          const subValue = stats ? (stats[sub as keyof Stats] ?? 0) : null;
          return (
            <div
              key={key}
              className={`relative overflow-hidden rounded-2xl p-5 shadow-sm bg-gradient-to-br ${gradient} text-white`}
            >
              <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-white/10" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-white/80">{label}</span>
                  <span className="material-symbols-outlined text-white/80" style={{ fontSize: 18 }}>{icon}</span>
                </div>
                {loading || value === null ? (
                  <div className="h-8 w-16 bg-white/20 rounded mt-2 animate-pulse" />
                ) : (
                  <p className="text-3xl font-bold mt-1.5">{value.toLocaleString()}</p>
                )}
                <p className="text-[11px] text-white/80 mt-1">
                  {loading || subValue === null ? "—" : `+${subValue.toLocaleString()}`} {subLabel}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {SMALL_CARDS.map(({ key, label, icon, color }) => (
          <div key={key} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: color + "18" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color }}>{icon}</span>
            </div>
            <div className="min-w-0">
              {loading ? (
                <div className="h-5 w-10 bg-slate-100 rounded animate-pulse" />
              ) : (
                <p className="text-lg font-bold text-slate-800 leading-tight">
                  {stats ? (stats[key as keyof Stats] ?? 0).toLocaleString() : "—"}
                </p>
              )}
              <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Activity feed */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent users */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-800">Recent Signups</h2>
            <Link href="/admin/users" className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-slate-50">
            {loading ? (
              <div className="py-12 text-center text-xs text-slate-400">Loading…</div>
            ) : recentUsers.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-400">No users yet</div>
            ) : (
              recentUsers.map((u) => (
                <Link
                  key={u.user_id}
                  href={`/admin/users/${u.user_id}`}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 text-white text-xs font-semibold flex items-center justify-center shrink-0 uppercase">
                    {(u.email || "?")[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-800 truncate">{u.email}</p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {u.full_name ?? "—"} · {timeAgo(u.created_at)}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums ${
                    (u.balance_cents ?? 0) <= 0 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                  }`}>
                    {formatUsd(u.balance_cents ?? 0)}
                  </span>
                  {u.is_banned && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-700">
                      banned
                    </span>
                  )}
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Recent documents */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-800">Recent Documents</h2>
            <Link href="/admin/documents" className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium">
              View all →
            </Link>
          </div>
          <div className="divide-y divide-slate-50">
            {loading ? (
              <div className="py-12 text-center text-xs text-slate-400">Loading…</div>
            ) : recentDocs.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-400">No documents yet</div>
            ) : (
              recentDocs.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-violet-600" style={{ fontSize: 16 }}>description</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-800 truncate">{d.document_name}</p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {d.user_profiles?.email ?? "—"} · {timeAgo(d.created_at)}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[d.status] ?? STATUS_STYLE.pending}`}>
                    {d.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Users",         href: "/admin/users",         icon: "people",             color: "#6366f1" },
            { label: "Documents",     href: "/admin/documents",     icon: "description",        color: "#8b5cf6" },
            { label: "Subscriptions", href: "/admin/subscriptions", icon: "credit_card",        color: "#f59e0b" },
            { label: "Waitlist",      href: "/admin/waitlist",      icon: "playlist_add_check", color: "#10b981" },
            { label: "Settings",      href: "/admin/system"  ,      icon: "settings",           color: "#0ea5e9" },
            { label: "Audit Logs",    href: "/admin/audit-log" ,    icon: "history",            color: "#ec4899" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="bg-white rounded-xl border border-slate-200 p-3.5 flex items-center gap-2.5 hover:border-slate-300 hover:shadow-sm transition-all group"
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-transform group-hover:scale-110"
                style={{ background: item.color + "18" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: item.color }}>{item.icon}</span>
              </div>
              <span className="text-xs font-medium text-slate-700 truncate">{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
