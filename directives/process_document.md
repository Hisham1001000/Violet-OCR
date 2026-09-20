# SOP: Process Arabic Handwritten Document (Phase 1 MVP)

## Goal
Accept a handwritten Arabic document (image or PDF), extract all text using Google Cloud Vision, parse basic fields, and produce a downloadable RTL Arabic Excel file. The result is stored in Supabase for review.

## Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Path to GCP service account JSON for Cloud Vision |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for Gemini structuring/correction |
| `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `AZURE_DI_ENDPOINT` | No | Azure Document Intelligence endpoint (for hybrid OCR) |
| `AZURE_DI_KEY` | No | Azure Document Intelligence API key |
| `AZURE_OCR_ENABLED` | No | Set to `"1"` to enable always-both OCR mode (default: `"0"`) |

## Inputs
- `job_id` — Supabase `document_jobs` UUID (must already exist with status `pending`)
- `document_url` — Supabase Storage signed URL pointing to the uploaded document
- `user_id` — Supabase auth user UUID (for RLS verification)
- `debug` (optional) — If true, write raw Vision responses to `.tmp/vision_debug_*.json`

## Trigger
HTTP POST to Modal endpoint `/process-document` with JSON body:
```json
{
  "job_id": "uuid",
  "document_url": "https://...",
  "user_id": "uuid"
}
```

## Pipeline Stages

### Stage 1 — Mark as Processing
- Update `document_jobs.status = 'processing'`
- Frontend polls or subscribes via Supabase Realtime to show progress

### Stage 2 — Download Document
- Download bytes from `document_url` using `httpx`
- Detect MIME type from response headers
- Supported: `image/png`, `image/jpeg`, `image/webp`, `application/pdf`

### Stage 3 — Google Cloud Vision OCR
- Script: `execution/extract_vision.py`
- Auth: service account via `GOOGLE_APPLICATION_CREDENTIALS` (NOT the OAuth credentials used by Google Sheets)
- For images: run `DOCUMENT_TEXT_DETECTION` with `language_hints=["ar"]`
- For PDFs: rasterize each page to PNG via `pdf2image` (requires `poppler`), then run Vision per page
- Output: `full_text` (all pages joined), `pages[]` with per-page text and confidence, `raw_response`

### Stage 3.3 — Azure Document Intelligence OCR (always-both mode)
- Script: `execution/extract_azure.py`
- Enabled by: `AZURE_OCR_ENABLED=1` in `.env` (default: `0` = disabled)
- Credentials: `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY` (Azure Portal → Document Intelligence → Keys and Endpoint)
- Accepts PDF natively (no rasterization). Model: `prebuilt-read`.
- Runs on EVERY document when enabled. Non-fatal: errors logged as warnings, pipeline continues with Vision only.
- Output stored in `azure_text` variable (used in Stage 3.6).

### Stage 3.5 — OCR Pre-processing
- Char normalization: Urdu/Persian chars (ی/ک/ہ/ے) → Arabic equivalents (ي/ك/ه/ي)
- `ocr_corrections` table: deterministic find-and-replace on `clean_text`

### Stage 3.6 — Gemini OCR Arbitration (Vision vs Azure)
- Function: `reconcile_ocr_texts()` in `execution/extract_gemini.py`
- Only runs when `azure_text` was populated in Stage 3.3.
- Gemini compares both outputs line-by-line and word-by-word, selects the more correct Arabic reading.
- Safety guard: rejects result if >40% char change vs Vision text.
- Non-fatal: errors logged as warnings, pipeline continues with unchanged `clean_text`.

### Stage 3.7 — Gemini OCR Correction pass
- Function: `correct_ocr_text()` in `execution/extract_gemini.py`
- Best-effort Arabic name spelling fixes (محمد not مهمد, etc.)
- Safety guard: rejects result if >30% char change.

### Stage 4 — Gemini Structuring + fallback field parsing
- Function: `structure_with_gemini()` in `execution/extract_gemini.py`
- Takes `clean_text` (after all pre-processing stages above)
- Returns `structured_data`: list of participant dicts with detected column headers
- Fallback: `_parse_fields()` regex parser if Gemini fails

### Stage 5 — Save to Supabase
- Update `document_jobs`: set `full_text`, `fields_json`
- Insert `document_pages` row per page: `raw_vision_response`, `full_text`
  - Used for debugging OCR quality and for Phase 2 multi-engine comparison

### Stage 6 — Generate Excel and Upload
- Script: `execution/generate_excel.py`
- Sheet 1 "النص المستخرج": field_name | value (RTL, Arabic fonts)
- Sheet 2 "معلومات المستند": document metadata + full raw text
- Upload to Supabase Storage `exports/{job_id}.xlsx`
- Generate signed URL (1 hour validity)
- Update `document_jobs.status = 'completed'`, `completed_at`

## Expected Output
- `document_jobs.status` → `completed`
- `document_jobs.full_text` → extracted Arabic text
- `document_jobs.fields_json` → array of `{field_name, value}` objects
- `document_pages` → one row per page with raw Vision JSON
- Supabase Storage `exports/{job_id}.xlsx` → downloadable Excel file
- HTTP response: `{"success": true, "job_id": "...", "excel_url": "..."}`

## Edge Cases

### Empty text returned by Vision
- Log warning: "Empty text extracted — document may be blank or unreadable"
- Continue pipeline; `fields_json` will be `[]`
- Status still set to `completed` — user sees empty result in review UI

### PDF rasterization fails (poppler not installed)
- Error: `"PDF rasterization failed: ... Ensure poppler is installed."`
- Status: `failed`; `error_message` populated
- Fix: install poppler — on Modal this is `apt_install(["poppler-utils"])`

### Vision API authentication error
- Error: `google.auth.exceptions.DefaultCredentialsError`
- Cause: `GOOGLE_APPLICATION_CREDENTIALS` not set or pointing to wrong file
- Fix: ensure service account JSON path is correct and Cloud Vision API is enabled in GCP

### Download fails (bad URL, expired signed URL)
- Error: `"Download failed: ..."`
- Status: `failed`; `error_message` populated
- Supabase signed URLs expire — generate fresh URL before triggering pipeline

### Excel upload fails (Supabase Storage unreachable)
- File is still created locally at `.tmp/{job_id}.xlsx`
- Error message set; status: `failed`
- Retry: re-run the pipeline; it will overwrite the existing upload (upsert=true)

### Duplicate page insert
- `document_pages` has UNIQUE (job_id, page_number) — upsert used to handle re-runs safely

## Debug Mode
Run with `--debug` flag or pass `debug: true` in the JSON payload:
- Raw Vision JSON written to `.tmp/vision_debug_{suffix}_{timestamp}.json`
- Inspect this file to verify Arabic character encoding and confidence scores

## Slack Activity
Not configured in Phase 1 MVP. Phase 2 will add Slack streaming via `_slack_send()`.

## Notes
- `GOOGLE_APPLICATION_CREDENTIALS` (Vision service account) ≠ `GOOGLE_CREDENTIALS_PATH` (Sheets OAuth). Never mix them.
- For handwritten Arabic, Vision confidence is typically 0.5–0.8. Low confidence is expected and normal in Phase 1.
- `.tmp/` files are intermediates — they can be safely deleted and regenerated.
- Run `python execution/process_document.py --help` for CLI usage.
