"""
Local development server — mirrors the Modal process-document endpoint.
Run: python execution/local_server.py

Listens on http://localhost:8001
Set MODAL_PROCESS_DOCUMENT_URL=http://localhost:8001 in frontend/.env.local

IMPORTANT: /process and / respond 202 IMMEDIATELY and run the pipeline in a
background thread. This prevents Next.js from cancelling the fire-and-forget
fetch before it receives a response.
"""

import sys
import os
import threading
import logging
from pathlib import Path

# Ensure repo root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from execution.process_document import run_pipeline
from execution.generate_excel import generate as generate_excel

logger = logging.getLogger(__name__)

# Track job_ids running in this process so we can fail them on shutdown
_active_jobs: set[str] = set()
_active_jobs_lock = threading.Lock()


def _pipeline_auth_ok(request) -> bool:
    """Shared-secret gate, enforced only when PIPELINE_SHARED_SECRET is set.

    Deliberately NOT fail-closed, unlike the Modal side. This server binds
    to 127.0.0.1 and is reachable only from this machine, and local dev
    normally runs without the secret; failing closed here would buy no
    security and would break `python start.py` for anyone who cloned the
    repo. The internet-facing copy of this gate is in modal_webhook.py and
    it refuses anything it cannot verify."""
    import hmac
    expected = os.getenv("PIPELINE_SHARED_SECRET")
    if not expected:
        return True
    return hmac.compare_digest(request.headers.get("x-pipeline-token", ""), expected)


def _cleanup_stale_jobs():
    """On startup: find any jobs stuck in 'processing' and mark them failed."""
    try:
        from supabase import create_client
        sb = create_client(
            os.environ["NEXT_PUBLIC_SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"],
        )
        stale = (
            sb.table("document_jobs")
            .select("id")
            .eq("status", "processing")
            .execute()
            .data
        )
        if stale:
            ids = [r["id"] for r in stale]
            sb.table("document_jobs").update({
                "status": "failed",
                "error_message": "Processing was interrupted (server restarted). Please reprocess.",
            }).in_("id", ids).execute()
            logger.info(f"[Startup] Recovered {len(ids)} stale job(s): {ids}")
    except Exception as e:
        logger.warning(f"[Startup] Could not recover stale jobs: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stale_jobs()
    # Pre-warm the shared Supabase client so the first job's background
    # thread doesn't incur the ~1 s TCP cold-start cost.
    try:
        from execution.process_document import _get_supabase
        _get_supabase()
        logger.info("[Startup] Supabase client pre-warmed")
    except Exception as e:
        logger.warning(f"[Startup] Supabase pre-warm failed (non-fatal): {e}")
    yield
    # On shutdown: mark any in-flight jobs as failed
    with _active_jobs_lock:
        in_flight = list(_active_jobs)
    if in_flight:
        try:
            from supabase import create_client
            sb = create_client(
                os.environ["NEXT_PUBLIC_SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_ROLE_KEY"],
            )
            sb.table("document_jobs").update({
                "status": "failed",
                "error_message": "Processing was interrupted (server shutdown). Please reprocess.",
            }).in_("id", in_flight).execute()
            logger.info(f"[Shutdown] Marked {len(in_flight)} in-flight job(s) as failed")
        except Exception as e:
            logger.warning(f"[Shutdown] Could not mark in-flight jobs as failed: {e}")


app = FastAPI(lifespan=lifespan)


@app.post("/process")
@app.post("/")
async def process_document(request: Request):
    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON: {e}", "success": False}, status_code=400)

    job_id       = body.get("job_id")
    document_url = body.get("document_url")
    user_id      = body.get("user_id")
    debug        = body.get("debug", False)

    if not job_id or not document_url or not user_id:
        return JSONResponse(
            {"error": "Missing required fields: job_id, document_url, user_id", "success": False},
            status_code=400,
        )

    # ── Run pipeline in background thread and return 202 immediately ──────────
    # This is CRITICAL: Next.js fire-and-forget fetch is cancelled if the server
    # doesn't respond before the route handler returns. By returning 202 first,
    # the fetch completes successfully and the pipeline runs independently.
    def _run():
        with _active_jobs_lock:
            _active_jobs.add(job_id)
        try:
            result = run_pipeline(
                job_id=job_id,
                document_url=document_url,
                user_id=user_id,
                debug=debug,
            )
            if not result.get("success"):
                logger.error(f"[Pipeline] Job {job_id} failed: {result.get('error')}")
            else:
                logger.info(f"[Pipeline] Job {job_id} completed successfully")
        except Exception as exc:
            logger.exception(f"[Pipeline] Unhandled error for job {job_id}: {exc}")
            # Ensure job is never left stuck in "processing"
            try:
                from supabase import create_client
                _sb = create_client(
                    os.environ["NEXT_PUBLIC_SUPABASE_URL"],
                    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
                )
                _sb.table("document_jobs").update({
                    "status": "failed",
                    "error_message": f"Unhandled pipeline error: {exc}",
                }).eq("id", job_id).execute()
            except Exception:
                pass
        finally:
            with _active_jobs_lock:
                _active_jobs.discard(job_id)

    thread = threading.Thread(target=_run, daemon=True, name=f"pipeline-{job_id[:8]}")
    thread.start()

    logger.info(f"[Pipeline] Job {job_id} queued — background thread started")
    return JSONResponse({"success": True, "job_id": job_id, "status": "queued"}, status_code=202)


@app.post("/generate-excel")
async def regenerate_excel(request: Request):
    """
    Regenerate Excel from current structured_data (includes user edits).
    Called by the frontend export button so the download always reflects corrections.
    """
    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON: {e}", "success": False}, status_code=400)

    job_id = body.get("job_id")
    if not job_id:
        return JSONResponse({"error": "Missing job_id", "success": False}, status_code=400)

    result = generate_excel(
        job_id=job_id,
        full_text=body.get("full_text") or "",
        fields=body.get("fields") or [],
        document_name=body.get("document_name") or "document",
        structured_data=body.get("structured_data") or None,
        column_order=body.get("column_order") or None,
    )
    status_code = 200 if result["success"] else 500
    return JSONResponse(result, status_code=status_code)


@app.post("/recrop-job")
async def recrop_job(request: Request):
    """Manually trigger the cropper for one job — back-fill / retry path."""
    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON: {e}", "success": False}, status_code=400)
    job_id = body.get("job_id")
    if not job_id:
        return JSONResponse({"error": "Missing job_id", "success": False}, status_code=400)
    try:
        from execution.crop_names import crop_job_names
        stats = crop_job_names(job_id)
        return JSONResponse({"success": True, **stats}, status_code=200)
    except Exception as e:
        return JSONResponse({"error": str(e), "success": False, "job_id": job_id}, status_code=500)


@app.post("/train-only")
async def train_only(request: Request):
    """
    Train-only pipeline: Azure Layout + crop, no OCR / structuring / Excel.
    Used by the manual-upload flow to produce name-level training crops at
    minimal cost (~1 Azure call per file, no Vision/Gemini spend).
    Body: {job_id, document_url, user_id}
    """
    if not _pipeline_auth_ok(request):
        return JSONResponse({"error": "Unauthorized", "success": False}, status_code=401)
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON: {e}", "success": False}, status_code=400)
    job_id       = body.get("job_id")
    document_url = body.get("document_url")
    user_id      = body.get("user_id")
    if not job_id or not document_url or not user_id:
        return JSONResponse(
            {"error": "Missing job_id, document_url, or user_id", "success": False},
            status_code=400,
        )
    # Spawn in a thread so this returns 202 quickly (Vercel-safe).
    def _runner():
        try:
            from execution.process_document import run_train_only_pipeline
            run_train_only_pipeline(job_id=job_id, document_url=document_url, user_id=user_id)
        except Exception as exc:
            print(f"[train-only] background runner failed: {exc}")
    threading.Thread(target=_runner, daemon=True).start()
    return JSONResponse(
        {"success": True, "job_id": job_id, "status": "queued"},
        status_code=202,
    )


if __name__ == "__main__":
    print("Local pipeline server running on http://localhost:8001")
    # 127.0.0.1, not 0.0.0.0: this is the local dev server and binding every
    # interface publishes it to whatever network the laptop is on.
    uvicorn.run("execution.local_server:app", host="127.0.0.1", port=8001, reload=True)
