"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { TopUpModal } from "@/components/TopUpModal";
import { useLang } from "@/lib/lang-context";
import { formatRowPrice, formatUsd } from "@/lib/billing";

interface Txn {
  id: string;
  kind: "grant" | "topup" | "charge" | "refund" | "adjust";
  amount_cents: number;
  rows: number | null;
  job_id: string | null;
  balance_after: number;
  note: string | null;
  created_at: string;
}

interface HeldJob {
  id: string;
  document_name: string;
  row_count: number | null;
  cost_cents: number | null;
}

interface BillingData {
  balance_cents: number;
  rows_used_total: number;
  rows_affordable: number;
  transactions: Txn[];
  held: HeldJob[];
}

const copy = {
  title:        { en: "Balance",                 ar: "الرصيد" },
  subtitle:     { en: "You pay for what is extracted — 1.5 cents per row.",
                  ar: "تدفع مقابل ما يُستخرج فعلياً — سنت ونصف لكل صف." },
  yourBalance:  { en: "Your balance",            ar: "رصيدك" },
  rowsLeft:     { en: "rows remaining",          ar: "صف متبقٍ" },
  perRow:       { en: "per row",                 ar: "لكل صف" },
  addFunds:     { en: "Add credit",              ar: "إضافة رصيد" },
  empty:        { en: "Your balance is empty. Add credit to process documents.",
                  ar: "رصيدك فارغ. أضف رصيداً لمعالجة المستندات." },
  low:          { en: "Your balance is running low.", ar: "رصيدك على وشك النفاد." },
  heldTitle:    { en: "Waiting for credit",      ar: "بانتظار الرصيد" },
  heldDesc:     { en: "These documents finished processing but cost more than your balance. Add credit and open them to unlock.",
                  ar: "هذه المستندات اكتملت معالجتها لكن تكلفتها تجاوزت رصيدك. أضف رصيداً ثم افتحها لفكّ القفل." },
  rows:         { en: "rows",                    ar: "صف" },
  open:         { en: "Open",                    ar: "فتح" },
  statement:    { en: "Statement",               ar: "كشف الحساب" },
  noTxns:       { en: "Nothing yet.",            ar: "لا توجد حركات بعد." },
  balanceAfter: { en: "Balance",                 ar: "الرصيد" },
  loading:      { en: "Loading…",                ar: "جارٍ التحميل…" },
  howTo:        { en: "How pricing works",       ar: "كيف تعمل التسعيرة" },
  howToBody:    { en: "Upload a sheet, and you are charged 1.5 cents for every row the system extracts. A 20-row page costs $0.30. Nothing is charged for a page it could not read. Every run is charged, including reprocessing a document or uploading the same sheet again.",
                  ar: "ارفع كشفاً، ويُحتسب عليك سنت ونصف عن كل صف يستخرجه النظام. صفحة بها ٢٠ صفاً تكلّف ٠٫٣٠ دولار. لا يُحتسب شيء على صفحة لم يستطع قراءتها. وكل معالجة تُحتسب، بما في ذلك إعادة معالجة مستند أو رفع الكشف نفسه مرة أخرى." },
};

const KIND_LABEL: Record<Txn["kind"], { en: string; ar: string }> = {
  grant:  { en: "Welcome credit", ar: "رصيد ترحيبي" },
  topup:  { en: "Top-up",         ar: "إضافة رصيد" },
  charge: { en: "Extraction",     ar: "استخراج" },
  refund: { en: "Refund",         ar: "استرداد" },
  adjust: { en: "Adjustment",     ar: "تسوية" },
};

export default function BillingPage() {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const t = (k: keyof typeof copy) => copy[k][lang];

  const [data, setData]       = useState<BillingData | null>(null);
  const [topUpOpen, setTopUp] = useState(false);
  const [email, setEmail]     = useState<string | undefined>();

  const load = useCallback(() => {
    fetch("/api/billing", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!d.error) setData(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setEmail(d?.user?.email))
      .catch(() => {});
  }, [load]);

  const balance = data?.balance_cents ?? 0;
  const isEmpty = balance <= 0;
  const isLow   = balance > 0 && balance < 25;

  return (
    <>
      <div dir={isRtl ? "rtl" : "ltr"} className="max-w-4xl mx-auto space-y-6">

        <div className="space-y-1">
          <h1 className="text-2xl font-light tracking-tight text-on-background">{t("title")}</h1>
          <p className="text-sm text-on-surface-variant">{t("subtitle")}</p>
        </div>

        {/* ── Balance card ─────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white p-6 editorial-shadow border border-outline-variant/30">
          <div>
            <div>
              <p className="text-xs text-on-surface-variant mb-1">{t("yourBalance")}</p>
              <p className={`text-4xl font-light tracking-tight ${isEmpty ? "text-error" : "text-on-background"}`}>
                {formatUsd(balance)}
              </p>
              <p className="text-xs text-on-surface-variant mt-1.5">
                {data
                  ? `${data.rows_affordable.toLocaleString()} ${t("rowsLeft")} · ${formatRowPrice()} ${t("perRow")}`
                  : t("loading")}
              </p>
            </div>

          </div>

          {(isEmpty || isLow) && (
            <p className={`mt-5 text-xs rounded-lg px-3.5 py-2.5 ${
              isEmpty
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-800 border border-amber-200"
            }`}>
              {isEmpty ? t("empty") : t("low")}
            </p>
          )}

          <button
            onClick={() => setTopUp(true)}
            className="mt-5 rounded-full px-6 py-2.5 text-sm font-semibold text-white
                       bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] shadow-md shadow-primary/25
                       hover:opacity-95 transition-opacity"
          >
            {t("addFunds")}
          </button>
        </div>

        {/* ── Documents held for credit ─────────────────────────────────── */}
        {data && data.held.length > 0 && (
          <div className="rounded-2xl bg-amber-50/60 border border-amber-200 p-5">
            <h2 className="text-sm font-semibold text-amber-900 mb-1">{t("heldTitle")}</h2>
            <p className="text-xs text-amber-800/90 mb-4 leading-relaxed">{t("heldDesc")}</p>
            <ul className="space-y-2">
              {data.held.map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-3 bg-white rounded-lg px-3.5 py-2.5 border border-amber-200/70">
                  <div className="min-w-0">
                    <p className="text-[13px] text-on-background truncate">{j.document_name}</p>
                    <p className="text-[11px] text-on-surface-variant">
                      {j.row_count ?? 0} {t("rows")} · {formatUsd(j.cost_cents ?? 0)}
                    </p>
                  </div>
                  <Link
                    href={`/documents/${j.id}`}
                    className="shrink-0 text-xs font-semibold text-primary hover:underline"
                  >
                    {t("open")}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── How it works ─────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-surface-container-low p-5">
          <h2 className="text-sm font-semibold text-on-background mb-2">{t("howTo")}</h2>
          <p className="text-xs text-on-surface-variant leading-relaxed">{t("howToBody")}</p>
        </div>

        {/* ── Statement ────────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white border border-outline-variant/30 overflow-hidden">
          <h2 className="text-sm font-semibold text-on-background px-5 pt-5 pb-3">{t("statement")}</h2>
          {!data ? (
            <p className="px-5 pb-5 text-xs text-on-surface-variant">{t("loading")}</p>
          ) : data.transactions.length === 0 ? (
            <p className="px-5 pb-5 text-xs text-on-surface-variant">{t("noTxns")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <tbody>
                  {data.transactions.map((tx) => {
                    const credit = tx.amount_cents > 0;
                    return (
                      <tr key={tx.id} className="border-t border-outline-variant/20">
                        <td className="px-5 py-3 text-on-background whitespace-nowrap">
                          {KIND_LABEL[tx.kind]?.[lang] ?? tx.kind}
                          {tx.rows != null && (
                            <span className="text-on-surface-variant"> · {tx.rows} {t("rows")}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-on-surface-variant text-[11px] whitespace-nowrap">
                          {new Date(tx.created_at).toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
                            day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                          })}
                        </td>
                        <td dir="ltr" className={`px-3 py-3 font-medium whitespace-nowrap ${isRtl ? "text-left" : "text-right"} ${credit ? "text-emerald-600" : "text-on-background"}`}>
                          {credit ? "+" : "−"}{formatUsd(Math.abs(tx.amount_cents))}
                        </td>
                        <td dir="ltr" className={`px-5 py-3 text-on-surface-variant text-[11px] whitespace-nowrap ${isRtl ? "text-left" : "text-right"}`}>
                          {formatUsd(tx.balance_after)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <TopUpModal
        open={topUpOpen}
        onClose={() => { setTopUp(false); load(); }}
        balanceCents={balance}
        userEmail={email}
      />
    </>
  );
}
