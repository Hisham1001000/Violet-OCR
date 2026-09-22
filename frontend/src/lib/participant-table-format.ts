// Pure helpers behind ParticipantTable: canvas text measurement, digit
// normalisation, Arabic column classification and the name-suggestion map.
// They were module-private inside the component, so nothing outside that file
// could reference them and moving them cannot change a caller's behaviour.
//
// They live apart from the component because they are the parts with rules in
// them -- which Arabic column holds a phone number, which holds a person's
// name, which offers a fixed pair of answers -- and those rules mirror
// execution/process_document.py. Eight hundred lines of editing UI on top of
// them hid that; the fixed-choice patterns below have drifted once already.

// ── Canvas text measurement ────────────────────────────────────────────────
let _measureCanvas: HTMLCanvasElement | null = null;
export function measurePx(text: string): number {
  if (typeof document === "undefined") return text.length * 7;
  try {
    if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
    const ctx = _measureCanvas.getContext("2d");
    if (!ctx) return text.length * 7;
    ctx.font = "13px Alexandria, system-ui, sans-serif";
    return ctx.measureText(text).width;
  } catch { return text.length * 7; }
}

// ── Minimum column width so a header fits in ≤ maxLines lines ─────────────
// Uses greedy word-wrap — the same algorithm browsers use.
export function minWidthForNLines(header: string, maxLines: number): number {
  const words = header.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const widths = words.map((w) => measurePx(w) + 4); // +4 inter-word gap
  const maxWord = Math.max(...widths);
  const total   = widths.reduce((s, w) => s + w, 0);
  if (words.length <= maxLines) return maxWord; // one word per line is fine
  // Binary search: smallest width where greedy wrap stays ≤ maxLines
  let lo = maxWord, hi = total;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    let lines = 1, lineW = 0;
    for (const w of widths) {
      if (lineW + w > mid && lineW > 0) { lines++; lineW = w; }
      else lineW += w;
    }
    if (lines <= maxLines) hi = mid; else lo = mid;
  }
  return hi + 12; // +12 for cell padding
}

// Mirrors _PHONE_COLS / _ID_COLS in execution/process_document.py.
const PHONE_OR_ID_COL = /\u0647\u0648\u064A\u0629|\u0647\u0648\u064A\u0647|\u0628\u0637\u0627\u0642\u0629|\u0627\u0644\u0648\u0637\u0646\u064A|identity|passport|\u062C\u0648\u0627\u0632|\u0631\u0642\u0645|\u0647\u0627\u062A\u0641|\u062C\u0648\u0627\u0644|\u0645\u0648\u0628\u0627\u064A\u0644|phone|tel/i;

export function normalizeDigits(val: unknown, col?: string): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== "string") return val as string | null;
  if (!val) return val;
  const folded = val.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => String(ch.codePointAt(0)! & 0xF));

  // Whitespace inside a phone or ID is always an OCR artefact \u2014 no number on
  // these forms contains one. Done here as well as in the pipeline so documents
  // processed before that fix display clean without a reprocess.
  //
  // Restricted to phone/ID columns on purpose. Applied everywhere it would eat
  // the separators out of a date read as "12 03 1998" and silently turn it into
  // 12031998. A leading + and the * of a redacted card number are kept.
  if (!col || !PHONE_OR_ID_COL.test(col)) return folded;
  const tight = folded.replace(/\s+/g, "");
  return /^\+?[\d*]+$/.test(tight) ? tight : folded;
}

export function normalizeParticipants(ps: Array<Record<string, unknown>>) {
  return ps.map((p) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, normalizeDigits(v, k)]))
  ) as Array<Record<string, string | null>>;
}

export function applyNameFirst(cols: string[]): string[] {
  const nameCol = cols.find((c) => /اسم/.test(c));
  if (!nameCol || cols[0] === nameCol) return cols;
  return [nameCol, ...cols.filter((c) => c !== nameCol)];
}

export function isRowNumberCol(col: string, ps: Array<Record<string, string | null>>): boolean {
  if (/^[#٠-٩\u0660-\u06690-9\s]+$/.test(col.trim())) return true;
  const vals = ps.map((p) => p[col]).filter((v): v is string => v != null && v !== "");
  if (vals.length < 2) return false;
  const nums = vals.map((v) => parseInt(v.trim(), 10));
  return nums.every((n) => !isNaN(n) && n >= 1 && n <= 999) &&
    nums.every((n, i) => i === 0 || n > nums[i - 1]);
}

// Auto-fill is blocked ONLY for these three field types:
//   1. Personal Full Name  → "اسم" that refers to a PERSON, not an entity/org/place/event
//   2. Date of Birth only  → "تاريخ" + birth word. Other dates (course/session/start) CAN be auto-filled.
//   3. Phone number        → explicit phone words, or "رقم" paired with a contact word
//
// Key insight: many Arabic forms have columns like "اسم الجهة" (org name), "اسم الدورة" (course name),
// "تاريخ الدورة" (course date) — these share the same value for all participants and SHOULD be auto-fillable.
// Blocking them causes auto-fill to vanish entirely on those files.
export function isPrimaryField(col: string): boolean {
  // ── Phone number ───────────────────────────────────────────────────────────
  if (/هاتف|تليفون|جوال|موبايل/.test(col)) return true;
  if (/رقم/.test(col) && /تواصل|هاتف|تليفون|جوال|موبايل|اتصال/.test(col)) return true;

  // ── Date of Birth only ────────────────────────────────────────────────────
  // Other dates (تاريخ الدورة، تاريخ البدء، تاريخ الانتهاء) are often identical
  // across all rows, so they should remain auto-fillable.
  if (/تاريخ/.test(col) && /ميلاد|ولادة/.test(col)) return true;

  // ── Personal full name ────────────────────────────────────────────────────
  // Block "اسم" ONLY when it refers to a person's name.
  // Columns like "اسم الجهة", "اسم المؤسسة", "اسم الدورة" name an entity/org/event
  // that is the same for every row — they must remain auto-fillable.
  if (/اسم/.test(col)) {
    const entityQualifiers =
      /جهة|مؤسسة|شركة|مدرسة|جامعة|معهد|منطقة|محافظة|مدينة|قرية|دولة|مشروع|برنامج|حدث|دورة|مركز|قسم|وزارة|هيئة|نادي|فريق|مجموعة|نشاط|تخصص/;
    if (entityQualifiers.test(col)) return false; // entity/org/event name → allow auto-fill
    return true;                                   // personal name → block auto-fill
  }

  return false;
}

// ── Fixed-choice columns ───────────────────────────────────────────────────
// These mirror execution/process_document.py:963-1027 exactly. The pipeline
// already normalises these columns to one of two answers and blanks anything
// it cannot place, so the table only has to offer the same two back.
//
// Keeping a second copy of the patterns here is a known liability -- they have
// drifted once already, when النوع الإجتماعي arrived with a hamza the pattern
// missed and 954 cells went un-normalised. The fix is for the pipeline to send
// the choice map alongside the data; `choicesFromServer` below is where that
// will land, and until it does these patterns are the fallback.
const GENDER_COL_PAT   = /جنس|نوع.{0,8}[اأإآ]جتماع|gender|sex/i;
const APPROVAL_COL_PAT = /موافق|قبول|وافق|توافق/i;
const DATE_COL_EXCL    = /تاريخ|date/i;
const DISABILITY_COL_PAT = /[اأإآ]عاق|disab/i;

export function choicesFor(col: string): string[] | null {
  if (GENDER_COL_PAT.test(col)) return ["ذكر", "أنثى"];
  // تاريخ الموافقة is a date, not a consent answer.
  if (APPROVAL_COL_PAT.test(col) && !DATE_COL_EXCL.test(col)) return ["موافق", "غير موافق"];
  if (DISABILITY_COL_PAT.test(col)) return ["نعم", "لا"];
  return null;
}

export interface NameSuggestion {
  original: string; suggested: string; confidence: number;
  source: "static" | "correction" | "family_dict" | "family_dict+gemini";
  needs_review?: boolean; candidates?: string[];
}
export type SuggestionsMap = Map<string, NameSuggestion>;

export function extractSuggestions(ps: Array<Record<string, unknown>>): SuggestionsMap {
  const map: SuggestionsMap = new Map();
  ps.forEach((p, rowIdx) => {
    const raw = p["_suggestions"];
    if (!raw || typeof raw !== "object") return;
    const sugObj = raw as Record<string, NameSuggestion>;
    for (const [field, sug] of Object.entries(sugObj)) {
      const hasDiff = sug?.suggested && sug.suggested !== p[field];
      const hasReview = sug?.needs_review && sug?.candidates && sug.candidates.length > 0;
      if (hasDiff || hasReview) map.set(`${rowIdx}:${field}`, sug);
    }
  });
  return map;
}
