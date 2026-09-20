"""
Tool: extract_gemini_ocr
Primary OCR engine — extracts text from Arabic documents using Gemini Flash vision.

Accuracy improvements over baseline:
  1. 300 DPI rasterization (was 144 DPI) — sharper input for ambiguous characters
  2. thinking_budget=2048 — enables Gemini reasoning on difficult handwriting
  3. Prompt tuned for Palestinian Arabic forms with character confusion guidance
  4. 2-pass OCR: Pass 1 raw extraction → Pass 2 targeted name-correction re-verification
  5. Conservative corrector (_safe_to_apply): rejects digit changes, column-count shifts,
     normalization-only edits, and tokens absent from the Palestinian name dictionary
  6. Repeated-token detection: flags names where a content token appears more than once
  7. Consonant skeleton comparison: strips harakat/hamza/alef variants for phonetic matching

Auth:  GEMINI_API_KEY
Models (env vars exposed for cost tuning, but safe defaults below):
  GEMINI_OCR_MODEL              full-page OCR pass        (default: gemini-2.5-flash)
  GEMINI_OCR_THINKING_BUDGET    full-page thinking budget (default: 512)
  GEMINI_MODEL                  targeted name-correction  (default: gemini-2.5-flash)
Flags: GEMINI_OCR_CORRECTION=0 disables the name-correction pass (default: enabled)

Cost-tuning note: gemini-2.5-flash-lite + thinking_budget=0 was tested and
catastrophically broke structured output (0 pipe-separated rows, 32k words of
unformatted dump). Do not use that combination. If reducing cost, prefer
keeping the model and lowering thinking_budget gradually (try 256, then 128).

Return format (compatible with extract_azure.py):
    {
        "success":      bool,
        "full_text":    str,   # all pages joined with "\\n\\n"
        "grid_text":    str,   # same as full_text — Gemini formats table rows with | separators
        "spatial_text": str,   # empty — Gemini does not produce bounding-box output
        "pages": [
            {"page_number": int, "full_text": str, "confidence": None}
        ],
        "raw_response": {"model": str, "pages": int},
        "error":        str | None,
        "provider":     "gemini_ocr",
    }
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# ── OCR prompt — tuned for handwritten Palestinian Arabic registration forms ──
# The name hints that used to sit inside this prompt were lifted out to
# data/name_hints.json, which is withheld from the repository for the same
# reason as the name lexicons: it is distilled from customer documents. The
# pipeline runs without it and simply omits the hint, the same way
# place_lexicon and ocr_voter fall back to empty lexicons. Local-name accuracy
# drops when it is missing and nothing errors, so check the file is on disk
# before deploying -- Modal ships the working tree, not git.
_OCR_PROMPT = (
    "You are an expert Arabic OCR system specialising in handwritten Palestinian "
    "participant registration forms from the Gaza Strip (Khan Yunis area).\n\n"
    "CRITICAL rules:\n"
    "- Extract ALL text exactly as written — character-for-character, row-by-row\n"
    "- Phone numbers: ALWAYS write the full 10-digit number as a single unbroken string "
    "(no spaces, no dashes). Example: if the cell shows '059 111 2223' write '0591112223'. "
    "Palestinian phones always start with 059 or 056 and have exactly 10 digits.\n"
    "- For tables: output each row on its own line with columns separated by  |  \n"
    "- Empty cells: if a cell has NO visible handwriting at all → leave it blank between | separators\n"
    "  (two consecutive || or nothing at the row end). NEVER copy a value from another row.\n"
    "- Signature cells (التوقيع, توقيع, إمضاء): if the cell contains only a handwritten mark/scrawl "
    "that is NOT a readable name → leave it blank. Do NOT write the person's name there.\n"
    "- Use Arabic characters only — never substitute Persian/Urdu variants:\n"
    "    Arabic ي (ya)  ≠  Persian ی  |  Arabic ك (kaf)  ≠  Persian ک\n"
    "    Arabic ه (ha)  ≠  Persian ہ  |  Arabic ة (ta marbuta) — always preserve it\n"
    "- Names are quadruple (4 parts): given + father + grandfather + family name\n"
    "- Read Arabic right-to-left; name column is usually first\n"
    "- Include every row and cell, even partially legible ones\n\n"
    "Output the extracted text only. No explanations, no markdown."
)

# ── Name-correction prompt ─────────────────────────────────────────────────────
# Deliberately conservative — Gemini must NOT "improve" text, only fix clear misreads.
_CORRECTION_PROMPT = (
    "You are checking Arabic OCR output from a Palestinian registration form.\n\n"
    "For each row below: look at the image and decide if any Arabic name was clearly misread.\n\n"
    "STRICT rules — read carefully:\n"
    "- If a name token is CLEARLY wrong and you can confidently read a DIFFERENT name "
    "in the image → replace ONLY that token\n"
    "- If you are NOT 100% sure about a correction → return the row EXACTLY as given\n"
    "- Do NOT add or remove hamza (أ/إ/ا), alef, or any diacritics\n"
    "- Do NOT change spelling unless the word is completely different in the image\n"
    "- Do NOT change phone numbers, dates, gender, or any non-name columns\n"
    "- Do NOT invent names — only write what you can clearly read in the image\n"
    "- Keep | as column separator; return the SAME number of rows in the SAME order\n\n"
    "Rows to check:\n{rows}\n\n"
    "Return each row on its own line. If a row is correct or you are unsure, copy it unchanged."
)

# -- Lazy prompt hints --------------------------------------------------------
_PROMPT_HINTS: str | None = None


def _load_prompt_hints() -> str:
    """The corpus-derived name hint, or "" when the data file is absent.

    Returns a string rather than raising: a missing hint file must cost
    accuracy, not stop the pipeline.
    """
    global _PROMPT_HINTS
    if _PROMPT_HINTS is not None:
        return _PROMPT_HINTS
    _PROMPT_HINTS = ""
    comma = "\u060c "
    try:
        with open(Path(__file__).parent / "data" / "name_hints.json", encoding="utf-8") as f:
            d = json.load(f)
        block = str(d.get("hint_block") or "")
        if block:
            # The block reproduces the prompt exactly as it was when the hint
            # lived inline, wrapping included. The arrays below rebuild an
            # equivalent hint if it is ever absent.
            _PROMPT_HINTS = block
            return _PROMPT_HINTS
        first  = [str(x).strip() for x in (d.get("first_names")  or []) if str(x).strip()]
        family = [str(x).strip() for x in (d.get("family_names") or []) if str(x).strip()]
        parts = []
        if first:
            parts.append("Common first names: " + comma.join(first) + "\n\n")
        if family:
            parts.append("Common family names in this area (spell carefully):\n  "
                         + comma.join(family) + "\n\n")
        _PROMPT_HINTS = "".join(parts)
        logger.debug(f"[GeminiOCR] Prompt hints: {len(first)} given, {len(family)} family")
    except FileNotFoundError:
        logger.info("[GeminiOCR] data/name_hints.json absent - prompting without name hints")
    except Exception as e:
        logger.warning(f"[GeminiOCR] Could not read name_hints.json ({e}) - no name hints")
    return _PROMPT_HINTS


def _ocr_prompt() -> str:
    """The OCR prompt, with the corpus hint spliced in before the closing line."""
    hints = _load_prompt_hints()
    if not hints:
        return _OCR_PROMPT
    tail = "Output the extracted text only."
    return _OCR_PROMPT.replace(tail, hints + tail, 1)


# ── Lazy name dictionary ──────────────────────────────────────────────────────
_NAME_LIST: list[str] | None = None   # list for difflib compatibility


def _load_name_list() -> list[str]:
    global _NAME_LIST
    if _NAME_LIST is not None:
        return _NAME_LIST
    data_dir = Path(__file__).parent / "data"
    names: set[str] = set()
    for fname in ("arabic_names_female.json", "arabic_names_male.json", "arabic_family_names.json"):
        try:
            with open(data_dir / fname, encoding="utf-8") as f:
                entries = json.load(f)
            if isinstance(entries, list):
                names.update(str(e).strip() for e in entries if e)
            elif isinstance(entries, dict):
                names.update(str(k).strip() for k in entries)
        except Exception:
            pass
    _NAME_LIST = list(names)
    logger.debug(f"[GeminiOCR] Loaded {len(_NAME_LIST)} name entries")
    return _NAME_LIST


# ── Public API ─────────────────────────────────────────────────────────────────

def extract_gemini_ocr(image_bytes: bytes, source_label: str = "<bytes>") -> dict:
    """
    Extract text from a document (PDF or image) using Gemini Flash vision.

    PDFs are rasterized to 300 DPI PNG pages using PyMuPDF.
    Runs an automatic name-correction pass when suspicious names are detected.
    """
    start = time.time()

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return _fail("GEMINI_API_KEY not set — Gemini OCR unavailable")

    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError:
        return _fail("google-genai not installed. Run: pip install google-genai")

    client     = genai.Client(api_key=api_key)
    # Round 1 (full-page OCR). flash + thinking is the proven safe default;
    # flash-lite without thinking was tested and produced 0 structured rows.
    model_name = os.getenv("GEMINI_OCR_MODEL", "gemini-2.5-flash")

    # ── Rasterize PDF or wrap single image ──────────────────────────────────────
    is_pdf = image_bytes[:4] == b"%PDF"
    if is_pdf:
        page_images = _pdf_to_images(image_bytes)
        if page_images is None:
            return _fail("PDF rasterization failed — ensure PyMuPDF is installed: pip install pymupdf")
        logger.info(f"[GeminiOCR] Rasterized {len(page_images)} page(s) at 300 DPI | source={source_label}")
    else:
        page_images = [image_bytes]

    # ── Preprocess each page before OCR ─────────────────────────────────────────
    if os.getenv("GEMINI_PREPROCESS", "1") == "1":
        page_images = [_preprocess_page(p) for p in page_images]
        logger.info(f"[GeminiOCR] Preprocessing applied to {len(page_images)} page(s)")

    # ── OCR each page ────────────────────────────────────────────────────────────
    pages: list[dict] = []
    page_texts: list[str] = []
    _quota_pages: list[int] = []  # pages that hit daily quota

    for i, page_bytes in enumerate(page_images, start=1):
        page_text = _ocr_page(client, model_name, page_bytes, genai_types, i, len(page_images),
                              quota_hits=_quota_pages)
        pages.append({"page_number": i, "full_text": page_text, "confidence": None})
        page_texts.append(page_text)

    full_text = "\n\n".join(t for t in page_texts if t)

    # ── Quota guard: if ALL pages failed due to daily quota, return failure ───
    # This prevents the pipeline silently falling back to Azure's corrupted
    # output when Gemini returns success=True but empty text after quota exhaust.
    if _quota_pages and not full_text.strip():
        logger.error(
            f"[GeminiOCR] All {len(page_images)} page(s) hit daily quota — returning failure "
            f"so pipeline can surface a clear error instead of silently using Azure fallback"
        )
        return {
            "success":      False,
            "full_text":    "",
            "grid_text":    "",
            "spatial_text": "",
            "pages":        pages,
            "raw_response": {"model": model_name, "pages": len(pages)},
            "error":        (
                "Gemini OCR daily quota exhausted "
                f"(free tier: 20 requests/day, model: {model_name}). "
                "Please try again after midnight (Pacific Time) or upgrade your Gemini API plan."
            ),
            "provider":     "gemini_ocr",
        }

    # ── Automatic name-correction pass ───────────────────────────────────────────
    if os.getenv("GEMINI_OCR_CORRECTION", "1") == "1" and full_text:
        full_text = _name_correction_pass(client, model_name, genai_types, full_text, page_images)
        if len(pages) == 1:
            pages[0]["full_text"] = full_text

    elapsed    = round((time.time() - start) * 1000)
    word_count = len(full_text.split())

    logger.info(
        f"[GeminiOCR] Done | source={source_label} | pages={len(pages)} | "
        f"words={word_count} | chars={len(full_text)} | {elapsed}ms"
    )

    return {
        "success":      True,
        "full_text":    full_text,
        "grid_text":    full_text,
        "spatial_text": "",
        "pages":        pages,
        "raw_response": {"model": model_name, "pages": len(pages)},
        "error":        None,
        "provider":     "gemini_ocr",
    }


# ── Internal helpers ───────────────────────────────────────────────────────────

def _ocr_page(
    client, model_name: str, page_bytes: bytes, genai_types,
    page_num: int, total: int,
    quota_hits: list | None = None,
) -> str:
    """Send one page to Gemini and return extracted text.
    Retries once after 35 seconds on 429 (rate limit) before giving up.
    When daily quota is hit, appends page_num to quota_hits (if provided).
    """
    thinking_budget = int(os.getenv("GEMINI_OCR_THINKING_BUDGET", "512"))

    for attempt in range(2):
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_bytes(data=page_bytes, mime_type="image/png"),
                    _ocr_prompt(),
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0,
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=thinking_budget),
                ),
            )
            text = (resp.text or "").strip()
            logger.info(f"[GeminiOCR] Page {page_num}/{total} | words={len(text.split())}")
            return text

        except Exception as e:
            err = str(e)
            is_rate_limit = "429" in err
            is_daily_quota = "PerDay" in err or "per_day" in err.lower()
            if is_rate_limit and not is_daily_quota and attempt == 0:
                logger.warning(f"[GeminiOCR] Page {page_num}/{total} rate-limited (per-min) — retrying in 35s")
                time.sleep(35)
                continue
            if is_rate_limit and is_daily_quota:
                logger.warning(f"[GeminiOCR] Page {page_num}/{total} — daily quota exhausted, cannot retry")
                if quota_hits is not None:
                    quota_hits.append(page_num)
            else:
                logger.warning(f"[GeminiOCR] Page {page_num}/{total} failed: {e}")
            return ""

    return ""


def _pdf_to_images(pdf_bytes: bytes) -> list[bytes] | None:
    """Rasterize PDF to PNG bytes at 300 DPI using PyMuPDF."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        images = []
        for page in doc:
            mat = fitz.Matrix(300 / 72, 300 / 72)  # 300 DPI
            pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
            images.append(pix.tobytes("png"))
        doc.close()
        return images
    except Exception as e:
        logger.error(f"[GeminiOCR] PDF rasterization error: {e}")
        return None


def _preprocess_page(page_bytes: bytes) -> bytes:
    """
    Lightweight preprocessing for Gemini vision OCR.

    Pipeline (order matters):
      1. EXIF rotation  — fixes phone photos taken sideways
      2. Grayscale      — halves file size; Gemini reads grayscale well
      3. Denoise        — 3×3 median filter removes scanner speckle before sharpening
      4. Autocontrast   — stretches histogram (handles dark/faded scans)
      5. Unsharp mask   — crisp Arabic strokes + dots without halos
      6. Deskew         — corrects page tilt ±0.5°–15° using ink-pixel PCA

    NOT applied (deliberately):
      - Binarization: destroys the gray gradient Gemini uses to reason about
        ambiguous handwritten characters (thin strokes vs thick, etc.)
      - Upscale: we already rasterize at 300 DPI — no benefit to going higher

    Controlled by env var GEMINI_PREPROCESS (default 1). Set to 0 to disable.
    Returns original bytes unchanged if Pillow unavailable or processing fails.
    """
    try:
        import io as _io
        from PIL import Image, ImageFilter, ImageOps

        img = Image.open(_io.BytesIO(page_bytes))

        # 1. EXIF rotation — phone photos may be sideways
        img = ImageOps.exif_transpose(img)

        # 2. Grayscale
        if img.mode != "L":
            if img.mode not in ("RGB", "RGBA", "L"):
                img = img.convert("RGB")
            img = img.convert("L")

        # 3. Denoise — remove scanner speckle before sharpening amplifies it
        img = img.filter(ImageFilter.MedianFilter(size=3))

        # 4. Autocontrast — stretch per-image histogram, clip 1% tails
        img = ImageOps.autocontrast(img, cutoff=1)

        # 5. Unsharp mask — sharpen Arabic strokes and diacritic dots
        #    radius=1.5 targets thin strokes (~4–8 px wide at 300 DPI)
        #    percent=150 is enough to crisp edges without halos
        #    threshold=4 skips smooth background regions
        img = img.filter(ImageFilter.UnsharpMask(radius=1.5, percent=150, threshold=4))

        # 6. Deskew — correct page tilt via ink-pixel PCA (numpy required)
        img = _deskew_pil(img)

        buf = _io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        result = buf.getvalue()
        logger.debug(f"[GeminiOCR] Preprocessed: {len(page_bytes):,} → {len(result):,} bytes")
        return result

    except Exception as e:
        logger.warning(f"[GeminiOCR] Preprocessing failed (using original): {e}")
        return page_bytes


def _deskew_pil(img) -> object:
    """
    Detect and correct page tilt using ink-pixel PCA (numpy).
    Corrects tilts between ±0.5° and ±15°.
    Returns original image unchanged if numpy is unavailable or tilt is outside range.
    """
    try:
        import math
        import numpy as np
        from PIL import Image

        data  = np.array(img)
        # Ink pixels are darker than 200 on a white background
        ink   = (data < 200).astype(np.uint8)
        coords = np.column_stack(np.where(ink > 0))
        if len(coords) < 200:
            return img   # too sparse — skip

        cf     = coords.astype(np.float32)
        mean   = cf.mean(axis=0)
        cov    = np.cov((cf - mean).T)
        _, evecs = np.linalg.eigh(cov)
        dom    = evecs[:, -1]                          # principal eigenvector
        angle  = math.degrees(math.atan2(dom[0], dom[1]))

        if abs(angle) < 0.5 or abs(angle) > 15:
            return img   # not worth correcting

        logger.debug(f"[GeminiOCR] Deskewing {angle:.2f}°")
        return img.rotate(-angle, expand=True, fillcolor=255)

    except Exception:
        return img


# ── Name-validation helpers ────────────────────────────────────────────────────

# Persian/Urdu codepoints that don't belong in Palestinian Arabic text
_PERSIAN_CHARS = frozenset("یکہے")

# Arabic particles that appear inside compound names — never flag these
_NAME_PARTICLES = frozenset({
    "أبو", "ابو", "أبي", "ابي", "عبد", "بنت", "بن", "ابن", "آل",
    "أم", "ام", "الله", "الدين", "الحق", "الرحمن", "دية", "عطا",
})

# Arabic common words that are definitely NOT person names
_NON_NAME_WORDS = frozenset({
    "اسم", "رقم", "الهاتف", "التاريخ", "العمر", "الجنس", "العنوان",
    "ملاحظات", "المجموع", "الرقم", "التسلسل", "الفساد", "الباب",
    "نعم", "لا", "ذكر", "أنثى", "المشروع", "المنظمة", "المستفيد",
})


def _has_repeated_tokens(name: str) -> bool:
    """
    Return True if a content token (non-particle, len >= 2) appears more than once.

    Detects OCR duplication artifacts, e.g.:
      'محمد محمد أحمد عبدالله'  ← محمد repeated
      'عبد عبد الرحمن عبدالله'  ← particles excluded, عبد×2 flags nothing

    Called from both _is_suspicious_token() and _score_name().
    """
    tokens  = name.split()
    content = [t for t in tokens if t not in _NAME_PARTICLES and len(t) >= 2]
    return len(content) != len(set(content))


def _is_suspicious_token(token: str, name_list: list[str]) -> bool:
    """
    Conservative check: returns True only when a token is clearly wrong.
    False positives (flagging a valid but rare name) are worse than missing errors.

    Checks (in order):
      1. Non-Arabic content (< 60 % Arabic chars) — skip
      2. Non-name vocabulary word in name cell
      3. Persian/Urdu character (ی ک ہ ے) — definitive OCR confusion
      4. Exact dictionary hit — valid
      5. Fuzzy dictionary match ≥ 0.72 — valid
      6. No match at all for a name-length token (3–15 chars) — suspicious
    """
    if not token or len(token) < 2:
        return False

    # Must be mostly Arabic
    arabic_chars = sum(1 for c in token if "\u0600" <= c <= "\u06FF")
    if arabic_chars / len(token) < 0.6:
        return False

    # Known non-name word appearing in name column → wrong
    if token in _NON_NAME_WORDS:
        return True

    # Common name particles (أبو، عبد، بن…) — always valid in Arabic names
    if token in _NAME_PARTICLES:
        return False

    # Contains Persian/Urdu characters → OCR confusion, definitely wrong
    if any(c in _PERSIAN_CHARS for c in token):
        return True

    # Exact match in dictionary → fine
    if token in set(name_list):
        return False

    # Fuzzy match: if a close name exists it was probably read correctly
    import difflib
    close = difflib.get_close_matches(token, name_list, n=1, cutoff=0.72)
    if close:
        return False

    # No match at all for a name-length token → suspicious
    return 3 <= len(token) <= 15


def _is_suspicious_row(line: str, name_list: list[str]) -> bool:
    """
    Extends per-token checking to the full name cell of a pipe-separated row.
    Also catches repeated-token artifacts that per-token checks would miss.
    """
    if "|" not in line:
        return False
    cols = [c.strip() for c in line.split("|")]
    for col in cols[:3]:
        if not col:
            continue
        arabic_frac = sum(1 for c in col if "\u0600" <= c <= "\u06FF") / max(len(col), 1)
        if arabic_frac < 0.5:
            continue
        # Per-token suspicious check
        if any(_is_suspicious_token(tok, name_list) for tok in col.split()):
            return True
        # Repeated non-particle token in a single name cell
        if _has_repeated_tokens(col):
            return True
    return False


def _consonant_skeleton(text: str) -> str:
    """
    Canonical phonetic form for comparison: normalises alef family, ya, ta-marbuta,
    strips all harakat/shadda/sukun, and removes whitespace + zero-width chars.

    Used in two places:
      - _safe_to_apply(): detect normalisation-only corrections that should be skipped
      - arbitrate_cell(): detect phonetically-equivalent readings between engines
    """
    t = text.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ٱ", "ا")
    t = t.replace("ى", "ي")
    t = t.replace("ة", "ه")                                  # ta marbuta ≡ ha for skeleton
    t = re.sub(r"[\u064B-\u065F\u0670]", "", t)              # strip harakat + superscript alef
    t = re.sub(r"[\s\u200c\u200d\u00a0]", "", t)             # strip whitespace + ZW chars
    return t


def _safe_to_apply(orig: str, corr: str, name_list: list[str]) -> tuple[bool, str]:
    """
    Gate before applying a Gemini correction.
    Returns (should_apply: bool, reason: str).

    Rejects:
    - Identical rows (no actual change)
    - Normalization-only changes (hamza, alef, diacritics)
    - Column count changes (Gemini added/removed | separators)
    - Digit changes (phone numbers, dates are protected)
    - Corrections that introduce new tokens not found in any name dictionary
    """
    orig = orig.strip()
    corr = corr.strip()

    if not corr:
        return False, "empty correction"

    if orig == corr:
        return False, "identical — no change"

    # Normalization-only (hamza, alef, diacritics) — skip silently
    if _consonant_skeleton(orig) == _consonant_skeleton(corr):
        return False, "normalization-only (hamza/alef/diacritics) — not applied"

    # Column count must be identical
    if orig.count("|") != corr.count("|"):
        return False, f"column count changed ({orig.count('|')+1} → {corr.count('|')+1}) — rejected"

    # Digits (phone numbers, dates) must be unchanged
    orig_digits = re.sub(r"\D", "", orig)
    corr_digits = re.sub(r"\D", "", corr)
    if orig_digits != corr_digits:
        return False, "digits changed (phone/date protected) — rejected"

    # Any NEW Arabic content in name columns must be verifiable in the dictionary.
    # Rules for corrections (stricter than OCR-scan rules):
    # 1. Exact match in dictionary → OK
    # 2. Name particle (ابو، عبد…) → OK
    # 3. Part of a known multi-word family name (e.g. "زيد" in "ابو زيد") → OK
    # 4. NO fuzzy matching — too risky with a 30K+ name list (طاطة ≈ طماطة at 0.89)
    name_set       = set(name_list)
    multi_names    = [n for n in name_set if " " in n]   # e.g. "ابو زيد"
    multi_parts    = {part for mn in multi_names for part in mn.split()}  # individual parts

    orig_cols = orig.split("|")
    corr_cols = corr.split("|")
    for i in range(min(3, len(orig_cols))):
        o_col = orig_cols[i].strip()
        c_col = corr_cols[i].strip()
        if o_col == c_col:
            continue
        orig_tokens = set(o_col.split())
        corr_tokens = set(c_col.split())
        new_tokens  = corr_tokens - orig_tokens
        for tok in new_tokens:
            if len(tok) < 2:
                continue
            ar = sum(1 for c in tok if "\u0600" <= c <= "\u06FF")
            if ar / max(len(tok), 1) < 0.5:
                continue   # not Arabic — skip
            if tok in _NAME_PARTICLES:
                continue
            if tok in name_set:
                continue   # exact single-word hit
            if tok in multi_parts:
                continue   # part of a known compound name (e.g. "زيد" from "ابو زيد")
            return False, f"introduced unverified token '{tok}' — rejected"

    return True, "ok"


def _name_correction_pass(
    client, model_name: str, genai_types,
    full_text: str,
    page_images: list[bytes],
) -> str:
    """
    Scan OCR output for suspicious name tokens.
    When found, make one targeted Gemini call to re-verify those rows.
    Each proposed correction is validated before being applied.
    """
    name_list = _load_name_list()
    if not name_list:
        return full_text

    lines = full_text.splitlines()

    suspicious_rows: list[str] = []
    suspicious_idxs: list[int] = []

    for idx, line in enumerate(lines):
        # _is_suspicious_row() checks per-token AND repeated-token artifacts
        if _is_suspicious_row(line, name_list):
            suspicious_rows.append(line)
            suspicious_idxs.append(idx)

    if not suspicious_rows:
        logger.info("[GeminiOCR] Name validation: all names look plausible — no correction pass needed")
        return full_text

    # Targeted correction pass uses the better model (flash + thinking) since
    # it only fires on suspicious rows — much smaller volume than full-page OCR,
    # and quality matters more here. Independent of GEMINI_OCR_MODEL.
    correction_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    logger.info(
        f"[GeminiOCR] Name validation: {len(suspicious_rows)} suspicious row(s) → "
        f"correction pass on {correction_model}"
    )

    prompt   = _CORRECTION_PROMPT.format(rows="\n".join(suspicious_rows))
    contents = [genai_types.Part.from_bytes(data=img, mime_type="image/png") for img in page_images]
    contents.append(prompt)

    try:
        for attempt in range(2):
            try:
                resp = client.models.generate_content(
                    model=correction_model,
                    contents=contents,
                    config=genai_types.GenerateContentConfig(
                        temperature=0,
                        thinking_config=genai_types.ThinkingConfig(thinking_budget=1024),
                    ),
                )
                break
            except Exception as e:
                err = str(e)
                is_daily = "PerDay" in err or "per_day" in err.lower()
                if "429" in err and not is_daily and attempt == 0:
                    logger.warning("[GeminiOCR] Correction pass rate-limited — retrying in 35s")
                    time.sleep(35)
                    continue
                raise

        corrected_text  = (resp.text or "").strip()
        if not corrected_text:
            return full_text

        corrected_lines = [l.strip() for l in corrected_text.splitlines() if l.strip()]

        applied = rejected = 0
        for orig, corr in zip(suspicious_rows, corrected_lines):
            apply, reason = _safe_to_apply(orig, corr, name_list)
            if apply:
                full_text = full_text.replace(orig, corr, 1)
                logger.info(f"[GeminiOCR] Applied correction: «{orig[:50]}» → «{corr[:50]}»")
                applied += 1
            else:
                logger.info(f"[GeminiOCR] Rejected correction ({reason}): «{corr[:50]}»")
                rejected += 1

        logger.info(f"[GeminiOCR] Correction pass done — applied={applied} rejected={rejected}")
        return full_text

    except Exception as e:
        logger.warning(f"[GeminiOCR] Correction pass failed (using original): {e}")
        return full_text


def _fail(error: str) -> dict:
    return {
        "success":      False,
        "full_text":    "",
        "grid_text":    "",
        "spatial_text": "",
        "pages":        [],
        "raw_response": {},
        "error":        error,
        "provider":     "gemini_ocr",
    }
