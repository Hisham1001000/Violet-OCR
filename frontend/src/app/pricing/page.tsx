"use client";

import { useState } from "react";
import { useLang } from "@/lib/lang-context";
import Link from "next/link";
import { SIGNUP_GRANT_CENTS, costOfRows, formatRowPrice, formatUsd } from "@/lib/billing";

const CONTACT_WHATSAPP = "+972569523615";
const CONTACT_EMAIL    = "violetocr4@gmail.com";

// There are no tiers any more, so there is nothing to compare: one price, one
// set of features, and the only number that varies is how many rows you send.
// See lib/billing.ts for the price itself.

export default function PricingPage() {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  const [rows, setRows] = useState(20);

  const waUrl   = `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent(lang === "ar" ? "مرحباً، أريد الاشتراك في المنصة" : "Hello, I'd like to subscribe to Violet OCR")}`;
  const mailUrl = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(lang === "ar" ? "طلب اشتراك" : "Subscription request")}`;


  const FAQ = [
    {
      q: { en: "What exactly is a row?",                 ar: "ما هو الصف بالضبط؟"                          },
      a: { en: "One participant line in your table — one person, with all their columns. A sheet listing 20 people costs 30 cents no matter how many columns it has.",
           ar: "سطر مشارك واحد في جدولك — شخص واحد بكل أعمدته. كشف فيه 20 شخصاً يكلّف 30 سنتاً مهما بلغ عدد الأعمدة." },
    },
    {
      q: { en: "What if it reads the page badly?",       ar: "وماذا لو قرأ الصفحة قراءة سيئة؟"             },
      a: { en: "Every run is charged for the rows it extracts — reprocessing a document, or uploading the same sheet again, is charged like a new one. A page it could not read at all produces no rows, so it costs nothing.",
           ar: "كل معالجة تُحتسب بعدد الصفوف التي تستخرجها — إعادة معالجة مستند أو رفع الكشف نفسه مرة أخرى تُحتسب كمعالجة جديدة. والصفحة التي تعذّرت قراءتها تماماً لا تنتج صفوفاً، فلا تكلّف شيئاً." },
    },
    {
      q: { en: "Does my credit expire?",                 ar: "هل ينتهي رصيدي؟"                             },
      a: { en: "No. There is no monthly reset and nothing to lose by not using it — credit sits there until you spend it.",
           ar: "لا. لا يوجد تجديد شهري ولا شيء تخسره إن لم تستخدمه — يبقى الرصيد حتى تنفقه." },
    },
    {
      q: { en: "What happens if a sheet costs more than my balance?", ar: "ماذا يحدث إن تجاوزت تكلفة الكشف رصيدي؟" },
      a: { en: "We process it and hold the result. You will see that it is ready, what it costs, and how much you are short — add credit and it unlocks. Nothing is lost and you are not charged for what you cannot see.",
           ar: "نعالجه ونحتفظ بالنتيجة. سترى أنه جاهز، وكم يكلّف، وكم ينقصك — أضف رصيداً ليُفتح. لا يضيع شيء ولا تُحاسب على ما لا تراه." },
    },
    {
      q: { en: "How do I add credit?",                   ar: "كيف أضيف رصيداً؟"                            },
      a: { en: "Card payment is not live yet. Message us on WhatsApp or by email with the amount and we credit your account, usually within a few hours.",
           ar: "الدفع بالبطاقة غير مفعّل بعد. راسلنا على واتساب أو بالبريد بالمبلغ المطلوب ونضيفه إلى حسابك، عادةً خلال ساعات قليلة." },
    },
  ];

  return (
    <div dir={isRtl ? "rtl" : "ltr"} style={{ minHeight: "100vh", background: "#0f0d12", color: "#e2e8f0" }}>

      {/* ── Nav ──────────────────────────────────────────────────────── */}
      <nav style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 32px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(15,13,18,0.88)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}>
        <Link href="/dashboard" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <img src="/logo.png" alt="Violet" style={{ width: 26, height: 26, objectFit: "contain" }} />
          <span style={{
            fontSize: 15, fontWeight: 800, letterSpacing: "0.16em",
            background: "linear-gradient(135deg,#e879f9,#a855f7,#7c3aed)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>VIOLET</span>
        </Link>
        <Link href="/billing" style={{
          fontSize: 12, fontWeight: 600, color: "#a78bfa",
          padding: "8px 18px",
          border: "1px solid rgba(167,139,250,0.3)",
          borderRadius: 20, textDecoration: "none",
        }}>
          {lang === "ar" ? "← لوحة التحكم" : "Dashboard →"}
        </Link>
      </nav>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section style={{ textAlign: "center", padding: "56px 24px 40px" }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.25)",
          borderRadius: 20, padding: "5px 14px", marginBottom: 22,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981" }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "#a78bfa" }}>
            {lang === "ar" ? "موثوق به من فرق العمل في المنطقة" : "Trusted by teams across the region"}
          </span>
        </div>

        <h1 style={{
          fontSize: "clamp(26px, 5vw, 44px)", fontWeight: 800, lineHeight: 1.15,
          marginBottom: 14, maxWidth: 640, marginInline: "auto",
          background: "linear-gradient(135deg, #f1f5f9 30%, #a78bfa)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          {lang === "ar"
            ? "استخرج البيانات العربية من أي مستند"
            : "Extract Arabic data from any document"}
        </h1>
        <p style={{ fontSize: 14, color: "#94a3b8", maxWidth: 440, marginInline: "auto", lineHeight: 1.65 }}>
          {lang === "ar"
            ? "ثلاثة محركات OCR. نتيجة واحدة دقيقة. ادفع فقط مقابل ما تعالجه."
            : "Three OCR engines. One accurate result. Pay only for what you process."}
        </p>
      </section>

      {/* ── Price ────────────────────────────────────────────────────── */}
      <section style={{ maxWidth: 700, marginInline: "auto", padding: "0 24px 44px" }}>
        <div style={{
          background: "linear-gradient(145deg, rgba(139,92,246,0.16), rgba(88,28,220,0.08))",
          border: "1.5px solid rgba(139,92,246,0.5)", borderRadius: 24,
          padding: "38px 32px", textAlign: "center",
          boxShadow: "0 0 40px rgba(139,92,246,0.15), 0 8px 30px rgba(0,0,0,0.3)",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 9 }} dir="ltr">
            <span style={{ fontSize: 58, fontWeight: 800, color: "#f1f5f9", lineHeight: 1 }}>
              {formatRowPrice()}
            </span>
            <span style={{ fontSize: 15, color: "#a78bfa", fontWeight: 600 }}>
              {lang === "ar" ? "/ صف" : "/ row"}
            </span>
          </div>

          <p style={{ fontSize: 13.5, color: "#94a3b8", marginTop: 14, lineHeight: 1.7, maxWidth: 420, marginInline: "auto" }}>
            {lang === "ar"
              ? "لا اشتراك ولا حصة شهرية. تدفع عن كل صف يستخرجه النظام من كشوفك — لا أكثر."
              : "No subscription, no monthly quota. You pay for each row the system extracts from your sheets — nothing else."}
          </p>

          {/* ── Calculator ─────────────────────────────────────────── */}
          <div style={{
            marginTop: 30, padding: "22px 24px", borderRadius: 16,
            background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.07)",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                {lang === "ar" ? "كشف فيه" : "A sheet with"}{" "}
                <strong style={{ color: "#e2e8f0", fontSize: 15 }}>{rows}</strong>{" "}
                {lang === "ar" ? "صفاً" : rows === 1 ? "row" : "rows"}
              </span>
              <span dir="ltr" style={{ fontSize: 24, fontWeight: 800, color: "#c4b5fd" }}>
                {formatUsd(costOfRows(rows))}
              </span>
            </div>
            <input
              type="range" min={1} max={200} value={rows}
              onChange={(e) => setRows(parseInt(e.target.value, 10))}
              aria-label={lang === "ar" ? "عدد الصفوف" : "Number of rows"}
              style={{ width: "100%", accentColor: "#8b5cf6", cursor: "pointer" }}
            />
            <div dir="ltr" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#64748b", marginTop: 6 }}>
              <span>1</span><span>200</span>
            </div>
          </div>

          <p style={{ fontSize: 12, color: "#a78bfa", marginTop: 22 }}>
            {lang === "ar"
              ? `كل حساب جديد يبدأ بـ ${formatUsd(SIGNUP_GRANT_CENTS)} رصيداً مجانياً`
              : `Every new account starts with ${formatUsd(SIGNUP_GRANT_CENTS)} of free credit`}
          </p>
        </div>

        {/* ── What you get ─────────────────────────────────────────── */}
        <div style={{
          marginTop: 20, borderRadius: 20, padding: "26px 28px",
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
        }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: "#c4b5fd", marginBottom: 16, letterSpacing: "0.05em" }}>
            {lang === "ar" ? "مشمول للجميع" : "INCLUDED FOR EVERYONE"}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 11 }}>
            {(lang === "ar"
              ? ["استخراج OCR كامل بثلاثة محركات",
                 "تصدير Excel",
                 "محرر التصحيح اليدوي",
                 "ذاكرة التصحيحات — يتعلم من بياناتك",
                 "مستندات متعددة الصفحات، بلا حد",
                 "سجل غير محدود",
                 "لا يُحتسب شيء على صفحة تعذّرت قراءتها"]
              : ["Full three-engine OCR extraction",
                 "Excel export",
                 "Manual correction editor",
                 "Correction memory — it learns your data",
                 "Multi-page documents, no cap",
                 "Unlimited history",
                 "Nothing charged for a page it could not read"]
            ).map((f, i) => (
              <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: "#cbd5e1" }}>
                <span style={{ color: "#a78bfa", fontWeight: 800, fontSize: 11, lineHeight: 1.6 }}>✓</span>
                <span style={{ lineHeight: 1.6 }}>{f}</span>
              </li>
            ))}
          </ul>
        </div>

      </section>

      {/* ── CTA strip ────────────────────────────────────────────────── */}
      <section style={{
        background: "linear-gradient(135deg, rgba(88,28,220,0.15), rgba(67,20,200,0.08))",
        border: "1px solid rgba(139,92,246,0.2)", borderRadius: 24,
        maxWidth: 780, marginInline: "auto", padding: "36px 40px",
        marginBottom: 64, marginLeft: 24, marginRight: 24, textAlign: "center",
      }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: "#f1f5f9", marginBottom: 10 }}>
          {lang === "ar" ? "جاهز للترقية؟" : "Ready to upgrade?"}
        </h2>
        <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 28, maxWidth: 460, marginInline: "auto" }}>
          {lang === "ar"
            ? "الدفع الإلكتروني قادم قريباً. الآن، تواصل معنا مباشرة أو انضم لقائمة الانتظار."
            : "Online payment is coming soon. For now, contact us directly or join the waitlist."}
        </p>
        <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          <a href={waUrl} target="_blank" rel="noopener noreferrer" style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "#22c55e", color: "#fff",
            padding: "12px 22px", borderRadius: 14, fontSize: 13, fontWeight: 700,
            textDecoration: "none", boxShadow: "0 4px 14px rgba(34,197,94,0.3)",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            {lang === "ar" ? "واتساب" : "WhatsApp us"}
          </a>
          <a href={mailUrl} style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "rgba(255,255,255,0.07)", color: "#e2e8f0",
            padding: "12px 22px", borderRadius: 14, fontSize: 13, fontWeight: 700,
            textDecoration: "none", border: "1px solid rgba(255,255,255,0.12)",
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>mail</span>
            {lang === "ar" ? "راسلنا" : "Email us"}
          </a>
          <Link href="/billing" style={{
            display: "flex", alignItems: "center", gap: 5,
            color: "#a78bfa", fontSize: 12, fontWeight: 600,
            textDecoration: "none", padding: "12px 14px",
          }}>
            {lang === "ar" ? "انضم لقائمة الانتظار ←" : "Join the waitlist →"}
          </Link>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────── */}
      <section style={{ maxWidth: 640, marginInline: "auto", padding: "0 24px 80px" }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, textAlign: "center", marginBottom: 24, color: "#f1f5f9" }}>
          {lang === "ar" ? "الأسئلة الشائعة" : "Frequently asked questions"}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FAQ.map((item, i) => (
            <div key={i} style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 14, overflow: "hidden",
            }}>
              <button
                onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "15px 18px", background: "none", border: "none", cursor: "pointer",
                  color: "#e2e8f0", fontSize: 13, fontWeight: 600,
                  textAlign: isRtl ? "right" : "left", gap: 12,
                }}
              >
                {item.q[lang as "en" | "ar"]}
                <span className="material-symbols-outlined" style={{
                  fontSize: 16, color: "#64748b", flexShrink: 0,
                  transition: "transform 0.2s",
                  transform: faqOpen === i ? "rotate(180deg)" : "rotate(0deg)",
                  display: "inline-block",
                }}>expand_more</span>
              </button>
              <div style={{ maxHeight: faqOpen === i ? 200 : 0, overflow: "hidden", transition: "max-height 0.25s ease" }}>
                <p style={{ padding: "0 18px 16px", fontSize: 12, color: "#94a3b8", lineHeight: 1.7, margin: 0 }}>
                  {item.a[lang as "en" | "ar"]}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "20px 24px", textAlign: "center", fontSize: 11, color: "#475569" }}>
        © 2025 Violet OCR · {lang === "ar" ? "جميع الحقوق محفوظة" : "All rights reserved"}
      </footer>
    </div>
  );
}
