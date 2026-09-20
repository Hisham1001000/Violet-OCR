"""
execution/grow_name_dict.py

Grows the Arabic name dictionaries from user corrections.

Source: field_corrections table (every cell edit a user makes in the review UI).
Target: arabic_names.json  (given names)
        arabic_family_names.json (family / tribal names)
Staging: name_candidates table (Supabase) — names sit here until promoted.

──────────────────────────────────────────────────────────────
Two-command workflow
──────────────────────────────────────────────────────────────

  python execution/grow_name_dict.py collect
      Scans all field_corrections rows, extracts name tokens,
      validates them, and upserts into name_candidates.
      Safe to run repeatedly — idempotent.

  python execution/grow_name_dict.py promote
      Writes every accepted name_candidate to the correct JSON file,
      marks the row as promoted=true, and clears the in-memory cache
      in merge_ocr_outputs.py so the next document sees the new names.

  python execution/grow_name_dict.py status
      Prints a summary: pending / accepted / rejected counts,
      top candidates by occurrence.

  python execution/grow_name_dict.py reject <name>
      Rejects a specific candidate by its exact name string.

──────────────────────────────────────────────────────────────
Validation gates (for user corrections, not raw OCR output)
──────────────────────────────────────────────────────────────

Gate 1 — Format
  • Single token (no spaces) — multi-word family names allowed
  • 2–20 Arabic characters
  • > 70 % Arabic chars
  • No Persian / Urdu chars (ی ک ہ ے) — these are OCR errors
  • Not a known non-name word (رقم، هاتف، لا، نعم…)

Gate 2 — Deduplication
  • Exact match on normalised form already in JSON dict → skip
  • Near-match (edit distance < 0.20 of existing JSON entry) → route to
    ocr_corrections instead (it is an OCR variant, not a new name)

Gate 3 — Auto-accept
  User corrections are ground-truth, so the threshold is intentionally low:
  • occurrences >= AUTO_ACCEPT_THRESHOLD (default 1) → status = 'accepted'
  • Otherwise                                         → status = 'pending'

──────────────────────────────────────────────────────────────
Token classification from a full corrected name
──────────────────────────────────────────────────────────────
  "هدى سامي محمد المصري"
   ^    ^     ^      ^
   |    |     |      last token → family name
   |____|_____|_____ all other tokens → given name
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path

# ── setup ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[GrowDict] %(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

_DATA_DIR          = Path(__file__).parent / "data"
# The generic Arabic name lists (male/female/family) were retired 2026-08-24:
# measured on the frozen 400 held-out names they covered only 71.0% of the words
# trainers actually type, versus 92.7% for a vocabulary built from our own
# approved training labels — at a third of the size.  They live in data/_archive/.
_TRAINING_JSON     = _DATA_DIR / "arabic_names_training.json"  # rebuilt by build_name_vocab.py
_LEARNED_JSON      = _DATA_DIR / "arabic_names_learned.json"   # auto-written from corrections

AUTO_ACCEPT_THRESHOLD = 1   # corrections are ground-truth → accept after 1 occurrence

# ── non-name vocabulary (single tokens that should never appear in a name cell) ─
_NON_NAME = frozenset({
    "اسم", "رقم", "هاتف", "جوال", "تاريخ", "ميلاد", "جنس", "ذكر", "أنثى", "انثى",
    "نعم", "لا", "موافق", "غير", "العمر", "المشارك", "المستفيد", "الاسم",
    "رباعي", "ثلاثي", "عنوان", "ملاحظة", "ملاحظات", "مبلغ", "كمية", "عدد",
    "تسلسل", "المسلسل", "الرقم", "#",
})

# ── Persian / Urdu characters that must not appear in Arabic names ─────────────
_PERSIAN_CHARS = frozenset("یکہے")

# ── Arabic character block ─────────────────────────────────────────────────────
_ARABIC_RE   = re.compile(r"[\u0600-\u06FF]")
_HARAKAT_RE  = re.compile(r"[\u064B-\u065F\u0670]")
_ALEF_MAP    = str.maketrans("أإآٱ", "اااا")


# ── helpers ────────────────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    """Strip diacritics and normalise alef variants — same as merge_ocr_outputs._norm."""
    return _HARAKAT_RE.sub("", s).translate(_ALEF_MAP).strip()


def _arabic_ratio(s: str) -> float:
    ar = sum(1 for c in s if "\u0600" <= c <= "\u06FF")
    return ar / max(len(s), 1)


def _load_json(path: Path) -> list[str]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: Path, names: list[str]) -> None:
    """Write sorted, deduplicated name list back to JSON."""
    unique = sorted(set(names))
    with path.open("w", encoding="utf-8") as f:
        json.dump(unique, f, ensure_ascii=False, indent=2)
    logger.info(f"Saved {len(unique):,} entries → {path.name}")


# ── name-field detection ───────────────────────────────────────────────────────
_NAME_FIELD_RE = re.compile(
    r"اسم|name|المشارك|المستفيد|الموظف|الطالب|رباعي|ثلاثي", re.I
)

def _is_name_field(field_name: str) -> bool:
    return bool(_NAME_FIELD_RE.search(field_name or ""))


# ── validation ─────────────────────────────────────────────────────────────────

def _validate_token(token: str) -> tuple[bool, str]:
    """
    Gate 1: Format validation for a single name token.
    Returns (ok, reason).
    """
    t = token.strip()
    if not t:
        return False, "empty"
    if len(t) < 2 or len(t) > 20:
        return False, f"length {len(t)} out of range [2,20]"
    if _arabic_ratio(t) < 0.70:
        return False, "less than 70% Arabic characters"
    if any(c in _PERSIAN_CHARS for c in t):
        return False, "contains Persian/Urdu character"
    if _norm(t) in {_norm(w) for w in _NON_NAME}:
        return False, "known non-name vocabulary word"
    return True, "ok"


def _token_edit_dist(s1: str, s2: str) -> float:
    """Simple normalised edit distance [0,1] on normalised forms."""
    a, b = _norm(s1), _norm(s2)
    n, m = len(a), len(b)
    if n == 0 and m == 0:
        return 0.0
    if n == 0:
        return 1.0
    if m == 0:
        return 1.0
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        curr = [i] + [0] * m
        for j in range(1, m + 1):
            curr[j] = min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1),
            )
        prev = curr
    return prev[m] / max(n, m)


def _find_near_match(
    norm_token: str,
    existing_norms: list[str],
    threshold: float = 0.20,
) -> str | None:
    """Return the nearest existing normalised entry if within threshold, else None."""
    best_dist  = threshold + 1
    best_entry = None
    for e in existing_norms:
        d = _token_edit_dist(norm_token, e)
        if d < best_dist:
            best_dist  = d
            best_entry = e
    return best_entry if best_dist <= threshold else None


# ── token extraction from a full corrected name ────────────────────────────────

def _extract_tokens(corrected_value: str) -> list[tuple[str, str]]:
    """
    Tokenise a corrected name value and classify each token.
    Returns list of (token, name_type) where name_type ∈ {'given', 'family'}.

    Rules:
      • Single token  → ambiguous; treat as 'given' (cannot confirm family)
      • 2+ tokens     → last token is 'family', all others are 'given'
    """
    tokens = corrected_value.strip().split()
    if not tokens:
        return []
    if len(tokens) == 1:
        return [(tokens[0], "given")]
    return [(t, "family" if i == len(tokens) - 1 else "given")
            for i, t in enumerate(tokens)]


# ── training_dataset as a second source ────────────────────────────────────────
# The trainer UI writes verified names straight to training_dataset.label and
# never touched the vocabulary, so thousands of real names stayed invisible to
# the dictionary.  A watermark in system_settings keeps this incremental: the
# expensive full scan happens once, then only newly-reviewed rows are fetched.
_WATERMARK_KEY   = "name_vocab_training_watermark"
_TRAINING_FIELD  = "الاسم الرباعي"   # passes _is_name_field


def _training_rows(supabase) -> tuple[list[dict], str | None]:
    """Approved training labels, shaped like field_corrections rows."""
    try:
        wm = (supabase.table("system_settings").select("value")
              .eq("key", _WATERMARK_KEY).execute().data)
        since = ((wm[0].get("value") or {}).get("reviewed_at")) if wm else None
    except Exception as e:
        logger.warning(f"watermark read failed, doing a full scan: {e}")
        since = None

    rows: list[dict] = []
    newest = since
    offset = 0
    while True:
        q = (supabase.table("training_dataset")
             .select("job_id, label, reviewed_at")
             .eq("status", "approved"))
        if since:
            q = q.gt("reviewed_at", since)
        batch = q.order("reviewed_at", desc=False).range(offset, offset + 999).execute().data or []
        for b in batch:
            label = (b.get("label") or "").strip()
            if not label:
                continue
            rows.append({"job_id": b.get("job_id") or "",
                         "field_name": _TRAINING_FIELD,
                         "corrected_value": label})
            ra = b.get("reviewed_at")
            if ra and (newest is None or ra > newest):
                newest = ra
        if len(batch) < 1000:
            break
        offset += 1000

    logger.info(f"training_dataset rows fetched: {len(rows)} (since={since})")
    return rows, newest


def _save_watermark(supabase, reviewed_at: str | None) -> None:
    if not reviewed_at:
        return
    try:
        supabase.table("system_settings").upsert({
            "key": _WATERMARK_KEY,
            "value": {"reviewed_at": reviewed_at},
            "description": "High-water mark for training_dataset -> name vocabulary",
        }, on_conflict="key").execute()
    except Exception as e:
        logger.warning(f"watermark write failed (next run rescans): {e}")


# ── main collect function ──────────────────────────────────────────────────────

def collect(supabase) -> dict:
    """
    Scan field_corrections for name-field corrections and upsert into
    name_candidates.

    Returns stats dict: {processed, validated, skipped_dup, inserted, updated}.
    """
    # Load existing JSON dictionaries for dedup/near-match checks
    # Given names: check against both male and female dicts (user organises them manually)
    # One flat vocabulary now — the training-derived list is not split by gender
    # or given/family, so both gates check the same word set.
    _known       = _load_json(_TRAINING_JSON) + _load_json(_LEARNED_JSON)
    given_list   = _known
    family_list  = _known
    given_norms  = [_norm(n) for n in given_list]
    family_norms = [_norm(n) for n in family_list]

    # Pull all field_corrections (service role — no auth filter needed)
    rows = (
        supabase.table("field_corrections")
        .select("job_id, field_name, corrected_value")
        .execute()
        .data
    )
    logger.info(f"field_corrections rows fetched: {len(rows)}")

    # Second source: names typed by trainers in the training UI.
    _train_rows, _train_watermark = _training_rows(supabase)
    rows = list(rows) + _train_rows

    stats = {"processed": 0, "validated": 0,
             "skipped_dup": 0, "skipped_near": 0,
             "inserted": 0, "updated": 0, "rejected": 0}

    # Pull existing name_candidates for fast dedup
    existing_candidates = (
        supabase.table("name_candidates")
        .select("normalized, name_type, occurrences, job_ids, status")
        .execute()
        .data
    )
    # Build local index: (normalized, name_type) → row
    candidate_index: dict[tuple[str, str], dict] = {
        (_norm(r["normalized"]), r["name_type"]): r
        for r in existing_candidates
    }

    for row in rows:
        if not _is_name_field(row.get("field_name", "")):
            continue
        corrected = (row.get("corrected_value") or "").strip()
        if not corrected:
            continue

        job_id = row.get("job_id", "")
        tokens = _extract_tokens(corrected)

        for token, name_type in tokens:
            stats["processed"] += 1
            ok, reason = _validate_token(token)
            if not ok:
                logger.debug(f"  Rejected '{token}': {reason}")
                stats["rejected"] += 1
                continue

            norm = _norm(token)
            existing_norms = family_norms if name_type == "family" else given_norms

            # Gate 2a: exact match in JSON dict → already known, skip
            if norm in set(existing_norms):
                logger.debug(f"  Skip '{token}' — already in JSON dict")
                stats["skipped_dup"] += 1
                continue

            # Gate 2b: near-match in JSON dict → OCR variant, not a new name
            near = _find_near_match(norm, existing_norms, threshold=0.20)
            if near:
                logger.debug(
                    f"  Skip '{token}' — near-match to existing '{near}' "
                    f"(dist ≤ 0.20); consider adding to ocr_corrections"
                )
                stats["skipped_near"] += 1
                continue

            key = (norm, name_type)
            if key in candidate_index:
                existing = candidate_index[key]
                # Already seen — increment occurrence if new job_id
                existing_jobs = set(existing.get("job_ids") or [])
                if job_id and job_id not in existing_jobs:
                    new_count = existing["occurrences"] + 1
                    new_jobs  = list(existing_jobs | {job_id})
                    new_status = (
                        "accepted" if new_count >= AUTO_ACCEPT_THRESHOLD
                        else existing["status"]
                    )
                    supabase.table("name_candidates").update({
                        "occurrences": new_count,
                        "job_ids":     new_jobs,
                        "last_seen":   "now()",
                        "status":      new_status,
                    }).eq("normalized", norm).eq("name_type", name_type).execute()
                    candidate_index[key]["occurrences"] = new_count
                    candidate_index[key]["status"]      = new_status
                    stats["updated"] += 1
                    logger.info(
                        f"  Updated '{token}' ({name_type}) "
                        f"occurrences={new_count} status={new_status}"
                    )
            else:
                # New candidate — insert
                new_status = "accepted" if AUTO_ACCEPT_THRESHOLD <= 1 else "pending"
                record = {
                    "name":        token,
                    "normalized":  norm,
                    "name_type":   name_type,
                    "occurrences": 1,
                    "job_ids":     [job_id] if job_id else [],
                    "status":      new_status,
                    "promoted":    False,
                }
                supabase.table("name_candidates").insert(record).execute()
                candidate_index[key] = {**record, "status": new_status}
                stats["inserted"] += 1
                logger.info(
                    f"  Inserted '{token}' ({name_type}) status={new_status}"
                )
            stats["validated"] += 1

    logger.info(
        f"Collect done | "
        f"processed={stats['processed']} validated={stats['validated']} "
        f"inserted={stats['inserted']} updated={stats['updated']} "
        f"skipped_dup={stats['skipped_dup']} skipped_near={stats['skipped_near']} "
        f"rejected={stats['rejected']}"
    )
    # Only advance the watermark once the rows above were processed without
    # raising — a crash mid-scan must leave it where it was so nothing is lost.
    _save_watermark(supabase, _train_watermark)
    return stats


# ── promote function ───────────────────────────────────────────────────────────

def promote(supabase, dry_run: bool = False) -> dict:
    """
    Write every accepted, unpromoteed name_candidate to the correct JSON file,
    then mark it as promoted=true in the database.
    Invalidates the in-memory cache in merge_ocr_outputs.py.

    Returns stats dict: {given_added, family_added}.
    """
    # Fetch accepted but not yet promoted
    rows = (
        supabase.table("name_candidates")
        .select("id, name, name_type")
        .eq("status", "accepted")
        .eq("promoted", False)
        .execute()
        .data
    )

    if not rows:
        logger.info("Promote: nothing to promote.")
        return {"given_added": 0, "family_added": 0}

    given_new:  list[str] = []
    family_new: list[str] = []

    for r in rows:
        if r["name_type"] == "family":
            family_new.append(r["name"])
        else:
            given_new.append(r["name"])

    stats = {"given_added": 0, "family_added": 0}

    if given_new:
        if not dry_run:
            # Auto-write to the learned file — no manual gender classification needed.
            # dict_score() loads from this file on every pipeline run.
            existing = _load_json(_LEARNED_JSON)
            merged   = list(set(existing) | set(given_new))
            _save_json(_LEARNED_JSON, merged)
        stats["given_added"] = len(given_new)
        logger.info(
            f"{'[dry-run] ' if dry_run else ''}"
            f"Given names added to arabic_names_learned.json ({len(given_new)}): "
            f"{given_new[:10]}{'…' if len(given_new)>10 else ''}"
        )

    if family_new:
        if not dry_run:
            existing = _load_json(_LEARNED_JSON)
            merged   = list(set(existing) | set(family_new))
            _save_json(_LEARNED_JSON, merged)
        stats["family_added"] = len(family_new)
        logger.info(
            f"{'[dry-run] ' if dry_run else ''}"
            f"Family names to add: {family_new[:10]}{'…' if len(family_new)>10 else ''}"
        )

    if not dry_run:
        # Mark as promoted in DB
        promoted_ids = [r["id"] for r in rows]
        # Supabase doesn't support IN with list via .in_() for all drivers,
        # so batch in chunks of 100
        for i in range(0, len(promoted_ids), 100):
            chunk = promoted_ids[i:i + 100]
            supabase.table("name_candidates").update(
                {"promoted": True}
            ).in_("id", chunk).execute()

        # Invalidate in-memory cache so the next document re-loads the JSON files
        try:
            import execution.merge_ocr_outputs as _mou
            _mou._name_list_cache   = None
            _mou._family_list_cache = None
            logger.info("merge_ocr_outputs name cache cleared.")
        except Exception as _ce:
            logger.warning(f"Cache clear failed (non-fatal): {_ce}")

        # Also clear extract_gemini.py cache
        try:
            import execution.extract_gemini as _eg
            _eg._NAMES_SET         = None
            _eg._NAMES_LIST        = None
            _eg._FAMILY_NAMES_SET  = None
            _eg._FAMILY_NAMES_LIST = None
            logger.info("extract_gemini name cache cleared.")
        except Exception as _ce:
            logger.warning(f"extract_gemini cache clear failed (non-fatal): {_ce}")

        logger.info(
            f"Promote complete | "
            f"given_added={stats['given_added']} family_added={stats['family_added']}"
        )
    else:
        logger.info(
            f"[dry-run] Would add: "
            f"given={stats['given_added']} family={stats['family_added']}"
        )

    return stats


# ── status function ────────────────────────────────────────────────────────────

def status(supabase) -> None:
    rows = (
        supabase.table("name_candidates")
        .select("name, name_type, status, occurrences, promoted")
        .order("occurrences", desc=True)
        .execute()
        .data
    )

    counts = {"pending": 0, "accepted": 0, "rejected": 0}
    not_promoted = []
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r["status"] == "accepted" and not r["promoted"]:
            not_promoted.append(r)

    print(f"\n── name_candidates status ──────────────────")
    print(f"  pending   : {counts['pending']}")
    print(f"  accepted  : {counts['accepted']}  (not yet promoted: {len(not_promoted)})")
    print(f"  rejected  : {counts['rejected']}")
    print(f"  total     : {sum(counts.values())}")

    if not_promoted:
        print(f"\n── Ready to promote ({len(not_promoted)}) ──────────────")
        for r in not_promoted[:20]:
            print(f"  [{r['name_type']:6}]  {r['name']}  (seen {r['occurrences']}x)")
        if len(not_promoted) > 20:
            print(f"  … and {len(not_promoted)-20} more")
    print()


# ── reject function ────────────────────────────────────────────────────────────

def reject(supabase, name: str) -> None:
    norm = _norm(name)
    res = (
        supabase.table("name_candidates")
        .update({"status": "rejected"})
        .eq("normalized", norm)
        .execute()
    )
    logger.info(f"Rejected '{name}' (normalised: '{norm}')")


# ── CLI ────────────────────────────────────────────────────────────────────────

def _get_supabase():
    from dotenv import load_dotenv
    load_dotenv()
    from supabase import create_client
    return create_client(
        os.environ["NEXT_PUBLIC_SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def add_name(name: str, gender: str) -> None:
    """
    Manually add a single name to the male or female dictionary.

    gender must be 'male' or 'female'.
    Silently skips if the name already exists (exact or near-match).
    """
    name = name.strip()
    if not name:
        logger.error("Name cannot be empty.")
        return

    gender = gender.strip().lower()
    if gender not in ("male", "female"):
        logger.error("gender must be 'male' or 'female'.")
        return

    # Gender no longer routes to a file (the gendered lists are archived); it is
    # still accepted so existing CLI usage keeps working.
    target = _LEARNED_JSON
    existing = _load_json(target)
    existing_norms = [_norm(n) for n in existing]

    norm_new = _norm(name)

    if norm_new in set(existing_norms):
        logger.info(f"'{name}' already in {target.name} — skipped.")
        return

    near = _find_near_match(norm_new, existing_norms, threshold=0.15)
    if near:
        # Very close to an existing entry — could be a typo or a genuine variant.
        # Ask the user rather than silently adding.
        answer = input(
            f"  WARNING: '{name}' is very similar to existing '{near}'.\n"
            f"  Add anyway? (y/N): "
        ).strip().lower()
        if answer != "y":
            logger.info("Skipped.")
            return

    merged = sorted(set(existing) | {name})
    _save_json(target, merged)
    logger.info(f"Added '{name}' → {target.name}  (total: {len(merged)})")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Grow the Arabic name dictionaries from user corrections."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("collect", help="Scan field_corrections → name_candidates")

    p_promote = sub.add_parser("promote", help="Write accepted candidates → JSON files")
    p_promote.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be added without writing anything"
    )

    sub.add_parser("status", help="Show pending / accepted / rejected counts")

    p_reject = sub.add_parser("reject", help="Reject a candidate by name")
    p_reject.add_argument("name", help="Exact name string to reject")

    p_add = sub.add_parser("add", help="Manually add a first name to male or female dictionary")
    p_add.add_argument("name",   help="The Arabic name to add (e.g. محمد)")
    p_add.add_argument("gender", help="'male' or 'female'")

    args = parser.parse_args()

    if args.cmd == "add":
        add_name(args.name, args.gender)
        return

    sb = _get_supabase()

    if args.cmd == "collect":
        collect(sb)

    elif args.cmd == "promote":
        promote(sb, dry_run=args.dry_run)

    elif args.cmd == "status":
        status(sb)

    elif args.cmd == "reject":
        reject(sb, args.name)


if __name__ == "__main__":
    main()
