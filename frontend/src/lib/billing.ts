// ── Pay-per-row billing ──────────────────────────────────────────────────────
// There are no subscription plans. A user holds a prepaid balance and is
// charged for what the pipeline actually extracts: 1.5 cents a row.
//
// All money is INTEGER CENTS. Never store or arithmetic a currency amount as a
// float — 0.1 + 0.2 is not 0.3 in binary floating point, and a balance that
// drifts a fraction of a cent per transaction is a bug nobody notices until it
// is thousands of rows old. Convert to a decimal string only to display.
//
// The price has a half cent in it, so it is held in TENTHS of a cent, and a
// document's cost is rounded UP to a whole cent: 15 rows = 22.5¢ → 23¢. That
// happens once per document, so it never adds more than half a cent to a bill.
// settle_job in migration 035 does the charging and must agree with this file.

/** Price of one extracted row, in tenths of a cent: 15 = 1.5¢ = $0.015. */
export const ROW_PRICE_TENTHS = 15;

/** Free credit a new account is granted — $0.50, 33 rows (mirrors the DEFAULT in migration 030). */
export const SIGNUP_GRANT_CENTS = 50;

/** Cost of a document with `rows` extracted rows, in whole cents (rounded up). */
export function costOfRows(rows: number): number {
  const n = Math.max(0, Math.trunc(rows));
  // n * 15 is a multiple of 5, so dividing by 10 lands on a whole or a .5 —
  // both exact in floating point, so the ceil cannot be thrown by rounding.
  return Math.ceil((n * ROW_PRICE_TENTHS) / 10);
}

/** 150 → "1.50". Two decimals, always. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs  = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 150 → "$1.50". */
export function formatUsd(cents: number): string {
  return `$${formatCents(cents)}`;
}

/** The row price for display: "$0.015". formatUsd would truncate it to "$0.01". */
export function formatRowPrice(): string {
  return `$${(ROW_PRICE_TENTHS / 1000).toFixed(3)}`;
}

/** How many rows a balance can still pay for. */
export function rowsAffordable(balanceCents: number): number {
  return Math.max(0, Math.floor((Math.trunc(balanceCents) * 10) / ROW_PRICE_TENTHS));
}

// There are deliberately no preset top-up tiers. "$5 = 333 rows" is just the
// price restated, and a row of fixed amounts reads like the plans this replaced.
// One price per row is the whole pricing model; people can pick their own number.

export type PaymentStatus = "pending" | "paid" | "unpaid";
