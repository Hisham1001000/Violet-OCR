"""Re-encode the training-crop CONTEXT images from PNG to JPEG.

Why: Supabase storage went over the plan quota (~2.2 GB). The context images —
the wider "editor backdrop" saved next to every tight crop so trainers can drag
the crop box — are ~80% of those bytes and are NEVER used for training; only the
tight crop feeds the model. Re-encoding just the context images at q95 frees
~1.2 GB with no visible loss and leaves every training crop as untouched PNG.

Deliberately writes back to the SAME object path (still ".png") with
content-type image/jpeg, so training_dataset.context_path stays valid and no
migration or frontend change is needed — browsers honour the content-type.

Run inside Modal (datacenter bandwidth); the user's connection is too slow to
move ~19k objects.
"""
import io
import os

QUALITY = 95          # near-lossless; the file is only an editor backdrop
BUCKET  = "training_crops"


def compress_context_images(limit: int | None = None, dry_run: bool = False,
                            offset: int = 0) -> dict:
    """Convert context images in the window [offset, offset+limit).

    A single worker converted ~50 images/min, i.e. hours for the full set, so
    callers split the range into chunks and run them concurrently; `offset`
    exists for that. Re-encoding is idempotent — anything already JPEG is
    skipped — so overlapping or re-run chunks are harmless.
    """
    from supabase import create_client
    from PIL import Image

    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    stats = {"seen": 0, "converted": 0, "skipped_already_jpeg": 0,
             "errors": 0, "bytes_before": 0, "bytes_after": 0, "samples": []}

    rows: list[dict] = []
    step = 1000
    off  = 0
    while True:
        res = (sb.table("training_dataset")
                 .select("id, context_path")
                 .not_.is_("context_path", "null")
                 .order("id")
                 .range(off, off + step - 1)
                 .execute())
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < step:
            break
        off += step
    rows = rows[offset: offset + limit if limit else None]

    for r in rows:
        path = r.get("context_path")
        if not path:
            continue
        stats["seen"] += 1
        try:
            raw = sb.storage.from_(BUCKET).download(path)
            stats["bytes_before"] += len(raw)

            im = Image.open(io.BytesIO(raw))
            if (im.format or "").upper() == "JPEG":
                stats["skipped_already_jpeg"] += 1
                stats["bytes_after"] += len(raw)
                continue

            buf = io.BytesIO()
            im.convert("RGB").save(buf, format="JPEG", quality=QUALITY, optimize=True)
            data = buf.getvalue()

            # Only rewrite when it actually helps.
            if len(data) >= len(raw):
                stats["bytes_after"] += len(raw)
                continue

            if not dry_run:
                sb.storage.from_(BUCKET).update(
                    path, data, {"content-type": "image/jpeg", "upsert": "true"})
            stats["bytes_after"] += len(data)
            stats["converted"] += 1
            if len(stats["samples"]) < 5:
                stats["samples"].append(
                    {"path": path, "before_kb": round(len(raw) / 1024),
                     "after_kb": round(len(data) / 1024)})
        except Exception as e:                      # noqa: BLE001 - report, keep going
            stats["errors"] += 1
            if len(stats["samples"]) < 8:
                stats["samples"].append({"path": path, "error": str(e)[:90]})

    stats["saved_mb"] = round(
        (stats["bytes_before"] - stats["bytes_after"]) / 1024 / 1024, 1)
    return stats
