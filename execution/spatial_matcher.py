"""
Spatial Matcher — maps OCR words to Azure Layout cells via bounding-box overlap.

Given Azure Layout's table grid (with cell polygons) and per-page word lists
from Vision and Azure Read (each with word polygons), this module:

1. For each cell in the Layout grid, finds words from Vision and Azure Read
   whose center point falls inside the cell's bounding box.
2. Reconstructs per-cell text from the matched words.
3. Votes on each cell: Layout text vs Vision text vs Azure Read text.
4. Returns the layout_result with improved cell text.

Coordinate systems:
    Azure Layout cells:  polygon in inches (from Azure DI)
    Azure Read words:    polygon in inches (same API)
    Vision words:        polygon in pixels → scaled to inches via page dimensions
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)


# ── Geometry helpers ─────────────────────────────────────────────────────────

def _poly_to_bbox(polygon: list[float]) -> tuple[float, float, float, float]:
    """Flat polygon [x1,y1,x2,y2,...] → (min_x, min_y, max_x, max_y)."""
    if len(polygon) < 4:
        return (0.0, 0.0, 0.0, 0.0)
    xs = polygon[0::2]
    ys = polygon[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def _point_in_bbox(
    px: float, py: float,
    bbox: tuple[float, float, float, float],
    margin: float = 0.0,
) -> bool:
    """Check if (px, py) falls inside bbox ± margin."""
    return (bbox[0] - margin <= px <= bbox[2] + margin and
            bbox[1] - margin <= py <= bbox[3] + margin)


# ── Word → cell matching ────────────────────────────────────────────────────

def _match_words_to_cells(
    cell_polygons: list[dict],
    words: list[dict],
    page_number: int,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    margin: float = 0.04,
) -> dict[tuple[int, int], str]:
    """
    For each cell on *page_number*, find words whose center falls inside.

    Args:
        cell_polygons:  [{row, col, polygon, page}, ...]
        words:          [{content, polygon, ...}, ...]  (polygon in source coords)
        page_number:    which page to process
        scale_x/y:      multiply word coords to convert to cell coordinate system
        margin:         expand cell bbox by this many inches to catch edge words

    Returns:
        {(row, col): "matched text"}
    """
    page_cells = [c for c in cell_polygons if c.get("page") == page_number]
    if not page_cells:
        return {}

    # Pre-compute cell bounding boxes
    cell_bboxes: list[tuple[int, int, tuple[float, float, float, float]]] = []
    for cell in page_cells:
        poly = cell.get("polygon") or []
        if len(poly) >= 6:
            bbox = _poly_to_bbox(poly)
            cell_bboxes.append((cell["row"], cell["col"], bbox))

    if not cell_bboxes:
        return {}

    # Map each word to its cell
    cell_words: dict[tuple[int, int], list[tuple[int, str]]] = {}
    for word_idx, word in enumerate(words):
        poly = word.get("polygon") or []
        if len(poly) < 4:
            continue
        content = (word.get("content") or "").strip()
        if not content:
            continue

        # Word center in cell (Azure) coordinate system
        xs = poly[0::2]
        ys = poly[1::2]
        cx = (sum(xs) / len(xs)) * scale_x
        cy = (sum(ys) / len(ys)) * scale_y

        for row, col, bbox in cell_bboxes:
            if _point_in_bbox(cx, cy, bbox, margin):
                key = (row, col)
                if key not in cell_words:
                    cell_words[key] = []
                cell_words[key].append((word_idx, content))
                break  # word belongs to at most one cell

    # Reconstruct text per cell, preserving OCR reading order
    result: dict[tuple[int, int], str] = {}
    for key, wlist in cell_words.items():
        wlist.sort(key=lambda w: w[0])
        result[key] = " ".join(w[1] for w in wlist)

    return result


# ── Arabic helpers ───────────────────────────────────────────────────────────

_AR_RE = re.compile(r"[\u0600-\u06FF]")
_DIACRITICS = re.compile(r"[\u064B-\u065F\u0670]")
_ALEF_VARS  = re.compile(r"[أإآٱ]")


def _norm(s: str) -> str:
    """Quick Arabic normalisation for comparison."""
    s = _DIACRITICS.sub("", s)
    s = _ALEF_VARS.sub("ا", s)
    return " ".join(s.split()).strip()


def _is_arabic(text: str) -> bool:
    """True if text is predominantly Arabic characters."""
    if not text:
        return False
    no_sp = text.replace(" ", "")
    if not no_sp:
        return False
    return len(_AR_RE.findall(no_sp)) / len(no_sp) > 0.5


# ── Per-cell voting ─────────────────────────────────────────────────────────

def _vote_cell(layout: str, vision: str, azure_read: str) -> tuple[str, str]:
    """
    Vote on the best text for a single cell.

    Returns (winner_text, method_label).

    Priority when tied:  layout > azure_read > vision
    Tiebreaker when all differ:  dict_score (name cells) or layout (other cells)
    """
    cands = {}
    if layout:
        cands["layout"] = layout
    if vision:
        cands["vision"] = vision
    if azure_read:
        cands["azure_read"] = azure_read

    if not cands:
        return "", "empty"
    if len(cands) == 1:
        k = next(iter(cands))
        return cands[k], f"single_{k}"

    # --- Layout empty, pick from remaining ---
    if not layout:
        vals = list(cands.values())
        if len(vals) == 2 and _norm(vals[0]) == _norm(vals[1]):
            # Both non-layout agree
            return cands.get("azure_read", vals[0]), "fill_agree"
        if len(vals) == 1:
            return vals[0], "fill_single"
        # Pick by dict_score
        from execution.ocr_voter import dict_score
        best = max(cands.items(), key=lambda kv: dict_score(kv[1]))
        return best[1], "fill_score"

    # --- Normalise for comparison ---
    norms = {k: _norm(v) for k, v in cands.items()}

    # All agree
    if len(set(norms.values())) == 1:
        return layout, "unanimous"

    # 2 of 3 agree (only possible with 3 candidates)
    if len(cands) == 3:
        # Check vision+azure_read agreement FIRST. When the two independent
        # text-OCR engines agree with each other but disagree with Layout,
        # they outvote Layout — Layout's text is just one reading of the cell,
        # vision+azure_read agreeing is two independent readings.
        if norms.get("vision") == norms.get("azure_read"):
            return cands["azure_read"], "majority_vision+azure_read"
        # Otherwise prefer the pair containing layout.
        if norms.get("layout") == norms.get("azure_read"):
            return cands["layout"], "majority_layout+azure_read"
        if norms.get("layout") == norms.get("vision"):
            return cands["layout"], "majority_layout+vision"

    # 2 candidates, disagree
    if len(cands) == 2:
        keys = list(cands.keys())
        # Two disagree — for Arabic text use dict_score, else keep layout
        if _is_arabic(layout):
            from execution.ocr_voter import dict_score
            scores = {k: dict_score(v) for k, v in cands.items()}
            best_k = max(scores, key=lambda k: scores[k])
            if scores[best_k] > 0:
                return cands[best_k], f"score_{best_k}"
        return layout, "layout_default"

    # All 3 differ — tiebreaker
    if _is_arabic(layout):
        from execution.ocr_voter import dict_score
        scores = {k: dict_score(v) for k, v in cands.items()}
        best_k = max(scores, key=lambda k: scores[k])
        if scores[best_k] > 0:
            return cands[best_k], f"score_{best_k}"

    return layout, "layout_default"


# ── Main entry point ─────────────────────────────────────────────────────────

def spatial_vote_layout(
    layout_result: dict,
    vision_result: dict | None,
    azure_read_result: dict | None,
) -> dict:
    """
    Improve Azure Layout cell text via spatial voting with Vision and Azure Read.

    Modifies layout_result tables in-place: headers and rows are updated with
    the voted text.  Returns the same layout_result dict.
    """
    tables = layout_result.get("tables") or []
    if not tables:
        return layout_result

    page_dims = layout_result.get("page_dims") or {}

    # Index Vision pages by page number
    vision_pages: dict[int, dict] = {}
    if vision_result and vision_result.get("success"):
        for vp in (vision_result.get("pages") or []):
            vision_pages[vp["page_number"]] = vp

    # Index Azure Read pages by page number
    azure_read_pages: dict[int, dict] = {}
    if azure_read_result and azure_read_result.get("success"):
        for ap in (azure_read_result.get("pages") or []):
            azure_read_pages[ap["page_number"]] = ap

    if not vision_pages and not azure_read_pages:
        logger.info("[SpatialVoter] No Vision or Azure Read data — skipping")
        return layout_result

    total_cells = 0
    cells_voted = 0
    cells_changed = 0
    method_counts: dict[str, int] = {}
    # Cells that need the Gemini Judge: all engines disagreed or layout-default
    # Each entry: {table_idx, row, col, page, polygon, layout, vision, azure_read, method}
    low_confidence_cells: list[dict] = []

    for _tbl_idx, table in enumerate(tables):
        cell_polygons = table.get("cell_polygons") or []
        if not cell_polygons:
            continue

        row_count = table["row_count"]
        col_count = table["column_count"]

        # Rebuild 2D grid from headers + rows
        grid: list[list[str | None]] = [[None] * col_count for _ in range(row_count)]
        for c, h in enumerate(table["headers"]):
            if c < col_count:
                grid[0][c] = h
        for r_idx, row_data in enumerate(table["rows"], start=1):
            for c, val in enumerate(row_data):
                if r_idx < row_count and c < col_count:
                    grid[r_idx][c] = val

        # Which pages does this table span?
        pages_in_table = sorted(set(c["page"] for c in cell_polygons))

        for page_num in pages_in_table:
            # --- Compute Vision scale ---
            vision_cell_text: dict[tuple[int, int], str] = {}
            vp = vision_pages.get(page_num)
            if vp and vp.get("words"):
                v_w = vp.get("width", 0)
                v_h = vp.get("height", 0)
                # Azure page dimensions (inches) — try layout first, then Azure Read
                az_dims = page_dims.get(page_num) or {}
                az_w = az_dims.get("width", 0.0)
                az_h = az_dims.get("height", 0.0)
                if not az_w:
                    ar_page = azure_read_pages.get(page_num)
                    if ar_page:
                        az_w = ar_page.get("width", 0.0)
                        az_h = ar_page.get("height", 0.0)

                if v_w and az_w:
                    sx = az_w / v_w
                    sy = az_h / v_h if v_h else sx
                else:
                    sx = sy = 1.0 / 144.0  # fallback: 144 DPI

                vision_cell_text = _match_words_to_cells(
                    cell_polygons, vp["words"], page_num,
                    scale_x=sx, scale_y=sy, margin=0.04,
                )

            # --- Azure Read: same coordinate system, no scaling ---
            azure_read_cell_text: dict[tuple[int, int], str] = {}
            ar_page = azure_read_pages.get(page_num)
            if ar_page and ar_page.get("words"):
                azure_read_cell_text = _match_words_to_cells(
                    cell_polygons, ar_page["words"], page_num,
                    scale_x=1.0, scale_y=1.0, margin=0.04,
                )

            # --- Vote per cell on this page ---
            page_cells = [c for c in cell_polygons if c.get("page") == page_num]
            for cell_info in page_cells:
                r = cell_info["row"]
                c = cell_info["col"]
                total_cells += 1

                # Skip header row — keep column headers as-is
                if r == 0:
                    continue

                layout_text = (grid[r][c] or "").strip()
                vis_text    = vision_cell_text.get((r, c), "").strip()
                az_text     = azure_read_cell_text.get((r, c), "").strip()

                if not layout_text and not vis_text and not az_text:
                    continue

                winner, method = _vote_cell(layout_text, vis_text, az_text)
                cells_voted += 1
                method_counts[method] = method_counts.get(method, 0) + 1

                if winner and winner != layout_text:
                    grid[r][c] = winner
                    cells_changed += 1
                    logger.debug(
                        f"[SpatialVoter] ({r},{c}) «{layout_text}» → «{winner}» "
                        f"[{method}] vis=«{vis_text}» az=«{az_text}»"
                    )

                # Flag for the Gemini Judge: all-disagree cases where the cell
                # looks like a name (2+ Arabic words).  Single-word cells (gender,
                # consent marks, signature fragments) are excluded — Gemini can't
                # improve short noise, and the API calls add ~2s each.
                _best_candidate = winner or layout_text or vis_text or az_text
                _is_multiword_arabic = (
                    _is_arabic(_best_candidate) and
                    len([t for t in _best_candidate.split() if _AR_RE.search(t)]) >= 2
                )
                if (method.startswith("score_") or method == "layout_default") and _is_multiword_arabic:
                    low_confidence_cells.append({
                        "table_idx": _tbl_idx,
                        "row": r,
                        "col": c,
                        "page": page_num,
                        "polygon": cell_info.get("polygon") or [],
                        "layout":  layout_text,
                        "vision":  vis_text,
                        "azure_read": az_text,
                        "winner":  winner,
                        "method":  method,
                    })

        # Write voted grid back into table
        table["headers"] = [grid[0][c] or "" for c in range(col_count)]
        table["rows"] = [
            [grid[r][c] for c in range(col_count)]
            for r in range(1, row_count)
        ]

    logger.info(
        f"[SpatialVoter] Done | total_cells={total_cells} | "
        f"voted={cells_voted} | changed={cells_changed} | "
        f"low_conf={len(low_confidence_cells)} | "
        + " ".join(f"{k}={v}" for k, v in sorted(method_counts.items()) if v)
    )
    # Attach low-confidence cells for the Gemini Judge
    layout_result["_low_confidence_cells"] = low_confidence_cells
    return layout_result
