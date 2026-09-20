"use client";

import { useState, useEffect, useRef } from "react";
import { useLang } from "@/lib/lang-context";

// How long the result has to have been on screen before we ask. The point is to
// rate a table the person has actually looked at, so this counts VISIBLE
// seconds: a tab left open in the background is not review time, and asking
// someone what they thought of a document they have not read yet gets an
// answer about the progress bar.
const ASK_AFTER_VISIBLE_MS = 60_000;
const TICK_MS = 1_000;

const seenKey = (jobId: string) => `violet_feedback_${jobId}`;

interface FeedbackPromptProps {
  jobId: string;
  /** Only start counting once the extraction is actually on screen. */
  ready: boolean;
}

const copy = {
  title:       { en: "How did that go?",         ar: "كيف كانت التجربة؟" },
  subtitle:    { en: "A quick rating helps us fix what matters.",
                 ar: "تقييم سريع يساعدنا نصلح ما يهم فعلاً." },
  placeholder: { en: "What worked, what didn't? (optional)",
                 ar: "ما الذي أعجبك، وما الذي أخطأ؟ (اختياري)" },
  send:        { en: "Send",                     ar: "إرسال" },
  sending:     { en: "Sending…",                 ar: "جارٍ الإرسال…" },
  later:       { en: "Not now",                  ar: "ليس الآن" },
  thanks:      { en: "Thank you — this goes straight to the team.",
                 ar: "شكراً لك — يصل هذا إلى الفريق مباشرة." },
  failed:      { en: "Couldn't send. Try again?", ar: "تعذر الإرسال. تحاول مرة أخرى؟" },
  dismiss:     { en: "Dismiss",                  ar: "إغلاق" },
};

const RATING_LABEL = [
  { en: "Bad",       ar: "سيئة"     },
  { en: "Poor",      ar: "ضعيفة"    },
  { en: "OK",        ar: "مقبولة"   },
  { en: "Good",      ar: "جيدة"     },
  { en: "Excellent", ar: "ممتازة"   },
];

export function FeedbackPrompt({ jobId, ready }: FeedbackPromptProps) {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof copy) => copy[k][lang];

  const [visible, setVisible]   = useState(false);
  const [rating, setRating]     = useState(0);
  const [hover, setHover]       = useState(0);
  const [comment, setComment]   = useState("");
  const [sending, setSending]   = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState(false);
  const elapsedRef = useRef(0);

  useEffect(() => {
    if (!ready || !jobId) return;
    // Already rated or dismissed this document.
    try {
      if (localStorage.getItem(seenKey(jobId))) return;
    } catch { /* private mode — just ask */ }

    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      elapsedRef.current += TICK_MS;
      if (elapsedRef.current >= ASK_AFTER_VISIBLE_MS) {
        clearInterval(id);
        setVisible(true);
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [ready, jobId]);

  function remember() {
    try { localStorage.setItem(seenKey(jobId), "1"); } catch { /* ignore */ }
  }

  function dismiss() {
    remember();
    setVisible(false);
  }

  async function submit() {
    if (rating < 1 || sending) return;
    setSending(true);
    setError(false);
    try {
      const res = await fetch("/api/feedback", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ job_id: jobId, rating, comment: comment.trim() }),
      });
      if (!res.ok) throw new Error("failed");
      remember();
      setSent(true);
      setTimeout(() => setVisible(false), 2600);
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }

  if (!visible) return null;

  const shown = hover || rating;

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      // Bottom corner, never a modal: the person may still be correcting cells,
      // and a dialog over the table would be exactly the interruption this is
      // meant to avoid.
      style={{
        position: "fixed", bottom: 20, zIndex: 60,
        insetInlineEnd: 20, width: "min(340px, calc(100vw - 40px))",
        background: "#fff", borderRadius: 16,
        border: "1px solid #e2e8f0",
        boxShadow: "0 12px 32px rgba(15,13,18,0.16)",
        padding: 18,
        animation: "fb-in 0.28s cubic-bezier(0.16,1,0.3,1) both",
      }}
    >
      <style>{`
        @keyframes fb-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {sent ? (
        <p style={{ fontSize: 13, color: "#166534", margin: 0, lineHeight: 1.6 }}>
          {t("thanks")}
        </p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: "#35313a", margin: 0 }}>{t("title")}</p>
              <p style={{ fontSize: 11.5, color: "#625d67", margin: "3px 0 0", lineHeight: 1.55 }}>
                {t("subtitle")}
              </p>
            </div>
            <button
              onClick={dismiss}
              aria-label={t("dismiss")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 14, lineHeight: 1, padding: 2 }}
            >✕</button>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 14 }}
            onMouseLeave={() => setHover(0)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setRating(n)}
                onMouseEnter={() => setHover(n)}
                aria-label={`${n} / 5`}
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: "2px 1px",
                  fontSize: 24, lineHeight: 1,
                  color: n <= shown ? "#f59e0b" : "#e2e8f0",
                  transition: "color .12s",
                }}
              >★</button>
            ))}
            {shown > 0 && (
              <span style={{ fontSize: 11.5, color: "#625d67", marginInlineStart: 8 }}>
                {RATING_LABEL[shown - 1][lang]}
              </span>
            )}
          </div>

          {rating > 0 && (
            <>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t("placeholder")}
                dir={isRtl ? "rtl" : "ltr"}
                rows={3}
                maxLength={2000}
                style={{
                  width: "100%", boxSizing: "border-box", marginTop: 12,
                  fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.6,
                  padding: "8px 10px", borderRadius: 8, resize: "vertical",
                  border: "1px solid #e2e8f0", outline: "none", color: "#35313a",
                }}
              />

              {error && (
                <p style={{ fontSize: 11.5, color: "#dc2626", margin: "8px 0 0" }}>{t("failed")}</p>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                <button
                  onClick={submit}
                  disabled={sending}
                  style={{
                    fontSize: 12.5, fontWeight: 600, color: "#fff",
                    padding: "7px 18px", borderRadius: 9999, border: "none",
                    cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.6 : 1,
                    background: "linear-gradient(135deg,#7c3aed,#6d28d9)",
                    boxShadow: "0 3px 10px rgba(109,40,217,0.25)",
                    fontFamily: "inherit",
                  }}
                >{sending ? t("sending") : t("send")}</button>
                <button
                  onClick={dismiss}
                  style={{ fontSize: 12, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                >{t("later")}</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
