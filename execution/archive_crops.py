"""
execution/archive_crops.py — move the training crops off Supabase Storage.

The crop images are the only copy of months of trainer work. They are needed to
retrain from base on the full set, and to score any future model against the
frozen 400 — the adapters are just weights and can always be rebuilt, the images
cannot. But they do not need to live on Supabase, where they are what pushes the
storage quota.

This copies every crop and context image to a Modal volume and writes a manifest
alongside them. It DELETES NOTHING. Deletion is a separate, deliberate step that
should only run after `verify` reports every file present with a matching size.

    modal run execution/archive_crops.py::archive      # copy + manifest
    modal run execution/archive_crops.py::verify       # confirm before deleting
    modal run execution/archive_crops.py::purge        # delete from Supabase

Labels stay in Postgres — they are text and cost nothing.
"""
from __future__ import annotations

import modal

app     = modal.App("arabic-crop-archive")
# Named crops_vol, not `archive`: the local entrypoint below is called
# archive(), and the function name shadows the module-level volume inside
# the container -- commit() then resolves to the entrypoint object.
crops_vol = modal.Volume.from_name("arabic-htr-crops", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(["httpx"])
)

BUCKET   = "training_crops"
MOUNT    = "/archive"
WORKERS  = 12


def _env():
    import os
    return (os.environ["NEXT_PUBLIC_SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def _rows():
    """Every training_dataset row that owns at least one image."""
    import json, urllib.request
    url, key = _env()
    H = {"apikey": key, "Authorization": "Bearer " + key}
    out, offset = [], 0
    while True:
        q = (url + "/rest/v1/training_dataset?select=id,label,status,crop_path,context_path"
             "&order=created_at.asc&limit=1000&offset=" + str(offset))
        batch = json.load(urllib.request.urlopen(
            urllib.request.Request(q, headers=H), timeout=120))
        out += batch
        if len(batch) < 1000:
            break
        offset += 1000
    return [r for r in out if r.get("crop_path") or r.get("context_path")]


def _paths(rows):
    seen = []
    for r in rows:
        for k in ("crop_path", "context_path"):
            p = r.get(k)
            if p and p not in seen:
                seen.append(p)
    return seen


@app.function(image=image, volumes={MOUNT: crops_vol},
              secrets=[modal.Secret.from_name("claude-orchestrator-secrets")],
              timeout=10800)
def archive_all(limit: int = 0) -> dict:
    """Copy every image to the volume. Skips files already archived."""
    import json, os, pathlib, urllib.request
    import concurrent.futures as cf

    url, key = _env()
    H = {"apikey": key, "Authorization": "Bearer " + key}
    rows  = _rows()
    paths = _paths(rows)
    if limit:
        paths = paths[:limit]
    print(f"{len(rows)} rows, {len(paths)} images to archive")

    def fetch(path):
        dest = pathlib.Path(MOUNT) / path
        if dest.exists() and dest.stat().st_size > 0:
            return path, dest.stat().st_size, "skip"
        try:
            req = urllib.request.Request(
                url + "/storage/v1/object/sign/" + BUCKET + "/" + path,
                data=json.dumps({"expiresIn": 3600}).encode(),
                headers=dict(H, **{"Content-Type": "application/json"}), method="POST")
            signed = json.load(urllib.request.urlopen(req, timeout=90))["signedURL"]
            blob = urllib.request.urlopen(url + "/storage/v1" + signed, timeout=180).read()
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(blob)
            return path, len(blob), "ok"
        except Exception as e:
            return path, 0, "fail:" + str(e)[:60]

    done = failed = skipped = 0
    total_bytes = 0
    errors = []
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for n, (path, size, how) in enumerate(ex.map(fetch, paths), 1):
            if how == "ok":
                done += 1; total_bytes += size
            elif how == "skip":
                skipped += 1; total_bytes += size
            else:
                failed += 1
                if len(errors) < 10:
                    errors.append({"path": path, "error": how})
            if n % 500 == 0:
                print(f"  {n}/{len(paths)}  ok={done} skip={skipped} fail={failed}")
                crops_vol.commit()

    # The manifest is what makes the archive usable on its own: labels and
    # statuses live in Postgres, and an archive that cannot be read back
    # without the database is not really a backup.
    manifest = pathlib.Path(MOUNT) / "manifest.json"
    manifest.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    crops_vol.commit()

    return {"rows": len(rows), "images": len(paths), "copied": done,
            "already_there": skipped, "failed": failed,
            "megabytes": round(total_bytes / 1024 / 1024, 1), "errors": errors}


@app.function(image=image, volumes={MOUNT: crops_vol},
              secrets=[modal.Secret.from_name("claude-orchestrator-secrets")],
              timeout=3600)
def verify_all() -> dict:
    """Confirm every image is on the volume and non-empty. Run before purging."""
    import pathlib
    rows  = _rows()
    paths = _paths(rows)
    missing, empty = [], []
    total = 0
    for p in paths:
        f = pathlib.Path(MOUNT) / p
        if not f.exists():
            missing.append(p)
        elif f.stat().st_size == 0:
            empty.append(p)
        else:
            total += f.stat().st_size
    ok = not missing and not empty
    return {"images_expected": len(paths), "present": len(paths) - len(missing) - len(empty),
            "missing": len(missing), "empty": len(empty),
            "megabytes": round(total / 1024 / 1024, 1),
            "SAFE_TO_PURGE": ok,
            "sample_missing": missing[:10]}


@app.function(image=image, volumes={MOUNT: crops_vol},
              secrets=[modal.Secret.from_name("claude-orchestrator-secrets")],
              timeout=10800)
def purge_supabase(confirm: str = "") -> dict:
    """
    Delete the images from Supabase Storage. Refuses unless verify passes.

    Requires confirm="DELETE" so this cannot run by accident — it removes the
    only copy that is not on the volume.
    """
    import json, pathlib, urllib.request
    if confirm != "DELETE":
        return {"error": 'refused — call with confirm="DELETE"'}

    v = verify_all.local()
    if not v["SAFE_TO_PURGE"]:
        return {"error": "refused — archive incomplete", "verify": v}

    url, key = _env()
    H = {"apikey": key, "Authorization": "Bearer " + key,
         "Content-Type": "application/json"}
    paths = _paths(_rows())
    removed = 0
    for i in range(0, len(paths), 100):
        chunk = paths[i:i + 100]
        req = urllib.request.Request(
            url + "/storage/v1/object/" + BUCKET,
            data=json.dumps({"prefixes": chunk}).encode(),
            headers=H, method="DELETE")
        try:
            urllib.request.urlopen(req, timeout=180)
            removed += len(chunk)
            print(f"  removed {removed}/{len(paths)}")
        except Exception as e:
            return {"error": str(e)[:120], "removed": removed}
    return {"removed": removed, "archive_megabytes": v["megabytes"]}


@app.local_entrypoint()
def archive(limit: int = 0):
    r = archive_all.remote(limit)
    print("\n  rows          ", r["rows"])
    print("  images        ", r["images"])
    print("  copied        ", r["copied"])
    print("  already there ", r["already_there"])
    print("  failed        ", r["failed"])
    print("  size          ", r["megabytes"], "MB")
    for e in r["errors"]:
        print("   ", e)


@app.local_entrypoint()
def verify():
    r = verify_all.remote()
    for k, v in r.items():
        print(f"  {k:18} {v}")


@app.function(image=image, volumes={MOUNT: crops_vol},
              secrets=[modal.Secret.from_name("claude-orchestrator-secrets")],
              timeout=10800)
def purge_selective(confirm: str = "", dry_run: bool = True) -> dict:
    """
    Free Supabase without breaking the trainer queue.

    Deletes:
      - every context image  (the editor's wide view; regenerable from the
        original document, and only that editor ever reads it)
      - the tight crop of every APPROVED row (training is done with these, and
        they are archived twice over)

    Keeps:
      - the tight crop of every pending/verified row, so a trainer resuming the
        queue still sees the image they are labelling

    Refuses unless the archive verifies complete.
    """
    import json, urllib.request

    v = verify_all.local()
    if not v["SAFE_TO_PURGE"]:
        return {"error": "refused — archive incomplete", "verify": v}

    rows = _rows()
    doomed, kept = [], []
    for r in rows:
        if r.get("context_path"):
            doomed.append(r["context_path"])
        if r.get("crop_path"):
            (doomed if r.get("status") == "approved" else kept).append(r["crop_path"])
    doomed = list(dict.fromkeys(doomed))

    if dry_run or confirm != "DELETE":
        return {"would_delete": len(doomed), "would_keep": len(kept),
                "dry_run": True, "sample": doomed[:3]}

    url, key = _env()
    H = {"apikey": key, "Authorization": "Bearer " + key,
         "Content-Type": "application/json"}
    removed = 0
    for i in range(0, len(doomed), 100):
        chunk = doomed[i:i + 100]
        req = urllib.request.Request(url + "/storage/v1/object/" + BUCKET,
                                     data=json.dumps({"prefixes": chunk}).encode(),
                                     headers=H, method="DELETE")
        try:
            urllib.request.urlopen(req, timeout=180)
            removed += len(chunk)
            if removed % 2000 < 100:
                print(f"  removed {removed}/{len(doomed)}")
        except Exception as e:
            return {"error": str(e)[:120], "removed": removed}
    return {"removed": removed, "kept": len(kept)}


@app.local_entrypoint()
def purge():
    print(purge_supabase.remote("DELETE"))


@app.local_entrypoint()
def plan():
    r = purge_selective.remote("", True)
    for k, v in r.items():
        print(f"  {k:16} {v}")


@app.local_entrypoint()
def clean():
    print(purge_selective.remote("DELETE", False))
