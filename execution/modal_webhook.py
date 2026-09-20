"""
Modal webhook app for the 3-layer AI orchestration system.
App name: violet-pipeline

Deploy:
    modal secret create claude-orchestrator-secrets \\
        ANTHROPIC_API_KEY=... SLACK_WEBHOOK_URL=... SENDGRID_API_KEY=...
    modal deploy execution/modal_webhook.py

Endpoints:
    GET  /list-webhooks           List all registered webhooks
    POST /directive?slug={slug}   Execute a directive via Claude
    GET  /test-email              Send a test email to verify config

All activity streams to Slack in real-time.
"""

import hmac
import json
import os
import sys
from pathlib import Path

import httpx
import modal
from fastapi import Request

# ── Modal App ──────────────────────────────────────────────────────────────────

# The Modal SECRET is still named claude-orchestrator-secrets. Renaming a
# secret is a separate dashboard action and would break every app that
# reads it, so only the app was renamed.
app = modal.App("violet-pipeline")

image = (
    modal.Image.debian_slim()
    .pip_install([
        "fastapi[standard]",
        "anthropic>=0.25.0",
        "httpx",
        "sendgrid",
        "google-api-python-client",
        "google-auth-httplib2",
        "google-auth-oauthlib",
    ])
    .add_local_dir(".", remote_path="/app", ignore=[
        ".env", ".tmp", "__pycache__", ".git", "node_modules",
        # The Python pipeline never imports from the Next.js app. Mounting it
        # (src/ + .next/ build output + public/) uploaded ~400 needless files
        # per deploy and was tripping Modal's upload heartbeat timeout.
        "frontend", "*.pdf",
    ])
)

modal_secret = modal.Secret.from_name("claude-orchestrator-secrets")

# ── OCR Image (Phase 1) ────────────────────────────────────────────────────────
# Separate image for the Arabic OCR pipeline. Kept isolated so a build failure
# here cannot affect the existing list-webhooks / directive / test-email endpoints.

ocr_image = (
    modal.Image.debian_slim()
    .apt_install(["poppler-utils"])
    .pip_install([
        "fastapi[standard]",
        "google-cloud-vision>=3.7.0",
        "google-genai>=0.8.0",
        "supabase>=2.3.0",
        "httpx",
        "Pillow>=10.0.0",
        "pdf2image>=1.16.0",
        "pymupdf>=1.23.0",
        "xlsxwriter>=3.1.0",
        "python-dotenv>=1.0.0",
        "azure-ai-documentintelligence>=1.0.0",
    ])
    # Stage 5.5: re-read handwritten name cells with the fine-tuned adapters
    # instead of shipping Azure's reading to the customer. Set to "0" and
    # redeploy to fall straight back to Azure -- the stage is then skipped
    # entirely, not merely ignored.
    # Must precede add_local_dir: Modal forbids build steps after local files.
    .env({
        # Names are read by the fine-tuned adapters (Stage 5.5).
        "LORA_NAMES_ENABLED": "1",
        # Redundant OCR secondaries, kept in the code but out of the run.
        # Frozen 400: four-engine chain 68.5% of name words, Azure Layout +
        # adapters 87.3%. Azure stays -- it reads digits and dates well, which
        # the model was never trained on. Flip any of these to "1" to restore.
        "GEMINI_OCR_ENABLED": "0",
        "VISION_ENABLED":     "0",
        # Per-cell Gemini re-reads, ON, on the newest Flash. Scoped to single
        # cells -- never the whole table, which reorders rows (see Stage 4a.1).
        "GEMINI_CELL_REVIEW": "1",
        # The pipeline was pinned to gemini-2.5-flash, two generations behind.
        # On the same crop 2.5 read "هدى محمد" where 3.7 read
        # "هدى محمد سالم المصري". That gap is what produced 4001 for نور and
        # 907.11222 for 407111222 in the digit columns.
        "GEMINI_MODEL": "gemini-3.7-flash",
        # Stage 4.7: re-read only the cells QL4 proves malformed. Measured on
        # one sheet, both phone misses were cells QL4 had already flagged and
        # nothing acted on.
        "DIGIT_REPAIR_ENABLED": "1",
    })
    .add_local_dir(".", remote_path="/app", ignore=[
        ".env", ".tmp", "__pycache__", ".git", "node_modules",
        # The Python pipeline never imports from the Next.js app. Mounting it
        # (src/ + .next/ build output + public/) uploaded ~400 needless files
        # per deploy and was tripping Modal's upload heartbeat timeout.
        "frontend", "*.pdf",
    ])
)

# ── Helpers ────────────────────────────────────────────────────────────────────

def _load_webhooks() -> dict:
    registry_path = Path("/app/execution/webhooks.json")
    with open(registry_path) as f:
        data = json.load(f)
    return data.get("webhooks", {})


def _load_directive(directive_filename: str) -> str:
    directive_path = Path("/app/directives") / directive_filename
    if not directive_path.exists():
        raise FileNotFoundError(f"Directive not found: {directive_filename}")
    return directive_path.read_text(encoding="utf-8")


def _pipeline_auth_ok(request: Request) -> bool:
    """
    Shared-secret gate for the OCR pipeline endpoints (process-document,
    generate-excel).

    Fails CLOSED: with PIPELINE_SHARED_SECRET unset on this worker, every
    request is refused. It used to allow them through, so that deploying the
    gate could not take the pipeline down before the secret existed on both
    sides. That window has passed, the secret is provisioned, and an endpoint
    that silently opens itself when a variable goes missing is the wrong way
    round for a door onto the internet. A missing variable now stops uploads,
    loudly, instead of accepting unauthenticated work.

    To actually close the door: set the SAME value for PIPELINE_SHARED_SECRET in
    the Modal secret `claude-orchestrator-secrets` AND in the Vercel project env.
    The Vercel API routes send it as the `X-Pipeline-Token` header.
    """
    expected = os.getenv("PIPELINE_SHARED_SECRET")
    if not expected:
        print("[auth] PIPELINE_SHARED_SECRET is not set on this worker - refusing. "
              "Set it in the Modal secret and redeploy.")
        return False
    token = request.headers.get("x-pipeline-token", "")
    return hmac.compare_digest(token, expected)


def _slack_send(message: str) -> None:
    """Post to Slack. Silently fails so it never crashes the main flow."""
    url = os.getenv("SLACK_WEBHOOK_URL")
    if not url:
        return
    try:
        httpx.post(url, json={"text": message}, timeout=5)
    except Exception:
        pass


def _build_tool_schemas(allowed_tools: list) -> list:
    """Return Anthropic tool schema dicts for the given allowed tools."""
    ALL_SCHEMAS = {
        "send_email": {
            "name": "send_email",
            "description": "Send an email via SendGrid or SMTP.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address(es)"},
                    "subject": {"type": "string", "description": "Email subject"},
                    "body": {"type": "string", "description": "Email body (plain text or HTML)"},
                    "html": {"type": "boolean", "description": "True if body is HTML"},
                },
                "required": ["to", "subject", "body"],
            },
        },
        "read_sheet": {
            "name": "read_sheet",
            "description": "Read rows from a Google Sheet.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet document ID"},
                    "range_name": {"type": "string", "description": "A1 notation range, e.g. Sheet1!A1:Z100"},
                },
                "required": ["spreadsheet_id", "range_name"],
            },
        },
        "update_sheet": {
            "name": "update_sheet",
            "description": "Write or append data to a Google Sheet.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "spreadsheet_id": {"type": "string", "description": "Google Sheet document ID"},
                    "range_name": {"type": "string", "description": "A1 notation range"},
                    "values": {"type": "array", "items": {"type": "array"}, "description": "2D array of cell values"},
                    "mode": {"type": "string", "enum": ["write", "append"], "description": "write=overwrite, append=add rows"},
                },
                "required": ["spreadsheet_id", "range_name", "values"],
            },
        },
    }
    return [ALL_SCHEMAS[t] for t in allowed_tools if t in ALL_SCHEMAS]


def _dispatch_tool(tool_name: str, tool_input: dict) -> dict:
    sys.path.insert(0, "/app")
    from execution.tools import TOOL_REGISTRY

    if tool_name not in TOOL_REGISTRY:
        return {"success": False, "error": f"Unknown tool: {tool_name}"}
    try:
        return TOOL_REGISTRY[tool_name](**tool_input)
    except Exception as e:
        return {"success": False, "error": str(e)}


def _call_claude(directive_text: str, payload: dict, allowed_tools: list) -> str:
    """
    Run Claude claude-opus-4-6 with the directive as system prompt.
    Handles multi-turn tool use in an agentic loop until end_turn.
    """
    import anthropic

    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    tool_schemas = _build_tool_schemas(allowed_tools)

    messages = [
        {
            "role": "user",
            "content": (
                f"Inbound webhook payload:\n"
                f"```json\n{json.dumps(payload, indent=2)}\n```"
            ),
        }
    ]

    response_text = ""

    while True:
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=4096,
            system=directive_text,
            tools=tool_schemas if tool_schemas else [],
            messages=messages,
        )

        for block in response.content:
            if hasattr(block, "text"):
                response_text += block.text

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = _dispatch_tool(block.name, block.input)
                    _slack_send(
                        f"Tool: `{block.name}` | Result: `{json.dumps(result)[:300]}`"
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result),
                    })
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})
            continue

        break  # unexpected stop reason

    return response_text


# ── Web Endpoints ──────────────────────────────────────────────────────────────

@app.function(image=image, secrets=[modal_secret])
@modal.fastapi_endpoint(method="GET", label="list-webhooks")
def list_webhooks(request: Request):
    from fastapi.responses import JSONResponse

    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    webhooks = _load_webhooks()
    return JSONResponse({"webhooks": webhooks, "count": len(webhooks)})


@app.function(image=image, secrets=[modal_secret], timeout=300)
@modal.fastapi_endpoint(method="POST", label="directive")
async def run_directive(request: Request):
    from fastapi.responses import JSONResponse

    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    slug = request.query_params.get("slug")
    if not slug:
        return JSONResponse({"error": "Missing ?slug= query parameter"}, status_code=400)

    webhooks = _load_webhooks()
    if slug not in webhooks:
        return JSONResponse({"error": f"Unknown slug: {slug}"}, status_code=404)

    webhook_config = webhooks[slug]
    directive_filename = webhook_config.get("directive")
    allowed_tools = webhook_config.get("tools", [])

    _slack_send(f"Webhook triggered: `{slug}` | Directive: `{directive_filename}`")

    try:
        directive_text = _load_directive(directive_filename)
        content_type = request.headers.get("content-type", "")
        payload = await request.json() if "application/json" in content_type else {}
    except FileNotFoundError as e:
        _slack_send(f"ERROR `{slug}`: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
    except Exception as e:
        _slack_send(f"ERROR parsing request `{slug}`: {e}")
        return JSONResponse({"error": str(e)}, status_code=400)

    try:
        result = _call_claude(directive_text, payload, allowed_tools)
        _slack_send(f"Completed `{slug}` | Preview: {result[:300]}")
        return JSONResponse({"slug": slug, "result": result, "success": True})
    except Exception as e:
        _slack_send(f"CLAUDE ERROR `{slug}`: {e}")
        return JSONResponse({"error": str(e), "success": False}, status_code=500)


@app.function(image=image, secrets=[modal_secret])
@modal.fastapi_endpoint(method="GET", label="test-email")
def test_email(request: Request):
    from fastapi.responses import JSONResponse

    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    sys.path.insert(0, "/app")
    from execution.tools.send_email import send_email

    test_to = os.getenv("SMTP_USER", "test@example.com")
    result = send_email(
        to=test_to,
        subject="Claude Orchestrator - Test Email",
        body="If you received this, your email configuration is working correctly.",
    )
    _slack_send(f"Test email → `{test_to}` | Result: `{result}`")
    return JSONResponse(result)


# ── Background workers ─────────────────────────────────────────────────────────
# These are NOT web endpoints — Modal functions invoked via `.spawn()` from the
# webhook below. Spawning lets the webhook return in <1 second so Vercel's
# serverless function doesn't cancel the connection mid-flight.

@app.function(image=ocr_image, secrets=[modal_secret], timeout=900)
def _run_full_pipeline(job_id: str, document_url: str, user_id: str, debug: bool = False):
    """Heavy OCR pipeline. Runs in its own Modal worker after spawn()."""
    sys.path.insert(0, "/app")
    from execution.process_document import run_pipeline
    return run_pipeline(job_id=job_id, document_url=document_url, user_id=user_id, debug=debug)


@app.function(image=ocr_image, secrets=[modal_secret], timeout=300)
def _run_recrop(job_id: str):
    """Cropper-only path. Spawned from the webhook for the same reason."""
    sys.path.insert(0, "/app")
    from execution.crop_names import crop_job_names
    return crop_job_names(job_id)


@app.function(image=ocr_image, secrets=[modal_secret], timeout=21600)
def _compress_context_images(limit: int = 0, dry_run: bool = False, offset: int = 0):
    """Re-encode context (editor-backdrop) images PNG -> JPEG to cut storage.

    Runs here rather than locally because it moves ~19k objects, which the
    user's connection cannot do in reasonable time. Training crops are NOT
    touched — only the wider backdrop images the model never sees.
    """
    sys.path.insert(0, "/app")
    from execution.compress_context_images import compress_context_images
    return compress_context_images(limit=limit or None, dry_run=dry_run, offset=offset)


@app.function(image=ocr_image, secrets=[modal_secret], timeout=21600)
def _compress_context_all(chunk: int = 800, total: int = 10000):
    """Fan the re-encode out across parallel workers.

    One sequential worker managed ~50 images/min (hours for ~9.4k images).
    Splitting the range and running the chunks concurrently turns that into
    minutes; chunks are independent and idempotent, so a failed chunk can just
    be re-run.
    """
    windows = [(off, chunk) for off in range(0, total, chunk)]
    agg = {"seen": 0, "converted": 0, "skipped_already_jpeg": 0,
           "errors": 0, "bytes_before": 0, "bytes_after": 0}
    for res in _compress_context_images.starmap(
            [(c, False, o) for o, c in windows]):
        for k in agg:
            agg[k] += res.get(k, 0)
    agg["saved_mb"] = round((agg["bytes_before"] - agg["bytes_after"]) / 1024 / 1024, 1)
    return agg


@app.function(image=ocr_image, secrets=[modal_secret], timeout=1800)
def _lora_dry_run(job_id: str) -> dict:
    """
    Run Stage 5.5 against one job from inside the pipeline container, writing
    nothing.

    Worth having as its own entry point: lora_names calls another Modal app
    from within this one, and that only proves out in a real container. Locally
    it also drags the document and every crop across the operator's connection.
    """
    import sys
    sys.path.insert(0, "/app")
    from execution.lora_names import read_job_names
    stats = read_job_names(job_id, dry_run=True)
    for pair in stats.get("pairs", [])[:30]:
        mark = "  " if pair["azure"] == pair["lora"] else "->"
        print(f"row {pair['row']:>3} {mark} azure: {pair['azure']}")
        print(f"          lora : {pair['lora']}  agree={pair['agree']}")
    return stats


@app.function(image=ocr_image, secrets=[modal_secret], timeout=300)
def _run_train_only(job_id: str, document_url: str, user_id: str):
    """Train-only path: Azure Layout + crop, no OCR/structuring/Excel."""
    sys.path.insert(0, "/app")
    from execution.process_document import run_train_only_pipeline
    return run_train_only_pipeline(job_id=job_id, document_url=document_url, user_id=user_id)


# ── OCR Endpoint (Phase 1) ─────────────────────────────────────────────────────

@app.function(image=ocr_image, secrets=[modal_secret], timeout=60)
@modal.fastapi_endpoint(method="POST", label="process-document")
async def process_document_webhook(request: Request):
    """
    Multiplexed endpoint — accepts both full OCR processing and back-fill
    cropping. Returns 202 Accepted in <1 second after queueing the work via
    Modal `.spawn()`. The actual run happens in a separate Modal worker and
    updates document_jobs.status as it progresses.

    Why spawn? Vercel serverless functions cancel in-flight fetches as soon
    as they return. If this webhook ran the 30-90s pipeline inline, Vercel
    would kill the connection and the job would stay 'pending' forever
    (which is the bug this replaces).

    Modes:
      mode="full" (default)  Full OCR pipeline.
        Body: {job_id, document_url, user_id, debug?}
      mode="recrop_only"     Run only the training-data cropper (assumes
                             cell_polygons already exist on the job).
        Body: {job_id}
      mode="train_only"      Azure Layout + crop, NO OCR / structuring / Excel.
                             Used by the manual-upload training flow.
        Body: {job_id, document_url, user_id}
    """
    from fastapi.responses import JSONResponse

    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON body: {e}", "success": False}, status_code=400)

    mode   = body.get("mode") or "full"
    job_id = body.get("job_id")
    if not job_id:
        return JSONResponse({"error": "Missing job_id", "success": False}, status_code=400)

    if mode == "recrop_only":
        call = _run_recrop.spawn(job_id)
        return JSONResponse(
            {"success": True, "queued": True, "mode": "recrop_only", "job_id": job_id, "call_id": call.object_id},
            status_code=202,
        )

    if mode == "train_only":
        document_url = body.get("document_url")
        user_id      = body.get("user_id")
        if not document_url or not user_id:
            return JSONResponse(
                {"error": "Missing required fields for train_only: document_url, user_id", "success": False},
                status_code=400,
            )
        call = _run_train_only.spawn(job_id, document_url, user_id)
        return JSONResponse(
            {"success": True, "queued": True, "mode": "train_only", "job_id": job_id, "call_id": call.object_id},
            status_code=202,
        )

    # Full pipeline
    document_url = body.get("document_url")
    user_id      = body.get("user_id")
    debug        = body.get("debug", False)
    if not document_url or not user_id:
        return JSONResponse(
            {"error": "Missing required fields for full mode: document_url, user_id", "success": False},
            status_code=400,
        )

    call = _run_full_pipeline.spawn(job_id, document_url, user_id, debug)
    return JSONResponse(
        {"success": True, "queued": True, "mode": "full", "job_id": job_id, "call_id": call.object_id},
        status_code=202,
    )


# ── Excel Regeneration Endpoint ────────────────────────────────────────────────
# Mirrors local_server.py /generate-excel so the production website can export
# Excel files from current (possibly user-edited) structured_data. Without this,
# /api/documents/[id]/export hits Modal and 404s because no such route exists.

@app.function(image=ocr_image, secrets=[modal_secret], timeout=120)
@modal.fastapi_endpoint(method="POST", label="generate-excel")
async def generate_excel_webhook(request: Request):
    """
    Regenerate an Excel file from a job's structured_data and upload it to
    Supabase Storage. Returns a signed download URL.

    Expected JSON body:
        {
          "job_id":          "uuid",
          "structured_data": [{...}, ...],   # optional (falls back to DB row)
          "full_text":       "string",       # optional
          "fields":          [...],           # optional
          "document_name":   "string",        # optional
          "column_order":    ["col1", ...]    # optional
        }
    """
    from fastapi.responses import JSONResponse

    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)

    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON body: {e}", "success": False}, status_code=400)

    job_id = body.get("job_id")
    if not job_id:
        return JSONResponse({"error": "Missing job_id", "success": False}, status_code=400)

    try:
        sys.path.insert(0, "/app")
        from execution.generate_excel import generate as generate_excel

        result = generate_excel(
            job_id          = job_id,
            full_text       = body.get("full_text") or "",
            fields          = body.get("fields") or [],
            document_name   = body.get("document_name") or "document",
            structured_data = body.get("structured_data") or None,
            column_order    = body.get("column_order") or None,
        )
        status_code = 200 if result.get("success") else 500
        return JSONResponse(result, status_code=status_code)

    except Exception as e:
        return JSONResponse({"error": str(e), "success": False, "job_id": job_id}, status_code=500)
