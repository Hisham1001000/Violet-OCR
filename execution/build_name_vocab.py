"""
build_name_vocab.py — rebuild the name vocabulary from approved training labels.

The generic Arabic name lists that used to live in execution/data/ covered only
71% of the words real trainers type; labels from training_dataset cover 92.7%.
Measured on the frozen 400 held-out names, 2026-08-24.

Run after each training cycle:
    python execution/build_name_vocab.py            # write the file
    python execution/build_name_vocab.py --dry-run  # just report

Output: execution/data/arabic_names_training.json (a flat list of words).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from execution.ocr_voter import normalize_arabic  # noqa: E402

OUT = Path(__file__).parent / "data" / "arabic_names_training.json"
MIN_LEN = 2


def _env() -> dict:
    env = {}
    p = Path(__file__).parent.parent / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    env.setdefault("NEXT_PUBLIC_SUPABASE_URL", os.getenv("NEXT_PUBLIC_SUPABASE_URL", ""))
    env.setdefault("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    return env


def tokens(s: str) -> list[str]:
    """Split a label into normalised words, matching ocr_voter's vocab loader."""
    return [t for t in normalize_arabic(str(s or "")).split() if len(t) >= MIN_LEN]


def fetch_labels(url: str, key: str) -> list[str]:
    """All approved training labels, paginated past PostgREST's 1000-row cap."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    out: list[str] = []
    offset = 0
    while True:
        q = (f"{url}/rest/v1/training_dataset?select=label&status=eq.approved"
             f"&limit=1000&offset={offset}")
        req = urllib.request.Request(q, headers=headers)
        with urllib.request.urlopen(req, timeout=90) as r:
            batch = json.load(r)
        out += [b["label"] for b in batch if b.get("label")]
        if len(batch) < 1000:
            return out
        offset += 1000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    args = ap.parse_args()

    env = _env()
    url, key = env.get("NEXT_PUBLIC_SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        sys.exit("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")

    labels = fetch_labels(url, key)
    vocab: set[str] = set()
    for l in labels:
        vocab.update(tokens(l))
    words = sorted(vocab)

    previous = set(json.loads(OUT.read_text(encoding="utf-8"))) if OUT.exists() else set()
    print(f"  approved labels   {len(labels):>7,}")
    print(f"  distinct words    {len(words):>7,}")
    if previous:
        print(f"  previously        {len(previous):>7,}   (+{len(vocab - previous)} new)")

    if args.dry_run:
        print("  --dry-run: nothing written")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(words, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"  wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
