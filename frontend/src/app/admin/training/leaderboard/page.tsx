"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface LeaderRow {
  user_id: string;
  name: string;
  sent: number;   // crops sent to admin for review
}

export default function TrainerLeaderboardPage() {
  const [rows, setRows]       = useState<LeaderRow[]>([]);
  const [seasonStart, setSeasonStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  // Trainers can view the board; admin-only tabs stay hidden for them.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/admin/training/leaderboard")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setError(d.error ?? `HTTP ${r.status}`); setRows([]); return; }
        setRows((d.trainers as LeaderRow[]) ?? []);
        setSeasonStart((d.season_start as string) ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Network error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/admin/training/queue?limit=1").then((r) => setIsAdmin(r.ok)).catch(() => setIsAdmin(false));
  }, []);

  const top = rows[0];

  return (
    <div className="space-y-5">
      <TrainingTabs isAdmin={isAdmin === true} />

      <div>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <span style={{ fontSize: 22 }}>🏆</span> Trainer Leaderboard
        </h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Trainers ranked by how many name crops they&apos;ve sent to admin. The top trainer wears the crown 👑.
        </p>
        {seasonStart && (
          <p className="text-[11px] text-indigo-700 mt-1 inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">
            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>restart_alt</span>
            New round — counting from{" "}
            {new Date(seasonStart).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          <span className="font-semibold">Failed to load:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-xs text-slate-400">Loading leaderboard…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl py-16 text-center px-6">
          <span className="material-symbols-outlined text-slate-300 mb-3 inline-block" style={{ fontSize: 48 }}>
            emoji_events
          </span>
          <h2 className="text-sm font-semibold text-slate-700 mb-1">New round — everyone starts at zero</h2>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            The board has been reset. The first trainer to verify a crop takes the crown 👑 —
            send some for review and your name appears here.
          </p>
        </div>
      ) : (
        <>
          {/* Champion banner */}
          {top && top.sent > 0 && (
            <div className="relative overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                  <div className="w-14 h-14 rounded-full bg-amber-400 text-white flex items-center justify-center text-xl font-bold shadow">
                    {initials(top.name)}
                  </div>
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-2xl" title="Top trainer">👑</span>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-amber-700 font-bold">Top Trainer</p>
                  <p className="text-base font-bold text-slate-800 truncate">{top.name}</p>
                  <p className="text-xs text-slate-600">
                    <span className="font-bold text-amber-700">{top.sent}</span> crops sent to admin
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Ranked list — name + how much they sent, nothing else */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm divide-y divide-slate-50 overflow-hidden">
            {rows.map((t, i) => {
              const rank = i + 1;
              const nameEl = isAdmin ? (
                <Link href={`/admin/users/${t.user_id}`} className="font-semibold text-slate-800 hover:text-indigo-700 truncate inline-flex items-center gap-1">
                  {rank === 1 && <span title="Top trainer">👑</span>}
                  {t.name}
                </Link>
              ) : (
                <span className="font-semibold text-slate-800 truncate inline-flex items-center gap-1">
                  {rank === 1 && <span title="Top trainer">👑</span>}
                  {t.name}
                </span>
              );
              return (
                <div
                  key={t.user_id}
                  className={"flex items-center gap-3 px-4 py-3 " + (rank === 1 ? "bg-amber-50/60" : "hover:bg-slate-50")}
                >
                  <RankBadge rank={rank} />
                  <div className="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center text-xs font-bold shrink-0">
                    {initials(t.name)}
                  </div>
                  <div className="min-w-0 flex-1">{nameEl}</div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-slate-800 leading-none">{t.sent}</p>
                    <p className="text-[9px] uppercase tracking-wider text-slate-400">sent</p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return <span className="w-7 h-7 rounded-full bg-amber-400 text-white flex items-center justify-center text-sm shrink-0" title="1st">👑</span>;
  }
  const medal = rank === 2 ? "bg-slate-300 text-white" : rank === 3 ? "bg-amber-700 text-white" : "bg-slate-100 text-slate-500";
  return (
    <span className={"w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 " + medal}>
      {rank}
    </span>
  );
}

function initials(name: string): string {
  const parts = (name || "T").trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "T") + (parts[1]?.[0] ?? "")).toUpperCase();
}

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
                (active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-700")
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
