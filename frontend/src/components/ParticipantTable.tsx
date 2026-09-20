"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  measurePx, minWidthForNLines, normalizeParticipants, applyNameFirst,
  isRowNumberCol, isPrimaryField, choicesFor, extractSuggestions,
  type SuggestionsMap,
} from "@/lib/participant-table-format";

interface ParticipantTableProps {
  jobId: string;
  participants: Array<Record<string, unknown>>;
  columnOrder?: string[] | null;
  onSaved?: () => void;
  onExport?: () => void;
  exporting?: boolean;
  exported?:  boolean;
  canExport?: boolean;
}

function Caret({ color }: { color: string }) {
  return (
    <span style={{
      width: 0, height: 0, borderLeft: "3.5px solid transparent",
      borderRight: "3.5px solid transparent", borderTop: `4px solid ${color}`,
      display: "inline-block", flex: "none",
    }} />
  );
}

// ── History entry type (for Ctrl+Z undo) ──────────────────────────────────
interface HistoryEntry {
  participants: Array<Record<string, string | null>>;
  colOrderOverride: string[] | null;
  addedCols: Set<string>;
}

// An offer to fill the empty cells below the one just filled. Held with the
// anchor cell's rect because the panel is positioned `fixed` -- the table
// container computes to overflow-y:auto (overflow-x:auto forces it), so an
// absolutely-positioned panel inside a cell is clipped by it.
interface FillOffer {
  row: number; col: string; value: string; count: number; rect: DOMRect;
}

export function ParticipantTable({
  jobId, participants: initial, columnOrder, onSaved,
  onExport, exporting = false, exported = false, canExport = false,
}: ParticipantTableProps) {
  const [participants, setParticipants] = useState(() => normalizeParticipants(initial));

  // Columns the document arrived with. A column is hidden when every cell in it
  // is empty, which is right for a column the OCR never filled -- but it also
  // fired when a person emptied the cells themselves, so the column vanished
  // mid-edit. handleSave sends `columns` as column_order, so that vanishing was
  // also written back to the database. Emptying a cell is an edit, not a
  // request to drop the column.
  const originalColsRef = useRef<Set<string>>(
    new Set(normalizeParticipants(initial).flatMap((p) => Object.keys(p)))
  );
  // Tracks the last saved state — used as "original" baseline when logging corrections.
  // Updated on every successful save so subsequent edits diff against the right snapshot.
  const savedBaselineRef = useRef<Array<Record<string, string | null>>>(normalizeParticipants(initial));
  const [editingCell, setEditingCell]   = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue]       = useState("");
  const [editingHeader, setEditingHeader] = useState<string | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState("");
  const [dirty, setDirty]               = useState<Set<string>>(new Set());
  const [saving, setSaving]             = useState(false);
  const [saveMsg, setSaveMsg]           = useState<string | null>(null);
  const dragColRef                      = useRef<string | null>(null);
  const [dragOverCol, setDragOverCol]   = useState<string | null>(null);
  const [colOrderOverride, setColOrderOverride] = useState<string[] | null>(null);
  const [suggestions, setSuggestions]   = useState<SuggestionsMap>(() => extractSuggestions(initial));
  // Add column
  const [addingCol, setAddingCol]       = useState(false);
  const [newColName, setNewColName]     = useState("");
  const [addedCols, setAddedCols]       = useState<Set<string>>(new Set());
  // Fill-down: the offer under a cell just given a value, and the receipt.
  const [fillOffer, setFillOffer]       = useState<FillOffer | null>(null);
  const [fillDone, setFillDone]         = useState<{ count: number } | null>(null);
  // Rect of the cell being edited — anchors the choice list and the fill offer.
  const [cellRect, setCellRect]         = useState<DOMRect | null>(null);
  const colFillDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Column fill, opened from the header icon.
  const [fillCol, setFillCol]           = useState<string | null>(null);
  const [fillValue, setFillValue]       = useState("");
  // Undo history (stored in ref — doesn't trigger renders)
  const historyRef = useRef<HistoryEntry[]>([]);
  // Ref for the outer container — used to scope the Ctrl+Z listener
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [reviewBannerDismissed, setReviewBannerDismissed] = useState(false);

  // ── Auto-apply high-confidence suggestions on first render ───────────────
  // Suggestions with needs_review=false are applied automatically without user action.
  // Only needs_review=true suggestions (ambiguous family names) are left for human review.
  useEffect(() => {
    const toApply = Array.from(suggestions.entries()).filter(
      ([, s]) => !s.needs_review && s.suggested && s.suggested !== s.original
    );
    if (toApply.length === 0) return;
    setParticipants((prev) => prev.map((p, i) => {
      const patch: Record<string, string | null> = {};
      for (const [key, sug] of toApply) {
        const [rStr, col] = key.split(":");
        if (parseInt(rStr) === i) patch[col] = sug.suggested;
      }
      return Object.keys(patch).length > 0 ? { ...p, ...patch } : p;
    }));
    setDirty((prev) => { const next = new Set(prev); for (const [k] of toApply) next.add(k); return next; });
    setSuggestions((prev) => { const next = new Map(prev); for (const [k] of toApply) next.delete(k); return next; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Column derivation — memoized so it only recomputes when data/order changes,
  //    not on unrelated state updates (editingCell, saving, saveMsg, etc.)
  // Columns whose values are numbers. Editing one inside dir="rtl" puts the
  // caret on the wrong side, so backspace appears to eat digits from the far
  // end. Decided per COLUMN, not per keystroke, so the direction cannot flip
  // under the cursor while someone is typing.
  const numericCols = useMemo(() => {
    const NUMERIC = /^[\d٠-٩\s()+\-\/.]+$/;
    const HAS_DIGIT = /[\d٠-٩]/;
    const s = new Set<string>();
    for (const col of Object.keys(participants[0] ?? {})) {
      const vals = participants
        .map((p) => p[col])
        .filter((v): v is string => v != null && v !== "");
      if (vals.length === 0) continue;
      const numeric = vals.filter((v) => NUMERIC.test(v.trim()) && HAS_DIGIT.test(v));
      if (numeric.length >= vals.length * 0.6) s.add(col);
    }
    return s;
  }, [participants]);

  const { columns } = useMemo(() => {
    const _allCols: string[] = [];
    const _seen = new Set<string>();
    for (const p of participants) {
      for (const k of Object.keys(p)) {
        if (!_seen.has(k)) { _seen.add(k); _allCols.push(k); }
      }
    }
    const _effectiveOrder = colOrderOverride ?? columnOrder;
    const _orderedCols = _effectiveOrder && _effectiveOrder.length > 0
      ? [..._effectiveOrder.filter((c) => _seen.has(c)), ..._allCols.filter((c) => !_effectiveOrder.includes(c))]
      : applyNameFirst(_allCols);
    const cols = _orderedCols.filter(
      (col) => col !== "_suggestions" &&
        (originalColsRef.current.has(col) || addedCols.has(col) ||
         participants.some((p) => p[col] != null && p[col] !== "")) &&
        !isRowNumberCol(col, participants)
    );
    return { columns: cols };
  }, [participants, colOrderOverride, columnOrder, addedCols]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which columns have a fixed answer set, and what it is.
  const choiceCols = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const col of columns) {
      const c = choicesFor(col);
      if (c) m.set(col, c);
    }
    return m;
  }, [columns]);

  // ── Layout engine — canvas pixel measurement ──────────────────────────────
  const MIN_COL_PX = 52;
  const ROW_NUM_PX = 24;
  const DELETE_PX  = 20;

  // Memoized — only re-runs when column set or data changes, not on every render.
  const { colWidthPct, totalTablePx, rowNumPct, deletePct } = useMemo(() => {
    const colWidthPx: Record<string, number> = {};
    for (const col of columns) {
      let maxDataPx = 0;
      for (const p of participants) {
        const v = p[col];
        if (v) { const w = measurePx(v); if (w > maxDataPx) maxDataPx = w; }
      }
      const dataConstraint = maxDataPx + 20;
      const headerConstraint = minWidthForNLines(col, 3);
      // A choice column has to hold two chips and the caret even when every
      // cell in it is empty, which is the usual case and measures 0px of data.
      // A choice column has to hold two chips and the caret even when every
      // cell is empty (which measures 0px of data), plus the original reading
      // when that reading was not one of the two valid answers.
      const choiceConstraint = choiceCols.has(col) ? 104 : 0;
      colWidthPx[col] = Math.max(dataConstraint, headerConstraint, choiceConstraint, MIN_COL_PX);
    }
    const total = ROW_NUM_PX + DELETE_PX + columns.reduce((s, c) => s + colWidthPx[c], 0);
    const pct = (px: number) => `${((px / total) * 100).toFixed(2)}%`;
    const widthPct: Record<string, string> = {};
    for (const col of columns) widthPct[col] = pct(colWidthPx[col]);
    return { colWidthPct: widthPct, totalTablePx: total, rowNumPct: pct(ROW_NUM_PX), deletePct: pct(DELETE_PX) };
  }, [columns, participants]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Undo helpers ──────────────────────────────────────────────────────────
  // pushHistory reads directly from the current render's closure — always fresh.
  function pushHistory() {
    historyRef.current = [
      ...historyRef.current.slice(-29), // keep last 30 entries
      {
        participants: participants.map((p) => ({ ...p })),
        colOrderOverride,
        addedCols: new Set(addedCols),
      },
    ];
  }

  const undo = useCallback(() => {
    const entry = historyRef.current.pop();
    if (!entry) return;
    setParticipants(entry.participants);
    setColOrderOverride(entry.colOrderOverride);
    setAddedCols(entry.addedCols);
    // Close any open edit so stale editing state doesn't persist
    setEditingCell(null);
    setEditingHeader(null);
    setFillOffer(null);
    setFillDone(null);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // e.key is the LAYOUT'S character, so on an Arabic keyboard the Z key
      // reports an Arabic letter and this never matched -- undo simply did
      // nothing for anyone not typing on a Latin layout. e.code is the physical
      // key and is layout-independent; e.key stays as the fallback for the rare
      // browser that omits code.
      const isUndoKey = e.code === "KeyZ" || e.key?.toLowerCase() === "z";
      if (!((e.ctrlKey || e.metaKey) && isUndoKey && !e.shiftKey)) return;
      const active = document.activeElement as HTMLElement | null;
      // Skip inputs/textareas that live OUTSIDE this table (e.g. TopBar search).
      if (
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT") &&
        tableContainerRef.current &&
        !tableContainerRef.current.contains(active)
      ) return;
      e.preventDefault();
      undo();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo]);

  // ── Cell edit ─────────────────────────────────────────────────────────────
  const startEdit = useCallback((rowIdx: number, col: string, currentValue: string | null,
                                 el?: HTMLElement | null) => {
    setEditingCell({ row: rowIdx, col });
    setEditValue(currentValue ?? "");
    setCellRect(el ? el.getBoundingClientRect() : null);
    setFillOffer(null);
  }, []);

  // ── Fill down ─────────────────────────────────────────────────────────────
  // Offered only after a value is actually set, and only for the EMPTY cells
  // below it. The old auto-fill wrote over every row unconditionally, so
  // filling a column that OCR had read correctly in 30 of 40 rows destroyed all
  // 30. Cells that already hold something are never touched.
  function offerFor(rowIdx: number, col: string, value: string,
                    next: Array<Record<string, string | null>>, rect: DOMRect | null): FillOffer | null {
    // Never offer on a personal name, birth date or phone -- one value cannot
    // be right for every row in those.
    //
    // Nor on a fixed-choice column. Answering "أنثى" for row 3 says nothing
    // about row 4, so prompting to fill the rest of the column every time
    // someone corrects one cell is pure noise -- and on الجنس it is actively
    // wrong. A column that genuinely is all one answer still has the fill icon
    // in its header.
    if (!value || !rect || isPrimaryField(col) || choiceCols.has(col)) return null;
    const count = next.slice(rowIdx + 1).filter((p) => !p[col]).length;
    return count > 0 ? { row: rowIdx, col, value, count, rect } : null;
  }

  function applyFill() {
    if (!fillOffer) return;
    const { row, col, value } = fillOffer;
    // Recounted here rather than trusting the offer's count: cells may have
    // been edited between the offer appearing and it being taken.
    const targets = participants.map((p, i) => (i > row && !p[col]) ? i : -1).filter((i) => i >= 0);
    if (targets.length === 0) { setFillOffer(null); return; }
    pushHistory();
    setParticipants((prev) => prev.map((p, i) => targets.includes(i) ? { ...p, [col]: value } : p));
    setDirty((prev) => {
      const n = new Set(prev);
      for (const i of targets) n.add(`${i}:${col}`);
      return n;
    });
    setFillOffer(null);
    setFillDone({ count: targets.length });
  }

  // Types straight into every row of the column.
  //
  // History is pushed ONCE, when the panel opens, so the whole fill is a single
  // Ctrl+Z — not one undo step per keystroke. The participants update is
  // debounced because rewriting every row on each character would rebuild the
  // table forty times while someone types a word.
  function fillColumnLive(col: string, val: string) {
    setFillValue(val);
    setDirty((prev) => {
      const n = new Set(prev);
      participants.forEach((_, i) => n.add(`${i}:${col}`));
      return n;
    });
    if (colFillDebounce.current) clearTimeout(colFillDebounce.current);
    colFillDebounce.current = setTimeout(() => {
      setParticipants((prev) => prev.map((p) => ({ ...p, [col]: val || null })));
    }, 150);
  }

  const setCell = useCallback((rowIdx: number, col: string, value: string,
                               rect: DOMRect | null, offerFill = true) => {
    const original = participants[rowIdx][col] ?? "";
    if (value === original) { setEditingCell(null); setCellRect(null); return; }
    pushHistory();
    const next = participants.map((p, i) => i === rowIdx ? { ...p, [col]: value || null } : p);
    setParticipants(next);
    setDirty((prev) => new Set(prev).add(`${rowIdx}:${col}`));
    setEditingCell(null);
    setCellRect(null);
    setFillDone(null);
    setFillOffer(offerFill ? offerFor(rowIdx, col, value, next, rect) : null);
  }, [participants]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitEdit = useCallback((rowIdx: number, col: string) => {
    setCell(rowIdx, col, editValue, cellRect);
  }, [editValue, cellRect, setCell]);

  // Both panels are positioned `fixed` against a rect captured at open time, so
  // a scroll would leave them floating away from their cell. Dismiss instead.
  //
  // The column-fill input is deliberately NOT closed here: it sits in the
  // header, in flow, and moves with the table. Closing it on scroll broke fill
  // on two-choice columns -- every keystroke rewrites the column, the cells flip
  // between chips and text, the rows change height, the browser corrects the
  // scroll position, and that scroll event shut the input after one letter.
  useEffect(() => {
    if (!fillOffer && !editingCell) return;
    function drop() { setFillOffer(null); setEditingCell(null); setCellRect(null); }
    window.addEventListener("scroll", drop, true);
    return () => window.removeEventListener("scroll", drop, true);
  }, [fillOffer, editingCell]);

  useEffect(() => {
    if (!fillDone) return;
    const t = setTimeout(() => setFillDone(null), 5000);
    return () => clearTimeout(t);
  }, [fillDone]);

  // ── Header edit ───────────────────────────────────────────────────────────
  function startHeaderEdit(col: string) { setEditingHeader(col); setHeaderEditValue(col); }

  function commitHeaderEdit(oldCol: string) {
    const newCol = headerEditValue.trim();
    if (!newCol || newCol === oldCol) { setEditingHeader(null); return; }
    pushHistory();
    setParticipants((prev) => prev.map((p) =>
      Object.fromEntries(Object.entries(p).map(([k, v]) => [k === oldCol ? newCol : k, v]))
    ));
    if (addedCols.has(oldCol)) {
      setAddedCols((prev) => { const n = new Set(prev); n.delete(oldCol); n.add(newCol); return n; });
    }
    setDirty((prev) => new Set(prev).add(`header:${oldCol}`));
    setEditingHeader(null);
  }

  // ── Row / column mutations ─────────────────────────────────────────────────
  function deleteRow(rowIdx: number) {
    pushHistory();
    setParticipants((prev) => prev.filter((_, i) => i !== rowIdx));
    setDirty((prev) => new Set(prev).add(`deleted:${rowIdx}`));
    setEditingCell(null);
  }

  function deleteColumn(col: string) {
    if (columns.length <= 1) return;
    pushHistory();
    setParticipants((prev) => prev.map((p) => { const { [col]: _, ...rest } = p; return rest; }));
    setAddedCols((prev) => { const n = new Set(prev); n.delete(col); return n; });
    setDirty((prev) => new Set(prev).add(`col_deleted:${col}`));
    setEditingCell(null); setEditingHeader(null);
  }

  function addRow() {
    pushHistory();
    setParticipants((prev) => [...prev, Object.fromEntries(columns.map((f) => [f, null]))]);
    setDirty((prev) => new Set(prev).add(`added:${participants.length}`));
  }

  function confirmAddColumn() {
    const name = newColName.trim();
    if (!name) { setAddingCol(false); return; }
    pushHistory();
    // Register as an added col BEFORE touching participants so the columns filter includes it
    setAddedCols((prev) => new Set(prev).add(name));
    setParticipants((prev) => prev.map((p) => ({ ...p, [name]: null })));
    setColOrderOverride((prev) => (prev ? [...prev, name] : [...columns, name]));
    setDirty((prev) => new Set(prev).add(`col_added:${name}`));
    setNewColName("");
    setAddingCol(false);
  }

  // ── Suggestions ───────────────────────────────────────────────────────────
  function acceptSuggestion(rowIdx: number, col: string) {
    const sug = suggestions.get(`${rowIdx}:${col}`);
    if (!sug) return;
    pushHistory();
    setParticipants((prev) => prev.map((p, i) => i === rowIdx ? { ...p, [col]: sug.suggested } : p));
    setDirty((prev) => new Set(prev).add(`${rowIdx}:${col}`));
    setSuggestions((prev) => { const next = new Map(prev); next.delete(`${rowIdx}:${col}`); return next; });
  }

  function dismissSuggestion(rowIdx: number, col: string) {
    setSuggestions((prev) => { const next = new Map(prev); next.delete(`${rowIdx}:${col}`); return next; });
  }

  function applyAllSuggestions() {
    if (suggestions.size === 0) return;
    const entries = Array.from(suggestions.entries()).filter(([, s]) => s.suggested !== s.original);
    pushHistory();
    setParticipants((prev) => prev.map((p, i) => {
      const patch: Record<string, string | null> = {};
      for (const [key, sug] of entries) {
        const [rStr, col] = key.split(":");
        if (parseInt(rStr) === i) patch[col] = sug.suggested;
      }
      return { ...p, ...patch };
    }));
    setDirty((prev) => { const next = new Set(prev); for (const [k] of entries) next.add(k); return next; });
    setSuggestions(new Map());
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true); setSaveMsg(null);
    try {
      const cleanParticipants = participants.map((p) =>
        Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("_")))
      );
      const saveRes = await fetch(`/api/documents/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structured_data: cleanParticipants, column_order: columns }),
      });
      if (!saveRes.ok) throw new Error("فشل حفظ البيانات");

      // Manual cell corrections (row:col keys)
      const corrEntries: Array<{ key: string; rowIdx: number; col: string; original: string; corrected: string }> = Array.from(dirty)
        .filter((k) => !k.startsWith("deleted:") && !k.startsWith("added:") && !k.startsWith("header:") && !k.startsWith("col_deleted:") && !k.startsWith("col_added:"))
        .map((key) => {
          const [rowStr, col] = key.split(":");
          const rowIdx = parseInt(rowStr);
          const original = savedBaselineRef.current[rowIdx]?.[col] ?? "";
          const corrected = participants[rowIdx]?.[col] ?? "";
          return { key, rowIdx, col, original, corrected };
        })
        .filter(({ original, corrected }) => original !== corrected);

      const corrResults = await Promise.allSettled(
        corrEntries.map(({ rowIdx, col, original, corrected }) =>
          fetch(`/api/documents/${jobId}/corrections`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participant_index: rowIdx, field_name: col, original_value: original, corrected_value: corrected }),
          }).then(async (r) => {
            if (!r.ok) {
              const body = await r.json().catch(() => ({}));
              throw new Error(body.error || `HTTP ${r.status}`);
            }
            return { field: col, from: original, to: corrected };
          })
        )
      );

      // Surface any correction save failures (don't block the main save)
      const corrFailures = corrResults.filter((r) => r.status === "rejected");
      const successCount = corrResults.filter((r) => r.status === "fulfilled").length;
      void successCount;
      const msg = corrFailures.length > 0
        ? `تم الحفظ ✓ — تحذير: ${corrFailures.length} تصحيح لم يُحفظ (${(corrFailures[0] as PromiseRejectedResult).reason?.message ?? "خطأ"})`
        : `تم الحفظ بنجاح ✓`;
      if (corrFailures.length > 0) console.warn("Correction save failures:", corrFailures);
      setSaveMsg(msg);
      setTimeout(() => setSaveMsg(null), 4000);

      // Update correction baseline to the now-saved state
      savedBaselineRef.current = [...participants];
      setDirty(new Set());
      onSaved?.();
    } catch (err: unknown) {
      setSaveMsg(err instanceof Error ? err.message : "حدث خطأ");
    } finally {
      setSaving(false);
    }
  }

  if (participants.length === 0) {
    return <p style={{ color: "#64748b", fontSize: 13 }}>لم يتم استخراج بيانات مشاركين</p>;
  }

  return (
    <div ref={tableContainerRef} style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── TABLE ─────────────────────────────────────────────────────────── */}
      {/* overflow: auto — enables horizontal scroll only when columns hit their
          minimum width (table minWidth exceeded). No scroll while columns still fit. */}
      <div style={{ borderRadius: 12, border: "1px solid #e2e8f0", overflowX: "auto", overflowY: "visible", width: "100%" }}>
        {/* key on colgroup — forces colgroup remount when column order/set changes.
            Eliminates drag ghost artifacts and colgroup reconciliation bugs that cause
            white/blurry columns after reorder. Does NOT remount the whole table,
            so Ctrl+Z state restoration works correctly. */}
        <table
          dir="rtl"
          style={{
            borderCollapse: "separate", borderSpacing: 0,
            width: "100%", minWidth: `${totalTablePx}px`,
            fontSize: 13, tableLayout: "fixed",
          }}
        >
          <colgroup key={columns.join("|")}>
            <col style={{ width: rowNumPct }} />
            {columns.map((col) => <col key={col} style={{ width: colWidthPct[col] }} />)}
            <col style={{ width: deletePct }} />
          </colgroup>

          <thead>
            {/* ── Column names row ───────────────────────────────────────── */}
            <tr style={{ background: "#1e293b", color: "#e2e8f0" }}>
              <th style={{ padding: "4px 3px", textAlign: "center", fontWeight: 600, fontSize: 12, borderLeft: "1px solid #334155", verticalAlign: "middle" }}>
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col}
                  draggable
                  onDragStart={() => { dragColRef.current = col; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverCol(col); }}
                  onDragLeave={() => setDragOverCol(null)}
                  onDrop={() => {
                    const from = dragColRef.current;
                    if (!from || from === col) { setDragOverCol(null); return; }
                    const newOrder = [...columns];
                    const fi = newOrder.indexOf(from); const ti = newOrder.indexOf(col);
                    newOrder.splice(fi, 1); newOrder.splice(ti, 0, from);
                    setColOrderOverride(newOrder);
                    setDirty((prev) => new Set(prev).add("col_reorder"));
                    dragColRef.current = null; setDragOverCol(null);
                  }}
                  onDragEnd={() => { dragColRef.current = null; setDragOverCol(null); }}
                  style={{
                    padding: "4px 5px", textAlign: "center", fontWeight: 600, fontSize: 12,
                    borderLeft: "1px solid #334155", cursor: "grab", userSelect: "none",
                    position: "relative", verticalAlign: "middle",
                    // Always explicit — no `undefined` fallback that resolves to transparent,
                    // and no CSS transition that animates toward transparent (white ghost).
                    background: dragOverCol === col ? "#2d4a6e" : "#1e293b",
                  }}
                >
                  {editingHeader === col ? (
                    <input
                      autoFocus
                      style={{ width: "100%", padding: "2px 4px", border: "1px solid #7c3aed", borderRadius: 4, fontSize: 11, outline: "none", background: "#334155", color: "#fff" }}
                      value={headerEditValue}
                      onChange={(e) => setHeaderEditValue(e.target.value)}
                      onBlur={() => commitHeaderEdit(col)}
                      onKeyDown={(e) => { if (e.key === "Enter") commitHeaderEdit(col); if (e.key === "Escape") setEditingHeader(null); }}
                      dir="rtl"
                    />
                  ) : (
                    <>
                      <span
                        onClick={() => startHeaderEdit(col)}
                        title={col}
                        style={{ display: "block", cursor: "pointer", lineHeight: 1.3, wordBreak: "break-word", whiteSpace: "normal", textAlign: "center", paddingBlock: isPrimaryField(col) ? 0 : 14 }}
                      >
                        {col}
                      </span>
                      {columns.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteColumn(col); }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="col-delete-btn"
                          title="حذف العمود"
                          style={{ position: "absolute", top: 2, left: 2, color: "#64748b", background: "none", border: "none", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1, opacity: 0 }}
                        >✕</button>
                      )}
                      {/* The input lives in this column's header, under its
                          name — not as a bar across the whole table. It only
                          exists while open, so the header is unchanged at rest,
                          and being in flow it pushes rather than covers. */}
                      {fillCol === col && (
                        <input
                          autoFocus
                          value={fillValue}
                          onChange={(e) => fillColumnLive(col, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Escape" || e.key === "Enter") setFillCol(null);
                          }}
                          onBlur={() => setFillCol(null)}
                          placeholder="القيمة للكل"
                          dir={numericCols.has(col) ? "ltr" : "rtl"}
                          style={{
                            width: "95%", marginTop: 3, fontFamily: "inherit",
                            fontSize: 11, padding: "2px 5px", borderRadius: 4,
                            border: "1.5px solid #7c3aed", outline: "none",
                            textAlign: "center", background: "#fff", color: "#35313a",
                          }}
                        />
                      )}

                      {/* Fill the column. Sits opposite the delete button and
                          appears the same way — hidden until the header is
                          hovered, so a table at rest stays clean.
                          Not offered on names, phones or dates of birth: one
                          value cannot be right for every row in those. */}
                      {!isPrimaryField(col) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Once, here — so the whole fill is a single Ctrl+Z
                            // rather than one undo step per character typed.
                            pushHistory();
                            setFillCol(col);
                            setFillValue("");
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="col-fill-btn material-symbols-outlined"
                          title="تعبئة العمود بقيمة واحدة"
                          // Always visible, not hover-revealed: an affordance
                          // nobody can see is one nobody uses.
                          style={{ position: "absolute", top: 3, right: 3, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
                        >keyboard_double_arrow_down</button>
                      )}
                    </>
                  )}
                </th>
              ))}
              <th style={{ borderLeft: "1px solid #334155" }} />
            </tr>
          </thead>

          <tbody>
            {participants.map((participant, rowIdx) => (
              <tr
                key={rowIdx}
                style={{ background: rowIdx % 2 === 0 ? "#ffffff" : "#f8fafc" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(237,233,254,0.4)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = rowIdx % 2 === 0 ? "#ffffff" : "#f8fafc"; }}
              >
                <td style={{ padding: "2px 2px", color: "#94a3b8", textAlign: "center", borderLeft: "1px solid #f1f5f9", fontSize: 11, whiteSpace: "nowrap", borderTop: "1px solid #f1f5f9" }}>
                  {rowIdx + 1}
                </td>

                {columns.map((col) => {
                  const isEditing = editingCell?.row === rowIdx && editingCell?.col === col;
                  const value     = participant[col];
                  const sugKey    = `${rowIdx}:${col}`;
                  const suggestion = suggestions.get(sugKey);
                  const wordCount  = (value ?? "").trim().split(/\s+/).filter(Boolean).length;
                  const multiLine  = wordCount > 3;
                  const choices    = choiceCols.get(col);
                  // A value the pipeline could not fold into one of the two.
                  // Kept exactly as written -- the form is the record, not the
                  // list -- but marked so it is visible on review.
                  const offList    = !!choices && !!value && !choices.includes(value);
                  // Chips whenever the cell does NOT already hold a valid
                  // answer. Empty is the obvious case, but a bad read ("أنثر",
                  // ".5", "F") is the one that actually needs fixing most, and
                  // it used to be the only case with no one-click way out.
                  const needsChoice = !!choices && (!value || offList);

                  return (
                    <td
                      key={col}
                      onClick={(e) => { if (!isEditing) startEdit(rowIdx, col, value, e.currentTarget); }}
                      style={{
                        padding: isEditing ? "1px 2px" : "2px 3px",
                        borderLeft: "1px solid #f1f5f9", borderTop: "1px solid #f1f5f9",
                        cursor: isEditing ? "text" : "pointer",
                        // No edit highlight. `dirty` is never cleared -- not
                        // even on a successful save -- so the tint did not mean
                        // "unsaved", it meant "touched at some point in this
                        // session" and stayed for good. dirty itself is kept:
                        // handleSave uses it to decide which corrections to
                        // send, and that is the only job it does well.
                        verticalAlign: "middle", textAlign: "center",
                        position: "relative", overflow: "hidden",
                      }}
                    >
                      {isEditing ? (
                        <>
                          <input
                            autoFocus
                            style={{ width: "100%", padding: "3px 5px", border: "1.5px solid #7c3aed", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff", textAlign: "center" }}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(rowIdx, col)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(rowIdx, col); if (e.key === "Escape") { setEditingCell(null); setCellRect(null); } }}
                            dir={numericCols.has(col) ? "ltr" : "rtl"}
                          />
                        </>
                      ) : needsChoice && choices ? (
                        // The common case: the pipeline blanks anything it could
                        // not read with confidence, so most of a choice column
                        // arrives empty. Both answers sit right in the cell, so
                        // filling one is a single click rather than open-then-pick.
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                          {choices.map((ch) => (
                            <button
                              key={ch}
                              className="choice-chip"
                              onClick={(e) => { e.stopPropagation(); setCell(rowIdx, col, ch, null, false); }}
                            >{ch}</button>
                          ))}
                        </div>
                      ) : choices ? (
                        <span
                          title={value ?? ""}
                          style={{ fontSize: 13, color: "#35313a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                        >{value}</span>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 2 }}>
                          <span
                            style={multiLine ? {
                              display: "-webkit-box", WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical", overflow: "hidden",
                              color: value ? "#35313a" : "#cbd5e1", fontSize: 13,
                              textAlign: "center", wordBreak: "break-word", lineHeight: 1.3,
                            } as React.CSSProperties : {
                              display: "block", overflow: "hidden", textOverflow: "ellipsis",
                              whiteSpace: "nowrap", color: value ? "#35313a" : "#cbd5e1",
                              fontSize: 13, textAlign: "center",
                            }}
                            title={value ?? ""}
                          >
                            {value ?? "—"}
                          </span>
                          {suggestion?.needs_review && (
                            <div
                              className="suggestion-popover"
                              style={{
                                position: "absolute", zIndex: 30, top: "100%", right: 0, marginTop: 4,
                                background: "#fff", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                                border: "1px solid #fed7aa",
                                padding: "8px 12px", whiteSpace: "nowrap", minWidth: "max-content",
                                fontSize: 12, direction: "rtl",
                              }}
                            >
                              {suggestion.suggested !== suggestion.original && (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                  <span style={{ color: "#c2410c", fontWeight: 500 }}>اقتراح: {suggestion.suggested}</span>
                                  <button onClick={(e) => { e.stopPropagation(); acceptSuggestion(rowIdx, col); }} style={{ color: "#16a34a", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>✓</button>
                                </div>
                              )}
                              <button onClick={(e) => { e.stopPropagation(); dismissSuggestion(rowIdx, col); }} style={{ color: "#94a3b8", background: "none", border: "none", cursor: "pointer", fontSize: 11 }}>✕ تجاهل</button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}

                <td
                  style={{ padding: "6px 3px", borderLeft: "1px solid #f1f5f9", borderTop: "1px solid #f1f5f9", textAlign: "center" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => deleteRow(rowIdx)}
                    style={{ color: "#cbd5e1", background: "none", border: "none", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: "2px 3px", borderRadius: 4, transition: "color 0.15s" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "#cbd5e1"; }}
                    title="حذف الصف"
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── FILL DOWN ─────────────────────────────────────────────────────── */}
      {/* Offered at the moment a value is set, anchored under that cell. There
          is no permanent strip: the old one repeated "تعبئة تلقائية" once per
          column above the header of every table, whether or not anyone used it. */}
      {fillOffer && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "fixed", top: fillOffer.rect.bottom + 5,
            right: typeof window !== "undefined" ? window.innerWidth - fillOffer.rect.right : 0,
            zIndex: 70, display: "flex", alignItems: "center", gap: 8,
            background: "#fff", border: "1px solid #ddd6fe", borderRadius: 7,
            boxShadow: "0 6px 18px rgba(109,40,217,0.14)", padding: "5px 10px",
            direction: "rtl",
          }}
        >
          <button
            onClick={applyFill}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#7c3aed", padding: 0, fontFamily: "inherit", whiteSpace: "nowrap" }}
          >
            <Caret color="#7c3aed" />
            املأ الـ {fillOffer.count} الفارغة
          </button>
          <button
            onClick={() => setFillOffer(null)}
            title="إغلاق"
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#cbd5e1", padding: 0, lineHeight: 1 }}
          >✕</button>
        </div>
      )}

      {fillDone && (
        <div style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 9, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 7, padding: "6px 11px", fontSize: 12, color: "#166534", direction: "rtl" }}>
          تم ملء {fillDone.count} خلية
          <button
            onClick={() => undo()}
            style={{ color: "#7c3aed", background: "none", border: "none", cursor: "pointer", fontSize: 12, fontFamily: "inherit", borderRight: "1px solid #bbf7d0", paddingRight: 9 }}
          >تراجع</button>
        </div>
      )}

      {/* ── ADD ROW + ADD COLUMN ──────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <button
          onClick={addRow}
          style={{ fontSize: 12, color: "#7c3aed", background: "none", border: "none", cursor: "pointer", padding: "2px 0" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
        >
          + إضافة مشارك
        </button>

        {addingCol ? (
          <form
            onSubmit={(e) => { e.preventDefault(); confirmAddColumn(); }}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <input
              autoFocus
              value={newColName}
              onChange={(e) => setNewColName(e.target.value)}
              placeholder="اسم العمود الجديد"
              dir="rtl"
              style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1.5px solid #7c3aed", outline: "none", background: "#fff", width: 160 }}
              onKeyDown={(e) => { if (e.key === "Escape") { setAddingCol(false); setNewColName(""); } }}
            />
            <button type="submit" style={{ fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "none", background: "#7c3aed", color: "#fff", cursor: "pointer", fontWeight: 600 }}>✓</button>
            <button type="button" onClick={() => { setAddingCol(false); setNewColName(""); }} style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1px solid #cbd5e1", background: "none", color: "#64748b", cursor: "pointer" }}>✕</button>
          </form>
        ) : (
          <button
            onClick={() => setAddingCol(true)}
            style={{ fontSize: 12, color: "#7c3aed", background: "none", border: "none", cursor: "pointer", padding: "2px 0" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
          >
            + إضافة عمود
          </button>
        )}
      </div>

      {/* ── REVIEW NOTICE ─────────────────────────────────────────────────── */}
      {!reviewBannerDismissed && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(254,243,199,0.7)", border: "1px solid rgba(251,191,36,0.5)", borderRadius: 10, padding: "9px 14px", direction: "rtl" }}>
          <span style={{ color: "#92400e", fontSize: 12 }}>راجع دائماً جميع الأسماء والأرقام والحقول يدوياً. قد يرتكب النظام أخطاء في استخراج النص.</span>
          <button onClick={() => setReviewBannerDismissed(true)} style={{ color: "#b45309", background: "none", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, padding: "0 4px", lineHeight: 1 }} title="إغلاق">×</button>
        </div>
      )}


      {/* ── SAVE BAR + EXPORT ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        {(dirty.size > 0 || saveMsg) && (
          <>
            {dirty.size > 0 && (
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ color: "#fff", fontSize: 12, padding: "7px 18px", borderRadius: 9999, border: "none", cursor: saving ? "not-allowed" : "pointer", fontWeight: 600, opacity: saving ? 0.5 : 1, background: "linear-gradient(135deg,#7c3aed,#6d28d9)", boxShadow: "0 3px 10px rgba(109,40,217,0.25)" }}
              >
                {saving ? "جارٍ الحفظ…" : "حفظ التغييرات"}
              </button>
            )}
            {saveMsg && <span style={{ fontSize: 12, color: saveMsg.includes("✓") ? "#16a34a" : "#dc2626" }}>{saveMsg}</span>}
          </>
        )}

        {canExport && dirty.size === 0 && onExport && (
          <button
            onClick={onExport}
            disabled={exporting}
            style={{ display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, padding: "7px 18px", borderRadius: 9999, border: "none", cursor: exporting ? "not-allowed" : "pointer", fontWeight: 600, opacity: exporting ? 0.6 : 1, background: "linear-gradient(135deg,#7c3aed,#6d28d9)", boxShadow: "0 3px 10px rgba(109,40,217,0.25)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              {exported ? "check" : "file_download"}
            </span>
            Export to Excel
          </button>
        )}
      </div>

      <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
        انقر على أي خلية لتعديلها • اسحب رأس العمود لإعادة ترتيبه • Ctrl+Z للتراجع
      </p>

      <style>{`
        thead tr th:hover .col-delete-btn { opacity: 1 !important; }
        .col-fill-btn:hover { color: #ffffff !important; }
        .suggestion-popover { display: none; }
        td:hover .suggestion-popover { display: block; }
        .choice-chip {
          font-family: inherit; font-size: 12px; line-height: 1.5;
          color: #7c3aed; background: #faf5ff; border: 1px solid #ddd6fe;
          border-radius: 5px; padding: 1px 8px; cursor: pointer;
          white-space: nowrap; transition: background .12s, border-color .12s;
        }
        .choice-chip:hover { background: #ede9fe; border-color: #a78bfa; }
        .choice-opt:hover { background: #f5f3ff; }
      `}</style>
    </div>
  );
}
