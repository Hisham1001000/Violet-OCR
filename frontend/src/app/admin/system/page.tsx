"use client";

import { useEffect, useState } from "react";

interface Setting {
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  updated_at: string;
}

export default function AdminSystemPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState<string | null>(null);
  const [drafts, setDrafts]     = useState<Record<string, string>>({});
  const [msgs, setMsgs]         = useState<Record<string, string>>({});

  function load() {
    setLoading(true);
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings ?? []);
        const initial: Record<string, string> = {};
        (d.settings ?? []).forEach((s: Setting) => {
          initial[s.key] = JSON.stringify(s.value, null, 2);
        });
        setDrafts(initial);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function save(key: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(drafts[key] ?? ""); }
    catch { setMsgs((m) => ({ ...m, [key]: "Invalid JSON" })); return; }

    setSaving(key);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: parsed }),
    });
    const d = await res.json();
    setSaving(null);
    setMsgs((m) => ({ ...m, [key]: res.ok ? "Saved!" : d.error ?? "Failed" }));
    if (res.ok) load();
  }

  const ICONS: Record<string, string> = {
    plan_prices: "attach_money",
    plan_limits: "auto_stories",
    features:    "toggle_on",
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-slate-800">System Settings</h1>
        <p className="text-xs text-slate-500 mt-0.5">Global configuration stored in the database</p>
      </div>

      {loading ? (
        <div className="text-xs text-slate-400 py-16 text-center">Loading…</div>
      ) : (
        <div className="space-y-4">
          {settings.map((s) => (
            <div key={s.key} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
                  <span className="material-symbols-outlined text-slate-600" style={{ fontSize: 16 }}>
                    {ICONS[s.key] ?? "settings"}
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-800 font-mono">{s.key}</h3>
                  {s.description && <p className="text-[11px] text-slate-500">{s.description}</p>}
                </div>
                <span className="ml-auto text-[10px] text-slate-400">
                  Updated {new Date(s.updated_at).toLocaleDateString("en-GB")}
                </span>
              </div>
              <div className="p-5 space-y-3">
                <textarea
                  value={drafts[s.key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  rows={Object.keys(s.value).length + 2}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-3 text-xs font-mono text-slate-800 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 resize-none"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => save(s.key)}
                    disabled={saving === s.key}
                    className="bg-slate-800 text-white text-xs font-medium px-4 py-2 rounded-xl hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  >
                    {saving === s.key ? "Saving…" : "Save Changes"}
                  </button>
                  {msgs[s.key] && (
                    <span className={`text-[11px] font-medium ${msgs[s.key] === "Saved!" ? "text-emerald-600" : "text-red-500"}`}>
                      {msgs[s.key]}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
