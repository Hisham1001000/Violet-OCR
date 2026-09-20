"""
Tool: extract_azure
Azure Document Intelligence OCR — extracts text from Arabic documents.

Uses the prebuilt-read model which is optimized for printed/handwritten text,
returning per-word confidence scores and polygon bounding boxes.

Auth:  AZURE_DI_ENDPOINT + AZURE_DI_KEY environment variables
Model: prebuilt-read

Return format (compatible with extract_gemini_ocr.py):
    {
        "success":        bool,
        "full_text":      str,   # all pages joined with "\\n\\n"
        "grid_text":      str,   # pipe-separated rows (best Azure has)
        "markdown_text":  str,   # native Azure markdown table format
        "annotated_text": str,   # full_text with [?] on low-confidence words
        "spatial_text":   str,   # same as full_text
        "pages": [
            {
                "page_number": int,
                "full_text":   str,
                "confidence":  float,   # average word confidence for this page
                "width":       float,   # page width in inches
                "height":      float,   # page height in inches
                "lines":  [{"content": str, "polygon": list[float]}],
                "words":  [{"content": str, "confidence": float, "polygon": list[float]}],
            }
        ],
        "raw_response": {"model": str, "pages": int},
        "error":        str | None,
        "provider":     "azure",
    }
"""

from __future__ import annotations

import io
import logging
import os

logger = logging.getLogger(__name__)


def extract_azure(pdf_bytes: bytes, source_label: str = "<bytes>") -> dict:
    """
    Extract text from a PDF using Azure Document Intelligence prebuilt-read.

    Returns per-page confidence, bounding-box polygons, and four text formats:
      - full_text:      linear text (pages joined with double newline)
      - grid_text:      pipe-separated table rows (same as full_text for Azure)
      - markdown_text:  Azure's native markdown table output (best for structured forms)
      - annotated_text: full_text with [?] appended to words with confidence < 0.80
    """
    endpoint = os.getenv("AZURE_DI_ENDPOINT", "").rstrip("/")
    key      = os.getenv("AZURE_DI_KEY", "")

    if not endpoint or not key:
        return _fail("AZURE_DI_ENDPOINT or AZURE_DI_KEY not set — Azure OCR unavailable")

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
        )

        poller = client.begin_analyze_document(
            "prebuilt-read",
            io.BytesIO(pdf_bytes),
            content_type="application/pdf",
        )
        result = poller.result()

    except Exception as e:
        return _fail(f"Azure Document Intelligence API error: {e}")

    # ── Parse per-page output ────────────────────────────────────────────────────
    pages_data: list[dict] = []
    all_page_texts:      list[str] = []
    all_annotated_texts: list[str] = []

    for page in (result.pages or []):
        page_num   = page.page_number
        page_words = page.words or []
        page_lines = page.lines or []

        # Collect word-level data
        words_out: list[dict] = []
        word_texts:      list[str] = []
        annotated_words: list[str] = []

        for word in page_words:
            content    = (word.content or "").strip()
            confidence = word.confidence if word.confidence is not None else 1.0
            polygon    = list(word.polygon) if word.polygon else []

            words_out.append({
                "content":    content,
                "confidence": round(confidence, 4),
                "polygon":    polygon,
            })
            word_texts.append(content)
            annotated_words.append(content if confidence >= 0.80 else f"{content}[?]")

        # Collect line-level data
        lines_out: list[dict] = []
        for line in page_lines:
            lines_out.append({
                "content": (line.content or "").strip(),
                "polygon": list(line.polygon) if line.polygon else [],
            })

        # Per-page confidence: average of word confidences
        word_confs = [w["confidence"] for w in words_out if w["confidence"] is not None]
        avg_conf   = round(sum(word_confs) / len(word_confs), 4) if word_confs else 0.0

        page_text     = " ".join(word_texts)
        annotated_txt = " ".join(annotated_words)

        all_page_texts.append(page_text)
        all_annotated_texts.append(annotated_txt)

        pages_data.append({
            "page_number": page_num,
            "full_text":   page_text,
            "confidence":  avg_conf,
            "width":       page.width  or 0.0,
            "height":      page.height or 0.0,
            "lines":       lines_out,
            "words":       words_out,
        })

    full_text      = "\n\n".join(t for t in all_page_texts      if t)
    annotated_text = "\n\n".join(t for t in all_annotated_texts if t)

    # ── Build markdown text from Azure's native table/content output ─────────────
    # result.content is Azure's best-effort markdown representation of the document,
    # including table structures with | separators for structured forms.
    markdown_text = (result.content or "").strip()

    # ── Build name-column pipe rows from spatial polygon data ───────────────────
    # prebuilt-read produces no table structure, so we extract the name column
    # spatially: lines whose x-center falls in the right 40% of the page
    # (Arabic RTL layout — name column is on the right side).
    # This produces pipe-separated rows that _raw_names_from_pipe() can parse.
    grid_text = _build_name_pipe_rows(pages_data)
    if not grid_text:
        grid_text = full_text   # fallback: no structured rows found

    word_count = len(full_text.split())
    name_rows  = sum(1 for l in grid_text.splitlines() if "|" in l)
    logger.info(
        f"[Azure] Done | source={source_label} | pages={len(pages_data)} | "
        f"words={word_count} | chars={len(full_text)} | name_rows={name_rows}"
    )

    return {
        "success":        True,
        "full_text":      full_text,
        "grid_text":      grid_text,      # pipe-separated name-column rows
        "markdown_text":  markdown_text,
        "annotated_text": annotated_text,
        "spatial_text":   full_text,
        "pages":          pages_data,
        "raw_response":   {"model": "prebuilt-read", "pages": len(pages_data)},
        "error":          None,
        "provider":       "azure",
    }


def _build_name_pipe_rows(pages_data: list) -> str:
    """Extract name-column text from Azure line polygons as pipe-separated rows.

    Arabic registration forms are RTL — the name column is on the right side.
    We filter lines to keep only those that look like 4-part Arabic names:
      • x-centre in the right 40% of the page
      • ≥ 2 distinct Arabic word tokens of meaningful length
      • not a known single-word value (gender, approval, etc.)
      • not a header line

    Returns text like:
        1 | سارة سعيد الظهراوي |
        2 | بتول رامي أبو مليحة |
    which _raw_names_from_pipe() in process_document.py can parse.
    """
    # Single common words that appear in the right column but are NOT names
    _NON_NAME = frozenset({
        'ذكر', 'أنثى', 'انثى', 'انه', 'أنه', 'نعم', 'لا', 'موافق',
        'موافقه', 'مواقد', 'مواقده', 'مواجهه', 'مصنف', 'نث',
        '-', '–', '—',
    })
    # Words that signal a header / label line — skip the whole line
    _HEADER_TOKENS = frozenset({
        'الاسم', 'رباعي', 'مشارك', 'للمشارك', 'الكامل', 'اسم',
        '#', 'رقم', 'م', 'ت', 'الرقم', 'التسلسل',
        # Form column headers
        'الفئة', 'العمرية', 'تاريخ', 'الميلاد', 'النوع', 'الاجتماعي',
        'الإجتماعي', 'التواصل', 'المحافظة', 'التجمع', 'السكني',
        'الموافقة', 'التوقيع', 'المدارك', 'الإعاقة', 'إعاقة', 'لديك',
    })

    rows: list[str] = []
    row_num = 0

    for page in pages_data:
        page_width = page.get("width") or 0.0
        if not page_width:
            continue

        x_threshold = page_width * 0.58   # right ~42% = name column for Arabic RTL

        candidates: list[tuple[float, str]] = []

        for line in page.get("lines", []):
            content = (line.get("content") or "").strip()
            poly    = line.get("polygon") or []

            if not content or len(poly) < 8:
                continue

            xs       = [poly[i] for i in range(0, len(poly), 2)]
            ys       = [poly[i] for i in range(1, len(poly), 2)]
            x_centre = sum(xs) / len(xs)
            y_centre = sum(ys) / len(ys)

            if x_centre < x_threshold:
                continue

            # ── Content filters ────────────────────────────────────────────────
            tokens = content.split()

            # Skip header lines
            if set(tokens) & _HEADER_TOKENS:
                continue

            # Skip single-word non-name values
            if len(tokens) == 1 and tokens[0] in _NON_NAME:
                continue

            # Count meaningful Arabic word tokens (≥ 2 Arabic chars each)
            arabic_words = [
                t for t in tokens
                if sum(1 for c in t if '\u0600' <= c <= '\u06ff') >= 2
                and t not in _NON_NAME
            ]
            # A name needs at least 2 Arabic word tokens
            if len(arabic_words) < 2:
                continue

            # Skip lines that look like dates or phone numbers
            digit_count = sum(1 for c in content if c.isdigit())
            if digit_count > 4:
                continue
            if '/' in content and len(arabic_words) < 3:
                continue

            candidates.append((y_centre, content))

        candidates.sort(key=lambda t: t[0])

        for _, content in candidates:
            row_num += 1
            rows.append(f"{row_num} | {content} |")

    return "\n".join(rows)


def _fail(error: str) -> dict:
    return {
        "success":        False,
        "full_text":      "",
        "grid_text":      "",
        "markdown_text":  "",
        "annotated_text": "",
        "spatial_text":   "",
        "pages":          [],
        "raw_response":   {},
        "error":          error,
        "provider":       "azure",
    }
