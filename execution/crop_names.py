"""
execution/crop_names.py

Crop name cells from a job's original document → upload to training_crops
bucket → insert pending rows into training_dataset.

Source data:
  document_jobs.structured_data   — the OCR'd values per (participant, field)
  document_jobs.cell_polygons     — bounding polygons in INCHES (Azure layout)
  document_jobs.document_url      — storage path inside `documents` bucket

Output:
  training_crops/{job_id}/{idx}_{slug}.png  — the cropped name images
  training_dataset rows                       — one per crop, status='pending'

Idempotent: re-running on the same job is a no-op (UNIQUE constraint on
(job_id, participant_index, field_name)).

Usage (CLI):
    python execution/crop_names.py <job_id>

Programmatic:
    from execution.crop_names import crop_job_names
    crop_job_names(job_id, supabase=sb)
"""
from __future__ import annotations

import io
import logging
import os
import re
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[CropNames] %(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# Padding around each cell polygon, in pixels at the render DPI below.
# Asymmetric on purpose:
#   • Horizontal: small (12 px) — Arabic word boundaries are usually well-defined
#     by Azure's polygons, and over-padding adds neighbor-cell content.
#   • Top:        moderate (10 px) — for tall ascenders (ل ك ا ط).
#   • Bottom:     larger (18 px) — Arabic descenders (ج م ن ي ق ص) hang well
#     below the baseline and get clipped if we use the same padding all round.
#     This was the dominant complaint: "names cut off at the bottom".
# Plus a percentage expansion (3 % each side) so very small cells get tighter
# crops and large cells get more slack proportionally.
_PAD_PX_X       = 12
_PAD_PX_TOP     = 10
_PAD_PX_BOTTOM  = 18
_PAD_PCT        = 0.03

# Render DPI — Azure polygons are in inches, multiplied to get pixel coords.
# 200 DPI is a good balance: high enough for OCR training, fast enough.
_DPI = 200

# Only crop columns whose header matches a name pattern (Arabic or English).
_NAME_HEADER_RE = re.compile(r"اسم|name", re.IGNORECASE)

# Signature columns often contain "اسم" too (e.g. "اسم وتوقيع ولي الأمر") but hold
# handwritten signatures / guardian marks, not clean per-person names.
_SIG_HEADER_RE = re.compile(r"توقيع|signature|imza|\bsign\b", re.IGNORECASE)

# Entity / organization name columns ("اسم المؤسسة", "اسم الموزع", "اسم الجهة") are
# NOT person names. They're usually sparsely filled or repeated, so cropping them
# both starves the real name column and pollutes the set with junk.
_ENTITY_HEADER_RE = re.compile(
    r"مؤسس|منظم|شريك|جهة|جهه|مركز|موزع|قاعدي|مدرس|جامع|كلي|company|organization|entity",
    re.IGNORECASE,
)


def _norm_ar_header(s: str) -> str:
    """Normalize an Arabic header for matching: strip diacritics and unify
    alef/hamza + yeh + teh-marbuta variants. Critical because the real name
    column is frequently written "الإسم" (hamza-alef) while the pattern is plain
    "اسم" — without this the person-name column is MISSED and the cropper falls
    back to the wrong column (e.g. an organization-name column), producing only
    a handful of crops instead of every name."""
    s = re.sub(r"[ً-ٰٟ]", "", s)   # diacritics
    s = re.sub(r"[أإآٱ]", "ا", s)                  # alef/hamza variants -> ا
    s = re.sub(r"[ىئ]", "ي", s)                    # yeh variants -> ي
    return s.replace("ة", "ه")

# A letter is Arabic (incl. supplement) or Latin. Used to tell real word/name
# text apart from sparse-cell OCR noise.
_LETTER_RE = re.compile(r"[؀-ۿݐ-ݿa-zA-Z]")


def _looks_like_name_text(value: str) -> bool:
    """
    True when a cell value looks like real word/name text worth training on.

    Name columns in real documents are often sparsely filled — many cells hold
    nothing, a stray digit, a dash, or an OCR speck ('N', '1', '-', '11').
    Cropping those produces the "random characters / small pieces of text"
    that make the training set useless. We keep a cell only when it has at
    least two letters (Arabic OR Latin), so genuinely-Arabic cells that OCR
    mangled into Latin garbage ('~Lis Es') are still captured for correction,
    while pure non-text noise is dropped.
    """
    if not value:
        return False
    v = value.strip()
    if len(v) < 2:
        return False
    return len(_LETTER_RE.findall(v)) >= 2


def _name_column_score(texts: list[str]) -> float:
    """
    Score how strongly a column looks like an Arabic NAME column. Used to pick
    the right column when headers are blank/garbage (some scans put the real
    header row in row 1, leaving Azure's row-0 header empty). Returns -1 for
    clearly non-name columns.

    Names are letter text, multi-word, and mostly UNIQUE per row. Phone/ID/age
    columns are digit-heavy; gender/disability/session columns repeat the same
    few short values. So we reward word count + distinct-value ratio + letter
    ratio, and reject digit-heavy columns.
    """
    vals = [t.strip() for t in texts if t and t.strip()]
    if len(vals) < 2:
        return -1.0
    letter_ratio_sum = 0.0
    word_sum = 0
    digit_heavy = 0
    for v in vals:
        s = v.replace(" ", "")
        if not s:
            continue
        letters = sum(1 for c in s if c.isalpha())
        digits  = sum(1 for c in s if c.isdigit())
        letter_ratio_sum += letters / len(s)
        if digits / len(s) > 0.3:
            digit_heavy += 1
        word_sum += len(v.split())
    n = len(vals)
    avg_letters = letter_ratio_sum / n
    avg_words   = word_sum / n
    distinct    = len(set(vals)) / n
    if avg_letters < 0.5:            # phones, IDs, numbers — not a name column
        return -1.0
    if digit_heavy / n > 0.3:        # too many digit cells
        return -1.0
    return avg_words + distinct + avg_letters * 0.5


def _is_repeated_column(texts: list[str], min_rows: int = 5, max_distinct_ratio: float = 0.3) -> bool:
    """True when a column is near-constant (same value repeated on most rows,
    e.g. a distributor/organization name printed on every row). Low training
    value and almost never the per-person name column. Only judged when there
    are enough rows to be confident."""
    vals = [t.strip() for t in texts if t and t.strip()]
    if len(vals) < min_rows:
        return False
    return (len(set(vals)) / len(vals)) < max_distinct_ratio


def _slugify_field(field: str) -> str:
    """Make a Supabase-Storage-safe slug from a column name.

    Supabase Storage rejects non-ASCII characters in object keys with
    HTTP 400 InvalidKey. We can't keep Arabic in the path. Strip to ASCII
    AND append a short content hash so different Arabic-only headers
    don't collide on the same fallback slug ('field' + 'field'). The
    full Arabic field_name is still preserved in the training_dataset row.
    """
    import hashlib
    ascii_only = re.sub(r"[^a-zA-Z0-9_-]+", "_", field).strip("_")
    digest = hashlib.md5(field.encode("utf-8")).hexdigest()[:8]
    base = (ascii_only or "field")[:32]
    return f"{base}_{digest}"


def _polygon_to_bbox_pixels(polygon: list[float], dpi: int, page_w_in: float, page_h_in: float, unit_scale: float = 1.0, neighbors: list | None = None) -> tuple[int, int, int, int] | None:
    """
    Convert an Azure polygon ([x1,y1,...,x4,y4]) into a pixel bbox
    (left, top, right, bottom) suitable for PIL.crop.

    `unit_scale` converts polygon units to inches:
      • 1.0      → polygon already in inches (Azure default for PDFs)
      • 1/dpi    → polygon in image pixels (Azure default for images)
      • 25.4     → polygon in millimetres
    Caller picks the scale once per page using _detect_polygon_unit.

    Padding is asymmetric — extra on the bottom so Arabic descenders aren't
    clipped — and combines a fixed pixel cushion with a small percentage
    expansion that scales with cell size.

    Returns None when the polygon coordinates are clearly outside the page
    even after the chosen scale + rotation. The caller should treat this as
    a skipped cell, not an error.

    `neighbors` (the other cell polygons on the page, same units) makes the
    padding stop at half the gap to whichever cell is actually adjacent.

    It is opt-in, and the name path deliberately does NOT pass it. The padding
    above is generous -- on the rotated registration sheet the rows stack along
    the cells' 45 px axis, so a fixed 12 px reached ~29% into the row next door
    and 52% of the finished crop belonged to other cells. Clamping takes that to
    10% with nothing of the cell's own content lost. But the LoRA adapters were
    trained on crops cut with exactly the padding above, so changing it for them
    would be a train/inference mismatch, not an improvement. Numeric re-reads
    have no such tie and pass it.
    """
    xs = polygon[0::2]
    ys = polygon[1::2]
    page_w_px = int(page_w_in * dpi)
    page_h_px = int(page_h_in * dpi)
    # Convert to inches via unit_scale, then to pixels via dpi.
    px_min, px_max = min(xs) * unit_scale * dpi, max(xs) * unit_scale * dpi
    py_min, py_max = min(ys) * unit_scale * dpi, max(ys) * unit_scale * dpi

    # Self-rescue for rotation mismatch: if the polygon's max-x exceeds the
    # rendered page width OR max-y exceeds the rendered page height by more
    # than 5 %, swap the axes once and retry. This is the standard fingerprint
    # of an Azure-vs-PyMuPDF orientation disagreement.
    out_of_x = px_max > page_w_px * 1.05
    out_of_y = py_max > page_h_px * 1.05
    if out_of_x or out_of_y:
        # Try transposing — landscape vs portrait swap.
        px_min, px_max, py_min, py_max = py_min, py_max, px_min, px_max
        # If the swap doesn't fix it, give up on this cell.
        if px_max > page_w_px * 1.05 or py_max > page_h_px * 1.05:
            return None

    cell_w = max(1.0, px_max - px_min)
    cell_h = max(1.0, py_max - py_min)
    pad_pct_x = cell_w * _PAD_PCT
    pad_pct_y = cell_h * _PAD_PCT

    # Clamp the TOTAL padding, fixed plus percentage. Clamping only the fixed
    # part still lets the percentage cross the line into the next cell.
    pad_l = pad_r = _PAD_PX_X + pad_pct_x
    pad_t = _PAD_PX_TOP    + pad_pct_y
    pad_b = _PAD_PX_BOTTOM + pad_pct_y

    if neighbors:
        k = unit_scale * dpi
        cx, cy = (px_min + px_max) / 2, (py_min + py_max) / 2
        gap_l, gap_r, gap_t, gap_b = [], [], [], []
        for npoly in neighbors:
            if not npoly or len(npoly) < 8:
                continue
            nxs, nys = npoly[0::2], npoly[1::2]
            nx0, nx1 = min(nxs) * k, max(nxs) * k
            ny0, ny1 = min(nys) * k, max(nys) * k
            # Same cell listed again -- ignore, or it clamps against itself.
            if abs(nx0 - px_min) < 1 and abs(ny0 - py_min) < 1:
                continue
            # Which side a cell is on is decided by its centre, so a neighbour
            # that already overlaps this cell yields a negative gap and pins the
            # padding to zero rather than being skipped as "not adjacent".
            if min(py_max, ny1) - max(py_min, ny0) > 0:
                (gap_l if (nx0 + nx1) / 2 < cx else gap_r).append(
                    px_min - nx1 if (nx0 + nx1) / 2 < cx else nx0 - px_max)
            if min(px_max, nx1) - max(px_min, nx0) > 0:
                (gap_t if (ny0 + ny1) / 2 < cy else gap_b).append(
                    py_min - ny1 if (ny0 + ny1) / 2 < cy else ny0 - py_max)
        # Half the gap: room for a descender that crosses the ruled line, never
        # enough to reach the neighbour's own writing.
        if gap_l: pad_l = min(pad_l, max(0.0, min(gap_l) / 2))
        if gap_r: pad_r = min(pad_r, max(0.0, min(gap_r) / 2))
        if gap_t: pad_t = min(pad_t, max(0.0, min(gap_t) / 2))
        if gap_b: pad_b = min(pad_b, max(0.0, min(gap_b) / 2))

    # Round outwards, but only on the clamped path. int() truncates, so the
    # right and bottom edges land inside the cell and shave the last stroke off
    # whatever was written there -- which bites hardest exactly when the padding
    # has been clamped to nothing. The name path keeps int() because its crops
    # have to stay identical to the ones the adapters were trained on; a pixel
    # is not worth a train/inference mismatch.
    if neighbors:
        import math
        left   = max(0, math.floor(px_min - pad_l))
        top    = max(0, math.floor(py_min - pad_t))
        right  = min(page_w_px, math.ceil(px_max + pad_r))
        bottom = min(page_h_px, math.ceil(py_max + pad_b))
    else:
        left   = max(0, int(px_min - pad_l))
        top    = max(0, int(py_min - pad_t))
        right  = min(page_w_px, int(px_max + pad_r))
        bottom = min(page_h_px, int(py_max + pad_b))

    # Final sanity gate — reject any degenerate / inverted bbox.
    if right - left < 4 or bottom - top < 4:
        return None
    return left, top, right, bottom


def _render_pages(file_bytes: bytes, content_type: str) -> dict[int, "Image.Image"]:
    """
    Returns {page_number_1based: PIL.Image}.

    PDFs render every page at _DPI. Single images return {1: image} regardless
    of declared page count.
    """
    from PIL import Image  # noqa: F401  (type checking only)

    pages: dict[int, "Image.Image"] = {}

    if content_type == "application/pdf" or file_bytes[:4] == b"%PDF":
        try:
            import fitz  # PyMuPDF
        except ImportError:
            raise RuntimeError("PyMuPDF not installed — run: pip install pymupdf")
        from PIL import Image as PILImage
        doc = fitz.open(stream=io.BytesIO(file_bytes), filetype="pdf")
        try:
            zoom = _DPI / 72.0   # 72 DPI is PDF base
            mat = fitz.Matrix(zoom, zoom)
            for i, page in enumerate(doc, start=1):
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img = PILImage.frombytes("RGB", (pix.width, pix.height), pix.samples)
                pages[i] = img
        finally:
            doc.close()
    else:
        from PIL import Image as PILImage, ImageOps
        img = PILImage.open(io.BytesIO(file_bytes))
        # Honour the EXIF orientation tag, because Azure does.
        #
        # A phone photo is stored in the sensor's orientation with a tag saying
        # how to display it. Azure applies that tag and reports its page in the
        # displayed frame; this loaded the raw bytes and did not, so on any
        # photo with a tag the image and the polygon coordinates disagreed by a
        # quarter turn. _orient_to_polygons then had to guess, and it cannot:
        # it scores by whether polygons FIT the page, and 90 and 270 both fit a
        # rotated page equally, so it took 90 because it tries that first.
        #
        # Measured on the sheet that exposed this: EXIF orientation 8, stored
        # 1080x2400, Azure page 2400x1080. Applying the tag gives exactly
        # 2400x1080 and every crop lands on its own cell. Guessing gave 90
        # degrees and every name crop landed on blank paper, which is how the
        # reader came back with the same name for four different people.
        img = ImageOps.exif_transpose(img).convert("RGB")
        pages[1] = img

    return pages


def _page_size_inches(image, dpi: int) -> tuple[float, float]:
    """Reverse-derive the page size in inches from rendered pixels."""
    return image.width / dpi, image.height / dpi


def _exact_polygon_scale(image, page_w: float, page_h: float, dpi: int) -> float | None:
    """
    Scale factor from Azure's polygon units to inches, computed exactly.

    Azure reports the page size in the same units as its polygons. When we have
    it, the conversion is arithmetic and needs no guessing:

        pixels_per_unit = rendered_width / page_width
        scale_to_inches = pixels_per_unit / dpi

    _detect_polygon_unit() guesses instead, by trying inch/pixel/mm/cm and
    keeping whichever overshoots the page least. On a photographed page that
    picked "cm" — a ~4% overshoot that scored a perfect zero — and every crop
    box landed most of a row too low, so each crop showed the NEXT person's
    name. Returns None when Azure's size is unavailable (older jobs), so the
    caller can fall back to the heuristic.
    """
    if not page_w or not page_h or page_w <= 0 or page_h <= 0:
        return None
    # The rendered page may be rotated relative to Azure's frame; match the
    # orientation before dividing, or the scale is wrong by the aspect ratio.
    azure_landscape = page_w >= page_h
    img_landscape   = image.width >= image.height
    w_px = image.width if azure_landscape == img_landscape else image.height
    return (w_px / page_w) / dpi


def _detect_polygon_unit(image, polys: list[list[float]], dpi: int) -> float:
    """
    Decide what unit Azure used for this page's polygon coordinates and
    return a scale factor that converts the polygons to inches.

    Azure Document Intelligence:
      • PDF input  → polygon coords are in INCHES → scale = 1.0
      • Image input → polygon coords are in PIXELS → scale = 1 / dpi   (so
        that polygon-pixel × scale × dpi == polygon-pixel for the bbox math)

    Heuristic: compute the max polygon coordinate on this page and compare
    to plausible page widths. Whichever interpretation lands closest to the
    rendered page wins. Defaults to inches if both are way off.
    """
    if not polys:
        return 1.0
    max_x = max((max(p[0::2]) for p in polys if p and len(p) >= 8), default=0.0)
    max_y = max((max(p[1::2]) for p in polys if p and len(p) >= 8), default=0.0)
    if max_x == 0 and max_y == 0:
        return 1.0

    # Page in pixels at the rendering DPI.
    page_w_px = image.width
    page_h_px = image.height
    page_w_in = image.width  / dpi
    page_h_in = image.height / dpi

    # Candidates: scale factor → expected unit
    candidates = [
        (1.0,      "inch"),     # Azure PDF default
        (1.0 / dpi, "pixel"),   # Azure image default
        (1.0 / 25.4, "mm"),     # rare
        (1.0 / 2.54, "cm"),     # rare
    ]
    best_scale  = 1.0
    best_metric = float("inf")
    for scale, _label in candidates:
        # Treat the polygons as if they were in <unit>; convert to pixels via
        # scale × dpi. Best fit = smallest "out-of-page overshoot" considering
        # both axes (and their swap to absorb rotation).
        cand_x_px = max_x * scale * dpi
        cand_y_px = max_y * scale * dpi
        # Try both upright and 90°-rotated layouts.
        for ow, oh in ((page_w_px, page_h_px), (page_h_px, page_w_px)):
            overshoot = max(0, cand_x_px - ow * 1.05) + max(0, cand_y_px - oh * 1.05)
            undershoot = max(0, ow * 0.4 - cand_x_px) + max(0, oh * 0.4 - cand_y_px)
            metric = overshoot + undershoot * 0.1
            if metric < best_metric:
                best_metric = metric
                best_scale  = scale
    return best_scale


def _orient_to_polygons(image, polys_for_page: list[list[float]], dpi: int, unit_scale: float = 1.0):
    """
    Auto-rotate `image` to whichever of 0/90/180/270 best matches the polygon
    bounding boxes from Azure Layout. Fixes the very common case where PyMuPDF
    renders the page in one orientation while Azure read it in another (e.g.
    PDFs with a /Rotate flag the rasteriser chose to ignore, or scanned images
    with embedded EXIF orientation).

    Score = number of polygons whose max-x and max-y fall inside the rotated
    image's page dimensions. Highest score wins; ties prefer no rotation.
    """
    if not polys_for_page:
        return image

    def fit_score(img):
        w_in = img.width  / dpi
        h_in = img.height / dpi
        s = 0
        for poly in polys_for_page:
            if not poly or len(poly) < 8:
                continue
            xs = poly[0::2]
            ys = poly[1::2]
            # Apply the same unit conversion the bbox math will apply.
            if max(xs) * unit_scale <= w_in * 1.02 and max(ys) * unit_scale <= h_in * 1.02:
                s += 1
        return s

    best_img   = image
    best_score = fit_score(image)
    for angle in (90, 180, 270):
        # PIL rotate is CCW; expand=True keeps the full content.
        rotated = image.rotate(-angle, expand=True)
        s = fit_score(rotated)
        if s > best_score:
            best_score = s
            best_img   = rotated
    return best_img


def _upright_quarter_turn(angle: float) -> int:
    """
    Map Azure's measured page content angle to the quarter-turn needed to make
    the content read upright, as a counter-clockwise angle for PIL's rotate().

    Azure reports `DocumentPage.angle` as the content's CLOCKWISE rotation in
    the image, range (-180, 180]. A page scanned sideways reports ~±90, upside
    down ~±180. To undo a clockwise rotation of A we rotate counter-clockwise
    by A, i.e. PIL rotate(+A). Returns 0 when the page is already upright (or
    the tilt is too small/ambiguous to be a quarter turn).
    """
    a = float(angle or 0.0)
    # Deliberately tighter than 45°: a page sitting at a genuine diagonal is not
    # a quarter turn, and snapping it to one would make it harder to read, not
    # easier. Anything outside these windows is left exactly as-is.
    for target in (90, 180, 270, -90, -180):
        if abs(a - target) <= 30.0:
            return target % 360
    return 0


def _rotate_with_box(crop, context, ctx_box: dict, ccw: int):
    """
    Rotate a crop + its wider context image by `ccw` degrees counter-clockwise
    (90/180/270) and carry `ctx_box` — the tight name box expressed in context
    pixels — through the same transform so the inline editor still opens on the
    right region.

    Coordinates are top-left origin. For a W x H image:
      CCW  90: (x, y) -> (y,         W - x - w)   new size H x W
      CCW 180: (x, y) -> (W - x - w, H - y - h)   new size W x H
      CCW 270: (x, y) -> (H - y - h, x)           new size H x W
    """
    if ccw not in (90, 180, 270):
        return crop, context, ctx_box

    W, H = context.width, context.height
    x, y = ctx_box["x"], ctx_box["y"]
    w, h = ctx_box["w"], ctx_box["h"]

    if ccw == 90:
        new_box = {"x": y,             "y": W - x - w, "w": h, "h": w}
    elif ccw == 180:
        new_box = {"x": W - x - w,     "y": H - y - h, "w": w, "h": h}
    else:  # 270
        new_box = {"x": H - y - h,     "y": x,         "w": h, "h": w}

    return (crop.rotate(ccw, expand=True),
            context.rotate(ccw, expand=True),
            new_box)


# Columns whose answers come from a fixed set. They can score well on
# "looks like Arabic words" and are never name columns.
_FIXED_CHOICE_HEADER_RE = re.compile(
    r"جنس|نوع.{0,8}[اأإآ]جتماع|gender|sex|[اأإآ]عاق|disab|موافق|قبول|وافق|توافق")


def _looks_high_cardinality(values: list, threshold: float = 0.5) -> bool:
    """
    Do these values vary the way people's names do?

    A name column is nearly all distinct -- measured across the corpus, 7,777
    distinct values in 8,364 name cells. A fixed-choice column is the opposite:
    thirteen rows of ذكر and أنثى. Both can look like "Arabic words" to a
    content score, which is how a sheet with no name column at all had its
    GENDER column handed to the name reader, and every cell answered with أنس
    -- a person's name, correctly read, from a cell that never held one.
    """
    vals = [str(v).strip() for v in (values or []) if str(v or "").strip()]
    if len(vals) < 4:
        return True          # too little to judge; let the score decide
    return (len(set(vals)) / len(vals)) >= threshold


def detect_name_fields(cell_polygons: list, structured: list, job_id: str = "") -> tuple:
    """
    Decide which columns hold person names, and collect each column's text.

    Lifted out of crop_job_names so the training cropper and the production
    LoRA reader select exactly the same cells. If those two ever disagreed the
    model would be reading columns it was never trained on, and nothing would
    report it.

    Returns (name_fields, texts_by_field, all_field_names).
    """
    # Primary: column header matches "اسم" or "name" (works on regular OCR docs).
    # Fallback: when no header matches (e.g. a manually-uploaded scan whose
    # header Azure couldn't read), detect by CONTENT — pick every column whose
    # values are ≥ 50 % Arabic letters and average ≥ 2 words. This catches the
    # common case where the column is clearly a name column even though the
    # header is junk / missing / non-Arabic.
    all_field_names = []
    seen_fields: set = set()
    for cp in cell_polygons:
        fn = cp.get("field_name", "")
        if fn and fn not in seen_fields:
            seen_fields.add(fn)
            all_field_names.append(fn)

    # Per-field text lists. Prefer the cell text captured in cell_polygons
    # (header-agnostic — survives blank/garbage header rows); fall back to
    # structured_data for older jobs whose polygons predate text capture.
    texts_by_field: dict[str, list[str]] = {}
    has_cell_text = any(("text" in cp) for cp in cell_polygons)
    if has_cell_text:
        for cp in cell_polygons:
            fn = cp.get("field_name", "")
            if fn:
                texts_by_field.setdefault(fn, []).append(cp.get("text") or "")
    else:
        for fn in all_field_names:
            texts_by_field[fn] = [str(row.get(fn) or "") for row in structured if row.get(fn)]

    # Primary: a real header says "اسم"/"name" — matched on the NORMALIZED header
    # (so "الإسم" with hamza-alef matches too), while EXCLUDING signature columns,
    # organization/entity-name columns, and near-constant columns. Those are the
    # wrong-column ("only 5 names") and junk-crop sources.
    def _is_person_name_header(fn: str) -> bool:
        nfn = _norm_ar_header(fn)
        if not _NAME_HEADER_RE.search(nfn):
            return False
        if _SIG_HEADER_RE.search(nfn) or _ENTITY_HEADER_RE.search(nfn):
            return False
        if _is_repeated_column(texts_by_field.get(fn, [])):
            return False
        return True

    name_fields: set[str] = {fn for fn in all_field_names if _is_person_name_header(fn)}

    # Fallback: detect by CONTENT. Score each column by name-likeness and pick the
    # best — this finds the name column even when its header is blank/garbage.
    # Still exclude signature/entity columns so the fallback can't pick an
    # organization-name column by content.
    if not name_fields:
        _cand = [
            fn for fn in all_field_names
            if not _SIG_HEADER_RE.search(_norm_ar_header(fn))
            and not _ENTITY_HEADER_RE.search(_norm_ar_header(fn))
            and not _FIXED_CHOICE_HEADER_RE.search(_norm_ar_header(fn))
            and _looks_high_cardinality(texts_by_field.get(fn, []))
        ]
        scored = [(fn, _name_column_score(texts_by_field.get(fn, []))) for fn in _cand]
        scored = [(fn, s) for fn, s in scored if s > 0]
        if scored:
            scored.sort(key=lambda x: x[1], reverse=True)
            best_fn, best_s = scored[0]
            name_fields.add(best_fn)
            # Also include other strongly name-like columns (e.g. docs with a
            # separate first-name and full-name column).
            for fn, s in scored[1:]:
                if s >= best_s * 0.85 and s >= 2.5:
                    name_fields.add(fn)
            logger.info(
                f"Job {job_id}: content-based name detection -> {sorted(name_fields)} "
                f"(top score={best_s:.2f})"
            )

    if not name_fields:
        logger.info(f"Job {job_id}: no name columns found by header OR content")

    return name_fields, texts_by_field, all_field_names


def crop_job_names(job_id: str, supabase=None) -> dict:
    """
    Crop every name cell in `job_id` and insert pending rows into
    training_dataset. Returns stats dict.
    """
    if supabase is None:
        from dotenv import load_dotenv
        load_dotenv()
        from supabase import create_client
        supabase = create_client(
            os.environ["NEXT_PUBLIC_SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )

    stats = {
        "job_id": job_id, "created": 0, "skipped_existing": 0,
        "skipped_no_polygon": 0, "skipped_empty_content": 0, "errors": 0,
        # First few error messages so a 500-error UI can show actionable text.
        "error_samples": [],
    }

    # ── Fetch job ──────────────────────────────────────────────────────────────
    job_resp = (
        supabase.table("document_jobs")
        .select("id, document_url, structured_data, cell_polygons, status")
        .eq("id", job_id)
        .single()
        .execute()
    )
    job = job_resp.data
    if not job:
        logger.warning(f"Job {job_id} not found")
        return {**stats, "error": "job_not_found"}
    if job.get("status") != "completed":
        logger.info(f"Job {job_id} not completed (status={job.get('status')}) — skip")
        return {**stats, "error": "not_completed"}
    document_url   = job.get("document_url")
    structured     = job.get("structured_data") or []
    cell_polygons  = job.get("cell_polygons") or []
    if not document_url:
        return {**stats, "error": "no_document_url"}
    if not cell_polygons:
        logger.info(f"Job {job_id} has no cell_polygons — Azure layout was not used")
        return {**stats, "error": "no_polygons"}

    # ── Download the original ──────────────────────────────────────────────────
    try:
        file_bytes = supabase.storage.from_("documents").download(document_url)
    except Exception as e:
        logger.error(f"Failed to download {document_url}: {e}")
        return {**stats, "error": f"download_failed: {e}"}

    # Heuristic for content type from extension
    ext = (document_url.rsplit(".", 1)[-1] or "").lower()
    content_type = "application/pdf" if ext == "pdf" else f"image/{ext or 'png'}"

    # ── Render pages once ──────────────────────────────────────────────────────
    try:
        pages = _render_pages(file_bytes, content_type)
    except Exception as e:
        logger.error(f"Failed to render pages: {e}")
        return {**stats, "error": f"render_failed: {e}"}
    if not pages:
        return {**stats, "error": "no_pages_rendered"}

    # ── Pre-fetch existing training_dataset rows for this job (idempotency) ────
    existing = (
        supabase.table("training_dataset")
        .select("participant_index, field_name")
        .eq("job_id", job_id)
        .execute()
        .data or []
    )
    existing_keys = {(r["participant_index"], r["field_name"]) for r in existing}

    name_fields, texts_by_field, all_field_names = detect_name_fields(
        cell_polygons, structured, job_id)

    # ── Per-page auto-orient + diagnostics ──────────────────────────────────
    # Azure may have read the page in a different rotation than PyMuPDF
    # rendered it. For each page, collect ALL of its polygons (not just name
    # ones) and pick the rotation that best fits — once per page so we don't
    # rotate inside the per-cell loop.
    polys_by_page: dict[int, list[list[float]]] = {}
    for cp in cell_polygons:
        polys_by_page.setdefault(cp.get("page", 1), []).append(cp.get("polygon") or [])

    # Azure's page size per page, in polygon units — the exact scale source.
    page_size_by_page: dict[int, tuple] = {}
    for cp in cell_polygons:
        pg = cp.get("page", 1)
        if pg not in page_size_by_page and cp.get("page_width"):
            page_size_by_page[pg] = (float(cp.get("page_width") or 0.0),
                                     float(cp.get("page_height") or 0.0))

    # Azure's measured content angle per page. The bbox-fit orient below cannot
    # distinguish 0° from 180° (a flipped page has an identical bounding box),
    # so a page scanned upside-down yields upside-down crops. Azure reports the
    # true content angle; we use it to flip the final crop 180° when needed.
    # Range is (-180, 180]; values near ±180 mean the page is upside down.
    page_angle_by_page: dict[int, float] = {}
    for cp in cell_polygons:
        pg = cp.get("page", 1)
        if pg not in page_angle_by_page and cp.get("page_angle") is not None:
            try:
                page_angle_by_page[pg] = float(cp["page_angle"])
            except (TypeError, ValueError):
                pass

    diag: list[str] = []
    # Per-page unit scale (1.0 = inches, 1/dpi = pixels, ...). Used both in
    # the orient step and inside the crop loop.
    unit_scale_by_page: dict[int, float] = {}
    for pn, img in list(pages.items()):
        polys = polys_by_page.get(pn, [])
        max_x = max((max(p[0::2]) for p in polys if p and len(p) >= 8), default=0.0)
        max_y = max((max(p[1::2]) for p in polys if p and len(p) >= 8), default=0.0)
        page_w_in = img.width  / _DPI
        page_h_in = img.height / _DPI

        # Scale BEFORE orienting — orient uses the same scale. Prefer Azure's
        # own page size (exact); fall back to the heuristic only for jobs whose
        # polygons predate page_width/page_height capture.
        _pw, _ph = page_size_by_page.get(pn, (0.0, 0.0))
        unit_scale = _exact_polygon_scale(img, _pw, _ph, _DPI)
        if unit_scale is None:
            unit_scale = _detect_polygon_unit(img, polys, _DPI)
            logger.info(f"Job {job_id}: page {pn} has no Azure page size — guessed unit_scale={unit_scale}")
        unit_scale_by_page[pn] = unit_scale

        oriented = _orient_to_polygons(img, polys, _DPI, unit_scale=unit_scale)
        if oriented is not img:
            logger.info(
                f"Job {job_id}: page {pn} auto-rotated "
                f"({img.width}x{img.height} -> {oriented.width}x{oriented.height})"
            )
            pages[pn] = oriented

        diag.append(
            f"page {pn}: rendered {page_w_in:.2f}x{page_h_in:.2f} in @ {_DPI} DPI; "
            f"polygon extents max_x={max_x:.2f} max_y={max_y:.2f}; "
            f"unit_scale={unit_scale:.4f} ({len(polys)} polys)"
        )
    stats["diag"] = diag
    logger.info(f"Job {job_id}: per-page summary: {diag}")

    # ── Handwriting gate ──────────────────────────────────────────────────────
    # This model is for HANDWRITING, so printed name lists (typed rosters,
    # distributor sheets) must not enter the training set. Azure tags each cell
    # is_handwritten; we classify the DOCUMENT by the fraction of its NAME cells
    # that are handwritten — a clean bimodal signal (printed docs ~0%, handwritten
    # forms ~60-90%). Each crop is tagged; when CROP_HANDWRITTEN_ONLY=1 (default)
    # a printed document is skipped entirely. Jobs whose polygons predate this
    # capture have no flag → treated as "unknown" (kept, tagged null).
    _name_cells = [cp for cp in cell_polygons if cp.get("field_name") in name_fields]
    _has_hw_info = any(("handwritten" in cp) for cp in _name_cells)
    doc_handwritten = None
    if _has_hw_info and _name_cells:
        _hw_n = sum(1 for cp in _name_cells if cp.get("handwritten"))
        _frac = _hw_n / len(_name_cells)
        doc_handwritten = _frac >= 0.4
        stats["handwritten_doc"] = doc_handwritten
        stats["handwritten_name_frac"] = round(_frac, 2)
        if os.getenv("CROP_HANDWRITTEN_ONLY", "1") == "1" and not doc_handwritten:
            logger.info(f"Job {job_id}: PRINTED document (handwritten name cells "
                        f"{_hw_n}/{len(_name_cells)} = {_frac:.0%}) — skipping (handwriting-only mode)")
            stats["name_fields"] = sorted(name_fields)
            stats["error"] = "printed_document"
            return stats

    # ── Iterate name cells with polygons, crop, upload, insert ─────────────────
    from PIL import Image  # noqa
    for cp in cell_polygons:
        field_name = cp.get("field_name", "")
        if field_name not in name_fields:
            continue

        participant_index = cp.get("participant_index")
        polygon           = cp.get("polygon") or []
        page_no           = cp.get("page", 1)

        if (participant_index, field_name) in existing_keys:
            stats["skipped_existing"] += 1
            continue
        if not polygon or len(polygon) < 8:
            stats["skipped_no_polygon"] += 1
            continue
        page_img = pages.get(page_no)
        if page_img is None:
            stats["skipped_no_polygon"] += 1
            continue

        # OCR value (label) for this cell. Prefer the text captured alongside the
        # polygon (header-agnostic); fall back to structured_data for old jobs.
        cp_text = cp.get("text")
        if cp_text is not None:
            ocr_value = str(cp_text).strip()
        else:
            ocr_value = None
            if 0 <= participant_index < len(structured):
                ocr_value = (structured[participant_index] or {}).get(field_name)
            ocr_value = (str(ocr_value).strip() if ocr_value is not None else "")

        # Skip sparse / noise cells (empty, single char, pure digits/punct).
        # These are the source of "random character" crops — a name column is
        # rarely 100% filled, and cropping its blank rows pollutes the dataset.
        if not _looks_like_name_text(ocr_value):
            stats["skipped_empty_content"] += 1
            continue

        try:
            page_w_in, page_h_in = _page_size_inches(page_img, _DPI)
            box = _polygon_to_bbox_pixels(
                polygon, _DPI, page_w_in, page_h_in,
                unit_scale=unit_scale_by_page.get(page_no, 1.0),
            )
            if box is None:
                # Polygon out-of-page (rotation mismatch, garbage geometry);
                # logged and counted but not treated as an error.
                logger.debug(f"Skipped invalid bbox for ({participant_index}, {field_name})")
                stats["skipped_no_polygon"] += 1
                continue
            tl, tt, tr, tb = box
            cw, ch = tr - tl, tb - tt
            crop = page_img.crop(box)
            if crop.width < 10 or crop.height < 10:
                stats["skipped_no_polygon"] += 1
                continue

            # ── Context crop: the cell + a margin, for non-destructive editing ──
            # The inline editor edits against THIS wider image (never the tight
            # crop), so adjusting the box doesn't zoom/shrink the view and a
            # cut-off word can be recovered by expanding into the margin.
            pw, ph = page_img.width, page_img.height
            mx = max(int(cw * 0.6), 40)
            my = max(int(ch * 0.9), 24)
            cl, ct = max(0, tl - mx), max(0, tt - my)
            cr, cb = min(pw, tr + mx), min(ph, tb + my)
            context = page_img.crop((cl, ct, cr, cb))
            # Tight box within the context image (context pixels), before flip.
            ctx_box = {"x": tl - cl, "y": tt - ct, "w": cw, "h": ch}

            # Orientation correction: the bbox-fit orient above aligns the page
            # to polygon space, but it cannot tell which way the TEXT reads —
            # a page scanned sideways or upside-down still yields rotated crops
            # that trainers have to tilt their head to read. Azure measures the
            # true content angle per page, so undo it here for every quarter
            # turn (90/180/270), carrying the editor's box through the same
            # transform.
            _ccw = _upright_quarter_turn(page_angle_by_page.get(page_no, 0.0))
            if _ccw:
                crop, context, ctx_box = _rotate_with_box(crop, context, ctx_box, _ccw)

            buf = io.BytesIO()
            crop.save(buf, format="PNG", optimize=True)
            crop_bytes = buf.getvalue()
            cbuf = io.BytesIO()
            context.save(cbuf, format="PNG", optimize=True)
            context_bytes = cbuf.getvalue()

            slug         = _slugify_field(field_name)
            crop_path    = f"{job_id}/{participant_index}_{slug}.png"
            context_path = f"{job_id}/{participant_index}_{slug}_ctx.png"

            # Upload — overwrite is safe since we already filtered duplicates above
            supabase.storage.from_("training_crops").upload(
                crop_path, crop_bytes, {"content-type": "image/png", "upsert": "true"})
            supabase.storage.from_("training_crops").upload(
                context_path, context_bytes, {"content-type": "image/png", "upsert": "true"})

            # Insert the row. A duplicate-key (23505) means another run already
            # created this exact (job_id, participant_index, field_name) — count
            # it as a skip, not an error, so concurrent/repeat re-crops stay
            # idempotent instead of flooding the stats with false "errors".
            # Migration-safe: if the context columns don't exist yet (025 not
            # applied), retry the insert without them.
            _row = {
                "job_id":            job_id,
                "participant_index": participant_index,
                "field_name":        field_name,
                "crop_path":         crop_path,
                "context_path":      context_path,
                "context_box":       ctx_box,
                "handwritten":       doc_handwritten,   # True / False / None(unknown)
                "ocr_output":        ocr_value or None,
                "label":             ocr_value or None,   # initialise to OCR; admin edits to fix
                "status":            "pending",
            }
            try:
                supabase.table("training_dataset").insert(_row).execute()
                stats["created"] += 1
            except Exception as ins_err:
                msg = str(ins_err)
                if "23505" in msg or "duplicate key" in msg:
                    stats["skipped_existing"] += 1
                elif "context_path" in msg or "context_box" in msg or "handwritten" in msg:
                    _row.pop("context_path", None); _row.pop("context_box", None); _row.pop("handwritten", None)
                    try:
                        supabase.table("training_dataset").insert(_row).execute()
                        stats["created"] += 1
                    except Exception as e2:
                        if "23505" in str(e2) or "duplicate key" in str(e2):
                            stats["skipped_existing"] += 1
                        else:
                            raise
                else:
                    raise
        except Exception as e:
            err_msg = f"({participant_index}, {field_name!r}): {type(e).__name__}: {e}"
            logger.warning(f"Crop failed for {err_msg}")
            stats["errors"] += 1
            if len(stats["error_samples"]) < 3:
                stats["error_samples"].append(str(err_msg)[:300])

    # Annotate which columns we considered name columns + which (if any) were
    # detected by content. Powers a useful error message on the UI when 0 rows
    # were produced.
    stats["name_fields"] = sorted(name_fields)
    if not name_fields and stats["created"] == 0 and not stats.get("error"):
        stats["error"] = "no_name_columns_detected"
    # Name column(s) found, but every cell was empty / noise (no real names).
    elif (
        stats["created"] == 0
        and stats["skipped_empty_content"] > 0
        and stats["skipped_no_polygon"] == 0
        and stats["errors"] == 0
        and not stats.get("error")
    ):
        stats["error"] = "all_cells_empty"
    # All eligible cells skipped due to bad geometry → likely rotation mismatch.
    elif (
        stats["created"] == 0
        and stats["skipped_no_polygon"] > 0
        and stats["errors"] == 0
        and not stats.get("error")
    ):
        stats["error"] = "rotation_mismatch"

    logger.info(
        f"Done | created={stats['created']} skipped_existing={stats['skipped_existing']} "
        f"skipped_no_polygon={stats['skipped_no_polygon']} "
        f"skipped_empty_content={stats['skipped_empty_content']} errors={stats['errors']} "
        f"name_fields={stats['name_fields']}"
    )
    return stats


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python execution/crop_names.py <job_id>")
        sys.exit(1)
    result = crop_job_names(sys.argv[1])
    print(result)
