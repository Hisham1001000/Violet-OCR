"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface Profile {
  user_id: string;
  email: string;
  full_name: string | null;
  plan: string;
  subscription_status: string;
  pages_used_this_month: number;
  balance_cents: number | null;
  rows_used_total: number | null;
  is_admin: boolean;
  is_trainer: boolean;
  is_banned: boolean;
  created_at: string;
  usage_reset_at: string;
}

interface Doc {
  id: string;
  document_name: string;
  status: string;
  created_at: string;
  error_message: string | null;
}

const STATUS_DOT: Record<string, string> = {
  completed:  "bg-emerald-500",
  processing: "bg-blue-500 animate-pulse",
  pending:    "bg-amber-400",
  failed:     "bg-red-500",
};


export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [profile, setProfile]   = useState<Profile | null>(null);
  const [docs, setDocs]         = useState<Doc[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [topUpDollars, setTopUpDollars] = useState("");
  const [msg, setMsg]           = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch(`/api/admin/users/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setProfile(d.profile ?? null);
        setDocs(d.documents ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [id]);

  async function addCredit() {
    const dollars = Number(topUpDollars);
    if (!Number.isFinite(dollars) || dollars === 0) { setMsg("Enter a non-zero amount"); return; }
    // Dollars in, integer cents out -- rounded here so a value like 10.005
    // cannot put a fraction of a cent into the ledger.
    const cents = Math.round(dollars * 100);
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${id}/balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: cents }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) {
      setMsg(`Balance is now $${((d.balance_cents ?? 0) / 100).toFixed(2)}`);
      setTopUpDollars("");
      load();
    } else setMsg(d.error ?? "Failed");
  }

  async function toggleAdmin() {
    if (!profile) return;
    const confirmed = window.confirm(
      profile.is_admin ? "Remove admin access from this user?" : "Grant admin access to this user?"
    );
    if (!confirmed) return;
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_admin: !profile.is_admin }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) { setMsg("Admin status updated"); load(); }
    else setMsg(d.error ?? "Failed");
  }

  async function toggleTrainer() {
    if (!profile) return;
    const confirmed = window.confirm(
      profile.is_trainer
        ? "Revoke trainer access? They will no longer see /admin/training."
        : "Grant trainer access? They will be able to label training crops only — no other admin sections."
    );
    if (!confirmed) return;
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_trainer: !profile.is_trainer }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) { setMsg("Trainer status updated"); load(); }
    else setMsg(d.error ?? "Failed");
  }

  async function toggleBan() {
    if (!profile) return;
    const confirmed = window.confirm(
      profile.is_banned
        ? "Unban this user? They'll be able to log in again."
        : "Ban this user? They'll be signed out and blocked from logging in."
    );
    if (!confirmed) return;
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_banned: !profile.is_banned }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) { setMsg(profile.is_banned ? "User unbanned" : "User banned successfully"); load(); }
    else setMsg(d.error ?? "Failed");
  }

  async function hardDelete() {
    if (!profile) return;
    const confirmed = window.confirm(
      `PERMANENTLY delete ${profile.email}?\n\n` +
      `• Account removed from authentication\n` +
      `• All their documents and pages deleted\n` +
      `• Email freed — they CAN sign up again with the same email\n\n` +
      `If you want to block re-signup, use Ban instead.`
    );
    if (!confirmed) return;
    if (!window.confirm("This cannot be undone. Continue?")) return;
    setSaving(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
    const d = await res.json();
    setSaving(false);
    if (res.ok) { setMsg("User permanently deleted"); router.push("/admin/users"); }
    else setMsg(d.error ?? "Failed");
  }

  if (loading) return <div className="text-xs text-slate-400 py-16 text-center">Loading…</div>;
  if (!profile) return <div className="text-xs text-red-500 py-16 text-center">User not found</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back */}
      <button onClick={() => router.back()} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>arrow_back</span>
        Back to Users
      </button>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-slate-800">{profile.email}</h1>
        {profile.is_banned && (
          <span className="text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full border border-amber-200">
            Banned
          </span>
        )}
      </div>

      {msg && (
        <p className={`text-xs px-4 py-2.5 rounded-xl border ${msg.includes("success") ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-600 border-red-200"}`}>
          {msg}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Profile card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">Profile</h2>
          <dl className="space-y-2.5 text-xs">
            {[
              ["User ID",    profile.user_id],
              ["Email",      profile.email],
              ["Name",       profile.full_name ?? "—"],
              ["Balance",    `$${(((profile.balance_cents ?? 0)) / 100).toFixed(2)}`],
              ["Rows Used",  String(profile.rows_used_total ?? 0)],
              ["Admin",      profile.is_admin ? "Yes" : "No"],
              ["Trainer",    profile.is_trainer ? "Yes" : "No"],
              ["Joined",     new Date(profile.created_at).toLocaleDateString("en-GB")],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Actions card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-5">
          <h2 className="text-sm font-semibold text-slate-800">Actions</h2>

          {/* The only way credit enters an account until a payment provider is
              wired up. add_balance is service-role only, so this route is the
              single door in. */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium text-slate-600">
              Add credit — balance ${(((profile.balance_cents ?? 0)) / 100).toFixed(2)}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.01"
                value={topUpDollars}
                onChange={(e) => setTopUpDollars(e.target.value)}
                placeholder="10.00"
                className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300"
              />
              <button
                onClick={addCredit}
                disabled={saving || !topUpDollars}
                className="bg-slate-800 text-white text-xs font-medium px-4 rounded-xl hover:bg-slate-700 disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                {saving ? "…" : "Add"}
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              Dollars. Negative removes credit. {topUpDollars && !Number.isNaN(Number(topUpDollars))
                ? `= ${Math.round(Number(topUpDollars) * 100)} rows`
                : ""}
            </p>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <button
              onClick={toggleAdmin}
              disabled={saving}
              className={`w-full text-xs font-medium py-2 rounded-xl border transition-colors disabled:opacity-40 ${profile.is_admin ? "border-red-200 text-red-600 hover:bg-red-50" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {profile.is_admin ? "Revoke Admin Access" : "Grant Admin Access"}
            </button>

            <button
              onClick={toggleTrainer}
              disabled={saving}
              className={`w-full text-xs font-medium py-2 rounded-xl border transition-colors disabled:opacity-40 ${profile.is_trainer ? "border-indigo-300 text-indigo-700 hover:bg-indigo-50" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {profile.is_trainer ? "Revoke Trainer Access" : "Grant Trainer Access (training section only)"}
            </button>

            <button
              onClick={toggleBan}
              disabled={saving}
              className={`w-full text-xs font-medium py-2 rounded-xl border transition-colors disabled:opacity-40 ${profile.is_banned ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50" : "border-amber-200 text-amber-700 hover:bg-amber-50"}`}
            >
              {profile.is_banned ? "Unban User (allow login)" : "Ban User (block login + re-signup)"}
            </button>

            <button
              onClick={hardDelete}
              disabled={saving}
              className="w-full text-xs font-medium py-2 rounded-xl border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-40 transition-colors"
            >
              Delete Account (permanent, frees email)
            </button>
          </div>
        </div>
      </div>

      {/* Documents table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-800">Documents ({docs.length})</h2>
        </div>
        {docs.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-8">No documents yet</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-slate-100">
              <tr className="text-left text-slate-500">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-medium text-slate-800 truncate max-w-xs">
                    <Link
                      href={`/admin/documents/${d.id}`}
                      className="hover:text-indigo-700 hover:underline underline-offset-2"
                    >
                      {d.document_name}
                    </Link>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[d.status] ?? STATUS_DOT.pending}`} />
                      {d.status}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-slate-400">{new Date(d.created_at).toLocaleDateString("en-GB")}</td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/documents/${d.id}`}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>visibility</span>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
