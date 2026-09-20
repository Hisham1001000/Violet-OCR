"use client";

import { useState } from "react";
import { useLang } from "@/lib/lang-context";
import { TopUpModal } from "@/components/TopUpModal";
import { formatUsd } from "@/lib/billing";
import { notifyBalanceChanged } from "@/lib/balance-events";

// Shown when a document finished processing but cost more than the balance.
//
// The tone matters here. The work IS done and it IS theirs — they are not being
// told no, they are being told "one more step". So: what it is, what it costs,
// exactly how short they are, and a button that re-checks the moment they have
// paid, rather than making them guess when to refresh.
interface LockedDocumentProps {
  jobId: string;
  documentName: string;
  rowCount: number | null;
  costCents: number | null;
  balanceCents: number;
  shortfallCents: number;
  userEmail?: string;
  onUnlocked: () => void;
}

const copy = {
  ready:      { en: "Your file is ready",              ar: "ملفك جاهز" },
  body:       { en: "We finished reading this document, but it costs more than your current balance. Add credit and it unlocks — nothing is lost.",
                ar: "انتهينا من قراءة هذا المستند، لكن تكلفته تتجاوز رصيدك الحالي. أضف رصيداً ليُفتح — لم يضع شيء." },
  rowsFound:  { en: "Rows extracted",                  ar: "الصفوف المستخرجة" },
  cost:       { en: "Cost",                            ar: "التكلفة" },
  balance:    { en: "Your balance",                    ar: "رصيدك" },
  short:      { en: "Short by",                        ar: "المتبقي" },
  addCredit:  { en: "Add credit",                      ar: "إضافة رصيد" },
  checkAgain: { en: "I've paid — check again",         ar: "لقد دفعت — تحقّق مرة أخرى" },
  checking:   { en: "Checking…",                       ar: "جارٍ التحقق…" },
  stillShort: { en: "Still not enough credit. If you have just paid, give it a moment and try again.",
                ar: "الرصيد ما زال غير كافٍ. إن كنت قد دفعت للتو، أمهله لحظة ثم حاول مجدداً." },
  failed:     { en: "Couldn't check right now. Try again.",
                ar: "تعذّر التحقق الآن. حاول مرة أخرى." },
  noCharge:   { en: "You have not been charged for this document.",
                ar: "لم يُخصم من رصيدك شيء مقابل هذا المستند." },
};

export function LockedDocument({
  jobId, documentName, rowCount, costCents, balanceCents, shortfallCents,
  userEmail, onUnlocked,
}: LockedDocumentProps) {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof copy) => copy[k][lang];

  const [topUpOpen, setTopUpOpen] = useState(false);
  const [checking, setChecking]   = useState(false);
  const [note, setNote]           = useState<string | null>(null);

  async function checkAgain() {
    setChecking(true);
    setNote(null);
    try {
      const res  = await fetch(`/api/documents/${jobId}/settle`, { method: "POST" });
      const data = await res.json();
      if (data.paid) { notifyBalanceChanged(); onUnlocked(); return; }
      notifyBalanceChanged();
      setNote(t("stillShort"));
    } catch {
      setNote(t("failed"));
    } finally {
      setChecking(false);
    }
  }

  const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-amber-200/50 last:border-0">
      <span className="text-xs text-amber-900/80">{label}</span>
      <span dir="ltr" className={`text-[13px] tabular-nums ${strong ? "font-bold text-amber-900" : "text-amber-900/90"}`}>
        {value}
      </span>
    </div>
  );

  return (
    <section dir={isRtl ? "rtl" : "ltr"} className="rounded-2xl bg-amber-50 border border-amber-200 p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 shrink-0 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center">
          <span className="material-symbols-outlined text-amber-700" style={{ fontSize: 20 }}>lock</span>
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-amber-950">{t("ready")}</h2>
          <p className="text-[13px] text-amber-900/85 mt-1.5 leading-relaxed max-w-lg">{t("body")}</p>
          <p className="text-xs text-amber-800/70 mt-2 truncate">{documentName}</p>
        </div>
      </div>

      <div className="mt-6 rounded-xl bg-white/70 border border-amber-200 px-4 sm:px-5 py-1 max-w-md">
        <Row label={t("rowsFound")} value={String(rowCount ?? 0)} />
        <Row label={t("cost")}      value={formatUsd(costCents ?? 0)} />
        <Row label={t("balance")}   value={formatUsd(balanceCents)} />
        <Row label={t("short")}     value={formatUsd(shortfallCents)} strong />
      </div>

      <p className="text-[11px] text-amber-800/70 mt-3">{t("noCharge")}</p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setTopUpOpen(true)}
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white
                     bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] shadow-md shadow-primary/25
                     hover:opacity-95 transition-opacity"
        >
          {t("addCredit")}
        </button>
        <button
          onClick={checkAgain}
          disabled={checking}
          className="rounded-full px-5 py-2.5 text-sm font-semibold border border-amber-400
                     text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-50"
        >
          {checking ? t("checking") : t("checkAgain")}
        </button>
      </div>

      {note && <p className="text-xs text-amber-900 mt-3">{note}</p>}

      <TopUpModal
        open={topUpOpen}
        // Closing the top-up sheet is the most likely moment for the balance to
        // have changed, so re-check rather than making them press the button.
        onClose={() => { setTopUpOpen(false); void checkAgain(); }}
        balanceCents={balanceCents}
        userEmail={userEmail}
      />
    </section>
  );
}
