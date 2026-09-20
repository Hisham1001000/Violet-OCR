"""
Tool: extract_azure_layout
Azure Document Intelligence — prebuilt-layout table extractor.

Unlike prebuilt-read (which returns linear text), prebuilt-layout detects
the actual table grid and returns every cell with its exact (row, column)
coordinate.  Empty cells are explicitly present as empty strings — no shifting.

Auth:  AZURE_DI_ENDPOINT + AZURE_DI_KEY environment variables
Model: prebuilt-layout

Return format:
    {
        "success":      bool,
        "tables": [
            {
                "row_count":    int,
                "column_count": int,
                "headers":      [str, ...],          # first row (column headers)
                "rows": [                             # data rows (row 1+)
                    [str | None, ...],                # one list per row, indexed by col
                ],
                "page_number":  int,                 # page where this table starts
            }
        ],
        "full_text":    str,        # plain text fallback (Azure content field)
        "page_count":   int,
        "raw_response": {"model": str, "pages": int},
        "error":        str | None,
        "provider":     "azure_layout",
    }
"""

from __future__ import annotations

import io
import logging
import os
import re

logger = logging.getLogger(__name__)

# Azure Document Intelligence rejects files over its per-file size limit
# (InvalidContentLength — "the input image is too large"; ~4 MB on the F0 tier).
# Many handwritten forms are high-resolution phone scans that exceed it, so we
# re-render oversized PDFs to a smaller size BEFORE sending. Page dimensions (in
# points/inches) are preserved exactly, so Azure's inch-based cell polygons still
# map correctly onto the crop step's render of the original document.
_AZURE_MAX_BYTES = 3_900_000


_SUBHEADER_WORDS_RAW = {
    "من", "الى", "إلى", "from", "to", "start", "end",
    "بداية", "نهاية", "ذهاب", "اياب", "إياب",
}


def _norm_word(v: str) -> str:
    return re.sub(r"[أإآٱ]", "ا", str(v)).replace("ى", "ي").strip().lower()


# Normalised at import, with the SAME transform used on the cells being tested.
# Comparing a normalised cell against a raw set silently never matches: "إلى"
# folds to "الي", which is not the "الى" written here.
_SUBHEADER_WORDS = {_norm_word(w) for w in _SUBHEADER_WORDS_RAW}


def _is_subheader_row(values) -> bool:
    """
    True when a row is the second line of a split header, not a person.

    Deliberately narrow: every non-empty cell must be a known header word, and
    the row must carry no digits at all. A real participant row always has a
    name or a number somewhere, so this cannot swallow sparse data.
    """
    vals = [str(v).strip() for v in values if v is not None and str(v).strip()]
    if not vals or len(vals) > 4:
        return False
    if any(any(ch.isdigit() for ch in v) for v in vals):
        return False
    return all(_norm_word(v) in _SUBHEADER_WORDS for v in vals)


def _shrink_pdf_for_azure(data: bytes, source_label: str = "<bytes>") -> bytes:
    """Return PDF bytes under _AZURE_MAX_BYTES, re-rendering pages to JPEG at
    progressively lower DPI/quality if needed. Falls back to the original bytes
    if PyMuPDF is unavailable or the input isn't a PDF."""
    if len(data) <= _AZURE_MAX_BYTES:
        return data
    try:
        import fitz  # PyMuPDF
    except ImportError:
        logger.warning("[AzureLayout] %s | oversized (%d B) but PyMuPDF missing — sending as-is",
                       source_label, len(data))
        return data
    try:
        src = fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        logger.warning("[AzureLayout] %s | oversized (%d B) but not a readable PDF (%s) — sending as-is",
                       source_label, len(data), e)
        return data

    best = data
    for dpi, quality in ((200, 80), (170, 75), (150, 70), (120, 65), (100, 60)):
        try:
            out = fitz.open()
            mat = fitz.Matrix(dpi / 72, dpi / 72)
            for page in src:
                pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
                jpg = pix.tobytes("jpeg", jpg_quality=quality)
                rect = page.rect  # original size in points → preserves inches
                npage = out.new_page(width=rect.width, height=rect.height)
                npage.insert_image(rect, stream=jpg)
            buf = out.tobytes(garbage=4, deflate=True)
            out.close()
        except Exception as e:
            logger.warning("[AzureLayout] %s | shrink attempt dpi=%d failed: %s", source_label, dpi, e)
            continue
        best = buf
        if len(buf) <= _AZURE_MAX_BYTES:
            logger.info("[AzureLayout] %s | shrunk %d B → %d B (dpi=%d, q=%d)",
                        source_label, len(data), len(buf), dpi, quality)
            src.close()
            return buf
    src.close()
    logger.warning("[AzureLayout] %s | could not get under %d B (smallest=%d B) — sending smallest",
                   source_label, _AZURE_MAX_BYTES, len(best))
    return best


def _split_pdf_pages(data: bytes, pages_per_chunk: int = 2) -> list[tuple[int, bytes]]:
    """Split a PDF into consecutive page chunks for separate Azure calls.

    Azure Document Intelligence's F0 (free) tier only analyzes the first 2 pages
    of any single request, so a multi-page roster silently loses every name past
    page 2. Sending the document in ≤2-page chunks works around that. Returns a
    list of (page_offset, chunk_bytes) where page_offset is the 0-based index of
    the chunk's first page in the original document — used to keep page numbers
    globally correct for the cropper. Falls back to a single chunk if PyMuPDF is
    unavailable, the input isn't a PDF, or it already fits in one chunk."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return [(0, data)]
    try:
        src = fitz.open(stream=data, filetype="pdf")
    except Exception:
        return [(0, data)]
    n = src.page_count
    if n <= pages_per_chunk:
        src.close()
        return [(0, data)]
    chunks: list[tuple[int, bytes]] = []
    for start in range(0, n, pages_per_chunk):
        end = min(start + pages_per_chunk, n)
        try:
            dst = fitz.open()
            dst.insert_pdf(src, from_page=start, to_page=end - 1)
            chunks.append((start, dst.tobytes(garbage=4, deflate=True)))
            dst.close()
        except Exception as e:
            logger.warning("[AzureLayout] split failed for pages %d-%d: %s — sending whole", start, end, e)
            src.close()
            return [(0, data)]
    src.close()
    return chunks


def extract_azure_layout(pdf_bytes: bytes, source_label: str = "<bytes>") -> dict:
    """
    Extract table structure from a PDF using Azure Document Intelligence prebuilt-layout.

    Returns a list of tables, each as a dict with:
      - headers:  list of column header strings (from the first row)
      - rows:     list of data rows, each a list of cell values aligned to headers
      - Empty cells are None (not omitted), so column indices never shift.
    """
    endpoint = os.getenv("AZURE_DI_ENDPOINT", "").rstrip("/")
    key      = os.getenv("AZURE_DI_KEY", "")

    if not endpoint or not key:
        return _fail("AZURE_DI_ENDPOINT or AZURE_DI_KEY not set — Azure layout unavailable")

    try:
        from azure.ai.documentintelligence import DocumentIntelligenceClient
        from azure.core.credentials import AzureKeyCredential
    except ImportError:
        return _fail(
            "azure-ai-documentintelligence not installed. "
            "Run: pip install azure-ai-documentintelligence"
        )

    try:
        client = DocumentIntelligenceClient(
            endpoint=endpoint,
            credential=AzureKeyCredential(key),
            # Cap retry backoff. On a throttle Azure can answer 403 with a
            # Retry-After measured in DAYS (observed: 282299 s ~ 78 h); the SDK
            # honours it verbatim and the whole batch silently hangs instead of
            # failing. Bounding the wait turns that into a normal error the
            # caller can retry later.
            retry_total=3,
            retry_backoff_max=60,
        )
    except Exception as e:
        return _fail(f"Azure Document Intelligence client init error: {e}")

    send_bytes = _shrink_pdf_for_azure(pdf_bytes, source_label)

    def _parse_layout_result(result, page_offset: int):
        """Parse one Azure result into (tables, full_text, page_dims, n_pages),
        shifting every page number by page_offset so multi-chunk documents keep
        globally-correct page coordinates for the cropper."""
        # Handwritten character ranges from Azure's style detection — the reliable
        # signal for keeping ONLY handwritten name crops in the training set. A
        # cell is "handwritten" when most of its content span falls inside these.
        _hw_intervals: list[tuple[int, int]] = []
        for _st in (getattr(result, "styles", None) or []):
            if getattr(_st, "is_handwritten", False):
                for _sp in (_st.spans or []):
                    _hw_intervals.append((_sp.offset, _sp.offset + _sp.length))

        def _cell_handwritten(cell) -> bool:
            sps = getattr(cell, "spans", None) or []
            if not sps or not _hw_intervals:
                return False
            best = 0.0
            for s in sps:
                o, e = s.offset, s.offset + s.length
                cov = sum(max(0, min(e, b) - max(o, a)) for a, b in _hw_intervals)
                best = max(best, cov / max(1, e - o))
            return best >= 0.5

        _tables: list[dict] = []
        for table in (result.tables or []):
            row_count = table.row_count or 0
            col_count = table.column_count or 0

            # A table is a table at any size. This used to require two rows,
            # so a sheet holding a header and nothing else, or a single line of
            # data with no header, was dropped and the customer got nothing back
            # for a file that plainly had a table in it.
            if row_count < 1 or col_count < 1:
                continue   # nothing there at all

            # Determine which page this table starts on (global numbering).
            page_number = page_offset + 1
            if table.bounding_regions:
                page_number = page_offset + (table.bounding_regions[0].page_number or 1)

            # Build a 2D grid: grid[row][col] = cell content
            grid: list[list[str | None]] = [
                [None] * col_count for _ in range(row_count)
            ]

            # Capture cell bounding polygons for spatial matching
            cell_polygons: list[dict] = []

            for cell in (table.cells or []):
                r = cell.row_index
                c = cell.column_index
                if r < row_count and c < col_count:
                    content = _clean_cell_text(cell.content)
                    grid[r][c] = content if content else None

                    # Cell bounding polygon (inches) for spatial word matching
                    cell_poly = []
                    cell_page = page_number
                    if cell.bounding_regions:
                        br = cell.bounding_regions[0]
                        cell_poly = list(br.polygon) if br.polygon else []
                        cell_page = page_offset + (br.page_number or 1)
                    cell_polygons.append({
                        "row": r, "col": c,
                        "polygon": cell_poly,
                        "page": cell_page,
                        "handwritten": _cell_handwritten(cell),
                    })

            # Header rows come from Azure's own kind="columnHeader" tag rather
            # than an assumed row 0, and a spanning parent is pushed down onto
            # the columns it covers.
            hdr_rows = _header_row_count(table.cells, row_count)
            paths    = _header_paths(table.cells, hdr_rows, col_count)
            # Flatten to one name per column: structured_data is a flat dict and
            # field_name has to match its keys, so the hierarchy rides along in
            # the name. header_paths keeps the structure for anything that wants
            # to render it as parent/child.
            headers = [_HDR_SEP.join(p) if p else "" for p in paths]

            # Data starts after the header rows -- not always row 1.
            data_rows = []
            for r in range(hdr_rows, row_count):
                data_rows.append([grid[r][c] for c in range(col_count)])

            _tables.append({
                "row_count":    row_count,
                "column_count": col_count,
                "headers":      headers,
                "header_paths": paths,
                "header_row_count": hdr_rows,
                "rows":         data_rows,
                "page_number":  page_number,
                "cell_polygons": cell_polygons,
            })

        _full_text = (result.content or "").strip()
        _page_dims: dict[int, dict] = {}
        for pg in (result.pages or []):
            _page_dims[page_offset + (pg.page_number or 1)] = {
                "width": pg.width or 0.0,
                "height": pg.height or 0.0,
                # Content rotation Azure measured, in degrees, range (-180, 180].
                # ~±180 means the page was scanned upside down. Used downstream by
                # the cropper to flip crops the right way up.
                "angle": pg.angle or 0.0,
            }
        return _tables, _full_text, _page_dims, len(result.pages or [])

    # Split into ≤2-page chunks to beat the F0 free-tier 2-page limit, then
    # analyze each chunk and merge with globally-correct page numbers.
    chunks = _split_pdf_pages(send_bytes, pages_per_chunk=2)

    tables_out: list[dict] = []
    full_text_parts: list[str] = []
    page_dims: dict[int, dict] = {}
    page_count = 0
    for page_offset, chunk_bytes in chunks:
        chunk_bytes = _shrink_pdf_for_azure(chunk_bytes, f"{source_label}#p{page_offset + 1}")
        try:
            poller = client.begin_analyze_document(
                "prebuilt-layout",
                io.BytesIO(chunk_bytes),
                content_type="application/pdf",
            )
            result = poller.result()
        except Exception as e:
            # A single chunk failing must not lose the whole document.
            if len(chunks) == 1:
                return _fail(f"Azure Document Intelligence layout API error: {e}")
            logger.warning("[AzureLayout] %s | chunk at page %d failed: %s — continuing",
                           source_label, page_offset + 1, e)
            continue
        _t, _ft, _pd, _np = _parse_layout_result(result, page_offset)
        tables_out.extend(_t)
        if _ft:
            full_text_parts.append(_ft)
        page_dims.update(_pd)
        page_count += _np

    if page_count == 0 and not tables_out:
        return _fail("Azure Document Intelligence layout API error: all page chunks failed")

    # ── Plain text fallback ──────────────────────────────────────────────────────
    full_text = "\n".join(full_text_parts).strip()

    total_data_rows = sum(len(t["rows"]) for t in tables_out)

    logger.info(
        f"[AzureLayout] Done | source={source_label} | pages={page_count} | "
        f"tables={len(tables_out)} | data_rows={total_data_rows}"
    )

    return {
        "success":      True,
        "tables":       tables_out,
        "full_text":    full_text,
        "page_count":   page_count,
        "page_dims":    page_dims,
        "raw_response": {"model": "prebuilt-layout", "pages": page_count},
        "error":        None,
        "provider":     "azure_layout",
    }


# Separator between a parent header and its child, e.g. "خط السير - من".
_HDR_SEP = " - "

# Azure reports a selection mark for anything reading as a tick or a cross, and
# tells us nothing about WHICH -- not the shape, not the meaning. There is no
# honest single character to stand in for it.
SELECTION_MARK = ""


def _clean_cell_text(raw: str) -> str:
    """
    Cell text with Azure's selection tokens resolved to a neutral mark.

    These were rewritten as the Arabic word for "agreed", on every column of
    every form. On a sheet asking whether the participant has a disability that
    is simply false, and it produced the contradiction "no agreed" -- the person
    had written NO and the pipeline appended AGREE.

    What a mark means depends on the question, and this layer does not know the
    question. It records THAT a mark is there. The approval normaliser in
    process_document, which does know which columns are consent columns, is
    where it becomes a word.

    A mark next to real handwriting adds nothing, so it is dropped rather than
    left to produce "X (tick)".

    A mark with NO glyph leaves the cell empty. It used to become a tick, which
    put a tick on a sheet where the person had drawn a cross -- Azure reports
    that a mark is present, never which one, so any character chosen here is
    invented. Where Azure actually READS the glyph it comes through as text
    ("X") and is preserved; where it does not, the cell says nothing, which is
    the truth.
    """
    txt = (raw or "").strip()
    marked = ":selected:" in txt
    txt = txt.replace(":selected:", " ").replace(":unselected:", " ")
    txt = " ".join(txt.split())
    if marked and not txt:
        return SELECTION_MARK
    return txt


def _azure_order_is_reading_order(main_table: dict, layout_result: dict) -> bool:
    """
    Does Azure's column numbering already run in reading order?

    Azure numbers columns by where they sit in the PAGE's coordinate frame, and
    a photograph taken sideways rotates that frame with it -- so the numbering
    can run either way and neither is a bug. Assuming one direction was wrong:
    it was inferred from a single sheet shot at 89.5 degrees, and it mirrored
    every upright form.

    Measured on two real sheets:

      angle -0.4  "#" (the first column on the paper) is col 0, at the RIGHT
                  edge -- x DECREASES as the index rises, already reading order
      angle 89.5  "#" is col 15, at the far end of y -- y INCREASES with the
                  index, so the numbering runs backwards

    An Arabic table reads right to left, so reading order is whichever
    direction DECREASES. Pick the axis the columns actually advance along
    rather than trusting the angle, and answer from that.

    Returns True (leave the order alone) when the geometry is unreadable --
    Azure's own order is the better guess than a coin flip.
    """
    polys = main_table.get("cell_polygons") or []
    if not polys:
        return True

    xs_by_col: dict = {}
    ys_by_col: dict = {}
    for cp in polys:
        poly = cp.get("polygon") or []
        if len(poly) < 8:
            continue
        col = cp.get("col")
        xs_by_col.setdefault(col, []).append(sum(poly[0::2]) / len(poly[0::2]))
        ys_by_col.setdefault(col, []).append(sum(poly[1::2]) / len(poly[1::2]))
    if len(xs_by_col) < 2:
        return True

    cols = sorted(xs_by_col)
    def spread(d):
        vals = [sum(d[c]) / len(d[c]) for c in cols]
        return max(vals) - min(vals), vals
    x_range, x_vals = spread(xs_by_col)
    y_range, y_vals = spread(ys_by_col)

    # Columns sit side by side, so they spread far along one axis and barely at
    # all along the other. The wider spread is the axis they advance on.
    vals = x_vals if x_range >= y_range else y_vals
    # Decreasing with the column index means Azure already numbered them right
    # to left, which for an Arabic table is reading order.
    return vals[-1] < vals[0]


def _is_rtl_table(headers: list) -> bool:
    """
    Whether this form reads right-to-left, decided by script so a Latin form is
    left alone.
    """
    ar = lat = 0
    for h in headers:
        for ch in str(h or ""):
            o = ord(ch)
            if 0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or 0xFB50 <= o <= 0xFEFF:
                ar += 1
            elif ch.isalpha() and o < 0x0250:
                lat += 1
    return ar > lat


# Five or more digits in a row is participant data -- an ID, a phone. A header
# never carries one; even a date header like "27/8/2026" tops out at four.
_LONG_DIGITS = re.compile(r"\d{5,}")


def _cell_text(cell) -> str:
    return " ".join((getattr(cell, "content", "") or "").split())


def _row_is_participant_data(cells_at_row) -> bool:
    """Does this row hold someone's details rather than column labels?"""
    for c in cells_at_row:
        txt = _cell_text(c)
        # Arabic-Indic digits count the same as ASCII ones.
        norm = "".join(str(int(ch)) if ch.isdigit() else ch for ch in txt)
        if _LONG_DIGITS.search(norm):
            return True
    return False


def _header_row_count(cells, row_count: int) -> int:
    """
    How many leading rows are column headers.

    Azure tags header cells kind="columnHeader", and only rows where such a cell
    BEGINS are counted. A tall header spanning two rows does not create a second
    tier: expanding its row_span marked the first participant's row as a header,
    so "الاسم رباعي" came back as "الاسم رباعي - كفاح عرفان حسون" and every other
    column carried row 1's value too. It also broke the row-number drop, because
    "#" became "# - 1", stopped matching the pattern, and survived as a stray
    column.

    In a genuine two-tier header the second tier has cells of its own -- "من" and
    "إلى" sit at row_index 1 and carry the tag themselves.

    Only LEADING consecutive header rows count. A header repeated mid-table is a
    different problem and stays with _is_subheader_row.
    """
    origins: set = set()
    by_row: dict = {}
    for cell in (cells or []):
        by_row.setdefault(cell.row_index, []).append(cell)
        if (getattr(cell, "kind", "") or "") == "columnHeader":
            origins.add(cell.row_index)

    # A one-row table has no header row -- the row IS the data, and its columns
    # get synthetic names. Demanding a header there left zero data rows and the
    # table came back empty.
    if row_count < 2:
        return 0

    n = 0
    # Never consume the whole table: at least one data row must survive.
    while n in origins and n < row_count - 1:
        # Second belt: a row holding an ID or a phone number is somebody's data,
        # whatever Azure tagged it. Row 0 is exempt -- if the top row is the
        # header it stays the header regardless of what got read out of it.
        if n > 0 and _row_is_participant_data(by_row.get(n, [])):
            break
        n += 1
    # Azure omits kind on some tables; one header row is the old behaviour.
    return n or 1


def _header_paths(cells, nrows: int, ncols: int) -> list:
    """
    The header path of each column, parent first.

    Azure emits a spanning cell once, at its origin, and leaves the columns it
    covers empty -- which is why "خط السير" landed in one column and its
    second half became "عمود N". Expanding the span turns

        row 0:  خط السير  |  (empty)
        row 1:  من        |  إلى

    into [["خط السير", "من"], ["خط السير", "إلى"]].
    """
    mat = [[None] * ncols for _ in range(nrows)]
    for cell in (cells or []):
        r, c = cell.row_index, cell.column_index
        if r >= nrows or c >= ncols:
            continue
        content = _clean_cell_text(cell.content)
        if not content:
            continue
        rs = getattr(cell, "row_span", 1) or 1
        cs = getattr(cell, "column_span", 1) or 1
        for rr in range(r, min(r + rs, nrows)):
            for cc in range(c, min(c + cs, ncols)):
                mat[rr][cc] = content

    paths = []
    for c in range(ncols):
        path = []
        for r in range(nrows):
            t = mat[r][c]
            # A cell spanning rows repeats down its span -- keep it once.
            if t and (not path or path[-1] != t):
                path.append(t)
        paths.append(path)
    return paths


# ── Shared table-shape helpers ────────────────────────────────────────────────
# layout_to_participants() and layout_to_cell_polygons() walk the same Azure grid
# and MUST agree on which columns exist, what they are called, and which tables
# belong to the same form. They had drifted: the polygon path named blank headers
# and matched pages by column count, while the participants path dropped blank
# headers and demanded the header TEXT match. Two functions disagreeing about the
# shape of a table is how one person's data ends up in another person's row, so
# the logic lives here once.

def _norm_header(h: str) -> str:
    """Strip diacritics and unify alef, for fuzzy header comparison."""
    h = re.sub(r"[ً-ٰٟ]", "", str(h or ""))
    h = re.sub(r"[أإآٱ]", "ا", h)
    return h.strip().lower()


def _effective_headers(hdrs: list, ncols: int) -> list:
    """
    A usable, unique name for every column position.

    A blank header becomes "عمود N" instead of the column being dropped. Real
    forms do have unnamed columns -- the second half of a split header like
    "خط السير" over "من"/"إلى" is one -- and a column the customer can rename is
    worth far more than a column silently discarded.
    """
    out_h, seen = [], {}
    for i in range(ncols):
        nm = (str(hdrs[i]).strip() if i < len(hdrs) and hdrs[i] else "")
        if not nm:
            nm = f"عمود {i + 1}"
        if nm in seen:
            seen[nm] += 1
            nm = f"{nm} ({seen[nm]})"
        else:
            seen[nm] = 0
        out_h.append(nm)
    return out_h


def _same_form(main_cols: int, main_norms: list, other: dict) -> bool:
    """
    Is this table another page of the same form?

    Column COUNT first. Header text is OCR output and varies between pages of
    one document -- "رقم الهوية" on the first, "رقم الهويه" on the second -- so
    requiring the text to match discards whole pages of real participants. An
    identical column count is the stronger signal; text overlap is the fallback
    for when the counts genuinely differ.
    """
    if (other.get("column_count") or 0) == main_cols:
        return True
    other_norms = [_norm_header(h) for h in (other.get("headers") or []) if h]
    if not other_norms:
        return False
    return sum(1 for h in other_norms if h in main_norms) / len(other_norms) >= 0.6


def layout_to_participants(layout_result: dict) -> tuple[list[str], list[dict]]:
    """
    Convert extract_azure_layout() output into (column_order, participants).

    This is the drop-in replacement for Gemini structuring when Azure layout
    successfully detected the table grid.

    Returns:
        column_order:  list of column header strings
        participants:  list of dicts {header: value_or_None}

    Note: see layout_to_cell_polygons() for the per-cell polygon map used by
    the training-data cropper.
    """
    tables = layout_result.get("tables") or []
    if not tables:
        return [], []

    # Pick the table with the most data rows as the reference (defines column order).
    main_table = max(tables, key=lambda t: len(t["rows"]))
    main_cols  = main_table.get("column_count") or len(main_table["headers"])
    # Every column gets a name, including the unnamed ones. `headers` is the
    # customer-visible column order from here on.
    headers    = _effective_headers(main_table["headers"], main_cols)
    main_norms = [_norm_header(h) for h in main_table["headers"]]

    def _rows_to_participants(tbl_headers: list, tbl_rows: list) -> list:
        """
        Build one record per row, addressing columns BY POSITION.

        This used to look each value up by its header's text:

            src_idx = [_norm_header(h) for h in tbl_headers].index(_norm_header(header))
            except ValueError: value = None

        On a handwritten form the header row is handwritten too. Azure reads
        "رقم الهوية" on page one and "رقم الهويه" on page two, the lookup raises,
        and page two's ID column becomes empty for every participant -- silently,
        with the job still reporting success. That is the "it gets confused on a
        different form" failure.

        Azure numbers its columns explicitly and emits empty cells rather than
        skipping them, so position is reliable where the header text is not. When
        this table has the same column count as the main one, index i means the
        same column. A misread header now costs a wrong LABEL, which the customer
        can rename in one click, instead of a lost column.
        """
        records = []
        # Columns that contain only the printed row number are NOT real content —
        # a row with just "6" in the # column and nothing else is still blank.
        _ROW_NUM_PAT = re.compile(r"^[#0-9٠-٩]+$")

        by_position = len(tbl_headers) == len(main_table["headers"])
        name_to_src = None
        if not by_position:
            # Genuinely different shape: fall back to matching header text, which
            # is all that is left to go on.
            tbl_norms  = [_norm_header(h) for h in tbl_headers]
            name_to_src = {}
            for i, h in enumerate(main_table["headers"]):
                try:
                    name_to_src[i] = tbl_norms.index(_norm_header(h))
                except ValueError:
                    pass

        for row in tbl_rows:
            if all(v is None or v == "" for v in row):
                continue   # skip blank rows
            if _is_subheader_row(row):
                continue   # second line of a split header, not a participant
            record: dict = {}
            for col_idx, header in enumerate(headers):
                src_idx = col_idx if by_position else name_to_src.get(col_idx)
                value = (row[src_idx]
                         if src_idx is not None and src_idx < len(row) else None)
                record[header] = value if value else None
            # Post-mapping blank check: after reshuffling into the main column
            # order, a row may become all-None (e.g. this table's headers didn't
            # match the main headers). Also treat "only a row-number value" as
            # blank — the printed # alone is not participant data.
            non_empty = [
                v for v in record.values()
                if v is not None and str(v).strip() != ""
            ]
            if not non_empty:
                continue
            if len(non_empty) == 1 and _ROW_NUM_PAT.match(str(non_empty[0]).strip()):
                continue
            records.append(record)
        return records

    # Merge all compatible tables in page order
    participants: list = []
    skipped_pages: list = []
    for table in sorted(tables, key=lambda t: t.get("page_number", 1)):
        # Column count first, header text only as a fallback. The old rule
        # demanded 60% of header TEXT match, so a second page whose header row
        # was faint or cropped fell below it and every participant on that page
        # vanished -- with the job still reporting success.
        if not _same_form(main_cols, main_norms, table):
            skipped_pages.append(table.get("page_number", "?"))
            logger.warning(
                f"[AzureLayout] EXCLUDED page {table.get('page_number', '?')} "
                f"— {table.get('column_count')} columns vs {main_cols}, "
                f"headers: {table['headers']}"
            )
            continue
        rows = _rows_to_participants(table["headers"], table["rows"])
        participants.extend(rows)
        logger.info(
            f"[AzureLayout] Merged table page={table.get('page_number', '?')} "
            f"→ {len(rows)} rows (total so far: {len(participants)})"
        )

    # Renumber the sequence column (#, #1, №, etc.) 1..N so every row has a
    # unique, contiguous identifier. Azure sometimes leaves this column blank
    # on later pages (e.g. page 2's header is "#" and page 1's is "#1" → the
    # column-mapper can't find it, so page 2 rows lose their number).
    # Detect the sequence column: first header starting with # or a pure digit.
    # Match ONLY a standalone serial token — anchored with $ so "رقم الهوية"
    # (ID number) / "رقم الهاتف" (phone number) do NOT match just because they
    # start with "رقم" ("number"). Overwriting those would destroy real data.
    # Reading order for display. `headers` above is the physical position map
    # that _rows_to_participants indexes with col_idx and must not move, so any
    # flip applies only to the list handed back as column_order -- which is
    # purely a display order (structured_data and cell_polygons are keyed by
    # name, never by position in this list).
    display = list(headers)
    if _is_rtl_table(headers) and not _azure_order_is_reading_order(main_table, layout_result):
        display = list(reversed(headers))

    _seq_pat = re.compile(r"^(#\d*|No\.?|№|م|ت|رقم|الرقم|تسلسل|مسلسل)$", re.I)
    seq_col = None
    if display:
        first = (display[0] or "").strip()
        if _seq_pat.match(first) or first in ("#1", "#"):
            # Value guard: only renumber when the column's existing values already
            # look like short serial integers. An ID column that happens to be
            # first (e.g. "960 *** 549") must never be clobbered with 1..N.
            _vals = [str(p.get(display[0]) or "").strip() for p in participants]
            _vals = [v for v in _vals if v]
            _serial_like = sum(1 for v in _vals if v.isdigit() and len(v) <= 4)
            if _vals and _serial_like >= 0.6 * len(_vals):
                seq_col = display[0]
    if seq_col:
        for idx, rec in enumerate(participants, start=1):
            rec[seq_col] = str(idx)

    return display, participants


# Words that appear as a SECOND header row rather than as data. A column whose
# header spans two lines -- "خط السير" over "من" / "إلى" -- makes Azure emit that
# second line as a data row, which then becomes a participant with no name, no ID
# and no phone. It shows up as a blank first row in the customer's table.
def layout_to_cell_polygons(layout_result: dict) -> list[dict]:
    """
    Build a flat list of per-cell polygons keyed by (participant_index, field_name).

    Used by the training-data cropper to crop each cell from the original document
    after the pipeline finishes.

    Returns:
        [
          {
            "participant_index": int,   # 0-based row in structured_data
            "field_name":        str,   # column header (matches structured_data key)
            "page":              int,   # 1-based page number
            "polygon":           [x1,y1, x2,y2, x3,y3, x4,y4]   # inches
          },
          ...
        ]

    Mirrors the same row-skip logic as layout_to_participants so indices align.
    """
    tables = layout_result.get("tables") or []
    if not tables:
        return []

    # Per-page content angle (from Azure) so the cropper can correct upside-down
    # pages. Keyed by 1-based page number; defaults to 0 when unavailable.
    page_dims = layout_result.get("page_dims") or {}
    def _angle_for(page_no: int) -> float:
        dim = page_dims.get(page_no) or page_dims.get(str(page_no)) or {}
        try:
            return float(dim.get("angle") or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def _size_for(page_no: int) -> tuple:
        """
        Azure's own page size, in the same units as the polygons.

        Carried onto every cell so the cropper can scale exactly
        (pixels_per_unit = rendered_width / page_width) instead of guessing the
        unit from the coordinate magnitudes. The guess is what produced crops
        shifted most of a row down on photographed pages.
        """
        dim = page_dims.get(page_no) or page_dims.get(str(page_no)) or {}
        try:
            return float(dim.get("width") or 0.0), float(dim.get("height") or 0.0)
        except (TypeError, ValueError):
            return 0.0, 0.0

    main_table = max(tables, key=lambda t: len(t["rows"]))
    headers    = main_table["headers"]
    main_cols  = main_table.get("column_count") or len(headers)

    # Effective, unique field name PER COLUMN INDEX. Real headers are kept; blank
    # or garbage headers become position-based labels ("عمود N") so a column is
    # NEVER dropped. Some scans put the real header row in row 1 and leave Azure's
    # row-0 header blank — the old "skip empty header" logic discarded the entire
    # name column then. We emit every column (with cell text) and let the cropper
    # detect the name column by content, header-agnostic.
    eff_headers = _effective_headers(headers, main_cols)

    main_norms = [_norm_header(h) for h in headers]

    def _compatible(other_t: dict) -> bool:
        # Same column count → same form across pages (position-based alignment),
        # even when OCR garbled the per-page header text differently.
        if (other_t.get("column_count") or 0) == main_cols:
            return True
        other_norms = [_norm_header(h) for h in (other_t.get("headers") or []) if h]
        if not other_norms:
            return False
        matches = sum(1 for h in other_norms if h in main_norms)
        return matches / len(other_norms) >= 0.6

    out: list[dict] = []
    participant_index = 0

    for table in sorted(tables, key=lambda t: t.get("page_number", 1)):
        if not _compatible(table):
            continue
        page_no = table.get("page_number", 1)
        angle   = _angle_for(page_no)
        pw, ph  = _size_for(page_no)

        # Build polygon lookup by (row, col) for this table
        poly_lookup: dict[tuple[int, int], list[float]] = {}
        hw_lookup:   dict[tuple[int, int], bool] = {}
        for cp in table.get("cell_polygons", []):
            poly_lookup[(cp["row"], cp["col"])] = cp.get("polygon") or []
            hw_lookup[(cp["row"], cp["col"])]   = bool(cp.get("handwritten"))

        # Walk the data rows in the same order as _rows_to_participants
        _ROW_NUM_PAT = re.compile(r"^[#0-9٠-٩]+$")
        tbl_norms = [_norm_header(h) for h in table["headers"]]

        # r_idx must be the ABSOLUTE grid row, because poly_lookup is keyed by
        # it. With a two-tier header, data starts at grid row 2 -- starting at 1
        # here would hand every crop the row above the one it belongs to.
        for r_idx, row in enumerate(table["rows"],
                                    start=table.get("header_row_count", 1)):
            if all(v is None or v == "" for v in row):
                continue
            # Must mirror _rows_to_participants exactly. participant_index is
            # only meaningful because both loops skip the same rows; when they
            # drift, every polygon points at the wrong person's cell. Skipping
            # here without incrementing participant_index is what keeps them
            # in step.
            if _is_subheader_row(row):
                continue
            non_empty = [v for v in row if v is not None and str(v).strip() != ""]
            if not non_empty:
                continue
            if len(non_empty) == 1 and _ROW_NUM_PAT.match(str(non_empty[0]).strip()):
                continue

            # Emit EVERY column (position-based) with its cell text, so the
            # cropper can detect the name column by content regardless of how
            # bad the header row was. Blank-header columns are kept (synthetic
            # name) instead of being dropped.
            ncols = min(main_cols, table.get("column_count") or len(row), len(row))
            for c in range(ncols):
                poly = poly_lookup.get((r_idx, c))
                if not poly:
                    continue
                cell_text = row[c]
                out.append({
                    "participant_index": participant_index,
                    "field_name":        eff_headers[c] if c < len(eff_headers) else f"عمود {c + 1}",
                    "page":              page_no,
                    "polygon":           poly,
                    "page_angle":        angle,
                    "page_width":        pw,
                    "page_height":       ph,
                    "text":              (str(cell_text).strip() if cell_text else ""),
                    "col":               c,
                    "handwritten":       hw_lookup.get((r_idx, c)),
                })
            participant_index += 1

    return out


def _fail(error: str) -> dict:
    return {
        "success":      False,
        "tables":       [],
        "full_text":    "",
        "page_count":   0,
        "raw_response": {},
        "error":        error,
        "provider":     "azure_layout",
    }
