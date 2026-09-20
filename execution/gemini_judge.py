"""
Gemini Judge — Cell-Level Image Crop Reviewer.

Called "Gemini Round 2" (and this file gemini_cell_review.py) until 2026-09-10.
Always on: there is deliberately no switch to turn it off.

After the Round 1 spatial vote (Layout + Vision + Azure Read), some cells
remain unresolved: all three engines disagreed, and no candidate scored well
in the Arabic-names dictionary.  For those cells this module:

1. Crops the cell region from the PDF page (using its Azure Layout polygon)
2. Sends the crop to Gemini with the three Round-1 candidates as context
3. Replaces the cell text with Gemini's visual reading

Gemini only ever sees one cell at a time — no table-wide re-serialization —
so there is zero alignment or row-shifting risk.
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
import re
import time

logger = logging.getLogger(__name__)


# ── Crop helper (reused pattern from ocr_quality.py) ─────────────────────────

def _crop_cell_from_pdf(
    pdf_bytes: bytes,
    page_number: int,      # 1-based (Azure convention)
    polygon: list[float],  # 8 floats in inches
    dpi: int = 400,
    margin_in: float = 0.08,
) -> bytes | None:
    """Crop a cell's bounding rect from the PDF page, return PNG bytes."""
    if not polygon or len(polygon) < 8:
        return None
    try:
        import fitz
    except ImportError:
        logger.warning("[GeminiJudge] PyMuPDF not installed")
        return None

    xs = polygon[0::2]
    ys = polygon[1::2]
    x0_in, y0_in = min(xs), min(ys)
    x1_in, y1_in = max(xs), max(ys)

    # Expand by margin (still in inches)
    x0_in = max(0.0, x0_in - margin_in)
    y0_in = max(0.0, y0_in - margin_in)
    x1_in += margin_in
    y1_in += margin_in

    try:
        doc  = fitz.open(stream=pdf_bytes, filetype="pdf")
        page = doc.load_page(page_number - 1)   # PyMuPDF is 0-based

        # PDF points: 72 per inch
        rect = fitz.Rect(
            x0_in * 72,
            y0_in * 72,
            min(page.rect.width,  x1_in * 72),
            min(page.rect.height, y1_in * 72),
        )
        if rect.width < 4 or rect.height < 3:
            doc.close()
            return None

        scale = dpi / 72.0
        mat   = fitz.Matrix(scale, scale)
        pix   = page.get_pixmap(matrix=mat, clip=rect, colorspace=fitz.csRGB)
        png   = pix.tobytes("png")
        doc.close()
        return png
    except Exception as e:
        logger.warning(f"[GeminiJudge] Crop failed page={page_number}: {e}")
        return None


# ── Gemini per-cell review ───────────────────────────────────────────────────

_PROMPT_TEMPLATE = """You are reading a single cell cropped from an Arabic registration form.

OCR engines read this cell and disagreed:
  Azure Layout:  "{layout}"
  Google Vision: "{vision}"
  Azure Read:    "{azure_read}"
  Gemini OCR:    "{gemini_ocr}"

Look at the image and decide which reading is correct, OR provide a better
reading if all are wrong.

Rules:
  • Reply with ONLY the final text. No explanations, no quotes, no prefix.
  • Use standard Arabic forms (ا not أ/إ/آ unless the image clearly shows them).
  • If the cell is empty or unreadable, reply exactly: EMPTY
  • Do not guess — only use what you can clearly see in the image.
"""


# Returned by _read_cell when the ENGINE produced nothing -- a rate limit, a
# dropped connection, a blocked key. Distinct from a reply we chose not to use.
_ENGINE_FAILED = object()


def _review_one_cell(client, model_name, genai_types, cell: dict, crop_png: bytes) -> str | None:
    """Send one cell crop to Gemini and return its reading (or None on error)."""
    out = _read_cell(client, model_name, genai_types, cell, crop_png)
    return None if out is _ENGINE_FAILED else out


def _read_cell(client, model_name, genai_types, cell: dict, crop_png: bytes):
    """
    One cell, retrying the failures that clear on their own.

    Returns the reading, "" for a cell Gemini reports EMPTY, None for a reply
    that is unusable (blank or off-script), or _ENGINE_FAILED when no answer
    came back at all.

    This used to try once and swallow any exception at DEBUG level, so a rate
    limit or a dropped connection quietly left the cell with its Round-1 value
    and nothing in the log said a review had been skipped. At 4 requests at a
    time that was rare; at 8 a 429 is likelier, and silently losing reviews
    would trade accuracy for speed. Now a rate limit or network error is retried,
    and only a failure that will answer the same way next time -- a bad key, a
    blocked project, a monthly spend cap -- gives up at once. A reply that came
    back is never re-asked, so retrying cannot fish for a different answer: it
    only recovers cells that got none.
    """
    prompt = _PROMPT_TEMPLATE.format(
        layout=cell.get("layout") or "—",
        vision=cell.get("vision") or "—",
        azure_read=cell.get("azure_read") or "—",
        gemini_ocr=cell.get("gemini_ocr") or "—",
    )
    last_err = None
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_bytes(data=crop_png, mime_type="image/png"),
                    prompt,
                ],
                config=genai_types.GenerateContentConfig(temperature=0.1),
            )
        except Exception as e:
            last_err = e
            code = getattr(e, "code", None)
            msg = str(e).lower()
            spend_cap = "spend" in msg or "exceeded its monthly" in msg
            permanent = spend_cap or (isinstance(code, int) and 400 <= code < 500 and code != 429)
            if permanent or attempt == 2:
                break
            time.sleep(1.5 * (attempt + 1))
            continue

        try:
            raw = (response.text or "").strip()
        except Exception as e:
            logger.debug(f"[GeminiJudge] Unreadable response object: {e}")
            return None
        if not raw:
            return None
        # Strip markdown/quotes Gemini sometimes adds
        raw = raw.strip('"\'`').strip()
        if raw.upper() == "EMPTY":
            return ""
        # Sanity: reject multi-line or very long replies (model went off-script)
        if "\n" in raw or len(raw) > 200:
            logger.debug(f"[GeminiJudge] Rejected verbose reply: {raw[:80]!r}")
            return None
        return raw

    logger.warning(f"[GeminiJudge] cell ({cell.get('row')},{cell.get('col')}) got no reading "
                   f"after retries: {last_err}")
    return _ENGINE_FAILED


# ── Main entry point ─────────────────────────────────────────────────────────

def review_low_confidence_cells(
    layout_result: dict,
    pdf_bytes: bytes,
    max_cells: int = 30,
    max_workers: int | None = None,
    gemini_raw_names: dict | None = None,
) -> dict:
    """
    Run Gemini visual review on low-confidence cells flagged by spatial_vote_layout.

    Modifies layout_result tables in-place: updates headers/rows with Gemini's
    readings when they differ from the Round-1 winners.  Returns layout_result.

    When gemini_raw_names is provided (row_idx → name), attaches the Gemini OCR
    candidate to each cell so the Gemini Judge prompt can show 4 candidates instead
    of 3. Assumes layout row r (r ≥ 1) maps to gemini row (r - 1).
    """
    low_cells = layout_result.get("_low_confidence_cells") or []
    if low_cells and gemini_raw_names:
        for cell in low_cells:
            r = cell.get("row", 0)
            if r >= 1:
                cell["gemini_ocr"] = gemini_raw_names.get(r - 1, "")
    tables = layout_result.get("tables") or []
    if not low_cells or not tables:
        logger.info("[GeminiJudge] No low-confidence cells to review")
        return layout_result

    if not os.getenv("GEMINI_API_KEY"):
        logger.warning("[GeminiJudge] GEMINI_API_KEY not set — skipping")
        return layout_result

    # Cap the number of cells reviewed per document (cost / latency safety)
    if len(low_cells) > max_cells:
        logger.info(f"[GeminiJudge] Capping review: {len(low_cells)} → {max_cells} cells")
        low_cells = low_cells[:max_cells]

    # Gemini client (one instance reused across cells)
    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError:
        logger.warning("[GeminiJudge] google-genai not installed — skipping")
        return layout_result

    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    model_name = os.getenv("GEMINI_MODEL", "gemini-3.7-flash")

    start = time.time()
    updated = 0
    reviewed = 0

    # Crop all cells upfront (local, fast)
    crops: list[tuple[dict, bytes]] = []
    for cell in low_cells:
        png = _crop_cell_from_pdf(pdf_bytes, cell["page"], cell["polygon"])
        if png:
            crops.append((cell, png))

    if not crops:
        logger.info("[GeminiJudge] No cells could be cropped — skipping")
        return layout_result

    # Parallel Gemini calls, 8 at a time (was 4). Each call is ~9.5s and the cells
    # are independent -- one crop, one prompt built from that cell's own
    # candidates, and every write below lands on a different (table, row, col) --
    # so pool width changes how long the stage takes, not what any cell reads.
    # The retry in _read_cell is what stops the wider pool from costing reviews.
    workers = max_workers or max(1, int(os.getenv("GEMINI_JUDGE_WORKERS", "8")))

    def _task(pair):
        cell, png = pair
        return cell, _read_cell(client, model_name, genai_types, cell, png)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(_task, crops))

    failed = sum(1 for _, t in results if t is _ENGINE_FAILED)

    # Apply updates to the tables
    for cell, gemini_text in results:
        reviewed += 1
        if gemini_text is None or gemini_text is _ENGINE_FAILED:
            continue
        t_idx = cell["table_idx"]
        r = cell["row"]
        c = cell["col"]
        if t_idx >= len(tables):
            continue
        table = tables[t_idx]

        # Row 0 = headers; rows are rows[r-1] in table["rows"]
        if r == 0:
            if c < len(table["headers"]):
                old = table["headers"][c]
                if gemini_text and gemini_text != old:
                    table["headers"][c] = gemini_text
                    updated += 1
                    logger.debug(f"[GeminiJudge] header ({r},{c}) «{old}» → «{gemini_text}»")
            continue

        row_data = table["rows"][r - 1] if (r - 1) < len(table["rows"]) else None
        if row_data is None or c >= len(row_data):
            continue

        old_val = row_data[c]
        new_val = gemini_text if gemini_text else None
        if new_val != old_val:
            row_data[c] = new_val
            updated += 1
            logger.info(
                f"[GeminiJudge] ({r},{c}) «{old_val}» → «{new_val}» | "
                f"vote_winner=«{cell.get('winner')}» method={cell.get('method')}"
            )

    elapsed = round(time.time() - start, 2)
    # `failed` is the number that matters for accuracy: cells that got no reading
    # at all. It should be 0 -- anything else means reviews were lost.
    logger.info(
        f"[GeminiJudge] Done | reviewed={reviewed}/{len(low_cells)} | updated={updated} | "
        f"failed={failed} | workers={workers} | elapsed={elapsed}s"
    )
    return layout_result
