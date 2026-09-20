"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface TrainerStat {
  user_id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
  is_trainer: boolean;
  total_verified: number;
  awaiting_review: number;
  approved: number;
  rejected: number;
  last_activity: string;
  last_7_days_verified: number;
}

interface Totals {
  trainers: number;
  total_verified: number;
  awaiting_review: number;
  approved: number;
  rejected: number;
}

export default function AdminTrainerStatsPage() {
  const [trainers, setTrainers] = useState<TrainerStat[]>([]);
  const [totals, setTotals]     = useState<Totals | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/training/trainer-stats")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(d.error ?? `HTTP ${r.status}`);
          setTrainers([]);
          return;
        }
        setTrainers(d.trainers ?? []);
        setTotals(d.totals ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Network error"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-5">
      <TrainingTabs />

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Trainer Activity</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Per-trainer breakdown of verified, awaiting-review, approved, and rejected items.
            Trainers who haven&apos;t verified anything do not appear yet.
          </p>
        </div>
      </div>

      {/* Totals strip */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Trainers"  value={totals.trainers} />
          <Stat label="Verified"  value={totals.total_verified} color="text-slate-800" />
          <Stat label="Awaiting"  value={totals.awaiting_review} color="text-indigo-700" />
          <Stat label="Approved"  value={totals.approved} color="text-emerald-700" />
          <Stat label="Rejected"  value={totals.rejected} color="text-slate-500" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-xs text-slate-400">Loading…</div>
      ) : trainers.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl py-16 text-center px-6">
          <span className="material-symbols-outlined text-slate-300 mb-3 inline-block" style={{ fontSize: 48 }}>
            group
          </span>
          <h2 className="text-sm font-semibold text-slate-700 mb-1">No trainer activity yet</h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Once a trainer verifies their first crop, their stats will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-slate-100 bg-slate-50">
              <tr className="text-left text-slate-500">
                <th className="px-4 py-3 font-medium">Trainer</th>
                <th className="px-4 py-3 font-medium text-right">Verified</th>
                <th className="px-4 py-3 font-medium text-right">Awaiting</th>
                <th className="px-4 py-3 font-medium text-right">Approved</th>
                <th className="px-4 py-3 font-medium text-right">Rejected</th>
                <th className="px-4 py-3 font-medium text-right">Last 7 days</th>
                <th className="px-4 py-3 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {trainers.map((t) => (
                <tr key={t.user_id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/users/${t.user_id}`}
                      className="font-medium text-slate-800 hover:text-indigo-700"
                    >
                      {t.full_name || t.email}
                    </Link>
                    {t.full_name && (
                      <p className="text-[10px] text-slate-400">{t.email}</p>
                    )}
                    <div className="flex gap-1 mt-0.5">
                      {t.is_admin && (
                        <span className="text-[9px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded">Admin</span>
                      )}
                      {t.is_trainer && (
                        <span className="text-[9px] font-semibold uppercase tracking-wide bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">Trainer</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-800">{t.total_verified}</td>
                  <td className="px-4 py-3 text-right">
                    {t.awaiting_review > 0
                      ? <span className="text-indigo-700 font-semibold">{t.awaiting_review}</span>
                      : <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {t.approved > 0
                      ? <span className="text-emerald-700 font-semibold">{t.approved}</span>
                      : <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {t.rejected > 0
                      ? <span className="text-slate-500">{t.rejected}</span>
                      : <span className="text-slate-300">0</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">{t.last_7_days_verified}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {t.last_activity
                      ? new Date(t.last_activity).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <p className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold ${color ?? "text-slate-800"}`}>{value}</p>
    </div>
  );
}

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
