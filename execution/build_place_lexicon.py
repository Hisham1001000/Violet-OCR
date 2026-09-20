# -*- coding: utf-8 -*-
"""
execution/build_place_lexicon.py — derive the Gaza place vocabulary from data
already in the database, so misread place cells can be matched back to a real
name.

Why a lexicon rather than a model: place columns hold 1,432 cells across 414
distinct spellings, but the real vocabulary is a few dozen governorates and
neighbourhoods -- the top 30 values already cover 67% of every cell. Names are
the opposite (8,364 cells, 7,777 distinct) which is why they need the adapters.
A closed vocabulary is a dictionary problem, and 1,432 cells is far too thin to
train on anyway.

    python execution/build_place_lexicon.py derive     # write the draft
    python execution/build_place_lexicon.py show       # print it for review
    python execution/build_place_lexicon.py approve    # strict-filter -> live file

`derive` never overwrites an approved lexicon -- it writes the DRAFT path and
leaves approval to a person, because a wrong entry here silently rewrites real
data.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import collections
from difflib import SequenceMatcher

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA_DIR   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DRAFT_PATH = os.path.join(DATA_DIR, "gaza_places_draft.json")
SEED_PATH  = os.path.join(DATA_DIR, "gaza_places_seed.json")
LEXICON_PATH = os.path.join(DATA_DIR, "gaza_places.json")

# Columns that hold a place. Kept deliberately narrow -- a false positive here
# would point the corrector at a column of names.
PLACE_HEADER = re.compile(r"محافظ|تجمع|سكن|خط\s*السير|منطقة|بلدة|مخيم|عنوان|address|^من$|^إلى$|^الى$")

_DIACRITICS = re.compile(r"[ً-ٰٟ]")


def norm(s: str) -> str:
    """Fold the spelling differences that are never meaningful in a place name."""
    s = _DIACRITICS.sub("", str(s or ""))
    s = re.sub(r"[أإآٱ]", "ا", s)
    s = re.sub(r"[يىئ]", "ي", s)
    s = s.replace("ة", "ه").replace("ؤ", "و")
    s = re.sub(r"[^\w\s؀-ۿ]", " ", s)
    return " ".join(s.split())


def is_plausible_place(v: str) -> bool:
    """Reject the OCR junk before it can become a lexicon entry."""
    v = str(v or "").strip()
    if len(v) < 3:
        return False
    if re.search(r"[A-Za-z]", v):          # N, M, Yours, FOR ...
        return False
    letters = re.findall(r"[؀-ۿ]", v)
    if len(letters) < 3:                   # "1", "2 موافق", "~", "/"
        return False
    if re.search(r"\d", v):
        return False
    return True


def load_seed() -> list:
    """Real place names, from data so they can be edited without touching code."""
    try:
        return json.load(io.open(SEED_PATH, encoding="utf-8")).get("places") or []
    except Exception:
        return []


def attach_to_seed(value: str, seed: list, threshold: float = 0.72):
    """
    The seed place this spelling is a reading of, or None.

    Clustering on frequency alone was not safe: it made a mangled "dir al-balah"
    into a canonical entry of its own, and split three different misreadings of
    "khan yunis" into three clusters. A common misreading would then be written
    back over a correct value.

    Anchoring to names known to exist means the worst case is a spelling that
    matches nothing and is left exactly as Azure read it.
    """
    n = norm(value)
    best, score = None, 0.0
    for place in seed:
        r = SequenceMatcher(None, n, norm(place)).ratio()
        if r > score:
            best, score = place, r
    return (best, score) if score >= threshold else (None, score)


def cluster(values: collections.Counter, threshold: float = 0.82) -> list:
    """
    Group spellings of the same place, most frequent spelling wins.

    Frequency decides the canonical form because the correct reading is the one
    Azure lands on most often -- "خانيونس" 36 times against "خانونى" 6.
    """
    out: list = []
    for value, count in values.most_common():
        n = norm(value)
        for entry in out:
            if SequenceMatcher(None, n, entry["_norm"]).ratio() >= threshold:
                entry["variants"][value] = count
                entry["count"] += count
                break
        else:
            out.append({"canonical": value, "_norm": n, "count": count,
                        "variants": {value: count}})
    return out


def derive() -> dict:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=".env")
    from supabase import create_client

    sb = create_client(os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"),
                       os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    rows, page = [], 0
    while True:
        r = (sb.table("document_jobs").select("structured_data")
             .eq("status", "completed").range(page * 500, page * 500 + 499).execute())
        if not r.data:
            break
        rows += r.data
        page += 1
        if page > 20:
            break

    raw = collections.Counter()
    rejected = collections.Counter()
    for j in rows:
        for p in (j.get("structured_data") or []):
            for k, v in (p or {}).items():
                if k.startswith("_") or not PLACE_HEADER.search(k):
                    continue
                v = str(v or "").strip()
                if not v:
                    continue
                (raw if is_plausible_place(v) else rejected)[v] += 1

    # Anchor to known places first; cluster only what is left over.
    seed = load_seed()
    anchored: dict = {}
    leftover = collections.Counter()
    for value, count in raw.items():
        place, _score = attach_to_seed(value, seed)
        if place:
            e = anchored.setdefault(place, {"canonical": place, "count": 0,
                                            "variants": {}, "seeded": True})
            e["count"] += count
            e["variants"][value] = count
        else:
            leftover[value] = count

    clusters = cluster(leftover)
    for c in clusters:
        c.pop("_norm", None)
        c["seeded"] = False
    clusters = sorted(anchored.values(), key=lambda c: -c["count"]) + clusters
    draft = {
        "_note": ("Derived from completed jobs. REVIEW BEFORE USE -- a wrong "
                  "canonical here silently rewrites real data. seeded=true "
                  "entries are anchored to a known place in "
                  "gaza_places_seed.json and are the safe ones. seeded=false "
                  "matched no known place: either add the real name to the seed "
                  "file, or leave it out so those cells stay as Azure read them."),
        "_cells_seen": sum(raw.values()),
        "_junk_rejected": sum(rejected.values()),
        "places": clusters,
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    json.dump(draft, io.open(DRAFT_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    return draft


# A variant has to look this much like its canonical to be trusted. Higher than
# the 0.72 used to ATTACH a spelling during derivation, because that step only
# proposes and this one is what silently rewrites cells.
APPROVE_MIN = 0.80
# The differing word has to stand on its own too. A shared prefix inflates
# whole-string similarity enough to carry a different word through behind it:
# "الوسطى الأولية" cleared APPROVE_MIN against "الوسطى الزوايدة" on the
# "الوسطى ال" they share, and would have been stored as a known spelling of it.
LAST_TOKEN_MIN = 0.70


def _last_token_agrees(a: str, b: str) -> bool:
    ta, tb = a.split(), b.split()
    if len(ta) < 2 or len(tb) < 2:
        return True
    return SequenceMatcher(None, ta[-1], tb[-1]).ratio() >= LAST_TOKEN_MIN


def approve() -> dict:
    """
    Turn the reviewed draft into the live lexicon, keeping only what is safe.

    Two rules, both erring towards doing nothing:

      * entries that matched no real place are dropped entirely -- they are the
        ones with no anchor, so there is nothing to be confident about
      * a variant must look at least APPROVE_MIN like its canonical

    Dropping a genuine variant costs nothing: that cell stays exactly as Azure
    read it, which is the behaviour before any of this existed. Keeping a wrong
    one corrupts a correct value. The trade is not symmetric, so the filter is
    not either. It threw out "دير البلح <- محمد البلح" (a person's name from a
    misaligned cell), "بالميرا <- بالخير" and "الزيتون <- العيون".
    """
    draft = json.load(io.open(DRAFT_PATH, encoding="utf-8"))
    kept, dropped_entries, dropped_variants = [], 0, 0
    for entry in draft.get("places") or []:
        if not entry.get("seeded"):
            dropped_entries += 1
            continue
        canonical = entry["canonical"]
        variants = {}
        for v, n in (entry.get("variants") or {}).items():
            if norm(v) == norm(canonical):
                variants[v] = n            # a spelling difference only
            elif (SequenceMatcher(None, norm(v), norm(canonical)).ratio() >= APPROVE_MIN
                  and _last_token_agrees(norm(v), norm(canonical))):
                variants[v] = n
            else:
                dropped_variants += n
        kept.append({"canonical": canonical, "count": sum(variants.values()),
                     "variants": variants})
    out = {
        "_note": ("Approved place lexicon. Generated by build_place_lexicon.py "
                  "approve from the reviewed draft; edit by hand freely. "
                  "execution/place_lexicon.py reads THIS file and corrects only "
                  "what it is confident about."),
        "_approve_min": APPROVE_MIN,
        "places": sorted(kept, key=lambda c: -c["count"]),
    }
    json.dump(out, io.open(LEXICON_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    out["_dropped_entries"] = dropped_entries
    out["_dropped_variant_cells"] = dropped_variants
    return out


def show(path: str = None) -> None:
    p = path or (LEXICON_PATH if os.path.exists(LEXICON_PATH) else DRAFT_PATH)
    d = json.load(io.open(p, encoding="utf-8"))
    if d.get("_cells_seen") is not None:
        print(f"{os.path.basename(p)}: {d['_cells_seen']} cells, "
              f"{d['_junk_rejected']} junk rejected, {len(d['places'])} places")
        print()
    else:
        # The approved file carries no cell census, only what it covers.
        covered = sum(c.get("count", 0) for c in d["places"])
        print(f"{os.path.basename(p)}: APPROVED, {len(d['places'])} places, "
              f"{covered} cells covered")
        print()
    for c in d["places"]:
        variants = [v for v in c["variants"] if v != c["canonical"]]
        extra = ("   <- " + ", ".join(variants[:4])) if variants else ""
        # The approved file has no `seeded` flag - everything in it is anchored,
        # so a "?" there would flag exactly the entries that are safe.
        mark = " ? " if c.get("seeded") is False else "   "
        print(f"{mark}{c['count']:5d}  {c['canonical'][:28]:30s}{extra}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "approve":
        d = approve()
        cells = sum(c["count"] for c in d["places"])
        print(f"wrote {LEXICON_PATH}")
        print(f"{len(d['places'])} places, {cells} cells covered")
        print(f"dropped {d['_dropped_entries']} unanchored entries and "
              f"{d['_dropped_variant_cells']} cells on doubtful variants")
    elif cmd == "derive":
        d = derive()
        print(f"wrote {DRAFT_PATH}")
        print(f"{d['_cells_seen']} place cells, {d['_junk_rejected']} junk rejected, "
              f"{len(d['places'])} distinct places")
    else:
        show()
