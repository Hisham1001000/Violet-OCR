"use client";

import { useState, useEffect, useRef } from "react";
import { useLang, type Lang } from "@/lib/lang-context";
import { T } from "@/lib/translations";

export default function SettingsPage() {
  const { lang, setLang } = useLang();
  const isRtl = lang === "ar";
  const t = T.settings;

  const [email, setEmail]               = useState<string>("—");
  const [langOpen, setLangOpen]         = useState(false);
  const langRef                         = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => { if (d?.user?.email) setEmail(d.user.email); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close language dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const accountRows = [
    { label: t.email[lang],  value: email,        icon: "mail"              },
  ];

  const langOptions: { value: Lang; label: string; flag: string }[] = [
    { value: "en", label: "English",  flag: "🇺🇸" },
    { value: "ar", label: "العربية",  flag: "🇸🇦" },
  ];

  const currentLang = langOptions.find((o) => o.value === lang);

  // OCR engines info
  const ocrEngines = [
    { icon: "visibility",    label: { en: "Google Vision", ar: "Google Vision" }, color: "#4285f4" },
    { icon: "cloud",         label: { en: "Azure Document Intelligence", ar: "Azure Document Intelligence" }, color: "#0078d4" },
    { icon: "auto_awesome",  label: { en: "Gemini AI",     ar: "Gemini AI"     }, color: "#7c3aed" },
  ];

  return (
    <>
      <div className="max-w-2xl mx-auto space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-lg font-semibold text-on-background">{t.title[lang]}</h1>
          <p className="text-xs text-on-surface-variant mt-0.5">{t.subtitle[lang]}</p>
        </div>

        {/* ── Account section ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
          <div className="px-5 py-3.5 border-b border-slate-50">
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t.account[lang]}</h2>
          </div>
          <div className="divide-y divide-slate-50">
            {accountRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center">
                    <span className="material-symbols-outlined text-slate-400" style={{ fontSize: 14 }}>{row.icon}</span>
                  </div>
                  <span className="text-xs font-medium text-[#35313a]">{row.label}</span>
                </div>
                <span className="text-xs text-slate-400 font-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Preferences section ──────────────────────────────────────── */}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
          <div className="px-5 py-3.5 border-b border-slate-50">
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t.preferences[lang]}</h2>
          </div>

          {/* Export format */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-slate-400" style={{ fontSize: 14 }}>table_view</span>
              </div>
              <span className="text-xs font-medium text-[#35313a]">{t.exportFmt[lang]}</span>
            </div>
            <span className="text-xs text-slate-400">Excel (.xlsx)</span>
          </div>

          {/* ── OCR Engines — informational, not a user choice ── */}
          <div className="px-5 py-4 border-b border-slate-50">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-lg bg-violet-50 flex items-center justify-center shrink-0 mt-0.5">
                <span className="material-symbols-outlined text-violet-500" style={{ fontSize: 14 }}>document_scanner</span>
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-[#35313a] mb-0.5">{t.provider[lang]}</p>
                <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                  {lang === "ar"
                    ? "نستخدم ثلاثة محركات OCR متزامنة ونختار أفضل نتيجة تلقائياً لتحقيق أعلى دقة."
                    : "We run three OCR engines simultaneously and automatically select the best result for maximum accuracy."}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ocrEngines.map((eng) => (
                    <div
                      key={eng.label.en}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "7px 10px",
                        background: "#f8fafc",
                        borderRadius: 8,
                        border: "1px solid #f1f5f9",
                      }}
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 14, color: eng.color }}
                      >
                        {eng.icon}
                      </span>
                      <span style={{ fontSize: 11, color: "#475569", fontWeight: 500 }}>
                        {eng.label[lang as "en" | "ar"]}
                      </span>
                      <span style={{ marginInlineStart: "auto", fontSize: 9, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                        {lang === "ar" ? "نشط" : "Active"}
                      </span>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Interface Language — custom styled dropdown ── */}
          <div className="flex items-center justify-between px-5 py-3.5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-slate-400" style={{ fontSize: 14 }}>language</span>
              </div>
              <span className="text-xs font-medium text-[#35313a]">{t.language[lang]}</span>
            </div>

            {/* Custom language picker — RTL-aware */}
            <div ref={langRef} style={{ position: "relative" }}>
              <button
                onClick={() => setLangOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 10px 6px 12px",
                  fontSize: 11, fontWeight: 500, color: "#35313a",
                  background: "#f8fafc", border: "1px solid #e2e8f0",
                  borderRadius: 8, cursor: "pointer",
                  transition: "border-color 0.12s, box-shadow 0.12s",
                  ...(langOpen ? { borderColor: "#a78bfa", boxShadow: "0 0 0 3px rgba(167,139,250,0.12)" } : {}),
                }}
              >
                <span style={{ fontSize: 14 }}>{currentLang?.flag}</span>
                {currentLang?.label}
                <span
                  className="material-symbols-outlined"
                  style={{
                    fontSize: 14, color: "#94a3b8",
                    transition: "transform 0.18s ease",
                    transform: langOpen ? "rotate(180deg)" : "rotate(0deg)",
                    display: "inline-block",
                  }}
                >
                  expand_more
                </span>
              </button>

              {/* Dropdown — opens UPWARD to avoid overflow:hidden clip from card parent */}
              <div
                style={{
                  position: "absolute",
                  ...(isRtl ? { left: 0 } : { right: 0 }),
                  bottom: "calc(100% + 6px)",
                  width: 148,
                  background: "#fff",
                  borderRadius: 12,
                  padding: "5px 0",
                  zIndex: 100,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.13), 0 2px 6px rgba(0,0,0,0.06)",
                  border: "1px solid rgba(0,0,0,0.06)",
                  opacity: langOpen ? 1 : 0,
                  transform: langOpen ? "translateY(0) scale(1)" : "translateY(8px) scale(0.96)",
                  pointerEvents: langOpen ? "auto" : "none",
                  transition: "opacity 0.18s cubic-bezier(0.16,1,0.3,1), transform 0.18s cubic-bezier(0.16,1,0.3,1)",
                }}
              >
                {langOptions.map((opt) => {
                  const active = lang === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { setLang(opt.value); setLangOpen(false); }}
                      style={{
                        width: "100%",
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "9px 12px",
                        fontSize: 12,
                        color: active ? "#7c3aed" : "#35313a",
                        fontWeight: active ? 600 : 400,
                        background: active ? "rgba(124,58,237,0.05)" : "none",
                        border: "none", cursor: "pointer",
                        transition: "background 0.1s",
                        textAlign: "start",
                      }}
                      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "#f8fafc"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = active ? "rgba(124,58,237,0.05)" : "none"; }}
                    >
                      <span style={{ fontSize: 15 }}>{opt.flag}</span>
                      {opt.label}
                      {active && (
                        <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#7c3aed", marginInlineStart: "auto" }}>check</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ── Danger zone ──────────────────────────────────────────────── */}
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(239,68,68,0.12)", background: "rgba(254,242,242,0.5)" }}>
          <div className="px-5 py-3.5 border-b" style={{ borderColor: "rgba(239,68,68,0.08)" }}>
            <h2 className="text-[10px] font-bold uppercase tracking-wider text-red-400">{t.danger[lang]}</h2>
          </div>
          <div className="px-5 py-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-[#35313a]">{t.deleteAccount[lang]}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{t.deleteDesc[lang]}</p>
            </div>
            <button
              onClick={() => {
                const confirmMsg = lang === "ar"
                  ? "سيتم فتح بريد إلكتروني لإرسال طلب حذف الحساب إلى الدعم. هل تريد المتابعة؟"
                  : "This opens an email to send an account-deletion request to support. Continue?";
                if (!window.confirm(confirmMsg)) return;
                const subject = encodeURIComponent("Account deletion request");
                const body = encodeURIComponent(
                  `Please delete my Violet account and associated documents.\n\nAccount email: ${email}`
                );
                window.location.href = `mailto:violetocr4@gmail.com?subject=${subject}&body=${body}`;
              }}
              className="text-xs font-semibold text-red-500 border border-red-200 px-4 py-1.5 rounded-full hover:bg-red-50 transition-colors"
            >
              {t.deleteBtn[lang]}
            </button>
          </div>
        </div>

      </div>
    </>
  );
}
