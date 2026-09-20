"""
Pipeline Orchestrator: Arabic Handwriting → Excel

Stages:
    1. Set job status → processing
    2. Download document from Supabase Storage
    3. Gemini OCR — rasterize PDF at 300 DPI, extract text page-by-page with thinking
    3.5 Apply character-level corrections (Urdu/Persian chars, ocr_corrections table)
    3.7 Gemini name correction (optional, skipped when Gemini OCR won)
    3.8 Logical pre-validation (phone/date format flags)
    4. Gemini structuring — produce {column_order, participants} JSON
    4.5 Per-cell DB correction lookup (confirmed ocr_corrections)
    5. Save to Supabase (document_jobs + document_pages)
    6. Generate RTL Arabic Excel → upload to Supabase Storage → return signed URL

Usage (CLI):
    python execution/process_document.py \\
      --job_id "uuid" \\
      --document_url "https://..." \\
      --user_id "uuid" \\
      [--debug]

Each stage updates document_jobs.status so the frontend can track progress in real-time.
On any failure: status = "failed", error_message set, exits with code 1.
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from supabase import create_client

logging.basicConfig(
    level=logging.INFO,
    format="[Pipeline] %(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Cached Supabase client ─────────────────────────────────────────────────────
# Shared across all background threads — avoids 1–1.5 s TCP cold-start per job.
# Initialised on first use; thread-safe via _sb_lock.
_supabase_client = None
_sb_lock = threading.Lock()


def _get_supabase():
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client
    with _sb_lock:
        if _supabase_client is None:
            from dotenv import load_dotenv
            load_dotenv()
            from supabase import create_client
            _supabase_client = create_client(
                os.environ["NEXT_PUBLIC_SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            )
            logger.info("[Supabase] Client initialised and cached")
    return _supabase_client


# ── Pipeline Entry Point ───────────────────────────────────────────────────────

def run_pipeline(job_id: str, document_url: str, user_id: str, debug: bool = False) -> dict:
    """
    Orchestrate the full Phase 1 processing pipeline.
    Updates document_jobs.status at each stage.
    Returns {"success": bool, "job_id": str, "excel_url": str | None, "error": str | None}
    """
    from dotenv import load_dotenv
    load_dotenv()

    supabase = _get_supabase()

    logger.info(f"=== Pipeline START | Job: {job_id} ===")
    pipeline_start = time.time()
    _pipeline_dbg = {"job_id": job_id, "document_url_prefix": document_url[:80], "stages": {}}

    from execution.pipeline_trace import PipelineTrace
    trace = PipelineTrace(job_id=job_id)

    # ── Stage 1: Mark as processing ───────────────────────────────────────────
    try:
        _update_job_status(supabase, job_id, "processing")
    except Exception as _s1_err:
        logger.error(f"Stage 1/6 | Could not set status=processing (Supabase unreachable?): {_s1_err}")
        # Continue anyway — pipeline can still run; status update will be retried at completion
    logger.info(f"Stage 1/6 | Status: processing")
    trace.step("STAGE 1 | Status", action="Job marked as processing in database")

    # ── Stage 2: Download document ────────────────────────────────────────────
    logger.info(f"Stage 2/6 | Downloading document | URL: {document_url}")
    try:
        image_bytes, mime_type = _download_document(document_url)
        logger.info(f"Stage 2/6 | Downloaded | Size: {len(image_bytes):,} bytes | Type: {mime_type}")
        trace.step("STAGE 2 | Download", action="Document downloaded from storage",
                   details={"size": f"{len(image_bytes):,} bytes", "type": mime_type})
    except Exception as e:
        trace.step("STAGE 2 | Download", status="FAILED", action=f"Download failed: {e}")
        return _fail(supabase, job_id, f"Download failed: {e}")

    # ── Stage 2.5: page-per-upload limit — removed ───────────────────────────
    # Truncating a PDF to the plan's page allowance made sense while people paid
    # for a bucket of pages a month. Billing is per extracted row now: a ten-page
    # document simply costs ten pages' worth of rows, so there is nothing to
    # enforce and silently dropping pages 2-10 would be destroying work the
    # customer is willing to pay for.

    # ── Stage 3 + 3.3: Multi-model OCR (Gemini + Azure) ─────────────────────────
    # Primary: Gemini OCR (best Arabic name quality, 300 DPI + thinking).
    # Optional: Azure Document Intelligence (AZURE_OCR_ENABLED=1).
    #   When Azure is enabled, both run in parallel; the higher-scoring output wins.
    #   Scoring: word_count × (0.3 + 0.7 × arabic_ratio) — rewards Arabic density.
    #   Gemini is preferred unless Azure scores >20% higher.
    #   Azure markdown/grid output is also stored for Quality Layer use.
    import concurrent.futures

    sys.path.insert(0, str(Path(__file__).parent.parent))

    _azure_enabled = os.getenv("AZURE_OCR_ENABLED", "0") == "1"
    # Gemini OCR and Google Vision are redundant secondaries. Measured on the
    # frozen 400, the full four-engine chain reads 68.5% of name words while
    # Azure Layout plus the fine-tuned adapters reads 87.3%. Azure stays --
    # it is genuinely good at the digit and date columns the model was never
    # trained on. The code stays too; these flags keep it out of the run.
    _gemini_ocr_enabled = os.getenv("GEMINI_OCR_ENABLED", "1") == "1"
    _vision_enabled     = os.getenv("VISION_ENABLED", "1") == "1"

    def _score_ocr(text: str) -> float:
        if not text or not text.strip():
            return 0.0
        stripped = text.replace(" ", "").replace("\n", "")
        arabic_chars = sum(1 for c in stripped if "\u0600" <= c <= "\u06FF")
        arabic_ratio = arabic_chars / max(len(stripped), 1)
        return len(text.split()) * (0.3 + 0.7 * arabic_ratio)

    def _run_gemini_ocr():
        from execution.extract_gemini_ocr import extract_gemini_ocr
        return extract_gemini_ocr(image_bytes, source_label=job_id)

    # Azure Read caps the REQUEST BODY, not the picture. A 4.10 MB phone photo
    # was refused with InvalidContentLength while Layout accepted the same file
    # and returned a full 19x21 table -- so the job died holding its own answer.
    #
    # Re-encoding is not downscaling. Every pixel survives; only JPEG detail
    # neither the eye nor the OCR uses is discarded. Measured on that photo:
    # 4.10 MB -> 2.18 MB at quality 95, still 3750x2648, still ~126px a row,
    # and Read went from refusing it to reading 252 words at 0.73 confidence.
    # Shrinking the DIMENSIONS would be the wrong fix: that walks cell height
    # down toward the ~43px floor where reading falls apart.
    AZURE_READ_MAX = 4 * 1024 * 1024

    def _fit_for_read(raw: bytes) -> bytes:
        if len(raw) <= AZURE_READ_MAX or raw[:4] == b"%PDF":
            return raw
        try:
            import io as _io
            from PIL import Image as _Image
            im = _Image.open(_io.BytesIO(raw)).convert("RGB")
            for q in (95, 90, 85, 80, 70):
                buf = _io.BytesIO()
                im.save(buf, format="JPEG", quality=q, optimize=True)
                if buf.tell() <= AZURE_READ_MAX:
                    logger.info(f"Stage 3 | Azure Read: re-encoded "
                                f"{len(raw)/1024/1024:.2f}MB -> {buf.tell()/1024/1024:.2f}MB "
                                f"at q{q}, {im.size} pixels unchanged")
                    return buf.getvalue()
            logger.warning(f"Stage 3 | Azure Read: still {buf.tell()/1024/1024:.2f}MB "
                           f"at q70; sending as is")
            return buf.getvalue()
        except Exception as e:
            logger.warning(f"Stage 3 | Azure Read: could not re-encode ({e}); sending original")
            return raw

    def _run_azure():
        from execution.extract_azure import extract_azure
        return extract_azure(_fit_for_read(image_bytes), source_label=job_id)

    def _run_azure_layout():
        from execution.extract_azure_layout import extract_azure_layout
        return extract_azure_layout(image_bytes, source_label=job_id)

    def _run_vision():
        from execution.extract_vision import extract_vision
        return extract_vision(image_bytes, source_label=job_id)

    logger.info(
        f"Stage 3/6 | Starting OCR | "
        f"{'Gemini + Vision + Azure read + Azure layout (parallel)' if _azure_enabled else 'Gemini only'}"
    )
    ocr_result           = None
    azure_text           = None
    azure_grid_text      = ""
    azure_markdown_text  = ""
    azure_annotated_text = ""
    azure_result         = None
    azure_layout_result  = None   # prebuilt-layout structured table
    gemini_ocr_result    = None
    vision_result        = None
    _azure_conf_avg      = 0.0
    _chosen_model        = "gemini_ocr"

    try:
        if _azure_enabled:
            # All four run in parallel — total OCR time = slowest engine only
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                _gemini_future = executor.submit(_run_gemini_ocr) if _gemini_ocr_enabled else None
                _vision_future = executor.submit(_run_vision)     if _vision_enabled     else None
                _azure_future  = executor.submit(_run_azure)
                _layout_future = executor.submit(_run_azure_layout)

                gemini_ocr_result = (_gemini_future.result(timeout=180)
                                     if _gemini_future else None)

                # Collect Vision result (non-fatal if unavailable)
                try:
                    vision_result = (_vision_future.result(timeout=60)
                                     if _vision_future else None)
                    if vision_result is None:
                        pass
                    elif vision_result.get("success"):
                        _v_words = len(vision_result.get("full_text", "").split())
                        logger.info(f"Stage 3/6 | Vision: {_v_words} words")
                    else:
                        logger.warning(f"Stage 3/6 | Vision failed: {vision_result.get('error')}")
                        vision_result = None
                except Exception as _v_err:
                    logger.warning(f"Stage 3/6 | Vision error (non-fatal): {_v_err}")
                    vision_result = None

                try:
                    azure_result = _azure_future.result(timeout=180)
                    if azure_result["success"]:
                        azure_text            = azure_result["full_text"]
                        azure_grid_text       = azure_result.get("grid_text", "")
                        azure_markdown_text   = azure_result.get("markdown_text", "")
                        azure_annotated_text  = azure_result.get("annotated_text", "")
                        _az_pages             = azure_result.get("pages") or []
                        _azure_conf_avg       = (
                            sum(p["confidence"] for p in _az_pages) / len(_az_pages)
                            if _az_pages else 0.0
                        )
                        logger.info(
                            f"Stage 3.3/6 | Azure read: {len(azure_text.split())} words | "
                            f"avg_conf={_azure_conf_avg:.3f}"
                        )
                    else:
                        logger.warning(f"Stage 3.3/6 | Azure read failed: {azure_result.get('error')}")
                except Exception as _az_err:
                    logger.warning(f"Stage 3.3/6 | Azure read error (non-fatal): {_az_err}")

                # Stage 3.35: Azure layout (table structure)
                try:
                    azure_layout_result = _layout_future.result(timeout=60)
                    if azure_layout_result["success"]:
                        _layout_tables    = azure_layout_result.get("tables") or []
                        _layout_rows      = sum(len(t["rows"]) for t in _layout_tables)
                        _layout_cols      = _layout_tables[0]["column_count"] if _layout_tables else 0
                        logger.info(
                            f"Stage 3.35/6 | Azure layout: {len(_layout_tables)} table(s) | "
                            f"{_layout_rows} data rows | {_layout_cols} columns"
                        )
                        # ── Detailed layout debug dump ────────────────────────────
                        for _ti, _t in enumerate(_layout_tables):
                            logger.info(
                                f"Stage 3.35/6 | Table {_ti+1}: "
                                f"{_t['row_count']} rows × {_t['column_count']} cols | "
                                f"page={_t.get('page_number', '?')}"
                            )
                            logger.info(
                                f"Stage 3.35/6 | Table {_ti+1} headers: {_t['headers']}"
                            )
                            # Row contents contain names/PII — only log under debug.
                            if debug:
                                for _ri, _row in enumerate(_t["rows"][:3]):   # first 3 data rows
                                    logger.info(
                                        f"Stage 3.35/6 | Table {_ti+1} row {_ri+1}: {_row}"
                                    )
                        # Save full layout to .tmp/ for inspection. Contains
                        # extracted cell text (PII) — debug-only, never in prod.
                        if debug:
                            import json as _json
                            from pathlib import Path as _Path
                            _tmp = _Path(".tmp")
                            _tmp.mkdir(parents=True, exist_ok=True)
                            _layout_dump = _tmp / f"azure_layout_{job_id[:8]}.json"
                            with open(_layout_dump, "w", encoding="utf-8") as _f:
                                _json.dump(azure_layout_result, _f, ensure_ascii=False, indent=2)
                            logger.info(f"Stage 3.35/6 | Full layout saved → {_layout_dump}")
                    else:
                        logger.warning(f"Stage 3.35/6 | Azure layout failed: {azure_layout_result.get('error')}")
                        azure_layout_result = None
                except Exception as _layout_err:
                    logger.warning(f"Stage 3.35/6 | Azure layout error (non-fatal): {_layout_err}")
                    azure_layout_result = None

            _g_ok = bool(gemini_ocr_result and gemini_ocr_result.get("success"))
            _gemini_quota_failed = (
                not _g_ok
                and "quota" in ((gemini_ocr_result or {}).get("error") or "").lower()
            )
            _g_score  = _score_ocr(gemini_ocr_result.get("full_text", "")) if _g_ok else 0.0
            _az_score = _score_ocr(azure_text or "") if azure_result and azure_result.get("success") else 0.0
            _v_score  = _score_ocr(vision_result.get("full_text", "")) if vision_result and vision_result.get("success") else 0.0
            _g_words  = len(gemini_ocr_result.get("full_text", "").split()) if _g_ok else 0
            _az_words = len((azure_text or "").split())
            _v_words  = len(vision_result.get("full_text", "").split()) if vision_result else 0

            if _gemini_ocr_enabled and (_gemini_quota_failed or (_g_score == 0 and not _g_ok)):
                _quota_err = (gemini_ocr_result or {}).get("error") or "Gemini OCR quota exhausted"
                return _fail(supabase, job_id,
                             f"{_quota_err} — Please try again after midnight (Pacific Time).")

            # ── Engine selection: Azure-primary ──────────────────────────────
            # Azure Read is the deterministic core (best row/column fidelity on
            # tabular Arabic). Vision is the secondary — used for cell-level
            # spatial voting at Stage 3.9. Gemini is NOT a primary text source;
            # it is reserved for targeted per-cell review at Stage 3.95 (Gemini Judge).
            # Fallback only if Azure failed outright (quota/API error).
            if azure_result and azure_result.get("success") and _az_score > 0:
                ocr_result    = azure_result
                _chosen_model = "azure"
            elif vision_result and _v_score > 0:
                ocr_result    = vision_result
                _chosen_model = "vision_fallback"
            elif _g_ok and _g_score > 0:
                ocr_result    = gemini_ocr_result
                _chosen_model = "gemini_fallback"
            elif (azure_layout_result and azure_layout_result.get("success")
                  and (azure_layout_result.get("tables") or [])):
                # Layout read the page even though Read would not take it, and
                # Layout is the engine that actually builds structured_data.
                # Failing here threw away a finished 19x21 table because a
                # DIFFERENT endpoint had refused the file for its size -- the
                # job ended up stored with 20 rows of good data and the message
                # "All OCR engines failed", and re-uploading reproduced it
                # every time because the file was the same size every time.
                ocr_result    = {"success": True,
                                 "full_text": azure_layout_result.get("full_text") or "",
                                 "pages": []}
                _chosen_model = "azure_layout_only"
                logger.warning(
                    "Stage 3 | Azure Read gave nothing; continuing on Layout, "
                    f"which found {len(azure_layout_result.get('tables') or [])} table(s)")
            else:
                return _fail(supabase, job_id, "All OCR engines failed")

            logger.info(
                f"Stage 3/6 | OCR winner: {_chosen_model} | "
                f"gemini={_g_score:.1f}pts/{_g_words}w  "
                f"azure={_az_score:.1f}pts/{_az_words}w  "
                f"vision={_v_score:.1f}pts/{_v_words}w"
            )
        else:
            logger.info("Stage 3.3/6 | Azure skipped (AZURE_OCR_ENABLED not set)")
            gemini_ocr_result = _run_gemini_ocr()
            _g_score  = _score_ocr(gemini_ocr_result.get("full_text", "")) if gemini_ocr_result.get("success") else 0.0
            _g_words  = len(gemini_ocr_result.get("full_text", "").split()) if gemini_ocr_result.get("success") else 0
            _az_score = 0.0
            _az_words = 0

            if gemini_ocr_result.get("success") and _g_score > 0:
                ocr_result    = gemini_ocr_result
                _chosen_model = "gemini_ocr"
            else:
                return _fail(supabase, job_id, f"Gemini OCR failed: {gemini_ocr_result.get('error', 'empty output')}")

        if not ocr_result.get("success"):
            return _fail(supabase, job_id, f"OCR failed: {ocr_result.get('error')}")

        full_text = ocr_result["full_text"]
        grid_text = ocr_result.get("grid_text") or ""

        if not full_text.strip():
            logger.warning("Stage 3/6 | Empty text — document may be blank or unreadable")

        logger.info(f"Stage 3/6 | OCR complete | model={_chosen_model} | chars={len(full_text)} | pages={len(ocr_result['pages'])}")

        trace.step(
            "STAGE 3 | OCR",
            model=_chosen_model,
            action=f"Document rasterized at 300 DPI | {'Gemini + Azure read + Azure layout (parallel)' if _azure_enabled else 'Gemini only'}",
            decision=f"Winner: {_chosen_model} (Gemini={_g_score:.1f}pts/{_g_words}w  Azure={_az_score:.1f}pts/{_az_words}w)",
            details={
                "Pages":         len(ocr_result["pages"]),
                "Gemini words":  _g_words,
                "Azure words":   _az_words,
                "Azure conf":    f"{_azure_conf_avg:.3f}" if _azure_enabled else "n/a",
                "Layout tables": len((azure_layout_result or {}).get("tables") or []) if azure_layout_result else "n/a",
            },
        )
        if azure_layout_result and azure_layout_result.get("success"):
            _lt = azure_layout_result.get("tables") or []
            trace.step(
                "STAGE 3.35 | Azure Layout",
                status="OK",
                action="Azure prebuilt-layout extracted table grid with exact row/col coordinates",
                details={
                    "tables":    len(_lt),
                    "data_rows": sum(len(t["rows"]) for t in _lt),
                    "columns":   _lt[0]["column_count"] if _lt else 0,
                    "headers":   _lt[0]["headers"] if _lt else [],
                },
            )
        else:
            trace.step("STAGE 3.35 | Azure Layout", status="DISABLED" if not _azure_enabled else "FAILED",
                       action="Azure layout not available — Gemini structuring will handle column assignment")
        _pipeline_dbg["stages"]["ocr"] = {
            "chosen_model":      _chosen_model,
            "gemini_score":      round(_g_score, 2),
            "azure_score":       round(_az_score, 2),
            "gemini_words":      _g_words,
            "azure_words":       _az_words,
            "azure_confidence":  round(_azure_conf_avg, 3),
            "full_text_length":  len(full_text),
            # full_text contains names/PII — only persist a preview under debug.
            "full_text_preview": full_text[:2000] if debug else "",
            "pages":             len(ocr_result["pages"]),
        }

        # Billing is NOT done here any more. Pages stopped being the unit: the
        # customer is charged per extracted row, and the row count does not
        # exist until structuring has run. See "Settle the bill" below.

    except Exception as e:
        return _fail(supabase, job_id, f"OCR error: {e}")

    grid_text = ocr_result.get("grid_text") or full_text

    # ── Stage 3.4: Token-level OCR merge (Azure + Vision) ────────────────────────
    # Runs only when both deterministic engines produced successful output.
    # Merges pipe-separated table text cell-by-cell using:
    #   • Arabic character confusion matrix (visual plausibility per substitution)
    #   • DP token-sequence alignment (handles dropped/shifted tokens)
    #   • Palestinian name dictionary validation (hallucination firewall)
    #   • Per-column type rules (phone/date → Azure; name → merge; text → Vision)
    # The merged text takes priority in Stage 3.5 input selection.
    _merged_ocr_text: str | None = None
    if (
        _azure_enabled
        and azure_result and azure_result.get("success")
        and vision_result and vision_result.get("success")
    ):
        try:
            from execution.merge_ocr_outputs import merge_ocr_outputs as _merge_fn
            _azure_for_merge  = azure_markdown_text or azure_grid_text or azure_text or ""
            _vision_for_merge = vision_result.get("grid_text", "") or vision_result.get("full_text", "")
            if _azure_for_merge and _vision_for_merge:
                _candidate = _merge_fn(_azure_for_merge, _vision_for_merge)
                if _candidate and "|" in _candidate:
                    _merged_ocr_text = _candidate
                    logger.info(
                        f"Stage 3.4/6 | Token merge complete | {len(_merged_ocr_text)} chars"
                    )
                    trace.step(
                        "STAGE 3.4 | Token Merge",
                        action="Merged Azure + Vision outputs token-by-token via confusion matrix",
                        details={"chars": len(_merged_ocr_text)},
                    )
                else:
                    logger.info("Stage 3.4/6 | Merge produced no table structure — skipped")
                    trace.step("STAGE 3.4 | Token Merge", status="SKIPPED",
                               action="No pipe-separated table in merged output")
            else:
                trace.step("STAGE 3.4 | Token Merge", status="SKIPPED",
                           action="Missing Azure or Vision text for merge")
        except Exception as _e34:
            logger.warning(f"Stage 3.4/6 | Token merge failed (non-fatal): {_e34}")
            trace.step("STAGE 3.4 | Token Merge", status="FAILED", action=str(_e34))
    else:
        trace.step("STAGE 3.4 | Token Merge", status="DISABLED",
                   action="Merge requires both Azure and Vision — one is unavailable")

    # ── Stage 3.5: OCR Pre-processing ────────────────────────────────────────────
    # Input selection priority:
    #   merged_azure_vision → Azure markdown → Azure grid → Gemini OCR (last resort) → full_text
    # Then apply character-level corrections (Urdu/Persian normalization + ocr_corrections DB).
    if _merged_ocr_text:
        gemini_input        = _merged_ocr_text
        _gemini_input_src   = "merged_azure_vision"
    elif _azure_enabled and azure_markdown_text:
        gemini_input        = azure_markdown_text
        _gemini_input_src   = "azure_markdown_text"
    elif _azure_enabled and azure_grid_text:
        gemini_input        = azure_grid_text
        _gemini_input_src   = "azure_grid_text"
    elif _azure_enabled and azure_annotated_text:
        gemini_input        = azure_annotated_text
        _gemini_input_src   = "azure_annotated_text"
    elif _azure_enabled and azure_text:
        gemini_input        = azure_text
        _gemini_input_src   = "azure_text_linear"
    else:
        gemini_input        = grid_text if grid_text.strip() else full_text
        _gemini_input_src   = "grid_text" if grid_text.strip() else "full_text"

    logger.info(f"Stage 3.5/6 | Input source: {_gemini_input_src} ({len(gemini_input)} chars)")
    _pipeline_dbg["stages"]["gemini_input_source"] = _gemini_input_src

    try:
        clean_text = _apply_ocr_corrections(gemini_input, supabase)
        _corrections_applied = clean_text != gemini_input
        logger.info(f"Stage 3.5/6 | Corrections: {'applied' if _corrections_applied else 'none needed'}")
    except Exception as e:
        logger.warning(f"Stage 3.5/6 | Correction failed (non-fatal): {e}")
        clean_text = gemini_input
        _corrections_applied = False

    trace.step(
        "STAGE 3.5 | Input Selection",
        action=f"Chose '{_gemini_input_src}' as structuring input; applied character normalization",
        details={
            "Source":      _gemini_input_src,
            "Input chars": len(gemini_input),
            "Corrections": "applied" if _corrections_applied else "none needed",
        },
    )

    # ── Stage 3.8: Logical Pre-Validation ─────────────────────────────────────
    try:
        _prevalidated = _logical_validation(clean_text)
        _preval_issues = [l for l in _prevalidated.splitlines() if l.startswith("[!]")]
        clean_text = _prevalidated
        trace.step("STAGE 3.8 | Logical Pre-Validation",
                   status="WARNING" if _preval_issues else "OK",
                   action="Scanned OCR text for phone/name/date format violations before structuring",
                   details={"rows_flagged": len(_preval_issues)},
                   issues=[l[2:].strip() for l in _preval_issues[:5]])
    except Exception as e:
        logger.warning(f"Stage 3.8/6 | Logical validation failed (non-fatal): {e}")
        trace.step("STAGE 3.8 | Logical Pre-Validation", status="FAILED", action=str(e))

    # ── Stage 3.9: Spatial voting (Vision + Azure Read → Azure Layout cells) ────
    # Before structuring, improve Azure Layout cell text by voting with spatially
    # matched words from Vision and Azure Read.  Each word is mapped to its
    # physical cell via bounding-box overlap — no index-based matching.
    if azure_layout_result and azure_layout_result.get("success") and (vision_result or azure_result):
        try:
            from execution.spatial_matcher import spatial_vote_layout
            _sv_tables_before = sum(
                sum(1 for cell in row if cell)
                for t in (azure_layout_result.get("tables") or [])
                for row in t.get("rows", [])
            )
            azure_layout_result = spatial_vote_layout(
                layout_result=azure_layout_result,
                vision_result=vision_result,
                azure_read_result=azure_result,
            )
            logger.info("Stage 3.9/6 | Spatial voting applied to Azure Layout cells")
            trace.step(
                "STAGE 3.9 | Spatial Cell Voting",
                status="OK",
                action="Voted on each cell: Layout vs Vision vs Azure Read (bounding-box aligned)",
            )
        except Exception as _e39:
            logger.warning(f"Stage 3.9/6 | Spatial voting failed (non-fatal): {_e39}")
            import traceback; traceback.print_exc()
            trace.step("STAGE 3.9 | Spatial Cell Voting", status="FAILED", action=str(_e39))
    else:
        logger.info("Stage 3.9/6 | Spatial voting skipped — layout or secondary OCR unavailable")

    # Extract raw name strings (position-indexed) from pipe-separated OCR texts.
    # Done BEFORE Stage 3.95 so the Gemini Judge can see the Gemini OCR candidate for each row.
    def _raw_names_from_pipe(text: str) -> dict:
        """Return {0-based-row-idx: name_str} from pipe-separated OCR text."""
        result: dict[int, str] = {}
        row_idx = 0
        for line in (text or "").splitlines():
            if "|" not in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            name = ""
            for p in parts[1:]:
                if p and sum(1 for c in p if "\u0600" <= c <= "\u06FF") >= 2:
                    name = p
                    break
            if name:
                result[row_idx] = name
                row_idx += 1
        return result

    _gemini_raw_names: dict = _raw_names_from_pipe(
        gemini_ocr_result.get("full_text", "") if gemini_ocr_result else ""
    )
    _azure_raw_names: dict = _raw_names_from_pipe(
        azure_result.get("grid_text", "") if (_azure_enabled and azure_result) else ""
    )

    # ── Stage 3.95: Gemini Judge — per-cell image crop review ──────────────────
    # For cells where all three Round-1 engines disagreed, crop the cell region
    # from the PDF and ask Gemini to read it visually.  Zero alignment risk —
    # Gemini only ever sees one cell at a time.
    # Always on. It used to sit behind GEMINI_CELL_REVIEW; the owner wants it
    # never switched off, so there is no flag to flip. Named "Gemini Round 2"
    # until 2026-09-10.
    if (azure_layout_result and azure_layout_result.get("success")
            and (azure_layout_result.get("_low_confidence_cells") or [])):
        try:
            from execution.gemini_judge import review_low_confidence_cells
            _n_low = len(azure_layout_result.get("_low_confidence_cells") or [])
            logger.info(f"Stage 3.95/6 | Gemini Judge: reviewing {_n_low} low-confidence cells")
            azure_layout_result = review_low_confidence_cells(
                layout_result=azure_layout_result,
                pdf_bytes=image_bytes,
                gemini_raw_names=_gemini_raw_names,
            )
            trace.step(
                "STAGE 3.95 | Gemini Judge",
                status="OK",
                model=os.getenv("GEMINI_MODEL", "gemini-3.7-flash"),
                action=f"Re-read {_n_low} low-confidence cells from image crops",
            )
        except Exception as _e395:
            logger.warning(f"Stage 3.95/6 | Gemini Judge failed (non-fatal): {_e395}")
            import traceback; traceback.print_exc()
            trace.step("STAGE 3.95 | Gemini Judge", status="FAILED", action=str(_e395))
    else:
        logger.info("Stage 3.95/6 | Gemini Judge skipped — no low-confidence cells")

    _name_col_names: list = []

    # ── Stage 4: Structuring — Azure layout first, Gemini structuring as fallback ──
    # Priority:
    #   1. Azure prebuilt-layout  — spatially grounded, exact row/col, no shifting
    #   2. Gemini structuring     — fallback when Azure layout unavailable/failed
    #
    # When Azure layout succeeds, Gemini structuring is skipped entirely for column
    # assignment.  Gemini is still used for name quality merging in Stage 4.6.
    logger.info(f"Stage 4/6 | Structuring")
    structured_data = None
    gemini_col_order = []
    _stage4_source   = "gemini"   # track which path was taken

    # ── Stage 4a: Try Azure layout structuring first ──────────────────────────
    if azure_layout_result and azure_layout_result.get("success"):
        try:
            from execution.extract_azure_layout import layout_to_participants, layout_to_cell_polygons
            _layout_col_order, _layout_participants = layout_to_participants(azure_layout_result)
            # Capture per-cell polygons in parallel — same indexing as participants
            # so the training cropper can map (participant_index, field_name) → bbox.
            _layout_cell_polygons = layout_to_cell_polygons(azure_layout_result)
            logger.info(f"Stage 4a/6 | layout_to_participants → cols={_layout_col_order}")
            if _layout_participants:
                logger.info(f"Stage 4a/6 | First row sample: {_layout_participants[0]}")
            if _layout_participants and _layout_col_order:
                # ── Value normalisation (phone/date/signature) ─────────────
                import re as _re2
                # ID / card / passport columns also contain "رقم" ("number") but are NOT
                # phone numbers. Without excluding them, _fix_phone strips the mask/spaces
                # from values like "960 *** 549" (→ 6 digits) and returns None, wiping the
                # whole ID column even though Azure read it correctly.
                _ID_COLS    = _re2.compile(r'هوية|هويه|بطاقة|الوطني|identity|passport|جواز', _re2.I)
                _PHONE_COLS = _re2.compile(r'(?:رقم|هاتف|جوال|موبايل|phone|tel)', _re2.I)
                _DATE_COLS  = _re2.compile(r'(?:تاريخ|date)', _re2.I)
                _SIG_COLS   = _re2.compile(r'(?:توقيع|imza|signature)', _re2.I)

                def _fix_phone(v):
                    """
                    A phone cell keeps its digits and nothing else.

                    Everything that is not a digit is dropped -- brackets,
                    letters and stray punctuation are OCR noise, never part of a
                    number. What is left is repaired where the repair is
                    unambiguous (a dropped leading zero, a 970/972 country
                    code) and otherwise kept exactly as read.

                    It never returns None. A short or malformed number is still
                    the only record of what is on the paper, and digit_repair
                    (_PHONE_RE: 059 or 056 then seven digits) flags precisely these for a
                    second look by Gemini. Blanking here would delete the
                    evidence before that stage ever sees it.
                    """
                    if not isinstance(v, str):
                        return v
                    # Digits, plus a leading '+' when the number was written in
                    # international form. Everything else -- brackets, letters,
                    # stray punctuation -- is OCR noise and goes.
                    plus = v.lstrip().startswith('+')
                    d = _re2.sub(r'\D', '', v)
                    if not d:
                        return None
                    # A 970/972 country code is KEPT, not rewritten to a local
                    # 0-prefix: it is how the number was written down, and
                    # rewriting it loses that.
                    if d[:3] in ('970', '972'):
                        return ('+' + d) if plus else d
                    if len(d) == 9 and d[:2] in ('59', '56', '57', '58', '54'):
                        d = '0' + d          # dropped leading zero
                    elif len(d) == 10 and d[0] == '2' and d[1:3] in ('59', '56', '57', '58', '54'):
                        d = '0' + d[1:]      # partial country code misread as a bare 2
                    return ('+' + d) if plus else d

                _WS = _re2.compile(r'\s+')

                def _fix_id(v):
                    """
                    An ID never contains a space.

                    ID columns are excluded from _fix_phone above (its length
                    rules would return None and wipe a legitimately short card
                    number), which left them with no whitespace cleanup at all --
                    so "407 941376" was stored, and exported, with the space in
                    it. This strips whitespace and keeps every digit: it can
                    never shorten or discard a reading.
                    """
                    if not isinstance(v, str):
                        return v
                    # Digits and mask characters only. '*' is kept because a
                    # redacted card number on the form ("960 *** 549") is a
                    # deliberate mark, not OCR noise -- stripping it would
                    # invent a plausible-looking six-digit ID that nobody wrote.
                    d = _re2.sub(r'[^0-9*]', '', v)
                    return d or None

                def _fix_date(v):
                    """Normalise date strings to YYYY/M/D. When components are out of
                    range, try day/month swap before giving up. Never return None for
                    a partially-readable date — keep the original so the user can see
                    and correct it manually rather than losing data."""
                    if not isinstance(v, str):
                        return v
                    v = v.strip()
                    # Fix merged-year OCR: "2.8/7/1" → year=2008, month=7, day=1
                    # OCR splits "2008" into "2" + "." + "8" then reads "/7/1"
                    m = _re2.match(r'^(\d)[./](\d{1,2})[/.](\d{1,2})[/.](\d{1,2})$', v)
                    if m:
                        _y_prefix, _y_suffix = m.group(1), m.group(2)
                        _c, _d = int(m.group(3)), int(m.group(4))
                        year = int(f"{_y_prefix}00{_y_suffix}")
                        if 1990 <= year <= 2025 and 1 <= _c <= 12 and 1 <= _d <= 31:
                            return f"{year}/{_c}/{_d}"
                        if 1990 <= year <= 2025 and 1 <= _d <= 12 and 1 <= _c <= 31:
                            return f"{year}/{_d}/{_c}"
                    # Fix merged OCR format: DD-MYYYY e.g. "26-22008" → "2008/2/26"
                    m = _re2.match(r'^(\d{1,2})-(\d)(\d{4})$', v)
                    if m:
                        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
                        if 1 <= day <= 31 and 1 <= month <= 12:
                            return f"{year}/{month}/{day}"
                    # Standard YYYY-MM-DD or YYYY/MM/DD
                    m = _re2.match(r'^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$', v)
                    if m:
                        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
                        if 1 <= month <= 12 and 1 <= day <= 31:
                            return f"{year}/{month}/{day}"
                        # Swap day/month — OCR may have seen them in the wrong order
                        if 1 <= day <= 12 and 1 <= month <= 31:
                            return f"{year}/{day}/{month}"
                        return v  # unfixable — keep original rather than blanking
                    # DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
                    m = _re2.match(r'^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$', v)
                    if m:
                        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
                        if 1 <= month <= 12 and 1 <= day <= 31:
                            return f"{year}/{month}/{day}"
                        # Swap (e.g. "13/6/2006" read as DD/MM but month=13 → MM=6, DD=13)
                        if 1 <= day <= 12 and 1 <= month <= 31:
                            return f"{year}/{day}/{month}"
                        return v  # unfixable — keep original
                    return v

                for _row in _layout_participants:
                    for _col in _layout_col_order:
                        _val = _row.get(_col)
                        if _val is None:
                            continue
                        if _PHONE_COLS.search(_col) and not _ID_COLS.search(_col):
                            _row[_col] = _fix_phone(_val)
                        elif _ID_COLS.search(_col):
                            _row[_col] = _fix_id(_val)
                        elif _DATE_COLS.search(_col):
                            _row[_col] = _fix_date(_val)
                        # Signature cells intentionally left untouched here — the
                        # universal signature guard (Stage 4a.2) handles name-leak
                        # detection after voting. Aggressive short-fragment wiping
                        # here was blanking legitimate signatures.
                # ── End value normalisation ────────────────────────────────

                structured_data  = _layout_participants
                gemini_col_order = _layout_col_order
                _stage4_source   = "azure_layout"
                logger.info(
                    f"Stage 4/6 | Azure layout structuring: "
                    f"{len(structured_data)} rows × {len(gemini_col_order)} cols"
                )

                trace.step(
                    "STAGE 4 | Structuring",
                    status="OK",
                    model="azure_layout",
                    action="Azure prebuilt-layout used for column assignment — no pipe-shifting possible",
                    details={
                        "rows":    len(structured_data),
                        "columns": len(gemini_col_order),
                        "headers": gemini_col_order,
                    },
                )
            else:
                logger.warning("Stage 4/6 | Azure layout returned empty table — falling back to Gemini structuring")
        except Exception as _e4a:
            logger.warning(f"Stage 4/6 | Azure layout structuring failed (non-fatal): {_e4a}")

    try:
        from execution.extract_gemini import structure_with_gemini

        # Fetch recent field corrections for few-shot injection
        recent_corrections = []
        try:
            recent_corrections = (
                supabase.table("field_corrections")
                .select("field_name,original_value,corrected_value")
                .order("created_at", desc=True)
                .limit(5)
                .execute()
                .data
            )
        except Exception:
            pass

        # ── Stage 4b: Gemini structuring (fallback when Azure layout unavailable) ──
        if _stage4_source != "azure_layout":
            # Extract first page PNG for visual grounding when Gemini must structure
            _first_page_png: bytes | None = None
            try:
                import fitz as _fitz
                _doc = _fitz.open(stream=image_bytes, filetype="pdf")
                _mat = _fitz.Matrix(300 / 72, 300 / 72)
                _pix = _doc[0].get_pixmap(matrix=_mat, colorspace=_fitz.csRGB)
                _first_page_png = _pix.tobytes("png")
                _doc.close()
                logger.info(f"Stage 4/6 | First-page PNG extracted for visual grounding ({len(_first_page_png):,} bytes)")
            except Exception as _e_png:
                logger.warning(f"Stage 4/6 | Could not extract first-page PNG (non-fatal): {_e_png}")

            gemini_result = structure_with_gemini(
                full_text=clean_text,
                field_corrections=recent_corrections,
                job_id=job_id,
                image_bytes=_first_page_png,
            )
        else:
            # Azure layout succeeded — still call Gemini structuring but only to get
            # a name-quality check, not for column assignment.  We skip the full call
            # to save quota; name correction happens in Stage 4.6 via Gemini OCR names.
            gemini_result = {"success": False, "participants": None, "column_order": []}

        # Gemini structuring path: take result when Gemini succeeded
        if gemini_result["success"] and gemini_result["participants"]:
            structured_data  = gemini_result["participants"]
            gemini_col_order = gemini_result.get("column_order") or []
            _stage4_source   = "gemini"

        # ── Post-processing: applies to both Azure layout AND Gemini paths ────
        if structured_data:
            # Normalize column names: collapse \n and extra spaces
            def _norm(name: str) -> str:
                return " ".join(name.split())

            if gemini_col_order:
                gemini_col_order = [_norm(c) for c in gemini_col_order]
            structured_data = [
                {_norm(k): v for k, v in p.items()}
                for p in structured_data
            ]

            # Column order cleanup:
            # 1. Drop the sequential row-number column (header is just # or an Arabic digit like ٤)
            #    — the table already shows row numbers via the UI row counter.
            #    BUT: extract row numbers FIRST and use them to sort rows into document order.
            #    Gemini sometimes outputs page-2 rows before page-1 rows when column structures
            #    differ between pages.  Sorting by the explicit row-number column restores order.
            # 2. Pin the Name column first (user requirement).
            if gemini_col_order:
                import re as _re
                _ROW_NUM_PAT = _re.compile(r"^[#٠-٩0-9\s]+$")

                # ── Sort by row number BEFORE dropping the column ──────────────
                if structured_data:
                    _rn_cols = [c for c in gemini_col_order if _ROW_NUM_PAT.match(c.strip())]
                    if _rn_cols:
                        _rn_col = _rn_cols[0]
                        _AR_DIGIT = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
                        _row_nums: list[int] = []
                        for _rp in structured_data:
                            _rv = str(_rp.get(_rn_col) or "").translate(_AR_DIGIT)
                            _m  = _re.search(r'\d+', _rv)
                            _row_nums.append(int(_m.group()) if _m else 99999)
                        # Only sort when:
                        # (a) all numbers are valid (no 99999 sentinel — means at least
                        #     one row had no parseable number, skip to avoid scrambling)
                        # (b) all numbers are unique (pages each restarting from 1 would
                        #     create duplicates — in that case trust Gemini's order)
                        _all_valid  = all(n != 99999 for n in _row_nums)
                        _all_unique = len(_row_nums) == len(set(_row_nums))
                        if _all_valid and _all_unique:
                            _sorted_indices = [i for _, i in sorted(zip(_row_nums, range(len(structured_data))))]
                            structured_data = [structured_data[i] for i in _sorted_indices]
                            logger.info(f"Stage 4/6 | Rows sorted by document row numbers: {_row_nums[:5]}…")

                # ── Now drop the row-number column ─────────────────────────────
                gemini_col_order = [c for c in gemini_col_order if not _ROW_NUM_PAT.match(c.strip())]
                if structured_data:
                    _dropped = {c for c in (structured_data[0] or {}) if _ROW_NUM_PAT.match(c.strip())}
                    if _dropped:
                        structured_data = [{k: v for k, v in p.items() if k not in _dropped} for p in structured_data]

                # The name column used to be yanked to position 0 here. That was
                # papering over a mirrored order: Azure numbers columns
                # left-to-right, the table renders dir="rtl", so an Arabic form
                # came out reversed and the name landed wherever. Pinning put the
                # one column people look at back in roughly the right place and
                # left the other eight wrong.
                #
                # layout_to_participants now returns reading order, so the name
                # sits where it sits on the paper -- which is what someone typing
                # from that paper needs. Re-pinning would move it off again.

            # ── Place names: match against the approved Gaza lexicon ──────────
            # Place columns are a closed vocabulary -- 1,053 usable cells across
            # the corpus resolve to about two dozen real places, where names are
            # 8,364 cells across 7,777 distinct. So this is a dictionary rather
            # than a model, and it only rewrites a cell when the match is not in
            # doubt; anything else is left exactly as Azure read it.
            #
            # Silent when data/gaza_places.json is absent, so an unreviewed
            # lexicon can never touch live data.
            _place_stats = None
            if structured_data:
                try:
                    from execution.place_lexicon import correct_rows as _fix_places
                    _place_stats = _fix_places(structured_data)
                    if _place_stats["changed"]:
                        logger.info(
                            f"Stage 4/6 | Place lexicon corrected "
                            f"{_place_stats['changed']} cell(s): "
                            + ", ".join(f"{c['before']!r}->{c['after']!r}"
                                        for c in _place_stats["changes"][:5]))
                except Exception as _pl_err:
                    logger.warning(f"Stage 4/6 | Place lexicon skipped (non-fatal): {_pl_err}")

            # ── Normalize gender and approval field values ────────────────────
            # Gender columns: any variant of (ذكر/م/male/انت) → ذكر; (أنثى/ف/female/بنت) → أنثى
            # Approval columns: any variant of (موافق/نعم/yes) → موافق; (غير موافق/لا/no) → غير موافق
            if structured_data:
                import re as _re  # ensure available even if gemini_col_order was empty
                _GENDER_COL_PAT   = _re.compile(r'جنس|نوع.{0,8}[اأإآ]جتماع|gender|sex', _re.I)
                # Approval columns: match موافق/قبول/وافق but NOT date columns (تاريخ الموافقة is a date)
                _APPROVAL_COL_PAT = _re.compile(r'موافق|قبول|وافق|توافق', _re.I)
                _DATE_COL_EXCL    = _re.compile(r'تاريخ|date', _re.I)
                # Values are folded before matching, so each spelling is listed
                # once in its normalised form. Enumerating them raw did not
                # scale: the pattern had "انتى" but not "أنتى", the same word
                # with a hamza, and that alone was 233 unmatched cells.
                def _norm_val(v: str) -> str:
                    v = _re.sub(r'[ً-ْٰ]', '', str(v or ''))
                    v = _re.sub(r'[أإآٱ]', 'ا', v)   # alef forms
                    v = _re.sub(r'[ىئ]', 'ي', v)                 # ya forms
                    v = v.replace('ة', 'ه')                            # ta marbuta
                    return ' '.join(v.split()).strip().lower()

                # Male: ذكر + OCR misreads (زلر = ذكر with ذ→ز ك→ل).
                # "انت" USED to be listed here. It is not male: across the
                # corpus, rows whose gender cell reads أنت carry female first
                # names 11 to 4, and every other ان-/أن- variant leans the same
                # way. They are all misreadings of أنثى, and leaving that entry
                # here would have sent 114 female rows to ذكر once folding began.
                _MALE_VAL_PAT     = _re.compile(
                    r'^(ذكر|ذك|ذكور|زلر|ذار|م|male|m|ولد|صبي)$', _re.I
                )
                # Female: أنثى and the ways it comes back misread -- ث read as
                # ت, ش, ن or ه, and the tail dropped. All normalised forms.
                _FEMALE_VAL_PAT   = _re.compile(
                    r'^(انثي|انتي|انت|انشي|انش|انني|اني|انه|اثني|التي|'
                    r'ف|female|f|بنت|فتاه|اناث)$', _re.I
                )
                # Yes: موافق + OCR misread مواجهه (و→ا, ق→جهـ) and موافقه/موافقة alternate forms
                # The tick is what extraction now records for an Azure selection
                # mark. It only means "agreed" in a column that asks for
                # agreement, which is exactly the columns this pattern is applied
                # to -- extraction used to write the word everywhere and turned a
                # disability answer of "لا" into "لا موافق".
                _YES_VAL_PAT      = _re.compile(
                    r'^(نعم|موافق|ن|yes|y|وافق|قبل|مقبول|مواجهه|موافقه|موافقة|'
                    r'لحم|نهم|لهم|نعنم|بعم)$', _re.I
                )
                _NO_VAL_PAT       = _re.compile(
                    r'^(لا|غير موافق|غير\s*موافق|ل|no|n|رفض|مرفوض|غير)$', _re.I
                )
                _DISABILITY_COL_PAT = _re.compile(r'[اأإآ]عاق|disab', _re.I)
                _YN_YES_PAT       = _re.compile(
                    r'^(نعم|ايوه|اجل|yes|y|لحم|نهم|لهم|نعنم|بعم)$', _re.I)
                _YN_NO_PAT        = _re.compile(r'^(لا|كلا|no|n)$', _re.I)
                # A bare tick or cross is left exactly as it was written.
                #
                # It is not normalised, because what a mark means depends on the
                # question and reading it either way is a guess; and it is not
                # blanked, because the person did answer -- erasing the mark
                # would destroy the answer rather than tidy it. It stays visible
                # for whoever is checking the sheet.
                _MARK_PAT = _re.compile(r'^[✓✔√×✕✖✗✘xX]$', _re.I)

                _all_cols = gemini_col_order or list(dict.fromkeys(k for p in structured_data for k in p))
                _gender_cols   = [c for c in _all_cols if _GENDER_COL_PAT.search(c)]
                # Exclude date columns from approval detection (e.g. تاريخ الموافقة = date field not consent)
                _approval_cols = [
                    c for c in _all_cols
                    if _APPROVAL_COL_PAT.search(c) and not _DATE_COL_EXCL.search(c)
                ]

                _disability_cols = [c for c in _all_cols
                                    if _DISABILITY_COL_PAT.search(c)]

                # A fixed-choice column has an answer set, and anything outside
                # it is not an answer. These columns were letting OCR noise
                # through untouched -- "8", "1", "لحم", "podéis!" sat in a
                # yes/no column looking like data. An empty cell says "nobody
                # knows, fill this in"; "لحم" says nothing at all and takes the
                # same amount of a person's attention to clear.
                #
                # Nothing here ever picks between the two valid answers. A value
                # that is not recognisably one of them is blanked, never guessed
                # into the more likely one.
                _CHOICES = [
                    (_gender_cols,     [(_MALE_VAL_PAT, "ذكر"), (_FEMALE_VAL_PAT, "أنثى")]),
                    (_approval_cols,   [(_YES_VAL_PAT, "موافق"), (_NO_VAL_PAT, "غير موافق")]),
                    (_disability_cols, [(_YN_YES_PAT, "نعم"), (_YN_NO_PAT, "لا")]),
                ]

                _norm_count = 0
                _blank_count = 0
                _blanked_samples: list = []
                for p in structured_data:
                    for cols, rules in _CHOICES:
                        for col in cols:
                            raw = (p.get(col) or "").strip()
                            if not raw:
                                continue
                            valid = [v for _, v in rules]
                            if raw in valid:
                                continue
                            # "موافق موافق" -> "موافق"
                            dedup = " ".join(dict.fromkeys(raw.split()))
                            if dedup in valid:
                                p[col] = dedup
                                _norm_count += 1
                                continue
                            # A mark is an answer, just not one of the words.
                            if _MARK_PAT.match(raw):
                                continue
                            raw_n = _norm_val(raw)
                            for pat, value in rules:
                                if pat.match(raw_n):
                                    p[col] = value
                                    _norm_count += 1
                                    break
                            else:
                                p[col] = None
                                _blank_count += 1
                                if len(_blanked_samples) < 8:
                                    _blanked_samples.append(f"{col[:18]}={raw[:14]!r}")

                if _blank_count:
                    logger.info(
                        f"Stage 4/6 | Blanked {_blank_count} fixed-choice cell(s) "
                        f"that matched no allowed answer: "
                        + ", ".join(_blanked_samples))
                if _gender_cols or _approval_cols or _disability_cols:
                    logger.info(
                        f"Stage 4/6 | Field normalization: gender={_gender_cols} "
                        f"approval={_approval_cols} disability={_disability_cols} "
                        f"| {_norm_count} normalized, {_blank_count} blanked"
                    )

                # Drop completely empty rows (all values null/empty) — blank table rows from OCR
                _before = len(structured_data)
                structured_data = [
                    p for p in structured_data
                    if any(v for v in p.values() if v and str(v).strip() and not str(v).startswith("_"))
                ]
                if len(structured_data) < _before:
                    logger.info(f"Stage 4/6 | Dropped {_before - len(structured_data)} empty row(s)")

            # ── Deduplicate semantically identical columns ─────────────────────
            # Root cause: Gemini produces duplicate columns for the same real column when
            # the OCR text contains the header more than once (multi-page, bilingual labels,
            # or spanning cells that Vision splits into multiple text lines).
            #
            # Gemini path ONLY.  Azure Layout returns a real geometric grid: every
            # column is a physical column with its own cell polygons, and
            # _effective_headers has already made the names unique -- there is
            # nothing to deduplicate.  Running these heuristics on a real grid
            # destroys data.  On an attendance sheet with one column per date,
            # _col_tokens("18/8/2026") drops the parts shorter than 3 chars and
            # returns {"2026"} for every single date, so Pass 2 sees a 1/1 token
            # overlap and merges 7 of the 8 date columns into the first -- then
            # fills that survivor's blanks with their values, so the column that
            # remains shows another date's data.  Duplicate columns are an LLM
            # failure mode, not a grid one.
            #
            # Two-pass strategy:
            #   Pass 1 — explicit semantic roots: signature, disability, phone, approval
            #   Pass 2 — general token overlap: any two columns that share ≥1 significant
            #            Arabic/English token (after normalization) are merged
            #
            # In both passes: keep the longest/most-descriptive header, merge the
            # shorter column's non-null values into it (fill gaps only), then drop it.
            if structured_data and gemini_col_order and _stage4_source == "azure_layout":
                logger.info(
                    f"Stage 4/6 | Dedup skipped — Azure grid is authoritative "
                    f"({len(gemini_col_order)} column(s) kept as detected)")
            elif structured_data and gemini_col_order:
                import re as _re

                def _merge_cols(_order, _data, _primary, _secondaries):
                    """Merge _secondaries into _primary across all rows; update col order."""
                    for _sec in _secondaries:
                        for _p in _data:
                            if not _p.get(_primary) and _p.get(_sec):
                                _p[_primary] = _p[_sec]
                            _p.pop(_sec, None)
                    _order[:] = [c for c in _order if c not in _secondaries]
                    logger.info(f"Stage 4/6 | Dedup: merged {_secondaries} → {_primary!r}")

                # ── Pass 1: Explicit semantic roots ────────────────────────────
                _DEDUP_ROOTS = [
                    _re.compile(r'توقيع|signature|sign', _re.I),
                    _re.compile(r'إعاقة|اعاقة|disability|special.need', _re.I),
                    _re.compile(r'هاتف|تليفون|جوال|phone|mobile|tel(?:ephone)?', _re.I),
                    _re.compile(r'^موافق|^الموافق|^قبول|^approval', _re.I),
                    # DOB synonyms: تاريخ الميلاد / تاريخ الولادة / date of birth
                    # Adding تاريخ to Pass2 STOP means these no longer merge via token overlap;
                    # this explicit root handles that synonym case.
                    _re.compile(r'ميلاد|ولادة|مولد|birth|dob', _re.I),
                ]
                # Guard: don't merge guardian signature with participant signature.
                # "اسم وتوقيع ولي الأمر" (guardian) ≠ "التوقيع" (participant).
                _GUARDIAN_PAT = _re.compile(r'ول[يى]|guardian', _re.I)
                for _root_pat in _DEDUP_ROOTS:
                    _matched = [c for c in gemini_col_order if _root_pat.search(c)]
                    if len(_matched) <= 1:
                        continue
                    # If the match set mixes guardian and non-guardian columns, skip.
                    _has_guardian    = any(_GUARDIAN_PAT.search(c) for c in _matched)
                    _has_non_guardian = any(not _GUARDIAN_PAT.search(c) for c in _matched)
                    if _has_guardian and _has_non_guardian:
                        logger.info(f"Stage 4/6 | Dedup Pass 1: skipping merge of {_matched} "
                                    f"(guardian vs participant signature)")
                        continue
                    _primary = max(_matched, key=len)
                    _merge_cols(gemini_col_order, structured_data, _primary,
                                [c for c in _matched if c != _primary])

                # ── Pass 2: General token-overlap dedup ────────────────────────
                # Normalize a column name to a set of "significant" tokens.
                # Tokens shorter than 3 chars or in the stoplist are ignored.
                _STOP = frozenset({'في', 'من', 'على', 'إلى', 'عن', 'بين', 'ذو', 'ذا', 'هذا',
                                   'هذه', 'كان', 'يكون', 'بال', 'وال', 'بـ', 'لـ', 'the', 'of',
                                   'and', 'for', 'رقم', 'اسم', 'بيانات', 'معلومات', 'كلمة',
                                   # "للمشارك" / "المشارك" appear in many column headers as a
                                   # grammatical qualifier (= "for the participant") — NOT a
                                   # semantic column identifier.  Without this exclusion Pass 2
                                   # merges "الاسم الرباعي للمشارك" with "التوقيع … للمشارك".
                                   'للمشارك', 'المشارك', 'للمشاركة', 'المشاركة',
                                   # Similar structural filler tokens
                                   'اقل', 'عام', 'سنة', 'العمر', 'الامر', 'الأمر',
                                   # "تاريخ" (= "date of") is a structural prefix, not a
                                   # semantic differentiator.  Without this, "تاريخ الميلاد"
                                   # (DOB) and "تاريخ الموافقة" (approval date) each tokenize
                                   # to {تاريخ, X}, share تاريخ at exactly 50%, and get merged
                                   # → DOB column disappears.
                                   'تاريخ', 'date',
                                   # "الموزع" (= "of the distributor") is a possessive
                                   # qualifier shared by "اسم الموزع" and "رقم جوال الموزع".
                                   # Without excluding it, Pass 2 sees the shared token
                                   # "موزع" and merges the distributor-NAME column into the
                                   # distributor-PHONE column — silently dropping a column.
                                   'موزع'})

                def _col_tokens(s):
                    s = _re.sub(r'[\u064B-\u065F\u0670]', '', s)   # diacritics
                    s = _re.sub(r'[أإآٱ]', 'ا', s)                 # alef variants
                    s = _re.sub(r'[يىئ]', 'ي', s)                  # yeh variants
                    parts = _re.split(r'[\s/\-_\|]+', s.strip())
                    result = set()
                    for p in parts:
                        p = p.lower()
                        # Strip definite article prefix (ال) and Arabic "and" connector (و)
                        if p.startswith('ال') and len(p) > 2: p = p[2:]
                        if p.startswith('و') and len(p) > 2:  p = p[1:]
                        if len(p) >= 3 and p not in _STOP:
                            result.add(p)
                    return frozenset(result)

                # Build token sets once
                _col_tok = {c: _col_tokens(c) for c in list(gemini_col_order)}

                # Check every pair — greedy: first found pair is merged immediately
                _changed = True
                while _changed:
                    _changed = False
                    _cols_now = list(gemini_col_order)
                    for _i in range(len(_cols_now)):
                        for _j in range(_i + 1, len(_cols_now)):
                            _a, _b = _cols_now[_i], _cols_now[_j]
                            _ta, _tb = _col_tok.get(_a, frozenset()), _col_tok.get(_b, frozenset())
                            # Skip if either has no significant tokens (prevents spurious merges)
                            if not _ta or not _tb:
                                continue
                            # Merge if shared tokens ≥ 1 AND shared fraction > 50% of shorter set
                            _shared = _ta & _tb
                            _shorter_len = min(len(_ta), len(_tb))
                            if _shared and len(_shared) / _shorter_len >= 0.5:
                                # Don't merge guardian column with non-guardian column
                                _a_guard = bool(_GUARDIAN_PAT.search(_a))
                                _b_guard = bool(_GUARDIAN_PAT.search(_b))
                                if _a_guard != _b_guard:
                                    continue
                                # Don't merge a date column with a non-date column
                                # e.g. "تاريخ الموافقة" must not merge with "الموافقة على..."
                                _DATE_COL_GUARD = _re.compile(r'تاريخ|date', _re.I)
                                if bool(_DATE_COL_GUARD.search(_a)) != bool(_DATE_COL_GUARD.search(_b)):
                                    continue
                                _primary = max((_a, _b), key=len)
                                _secondary = _b if _primary == _a else _a
                                _merge_cols(gemini_col_order, structured_data,
                                            _primary, [_secondary])
                                _changed = True
                                break
                        if _changed:
                            break

                # ── Final safety: remove any exact-duplicate keys Gemini still emitted ──
                _seen_cols: list = []
                for _c in gemini_col_order:
                    if _c not in _seen_cols:
                        _seen_cols.append(_c)
                gemini_col_order = _seen_cols

            logger.info(
                f"Stage 4/6 | Structuring complete | source={_stage4_source} | "
                f"{len(structured_data)} row(s) | {len(gemini_col_order)} col(s)"
            )
            _pipeline_dbg["stages"]["gemini"] = {
                "success":          True,
                "source":           _stage4_source,
                "participant_count": len(structured_data),
                "column_order":     gemini_col_order,
                # structured_data is the full extracted table (names/PII) — only
                # persist it to the debug JSON when debug is explicitly enabled.
                "structured_data":  structured_data if debug else f"<{len(structured_data)} rows redacted>",
            }
            if _stage4_source == "gemini":
                trace.step(
                    "STAGE 4 | Structuring",
                    model=gemini_result.get("model", "gemini"),
                    action="Gemini parsed OCR text + page image into structured participant records",
                    decision=f"Extracted {len(structured_data)} row(s) with {len(gemini_col_order)} column(s)",
                    details={
                        "Rows":    len(structured_data),
                        "Columns": ", ".join(gemini_col_order[:6]) + ("…" if len(gemini_col_order) > 6 else ""),
                        "Input":   f"{len(clean_text)} chars",
                    },
                )
            # Azure layout trace step was already emitted in Stage 4a above

        if not structured_data:
            logger.warning(f"Stage 4/6 | Both Azure layout and Gemini failed — using regex fallback")
            _pipeline_dbg["stages"]["gemini"] = {"success": False, "error": gemini_result.get("error")}
            trace.step("STAGE 4 | Structuring", status="FAILED",
                       action=f"Both Azure layout and Gemini structuring failed — regex fallback in use")
    except Exception as e:
        logger.warning(f"Stage 4/6 | Gemini error (non-fatal): {e} — using regex fallback")
        trace.step("STAGE 4 | Structuring", status="FAILED", action=str(e))

    # ── Quality Layer 4: Mathematical & Logical Reconciliation ──────────────
    _ql4_status  = "SKIPPED"
    _ql4_details: dict = {}
    _ql4_issues:  list[str] = []
    if structured_data:
        try:
            from execution.ocr_quality import mathematical_reconciliation
            _reconcile_result = mathematical_reconciliation(structured_data)
            _pipeline_dbg["stages"]["quality_l4"] = _reconcile_result
            _ql4_details = {
                "Rows checked":      len(structured_data),
                "Rows clean":        _reconcile_result["rows_clean"],
                "Anomalies found":   _reconcile_result["anomaly_count"],
                "Arithmetic checks": _reconcile_result["arithmetic_checks"],
            }
            _ql4_issues = [
                f"Row {a['row']} / {a['field']}: {a['issue']} — found {str(a['found'])[:30]!r}"
                for a in _reconcile_result.get("anomalies") or []
            ]
            _ql4_status = "WARNING" if _reconcile_result["anomaly_count"] > 0 else "OK"

            # ── Stage 4.7: re-read the cells QL4 just proved wrong ──────────
            # QL4 detects malformed phones and IDs but nothing acted on it. The
            # Stage 3.95 Gemini Judge picks cells by Azure confidence, a different
            # question, and never looked at these. Measured on one sheet, both
            # phone misses were cells QL4 had already flagged.
            #
            # One cell per call, and a reply is kept only if it satisfies the
            # rule the original value broke -- so a cell gets better or stays
            # as it was, never worse.
            try:
                from execution.digit_repair import repair_flagged_cells, enabled as _dr_on
                if (_dr_on() and _reconcile_result.get("anomalies")
                        and _layout_cell_polygons):
                    _dr = repair_flagged_cells(
                        structured_data,
                        _layout_cell_polygons,
                        _reconcile_result["anomalies"],
                        image_bytes,
                        ("application/pdf" if image_bytes[:4] == b"%PDF"
                         else "image/jpeg"),
                    )
                    _summary = (f"{_dr['fixed']} fixed, {_dr['rejected']} rejected "
                                f"of {_dr['attempted']} attempted")
                    if _dr.get("guard_blocked"):
                        _summary += f", {_dr['guard_blocked']} blocked by identity guard"
                    # An engine that answers nothing is an outage. Naming it in
                    # the trace is what turns "0 fixed" from ambiguous into a
                    # thing someone can act on.
                    if _dr.get("engine_errors"):
                        _summary += (f" — ENGINE FAILED on {_dr['engine_errors']} "
                                     f"cell(s), numbers NOT corrected")
                    _ql4_details["Digit repair"] = _summary
                    logger.info(f"[DigitRepair] {_dr}")
            except Exception as _dr_err:
                logger.warning(f"[DigitRepair] skipped (non-fatal): {_dr_err}")
        except Exception as _ql4_err:
            _ql4_status = "FAILED"
            _ql4_details["error"] = str(_ql4_err)
            logger.warning(f"Quality/L4 | Reconciliation failed (non-fatal): {_ql4_err}")

    trace.step(
        "QUALITY L4 | Math Reconciliation",
        status=_ql4_status,
        action="Validated phones, name completeness, date formats, and arithmetic consistency",
        details=_ql4_details,
        issues=_ql4_issues,
    )

    # ── Stage 4.6: Three-Engine Field Voting ──────────────────────────────────
    # Compare Gemini, Azure, and Vision raw readings for each name field per row.
    #
    # Vote rules:
    #   All 3 agree (after Arabic normalisation)  → unanimous winner
    #   Any 2 agree                               → majority wins
    #   All 3 differ                              → dict_score×0.6 + confidence×0.4
    #
    # dict_score: fraction of name tokens found in embedded Arabic names vocabulary.
    # Confidence: Azure read word-level confidence (0–1); Gemini/Vision = 0.
    #
    # Azure name candidates:
    #   If Azure layout was used for structuring → extract names from structured_data
    #   Otherwise → use _azure_raw_names (from Azure read pipe-text)
    #
    # Vision name candidates:
    #   extracted from Vision plain text (Arabic-dominant lines, 1–8 words).
    #   Matched to each row via sequence-similarity against the reference name.
    _voting_stats: dict = {}
    # BYPASSED when Azure Layout wins: Stage 3.9 spatial voting already did the
    # cell-level work (Layout vs Vision vs Azure Read, bbox-aligned). The
    # index-based voter here was tested with Vision-only on Azure Layout and
    # corrupted names because Vision's per-row indexing leaks tokens from
    # adjacent rows. The bbox-aligned spatial vote is safe; index vote is not.
    if _stage4_source == "azure_layout":
        logger.info("Stage 4.6/6 | Field voting SKIPPED — spatial voting done at Stage 3.9")
        trace.step("STAGE 4.6 | Field Voting", status="SKIPPED",
                   action="Spatial cell voting already applied at Stage 3.9 (bounding-box aligned)")
    elif structured_data and _azure_enabled and gemini_ocr_result and gemini_ocr_result.get("success"):
        try:
            import re as _rev
            _NAME_RE = _rev.compile(r"اسم|الاسم", _rev.I)
            _name_cols_for_vote = [c for c in (gemini_col_order or []) if _NAME_RE.search(c)]

            # Fallback: if no اسم column found, check if the first column is Arabic-heavy
            if not _name_cols_for_vote and structured_data:
                _first_col = next(iter(structured_data[0]), None)
                if _first_col:
                    _sample_vals = [str(r.get(_first_col) or "") for r in structured_data[:5] if r.get(_first_col)]
                    _ar_ratio = (
                        sum(
                            sum(1 for c in v if "\u0600" <= c <= "\u06FF") / max(len(v), 1)
                            for v in _sample_vals
                        ) / max(len(_sample_vals), 1)
                        if _sample_vals else 0.0
                    )
                    if _ar_ratio >= 0.50:
                        _name_cols_for_vote = [_first_col]

            if _name_cols_for_vote:
                from execution.ocr_voter import vote_participants

                # Build Azure name dict: if layout won, pull names from structured_data
                # (which IS the Azure layout output); else use _azure_raw_names.
                if _stage4_source == "azure_layout" and not any(_azure_raw_names.values()):
                    _az_names_vote: dict[int, str] = {
                        i: (row.get(_name_cols_for_vote[0]) or "").strip()
                        for i, row in enumerate(structured_data)
                    }
                else:
                    _az_names_vote = _azure_raw_names

                _vis_text = vision_result.get("full_text", "") if vision_result else ""

                structured_data, _voting_stats = vote_participants(
                    structured_data  = structured_data,
                    name_cols        = _name_cols_for_vote,
                    gemini_raw_names = _gemini_raw_names,
                    azure_raw_names  = _az_names_vote,
                    vision_text      = _vis_text,
                    azure_conf       = _azure_conf_avg,
                )

                _changed46 = sum(v for k, v in _voting_stats.items() if k != "unchanged")
                logger.info(
                    f"Stage 4.6/6 | Field voting | cols={_name_cols_for_vote} | "
                    + " ".join(f"{k}={v}" for k, v in _voting_stats.items() if v > 0)
                )
                trace.step(
                    "STAGE 4.6 | Field Voting",
                    status="OK" if _changed46 > 0 else "OK",
                    action="Per-row name vote: 2+ engines agree → majority; all differ → dict, then Vision",
                    details={
                        "name_cols": _name_cols_for_vote,
                        "stats":     _voting_stats,
                        "changed":   _changed46,
                    },
                )
            else:
                logger.info("Stage 4.6/6 | Field voting skipped — no name columns detected")
                trace.step("STAGE 4.6 | Field Voting", status="SKIPPED",
                           action="No name columns detected in column order")
        except Exception as _e46:
            logger.warning(f"Stage 4.6/6 | Field voting failed (non-fatal): {_e46}")
            trace.step("STAGE 4.6 | Field Voting", status="FAILED", action=str(_e46))
    else:
        trace.step("STAGE 4.6 | Field Voting", status="SKIPPED",
                   action="Azure not enabled or no secondary engine (Vision/Gemini) succeeded")

    # ── Stage 4.4: Row-level name rescue from Gemini OCR ───────────────────────
    # When Azure Layout's name cell has fewer Arabic tokens than Gemini OCR's
    # row name AND Gemini's first token is a known given name, replace.
    # See _rescue_weak_names_from_gemini_ocr for safety gates.
    if structured_data and _gemini_raw_names:
        try:
            structured_data, _n_rescued = _rescue_weak_names_from_gemini_ocr(
                structured_data=structured_data,
                gemini_raw_names=_gemini_raw_names,
                column_order=gemini_col_order,
            )
            logger.info(f"Stage 4.4/6 | Name rescue: {_n_rescued} row(s) replaced from Gemini OCR")
            trace.step(
                "STAGE 4.4 | Name Rescue",
                status="OK" if _n_rescued else "SKIPPED",
                action="Replaced weak Azure Layout name cells with stronger Gemini OCR row names",
                details={"rows_rescued": _n_rescued},
            )
        except Exception as _s44_err:
            logger.warning(f"Stage 4.4/6 | Name rescue failed (non-fatal): {_s44_err}")
            trace.step("STAGE 4.4 | Name Rescue", status="FAILED", action=str(_s44_err))

    # ── Stage 4.5: Per-cell DB correction lookup ──────────────────────────────
    if structured_data:
        try:
            _s45_before = sum(
                1 for row in structured_data for v in row.values()
                if v and isinstance(v, str)
            )
            structured_data = _apply_per_cell_corrections(structured_data, supabase)
            trace.step(
                "STAGE 4.5 | Per-Cell Corrections",
                action="Applied confirmed OCR corrections to individual structured cells",
            )
        except Exception as _s45_err:
            logger.warning(f"Stage 4.5/6 | Per-cell correction failed (non-fatal): {_s45_err}")
            trace.step("STAGE 4.5 | Per-Cell Corrections", status="FAILED", action=str(_s45_err))

    # Always run regex parser as fallback / supplement
    try:
        fields = _parse_fields(clean_text)
        logger.info(f"Stage 4/6 | Regex fallback parsed {len(fields)} fields")
    except Exception as e:
        fields = []
        logger.warning(f"Stage 4/6 | Regex parser error: {e}")

    # Embed column order into fields_json as a sentinel entry.
    # This uses no new DB column — JSONB array element values preserve order.
    if gemini_col_order:
        fields = [{"field_name": "__column_order__", "value": "||".join(gemini_col_order)}] + fields

    # ── Stage 4a.1: Gemini value-cleaning pass ────────────────────────────────
    # PERMANENTLY BYPASSED when Azure layout is the source — Gemini re-serializes
    # the entire table through an LLM, which can reorder rows, shift columns, or
    # corrupt alignment.  Phone/date fixes are handled deterministically by
    # _fix_phone and _fix_date in Stage 4a instead.
    if _stage4_source == "azure_layout":
        logger.info("Stage 4a.1/6 | Gemini value-cleaning SKIPPED — deterministic fixes used instead")
        trace.step("STAGE 4a.1 | Value Cleaning", status="SKIPPED",
                   action="Using deterministic _fix_phone/_fix_date instead of LLM re-serialization")
    elif structured_data and gemini_col_order:
        try:
            from execution.extract_gemini import clean_values_with_gemini
            _cleaned = clean_values_with_gemini(
                participants=structured_data,
                column_order=gemini_col_order,
                job_id=job_id,
            )
            if _cleaned is not structured_data:
                structured_data = _cleaned
                logger.info(f"Stage 4a.1/6 | Value-cleaning applied to {len(structured_data)} rows")
                trace.step("STAGE 4a.1 | Value Cleaning", status="OK", model="gemini",
                           action="Cleaned phones (leading 0), dates (YYYY/M/D), signatures (null if fragment)")
            else:
                logger.info("Stage 4a.1/6 | Value-cleaning: no changes (API key missing or call failed)")
        except Exception as _e_vc:
            logger.warning(f"Stage 4a.1/6 | Value-cleaning error (non-fatal): {_e_vc}")

    # ── Stage 4a.2: Universal signature guard ─────────────────────────────────
    # Clears signature cells ONLY when they are clearly a leak from the same
    # row's name column (exact match or token subset). Previously also cleared
    # "short fragments" but that wiped legitimate signatures — removed.
    #
    # Rule (per row):
    #   • If sig value equals (or is a token-subset of) the name value in the
    #     same row → clear it.  Otherwise leave it alone.
    if structured_data and gemini_col_order:
        try:
            import re as _re_sig
            from execution.ocr_voter import normalize_arabic as _norm_ar
            _SIG_PAT  = _re_sig.compile(r'توقيع|imza|signature|sign', _re_sig.I)
            _NAME_PAT_SIG = _re_sig.compile(r'اسم|الاسم|name', _re_sig.I)
            _GUARDIAN_PAT = _re_sig.compile(r'ول[يى]|guardian', _re_sig.I)

            # Only clean PARTICIPANT signature columns — guardian signature
            # columns ("توقيع ولي الأمر") are a separate field and may legitimately
            # contain a different name, so leave them alone.
            _sig_cols = [
                c for c in gemini_col_order
                if _SIG_PAT.search(c) and not _GUARDIAN_PAT.search(c)
            ]
            # Exclude sig columns from name detection — prevents a sig column
            # whose header contains "اسم" from being compared against itself.
            _name_cols_sig = [
                c for c in gemini_col_order
                if _NAME_PAT_SIG.search(c) and c not in _sig_cols
            ]

            _sig_cleaned = 0
            if _sig_cols:
                for _row in structured_data:
                    for _sig_col in _sig_cols:
                        _v = _row.get(_sig_col)
                        if not isinstance(_v, str) or not _v.strip():
                            continue
                        _v_norm = _norm_ar(_v)
                        _v_toks = set(_v_norm.split())

                        # Rule 1: matches any name column in this row
                        leaked_from_name = False
                        for _name_col in _name_cols_sig:
                            _n = _row.get(_name_col)
                            if not isinstance(_n, str) or not _n.strip():
                                continue
                            _n_norm = _norm_ar(_n)
                            if not _n_norm:
                                continue
                            _n_toks = set(_n_norm.split())
                            # Exact match OR signature tokens are a subset of
                            # the name tokens (and at least one shared token of
                            # length ≥ 3 — avoids stray-particle collisions).
                            if (
                                _v_norm == _n_norm
                                or (
                                    _v_toks
                                    and _v_toks.issubset(_n_toks)
                                    and any(len(t) >= 3 for t in _v_toks)
                                )
                            ):
                                leaked_from_name = True
                                break

                        if leaked_from_name:
                            _row[_sig_col] = None
                            _sig_cleaned += 1
                            continue

                logger.info(
                    f"Stage 4a.2/6 | Signature guard | sig_cols={_sig_cols} | "
                    f"name_cols={_name_cols_sig} | cleared={_sig_cleaned}"
                )
                trace.step(
                    "STAGE 4a.2 | Signature Guard",
                    action="Cleared signature cells that leaked from name column or were fragment noise",
                    details={
                        "sig_cols": _sig_cols,
                        "cleared":  _sig_cleaned,
                    },
                )
        except Exception as _e_sig:
            logger.warning(f"Stage 4a.2/6 | Signature guard error (non-fatal): {_e_sig}")

    # ── Pre-Stage-5 guard: reject documents with no extractable table data ────
    # Both Azure layout AND Gemini structuring failed to produce any rows. The
    # document likely has no tables — fail loudly so the user gets a clear
    # explanation instead of a "completed" job with an empty grid.
    if not structured_data:
        msg = (
            "No tables detected in this document. "
            "Violet is built for tabular data (forms, registers, attendance lists). "
            "Please upload a document containing a table."
        )
        logger.warning(f"Stage 4.9/6 | Pre-validation FAILED — {msg}")
        trace.step("STAGE 4.9 | Table Pre-validation", status="FAILED", action=msg)
        return _fail(supabase, job_id, msg)

    # ── Stage 5: Save to Supabase ─────────────────────────────────────────────
    # OCR + Gemini can take 60-90 s. By this point the original Supabase TCP
    # connection is almost certainly stale (WinError 10054 / ConnectionReset).
    # Always create a fresh client here so Stage 5-6 and any error paths use a
    # live connection. Reassign `supabase` so helpers below also see it.
    logger.info(f"Stage 5/6 | Saving to Supabase (fresh connection)")
    try:
        supabase = create_client(
            os.environ["NEXT_PUBLIC_SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
    except Exception as conn_err:
        return _fail(supabase, job_id, f"Database reconnect failed: {conn_err}")

    def _do_save(sb) -> None:
        """Inner save — separated so retry can call with a brand-new client."""
        update_data = {
            "full_text": full_text,
            "fields_json": fields,
        }
        if structured_data is not None:
            update_data["structured_data"] = structured_data
            # Store column order explicitly — JSONB does not preserve key order.
            # Prefer the order Gemini returned; fall back to first-appearance order.
            if gemini_col_order:
                update_data["column_order"] = gemini_col_order
            else:
                update_data["column_order"] = list(dict.fromkeys(k for p in structured_data for k in p.keys()))
        # Cell polygons enable the training-data cropper. Only present when Azure
        # layout produced them; Gemini-only paths leave this empty (cropper skips).
        try:
            if _layout_cell_polygons:  # may not exist if Azure layout was skipped
                update_data["cell_polygons"] = _layout_cell_polygons
        except NameError:
            pass
        try:
            sb.table("document_jobs").update(update_data).eq("id", job_id).execute()
        except Exception as save_err:
            # Migration-not-yet-run guards: drop unknown columns and retry once.
            err_msg = str(save_err)
            retried = False
            for missing_col in ("column_order", "cell_polygons"):
                if missing_col in err_msg and missing_col in update_data:
                    logger.warning(f"Stage 5/6 | {missing_col} column missing — saving without it")
                    del update_data[missing_col]
                    retried = True
            if retried:
                sb.table("document_jobs").update(update_data).eq("id", job_id).execute()
            else:
                raise

        # NOTE: We intentionally do NOT save the per-page raw_vision_response
        # JSON or full_text into document_pages anymore. Those fields are
        # write-only — no production code reads them, and the raw Vision JSON
        # was the dominant source of database bloat (often 100–500 KB per page).
        # The structured names + fields are already saved on document_jobs above,
        # which is what every user-facing feature reads. If page-level debug data
        # is ever needed, the per-job pipeline_debug JSON in .tmp/ has more.

    try:
        _do_save(supabase)
        logger.info(f"Stage 5/6 | Saved | Pages stored: {len(ocr_result['pages'])}")
        trace.step("STAGE 5 | Database Save",
                   action="Structured data, OCR text, and column order saved to Supabase",
                   details={"pages": len(ocr_result["pages"]), "rows": len(structured_data or [])})
    except OSError as e:
        logger.warning(f"Stage 5/6 | Connection error on save ({e}) — retrying with new client")
        try:
            supabase = create_client(
                os.environ["NEXT_PUBLIC_SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            )
            _do_save(supabase)
            logger.info(f"Stage 5/6 | Saved (retry OK) | Pages stored: {len(ocr_result['pages'])}")
            trace.step("STAGE 5 | Database Save",
                       action="Saved after connection retry",
                       details={"pages": len(ocr_result["pages"])})
        except Exception as retry_err:
            trace.step("STAGE 5 | Database Save", status="FAILED", action=str(retry_err))
            return _fail(supabase, job_id, f"Database save error: {retry_err}")
    except Exception as e:
        trace.step("STAGE 5 | Database Save", status="FAILED", action=str(e))
        return _fail(supabase, job_id, f"Database save error: {e}")

    # Stage 6 (Excel generation) removed — Excel is now on-demand only.
    # Users click "Export to Excel" on the document page; the /generate-excel
    # endpoint handles it from the structured_data already saved in Stage 5.

    # ── Mark COMPLETED — after the names are final, before the crop ───────────
    # Order matters twice over.
    #
    # Stage 5.5 runs BEFORE this flip: the frontend renders the table the moment
    # the job reads 'completed', so flipping first showed the customer Azure's
    # names and then silently swapped them on the next refresh.
    #
    # crop_job_names() runs AFTER: it refuses to run unless the status is
    # already 'completed' (returning error="not_completed"), so cropping first
    # made auto-crop a silent no-op on every upload and the file showed
    # "needs crop" until someone clicked it by hand.
    # ── Stage 5.5: re-read the name cells with the fine-tuned model ───────────
    # Azure reads handwritten Arabic names at 26% exact; the LoRA reads them at
    # 63% exact / 87% per name (frozen held-out set), so this is the difference
    # between a customer retyping most names and confirming most of them.
    #
    # Runs AFTER Stage 5, not earlier: it rewrites structured_data, which does
    # not exist until structuring has saved it. It deliberately leaves
    # cell_polygons alone -- the training cropper labels from that text, and
    # feeding the model its own guesses as ground truth would poison the next
    # training round.
    #
    # Off unless LORA_NAMES_ENABLED=1, and non-fatal either way: on any failure
    # the customer keeps Azure's names, exactly as before this stage existed.
    try:
        from execution.lora_names import read_job_names, enabled as _lora_on
        if _lora_on():
            _lora_stats = read_job_names(job_id, supabase=supabase)
            trace.step(
                "STAGE 5.5 | LoRA Name Reading",
                status="OK" if not _lora_stats.get("error") else "FAILED",
                action=("Re-read handwritten name cells with the fine-tuned "
                        "Qwen2.5-VL adapters; lexicon picks between them"),
                details=_lora_stats,
            )
            logger.info(f"[LoraNames] {_lora_stats}")
        else:
            trace.step("STAGE 5.5 | LoRA Name Reading", status="DISABLED",
                       action="LORA_NAMES_ENABLED is not set")
    except Exception as _lora_err:
        logger.warning(f"[LoraNames] Skipped (non-fatal): {_lora_err}")
        trace.step("STAGE 5.5 | LoRA Name Reading", status="FAILED", action=str(_lora_err))

    # ── Settle the bill ───────────────────────────────────────────────────────
    # One extracted row costs 1.5 cents, rounded up to a whole cent per
    # document (migration 035). The count is only final here, after
    # Stage 5.5 has rewritten the names, so this is the earliest honest moment
    # to charge.
    #
    # settle_job does the whole read-modify-write under a row lock and decides
    # the outcome itself:
    #   paid   -- balance covered it, deducted, ledger written
    #   unpaid -- it did not, so the job is held and the document page shows the
    #             result locked behind a top-up rather than handing it over
    #
    # Deliberately BEFORE the flip to 'completed': the frontend renders as soon
    # as it sees that status, and a completed job whose payment_status was still
    # 'pending' would show the table for the moment it took this call to return.
    _row_count = len(structured_data or [])
    try:
        _settle = supabase.rpc("settle_job", {
            "p_job_id": job_id, "p_user_id": user_id, "p_rows": _row_count,
        }).execute()
        _s = _settle.data if isinstance(_settle.data, dict) else {}
        # Every finished run is charged, reprocess and re-upload included
        # (migration 037). "already" only comes back from a database still on
        # the old one-charge-per-document rules, and then nothing was taken --
        # so say so rather than print a price that reads like a charge.
        if _s.get("already"):
            _bill_msg = (f"{_row_count} rows, NOT charged: document already paid and "
                         f"migration 037 is not applied | balance {_s.get('balance_cents', '?')}c")
        else:
            _bill_msg = (f"{_row_count} rows = {_s.get('cost_cents', '?')}c "
                         f"-> {_s.get('status', '?')} | balance {_s.get('balance_cents', '?')}c")
        logger.info(f"Stage 6/6 | Billing: {_bill_msg}")
        trace.step("STAGE 6 | Billing",
                   status="OK" if _s.get("status") == "paid" else "HELD",
                   action=_bill_msg,
                   details=_s)
    except Exception as _bill_err:
        # Never fail a job over billing. The work is done and the customer's
        # data is safe; an uncharged job is a reconciliation problem, a lost
        # job is a support ticket. It stays 'pending' and can be settled from
        # the document page's "check again" button.
        logger.warning(f"Stage 6/6 | Billing failed (non-fatal): {_bill_err}")
        trace.step("STAGE 6 | Billing", status="FAILED", action=str(_bill_err))

    _update_job_status(supabase, job_id, "completed", completed_at=datetime.now(timezone.utc).isoformat())

    # ── Auto-crop name cells for the training dataset ─────────────────────────
    # Synchronous, best-effort. Idempotent (UNIQUE on job_id/participant/field)
    # so re-running on the same job is a no-op. Skipped silently when polygons
    # aren't available (e.g. Gemini-only path) or when the training_crops bucket
    # doesn't exist yet.
    try:
        from execution.crop_names import crop_job_names
        crop_stats = crop_job_names(job_id, supabase=supabase)
        logger.info(f"[CropNames] {crop_stats}")
    except Exception as _crop_err:
        logger.warning(f"[CropNames] Skipped (non-fatal): {_crop_err}")

    # ── Auto-grow name dictionary (synchronous) ───────────────────────────────
    # MUST run synchronously, NOT in a daemon thread. In serverless (Modal) the
    # worker container terminates as soon as run_pipeline returns, killing any
    # background daemon thread mid-write — which means name_candidates rows from
    # this job's corrections never get persisted. Synchronous adds ~0.5–2 s but
    # guarantees the write completes.
    try:
        from execution.grow_name_dict import collect, promote
        # collect() takes only `supabase` — passing dry_run raised TypeError on
        # every document, swallowed by the handler below, so this loop never ran.
        # It also returns {inserted, updated, ...}; there is no "new_candidates".
        collected = collect(supabase=supabase)
        _new = (collected or {}).get("inserted", 0) + (collected or {}).get("updated", 0)
        if _new > 0:
            promote(supabase=supabase, dry_run=False)
            # Reset dict_score vocab cache so subsequent calls in the same
            # container re-read with the new names.
            import execution.ocr_voter as _ov
            _ov._FULL_VOCAB = None
            logger.info(
                f"[DictGrow] Auto-promote done — {_new} new/updated names, vocab cache reset"
            )
    except Exception as _e:
        # Non-fatal — corrections are still saved in field_corrections + ocr_corrections;
        # only the dictionary growth got skipped this round.
        logger.warning(f"[DictGrow] Sync grow failed (non-fatal): {_e}")

    # ── Complete ───────────────────────────────────────────────────────────────
    # (status was already set to 'completed' above, before the crop step, so
    # auto-crop could run — nothing more to flip here.)
    elapsed = round(time.time() - pipeline_start, 2)
    logger.info(f"=== Pipeline COMPLETE | Job: {job_id} | Time: {elapsed}s ===")

    # ── Write pipeline debug + execution trace ─────────────────────────────────
    try:
        _pipeline_dbg["elapsed_s"] = elapsed
        Path(".tmp").mkdir(exist_ok=True)
        dbg_path = Path(".tmp") / f"{job_id}_pipeline_debug.json"
        with open(dbg_path, "w", encoding="utf-8") as f:
            json.dump(_pipeline_dbg, f, ensure_ascii=False, indent=2, default=str)
        logger.info(f"Pipeline debug written → {dbg_path}")
    except Exception as e:
        logger.warning(f"Could not write pipeline debug: {e}")

    try:
        # One alert per job, listing every stage that failed.
        #
        # The ~75 non-fatal handlers above each keep the document processing
        # when one stage misbehaves, which is right -- but the failure then
        # goes nowhere. Three learning loops sat dead for months because
        # nothing ever said so. This makes them audible without changing what
        # any handler does.
        try:
            from execution.alerts import stages_failed
            _fails = trace.failures()
            if _fails:
                stages_failed(job_id, _fails, "", elapsed)
        except Exception as _alert_err:
            logger.warning(f"[alerts] failed to notify: {_alert_err}")

        trace_path = trace.save(".tmp", total_elapsed=elapsed)
        logger.info(f"Execution trace written → {trace_path}")
    except Exception as e:
        logger.warning(f"Could not write execution trace: {e}")

    return {"success": True, "job_id": job_id, "excel_url": None, "error": None}


# ── Train-only pipeline ────────────────────────────────────────────────────────
# Used by the manual-upload flow: runs ONLY Azure Layout + cropping. No OCR,
# no Gemini, no structuring, no Excel. Costs ~1 Azure Layout call per doc and
# produces name-level training crops with zero OCR spend.

def run_train_only_pipeline(job_id: str, document_url: str, user_id: str) -> dict:
    """
    Lightweight pipeline for the manual-upload training flow.

    Steps:
      1. status = processing
      2. Download document from Supabase storage
      3. Run Azure Layout (one call, multi-page PDFs supported)
      4. Save cell_polygons to document_jobs (no structured_data, no OCR text)
      5. Mark status = completed
      6. Crop name cells (existing crop_job_names) into training_dataset

    Failure modes:
      • Azure Layout returns no tables → status='failed' with a clear message
      • Download fails → status='failed'
      • Crop step fails non-fatally — job is still completed
    """
    from dotenv import load_dotenv
    load_dotenv()
    supabase = _get_supabase()

    logger.info(f"=== TrainOnly START | Job: {job_id} ===")
    start = time.time()

    # Stage 1: status=processing
    try:
        _update_job_status(supabase, job_id, "processing")
    except Exception as e:
        logger.warning(f"TrainOnly | Could not set processing: {e}")

    # Stage 2: download
    try:
        file_bytes, mime_type = _download_document(document_url)
        logger.info(f"TrainOnly | Downloaded {len(file_bytes):,} bytes | {mime_type}")
    except Exception as e:
        return _fail(supabase, job_id, f"Download failed: {e}")

    # Stage 3: Azure Layout
    try:
        from execution.extract_azure_layout import (
            extract_azure_layout, layout_to_participants, layout_to_cell_polygons,
        )
        layout = extract_azure_layout(file_bytes, source_label=job_id)
    except Exception as e:
        return _fail(supabase, job_id, f"Azure Layout error: {e}")

    if not layout.get("success"):
        return _fail(supabase, job_id, f"Azure Layout failed: {layout.get('error')}")

    tables = layout.get("tables") or []
    if not tables:
        return _fail(
            supabase, job_id,
            "No tables detected on any page. The document needs to contain a "
            "table with name cells for the cropper to work.",
        )

    # Stage 4: build structured_data + cell_polygons exactly like the full
    # pipeline would, so /admin/training and the cropper see a well-formed job.
    try:
        col_order, participants = layout_to_participants(layout)
        cell_polygons            = layout_to_cell_polygons(layout)
    except Exception as e:
        return _fail(supabase, job_id, f"Layout parse failed: {e}")

    update = {
        "structured_data": participants,
        "column_order":    col_order,
        "cell_polygons":   cell_polygons,
        "full_text":       "",       # train-only mode never extracts text
        "fields_json":     [],
    }
    try:
        supabase.table("document_jobs").update(update).eq("id", job_id).execute()
    except Exception as e:
        # Migration-not-yet-run guards: drop unknown columns and retry once.
        msg = str(e)
        retried = False
        for col in ("column_order", "cell_polygons"):
            if col in msg and col in update:
                logger.warning(f"TrainOnly | column {col!r} missing — saving without it")
                del update[col]
                retried = True
        if retried:
            try:
                supabase.table("document_jobs").update(update).eq("id", job_id).execute()
            except Exception as e2:
                return _fail(supabase, job_id, f"DB save failed: {e2}")
        else:
            return _fail(supabase, job_id, f"DB save failed: {e}")

    # Stage 5: complete
    try:
        _update_job_status(
            supabase, job_id, "completed",
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception as e:
        logger.warning(f"TrainOnly | Could not mark completed: {e}")

    # Stage 6: crop name cells (best-effort — job is already completed)
    try:
        from execution.crop_names import crop_job_names
        stats = crop_job_names(job_id, supabase=supabase)
        logger.info(f"TrainOnly | Crop stats: {stats}")
    except Exception as e:
        logger.warning(f"TrainOnly | Crop step failed (non-fatal): {e}")
        stats = {"created": 0, "errors": 1, "error": str(e)}

    elapsed = round(time.time() - start, 2)
    logger.info(f"=== TrainOnly DONE | {elapsed}s | crops={stats.get('created', 0)} ===")
    return {
        "success":    True,
        "job_id":     job_id,
        "elapsed_s":  elapsed,
        "rows":       len(participants),
        "tables":     len(tables),
        "crop_stats": stats,
    }


# ── Helpers ────────────────────────────────────────────────────────────────────

def _logical_validation(text: str) -> str:
    """
    Strategy 5 Step 2 — Logical validation pass.

    Scans each pipe-separated row for format violations:
      - Phone columns: must start with 059 or 056 and be 10 digits
      - Name columns (first 3 cells): must be Arabic-only text
      - Date columns: must match dd/mm/yyyy or yyyy-mm-dd pattern

    Rows with violations are prefixed with ⚠ so Gemini structuring knows to
    treat them with extra care. Non-table lines are passed through unchanged.
    """
    import re as _re

    _PHONE_RE  = _re.compile(r"^(059|056)\d{7}$")
    _DATE_RE   = _re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$|^\d{4}-\d{2}-\d{2}$")
    _ARABIC_RE = _re.compile(r"^[\u0600-\u06FF\s\u200c\u200d،.]+$")
    _DIGITS_RE = _re.compile(r"\D")

    issues_total = 0
    output_lines: list[str] = []

    for line in text.splitlines():
        if "|" not in line:
            output_lines.append(line)
            continue

        cols = [c.strip() for c in line.split("|")]
        issues: list[str] = []

        for i, col in enumerate(cols):
            if not col or col == "[?]":
                continue
            col_clean = col.replace("[?]", "").strip()

            # Phone column heuristic: 10-digit value
            digits = _DIGITS_RE.sub("", col_clean)
            if len(digits) == 10 and digits[0] in "05":
                if not _PHONE_RE.match(digits):
                    issues.append(f"col{i+1}:phone_fmt({col_clean!r})")

            # Date column heuristic: contains /
            elif "/" in col_clean or (_re.search(r"\d{4}-\d{2}", col_clean)):
                if not _DATE_RE.match(col_clean):
                    issues.append(f"col{i+1}:date_fmt({col_clean!r})")

            # Name columns (first 3): Arabic only, no digits
            elif i < 3 and col_clean and not _ARABIC_RE.match(col_clean):
                issues.append(f"col{i+1}:non_arabic({col_clean!r})")

        if issues:
            issues_total += len(issues)
            line = "[!] " + line + "  # validation:" + ",".join(issues)

        output_lines.append(line)

    if issues_total:
        logger.info(f"Stage 3.8/6 | Logical validation: {issues_total} issue(s) flagged")
    else:
        logger.info("Stage 3.8/6 | Logical validation: no issues found")

    return "\n".join(output_lines)


def _apply_ocr_corrections(full_text: str, supabase) -> str:
    """
    Layer 1 correction: fetch ocr_corrections table and apply find-and-replace
    on raw Vision text before sending to Gemini.

    Also applies deterministic character-level normalization:
    - Urdu/Persian characters → Arabic equivalents (Vision confuses them on handwritten forms)
    - Extended Arabic-Indic digits (U+06F0–06F9) → Western digits

    Safety rules (each rule is validated independently):
    - Skip rule if original pattern is empty or corrected text is empty string
    - Skip rule if applying it would reduce total text length by more than 30%
      (guards against rules that accidentally delete large chunks of valid content)
    - Always fall back to unchanged text on any exception
    """
    # ── Step 0: Deterministic character normalization ──────────────────────────
    # Vision frequently confuses Urdu/Persian variants with their Arabic equivalents
    # when processing handwritten Arabic text. These are character-for-character
    # substitutions that are always safe.
    _CHAR_NORMALIZE = str.maketrans(
        # Urdu/Persian → Arabic
        "یکہے"            # U+06CC U+06A9 U+06C1 U+06D2
        "۰۱۲۳۴۵۶۷۸۹",    # Extended Arabic-Indic digits (Perso-Arabic)
        "يكهي"            # Arabic yeh, kaf, heh, yeh
        "0123456789",
    )
    full_text = full_text.translate(_CHAR_NORMALIZE)
    logger.debug("Stage 3.5/6 | Character normalization applied (Urdu/Persian → Arabic)")

    try:
        # Apply every confirmed correction (frequency >= 1) so first-time edits
        # take effect immediately. Per-rule safety guards below (length-shrink,
        # phone-skip, exception isolation) make single-shot corrections safe.
        corrections = (
            supabase.table("ocr_corrections")
            .select("original_text,corrected_text")
            .gte("frequency", 1)
            .execute()
            .data
        )
    except Exception:
        return full_text

    original_length = len(full_text)

    import re as _ocr_re
    _PHONE_LIKE = _ocr_re.compile(r'^\d{7,}$|^0[5-9]\d+$|^[5-9]\d{7,}$')

    for c in corrections:
        orig = c.get("original_text", "")
        corr = c.get("corrected_text", "")

        # Skip rules that have blank fields
        if not orig or corr is None:
            continue

        # Never auto-correct phone-like patterns — phone numbers must not be altered
        # by the text-replacement pass (issue 6: phone corrections disabled)
        orig_digits = _ocr_re.sub(r'\D', '', orig)
        if len(orig_digits) >= 7 and len(orig_digits) / max(len(orig), 1) >= 0.6:
            logger.debug(f"Stage 3.5/6 | Skipping phone-like correction: '{orig}' → '{corr}'")
            continue

        # Only apply if the pattern actually appears
        if orig not in full_text:
            continue

        candidate = full_text.replace(orig, corr)

        # Safety check: reject if the correction removes more than 30% of total text
        if original_length > 0 and len(candidate) < original_length * 0.7:
            logger.warning(
                f"Stage 3.5/6 | OCR correction skipped (would remove >30% of text): "
                f"'{orig[:40]}' → '{corr[:40]}'"
            )
            continue

        full_text = candidate

    return full_text


def _rescue_weak_names_from_gemini_ocr(
    structured_data: list,
    gemini_raw_names: dict,
    column_order: list,
) -> tuple[list, int]:
    """
    Stage 4.4: Row-level name rescue from Gemini OCR text.

    Azure Layout sometimes wins the column structure but loses name fidelity at
    the cell level (a name's bbox spills into the wrong cell, or only the visible
    half lands inside the cell polygon). Gemini OCR reads the row as flowing text
    and often captures the full 4-token name. When that's the case, prefer it.

    Conservative replacement rule — all must hold:
      • Gemini's row name has STRICTLY MORE Arabic-dominant tokens than the
        current cell, AND ≥ 3 tokens (avoids overwriting with junk)
      • Gemini's first token is in the male/female names dictionary
        (proves it actually starts with a real Arabic given name)
      • Row alignment looks safe (Gemini row count ≥ 70% of structured row count)
    """
    import re as _rr
    if not structured_data or not gemini_raw_names:
        return structured_data, 0

    if len(gemini_raw_names) < len(structured_data) * 0.7:
        # Row alignment is too off — abort to prevent drift
        return structured_data, 0

    _NAME_COL_PAT = _rr.compile(r"اسم|name|المشارك|المستفيد|الموظف|الطالب", _rr.I)
    _GUARDIAN_PAT = _rr.compile(r"ول[يى]|توقيع|guardian|signature", _rr.I)
    name_col = next(
        (c for c in column_order
         if _NAME_COL_PAT.search(c) and not _GUARDIAN_PAT.search(c)),
        None,
    )
    if not name_col:
        return structured_data, 0

    try:
        from execution.extract_gemini import (
            _load_male_names_dict, _load_female_names_dict,
            _load_family_names_dict, _norm_for_match,
        )
        male_set, _   = _load_male_names_dict()
        female_set, _ = _load_female_names_dict()
        family_set, _ = _load_family_names_dict()
        # Merge in user-learned names (written by grow_name_dict.py promote)
        learned_set = set()
        try:
            import json as _json
            from pathlib import Path as _P
            _learned_path = _P(__file__).parent / "data" / "arabic_names_learned.json"
            if _learned_path.exists():
                learned_set = {
                    _norm_for_match(n) for n in _json.load(open(_learned_path, encoding="utf-8"))
                }
        except Exception:
            pass
        given_dict  = male_set | female_set | learned_set
    except Exception as _ne:
        logger.warning(f"Stage 4.4/6 | Could not load name dict ({_ne}); rescue disabled")
        return structured_data, 0

    def _ar_tokens(s: str) -> list[str]:
        return [
            t for t in (s or "").split()
            if sum(1 for c in t if "؀" <= c <= "ۿ") >= 2
        ]

    rescued = 0
    for i, row in enumerate(structured_data):
        current = (row.get(name_col) or "").strip()
        candidate = (gemini_raw_names.get(i) or "").strip()
        if not candidate:
            continue

        cur_tokens = _ar_tokens(current)
        cand_tokens = _ar_tokens(candidate)

        # Need strictly more tokens AND at least 3 to be a serious candidate
        if len(cand_tokens) <= len(cur_tokens) or len(cand_tokens) < 3:
            continue

        # First token of candidate must be a known Arabic given name
        first_norm = _norm_for_match(cand_tokens[0])
        if first_norm not in given_dict:
            continue

        # Last token (family name) must be either in the family-names dict OR
        # have ≥ 4 Arabic chars (long enough to be a real family name, not noise).
        # This blocks rescues where Gemini hallucinates a plausible-sounding but
        # wrong family name onto a row (the row-5 failure pattern).
        last_norm = _norm_for_match(cand_tokens[-1])
        last_ar_len = sum(1 for c in cand_tokens[-1] if "؀" <= c <= "ۿ")
        if last_norm not in family_set and last_ar_len < 4:
            continue

        logger.info(
            f"Stage 4.4 | Row {i+1} name rescue: "
            f"'{current}' ({len(cur_tokens)}t) → '{candidate}' ({len(cand_tokens)}t)"
        )
        row[name_col] = candidate
        rescued += 1

    return structured_data, rescued


def _apply_per_cell_corrections(structured_data: list, supabase) -> list:
    """
    Stage 4.5: Per-cell DB correction lookup.

    After Gemini structuring, check each cell value against confirmed entries
    in ocr_corrections (frequency >= 2) AND field_corrections (any freq).
    Matching is normalised: diacritics stripped, hamza variants unified, spaces
    stripped — so 'رياض احمد' matches DB key 'رياض أحمد'.

    Rules:
    - Phone fields are NEVER modified
    - Null/empty cells are skipped
    - A correction is applied only when the full cell value normalises to original_text
    """
    import re as _pcc_re

    _PHONE_PAT = _pcc_re.compile(r'هاتف|تليفون|جوال|موبايل|phone|mobile|tel|رقم', _pcc_re.I)
    # Fixed-choice columns are settled by Stage 4 and must not be re-opened here.
    #
    # Stage 4 normalises الجنس to أنثى, and this stage then matched the learned
    # rule 'آنثى' -> 'انثى' (both normalise to the same key) and wrote the
    # un-hamza'd form straight back over it. The table also holds 'نعم' -> 'قم'
    # AND 'قم' -> 'نعم', the same pair recorded in both directions, so a correct
    # نعم was being turned into قم -- which is how قم reached the disability
    # column of a finished sheet.
    #
    # Learning from a person's edits is right for names, where the vocabulary is
    # open and unknowable in advance. A column with two allowed answers has
    # nothing to learn: it is already decided, deterministically, upstream.
    _FIXED_CHOICE_PAT = _pcc_re.compile(r'جنس|نوع.{0,8}[اأإآ]جتماع|gender|sex|'
                                        r'[اأإآ]عاق|disab|موافق|قبول|وافق|توافق', _pcc_re.I)

    def _norm_key(s: str) -> str:
        """Normalise for lookup: strip diacritics, unify hamza/alef, strip spaces."""
        s = _pcc_re.sub(r'[\u064B-\u065F\u0670]', '', s)   # harakat
        s = _pcc_re.sub(r'[أإآٱ]', 'ا', s)                  # alef variants
        s = _pcc_re.sub(r'[يىئ]', 'ي', s)                   # yeh variants
        s = s.replace('ة', 'ه')                              # teh marbuta
        return s.strip()

    # ── Fetch from both correction tables ──────────────────────────────────────
    # ocr_corrections (freq >= 2): confirmed text-level rules, apply to ANY column.
    # field_corrections: user cell edits, scoped to the exact field_name where
    # they were recorded — never cross-applied to other columns. This is the
    # critical fix: a user edit of "4 -> نعم" in an agreement column must not
    # turn the row-number "4" into "نعم".
    global_lookup: dict = {}               # norm_key -> corrected (from ocr_corrections)
    per_column_lookup: dict[str, dict] = {}  # field_name -> {norm_key: corrected}
    column_defaults: dict = {}             # field_name -> default for empty cells

    try:
        # Apply EVERY confirmed correction immediately (frequency >= 1).
        # Previously required >= 2 occurrences which made first-time corrections
        # invisible — users perceived "the dataset isn't learning". Each correction
        # is already validated upstream (Arabic-only, length, phone-skipping) and
        # is column-overridable via field_corrections, so single-shot corrections
        # are safe to apply.
        for c in (
            supabase.table("ocr_corrections")
            .select("original_text,corrected_text,frequency")
            .gte("frequency", 1)
            .execute()
            .data
        ):
            orig = (c.get("original_text") or "").strip()
            corr = c.get("corrected_text")
            if orig and corr is not None:
                global_lookup[_norm_key(orig)] = corr
    except Exception as e:
        logger.warning(f"Stage 4.5/6 | Could not fetch ocr_corrections (non-fatal): {e}")

    try:
        for r in (
            supabase.table("field_corrections")
            .select("field_name,original_value,corrected_value")
            .execute()
            .data
        ):
            field = (r.get("field_name") or "").strip()
            orig  = (r.get("original_value") or "").strip()
            corr  = r.get("corrected_value")
            if not corr or not field:
                continue
            if orig:
                # Column-scoped correction: only applies to cells in `field`
                per_column_lookup.setdefault(field, {})[_norm_key(orig)] = corr
            else:
                # Auto-fill: empty cell in `field` gets this default (last writer wins)
                column_defaults[field] = corr
    except Exception as e:
        logger.warning(f"Stage 4.5/6 | Could not fetch field_corrections (non-fatal): {e}")

    if not global_lookup and not per_column_lookup and not column_defaults:
        logger.info("Stage 4.5/6 | No confirmed corrections in DB yet")
        return structured_data

    def _lookup_for_column(field: str) -> dict:
        """Merged view: per-column overrides global for this field."""
        if field in per_column_lookup:
            return {**global_lookup, **per_column_lookup[field]}
        return global_lookup

    corrected_count = 0
    result = []
    for row in structured_data:
        new_row = dict(row)
        for key, val in row.items():
            if not val or not isinstance(val, str) or not val.strip():
                # Empty cell — apply column default if one exists
                if key in column_defaults:
                    new_row[key] = column_defaults[key]
                    corrected_count += 1
                continue
            if _PHONE_PAT.search(key):
                continue   # never touch phone fields
            if _FIXED_CHOICE_PAT.search(key):
                continue   # settled upstream; a learned rule must not reopen it

            # Column-scoped lookup: field_corrections for this column + global ocr_corrections
            norm_lookup = _lookup_for_column(key)
            if not norm_lookup:
                continue

            # ── Pass 1: full-cell match ──────────────────────────────────────
            norm_val = _norm_key(val)
            if norm_val in norm_lookup and norm_lookup[norm_val] != val:
                new_val = norm_lookup[norm_val]
                logger.info(f"Stage 4.5 | [{key}] full-cell '{val}' → '{new_val}'")
                new_row[key] = new_val
                corrected_count += 1
                continue   # already corrected at cell level — skip token pass

            # ── Pass 2: token-level match ────────────────────────────────────
            # Split cell into tokens and replace each one independently.
            # Safety gate: only apply if the stored correction is OCR-plausible
            # (edit distance ≤ 40% of the longer token). This prevents a wrongly
            # stored correction like "محمود → سمير" from corrupting other names.
            tokens = val.split()
            new_tokens = []
            token_changed = False
            for tok in tokens:
                norm_tok = _norm_key(tok)
                if norm_tok in norm_lookup:
                    candidate = norm_lookup[norm_tok]
                    if candidate != tok:
                        # Compute edit distance ratio between original and corrected
                        a, b = norm_tok, _norm_key(candidate)
                        max_len = max(len(a), len(b))
                        if max_len > 0:
                            # Simple Levenshtein via SequenceMatcher ratio
                            import difflib as _dl
                            ratio = _dl.SequenceMatcher(None, a, b).ratio()
                            # ratio = 1 - (edit_dist / max_len) approx;
                            # only apply if ≥ 60% similarity (≤ 40% changed)
                            if ratio >= 0.60:
                                new_tokens.append(candidate)
                                token_changed = True
                                continue
                            else:
                                logger.debug(
                                    f"Stage 4.5 | [{key}] token '{tok}' correction "
                                    f"'{candidate}' rejected (similarity={ratio:.2f} < 0.60)"
                                )
                new_tokens.append(tok)
            if token_changed:
                new_val = " ".join(new_tokens)
                logger.info(f"Stage 4.5 | [{key}] token-level '{val}' → '{new_val}'")
                new_row[key] = new_val
                corrected_count += 1

        result.append(new_row)

    if corrected_count:
        logger.info(f"Stage 4.5 | {corrected_count} correction(s) applied")
    else:
        logger.info("Stage 4.5 | No per-cell corrections matched")

    return result


def _download_document(url: str) -> tuple:
    """
    Download document bytes from URL.
    Returns (bytes, mime_type).
    """
    import httpx
    response = httpx.get(url, timeout=60, follow_redirects=True)
    response.raise_for_status()
    mime_type = response.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    return response.content, mime_type


def _parse_fields(full_text: str) -> list:
    """
    Two-strategy field parser for Arabic documents.

    Strategy 1 — Colon-based: splits "field_name: value" lines and normalizes
    field names to canonical Arabic types.

    Strategy 2 — Pattern-based: extracts phone numbers, dates, gender tokens,
    and age values using regex. Covers table/form documents where data isn't
    colon-delimited.

    Both strategies run on every document. Results are deduplicated.
    The raw full_text is always preserved as النص الكامل for reference.
    """
    import re

    # ── Field name normalization map ──────────────────────────────────────────
    _NORM = {
        # Name
        'الاسم': 'الاسم', 'الاسم الكامل': 'الاسم', 'الاسم الرباعي': 'الاسم',
        'الاسم الرباعي المشارك': 'الاسم', 'اسم المشارك': 'الاسم', 'اسم': 'الاسم',
        'name': 'الاسم', 'full name': 'الاسم',
        # Date of birth
        'تاريخ الميلاد': 'تاريخ الميلاد', 'تاريخ الولادة': 'تاريخ الميلاد',
        'date of birth': 'تاريخ الميلاد', 'dob': 'تاريخ الميلاد',
        # Age
        'العمر': 'العمر', 'السن': 'العمر', 'الفئة العمرية': 'العمر',
        'age': 'العمر', 'age group': 'العمر',
        # Gender
        'الجنس': 'الجنس', 'gender': 'الجنس', 'sex': 'الجنس',
        # ID
        'رقم الهوية': 'رقم الهوية', 'رقم الوطني': 'رقم الهوية',
        'رقم البطاقة': 'رقم الهوية', 'رقم الجواز': 'رقم الهوية',
        'رقم الوثيقة': 'رقم الهوية', 'id': 'رقم الهوية', 'id number': 'رقم الهوية',
        # Phone
        'رقم الهاتف': 'رقم الهاتف', 'رقم التواصل': 'رقم الهاتف',
        'الهاتف': 'رقم الهاتف', 'الجوال': 'رقم الهاتف',
        'phone': 'رقم الهاتف', 'mobile': 'رقم الهاتف',
        # Nationality
        'الجنسية': 'الجنسية', 'nationality': 'الجنسية',
        # Address / Governorate
        'العنوان': 'العنوان', 'address': 'العنوان',
        'المحافظة': 'المحافظة', 'governorate': 'المحافظة',
        # Job
        'المهنة': 'المهنة', 'الوظيفة': 'المهنة', 'job': 'المهنة',
        # Consent
        'الموافقة': 'الموافقة', 'consent': 'الموافقة',
    }

    def _normalize(raw: str) -> str:
        key = raw.strip().lower()
        if key in _NORM:
            return _NORM[key]
        for k, v in _NORM.items():
            if k in key:
                return v
        return raw.strip()

    if not full_text or not full_text.strip():
        return []

    lines = [line.strip() for line in full_text.splitlines() if line.strip()]
    fields = []
    seen: set = set()

    def add(field_name: str, value: str):
        v = value.strip()
        if v and (field_name, v) not in seen:
            seen.add((field_name, v))
            fields.append({"field_name": field_name, "value": v})

    # ── Strategy 1: Colon-based with normalization ────────────────────────────
    arabic_letter = re.compile(r'[\u0600-\u06FF]')
    for line in lines:
        if ":" in line:
            parts = line.split(":", 1)
            raw_name = parts[0].strip()
            value = parts[1].strip()
            # Only accept field names that contain Arabic letters or known Latin keywords
            if raw_name and value and arabic_letter.search(raw_name):
                add(_normalize(raw_name), value)

    # ── Strategy 2: Pattern-based extraction ─────────────────────────────────
    full = full_text

    # Phone numbers: Palestinian/Arabic mobile (05xx, 06xx, 059x) or international
    for match in re.finditer(r'\b0[5-9]\d{8}\b', full):
        add('رقم الهاتف', match.group())

    # Dates in Arabic-Indic numerals: e.g. ٢٠١٣/١/١٧
    arabic_indic = '[\u0660-\u0669]'
    for match in re.finditer(
        rf'{arabic_indic}{{4}}[/\-]{arabic_indic}{{1,2}}[/\-]{arabic_indic}{{1,2}}', full
    ):
        add('تاريخ الميلاد', match.group())

    # Dates in Latin numerals: e.g. 2013/1/17 or 2024-09-24
    for match in re.finditer(r'\b20\d{2}[/\-]\d{1,2}[/\-]\d{1,2}\b', full):
        add('تاريخ الميلاد', match.group())

    # Gender tokens — collect all unique occurrences
    if 'ذكر' in full:
        add('الجنس', 'ذكر')
    if 'أنثى' in full or 'انثى' in full:
        add('الجنس', 'أنثى')

    # Age: standalone 1-2 digit numbers that follow a known age pattern
    for match in re.finditer(r'\b(1[0-9]|[2-9][0-9])\b', full):
        # Only pick up if near an age-related keyword
        start = max(0, match.start() - 50)
        ctx = full[start:match.end()]
        if any(kw in ctx for kw in ['العمر', 'السن', 'الفئة', 'عمره', 'عمرها']):
            add('العمر', match.group())

    # ── Always preserve raw text ──────────────────────────────────────────────
    add('النص الكامل', full_text.strip())

    return fields


def _update_job_status(supabase, job_id: str, status: str, **kwargs) -> None:
    """Update document_jobs status and any additional fields."""
    update_data = {"status": status, **kwargs}
    supabase.table("document_jobs").update(update_data).eq("id", job_id).execute()
    logger.info(f"Status updated | Job: {job_id} | Status: {status}")


def _save_page_debug(supabase, job_id: str, page_number: int, raw_response: dict, full_text: str) -> None:
    """Upsert a document_pages row with raw Vision response for debugging."""
    supabase.table("document_pages").upsert({
        "job_id": job_id,
        "page_number": page_number,
        "raw_vision_response": raw_response,
        "full_text": full_text,
    }, on_conflict="job_id,page_number").execute()


def _get_document_name(supabase, job_id: str) -> str:
    """Fetch document_name from document_jobs."""
    result = supabase.table("document_jobs").select("document_name").eq("id", job_id).single().execute()
    return result.data.get("document_name", "document") if result.data else "document"


def _enforce_column_order(structured_data: list, spatial_text: str) -> list:
    """
    Gemini reorders JSON keys despite prompt instructions.
    This function reorders participant dict keys to match the physical
    right-to-left column layout detected from the spatial OCR text.

    Strategy:
      1. Collect all column names from the data
      2. Scan the first 10 lines of spatial_text for the header row
         (the line containing the most column names)
      3. Sort columns by their position in that header line
      4. Reorder every participant dict to use that order
    """
    if not structured_data or not spatial_text:
        return structured_data

    all_cols = list(dict.fromkeys(k for p in structured_data for k in p.keys()))
    if len(all_cols) <= 1:
        return structured_data

    def find_pos(col: str, line: str) -> int:
        """Position of col in line, using padded search to avoid substring false-matches."""
        padded = " " + line + " "
        pos = padded.find(" " + col + " ")
        return pos if pos >= 0 else -1

    lines = spatial_text.strip().split("\n")[:10]
    best_line, best_count = "", 0
    for line in lines:
        count = sum(1 for c in all_cols if find_pos(c, line) >= 0)
        if count > best_count:
            best_count, best_line = count, line

    if best_count < 2:
        return structured_data  # not enough headers found — leave as-is

    found = sorted(
        [(c, find_pos(c, best_line)) for c in all_cols if find_pos(c, best_line) >= 0],
        key=lambda x: x[1],
    )
    ordered = [c for c, _ in found]
    remaining = [c for c in all_cols if c not in ordered]
    final_order = ordered + remaining

    if final_order == all_cols:
        return structured_data  # already correct

    logger.info(f"Column order corrected: {all_cols} → {final_order}")
    return [{k: p.get(k) for k in final_order} for p in structured_data]


def _fail(supabase, job_id: str, error_message: str) -> dict:
    """Mark job as failed, log the error, return failure dict."""
    logger.error(f"Pipeline FAILED | Job: {job_id} | Error: {error_message}")
    try:
        _update_job_status(supabase, job_id, "failed", error_message=error_message)
    except Exception as e:
        logger.error(f"Could not update failure status: {e}")
    return {"success": False, "job_id": job_id, "excel_url": None, "error": error_message}


# ── CLI Entry Point ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Run Arabic OCR pipeline for a document job")
    parser.add_argument("--job_id", required=True, help="document_jobs UUID")
    parser.add_argument("--document_url", required=True, help="Supabase Storage URL for the document")
    parser.add_argument("--user_id", required=True, help="Supabase auth user UUID")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode (write raw Vision output to .tmp/)")
    args = parser.parse_args()

    result = run_pipeline(
        job_id=args.job_id,
        document_url=args.document_url,
        user_id=args.user_id,
        debug=args.debug,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if not result["success"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
