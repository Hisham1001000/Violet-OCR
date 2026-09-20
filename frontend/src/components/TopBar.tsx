"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useLang } from "@/lib/lang-context";
import { T } from "@/lib/translations";
import {
  type AppNotification,
  getNotifications,
  markAllRead,
  listenForChanges,
  relativeTime,
} from "@/lib/notifications";
import { listenBalanceChanged } from "@/lib/balance-events";
import { formatUsd } from "@/lib/billing";
import type { UsageResponse } from "@/lib/types";

interface TopBarProps {
  title?: string;
  showMobileMenu?: boolean;
  onOpenMobileMenu?: () => void;
}

interface DocSuggestion {
  id: string;
  document_name: string;
}

export function TopBar({ title = "Dashboard", showMobileMenu = false, onOpenMobileMenu }: TopBarProps) {
  const router = useRouter();
  const { lang } = useLang();
  const t = T.topbar;
  const isRtl = lang === "ar";

  const [menuOpen, setMenuOpen]               = useState(false);
  const [notifOpen, setNotifOpen]             = useState(false);
  const [notifications, setNotifications]     = useState<AppNotification[]>([]);
  const [userInitial, setUserInitial]         = useState<string | null>(null);
  const [search, setSearch]                   = useState("");
  const [allDocs, setAllDocs]                 = useState<DocSuggestion[]>([]);
  const docsLoaded = useRef(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [usage, setUsage]                     = useState<UsageResponse | null>(null);
  const [creditOpen, setCreditOpen]           = useState(false);
  const [userEmail, setUserEmail]             = useState<string | undefined>();
  const creditTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchRef = useRef<HTMLDivElement>(null);
  const menuRef   = useRef<HTMLDivElement>(null);
  const notifRef  = useRef<HTMLDivElement>(null);
  const creditRef = useRef<HTMLDivElement>(null);

  const supabase = createClient();

  // Load user + docs
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) {
        setUserInitial(data.user.email[0].toUpperCase());
        setUserEmail(data.user.email);
      }
    });
    // The document list backs search suggestions only, and costs a median
    // 2006ms. Loading it on mount made every page entry wait for data nobody
    // had asked for yet, so it is fetched on first focus of the search box and
    // then kept for the session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Balance ───────────────────────────────────────────────────────────────
  // Refetched on mount, whenever something says the balance moved, and when the
  // tab regains focus (a top-up happens on WhatsApp, in another window).
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/usage", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive && typeof d?.balance_cents === "number") setUsage(d as UsageResponse); })
        .catch(() => {});
    };
    load();
    const off = listenBalanceChanged(load);
    const onFocus = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onFocus);
    return () => { alive = false; off(); document.removeEventListener("visibilitychange", onFocus); };
  }, []);

  // Load notifications + listen for changes
  useEffect(() => {
    setNotifications(getNotifications());
    return listenForChanges(() => setNotifications(getNotifications()));
  }, []);

  // Close panels on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSuggestions(false);
      if (menuRef.current   && !menuRef.current.contains(e.target as Node))   setMenuOpen(false);
      if (notifRef.current  && !notifRef.current.contains(e.target as Node))  setNotifOpen(false);
      if (creditRef.current && !creditRef.current.contains(e.target as Node)) setCreditOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function loadDocsOnce() {
    if (docsLoaded.current) return;
    docsLoaded.current = true;
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => setAllDocs(d.jobs ?? []))
      .catch(() => { docsLoaded.current = false; });
  }

  const suggestions: DocSuggestion[] = search.trim().length > 0
    ? allDocs.filter((d) => d.document_name.toLowerCase().includes(search.toLowerCase())).slice(0, 6)
    : [];

  const unreadCount = notifications.filter((n) => !n.read).length;

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  }

  function handleOpenNotifications() {
    setNotifOpen((v) => !v);
    setMenuOpen(false);
  }

  function handleOpenMenu() {
    setMenuOpen((v) => !v);
    setNotifOpen(false);
  }

  // Shared dropdown transition style
  const dropdownTransition = {
    transition: "opacity 0.18s cubic-bezier(0.16,1,0.3,1), transform 0.18s cubic-bezier(0.16,1,0.3,1)",
  };

  // Dropdown anchor: in RTL the panels open rightward (left:0); in LTR leftward (right:0)
  const anchorSide: React.CSSProperties = isRtl ? { left: 0 } : { right: 0 };

  return (
    <header
      className="flex justify-between items-center w-full h-12 px-3 sm:px-6 sticky top-0 z-40 bg-[#fef7fe]/90 backdrop-blur-xl"
      style={{ borderBottom: "1px solid rgba(183,175,187,0.12)" }}
    >
      {/* Title + Search */}
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        {showMobileMenu && (
          <button
            onClick={onOpenMobileMenu}
            aria-label="Open menu"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[#4A148C] hover:bg-slate-100 transition-colors shrink-0"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 22 }}>menu</span>
          </button>
        )}
        <span className="font-semibold text-[#4A148C] text-sm tracking-tight truncate">{title}</span>

        <div ref={searchRef} className="hidden lg:block relative">
          <div className="flex items-center bg-slate-100/80 px-3 py-1.5 rounded-full gap-2">
            <span className="material-symbols-outlined text-slate-400" style={{ fontSize: 14 }}>search</span>
            <input
              className="bg-transparent border-none focus:ring-0 text-xs w-44 p-0 outline-none placeholder:text-slate-300 text-[#35313a]"
              placeholder={t.searchPlaceholder[lang]}
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShowSuggestions(true); }}
              onFocus={() => { setShowSuggestions(true); loadDocsOnce(); }}
            />
            {search && (
              <button onClick={() => { setSearch(""); setShowSuggestions(false); }} className="text-slate-300 hover:text-slate-500 transition-colors">
                <span className="material-symbols-outlined" style={{ fontSize: 12 }}>close</span>
              </button>
            )}
          </div>

          {showSuggestions && suggestions.length > 0 && (
            <div
              className="dropdown-in absolute top-full mt-2 w-72 bg-white rounded-xl py-1.5 z-50"
              style={{ [isRtl ? "right" : "left"]: 0, boxShadow: "0 8px 30px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06)" }}
            >
              {suggestions.map((doc) => (
                <Link key={doc.id} href={`/documents/${doc.id}`}
                  onClick={() => { setSearch(""); setShowSuggestions(false); }}
                  className="flex items-center gap-2.5 px-3.5 py-2 hover:bg-slate-50 transition-colors">
                  <span className="material-symbols-outlined text-violet-400" style={{ fontSize: 14 }}>description</span>
                  <span className="text-xs text-[#35313a] truncate">{doc.document_name}</span>
                </Link>
              ))}
            </div>
          )}
          {showSuggestions && search.trim().length > 0 && suggestions.length === 0 && (
            <div
              className="dropdown-in absolute top-full mt-2 w-72 bg-white rounded-xl py-3 px-4 z-50"
              style={{ [isRtl ? "right" : "left"]: 0, boxShadow: "0 8px 30px rgba(0,0,0,0.10)" }}
            >
              <p className="text-xs text-slate-400">{t.noResults[lang]} &ldquo;{search}&rdquo;</p>
            </div>
          )}
        </div>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-2">

        {/* ── Credit ────────────────────────────────────────────────────── */}
        {/* Opens on hover, because checking what is left should not cost a
            click; the click itself is reserved for adding credit. A short
            close delay keeps the panel open while the pointer travels to it. */}
        {usage && (
          <div
            ref={creditRef}
            className="relative"
            onMouseEnter={() => {
              if (creditTimer.current) clearTimeout(creditTimer.current);
              setCreditOpen(true);
            }}
            onMouseLeave={() => {
              if (creditTimer.current) clearTimeout(creditTimer.current);
              creditTimer.current = setTimeout(() => setCreditOpen(false), 180);
            }}
          >
            <button
              onClick={() => {
                if (creditTimer.current) clearTimeout(creditTimer.current);
                setCreditOpen((v) => !v);
                setNotifOpen(false);
                setMenuOpen(false);
              }}
              className={`flex items-center gap-1.5 h-8 ps-2.5 pe-3 rounded-full text-xs font-semibold
                          transition-colors shrink-0 ${
                usage.balance_cents <= 0
                  ? "bg-red-50 text-red-600 hover:bg-red-100"
                  : "bg-slate-100/80 text-[#4A148C] hover:bg-slate-200/80"
              }`}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16, fontVariationSettings: "'FILL' 1, 'wght' 400" }}
              >
                toll
              </span>
              <span className="hidden sm:inline font-normal opacity-70">
                {lang === "ar" ? "الرصيد" : "Credit"}
              </span>
              <span dir="ltr" className="tabular-nums">{formatUsd(usage.balance_cents)}</span>
            </button>

            {/* Panel */}
            <div
              style={{
                position: "absolute",
                ...anchorSide,
                top: "calc(100% + 8px)",
                width: 268,
                background: "#fff",
                borderRadius: 14,
                overflow: "hidden",
                zIndex: 50,
                boxShadow: "0 16px 48px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.06)",
                border: "1px solid rgba(0,0,0,0.06)",
                opacity: creditOpen ? 1 : 0,
                transform: creditOpen ? "translateY(0) scale(1)" : "translateY(-10px) scale(0.97)",
                pointerEvents: creditOpen ? "auto" : "none",
                ...dropdownTransition,
              }}
            >
              <div style={{ padding: "14px 16px 12px" }}>
                <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>
                  {lang === "ar" ? "الرصيد المتبقي" : "Credit remaining"}
                </p>
                <p dir="ltr" style={{
                  fontSize: 26, fontWeight: 300, letterSpacing: "-0.02em", margin: "3px 0 0",
                  color: usage.balance_cents <= 0 ? "#dc2626" : "#35313a",
                  textAlign: isRtl ? "right" : "left",
                }}>
                  {formatUsd(usage.balance_cents)}
                </p>
                <p style={{ fontSize: 11, color: "#94a3b8", margin: "3px 0 0" }}>
                  {lang === "ar"
                    ? `يكفي لنحو ${usage.rows_affordable.toLocaleString()} صف`
                    : `about ${usage.rows_affordable.toLocaleString()} rows`}
                </p>

                {/* Used vs granted */}
                <div style={{
                  height: 5, borderRadius: 999, background: "#f1f5f9",
                  overflow: "hidden", marginTop: 12,
                }}>
                  <div style={{
                    height: "100%", borderRadius: 999,
                    width: usage.lifetime_cents > 0
                      ? `${Math.min(100, (usage.spent_cents / usage.lifetime_cents) * 100)}%`
                      : "0%",
                    background: "linear-gradient(90deg,#8b5cf6,#7c3aed)",
                    transition: "width 0.5s cubic-bezier(0.16,1,0.3,1)",
                  }} />
                </div>
                <div dir="ltr" style={{
                  display: "flex", justifyContent: "space-between",
                  fontSize: 10.5, color: "#94a3b8", marginTop: 6,
                }}>
                  <span>{formatUsd(usage.spent_cents)} {lang === "ar" ? "مستخدم" : "used"}</span>
                  <span>{formatUsd(usage.lifetime_cents)}</span>
                </div>
              </div>

              <Link
                href="/billing"
                onClick={() => setCreditOpen(false)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "11px 16px", borderTop: "1px solid #f1f5f9",
                  fontSize: 11.5, color: "#475569", textDecoration: "none",
                }}
                className="hover:bg-slate-50 transition-colors"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>settings</span>
                {lang === "ar" ? "الرصيد وكشف الحساب" : "Credit & billing"}
              </Link>
            </div>
          </div>
        )}

        {/* ── Notification bell ─────────────────────────────────────────── */}
        <div ref={notifRef} className="relative">
          <button
            onClick={handleOpenNotifications}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 transition-colors relative"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>notifications</span>
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 min-w-[14px] h-[14px] bg-violet-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>

          {/* Notification panel — always rendered, toggled with CSS */}
          <div
            style={{
              position: "absolute",
              ...anchorSide,
              top: "calc(100% + 8px)",
              width: 300,
              background: "#fff",
              borderRadius: 14,
              overflow: "hidden",
              zIndex: 50,
              boxShadow: "0 16px 48px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.06)",
              border: "1px solid rgba(0,0,0,0.06)",
              opacity: notifOpen ? 1 : 0,
              transform: notifOpen ? "translateY(0) scale(1)" : "translateY(-10px) scale(0.97)",
              pointerEvents: notifOpen ? "auto" : "none",
              ...dropdownTransition,
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #f1f5f9" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>
                {lang === "ar" ? "الإشعارات" : "Notifications"}
                {unreadCount > 0 && (
                  <span style={{ marginInlineStart: 6, background: "#ede9fe", color: "#7c3aed", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 999 }}>
                    {unreadCount}
                  </span>
                )}
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={() => { markAllRead(); }}
                  style={{ fontSize: 10, color: "#7c3aed", background: "none", border: "none", cursor: "pointer", fontWeight: 500 }}
                >
                  {lang === "ar" ? "تحديد كمقروء" : "Mark all read"}
                </button>
              )}
            </div>

            {/* List */}
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {notifications.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 28, color: "#cbd5e1", display: "block", marginBottom: 8 }}>notifications_none</span>
                  <p style={{ fontSize: 11, color: "#94a3b8" }}>
                    {lang === "ar" ? "لا توجد إشعارات" : "No notifications yet"}
                  </p>
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      display: "flex", gap: 12, padding: "12px 16px",
                      borderBottom: "1px solid #f8fafc",
                      background: n.read ? "transparent" : "rgba(237,233,254,0.35)",
                    }}
                  >
                    <div style={{ width: 6, height: 6, borderRadius: "50%", marginTop: 5, flexShrink: 0, background: n.read ? "transparent" : "#7c3aed" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 11, color: "#334155", lineHeight: 1.5 }}>{n.message}</p>
                      <p style={{ fontSize: 10, color: "#94a3b8", marginTop: 3 }}>{relativeTime(n.timestamp, lang)}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="h-5 w-px bg-slate-200 mx-1" />

        {/* ── Account menu ──────────────────────────────────────────────── */}
        <div ref={menuRef} className="relative">
          <button
            onClick={handleOpenMenu}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full hover:bg-slate-100 transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-violet-100 flex items-center justify-center text-[10px] font-bold text-violet-600">
              {userInitial ?? <span className="material-symbols-outlined" style={{ fontSize: 13 }}>person</span>}
            </div>
            <span
              className="material-symbols-outlined text-slate-400"
              style={{
                fontSize: 14,
                transition: "transform 0.2s ease",
                transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)",
                display: "inline-block",
              }}
            >
              expand_more
            </span>
          </button>

          {/* Account dropdown — always rendered, toggled with CSS */}
          <div
            style={{
              position: "absolute",
              ...anchorSide,
              top: "calc(100% + 8px)",
              width: 168,
              background: "#fff",
              borderRadius: 14,
              padding: "6px 0",
              zIndex: 50,
              boxShadow: "0 16px 48px rgba(0,0,0,0.13), 0 2px 8px rgba(0,0,0,0.06)",
              border: "1px solid rgba(0,0,0,0.06)",
              opacity: menuOpen ? 1 : 0,
              transform: menuOpen ? "translateY(0) scale(1)" : "translateY(-10px) scale(0.97)",
              pointerEvents: menuOpen ? "auto" : "none",
              ...dropdownTransition,
            }}
          >
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 7, padding: "9px 14px",
                fontSize: 12, color: "#35313a", textDecoration: "none",
                transition: "background 0.12s",
              }}
              className="hover:bg-slate-50"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#94a3b8" }}>settings</span>
              {t.settingsLink[lang]}
            </Link>

            <div style={{ margin: "4px 14px", height: 1, background: "#f1f5f9" }} />

            <button
              onClick={handleSignOut}
              style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                gap: 7, padding: "9px 14px",
                fontSize: 12, color: "#ef4444",
                background: "none", border: "none", cursor: "pointer",
                transition: "background 0.12s",
              }}
              className="hover:bg-red-50"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>logout</span>
              {t.signOut[lang]}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
