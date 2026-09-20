"use client";

import { useState, useEffect } from "react";
import { useLang } from "@/lib/lang-context";
import { formatUsd, rowsAffordable } from "@/lib/billing";

// Self-service card payment is not live yet — there is no provider wired up.
// Rather than pretend, this collects the request and hands over the two
// channels that actually work today.
const CONTACT_EMAIL    = "violetocr4@gmail.com";
const CONTACT_WHATSAPP = "972569523615";

interface TopUpModalProps {
  open: boolean;
  onClose: () => void;
  balanceCents: number;
  userEmail?: string;
}

const copy = {
  title:      { en: "Add credit",           ar: "إضافة رصيد" },
  subtitle:   { en: "Credit never expires and is spent at 1.5 cents per extracted row.",
                ar: "الرصيد لا ينتهي، ويُخصم منه سنت ونصف عن كل صف مستخرج." },
  current:    { en: "Current balance",      ar: "رصيدك الحالي" },
  amount:     { en: "How much would you like to add?", ar: "كم تريد أن تضيف؟" },
  rows:       { en: "rows",                 ar: "صف" },
  notLive:    { en: "Card payment is not live yet.", ar: "الدفع بالبطاقة غير مفعّل بعد." },
  notLiveBody:{ en: "Send us the amount you want and we will credit your account, usually within a few hours.",
                ar: "أرسل لنا المبلغ الذي تريده وسنضيفه إلى حسابك، عادةً خلال ساعات قليلة." },
  whatsapp:   { en: "WhatsApp",             ar: "واتساب" },
  or:         { en: "or",                   ar: "أو" },
  emailUs:    { en: "Email us at",          ar: "راسلنا على" },
  close:      { en: "Close",                ar: "إغلاق" },
  waMessage:  { en: "Hello, I'd like to add credit to my Violet account",
                ar: "مرحباً، أريد إضافة رصيد إلى حسابي في Violet" },
};

export function TopUpModal({ open, onClose, balanceCents, userEmail }: TopUpModalProps) {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof copy) => copy[k][lang];

  const [amount, setAmount] = useState("");

  useEffect(() => { if (open) setAmount(""); }, [open]);

  // Dollars in, integer cents out. Rounded here so 10.005 cannot become a
  // fraction of a cent anywhere downstream.
  const dollars = Number(amount);
  const cents   = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
  const rows    = rowsAffordable(cents);

  // Escape closes, like every other dismissible surface in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const amountText = cents > 0 ? ` — ${formatUsd(cents)}` : "";
  const message = `${copy.waMessage[lang]}${amountText}${userEmail ? ` (${userEmail})` : ""}`;
  const waUrl   = `https://wa.me/${CONTACT_WHATSAPP}?text=${encodeURIComponent(message)}`;
  const mailUrl = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Violet — add credit${amountText}`)}&body=${encodeURIComponent(message)}`;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, background: "rgba(0,0,0,0.60)",
      }}
    >
      <div
        dir={isRtl ? "rtl" : "ltr"}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-on-background">{t("title")}</h2>
        <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">{t("subtitle")}</p>

        <div className="mt-4 rounded-xl bg-surface-container-low px-4 py-3 flex items-baseline justify-between">
          <span className="text-xs text-on-surface-variant">{t("current")}</span>
          <span dir="ltr" className="text-lg font-light text-on-background">{formatUsd(balanceCents)}</span>
        </div>

        <p className="text-xs font-medium text-on-background mt-5 mb-2">{t("amount")}</p>
        <div className="relative">
          <span dir="ltr" className="absolute inset-y-0 start-0 flex items-center ps-3.5 text-on-surface-variant text-base pointer-events-none">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10.00"
            dir="ltr"
            autoFocus
            className="w-full rounded-xl border border-outline-variant/50 ps-8 pe-3.5 py-3 text-base
                       text-on-background outline-none focus:border-primary transition-colors"
          />
        </div>
        <p className="text-[11px] text-on-surface-variant mt-2 h-4">
          {rows > 0
            ? (lang === "ar"
                ? `≈ ${rows.toLocaleString()} صف`
                : `≈ ${rows.toLocaleString()} rows`)
            : ""}
        </p>

        <div className="mt-5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-xs font-semibold text-amber-900">{t("notLive")}</p>
          <p className="text-[11px] text-amber-800/90 mt-1 leading-relaxed">{t("notLiveBody")}</p>
        </div>

        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 block text-center rounded-full px-6 py-2.5 text-sm font-semibold text-white
                     bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] shadow-md shadow-primary/25
                     hover:opacity-95 transition-opacity"
        >
          {t("whatsapp")}{cents > 0 ? ` · ${formatUsd(cents)}` : ""}
        </a>

        <p className="text-[11px] text-on-surface-variant text-center mt-3">
          {t("emailUs")}{" "}
          <a href={mailUrl} className="text-primary hover:underline">{CONTACT_EMAIL}</a>
        </p>

        <button
          onClick={onClose}
          className="mt-4 w-full text-xs text-on-surface-variant hover:text-on-background py-2"
        >
          {t("close")}
        </button>
      </div>
    </div>
  );
}
