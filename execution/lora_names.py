"""
execution/lora_names.py — read a job's name cells with the fine-tuned model.

Stage 3.6 of the pipeline. Azure Layout (stage 3.35) already produces
cell_polygons; this crops the person-name cells out of the rendered pages and
sends them to the Modal GPU service, which reads them far better than Azure:

    Azure          26.0% full name                (what customers get today)
    LoRA A+B       63.3% full name, 87.3% per name   (frozen held-out set)

The names are written back into document_jobs.structured_data, which is what
ParticipantTable renders in /documents/[id]. Nothing else in the pipeline
changes, and nothing about the trainer queue is touched.

Off unless LORA_NAMES_ENABLED=1. Any failure is non-fatal: the job keeps
Azure's names rather than losing the document.

Programmatic:
    from execution.lora_names import read_job_names
    read_job_names(job_id, supabase=sb)
"""
from __future__ import annotations

import io
import logging
import os

from execution.crop_names import (
    _DPI,
    _detect_polygon_unit,
    _exact_polygon_scale,
    _looks_like_name_text,
    _orient_to_polygons,
    _page_size_inches,
    _polygon_to_bbox_pixels,
    _render_pages,
    _rotate_with_box,
    _upright_quarter_turn,
    detect_name_fields,
)

logging.basicConfig(
    level=logging.INFO,
    format="[LoraNames] %(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

MODAL_APP   = "arabic-lora-names"
MODAL_CLASS = "NameReader"

# Reading is ~2.9 s per crop per adapter, so a wide document is minutes of GPU.
# Cap it so one pathological job cannot hold the pipeline open indefinitely.
MAX_CELLS = int(os.getenv("LORA_NAMES_MAX_CELLS", "400"))


def enabled() -> bool:
    return os.getenv("LORA_NAMES_ENABLED", "0") == "1"


def _crop_name_cells(job: dict, cell_polygons: list, structured: list,
                     name_fields: set) -> list:
    """
    Crop every person-name cell into PNG bytes, in memory.

    Mirrors crop_names' geometry exactly — same DPI, same unit detection, same
    per-page orient, same quarter-turn correction — because the adapters were
    trained on crops made that way. A different crop is a different input
    distribution, and the model would quietly do worse.
    """
    from PIL import Image  # noqa: F401

    doc_bytes, content_type = job["_bytes"], job["_content_type"]
    pages = _render_pages(doc_bytes, content_type)
    if not pages:
        return []

    polys_by_page: dict = {}
    for cp in cell_polygons:
        polys_by_page.setdefault(cp.get("page", 1), []).append(cp.get("polygon") or [])

    page_angle_by_page: dict = {}
    for cp in cell_polygons:
        pg = cp.get("page", 1)
        if pg not in page_angle_by_page and cp.get("page_angle") is not None:
            try:
                page_angle_by_page[pg] = float(cp["page_angle"])
            except (TypeError, ValueError):
                pass

    # Azure's own page size, when the polygons carry it — the exact scale.
    page_size_by_page: dict = {}
    for cp in cell_polygons:
        pg = cp.get("page", 1)
        if pg not in page_size_by_page and cp.get("page_width"):
            page_size_by_page[pg] = (float(cp.get("page_width") or 0.0),
                                     float(cp.get("page_height") or 0.0))

    unit_scale_by_page: dict = {}
    for pn, img in list(pages.items()):
        polys = polys_by_page.get(pn, [])
        pw, ph = page_size_by_page.get(pn, (0.0, 0.0))
        unit_scale = _exact_polygon_scale(img, pw, ph, _DPI)
        if unit_scale is None:
            unit_scale = _detect_polygon_unit(img, polys, _DPI)
        unit_scale_by_page[pn] = unit_scale
        oriented = _orient_to_polygons(img, polys, _DPI, unit_scale=unit_scale)
        if oriented is not img:
            pages[pn] = oriented

    out = []
    for cp in cell_polygons:
        field_name = cp.get("field_name", "")
        if field_name not in name_fields:
            continue
        polygon = cp.get("polygon") or []
        if not polygon or len(polygon) < 8:
            continue
        page_no  = cp.get("page", 1)
        page_img = pages.get(page_no)
        if page_img is None:
            continue

        idx = cp.get("participant_index")
        cp_text = cp.get("text")
        if cp_text is not None:
            azure_value = str(cp_text).strip()
        else:
            azure_value = ""
            if isinstance(idx, int) and 0 <= idx < len(structured):
                azure_value = str((structured[idx] or {}).get(field_name) or "").strip()

        # Same sparse-cell gate as the trainer: blank rows and single-character
        # specks are not names, and reading them wastes GPU on noise.
        if not _looks_like_name_text(azure_value):
            continue

        try:
            page_w_in, page_h_in = _page_size_inches(page_img, _DPI)
            box = _polygon_to_bbox_pixels(
                polygon, _DPI, page_w_in, page_h_in,
                unit_scale=unit_scale_by_page.get(page_no, 1.0))
            if box is None:
                continue
            crop = page_img.crop(box)
            if crop.width < 10 or crop.height < 10:
                continue

            ccw = _upright_quarter_turn(page_angle_by_page.get(page_no, 0.0))
            if ccw in (90, 180, 270):
                crop = crop.rotate(ccw, expand=True)

            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            out.append({"participant_index": idx, "field_name": field_name,
                        "azure": azure_value, "png": buf.getvalue()})
        except Exception as e:                       # one bad cell, not one bad job
            logger.debug(f"crop failed for ({idx}, {field_name}): {e}")

    return out


def read_job_names(job_id: str, supabase=None, dry_run: bool = False) -> dict:
    """
    Replace Azure's name readings on one job with the model's.

    dry_run reads and compares but writes nothing, so a real customer job can be
    inspected safely before the flag is ever turned on. It also returns the
    per-cell pairs so Azure and the model can be read side by side.

    Returns a stats dict. Never raises: on any failure the job simply keeps the
    names Azure produced, which is what it would have had anyway.
    """
    stats = {"cells": 0, "read": 0, "changed": 0, "agreed": 0,
             "skipped_mismatch": 0, "error": None, "pairs": []}
    if not (enabled() or dry_run):
        stats["error"] = "disabled"
        return stats

    try:
        import modal

        if supabase is None:
            from execution.process_document import _get_supabase
            supabase = _get_supabase()

        job = (supabase.table("document_jobs")
               .select("id, document_url, structured_data, cell_polygons")
               .eq("id", job_id).single().execute().data)
        if not job:
            stats["error"] = "job_not_found"
            return stats

        cell_polygons = job.get("cell_polygons") or []
        structured    = job.get("structured_data") or []
        if not cell_polygons:
            stats["error"] = "no_cell_polygons"
            return stats

        name_fields, _, _ = detect_name_fields(cell_polygons, structured, job_id)
        if not name_fields:
            stats["error"] = "no_name_columns"
            return stats

        blob = supabase.storage.from_("documents").download(job["document_url"])
        job["_bytes"] = blob
        job["_content_type"] = ("application/pdf"
                                if str(job["document_url"]).lower().endswith(".pdf")
                                else "image/png")

        cells = _crop_name_cells(job, cell_polygons, structured, name_fields)
        stats["cells"] = len(cells)
        if not cells:
            stats["error"] = "no_name_cells"
            return stats
        if len(cells) > MAX_CELLS:
            logger.warning(f"Job {job_id}: {len(cells)} name cells, capping at {MAX_CELLS}")
            cells = cells[:MAX_CELLS]

        reader = modal.Cls.from_name(MODAL_APP, MODAL_CLASS)()
        results = reader.read.remote([c["png"] for c in cells])
        stats["read"]   = len(results)
        stats["agreed"] = sum(1 for r in results if r.get("agree"))

        # Write the readings back into structured_data. cell_polygons keeps
        # Azure's text untouched -- the trainer queue crops from it, and
        # relabelling those cells with model output would feed the model its
        # own guesses as ground truth.
        rows = list(structured)
        for cell, res in zip(cells, results):
            name = (res or {}).get("name", "").strip()
            idx  = cell["participant_index"]
            stats["pairs"].append({
                "row": idx, "azure": cell["azure"], "lora": name,
                "a": (res or {}).get("a", ""), "b": (res or {}).get("b", ""),
                "agree": bool((res or {}).get("agree")),
            })
            if not name or not isinstance(idx, int) or not (0 <= idx < len(rows)):
                continue

            # Refuse to write when the mapping cannot be trusted.
            #
            # The crop carries the Azure text of the cell it was cut from. If
            # the row we are about to overwrite does not hold that same text,
            # then this crop and this row are not the same cell, and writing
            # would put one person's name against another's ID.
            #
            # This is not hypothetical: a crop-geometry bug once shifted every
            # box most of a row down, so each crop showed the NEXT person. The
            # names came back cleaner than Azure's and landed on the wrong
            # rows -- data that looks right and is wrong. Nothing in the
            # pipeline objected. This check would have stopped it on the first
            # document.
            current = str((rows[idx] or {}).get(cell["field_name"]) or "").strip()
            if current and cell["azure"] and current != cell["azure"]:
                stats["skipped_mismatch"] += 1
                logger.warning(
                    f"Job {job_id}: row {idx} holds {current!r} but the crop came "
                    f"from {cell['azure']!r} — refusing to write {name!r}")
                continue

            if current != name:
                stats["changed"] += 1
            rows[idx] = {**(rows[idx] or {}), cell["field_name"]: name}

        if dry_run:
            logger.info(f"Job {job_id}: dry run — nothing written")
        else:
            supabase.table("document_jobs").update(
                {"structured_data": rows}).eq("id", job_id).execute()

        logger.info(
            f"Job {job_id}: read {stats['read']} name cells, "
            f"{stats['changed']} changed, {stats['agreed']}/{stats['read']} adapters agreed")
        return stats

    except Exception as e:
        # Non-fatal by design: a GPU hiccup must not cost the customer their
        # document. They keep Azure's names, exactly as before this stage existed.
        logger.warning(f"Job {job_id}: LoRA name reading failed (non-fatal): {e}")
        stats["error"] = str(e)
        return stats


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        sys.exit("usage: python execution/lora_names.py <job_id>")
    os.environ.setdefault("LORA_NAMES_ENABLED", "1")
    print(read_job_names(sys.argv[1]))
