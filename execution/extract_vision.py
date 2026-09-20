"""
Tool: extract_vision
Google Cloud Vision OCR — extracts text from Arabic documents.

Uses the DOCUMENT_TEXT_DETECTION feature which is optimised for dense text
(forms, tables, handwriting) and returns per-word confidence scores plus
full-page bounding-box layout.

Auth:  GOOGLE_APPLICATION_CREDENTIALS environment variable
       (path to service-account JSON, e.g. arabic-ocr-488521-8f89e7866670.json)

Return format (compatible with extract_azure.py / extract_gemini_ocr.py):
    {
        "success":    bool,
        "full_text":  str,          # all pages joined with "\\n\\n"
        "grid_text":  str,          # pipe-separated rows (spatial layout)
        "pages": [
            {
                "page_number": int,
                "full_text":   str,
                "confidence":  float,   # average word confidence 0–1
                "words": [{"content": str, "confidence": float}],
            }
        ],
        "raw_response": {"model": "vision", "pages": int},
        "error":      str | None,
        "provider":   "vision",
    }
"""

from __future__ import annotations

import io
import logging
import os

logger = logging.getLogger(__name__)

# Arabic Unicode block range for scoring
_AR_START = "\u0600"
_AR_END   = "\u06FF"


def _score_arabic(text: str) -> float:
    """Word count × arabic density — higher = more Arabic content."""
    if not text or not text.strip():
        return 0.0
    stripped = text.replace(" ", "").replace("\n", "")
    ar = sum(1 for c in stripped if _AR_START <= c <= _AR_END)
    ratio = ar / max(len(stripped), 1)
    return len(text.split()) * (0.3 + 0.7 * ratio)


def extract_vision(image_bytes: bytes, source_label: str = "<bytes>") -> dict:
    """
    Run Google Cloud Vision DOCUMENT_TEXT_DETECTION on image_bytes.

    Accepts JPEG, PNG, WebP, GIF, or PDF bytes.
    Returns a dict compatible with extract_azure / extract_gemini_ocr.
    """
    creds_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not creds_path or not os.path.isfile(creds_path):
        return _fail("GOOGLE_APPLICATION_CREDENTIALS not set or file not found")

    try:
        from google.cloud import vision as gv
        from google.oauth2 import service_account
    except ImportError:
        return _fail(
            "google-cloud-vision not installed. "
            "Run: pip install google-cloud-vision"
        )

    try:
        credentials = service_account.Credentials.from_service_account_file(
            creds_path,
            scopes=["https://www.googleapis.com/auth/cloud-vision"],
        )
        client = gv.ImageAnnotatorClient(credentials=credentials)
    except Exception as e:
        return _fail(f"Vision client init failed: {e}")

    # Detect mime type
    mime = _detect_mime(image_bytes)

    try:
        if mime == "application/pdf":
            # Convert each PDF page to PNG then call annotate_image per page.
            # 2× zoom (~144 DPI) — higher DPI (300) + preprocessing was tested and
            # produced worse results on real forms (empty fields, degraded text).
            # Vision reads raw raster better than preprocessed greyscale for Arabic.
            try:
                import fitz  # PyMuPDF
            except ImportError:
                return _fail("PyMuPDF not installed — run: pip install pymupdf")

            doc = fitz.open(stream=io.BytesIO(image_bytes), filetype="pdf")
            page_images = []
            for page in doc:
                mat = fitz.Matrix(2, 2)   # 2× zoom, ~144 DPI
                pix = page.get_pixmap(matrix=mat, alpha=False)
                page_images.append(pix.tobytes("png"))
            doc.close()
        else:
            page_images = [image_bytes]

        # NOTE: preprocessing deliberately NOT applied here. Shared light_preprocess
        # (grayscale + unsharp + denoise) degraded Vision accuracy on real Arabic
        # forms. Vision receives raw rasterized pages.

        feature = gv.Feature(type_=gv.Feature.Type.DOCUMENT_TEXT_DETECTION)
        requests_list = [
            {"image": gv.Image(content=img), "features": [feature]}
            for img in page_images
        ]
        batch_response = client.batch_annotate_images(requests=requests_list)
        page_responses = batch_response.responses

    except Exception as e:
        return _fail(f"Vision API call failed: {e}")

    pages_out: list[dict] = []
    all_text_parts: list[str] = []

    for page_idx, resp in enumerate(page_responses):
        if resp.error.message:
            logger.warning(f"[Vision] Page {page_idx+1} error: {resp.error.message}")
            continue

        annotation = resp.full_text_annotation
        if not annotation:
            continue

        page_text  = annotation.text or ""
        all_text_parts.append(page_text)

        # Collect word-level confidences and bounding boxes
        words_out: list[dict] = []
        _page_w_px = 0
        _page_h_px = 0
        for page in annotation.pages:
            _page_w_px = page.width or 0
            _page_h_px = page.height or 0
            for block in page.blocks:
                for para in block.paragraphs:
                    for word in para.words:
                        token   = "".join(s.text for s in word.symbols)
                        conf    = word.confidence if word.confidence else 0.0
                        # Bounding box as flat polygon [x1,y1,x2,y2,x3,y3,x4,y4] in pixels
                        polygon = []
                        if word.bounding_box and word.bounding_box.vertices:
                            for v in word.bounding_box.vertices:
                                polygon.append(v.x if v.x else 0)
                                polygon.append(v.y if v.y else 0)
                        if token.strip():
                            words_out.append({"content": token, "confidence": conf, "polygon": polygon})

        avg_conf = (
            sum(w["confidence"] for w in words_out) / len(words_out)
            if words_out else 0.0
        )

        pages_out.append({
            "page_number": page_idx + 1,
            "full_text":   page_text,
            "confidence":  round(avg_conf, 4),
            "width":       _page_w_px,
            "height":      _page_h_px,
            "words":       words_out,
        })

    if not pages_out:
        return _fail("Vision returned no text")

    full_text  = "\n\n".join(all_text_parts).strip()
    grid_text  = _build_grid(pages_out)
    page_count = len(pages_out)
    avg_conf   = sum(p["confidence"] for p in pages_out) / page_count

    logger.info(
        f"[Vision] Done | source={source_label} | pages={page_count} | "
        f"words={sum(len(p['words']) for p in pages_out)} | "
        f"avg_conf={avg_conf:.3f} | arabic_score={_score_arabic(full_text):.1f}"
    )

    return {
        "success":      True,
        "full_text":    full_text,
        "grid_text":    grid_text,
        "pages":        pages_out,
        "raw_response": {"model": "vision", "pages": page_count},
        "error":        None,
        "provider":     "vision",
    }


def _build_grid(pages: list[dict]) -> str:
    """
    Build a simple pipe-separated grid from word positions.
    Vision doesn't return table structure, so this is a best-effort
    line grouping based on text order.
    """
    lines = []
    for page in pages:
        for line in (page["full_text"] or "").splitlines():
            line = line.strip()
            if line:
                lines.append(line)
    return "\n".join(lines)


def _detect_mime(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "application/pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"   # safe default


def _fail(error: str) -> dict:
    logger.error(f"[Vision] {error}")
    return {
        "success":      False,
        "full_text":    "",
        "grid_text":    "",
        "pages":        [],
        "raw_response": {},
        "error":        error,
        "provider":     "vision",
    }
