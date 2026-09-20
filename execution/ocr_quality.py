"""
OCR Quality Layers — 4 accuracy guarantees on top of the core pipeline.

Layer 1: Multi-Engine Conflict Resolution  (OCR_CONFLICT_RESOLUTION=1)
    Compare Azure and Gemini OCR row-by-row. On mismatch, crop the disputed
    area from the PDF and ask Gemini to make a final visual determination.
    Requires: both Azure and Gemini OCR results, PDF bytes.

Layer 2: Zone Chunking / Spatial Zooming  (OCR_ZONE_CHUNKING=1)
    Detect the table zone using Azure line polygons, crop at 400 DPI, and
    re-submit the high-res crop to Gemini for focused extraction.
    Requires: Azure OCR result with polygon data, PDF bytes.

Layer 3: Super-Resolution for Low-Confidence Lines  (OCR_SUPER_RESOLUTION=1)
    Find lines where Azure confidence < 0.65, upscale 4× with LANCZOS +
    sharpening, and re-read them with Gemini.
    Requires: Azure OCR result with per-word confidence, PDF bytes.

Layer 4: Mathematical & Logical Reconciliation  (OCR_MATH_RECONCILIATION=1, default ON)
    Pure-Python checks on structured_data: phone formats, name completeness,
    arithmetic consistency, date formats. No API calls — zero cost.

Layers 1–3 are OFF by default and require AZURE_OCR_ENABLED=1 to be useful.
Layer 4 always runs (no API cost).
"""

from __future__ import annotations

import difflib
import io as _io
import logging
import os
import re

logger = logging.getLogger(__name__)


# ── Shared helpers ──────────────────────────────────────────────────────────────

def _gemini_client():
    """Return a google.genai.Client + types, or raise ImportError."""
    from google import genai
    from google.genai import types as genai_types
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise EnvironmentError("GEMINI_API_KEY not set")
    return genai.Client(api_key=api_key), genai_types


def _model_name() -> str:
    return os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 4 — Mathematical & Logical Reconciliation (Self-Audit)
# ══════════════════════════════════════════════════════════════════════════════

_PHONE_RE  = re.compile(r"^(059|056)\d{7}$")
_ID_RE     = re.compile(r"^\d{9}$")
_DATE_RE   = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$|^\d{4}-\d{2}-\d{2}$|^\d{4}/\d{1,2}/\d{1,2}$")

# Arabic-Indic numerals → Western for arithmetic
_AR_NUM_TABLE = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def _number_is_clean(raw: str) -> bool:
    """
    True when a numeric cell is nothing but digits.

    A space or dot inside a number is OCR uncertainty, not formatting -- these
    forms are written as continuous digits. "409060 271" strips to nine digits
    and passes a length check while still being a misread; "907.27820" only
    failed because it happened to lose one. The separator is the better signal,
    so treat any non-digit between digits as malformed and let the cell be
    re-read.
    """
    clean = str(raw or "").translate(_AR_NUM_TABLE).strip()
    return bool(clean) and clean.isdigit()


def _to_float(val: str) -> float | None:
    val = str(val).replace(",", "").replace("،", "").translate(_AR_NUM_TABLE).strip()
    try:
        return float(val)
    except ValueError:
        return None


def _col_match(cols: list[str], pattern: re.Pattern) -> list[str]:
    return [c for c in cols if pattern.search(c)]


def mathematical_reconciliation(structured_data: list[dict]) -> dict:
    """
    Layer 4: audit structured data for internal consistency. No API calls.

    Checks:
      ① Phone format — must match 059xxxxxxx or 056xxxxxxx
      ② Name completeness — Palestinian names have 4 Arabic token parts
      ③ Arithmetic: unit_price × quantity == line_total (if columns present)
      ④ Grand total: sum(line_totals) == last-row total (if columns present)
      ⑤ Date format sanity

    Returns:
        anomalies: list[dict], anomaly_count: int,
        arithmetic_checks: int, rows_clean: int
    """
    if not os.getenv("OCR_MATH_RECONCILIATION", "1") == "1":
        return {"anomalies": [], "anomaly_count": 0, "arithmetic_checks": 0, "rows_clean": 0}

    if not structured_data:
        return {"anomalies": [], "anomaly_count": 0, "arithmetic_checks": 0, "rows_clean": 0}

    cols = list(structured_data[0].keys()) if structured_data else []

    _NAME_PAT  = re.compile(r"اسم|name", re.I)
    _PHONE_PAT = re.compile(r"هاتف|تواصل|جوال|موبايل|phone|mobile|tel", re.I)
    _PRICE_PAT = re.compile(r"سعر|price|unit.?price|وحدة", re.I)
    _QTY_PAT   = re.compile(r"كمية|qty|quantity|عدد", re.I)
    _TOTAL_PAT = re.compile(r"مجموع|total|إجمالي|اجمالي", re.I)
    _DATE_PAT  = re.compile(r"تاريخ|ميلاد|ولاد|date|dob|birth", re.I)
    # ID columns were never validated, so a mangled ID reached the customer
    # unflagged: "907.27820" is eight digits and a stray dot where a nine-digit
    # number belongs. Excludes phone columns, which also match "رقم".
    _IDNUM_PAT = re.compile(r"هوية|هويه|identity|id|national", re.I)

    name_cols  = _col_match(cols, _NAME_PAT)
    phone_cols = _col_match(cols, _PHONE_PAT)
    price_cols = _col_match(cols, _PRICE_PAT)
    qty_cols   = _col_match(cols, _QTY_PAT)
    total_cols = _col_match(cols, _TOTAL_PAT)
    # A header saying تاريخ is not enough to make a column a date column. An
    # attendance sheet heads each day's column "تاريخ اليوم (1) ٩/١٢" -- the
    # date lives in the HEADER and every cell under it is a participant's
    # signature. Matched on the header alone, all 55 of those signatures were
    # flagged as malformed dates, sent to Gemini one by one (10 of a 13-minute
    # run), and 10 were overwritten with invented dates in four calendars.
    #
    # So the cells get a vote: the column only counts as dates when at least
    # half of its filled cells are shaped like one. A signature has no digits
    # and never qualifies; a date-of-birth column with a few OCR slips still
    # does. Proven on the same run -- the one day column whose header OCR'd as
    # "تاریخ" (Persian ی) escaped the header match and kept all 13 signatures.
    _LOOKS_DATE = re.compile(r"\d{1,4}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{1,4}")

    def _cells_are_dates(col: str) -> bool:
        vals = [str(r.get(col) or "").strip() for r in structured_data]
        vals = [v for v in vals if v]
        if not vals:
            return False
        datey = sum(1 for v in vals if _LOOKS_DATE.search(v.translate(_AR_NUM_TABLE)))
        return datey / len(vals) >= 0.5

    date_cols  = [c for c in _col_match(cols, _DATE_PAT) if _cells_are_dates(c)]
    id_cols    = [c for c in _col_match(cols, _IDNUM_PAT) if c not in phone_cols]

    anomalies: list[dict] = []
    arithmetic_checks = 0
    line_total_values: list[float] = []

    for row_idx, row in enumerate(structured_data):

        # ① Phone format
        for pc in phone_cols:
            raw    = str(row.get(pc) or "").strip()
            digits = re.sub(r"\D", "", raw.translate(_AR_NUM_TABLE))
            if digits and (not _PHONE_RE.match(digits) or not _number_is_clean(raw)):
                anomalies.append({
                    "row": row_idx, "field": pc,
                    "issue": "phone_format",
                    "expected": "10 digits starting with 059 or 056, no separators",
                    "found": raw if not _number_is_clean(raw) else digits,
                })

        # ①b ID number format — nine digits, nothing else
        for ic in id_cols:
            raw    = str(row.get(ic) or "").strip()
            digits = re.sub(r"\D", "", raw.translate(_AR_NUM_TABLE))
            if digits and (not _ID_RE.match(digits) or not _number_is_clean(raw)):
                anomalies.append({
                    "row": row_idx, "field": ic,
                    "issue": "id_format",
                    "expected": "9 digits, no separators",
                    "found": raw if not _number_is_clean(raw) else digits,
                })

        # ② Name completeness
        for nc in name_cols:
            name_val = str(row.get(nc) or "").strip()
            if not name_val:
                continue
            ar_tokens = [t for t in name_val.split() if re.search(r"[\u0600-\u06FF]", t)]
            if 0 < len(ar_tokens) < 4:
                anomalies.append({
                    "row": row_idx, "field": nc,
                    "issue": "name_incomplete",
                    "expected": "4 Arabic parts (given + father + grandfather + family)",
                    "found": f"{len(ar_tokens)} parts: {name_val}",
                })

        # ③ Date format
        for dc in date_cols:
            date_val = str(row.get(dc) or "").strip()
            if date_val and not _DATE_RE.match(date_val):
                anomalies.append({
                    "row": row_idx, "field": dc,
                    "issue": "date_format",
                    "expected": "dd/mm/yyyy or yyyy-mm-dd",
                    "found": date_val,
                })

        # ④ Arithmetic: price × qty == line total
        if price_cols and qty_cols and total_cols:
            for pc, qc, tc in zip(price_cols, qty_cols, total_cols):
                price = _to_float(str(row.get(pc) or ""))
                qty   = _to_float(str(row.get(qc) or ""))
                total = _to_float(str(row.get(tc) or ""))
                if price is not None and qty is not None and total is not None:
                    arithmetic_checks += 1
                    expected = round(price * qty, 2)
                    if abs(expected - total) > 0.05:
                        anomalies.append({
                            "row": row_idx, "field": tc,
                            "issue": "arithmetic_mismatch",
                            "expected": str(expected),
                            "found": str(total),
                        })
                    if total is not None:
                        line_total_values.append(total)

    # ⑤ Grand total
    if total_cols and len(structured_data) > 2 and line_total_values:
        tc = total_cols[0]
        last_row_total = _to_float(str(structured_data[-1].get(tc) or ""))
        if last_row_total is not None:
            line_sum = round(sum(line_total_values[:-1]), 2) if len(line_total_values) > 1 else 0
            arithmetic_checks += 1
            if abs(line_sum - last_row_total) > 0.05 and line_sum > 0:
                anomalies.append({
                    "row": len(structured_data) - 1, "field": tc,
                    "issue": "grand_total_mismatch",
                    "expected": str(line_sum),
                    "found": str(last_row_total),
                })

    rows_with_issues = {a["row"] for a in anomalies}
    rows_clean = len(structured_data) - len(rows_with_issues)

    if anomalies:
        logger.warning(
            f"[OCRQuality/L4] {len(anomalies)} anomaly(ies) in "
            f"{len(rows_with_issues)} row(s), {rows_clean} rows clean"
        )
        for a in anomalies:
            logger.warning(
                f"[OCRQuality/L4]   row={a['row']} field={a['field']!r} "
                f"issue={a['issue']} found={str(a['found'])[:40]!r}"
            )
    else:
        logger.info(
            f"[OCRQuality/L4] All {len(structured_data)} row(s) passed "
            f"({arithmetic_checks} arithmetic check(s))"
        )

    return {
        "anomalies":         anomalies,
        "anomaly_count":     len(anomalies),
        "arithmetic_checks": arithmetic_checks,
        "rows_clean":        rows_clean,
    }


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 5 — Name-Column Focused OCR + Multi-OCR Name Reconciliation
# ══════════════════════════════════════════════════════════════════════════════
# Stage 3.9: extract_name_column_ocr
#   Crops just the name column strip from the PDF and sends a dedicated
#   Gemini Vision call.  Returns one name per row for every page.
#
# Stage 4.6: reconcile_multi_ocr_names
#   Fuses four OCR readings per name (structured, col_ocr, azure_raw,
#   gemini_raw) plus top-3 fuzzy family-name candidates into one Gemini
#   text call that picks the best name.
# ══════════════════════════════════════════════════════════════════════════════

_NAME_COL_PROMPT = (
    "أمامك صورة لعمود الاسم الرباعي من استمارة تسجيل بالخط العربي اليدوي.\n"
    "المطلوب: اكتب الأسماء الرباعية مرقمةً بالترتيب من أعلى إلى أسفل.\n"
    "الشكل المطلوب:\n"
    "1. الاسم الأول\n"
    "2. الاسم الثاني\n"
    "... وهكذا\n\n"
    "قواعد مهمة:\n"
    "- كل سطر يجب أن يحتوي على رقم ونقطة واسم رباعي.\n"
    "- الاسم الرباعي = الاسم الأول + اسم الأب + اسم الجد + اسم العائلة (أربع كلمات).\n"
    "- تجاهل تماماً أي كلمة تدل على الجنس مثل: أنثى، ذكر، م، أ — حتى لو ظهرت بجانب الاسم.\n"
    "- تجاهل أي رموز أو أرقام أو توقيعات.\n"
    "- إذا كانت الخانة فارغة، اكتب: رقم. (فارغ)\n"
    "- لا تضف أي شرح أو تعليق — الأسماء فقط."
)

_NAME_RECONCILE_PROMPT_PREFIX = """\
أنت محكّم دقة لأسماء عربية مكتوبة بخط اليد.
لكل صف أدناه، لديك أربع قراءات OCR للاسم الرباعي واقتراحات من قاموس أسماء العائلات.

أولويات الاختيار (من الأعلى للأدنى):
1. col_ocr — قراءة مركّزة على عمود الاسم فقط (الأدق)
2. family_candidates — أقرب أسماء عائلات من القاموس
3. azure_raw / gemini_raw — القراءة الخام من OCR
4. structured — المخرج النهائي لـ Gemini (الأقل ثقة)

قاعدة صارمة: إذا كان col_ocr يختلف عن structured → خذ col_ocr وليس structured.
استثناء: إذا كان col_ocr يبدو مبتوراً أو حرف واحد فقط، تجاهله.

أعد JSON مصفوفة فقط — لا شرح — بهذا الشكل:
[{"row": 0, "name": "الاسم الصحيح"}, ...]

البيانات:
"""


def _find_name_col_x(azure_result: dict, page_width_pts: float) -> tuple:
    """Return (x0, x1) in PDF points for the name column.

    Strategy 1: header line containing 'الاسم' + qualifier word.
    Strategy 2: use azure grid_text pipe rows as anchors — match those exact
                texts back to Azure line polygons to get the real x-bounds.
    Strategy 3: fallback right 40% of page.
    """
    try:
        pages = (azure_result or {}).get("pages", [])

        # ── Strategy 1: header keyword → expand to actual content bounds ─────────
        # The header cell is often narrower than the name content beneath it.
        # Find the header x-center, then collect all Arabic content lines in
        # that same column and use their wider union as the crop bounds.
        for page in pages:
            page_w = page.get("width") or 1
            for line in page.get("lines", []):
                text = line.get("content", "")
                if "الاسم" in text and any(
                    w in text for w in ["رباعي", "مشارك", "الكامل", "الطالب", "المشارك"]
                ):
                    poly = line.get("polygon", [])
                    if len(poly) < 8:
                        continue
                    hdr_xs = [poly[i] for i in range(0, len(poly), 2)]
                    hdr_center_norm = sum(hdr_xs) / len(hdr_xs) / page_w

                    # Collect all lines in this column (within ±15% of header centre)
                    col_x_mins: list = []
                    col_x_maxs: list = []
                    for pg2 in pages:
                        pg2_w = pg2.get("width") or 1
                        for ln2 in pg2.get("lines", []):
                            c2 = ln2.get("content", "").strip()
                            if not c2 or any(d.isdigit() for d in c2):
                                continue
                            ar2 = [t for t in c2.split()
                                   if sum(1 for ch in t if '\u0600'<=ch<='\u06ff') >= 2]
                            if len(ar2) < 2:
                                continue
                            p2 = ln2.get("polygon", [])
                            if len(p2) < 8:
                                continue
                            xs2 = [p2[i] for i in range(0, len(p2), 2)]
                            center2 = sum(xs2) / len(xs2) / pg2_w
                            if abs(center2 - hdr_center_norm) <= 0.15:
                                col_x_mins.append(min(xs2) / pg2_w * page_width_pts)
                                col_x_maxs.append(max(xs2) / pg2_w * page_width_pts)

                    if col_x_mins:
                        col_x_mins.sort(); col_x_maxs.sort()
                        n = len(col_x_mins)
                        x0 = max(0,              col_x_mins[max(0, n//5)] - 8)
                        x1 = min(page_width_pts, col_x_maxs[int(n*0.90)]  + 8)
                        logger.debug(
                            f"[NameColX] Strategy 1 expanded: x0={x0:.1f} x1={x1:.1f} pts "
                            f"({n} content lines around header)"
                        )
                        return x0, x1
                    else:
                        # No content found — fall through to Strategy 2
                        break

        # ── Strategy 2: widest Arabic lines on right half = name column ──────────
        # The name column always has the most Arabic words per line (4-part names).
        # Collect lines with ≥3 Arabic word-tokens whose centre is in the right 50%.
        # The x-span of those lines defines the column bounds.
        _SKIP = frozenset({
            'ذكر','أنثى','انثى','موافق','نعم','لا','الجنس','الاسم',
            'تاريخ','الميلاد','العمر','الهاتف','المحافظة','التوقيع',
            'الرقم','ملاحظات','الحالة','رباعي','الكامل','مشارك',
        })
        x_spans: list = []   # each entry: (x_min_pts, x_max_pts, span_pts)
        for page in pages:
            page_w = page.get("width") or 1   # Azure: inches
            for ln in page.get("lines", []):
                content = ln.get("content", "").strip()
                if any(c.isdigit() for c in content):
                    continue
                tokens = content.split()
                ar_tokens = [
                    t for t in tokens
                    if sum(1 for c in t if '\u0600' <= c <= '\u06ff') >= 2
                    and t not in _SKIP
                ]
                if len(ar_tokens) < 3:          # need ≥3 Arabic word-tokens
                    continue
                poly = ln.get("polygon", [])
                if len(poly) < 8:
                    continue
                xs_raw = [poly[i] for i in range(0, len(poly), 2)]
                x_center_norm = sum(xs_raw) / len(xs_raw) / page_w
                if x_center_norm < 0.45:        # right 55% only
                    continue
                x_min_pts = min(xs_raw) / page_w * page_width_pts
                x_max_pts = max(xs_raw) / page_w * page_width_pts
                x_spans.append((x_min_pts, x_max_pts, x_max_pts - x_min_pts))

        if len(x_spans) >= 3:
            # Sort by span descending; take the widest cluster (top 80%)
            x_spans.sort(key=lambda t: -t[2])
            top = x_spans[:max(3, int(len(x_spans) * 0.8))]
            x0 = max(0,              min(t[0] for t in top) - 8)
            x1 = min(page_width_pts, max(t[1] for t in top) + 8)
            logger.debug(
                f"[NameColX] Strategy 2: x0={x0:.1f} x1={x1:.1f} pts "
                f"({len(x_spans)} wide Arabic lines)"
            )
            return x0, x1

    except Exception:
        pass

    # ── Strategy 3: fallback right 40% of page ────────────────────────────────
    logger.debug("[NameColX] Strategy 3 fallback: right 40%")
    return page_width_pts * 0.60, page_width_pts


def _parse_numbered_names(text: str, expected: int) -> list:
    """Parse '1. name\\n2. name\\n...' Gemini output into a 0-indexed list."""
    import re
    result: list = [None] * max(expected, 0)
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r'^(\d+)[\.،\-\)]\s*(.+)$', line)
        if not m:
            continue
        idx  = int(m.group(1)) - 1   # 1-based → 0-based
        name = m.group(2).strip()
        if name in ('(فارغ)', 'فارغ', '-', '', '—', 'empty', 'blank'):
            name = None
        if idx >= 0:
            if idx >= len(result):
                result.extend([None] * (idx - len(result) + 1))
            result[idx] = name
    return result


def extract_name_column_ocr(
    azure_result: dict,
    pdf_bytes: bytes,
    expected_rows: int = 0,
) -> list:
    """Crop the name column strip from every PDF page and extract names.

    Processes each page separately (one Gemini call per page) so Gemini
    does not skip rows when the stitched image is too tall.  Results from
    all pages are concatenated into one ordered list.

    Returns a list of name strings (None for empty/failed slots).
    Disabled when NAME_COLUMN_OCR=0 env var is set.
    """
    if os.getenv("NAME_COLUMN_OCR", "1") != "1":
        return []

    try:
        import fitz
        from PIL import Image
        import io as _pil_io
    except ImportError as e:
        logger.warning(f"[OCRQuality/L5] Missing dependency for name-column OCR: {e}")
        return []

    try:
        client, genai_types = _gemini_client()
    except Exception as e:
        logger.warning(f"[OCRQuality/L5] No Gemini client: {e}")
        return []

    # ── Render one strip per page ──────────────────────────────────────────────
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        num_pages = len(doc)
        col_x0 = col_x1 = None

        page_strips: list = []   # list of PNG bytes, one per page
        for page_idx in range(num_pages):
            page = doc.load_page(page_idx)
            page_width = page.rect.width

            if col_x0 is None:
                col_x0, col_x1 = _find_name_col_x(azure_result, page_width)

            dpi   = 300
            scale = dpi / 72
            mat   = fitz.Matrix(scale, scale)
            clip  = fitz.Rect(
                max(0, col_x0 - 10),
                0,
                min(page.rect.width, col_x1 + 10),
                page.rect.height,
            )
            pix = page.get_pixmap(matrix=mat, clip=clip, colorspace=fitz.csRGB)
            page_strips.append(pix.tobytes("png"))

        doc.close()

        if not page_strips:
            return []

    except Exception as e:
        logger.warning(f"[OCRQuality/L5] PDF rendering failed: {e}")
        return []

    # ── One Gemini call per page, then concatenate ─────────────────────────────
    all_names: list = []
    for page_idx, strip_bytes in enumerate(page_strips):
        try:
            response = client.models.generate_content(
                model=_model_name(),
                contents=[
                    genai_types.Part.from_bytes(data=strip_bytes, mime_type="image/png"),
                    _NAME_COL_PROMPT,
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0.0,
                    max_output_tokens=2048,
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                ),
            )
            raw_text = response.text or ""
            logger.debug(
                f"[OCRQuality/L5] Page {page_idx+1} name-column raw:\n{raw_text[:300]}"
            )
            page_names = _parse_numbered_names(raw_text, expected=0)
            all_names.extend(page_names)
        except Exception as e:
            logger.warning(
                f"[OCRQuality/L5] Gemini name-column call failed (page {page_idx+1}): {e}"
            )
            # Keep a None placeholder so row offsets stay correct
            all_names.append(None)

    # Strip trailing gender/status tokens that bleed in from adjacent column
    _GENDER_TOKENS = frozenset({
        'أنثى', 'انثى', 'ذكر', 'أ', 'م', 'female', 'male', 'f', 'm',
        'أنثي', 'انثي', 'ذكـر',
    })
    cleaned: list = []
    for name in all_names:
        if name:
            tokens = name.split()
            while tokens and tokens[-1] in _GENDER_TOKENS:
                tokens.pop()
            name = " ".join(tokens) if tokens else None
        cleaned.append(name)

    valid = sum(1 for n in cleaned if n)
    logger.info(
        f"[OCRQuality/L5] extract_name_column_ocr: {valid}/{len(cleaned)} names "
        f"from {len(page_strips)} page(s)"
    )
    return cleaned


# ── Token-level voting helpers ─────────────────────────────────────────────────

# Compound-name prefixes: treated as ONE name token together with the next word.
# e.g. "عبد الرحمن" → one token, not two.
_COMPOUND_PREFIXES = frozenset({
    'عبد', 'أبو', 'ابو', 'أم', 'ام', 'بنت', 'آل', 'ال', 'أبي', 'ابي',
})


def _norm_ar(text: str) -> str:
    """Normalize Arabic text for comparison (hamza, alef, yeh, teh marbuta, diacritics)."""
    import re as _re
    if not text:
        return ""
    text = _re.sub(r'[\u064B-\u065F\u0670]', '', text)   # strip harakat
    text = _re.sub(r'[أإآٱ]', 'ا', text)                  # alef variants → ا
    text = _re.sub(r'[يىئ]', 'ي', text)                   # yeh variants  → ي
    text = text.replace('ة', 'ه')                           # teh marbuta  → heh
    return text.strip()


def _split_name_tokens(name: str) -> list:
    """Split an Arabic name into positional tokens, merging compound prefixes.

    'عبد الرحمن حسين محمود عاشور'
    → ['عبد الرحمن', 'حسين', 'محمود', 'عاشور']
    """
    if not name:
        return []
    parts = name.split()
    tokens: list = []
    i = 0
    while i < len(parts):
        if parts[i] in _COMPOUND_PREFIXES and i + 1 < len(parts):
            tokens.append(parts[i] + ' ' + parts[i + 1])
            i += 2
        else:
            tokens.append(parts[i])
            i += 1
    return tokens


def _vote_name_tokens(readings: list) -> dict:
    """Vote on each token position across up to 4 OCR readings.

    Returns a dict with one entry per position:
      {
        pos: {
          "winner":  str,   # winning token (original form)
          "votes":   int,   # number of sources that agreed
          "total":   int,   # number of sources that had a value at this pos
          "options": dict,  # {norm: count} for all options
          "stable":  bool,  # True when ≥ 2 sources agree (locked, no judge needed)
        }
      }

    Alignment strategy:
      - Position 0  : given name (aligned from the start)
      - Position -1 : family name (aligned from the end)
      - Middle positions: aligned from the start after fixing the family name
    This handles readings with different token counts gracefully.
    """
    from collections import Counter

    tokenized = [_split_name_tokens(r) for r in readings if r and r.strip()]
    if not tokenized:
        return {}

    # Reference length = most common name length
    lengths = Counter(len(t) for t in tokenized)
    ref_len = lengths.most_common(1)[0][0]
    if ref_len == 0:
        return {}

    result: dict = {}

    for pos in range(ref_len):
        tokens_at_pos: list = []
        for t in tokenized:
            tlen = len(t)
            if tlen == ref_len:
                # Exact match — direct index
                tokens_at_pos.append(t[pos])
            elif tlen > ref_len:
                # Longer reading — skip (can't align reliably)
                pass
            else:
                # Shorter reading — align family name from the end
                # pos == ref_len-1  → family name → map to t[-1]
                # other positions   → map directly if they exist
                if pos == ref_len - 1 and tlen >= 1:
                    tokens_at_pos.append(t[-1])
                elif pos < tlen - 1:
                    tokens_at_pos.append(t[pos])
                # else: position doesn't exist in this shorter reading → skip

        if not tokens_at_pos:
            continue

        # Build normalized counter, keeping original forms
        norm_counter: Counter = Counter()
        norm_to_orig: dict = {}
        for tok in tokens_at_pos:
            n = _norm_ar(tok)
            norm_counter[n] += 1
            # Keep the shortest/cleanest original form for each normalized key
            if n not in norm_to_orig or len(tok) < len(norm_to_orig[n]):
                norm_to_orig[n] = tok

        winner_norm, vote_count = norm_counter.most_common(1)[0]
        result[pos] = {
            "winner":  norm_to_orig[winner_norm],
            "votes":   vote_count,
            "total":   len(tokens_at_pos),
            "options": {norm_to_orig[k]: v for k, v in norm_counter.items()},
            "stable":  vote_count >= 2,
        }

    return result


def reconcile_multi_ocr_names(
    structured_data: list,
    name_col_ocr: list,
    gemini_raw_names: dict,
    azure_raw_names: dict,
    name_col_key: str = "",
) -> list:
    """Fuse four OCR readings per row using token-level majority voting.

    Phase 1 — deterministic vote (free, no API):
      Split each reading into name tokens.  Vote per position.
      If ≥ 2 sources agree on every token → assemble final name, done.

    Phase 2 — Gemini judge (only for rows with at least one unclear token):
      Batch all unclear rows into ONE Gemini call.
      The prompt includes which tokens are already stable so Gemini
      cannot change them — only fixes the uncertain positions.

    structured_data:  list of row dicts (from Stage 4)
    name_col_ocr:     list[str|None] from extract_name_column_ocr (Stage 3.9)
    gemini_raw_names: {row_idx: name_str} from Gemini OCR pipe text
    azure_raw_names:  {row_idx: name_str} from Azure OCR pipe text
    name_col_key:     override name column key (auto-detect if "")
    """
    if not structured_data:
        return structured_data

    import re, json as _json, pathlib

    # ── Find name column ───────────────────────────────────────────────────────
    if not name_col_key:
        _name_pat = re.compile(r'اسم', re.UNICODE)
        name_col_key = next(
            (k for k in (structured_data[0] or {}).keys() if _name_pat.search(k)),
            None,
        )
    if not name_col_key:
        logger.warning("[OCRQuality/L5] reconcile_multi_ocr_names: no name column found")
        return structured_data

    # ── Load all three dictionaries ────────────────────────────────────────────
    _data_dir = pathlib.Path(__file__).parent / "data"

    def _load_dict(filename: str) -> list:
        try:
            return _json.loads((_data_dir / filename).read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning(f"[OCRQuality/L5] Could not load {filename}: {exc}")
            return []

    family_names  = _load_dict("arabic_family_names.json")
    male_names    = _load_dict("arabic_names_male.json")
    female_names  = _load_dict("arabic_names_female.json")

    # Pre-normalise each dict once — reused every row
    norm_family = [_norm_ar(n) for n in family_names]
    norm_male   = [_norm_ar(n) for n in male_names]
    norm_female = [_norm_ar(n) for n in female_names]
    # Position 0 (first name) — gender unknown → check both
    norm_given  = norm_female + norm_male

    def _family_candidates(name: str, n: int = 3) -> list:
        if not name or not family_names:
            return []
        last = name.split()[-1] if name.split() else ""
        return difflib.get_close_matches(last, family_names, n=n, cutoff=0.55) if last else []

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 1 — Token-level majority vote (deterministic, free)
    # ══════════════════════════════════════════════════════════════════════════
    vote_stable_count  = 0   # rows resolved by vote alone
    judge_payload: list = []  # rows that still need Gemini

    for i, row in enumerate(structured_data):
        structured_name = str(row.get(name_col_key) or "").strip()
        col_ocr_name    = (name_col_ocr[i] if i < len(name_col_ocr) else None) or ""
        gem_raw         = str(gemini_raw_names.get(i) or "").strip()
        az_raw          = str(azure_raw_names.get(i) or "").strip()

        # Priority order: col_ocr first (most focused), then azure, gemini, structured
        readings = [r for r in [col_ocr_name, az_raw, gem_raw, structured_name] if r]
        if not readings:
            continue

        # Quick path: all readings identical
        if len(set(_norm_ar(r) for r in readings)) == 1:
            # Use the col_ocr form (best source) if available, else structured
            row[name_col_key] = col_ocr_name or structured_name
            vote_stable_count += 1
            continue

        # Vote per token position
        vote = _vote_name_tokens(readings)
        if not vote:
            continue

        all_stable = all(v["stable"] for v in vote.values())

        # ── Phase 1b — Per-position dictionary resolution (free, no API) ─────────
        # Position mapping for a 4-token Arabic name:
        #   0         → first name    → arabic_names_male.json + arabic_names_female.json
        #   1         → father name   → arabic_names_male.json
        #   2         → grandfather   → arabic_names_male.json
        #   last pos  → family name   → arabic_family_names.json
        #
        # Rules per position:
        #   - Unstable token: check dict at threshold 0.80 — if one option matches,
        #     promote it to stable (no Gemini needed for this token).
        #   - Stable token at last pos (family name): dict is authoritative — override
        #     even a voted winner if another option matches better at 0.85.
        #   - Stable tokens at positions 0-2: trust the vote, skip dict check.
        last_pos = max(vote.keys()) if vote else -1

        def _pick_from_dict(candidates: list, norm_dict: list, threshold: float):
            """Return (best_token, best_score) from candidates vs normalised dict."""
            best_match, best_score = None, 0.0
            for tok in candidates:
                norm_tok = _norm_ar(tok)
                hits = difflib.get_close_matches(norm_tok, norm_dict, n=1, cutoff=threshold)
                if hits:
                    score = difflib.SequenceMatcher(None, norm_tok, hits[0]).ratio()
                    if score > best_score:
                        best_score, best_match = score, tok
            return best_match, best_score

        any_dict_loaded = family_names or male_names or female_names
        if any_dict_loaded:
            for p, v in vote.items():
                is_last = (p == last_pos)

                # Choose which dict and threshold based on position
                if is_last:
                    norm_dict  = norm_family
                    threshold  = 0.85   # family dict is authoritative — allow override
                elif p == 0:
                    norm_dict  = norm_given
                    threshold  = 0.78   # large dict, be slightly cautious
                else:
                    # positions 1, 2 → father / grandfather — always male
                    norm_dict  = norm_male
                    threshold  = 0.80

                if not norm_dict:
                    continue

                # Stable non-last positions: trust the vote — skip dict check
                if v["stable"] and not is_last:
                    continue

                # Build candidate list: all vote options; for stable last pos also include winner
                candidates = list(v["options"].keys())
                if v["stable"] and v["winner"] not in candidates:
                    candidates = [v["winner"]] + candidates

                best_match, best_score = _pick_from_dict(candidates, norm_dict, threshold)

                if best_match and best_score >= threshold:
                    old_winner = v["winner"]
                    vote[p]["winner"] = best_match
                    vote[p]["stable"] = True
                    if best_match != old_winner:
                        pos_label = {0: "first", 1: "father", 2: "grandfather"}.get(p, "family")
                        logger.info(
                            f"[OCRQuality/L5] Row {i} pos {p} ({pos_label}): "
                            f"dict {'override' if v['stable'] else 'resolved'} "
                            f"{old_winner!r} → {best_match!r} (score={best_score:.2f})"
                        )

            # Re-check stability after dict pass
            all_stable = all(v["stable"] for v in vote.values())

        assembled       = " ".join(vote[p]["winner"] for p in sorted(vote))

        if all_stable:
            # Every token has majority (vote or dict) — apply directly
            old = row.get(name_col_key, "")
            row[name_col_key] = assembled
            if assembled != old:
                logger.info(
                    f"[OCRQuality/L5] Row {i} stable: {old!r} → {assembled!r}"
                )
            vote_stable_count += 1
        else:
            # At least one token still unclear after vote + dict → Gemini judge
            token_desc: list = []
            for p in sorted(vote):
                v = vote[p]
                if v["stable"]:
                    token_desc.append({
                        "pos":    p,
                        "value":  v["winner"],
                        "locked": True,
                        "votes":  v["votes"],
                    })
                else:
                    token_desc.append({
                        "pos":     p,
                        "locked":  False,
                        "options": v["options"],   # {token: vote_count}
                    })

            judge_payload.append({
                "row":               i,
                "partial":           assembled,
                "token_votes":       token_desc,
                "readings":          {
                    "col_ocr":    col_ocr_name,
                    "azure":      az_raw,
                    "gemini":     gem_raw,
                    "structured": structured_name,
                },
                "family_candidates": _family_candidates(col_ocr_name or structured_name),
            })

    logger.info(
        f"[OCRQuality/L5] Phase 1 vote: {vote_stable_count} row(s) stable, "
        f"{len(judge_payload)} row(s) need judge"
    )

    if not judge_payload:
        return structured_data

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 2 — Gemini judge for rows with unclear tokens (one batch call)
    # ══════════════════════════════════════════════════════════════════════════
    _JUDGE_PROMPT_PREFIX = """\
أنت محكّم دقة لأسماء عربية رباعية مكتوبة بخط اليد.

لكل صف أدناه:
- token_votes: نتيجة التصويت لكل موقع في الاسم
  - locked=true  → هذا الجزء مؤكد (صوّت له ≥ مصدران) — لا تغيّره إطلاقاً
  - locked=false → هذا الجزء غير مؤكد — اختر أفضل قيمة من options أو من readings
- readings: القراءات الأربعة الخام (col_ocr الأدق، ثم azure، gemini، structured)
- family_candidates: أقرب أسماء عائلات من القاموس (للمواضع غير المؤكدة فقط)

قواعد صارمة:
1. لا تغيّر أي موقع locked=true — هذه قيمة مؤكدة رياضياً
2. للمواضع locked=false: اختر من options مع الاستعانة بـ readings وfamily_candidates
3. أعد JSON مصفوفة فقط — لا شرح

الشكل:
[{"row": 0, "name": "الاسم الرباعي الكامل"}, ...]

البيانات:
"""

    try:
        client, genai_types = _gemini_client()
    except Exception as e:
        logger.warning(f"[OCRQuality/L5] No Gemini client for judge: {e}")
        return structured_data

    prompt = _JUDGE_PROMPT_PREFIX + _json.dumps(judge_payload, ensure_ascii=False, indent=2)

    try:
        response = client.models.generate_content(
            model=_model_name(),
            contents=[prompt],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
                max_output_tokens=8192,
                thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            ),
        )
        raw = (response.text or "").strip()
        logger.debug(f"[OCRQuality/L5] Judge response:\n{raw[:600]}")

        raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.MULTILINE)
        raw = re.sub(r'\s*```$',          '', raw, flags=re.MULTILINE)
        corrections: list = _json.loads(raw.strip())

        corrected = 0
        for item in corrections:
            row_idx  = item.get("row")
            new_name = (item.get("name") or "").strip()
            if row_idx is None or not new_name:
                continue
            if 0 <= row_idx < len(structured_data):
                old_name = structured_data[row_idx].get(name_col_key, "")

                # Safety: verify judge didn't change any LOCKED token
                # Re-vote the corrected name against the original locked tokens
                orig_vote = _vote_name_tokens(
                    [r["readings"]["col_ocr"] or r["readings"]["structured"]
                     for r in judge_payload if r["row"] == row_idx]
                )
                locked_violations = 0
                new_tokens = _split_name_tokens(new_name)
                for p_info in next(
                    (r["token_votes"] for r in judge_payload if r["row"] == row_idx), []
                ):
                    if p_info.get("locked") and p_info["pos"] < len(new_tokens):
                        expected = _norm_ar(p_info["value"])
                        got      = _norm_ar(new_tokens[p_info["pos"]])
                        if expected != got:
                            locked_violations += 1

                if locked_violations:
                    logger.warning(
                        f"[OCRQuality/L5] Row {row_idx}: judge violated {locked_violations} "
                        f"locked token(s) — keeping vote result instead"
                    )
                    # Revert to the voted partial assembly
                    new_name = next(
                        (r["partial"] for r in judge_payload if r["row"] == row_idx),
                        old_name,
                    )

                if old_name != new_name:
                    structured_data[row_idx][name_col_key] = new_name
                    corrected += 1
                    logger.info(
                        f"[OCRQuality/L5] Row {row_idx} judge: {old_name!r} → {new_name!r}"
                    )

        logger.info(
            f"[OCRQuality/L5] Phase 2 judge: {corrected} correction(s) applied "
            f"({len(judge_payload)} rows sent)"
        )

    except Exception as e:
        logger.warning(f"[OCRQuality/L5] Judge call failed: {e}")

    return structured_data
