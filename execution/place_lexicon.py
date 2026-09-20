# -*- coding: utf-8 -*-
"""
execution/place_lexicon.py — correct a misread place name against a known list.

Place columns are a closed vocabulary: 1,053 usable cells across the corpus
resolve to about two dozen real Gaza places, and the top few cover most of them.
Names are the opposite -- 8,364 cells, 7,777 distinct -- which is why they need
the adapters and this does not.

The gate here is deliberately tighter than the one build_place_lexicon.py uses
to DERIVE the list. Deriving is a person's review step; correcting is automatic
and silent, so it only fires when the answer is not in doubt:

  * a value already equal to a canonical name is never touched
  * a spelling seen before is mapped to its canonical
  * anything else must clear a high similarity AND beat the runner-up by a
    clear margin, so a cell that sits between two real places is left alone

Everything else is returned exactly as it came in. A place left as Azure read it
is a cell someone can fix; a place quietly rewritten to the wrong village is not.
"""
from __future__ import annotations

import io
import json
import os
import re
from difflib import SequenceMatcher

DATA_DIR     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LEXICON_PATH = os.path.join(DATA_DIR, "gaza_places.json")

# Only fire on columns that hold a place.
PLACE_HEADER = re.compile(r"محافظ|تجمع|سكن|خط\s*السير|منطقة|بلدة|مخيم|عنوان|address|^من$|^إلى$|^الى$")

MIN_SIMILARITY = 0.86   # how close a spelling must be to a real place
MIN_MARGIN     = 0.06   # how much better than the second-best it must be
MIN_LAST_TOKEN = 0.70   # and its final word must stand on its own
MIN_TOKEN      = 0.82   # a single word inside a longer address

_DIACRITICS = re.compile(r"[ً-ْٰ]")
_cache: dict | None = None


def norm(s: str) -> str:
    s = _DIACRITICS.sub("", str(s or ""))
    s = re.sub(r"[أإآٱ]", "ا", s)   # alef variants
    s = re.sub(r"[يىئ]", "ي", s)         # yeh variants
    s = s.replace("ة", "ه").replace("ؤ", "و")
    s = re.sub(r"[^\w\s؀-ۿ]", " ", s)
    return " ".join(s.split())


def load(path: str | None = None) -> dict:
    """
    {canonical: {"canonical": str, "variants": {spelling: canonical}}}

    Returns an empty lexicon when the approved file is absent -- the draft is
    NOT read here on purpose. An unreviewed list must never correct live data.
    """
    global _cache
    if _cache is not None and path is None:
        return _cache
    p = path or LEXICON_PATH
    lex: dict = {"canonical": [], "variants": {}}
    try:
        d = json.load(io.open(p, encoding="utf-8"))
        for entry in d.get("places") or []:
            c = entry.get("canonical")
            if not c:
                continue
            lex["canonical"].append(c)
            for v in (entry.get("variants") or {}):
                if norm(v) != norm(c):
                    lex["variants"][norm(v)] = c
    except FileNotFoundError:
        pass
    except Exception:
        pass
    if path is None:
        _cache = lex
    return lex


def correct(value: str, lex: dict | None = None):
    """
    Returns (value_out, canonical_or_None).

    canonical is None when nothing was changed, so a caller can tell a
    correction from a pass-through without comparing strings.
    """
    lex = lex if lex is not None else load()
    raw = str(value or "").strip()
    if not raw or not lex["canonical"]:
        return raw, None

    n = norm(raw)
    # Already a real place -- but write back the canonical SPELLING. norm()
    # folds ya/alef-maqsura and ta-marbuta/ha, so "الوسطي" and "الوسطى" are the
    # same place spelled two ways. Returning the raw form would leave the sheet
    # holding both, which is the noise this is meant to remove.
    for c in lex["canonical"]:
        if n == norm(c):
            return (raw, None) if raw == c else (c, c)
    # A spelling already seen and reviewed.
    if n in lex["variants"]:
        return lex["variants"][n], lex["variants"][n]

    # A compound address -- "غزة - النصر", "الرمال الشمالى" -- never equals a
    # single canonical place, so whole-cell matching leaves every one of them
    # alone. Correcting it WORD by word does reach them: عزة -> غزة, النص ->
    # النصر, while the rest of the address is left exactly as written.
    #
    # The bar per word is higher than for a whole cell (MIN_TOKEN), because a
    # short word hits a high similarity by accident far more easily than a long
    # phrase does, and a word here sits inside real data rather than replacing
    # all of it.
    words = raw.split()
    if len(words) > 1:
        vocab = {norm(c): c for c in lex["canonical"]}
        for w in lex["variants"]:
            vocab.setdefault(w, lex["variants"][w])
        out, changed = [], False
        for w in words:
            wn = norm(w)
            if len(wn) < 3 or wn in vocab:
                out.append(vocab.get(wn, w) if wn in vocab else w)
                changed = changed or (wn in vocab and vocab[wn] != w)
                continue
            best, score = None, 0.0
            for cand_n, cand in vocab.items():
                if abs(len(cand_n) - len(wn)) > 2:
                    continue
                r = SequenceMatcher(None, wn, cand_n).ratio()
                if r > score:
                    best, score = cand, r
            if best and score >= MIN_TOKEN:
                out.append(best); changed = True
            else:
                out.append(w)
        if changed:
            joined = " ".join(out)
            return joined, joined

    scored = sorted(
        ((SequenceMatcher(None, n, norm(c)).ratio(), c) for c in lex["canonical"]),
        reverse=True)
    best, best_c = scored[0]
    runner = scored[1][0] if len(scored) > 1 else 0.0
    if best >= MIN_SIMILARITY and (best - runner) >= MIN_MARGIN             and _last_token_agrees(n, norm(best_c)):
        return best_c, best_c
    return raw, None


def _last_token_agrees(a: str, b: str) -> bool:
    """
    The final word has to match too, not just the string as a whole.

    A shared prefix inflates whole-string similarity enough to drag a different
    word through behind it: "الوسطى الأولية" scored above the threshold against
    "الوسطى الزوايدة" purely on the "الوسطى ال" they have in common, and would
    have rewritten one place as another. Comparing the tails separately stops
    the prefix paying for them.
    """
    ta, tb = a.split(), b.split()
    if len(ta) < 2 or len(tb) < 2:
        return True
    return SequenceMatcher(None, ta[-1], tb[-1]).ratio() >= MIN_LAST_TOKEN


def correct_rows(rows: list, lex: dict | None = None) -> dict:
    """
    Fix place cells across structured_data, in place.

    Returns {"changed": n, "changes": [...]} so the caller can log and trace it
    rather than the correction being invisible.
    """
    lex = lex if lex is not None else load()
    stats: dict = {"changed": 0, "changes": []}
    if not lex["canonical"]:
        return stats
    for i, row in enumerate(rows or []):
        for col in list((row or {}).keys()):
            if col.startswith("_") or not PLACE_HEADER.search(col):
                continue
            before = row.get(col)
            after, canonical = correct(before, lex)
            if canonical and after != before:
                row[col] = after
                stats["changed"] += 1
                stats["changes"].append({"row": i, "field": col,
                                         "before": before, "after": after})
    return stats
