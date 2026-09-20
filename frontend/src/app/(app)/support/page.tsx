"use client";

import { useState } from "react";
import { useLang } from "@/lib/lang-context";

const tx = (en: string, ar: string) => ({ en, ar });
const T = {
  pageTitle:   tx("Support",                  "الدعم"),
  pageSub:     tx("We're here to help you.",  "نحن هنا لمساعدتك."),
  card1Title:  tx("Documentation",            "التوثيق"),
  card1Desc:   tx("Guides and references",    "الأدلة والمراجع"),
  card2Title:  tx("WhatsApp",                 "واتساب"),
  card2Desc:   tx("Chat with us directly",    "تحدث معنا مباشرة"),
  card3Title:  tx("Report a Bug",             "الإبلاغ عن مشكلة"),
  card3Desc:   tx("Something not working?",   "هل هناك خلل ما؟"),
  card4Title:  tx("Feature Request",          "اقتراح ميزة"),
  card4Desc:   tx("Suggest an improvement",   "اقترح تحسيناً"),
  formTitle:   tx("Send a message",           "أرسل رسالة"),
  formSub:     tx("We'll reply to your account email.", "سنرد على بريد حسابك."),
  labelSubj:   tx("Subject",                  "الموضوع"),
  phSubj:      tx("What do you need help with?", "بماذا تحتاج مساعدة؟"),
  labelMsg:    tx("Message",                  "الرسالة"),
  phMsg:       tx("Describe your issue in detail…", "اشرح مشكلتك بالتفصيل…"),
  btnSend:     tx("Send Message",             "إرسال الرسالة"),
  btnSending:  tx("Sending…",                 "جارٍ الإرسال…"),
  successTitle: tx("Message sent!",           "تم إرسال رسالتك!"),
  successSub:  tx("We'll get back to you soon.", "سنرد عليك في أقرب وقت."),
  errorGeneric: tx("Failed to send. Please try WhatsApp.", "فشل الإرسال. يرجى التواصل عبر واتساب."),
  errSubj:     tx("Subject is required.",     "الموضوع مطلوب."),
  errMsg:      tx("Message is required.",     "الرسالة مطلوبة."),
  whatsappMsg: tx("Hello, I need support with Violet OCR.", "مرحباً، أحتاج مساعدة في منصة فيوليت."),
};
type L = "en" | "ar";

const WHATSAPP = "+972569523615";

export default function SupportPage() {
  const { lang } = useLang();
  const t = (k: keyof typeof T) => T[k][lang as L];

  const [subject, setSubject]   = useState("");
  const [message, setMessage]   = useState("");
  const [sending, setSending]   = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const waUrl = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(t("whatsappMsg"))}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!subject.trim()) { setError(t("errSubj")); return; }
    if (!message.trim()) { setError(t("errMsg"));  return; }

    setSending(true);
    try {
      const res = await fetch("/api/support", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim(), message: message.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("errorGeneric"));
      setSent(true);
      setSubject("");
      setMessage("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
    } finally {
      setSending(false);
    }
  }

  const CARDS = [
    { icon: "menu_book",  title: t("card1Title"), desc: t("card1Desc"), href: "#"    },
    { icon: "chat",       title: t("card2Title"), desc: t("card2Desc"), href: waUrl  },
    { icon: "bug_report", title: t("card3Title"), desc: t("card3Desc"), href: "#"    },
    { icon: "lightbulb",  title: t("card4Title"), desc: t("card4Desc"), href: "#"    },
  ];

  return (
    <>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-xl font-headline font-semibold text-on-background">{t("pageTitle")}</h1>
          <p className="text-xs text-on-surface-variant mt-0.5">{t("pageSub")}</p>
        </div>

        {/* Quick links */}
        <div className="grid grid-cols-2 gap-4">
          {CARDS.map((item) => (
            <a
              key={item.title}
              href={item.href}
              target={item.href.startsWith("http") ? "_blank" : undefined}
              rel="noopener noreferrer"
              className="text-start bg-surface-container-lowest rounded-2xl border border-outline-variant/10 editorial-shadow p-5 hover:border-primary/20 hover:bg-surface-container-low transition-all group no-underline"
            >
              <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center mb-3 group-hover:bg-primary/15 transition-colors">
                <span className="material-symbols-outlined text-primary" style={{ fontSize: 18 }}>{item.icon}</span>
              </div>
              <h3 className="text-xs font-semibold text-on-background mb-0.5">{item.title}</h3>
              <p className="text-[11px] text-on-surface-variant">{item.desc}</p>
            </a>
          ))}
        </div>

        {/* Contact form */}
        <div className="bg-surface-container-lowest rounded-2xl border border-outline-variant/10 editorial-shadow p-6 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-on-background">{t("formTitle")}</h2>
            <p className="text-[11px] text-on-surface-variant mt-0.5">{t("formSub")}</p>
          </div>

          {sent ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
                <span className="material-symbols-outlined text-emerald-600" style={{ fontSize: 24 }}>check_circle</span>
              </div>
              <p className="text-sm font-semibold text-on-background">{t("successTitle")}</p>
              <p className="text-xs text-on-surface-variant">{t("successSub")}</p>
              <button
                onClick={() => setSent(false)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                {lang === "ar" ? "إرسال رسالة أخرى" : "Send another message"}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-on-surface-variant mb-1.5">
                  {t("labelSubj")}
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t("phSubj")}
                  maxLength={200}
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-xs text-on-background placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-on-surface-variant mb-1.5">
                  {t("labelMsg")}
                </label>
                <textarea
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t("phMsg")}
                  maxLength={5000}
                  className="w-full bg-surface-container-low border border-outline-variant/20 rounded-xl px-4 py-2.5 text-xs text-on-background placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all resize-none"
                />
                <p className="text-[10px] text-on-surface-variant/40 mt-1 text-end">
                  {message.length}/5000
                </p>
              </div>

              {error && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5">
                  <span className="material-symbols-outlined text-red-500 shrink-0" style={{ fontSize: 14 }}>error</span>
                  <p className="text-[11px] text-red-700">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={sending}
                className="w-full bg-gradient-to-r from-primary to-primary-dim text-white text-xs font-semibold py-2.5 rounded-xl hover:shadow-md hover:shadow-primary/20 transition-all active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {sending ? t("btnSending") : t("btnSend")}
              </button>
            </form>
          )}
        </div>

        {/* WhatsApp fallback */}
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#22c55e">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-emerald-800">
              {lang === "ar" ? "تفضّل التواصل المباشر؟" : "Prefer direct contact?"}
            </p>
            <p className="text-[11px] text-emerald-700 mt-0.5">
              {lang === "ar" ? "تواصل معنا عبر واتساب للرد الفوري." : "Reach us on WhatsApp for instant replies."}
            </p>
          </div>
          <a
            href={waUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold px-3.5 py-2 rounded-xl transition-colors no-underline"
          >
            {lang === "ar" ? "واتساب" : "WhatsApp"}
          </a>
        </div>

      </div>
    </>
  );
}
