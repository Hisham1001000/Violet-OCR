"use client";

import { useState, useEffect, useCallback } from "react";

interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  full_name: string | null;
  created_at: string;
  contacted: boolean;
  upgraded: boolean;
  user_id: string | null;
  current_plan: string | null;
}

const PLAN_ORDER: Record<string, number> = { free: 0, starter: 1, standard: 2, pro: 3 };
const ALL_PLANS = ["free", "starter", "standard", "pro"] as const;

const PLAN_BADGE: Record<string, string> = {
  free:     "bg-slate-100 text-slate-600",
  starter:  "bg-blue-100 text-blue-700",
  standard: "bg-violet-100 text-violet-700",
  pro:      "bg-purple-100 text-purple-700",
};

export default function AdminWaitlistPage() {
  const [entries, setEntries]       = useState<WaitlistEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch]         = useState("");
  const [planTarget, setPlanTarget] = useState<{ entryId: string; userId: string; currentPlan: string } | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>("starter");

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/waitlist")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setEntries(d.entries ?? []);
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function markContacted(entry: WaitlistEntry) {
    setActionLoading(entry.id + "_contacted");
    await fetch(`/api/admin/waitlist/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacted: !entry.contacted }),
    });
    setActionLoading(null);
    load();
  }

  function openPlanModal(entry: WaitlistEntry) {
    const currentPlan = entry.current_plan ?? "free";
    setPlanTarget({ entryId: entry.id, userId: entry.user_id ?? "", currentPlan });
    setSelectedPlan(currentPlan);
  }

  async function applyPlanChange() {
    if (!planTarget) return;
    setActionLoading(planTarget.entryId + "_plan");
    await fetch(`/api/admin/users/${planTarget.userId}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: selectedPlan }),
    });
    if (selectedPlan !== "free") {
      await fetch(`/api/admin/waitlist/${planTarget.entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgraded: true }),
      });
    }
    setActionLoading(null);
    setPlanTarget(null);
    load();
  }

  const filtered = search.trim()
    ? entries.filter((e) => {
        const q  = search.toLowerCase();
        const n  = (e.full_name ?? e.name ?? "").toLowerCase();
        const em = e.email.toLowerCase();
        return n.includes(q) || em.includes(q);
      })
    : entries;

  const pending  = entries.filter((e) => !e.upgraded);
  const upgradedList = entries.filter((e) => e.upgraded);

  const isDowngrade = planTarget !== null
    ? (PLAN_ORDER[selectedPlan] ?? 0) < (PLAN_ORDER[planTarget.currentPlan] ?? 0)
    : false;

  return (
    <div>
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-headline font-semibold text-on-background">Waitlist</h1>
            <p className="text-xs text-on-surface-variant mt-0.5">
              {pending.length} pending · {upgradedList.length} upgraded
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-100/80 px-3 py-1.5 rounded-full border border-slate-200/60">
              <span className="material-symbols-outlined text-slate-400" style={{ fontSize: 13 }}>search</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="bg-transparent border-none outline-none text-xs w-44 placeholder:text-slate-300 text-slate-700"
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-slate-300 hover:text-slate-500">
                  <span className="material-symbols-outlined" style={{ fontSize: 11 }}>close</span>
                </button>
              )}
            </div>
            <button onClick={load} className="text-[11px] text-primary hover:underline flex items-center gap-1">
              <span className="material-symbols-outlined" style={{ fontSize: 13 }}>refresh</span>
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
        )}

        {loading && (
          <div className="text-xs text-on-surface-variant py-10 text-center">Loading…</div>
        )}

        {!loading && entries.length === 0 && (
          <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-low py-12 text-center">
            <span className="material-symbols-outlined text-on-surface-variant/30 block mb-2" style={{ fontSize: 32 }}>inbox</span>
            <p className="text-xs text-on-surface-variant">No waitlist entries yet</p>
          </div>
        )}

        {!loading && filtered.length === 0 && search && (
          <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-low py-8 text-center">
            <p className="text-xs text-on-surface-variant">No results for &ldquo;{search}&rdquo;</p>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/10 editorial-shadow overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-outline-variant/10 text-on-surface-variant text-left">
                  <th className="px-5 py-3 font-medium">Email</th>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Current Plan</th>
                  <th className="px-5 py-3 font-medium">Joined</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/8">
                {filtered.map((entry) => {
                  const currentPlan = entry.current_plan ?? "free";
                  return (
                    <tr key={entry.id} className={`hover:bg-surface-container-low transition-colors ${entry.upgraded ? "opacity-60" : ""}`}>
                      <td className="px-5 py-3 font-medium text-on-background">{entry.email}</td>
                      <td className="px-5 py-3 text-on-surface-variant">
                        {entry.full_name ?? entry.name ?? <span className="text-on-surface-variant/30">—</span>}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${PLAN_BADGE[currentPlan] ?? PLAN_BADGE.free}`}>
                          {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-on-surface-variant">
                        {new Date(entry.created_at).toLocaleDateString("en-GB")}
                      </td>
                      <td className="px-5 py-3">
                        {entry.upgraded ? (
                          <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">Upgraded</span>
                        ) : entry.contacted ? (
                          <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">Contacted</span>
                        ) : (
                          <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-[10px] font-semibold">Pending</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => markContacted(entry)}
                            disabled={actionLoading === entry.id + "_contacted"}
                            className="text-[10px] border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-low px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40"
                          >
                            {entry.contacted ? "Unmark" : "Mark contacted"}
                          </button>
                          {entry.user_id && (
                            <button
                              onClick={() => openPlanModal(entry)}
                              className="text-[10px] bg-slate-800 text-white px-2.5 py-1 rounded-lg hover:bg-slate-700 transition-colors"
                            >
                              Change plan
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Plan change modal */}
        {planTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
            onClick={(e) => { if (e.target === e.currentTarget) setPlanTarget(null); }}
          >
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-4">
              <h3 className="font-semibold text-slate-800">Change User Plan</h3>

              <div className="flex items-center justify-between text-xs bg-slate-50 rounded-xl px-3.5 py-2.5">
                <span className="text-slate-500">Current plan</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${PLAN_BADGE[planTarget.currentPlan] ?? PLAN_BADGE.free}`}>
                  {planTarget.currentPlan.charAt(0).toUpperCase() + planTarget.currentPlan.slice(1)}
                </span>
              </div>

              <div className="space-y-2">
                {ALL_PLANS.map((p) => {
                  const isCurrentPlan = p === planTarget.currentPlan;
                  const isDown = (PLAN_ORDER[p] ?? 0) < (PLAN_ORDER[planTarget.currentPlan] ?? 0);
                  return (
                    <label
                      key={p}
                      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all ${
                        selectedPlan === p ? "border-slate-800 bg-slate-50" : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="plan"
                        value={p}
                        checked={selectedPlan === p}
                        onChange={() => setSelectedPlan(p)}
                        className="accent-slate-800"
                      />
                      <span className="flex-1 text-sm text-slate-800">
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </span>
                      {isCurrentPlan && <span className="text-[10px] text-slate-400">current</span>}
                      {isDown && !isCurrentPlan && <span className="text-[10px] text-amber-600 font-medium">↓ downgrade</span>}
                    </label>
                  );
                })}
              </div>

              {isDowngrade && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
                  <span className="material-symbols-outlined text-amber-600 shrink-0 mt-0.5" style={{ fontSize: 14 }}>warning</span>
                  <p className="text-[11px] text-amber-800">You are downgrading this user. Their page limit will decrease immediately.</p>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => setPlanTarget(null)}
                  className="flex-1 border border-slate-200 text-slate-600 text-sm py-2 rounded-xl hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={applyPlanChange}
                  disabled={!!actionLoading || selectedPlan === planTarget.currentPlan}
                  className={`flex-1 text-white text-sm py-2 rounded-xl disabled:opacity-50 transition-colors ${
                    isDowngrade ? "bg-amber-600 hover:bg-amber-700" : "bg-slate-800 hover:bg-slate-700"
                  }`}
                >
                  {actionLoading ? "Saving…" : isDowngrade ? "Confirm Downgrade" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
