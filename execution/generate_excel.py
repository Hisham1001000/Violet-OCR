"""
Tool: generate_excel
Creates an RTL Arabic Excel workbook from extracted OCR fields and uploads
it to Supabase Storage, returning a signed download URL.

Sheet 1 "النص المستخرج" (Extracted Data):
    Columns: field_name | value

Sheet 2 "معلومات المستند" (Document Info):
    document_name, job_id, generated_at, full Vision text

Usage (CLI):
    python execution/generate_excel.py \\
      --job_id "abc-123" \\
      --fields '[{"field_name":"الاسم","value":"أحمد"}]' \\
      --document_name "scan.pdf" \\
      --full_text "الاسم: أحمد"

Returns (dict):
    {
        "success": bool,
        "file_path": str,       -- local .tmp/{job_id}.xlsx path
        "excel_url": str | None,  -- Supabase signed URL (1 hour)
        "error": str | None
    }
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path


# ── Column ordering helpers (mirrors ParticipantTable.tsx logic) ───────────────

_PRIORITY_PATTERNS = [
    re.compile(r'اسم'),
    re.compile(r'هاتف|تواصل|جوال|موبايل'),
    re.compile(r'تاريخ.*ميلاد|ميلاد|تاريخ.*ولاد|ولادة'),
]

def _apply_priority(cols: list) -> list:
    """Pin Name → DOB → Phone to the front, exactly as the website does."""
    pinned = []
    for pattern in _PRIORITY_PATTERNS:
        match = next((c for c in cols if pattern.search(c) and c not in pinned), None)
        if match:
            pinned.append(match)
    rest = [c for c in cols if c not in pinned]
    return pinned + rest

logging.basicConfig(
    level=logging.INFO,
    format="[Excel] %(asctime)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ── Workbook Generation ────────────────────────────────────────────────────────

def generate(
    job_id: str,
    full_text: str,
    fields: list,
    document_name: str,
    structured_data: list = None,
    column_order: list = None,
    output_dir: str = ".tmp",
) -> dict:
    """
    Build RTL Arabic Excel workbook and upload to Supabase Storage.

    Args:
        job_id: Supabase document_jobs UUID (used for filename)
        full_text: Complete raw text from Vision (written to Sheet 2)
        fields: List of {field_name: str, value: str} dicts (fallback flat format)
        document_name: Original uploaded file name
        structured_data: List of participant dicts from Gemini (one dict per person).
                         When provided, Sheet 1 becomes a proper participant table.
        output_dir: Local directory for the temporary .xlsx file

    Returns:
        {"success": bool, "file_path": str, "excel_url": str | None, "error": str | None}
    """
    try:
        import xlsxwriter
    except ImportError:
        return {"success": False, "file_path": "", "excel_url": None,
                "error": "xlsxwriter not installed. Run: pip install xlsxwriter"}

    output_path = Path(output_dir) / f"{job_id}.xlsx"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info(f"Generating Excel | Job: {job_id} | Fields: {len(fields)} | Output: {output_path}")

    try:
        workbook = xlsxwriter.Workbook(str(output_path))

        # ── Shared Formats ──────────────────────────────────────────────────────
        # All formats must include reading_order=2 for RTL Arabic
        header_fmt = workbook.add_format({
            "bold": True,
            "bg_color": "#2D5016",
            "font_color": "#FFFFFF",
            "border": 1,
            "align": "right",
            "valign": "vcenter",
            "reading_order": 2,
            "font_size": 12,
            "text_wrap": True,   # allow multi-line headers (stacked labels from original form)
        })
        cell_fmt = workbook.add_format({
            "border": 1,
            "align": "right",
            "valign": "vcenter",
            "reading_order": 2,
            "text_wrap": True,
            "font_size": 11,
        })
        label_fmt = workbook.add_format({
            "bold": True,
            "align": "right",
            "reading_order": 2,
            "font_size": 11,
        })
        value_fmt = workbook.add_format({
            "align": "right",
            "reading_order": 2,
            "font_size": 11,
            "text_wrap": True,
        })

        # ── Sheet 1: Participant Table (Gemini) or Flat Fields (fallback) ─────────
        if structured_data:
            # Gemini succeeded: one row per participant, one column per field
            ws1 = workbook.add_worksheet("المشاركون")
            ws1.right_to_left()

            # Collect all unique field names from all participants (preserves first-appearance order).
            # Skip internal metadata keys (prefixed with _) such as _suggestions.
            all_keys = []
            seen_keys = set()
            for p in structured_data:
                for k in p.keys():
                    if k not in seen_keys and not str(k).startswith("_"):
                        seen_keys.add(k)
                        all_keys.append(k)

            # Apply column_order if provided (from DB column_order or sentinel in fields_json)
            if not column_order:
                # Try to extract from sentinel entry in fields_json
                sentinel = next(
                    (f for f in (fields or []) if f.get("field_name") == "__column_order__"), None
                )
                if sentinel:
                    column_order = [c for c in sentinel["value"].split("||") if c]

            if column_order:
                # Start with ordered columns that actually exist in data, then append any extras
                col_names = [c for c in column_order if c in seen_keys]
                col_names += [c for c in all_keys if c not in set(col_names)]
            else:
                col_names = all_keys

            # Drop columns where every participant has null/empty value (matches website behaviour)
            col_names = [c for c in col_names if any(p.get(c) for p in structured_data)]


            # Set column widths based on actual data values, not header text.
            # Headers use text_wrap so they stack within whatever width the data needs.
            # This prevents a long header like "الموافقة على هذه الورقة" from stretching
            # the column wide when the answers are just "نعم" / "لا".
            for col_idx, col_name in enumerate(col_names):
                vals = [str(p.get(col_name) or "") for p in structured_data]
                max_data_len = max((len(v) for v in vals), default=0)
                # Min 8 chars (readable), max 35 chars, +2 for cell padding
                col_width = min(35, max(8, max_data_len + 2))
                ws1.set_column(col_idx, col_idx, col_width)

            # Header row — height scales with the tallest multi-line header
            max_lines = max((col.count("\n") + 1 for col in col_names), default=1)
            ws1.set_row(0, max(20, max_lines * 18))  # 18pt per line, minimum 20pt
            for col_idx, col_name in enumerate(col_names):
                ws1.write(0, col_idx, col_name, header_fmt)

            # Data rows (one per participant)
            for row_idx, participant in enumerate(structured_data, start=1):
                for col_idx, col_name in enumerate(col_names):
                    raw_val = participant.get(col_name) or ""
                    value = str(raw_val).translate(str.maketrans(
                        "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"
                    ))
                    ws1.write(row_idx, col_idx, value, cell_fmt)

            ws1.freeze_panes(1, 0)
            logger.info(f"Sheet 1: participant table | {len(structured_data)} rows × {len(col_names)} cols")
        else:
            # Fallback: flat field_name | value format
            ws1 = workbook.add_worksheet("النص المستخرج")
            ws1.right_to_left()
            ws1.set_column("A:A", 30)
            ws1.set_column("B:B", 50)

            ws1.write(0, 0, "اسم الحقل", header_fmt)
            ws1.write(0, 1, "القيمة", header_fmt)

            visible_fields = [f for f in fields if f.get("field_name") != "__column_order__"]
            for row_idx, field in enumerate(visible_fields, start=1):
                field_name = field.get("field_name", "")
                value = field.get("value", "")
                ws1.write(row_idx, 0, field_name, cell_fmt)
                ws1.write(row_idx, 1, value, cell_fmt)

            ws1.freeze_panes(1, 0)

        # ── Sheet 2: Document Metadata ──────────────────────────────────────────
        ws2 = workbook.add_worksheet("معلومات المستند")
        ws2.right_to_left()
        ws2.set_column("A:A", 25)
        ws2.set_column("B:B", 60)

        metadata = [
            ("اسم المستند", document_name),
            ("معرف المهمة", job_id),
            ("تاريخ الإنشاء", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            ("عدد الحقول", str(len(fields))),
        ]

        for row_idx, (label, value) in enumerate(metadata):
            ws2.write(row_idx, 0, label, label_fmt)
            ws2.write(row_idx, 1, value, value_fmt)

        # Full text section (below metadata)
        ws2.write(len(metadata) + 1, 0, "النص الكامل المستخرج", label_fmt)
        if full_text:
            ws2.write(len(metadata) + 2, 0, full_text, value_fmt)
            ws2.set_row(len(metadata) + 2, 200)  # Tall row for full text

        workbook.close()
        logger.info(f"Excel created | Path: {output_path} | Size: {output_path.stat().st_size:,} bytes")

    except Exception as e:
        logger.error(f"Excel generation failed | Error: {e}")
        return {"success": False, "file_path": str(output_path), "excel_url": None, "error": str(e)}

    # Upload to Supabase
    try:
        excel_url = _upload_to_supabase(str(output_path), job_id)
        logger.info(f"Uploaded to Supabase | Signed URL obtained")
        return {"success": True, "file_path": str(output_path), "excel_url": excel_url, "error": None}
    except Exception as e:
        logger.error(f"Supabase upload failed | Error: {e}")
        # Return partial success: file was created locally even if upload failed
        return {"success": False, "file_path": str(output_path), "excel_url": None,
                "error": f"Excel created locally but Supabase upload failed: {e}"}


def _upload_to_supabase(local_path: str, job_id: str) -> str:
    """
    Upload .xlsx to Supabase Storage bucket 'exports'.
    Returns a signed URL valid for 1 hour.
    Retries up to 3 times with exponential backoff on network errors.
    Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
    """
    import time as _time
    from supabase import create_client

    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    storage_path = f"{job_id}.xlsx"
    with open(local_path, "rb") as f:
        file_bytes = f.read()

    last_err = None
    for attempt in range(3):
        if attempt > 0:
            wait = 5 * (2 ** (attempt - 1))   # 5s, 10s
            logger.warning(f"Supabase upload retry {attempt}/2 in {wait}s — prev error: {last_err}")
            _time.sleep(wait)
        try:
            # Fresh client on every attempt — avoids stale TCP connection reuse
            client = create_client(url, key)
            client.storage.from_("exports").upload(
                path=storage_path,
                file=file_bytes,
                file_options={
                    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "upsert": "true",
                },
            )
            signed = client.storage.from_("exports").create_signed_url(storage_path, 3600)
            return signed["signedURL"]
        except Exception as e:
            last_err = e
            logger.warning(f"Supabase upload attempt {attempt + 1} failed: {e}")

    raise RuntimeError(f"Supabase upload failed after 3 attempts: {last_err}")


# ── CLI Entry Point ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate RTL Arabic Excel from OCR fields")
    parser.add_argument("--job_id", required=True, help="Document job UUID (used as filename)")
    parser.add_argument("--fields", required=True, help='JSON array: [{"field_name":"...","value":"..."}]')
    parser.add_argument("--document_name", required=True, help="Original document filename")
    parser.add_argument("--full_text", default="", help="Complete raw OCR text (written to Sheet 2)")
    parser.add_argument("--output_dir", default=".tmp", help="Local output directory (default: .tmp)")
    args = parser.parse_args()

    from dotenv import load_dotenv
    load_dotenv()

    try:
        fields = json.loads(args.fields)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --fields JSON | Error: {e}")
        sys.exit(1)

    result = generate(
        job_id=args.job_id,
        full_text=args.full_text,
        fields=fields,
        document_name=args.document_name,
        output_dir=args.output_dir,
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if not result["success"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
