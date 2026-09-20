"""
Tool: extract_gemini
Structures raw Arabic OCR text into participant records using Gemini.

Input:  pipe-separated text from Gemini OCR or Azure Document Intelligence
Output: list of dicts, one per row — keys are the column headers detected
        from the document (dynamic, not a fixed schema)

Gemini is instructed to:
  1. Detect the table headers exactly as they appear in the document
  2. Return a wrapper object with two keys:
       column_order: column names in exact right-to-left document order
       participants: each row as a dict {header: value}
  3. Preserve row order from the original document

Two-layer correction system:
    Layer 1 (pre-processing): ocr_corrections applied before this function
    Layer 2 (few-shot): field_corrections injected into Gemini prompt
"""

import json
import logging
import os
import re
import time
from pathlib import Path

# ── Field type detection ───────────────────────────────────────────────────────
_PHONE_KEY  = re.compile(r'هاتف|تواصل|جوال|موبايل|phone|mobile|tel', re.I)
_DATE_KEY   = re.compile(r'تاريخ|ميلاد|ولاد|date|dob|birth', re.I)
_NAME_KEY   = re.compile(r'اسم|name', re.I)

# Digits only — used for phone/date cleaning
_DIGITS_ONLY = re.compile(r'[^\d]')

logger = logging.getLogger(__name__)

# Arabic-Indic (U+0660–0669) + Extended Arabic-Indic (U+06F0–06F9) → Western digits
_DIGIT_TABLE = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

# Alef variant normalization for column key matching only (does NOT affect displayed values)
# أ/إ/آ/ٱ → ا  so Vision's variant alef forms don't break column header detection
_AR_KEY_NORMALIZE = str.maketrans('أإآٱ', 'اااا')

# Valid phone prefixes — all Palestinian mobile numbers start with 059 or 056
_VALID_PHONE_PREFIXES = frozenset({'059', '056'})

# ── Name suggestion engine ─────────────────────────────────────────────────────
_NAMES_MALE_DICT_PATH    = Path(__file__).parent / "data" / "arabic_names_male.json"
_NAMES_FEMALE_DICT_PATH  = Path(__file__).parent / "data" / "arabic_names_female.json"
_FAMILY_NAMES_DICT_PATH  = Path(__file__).parent / "data" / "arabic_family_names.json"

# Male dict (loaded lazily) — positions 1+ (father / grandfather / family)
_NAMES_MALE_SET: set | None = None
_NAMES_MALE_LIST: list | None = None

# Female dict (loaded lazily) — position 0 (first name, female)
_NAMES_FEMALE_SET: set | None = None
_NAMES_FEMALE_LIST: list | None = None

# Palestinian/Levantine family names dict (loaded lazily) — used for position ≥ 2
_FAMILY_NAMES_SET: set | None = None
_FAMILY_NAMES_LIST: list | None = None

# Strip tashkeel (diacritics) for comparison
_TASHKEEL_RE = re.compile(
    r"[\u0610-\u061A\u064B-\u065F\u0670"
    r"\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]"
)
# Arabic-only token filter (reject digits, Latin etc.)
_ARABIC_TOKEN = re.compile(r"^[\u0600-\u06FF]+$")

# Name prefix connectors — never suggest corrections for these standalone tokens
_NAME_CONNECTORS = frozenset(["ابو", "ام", "بنت", "ابن", "بن"])

# Max edit distance to surface a suggestion.
# Short names (≤5 chars): only allow distance 1  (one OCR misread)
# Longer names (6+ chars): allow distance 2
_SUGGEST_MAX_DIST_SHORT = 1   # for names 2–5 chars
_SUGGEST_MAX_DIST_LONG  = 2   # for names 6+ chars

# Minimum confidence to surface a suggestion.
# Below this threshold, the match is too uncertain and we return None.
# - First name (position 0): 0.70 — smaller token pool, higher signal
# - Father name (position 1): 0.80 — regional names are diverse
# - Family name (position ≥ 2): checked against dedicated family names dict
_SUGGEST_MIN_CONF_FIRST  = 0.65
_SUGGEST_MIN_CONF_FAMILY = 0.80

# Family names: minimum fuzzy confidence to include a candidate in the top-3 list.
# Below this → no candidates → mark needs_review.
_FAMILY_MIN_CONF_CANDIDATE = 0.72

# Family names: minimum confidence to send to Gemini for selection.
# Below this → flagged needs_review (human must decide), not auto-corrected.
_FAMILY_GEMINI_THRESHOLD = 0.75

# Minimum name-token length to bother checking (skip short connectors like ال)
_SUGGEST_MIN_LEN = 3

# ة ↔ ه is a very common OCR confusion — normalize both to ه for matching only
_TAH_NORM = str.maketrans("ة", "ه")

# Common male names — Palestinian/Levantine focus
_MALE_NAMES_SUPPLEMENT = frozenset([
    # First names
    "محمد", "احمد", "علي", "عمر", "خالد", "يوسف", "عبدالله", "ابراهيم",
    "اسماعيل", "مصطفى", "مصطفي", "حسن", "حسين", "كريم", "وليد", "سامي",
    "طارق", "عماد", "رامي", "ايمن", "نادر", "سمير", "جمال", "وائل",
    "ماهر", "نضال", "غسان", "بلال", "يزيد", "صالح", "زياد", "فادي",
    "حمد", "عبد", "ابو", "هاني", "امين", "باسم", "سليم", "سليمان",
    "داود", "موسى", "عيسى", "عبدالرحمن", "عبدالرحيم", "عبدالعزيز",
    "حمزه", "انس", "عمار", "اياد", "عادل", "ناصر", "سعيد", "رائد",
    "فيصل", "تامر", "هشام", "وسام", "اشرف", "شادي", "كمال", "جهاد",
    "راتب", "عاطف", "ربحي", "منير", "معتز", "قاسم", "نائل", "زاهر",
    "مازن", "ماجد", "نزار", "بسام", "ريان", "عمران", "بدر", "عصام",
    "ثائر", "شريف", "رفيق", "فراس", "لؤي", "نبيل", "حسام", "نعيم",
    "اسامه", "معاذ", "لقمان", "عروه", "ثامر", "يامن", "يعقوب", "مؤيد",
    "وصفي", "مصعد", "هيثم", "محمود", "مروان", "رضوان", "عوض", "مجد",
    "ضياء", "لؤي", "مهدي", "صهيب", "يزن", "قاسم", "عمر", "جودت",
    # Palestinian family name roots (common in Gaza / West Bank)
    "شهوان", "عاشور", "النجار", "ابو", "القدرة", "المشالح", "الشوريجي",
    "شهوات", "النحاس", "الوسلية", "الطهراوي", "حمدان", "عمرو", "حلس",
    "ابراهيم", "سلامه", "عاشو", "مرقه", "النظار", "المطورة", "رضوان",
])

# Very common Arabic names that may be absent from the downloaded dict
_COMMON_NAMES_SUPPLEMENT = frozenset([
    "علي", "عمر", "نور", "رنا", "هنا", "حسن", "حسين",
    "رامي", "ليلى", "سمر", "هند", "ربى", "دعاء", "وفاء", "هاله",
    "ولاء", "رلى", "لجين", "شذى", "ندى",
    "سلام", "هبه", "روان", "راما", "لانا", "سنا", "منى", "هيا",
    "رشا", "ريم", "نجوى", "غدير", "اسراء", "اسرار", "امنيه",
    # Palestinian female names
    "ميان","سجود", "هلا", "ملك", "قبول", "يامن",
    "روضه", "ثناء", "انتصار", "احلام", "افراح", "ابتسام",
    "عبد", "ابو",
    # Additional common Palestinian/Levantine female names for OCR recovery
    "سما", "لما", "منه", "منة", "وجد", "سجى", "تالا", "نبال",
    "رغد", "وفاء", "امل", "بتول", "مروة", "شهد", "غزل", "نغم",
    "ديمة", "ريتا", "ميرنا", "كريمه", "كريمة", "سنين", "صفاء",
])

# High-priority names: tiebreaker when multiple candidates share the same edit distance.
# These extremely common names are strongly preferred over rare/obscure matches.
_HIGH_PRIORITY_NAMES = frozenset([
    "محمد", "احمد", "علي", "عمر", "خالد", "يوسف", "عبدالله", "ابراهيم",
    "اسماعيل", "مصطفى", "مصطفي", "حسن", "حسين", "كريم", "وليد", "سامي",
    "طارق", "عماد", "رامي", "ايمن", "نادر", "سمير", "جمال", "وائل",
    "فاطمه", "مريم", "عائشه", "خديجه", "زينب", "سارا", "نور", "ايه",
    "رنا", "هنا", "سمر", "منى", "ريم", "رشا", "هند", "ليلى",
    "نادية", "نادي", "سهام", "ولاء", "دعاء", "هبه", "امل", "سلمى",
    "سلمي", "لما", "روان", "لانا", "سناء", "سنا", "ندى", "لجين",
])


def _load_female_names_dict() -> tuple[set, list]:
    """Load arabic_names_female.json once and cache."""
    global _NAMES_FEMALE_SET, _NAMES_FEMALE_LIST
    if _NAMES_FEMALE_SET is not None:
        return _NAMES_FEMALE_SET, _NAMES_FEMALE_LIST
    if _NAMES_FEMALE_DICT_PATH.exists():
        with open(_NAMES_FEMALE_DICT_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        _NAMES_FEMALE_LIST = sorted({_norm_for_match(n) for n in raw})
        _NAMES_FEMALE_SET = set(_NAMES_FEMALE_LIST)
        logger.info(f"[Names] Loaded {len(_NAMES_FEMALE_SET):,} female names from dictionary")
    else:
        _NAMES_FEMALE_SET = set()
        _NAMES_FEMALE_LIST = []
        logger.warning("[Names] arabic_names_female.json not found")
    return _NAMES_FEMALE_SET, _NAMES_FEMALE_LIST


def _load_male_names_dict() -> tuple[set, list]:
    """
    Load the male-only names dict for position-aware suggestions.
    Used for token positions > 0 (father's / grandfather's / family name)
    which are always male in Arabic naming convention.
    Falls back to _MALE_NAMES_SUPPLEMENT if the file doesn't exist.
    """
    global _NAMES_MALE_SET, _NAMES_MALE_LIST
    if _NAMES_MALE_SET is not None:
        return _NAMES_MALE_SET, _NAMES_MALE_LIST
    if _NAMES_MALE_DICT_PATH.exists():
        with open(_NAMES_MALE_DICT_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        _NAMES_MALE_LIST = sorted({_norm_for_match(n) for n in raw} | {_norm_for_match(n) for n in _MALE_NAMES_SUPPLEMENT})
        _NAMES_MALE_SET = set(_NAMES_MALE_LIST)
        logger.info(f"[Names] Loaded {len(_NAMES_MALE_SET):,} male names from dictionary")
    else:
        _NAMES_MALE_SET = {_norm_for_match(n) for n in _MALE_NAMES_SUPPLEMENT}
        _NAMES_MALE_LIST = sorted(_NAMES_MALE_SET)
        logger.warning(
            "[Names] arabic_names_male.json not found — "
            "run: python execution/build_names_dict.py  (using supplement only)"
        )
    return _NAMES_MALE_SET, _NAMES_MALE_LIST


def _load_family_names_dict() -> tuple[set, list]:
    """
    Load arabic_family_names.json (Palestinian/Levantine family names).
    Used exclusively for token positions ≥ 2 (grandfather / family name).
    Run `python execution/build_family_names_dict.py` to generate the file.
    """
    global _FAMILY_NAMES_SET, _FAMILY_NAMES_LIST
    if _FAMILY_NAMES_SET is not None:
        return _FAMILY_NAMES_SET, _FAMILY_NAMES_LIST
    if _FAMILY_NAMES_DICT_PATH.exists():
        with open(_FAMILY_NAMES_DICT_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        # File already contains normalized names; re-normalize to be safe
        _FAMILY_NAMES_LIST = sorted({_norm_for_match(n) for n in raw if n})
        _FAMILY_NAMES_SET = set(_FAMILY_NAMES_LIST)
        logger.info(f"[Names] Loaded {len(_FAMILY_NAMES_SET):,} family names from dictionary")
    else:
        _FAMILY_NAMES_SET = set()
        _FAMILY_NAMES_LIST = []
        logger.warning(
            "[Names] arabic_family_names.json not found — "
            "run: python execution/build_family_names_dict.py"
        )
    return _FAMILY_NAMES_SET, _FAMILY_NAMES_LIST


def _get_top_candidates(norm_token: str, names_list: list, top_n: int = 3) -> list[dict]:
    """
    Return up to top_n fuzzy-match candidates from names_list for the given token.
    Each result: {"name": str, "confidence": float}
    Only includes candidates with confidence ≥ _FAMILY_MIN_CONF_CANDIDATE.
    Skips candidates whose normalized form equals the token itself.
    """
    if not names_list:
        return []
    try:
        from rapidfuzz.distance import Levenshtein as _Lev
        from rapidfuzz import process as _rfp
    except ImportError:
        return []

    max_len = max(len(norm_token), 1)
    # Allow slightly more slack for longer family names (OCR can drop/swap multiple chars)
    if len(norm_token) <= 5:
        max_dist = 1
    elif len(norm_token) >= 8:
        max_dist = 3
    else:
        max_dist = 2
    dist_cutoff = max_dist / max_len

    raw_candidates = _rfp.extract(
        norm_token,
        names_list,
        scorer=_Lev.normalized_distance,
        score_cutoff=dist_cutoff,
        limit=top_n + 5,
    )

    seen: set[str] = set()
    results = []

    # Primary: standard Levenshtein on normalized tokens
    for name, norm_dist, _ in sorted(raw_candidates, key=lambda x: x[1]):
        if name == norm_token:
            continue
        conf = round(1.0 - norm_dist, 2)
        if conf < _FAMILY_MIN_CONF_CANDIDATE:
            continue
        seen.add(name)
        results.append({"name": name, "confidence": conf})
        if len(results) >= top_n:
            break

    # Secondary: confusion-normalized exact match (handles د/ر، ح/خ swaps).
    # Finds names that differ only by known OCR confusion chars — treated as
    # high-confidence (0.90) since the confusion pair is a known OCR artifact.
    if len(results) < top_n:
        confused_token = _norm_ocr_confusion(norm_token)
        for name in names_list:
            if name in seen or name == norm_token:
                continue
            if _norm_ocr_confusion(name) == confused_token:
                seen.add(name)
                results.insert(0, {"name": name, "confidence": 0.90})
                if len(results) >= top_n:
                    break

    return results[:top_n]


def _norm_for_match(text: str) -> str:
    """
    Normalize for fuzzy matching:
      - strip tashkeel (diacritics)
      - alef variants أإآٱ → ا
      - tah-marbuta ة → ه  (very common OCR confusion)
    """
    text = _TASHKEEL_RE.sub("", text)
    text = text.translate(_AR_KEY_NORMALIZE)
    text = text.translate(_TAH_NORM)
    return text.strip()


# Arabic OCR confusion pairs — chars that look similar and are frequently swapped.
# Used as a secondary search layer: collapse these to a canonical form so that
# "الخليل" and "الحليل" appear identical under confusion-normalization.
_OCR_CONFUSION_TRANS = str.maketrans({
    ord("ر"): "د",   # ر ↔ د  (very common, final strokes look similar)
    ord("خ"): "ح",   # خ ↔ ح  (same base, dot removed by OCR)
    ord("ج"): "ح",   # ج ↔ ح  (same base, different dot position)
})


def _norm_ocr_confusion(text: str) -> str:
    """
    Collapse known OCR-confused Arabic character pairs.
    Used ONLY for secondary fuzzy matching — never for output.
    """
    return text.translate(_OCR_CONFUSION_TRANS)


def _suggest_token(
    token: str,
    names_set: set,
    names_list: list,
    past_lookup: dict,
    is_family_position: bool = False,
) -> dict | None:
    """
    Find the best correction for a single name token.

    Priority:
      1. Past user corrections (field_corrections table)  → confidence 0.99
      2. Exact match in dict                              → no suggestion
      3. Edit-distance search against 30 K-name dict:
           ≤5 char names: max distance 1  (one OCR misread)
           6+ char names: max distance 2
         Only surfaced if confidence ≥ threshold:
           first name (position 0): ≥ 0.70
           family/father name (position ≥ 1): ≥ 0.80

    Returns {original, suggested, confidence, source} or None.
    """
    norm = _norm_for_match(token)

    # 1. Past user corrections override everything
    if norm in past_lookup and past_lookup[norm] != norm:
        return {
            "original": token,
            "suggested": past_lookup[norm],
            "confidence": 0.99,
            "source": "correction",
        }

    # 2. Exact match → nothing to suggest
    if norm in names_set:
        return None

    # 3. Edit-distance fuzzy match
    if not names_list:
        return None

    try:
        from rapidfuzz.distance import Levenshtein as _Lev
        from rapidfuzz import process as _rfp
    except ImportError:
        logger.warning("[Names] rapidfuzz not installed — name suggestions disabled")
        return None

    max_dist = _SUGGEST_MAX_DIST_SHORT if len(norm) <= 5 else _SUGGEST_MAX_DIST_LONG

    # normalized_distance = edit_distance / max(len(a), len(b))
    max_len = max(len(norm), 1)
    dist_cutoff = max_dist / max_len   # e.g. dist 1 on 4-char = 0.25 → score ≤ 0.25

    # Collect ALL candidates within the allowed distance, then apply tiebreaking
    candidates = _rfp.extract(
        norm,
        names_list,
        scorer=_Lev.normalized_distance,
        score_cutoff=dist_cutoff,
        limit=20,
    )

    if not candidates:
        return None

    # Tiebreaker priority: high-priority names > shorter norm_dist > alphabetical
    def _rank(c):
        name, dist, _ = c
        priority = 0 if name in _HIGH_PRIORITY_NAMES else 1
        return (dist, priority, name)

    best = min(candidates, key=_rank)
    suggested, norm_dist, _ = best

    if suggested == norm:
        return None

    confidence = round(1.0 - norm_dist, 2)

    # Apply confidence threshold — family/father/grandfather names are diverse;
    # a weak fuzzy match likely means the name is valid but rare, not an OCR error.
    min_conf = _SUGGEST_MIN_CONF_FAMILY if is_family_position else _SUGGEST_MIN_CONF_FIRST
    if confidence < min_conf:
        return None

    return {
        "original": token,
        "suggested": suggested,
        "confidence": confidence,
        "source": "static",
    }


def _build_name_suggestions(
    name_value: str,
    field_corrections: list,
) -> dict | None:
    """
    Analyse a full Arabic name string token by token with position-aware gender logic.

    Arabic naming convention:
      Position 0 — first name (ism): can be male OR female
      Position 1 — father's name (nasab 1): ALWAYS male
      Position 2 — grandfather's name (nasab 2): ALWAYS male
      Position 3+ — family name (nisbah): ALWAYS male

    For positions > 0 the male-only dict is used so we never suggest a female name
    as a correction for the father's or grandfather's name.

    Returns a suggestion object or None if no corrections needed:
        {
          "original":   "محمد احمد",
          "suggested":  "محمد أحمد",
          "confidence": 0.9,
          "source":     "static",   # or "correction"
          "tokens": [...]
        }
    """
    female_set, female_list = _load_female_names_dict()
    male_set,   male_list   = _load_male_names_dict()
    if not female_list and not male_list:
        return None

    # Build per-token lookup from past field_corrections on name fields
    past_lookup: dict[str, str] = {}
    for fc in (field_corrections or []):
        if not _NAME_KEY.search(fc.get("field_name", "")):
            continue
        orig_tokens = _norm_for_match(fc.get("original_value", "")).split()
        corr_tokens = _norm_for_match(fc.get("corrected_value", "")).split()
        for o, c in zip(orig_tokens, corr_tokens):
            past_lookup[o] = c

    tokens = name_value.split()
    corrected_tokens = list(tokens)
    token_suggestions: list[dict] = []

    family_set, family_list = _load_family_names_dict()

    for i, token in enumerate(tokens):
        norm = _norm_for_match(token)
        if len(norm) < _SUGGEST_MIN_LEN or not _ARABIC_TOKEN.match(norm):
            continue

        # Treat the last token as the family name if it is at position ≥ 1.
        # This handles 2-token names (first + family) where position 1 is the last name.
        is_last_token = (i == len(tokens) - 1)

        # Position ≥ 2 OR last token at position ≥ 1 → use family names dict
        if i >= 2 or (is_last_token and i >= 1):
            # Connector words (ابو, ام, بنت …) are prefixes, not standalone family names
            if norm in _NAME_CONNECTORS:
                continue

            # 1. Exact match in any dict → already valid, no suggestion needed
            if norm in female_set or norm in male_set or norm in family_set:
                continue

            # 2. Past user correction for this token → highest priority
            if norm in past_lookup and past_lookup[norm] != norm:
                token_suggestions.append({
                    "original": token,
                    "suggested": past_lookup[norm],
                    "confidence": 0.99,
                    "source": "correction",
                    "candidates": [past_lookup[norm]],
                    "needs_review": False,
                    "position": i,
                })
                corrected_tokens[i] = past_lookup[norm]
                continue

            # 3. Fuzzy top-3 from family names dict
            top3 = _get_top_candidates(norm, family_list, top_n=3) if family_list else []

            if top3:
                best = top3[0]
                token_suggestions.append({
                    "original": token,
                    "suggested": best["name"],   # will be replaced by Gemini selection
                    "confidence": best["confidence"],
                    "source": "family_dict",
                    "candidates": [c["name"] for c in top3],
                    # Only send to Gemini if confidence is high enough to be trustworthy.
                    # Below threshold → flag for human review, never auto-correct.
                    "needs_review": best["confidence"] < _FAMILY_GEMINI_THRESHOLD,
                    "position": i,
                })
                corrected_tokens[i] = best["name"]
            else:
                # No candidates at all — flag for human review
                token_suggestions.append({
                    "original": token,
                    "suggested": token,
                    "confidence": 0.0,
                    "source": "family_dict",
                    "candidates": [],
                    "needs_review": True,
                    "position": i,
                })
            continue

        # Position 0 or 1 — first name / father's name
        # If name exists in either reference dict → it's already correct, skip
        if norm in female_set or norm in male_set:
            continue

        is_family = i > 0
        if is_family and male_list:
            suggestion = _suggest_token(token, male_set, male_list, past_lookup, is_family_position=True)
        else:
            # Position 0: check female dict first, fall back to male dict
            ref_set  = female_set  if female_set  else male_set
            ref_list = female_list if female_list else male_list
            suggestion = _suggest_token(token, ref_set, ref_list, past_lookup, is_family_position=False)

        if suggestion:
            token_suggestions.append(suggestion)
            corrected_tokens[i] = suggestion["suggested"]

    if not token_suggestions:
        return None

    min_confidence = min(s["confidence"] for s in token_suggestions)
    source = (
        "correction"
        if any(s["source"] == "correction" for s in token_suggestions)
        else "family_dict"
        if any(s.get("source") == "family_dict" for s in token_suggestions)
        else "static"
    )
    has_pending = any(
        s.get("source") == "family_dict" and s.get("candidates") and not s.get("needs_review")
        for s in token_suggestions
    )

    return {
        "original": name_value,
        "suggested": " ".join(corrected_tokens),
        "confidence": round(min_confidence, 2),
        "source": source,
        "tokens": token_suggestions,
        "needs_review": any(s.get("needs_review") for s in token_suggestions),
        "pending_gemini": has_pending,   # True → Gemini should pick from candidates
    }


def _correct_names_with_gemini(participants: list, call_fn) -> list:
    """
    Batch Gemini call that selects the best family-name correction from
    the top-3 dataset candidates pre-computed by _build_name_suggestions.

    Only triggers when at least one participant has a name suggestion with
    pending_gemini=True (i.e. family name not in dict but fuzzy match found).

    call_fn(prompt, temperature, label) → raw response string | None

    Returns an updated participants list with corrected suggestions.
    """
    # Collect items that need Gemini selection
    # pending[field_key] = {row_idx, field, original_token, candidates, suggestion_obj}
    pending: list[dict] = []
    for row_idx, p in enumerate(participants):
        sug_map = p.get("_suggestions", {})
        for field, sug in sug_map.items():
            if not sug.get("pending_gemini"):
                continue
            for tok in sug.get("tokens", []):
                if tok.get("source") == "family_dict" and tok.get("candidates") and not tok.get("needs_review"):
                    pending.append({
                        "id": len(pending) + 1,
                        "row_idx": row_idx,
                        "field": field,
                        "original_name": p.get(field, ""),
                        "token": tok["original"],
                        "candidates": tok["candidates"],
                        "token_idx": tok.get("position", -1),
                    })

    if not pending:
        return participants

    # Build compact prompt — ask Gemini to pick best candidate per token
    lines = [
        "أنت محرر سجلات مدنية فلسطينية. لديك أسماء عائلات مستخرجة من OCR قد تحتوي على أخطاء.",
        "لكل سطر اختر الاسم الأصح من المرشحين المعطيين — لا تقترح أسماء من خارج القائمة.",
        'أعد JSON فقط — مصفوفة: [{"id": N, "correction": "..."}]',
        "",
    ]
    for item in pending:
        cands = " | ".join(item["candidates"])
        lines.append(f'[{item["id"]}] الاسم المقروء: "{item["token"]}" | المرشحون: [{cands}]')

    lines.append("")
    lines.append('أعد: [{"id": 1, "correction": "..."}, ...]')
    prompt = "\n".join(lines)

    raw = call_fn(prompt, temperature=0.0, attempt_label="Name correction")
    if not raw:
        logger.warning("[Names] Gemini name correction call returned nothing — skipping")
        return participants

    # Parse Gemini response
    try:
        raw_clean = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        arr_match = re.search(r"\[.*\]", raw_clean, re.DOTALL)
        if not arr_match:
            raise ValueError("no JSON array found")
        corrections = json.loads(arr_match.group())
    except Exception as e:
        logger.warning(f"[Names] Could not parse Gemini name correction response: {e}")
        return participants

    # Build id → correction map
    id_map: dict[int, str] = {}
    for item in corrections:
        if isinstance(item, dict) and "id" in item and "correction" in item:
            id_map[int(item["id"])] = str(item["correction"])

    # Apply corrections back to _suggestions
    result = [dict(p) for p in participants]
    for item in pending:
        selected = id_map.get(item["id"])
        if not selected:
            continue
        # Validate: Gemini must pick from the candidate list
        if selected not in item["candidates"]:
            logger.warning(
                f"[Names] Gemini picked '{selected}' which is not in candidates "
                f"{item['candidates']} — ignoring"
            )
            continue
        # Update the token suggestion's 'suggested' field
        row = result[item["row_idx"]]
        sug_map = row.setdefault("_suggestions", {})
        field_sug = sug_map.get(item["field"])
        if not field_sug:
            continue
        # Apply token correction to full name suggestion.
        # corrected_tokens may contain multi-word strings (e.g. "ابو لبده"), so
        # word-index replacement on the joined string is unreliable — it would
        # target only the first word of the expansion and leave the rest behind.
        # Instead, look up the pre-Gemini correction string and replace it directly.
        tok_idx = item["token_idx"]
        prev_suggested = None
        for tok in field_sug.get("tokens", []):
            if tok.get("position") == tok_idx and tok.get("source") == "family_dict":
                prev_suggested = tok.get("suggested", "")
                break

        if prev_suggested and prev_suggested in field_sug["suggested"]:
            field_sug["suggested"] = field_sug["suggested"].replace(prev_suggested, selected, 1)
        else:
            # Fallback: word-index replacement (works when token has no multi-word expansion)
            name_tokens = field_sug["suggested"].split()
            if 0 <= tok_idx < len(name_tokens):
                name_tokens[tok_idx] = selected
                field_sug["suggested"] = " ".join(name_tokens)
        # Update token-level record
        for tok in field_sug.get("tokens", []):
            if tok.get("original") == item["token"] and tok.get("source") == "family_dict":
                tok["suggested"] = selected
                tok.pop("pending_gemini", None)
        field_sug["pending_gemini"] = False
        field_sug["source"] = "family_dict+gemini"
        logger.info(
            f"[Names] Row {item['row_idx']} | {item['field']}: "
            f"'{item['token']}' → '{selected}' (Gemini-selected from {item['candidates']})"
        )

    return result


# ── Value-cleaning pass (runs after Azure layout structuring) ──────────────────
_VALUE_CLEAN_PROMPT = """أنت نظام تنظيف بيانات لنماذج تسجيل عربية فلسطينية.
البيانات موجودة في جدول منظم — لا تغيّر هيكل الجدول ولا أسماء الأعمدة.

مهمتك: تنظيف قيم الخلايا فقط وفق هذه القواعد:

قواعد رقم الهاتف (أهم قاعدة):
- كل رقم هاتف 10 أرقام يبدأ بـ 059 أو 056
- إذا كان 9 أرقام يبدأ بـ 59 → أضف 0 في البداية (591234567 → 0591234567)
- إذا كان 9 أرقام يبدأ بـ 56 → أضف 0 في البداية
- إذا كان 10 أرقام يبدأ بـ 259 → احذف الرقم الأول: 2591112223 → 0591112223
- إذا كان 8 أرقام أو أقل أو لا يمكن إصلاحه → اتركه كما هو
- حوّل الأرقام العربية (٠-٩) إلى أرقام إنجليزية

قواعد تاريخ الميلاد وتاريخ الموافقة:
- حوّل إلى صيغة YYYY/M/D دائماً
- أمثلة: 1.2.2006 → 2006/2/1 | 11-5-2007 → 2007/5/11 | 26.6.2006 → 2006/6/26
- إذا كان التاريخ غير منطقي (مثل 6-13-2006 أو 26-22008) → اتركه كما هو

قواعد عمود التوقيع (التوقيع، اسم وتوقيع ولي الأمر):
- إذا كانت القيمة كلمة واحدة أو اثنتين فقط مثل "مر"، "نة"، "سيد"، "ديت"، "جين" → null
- إذا كانت القيمة تبدو كخربشة أو جزء من كلمة → null
- إذا كانت القيمة اسماً كاملاً من 3+ كلمات → اتركها كما هي

قواعد عمود الإعاقة:
- إذا كانت القيمة "-" أو "—" أو نقطة → null

أي عمود آخر (الاسم، الجنس، المحافظة، الفئة العمرية...) → لا تغيّره أبداً

أعد نفس كائن JSON تماماً مع التعديلات فقط. لا تضف أي نص خارج الـ JSON."""


def clean_values_with_gemini(
    participants: list[dict],
    column_order: list[str],
    job_id: str = None,
) -> list[dict]:
    """
    Post-structuring value-cleaning pass.
    Runs after Azure layout produces the structured table.
    Fixes phones (leading 0), dates (normalize format), signatures (null fragments).
    Does NOT touch names, gender, location, or any other column.

    Returns the cleaned participants list (same structure).
    Falls back to original if Gemini fails.
    """
    if not participants:
        return participants

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        logger.warning("[ValueClean] GEMINI_API_KEY not set — skipping value clean")
        return participants

    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError:
        return participants

    client     = genai.Client(api_key=api_key)
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    payload = json.dumps(
        {"column_order": column_order, "participants": participants},
        ensure_ascii=False,
    )
    prompt = _VALUE_CLEAN_PROMPT + "\n\nالبيانات:\n" + payload

    try:
        resp = client.models.generate_content(
            model=model_name,
            contents=prompt,
            config=genai_types.GenerateContentConfig(
                temperature=0,
                max_output_tokens=8192,
                thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
            ),
        )
        raw = (resp.text or "").strip()

        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)

        cleaned = json.loads(raw)
        result  = cleaned.get("participants") or cleaned
        if isinstance(result, list) and len(result) == len(participants):
            logger.info(f"[ValueClean] Cleaned {len(result)} rows (phones, dates, signatures)")
            return result
        else:
            logger.warning(f"[ValueClean] Row count mismatch — keeping original")
            return participants

    except Exception as e:
        logger.warning(f"[ValueClean] Failed (non-fatal): {e} — keeping original values")
        return participants


_SYSTEM_PROMPT = """أنت نظام استخراج جداول من مستندات عربية ممسوحة ضوئيًا (OCR).

مهمتك: تحليل النص المستخرج بواسطة OCR وإعادة بيانات الجدول بصيغة JSON تعكس تمامًا الجدول الأصلي في المستند.

القواعد الصارمة:
1. أعد كائن JSON بمفتاحين فقط — بدون أي شرح أو نص إضافي أو markdown:
   {"column_order": [...], "participants": [...]}
2. column_order: مصفوفة نصية تحتوي على أسماء الأعمدة بالترتيب الدقيق كما تظهر في المستند من اليمين إلى اليسار
3. participants: مصفوفة من الكائنات، كل كائن يمثل صفًا واحدًا من البيانات
4. الخطوة الأولى: اكتشف عناوين الأعمدة (headers) من النص — هي الكلمات التي تصف البيانات (مثل: الاسم، تاريخ الميلاد، رقم الهوية، العمر، ...) كما تظهر في المستند
5. المفاتيح في كل كائن = عناوين الأعمدة بالضبط كما تظهر في المستند (لا تغيّر التسمية أبدًا)
6. ترتيب column_order: المستندات العربية تُقرأ من اليمين إلى اليسار، لذا أول عنصر في column_order هو العمود الأقصى يمينًا في المستند الأصلي، وآخر عنصر هو الأقصى يسارًا
7. حافظ على ترتيب الصفوف من الأعلى إلى الأسفل تمامًا كما في المستند — لا تغيّر الترتيب أبدًا

قواعد الخلايا الفارغة (حرجة جداً — لا استثناء):
8. إذا كانت الخلية فارغة في المستند الأصلي أو القيمة غير واضحة تمامًا → استخدم null بدون أي استثناء
9. لا تخترع بيانات — استخرج فقط ما هو مكتوب فعلاً في تلك الخلية بالذات
10. لا تُعيد هيكلة الجدول أو تدمج حقولًا أو تفصل حقولًا — الهدف إعادة الجدول كما هو بالضبط
10b. ممنوع منعاً باتاً: نسخ قيمة من صف آخر لملء خلية فارغة — كل صف مستقل تمامًا عن الآخر
10c. إذا كان رقم الهاتف أو تاريخ الميلاد أو أي حقل آخر غير موجود لشخص ما → null، حتى لو كانت القيمة مذكورة في صف آخر
10d. الاسم الفارغ أو غير الواضح → null، لا تضع اسم شخص آخر بدلاً منه
10e. اجعل عدد الصفوف في participants مساوياً تماماً لعدد الأشخاص في الجدول — لا تحذف صفاً ولا تدمج صفين

قواعد الأرقام (مهم جداً):
11. حوّل جميع الأرقام العربية-الهندية (٠١٢٣٤٥٦٧٨٩) إلى أرقام إنجليزية (0123456789) في الإخراج
12. كثير من النماذج تحتوي على أرقام مختلطة — بعضها عربي وبعضها إنجليزي في نفس الحقل أو النموذج. تعامل مع كليهما وحوّلهما إلى أرقام إنجليزية
13. أرقام الهاتف: استخرج الرقم كما هو بالضبط دون تعديل — اجمع الرقم في خلية واحدة بدون مسافات أو شرطات فقط
14. تواريخ الميلاد: قد تكون بصيغ مختلفة (2005/1/15 أو 15-1-2005 أو ٢٠٠٥/١/١٥) — حوّلها دائماً إلى أرقام إنجليزية واحتفظ بنفس الصيغة
15. إذا كان الرقم غير واضح جزئياً (مثل: 059X234567 حيث X غير واضح)، اكتب ما هو واضح ولا تخمّن الأجزاء الغامضة

قواعد الأسماء:
16. الأسماء العربية ثلاثية أو رباعية — اجمع كل الكلمات المتعلقة باسم الشخص الواحد في خلية واحدة
17. لا تضع اسمين لشخصين مختلفين في نفس الخلية

قواعد عناوين الأعمدة متعددة الأسطر (مهمة جداً):
20. كثير من النماذج العربية تضع عنوان العمود الواحد على سطرين أو أكثر بسبب ضيق المساحة.
    مثال: "النوع" في سطر و"الاجتماعي" في السطر التالي — وكلاهما يشكّلان عنوانًا واحدًا.
21. في هذه الحالة يجب عليك:
    أ) التعرف على أن هذه الكلمات المتتالية في أسطر منفصلة تشكّل عنوان عمود واحد
    ب) دمجها في مفتاح واحد باستخدام \n للفصل بين الأسطر تمامًا كما تظهر في المستند
    ج) مثال صحيح: {"column_order": ["النوع\nالاجتماعي", "تاريخ\nالميلاد"]}
    د) مثال خاطئ: {"column_order": ["النوع الاجتماعي", "تاريخ الميلاد"]}
22. الهدف: أن يطابق عنوان العمود تمامًا شكل الترويسة في النموذج الأصلي — مكدّسة كما هي

قاعدة الصفوف المدمجة (مهمة جداً):
18. كثيراً ما يضع OCR رقمي صفين متتاليين معاً في سطر واحد (مثل "3 2" أو "12 11" أو "8 9").
    هذا يعني أن Vision دمج صفَّين منفصلَين من النموذج في سطر واحد.
    في هذه الحالة يجب عليك:
    أ) التعرف على الرقمين التسلسليين في بداية السطر
    ب) فصل بيانات الشخص الأول عن بيانات الشخص الثاني
    ج) إنشاء كائنَين منفصلَين في participants — واحد لكل رقم
    د) الاسم الرباعي عادةً 3-4 كلمات فقط — إذا وجدت 6-8 كلمات تبدو أسماء، فهي على الأرجح اسمان لشخصَين مختلفَين
    هـ) استخدم تعدد القيم (جنسان، تاريخان، رقمان) كدليل على وجود شخصَين مدمجَين
19. مثال: السطر "3 2 محمد أحمد علي سارة خالد عمر انتى اتتى 1990/1/1 2005/3/15 059111 059222" يعني:
    - شخص رقم 2: محمد أحمد علي | انتى | 1990/1/1 | 059111
    - شخص رقم 3: سارة خالد عمر | اتتى | 2005/3/15 | 059222

قواعد أرقام الهاتف التفصيلية (أعلى أولوية — طبّقها دائماً):
25. كل رقم هاتف في هذه النماذج هو 10 أرقام بالضبط يبدأ بـ 059 أو 056 — بدون استثناء
26. إذا بدأ الرقم بـ 59 بدون صفر (9 أرقام) → أضف الصفر تلقائياً: 591234567 → 0591234567
27. إذا بدأ الرقم بـ 56 بدون صفر (9 أرقام) → أضف الصفر تلقائياً: 561234567 → 0561234567
28. إذا كانت الأرقام مفصولة بمسافات أو شرطات أو نقاط → اجمعها: 059-123-4567 أو 059 123 4567 → 0591234567
29. رقم لا يبدأ بـ 059 أو 056 → لا تحوله إلى null، بل اكتب الأرقام كما هي بالضبط حتى يتمكن المستخدم من المراجعة. استخدم null فقط إذا كانت الخلية فارغة تماماً (لا توجد أي أرقام مرئية)
30. لا تكتب null إذا كنت ترى أي نص أو أرقام في موضع تلك الخلية — اكتب ما تستطيع قراءته حتى لو كانت القراءة غير مؤكدة. استخدم null فقط إذا كانت الخلية فارغة تماماً في المستند الأصلي (لا يوجد أي كتابة هناك)

قواعد عدد الصفوف (حرجة جداً — لا استثناء):
31. قبل إنشاء الـ JSON، عُدّ بدقة كل صف بيانات في الجدول (صفوف البيانات فقط، ليس صف الرأس)
32. يجب أن يحتوي مصفوفة participants على نفس العدد بالضبط من الكائنات كعدد صفوف البيانات — لا تدمج صفين معاً، ولا تحذف صفاً حتى لو كان الاسم غير واضح
33. إذا كان الاسم غير واضح في صف ما → اكتب ما تستطيع قراءته (حتى حرف واحد أو "؟") ولا تحذف الصف أبداً
34. صف بدون اسم واضح هو صف حقيقي يجب تضمينه — ضع null في خانة الاسم فقط إذا لم يكن هناك أي كتابة مرئية في تلك الخلية بالذات

قواعد تنسيق نص الإدخال:
23. قد يحتوي النص على رمز | بين الكلمات — هذا يشير إلى حدود الأعمدة داخل الصف الواحد (مسافة واسعة بين خليتين متجاورتين في الجدول)
24. استخدم هذه العلامة كمساعدة لتحديد بنية الأعمدة — لكن البيانات الفعلية (الأسماء والأرقام) هي الأساس دائماً

قواعد حقل الجنس (حرجة جداً — لا استثناء):
35. إذا كان هناك عمود للجنس (مثل: الجنس، النوع، النوع الاجتماعي، gender) فإن القيمة المسموحة هي ذكر أو أنثى فقط — لا شيء آخر أبداً
36. حوّل كل مرادفات الجنس إلى واحدة من هاتين القيمتين:
    - ذكر ← م، M، male، ولد، صبي، انت، انتا، ذكور، ذك، او أي نص يشير إلى الجنس المذكر
    - أنثى ← ف، F، female، بنت، فتاة، انثى، اثنى، انثي، أو أي نص يشير إلى الجنس المؤنث
37. إذا كانت الخلية فارغة أو غير واضحة → null (لا تضع ذكر أو أنثى إذا لم تكن المعلومة موجودة)
38. احذر من OCR الخاطئ: "انت" تعني غالباً ذكر، "انتي" أو "انتى" تعني غالباً أنثى في هذا السياق — حوّلهما بما يناسب

قواعد حقل الموافقة (حرجة جداً — لا استثناء):
39. إذا كان هناك عمود للموافقة أو القبول (مثل: الموافقة، موافق، قبول، الموافقة على...) فإن القيم المسموحة هي فقط:
    موافق أو غير موافق (أو بديلاً: نعم أو لا)
40. حوّل كل المرادفات:
    - موافق ← نعم، yes، y، وافق، قبل، مقبول، ✓، صح، صحيح، x (إذا كان يشير إلى الموافقة)
    - غير موافق ← لا، no، n، رفض، مرفوض، ✗، خطأ
41. إذا كانت الخلية فارغة أو لا يمكن تحديد المعنى → null

قاعدة عدم تكرار الأعمدة (حرجة جداً):
45. ممنوع منعاً باتاً إنشاء عمودين يحملان نفس المعنى الجوهري — حتى لو اختلف شكل العنوان قليلاً
46. أمثلة على التكرار الممنوع:
    - "الاسم" و"الاسم الرباعي للمشارك" → عمود واحد فقط
    - "هل لديك إعاقة" و"الإعاقة" → عمود واحد فقط
    - "تاريخ الميلاد" و"تاريخ الولادة" → عمود واحد فقط (كلاهما يعني DOB)
47. إذا وجد نفس المعنى في عنوانين مختلفين → اختر العنوان الأطول والأكثر وصفاً وتجاهل الآخر تماماً
استثناء حرج جداً — عمودان يبدوان متشابهين لكنهما مختلفان:
    - "التوقيع" و"اسم وتوقيع ولي الأمر" → عمودان مختلفان تماماً — الأول توقيع المشارك نفسه، والثاني اسم وتوقيع الوالد أو الوصي — لا تدمجهما أبداً
    - "تاريخ الميلاد" و"تاريخ الموافقة" → عمودان مختلفان تماماً — الأول تاريخ ميلاد الشخص، والثاني تاريخ موافقته على المشاركة — لا تدمجهما أبداً

قواعد حقل التوقيع (حرجة جداً — لا استثناء):
48. عمود التوقيع (مثل: التوقيع، توقيع المشارك، الإمضاء) يحتوي على التوقيع فقط — لا يحتوي أبداً على:
    - اسم الشخص
    - تاريخ الموافقة أو أي تاريخ
    - كلمة "توقيع" أو "موافق" كنص مكتوب من عندك
    - أي نص وصفي أو تسمية
49. إذا كانت خلية التوقيع فارغة أو تحتوي على خربشة/رسم غير مقروء → null
50. إذا ظهر تاريخ بجانب التوقيع في المستند → ضع التاريخ في عمود "تاريخ الموافقة" وليس في عمود التوقيع
51. ممنوع منعاً باتاً دمج اسم الشخص أو التاريخ داخل خلية التوقيع — كل معلومة في عمودها الصحيح

قواعد الخلايا الفارغة المُعززة (أعلى أولوية — لا استثناء مطلقاً):
52. إذا لم يكتب الشخص شيئاً في خانة ما في المستند الأصلي → القيمة null بدون نقاش
53. ممنوع منعاً باتاً أن تملأ خانة فارغة بأي قيمة مهما كان السبب:
    - لا تنسخ من الصف السابق
    - لا تنسخ من الصف التالي
    - لا تضع قيمة افتراضية
    - لا تخمّن
    - لا تستنتج
54. الخانة الفارغة في المستند = null في الإخراج — هذه القاعدة مطلقة ولا تقبل الاستثناء

قواعد الحفاظ على جميع الأعمدة (أعلى أولوية — لا استثناء مطلقاً):
55. استخرج كل عمود موجود في الجدول دون استثناء. عدد عناصر column_order يجب أن يساوي عدد الأعمدة الظاهرة في المستند بالضبط — إن رأيت 4 أعمدة فيجب أن يحتوي column_order على 4 عناصر (وليس 2 أو 3).
56. ممنوع منعاً باتاً حذف عمود أو دمج عمودين، حتى في هذه الحالات:
    - عمود تتكرر فيه القيمة نفسها في كل الصفوف (مثل «اسم الموزّع» أو رقم جواله الموحّد لكل المستفيدين) → احتفظ به كعمود مستقل وكرّر القيمة في كل صف.
    - عمود قيمه مموّهة أو مخفية جزئياً (تحتوي على *** أو نجوم) مثل «رقم الهوية» → احتفظ به وانسخ القيمة كما تظهر مع النجوم.
    - عمودان يشتركان في كلمة داخل العنوان (مثل «اسم الموزّع» و«رقم جوال الموزّع») → هما عمودان مختلفان، لا تدمجهما أبداً.
57. لا تُسقط عموداً لأنه يبدو مكرراً أو قليل المعلومات — كل عمود في المستند يجب أن يظهر في الإخراج.

قواعد المستندات متعددة الصفحات والجداول المتعددة:
42. إذا كان المستند يحتوي على جداول متعددة (مثل جدول في كل صفحة) فاجمع صفوف جميع الجداول في مصفوفة participants واحدة
43. إذا تكررت عناوين الأعمدة (headers) في بداية جدول جديد → تجاهل الصف المكرر ولا تضفه كمشارك
44. استخدم column_order من أول جدول تراه كأساس — إذا كانت الصفحات التالية تحتوي على أعمدة إضافية غير موجودة في الصفحة الأولى، أضفها إلى نهاية column_order
    حرج جداً — ترتيب الصفوف: اقرأ الصفوف صفحةً صفحةً من أعلى إلى أسفل بالترتيب — لا تعيد ترتيب الصفوف أبداً ولا تبدل مكان بيانات شخص بآخر
    إذا كانت إحدى الصفحات تحتوي على عمود غير موجود في الصفحة الأخرى → اجعل قيمه null لتلك الصفوف

مثال مع أرقام مختلطة:
{
  "column_order": ["الاسم", "رقم الهاتف", "تاريخ الميلاد"],
  "participants": [
    {"الاسم": "محمد أحمد علي", "رقم الهاتف": "0591234567", "تاريخ الميلاد": "2005/3/15"},
    {"الاسم": "فاطمة حسن محمد", "رقم الهاتف": "0561234567", "تاريخ الميلاد": "1998/11/3"}
  ]
}
"""


def structure_with_gemini(
    full_text: str,
    field_corrections: list = None,
    job_id: str = None,
    image_bytes: bytes | None = None,
) -> dict:
    """
    Send raw OCR text to Gemini and get structured participant records.

    Args:
        full_text: Raw Vision OCR output (after OCR pre-processing pass)
        field_corrections: Recent {field_name, original_value, corrected_value} dicts
                           injected as few-shot examples (Layer 2 correction)
        image_bytes: Optional PNG/JPEG bytes of the first document page. When provided,
                     Gemini performs visual cross-verification — it looks at the actual
                     document to resolve ambiguities in the OCR text (especially [?]-marked
                     low-confidence words and name cells).

    Returns:
        {
            "success": bool,
            "participants": list[dict],  # one dict per person
            "column_order": list[str],   # column names in document order
            "model": str,
            "error": str | None
        }
    """
    try:
        from google import genai
        from google.genai import types as genai_types
    except ImportError:
        return _fail("google-genai not installed. Run: pip install google-genai")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return _fail("GEMINI_API_KEY not set in environment")

    if not full_text or not full_text.strip():
        return _fail("Empty text — nothing to structure")

    client = genai.Client(api_key=api_key)
    # Primary model + fallback if quota is exhausted
    _PRIMARY_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    _FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite")
    model_name = _PRIMARY_MODEL

    # Build user message
    user_msg = _build_prompt(full_text, field_corrections or [])
    full_prompt = _SYSTEM_PROMPT + "\n\n" + user_msg

    logger.info(f"[Gemini] Sending {len(full_text)} chars to {model_name}")

    # ── Debug state collector ──────────────────────────────────────────────────
    _dbg: dict = {
        "job_id": job_id,
        "input_text_length": len(full_text),
        "input_text_preview": full_text[:3000],
        "attempts": [],
        "parsed_before_normalization": None,
        "parsed_after_normalization": None,
        "after_sanity_check": None,
        "after_dedup": None,
        "final_participants": None,
        "column_order": None,
    }

    t0 = time.time()

    # When image_bytes provided, build a multimodal contents list for Attempt 1.
    # Gemini sees the actual document page alongside the OCR text — it uses vision
    # to resolve [?]-marked words and verify table structure directly from the image.
    _img_mime = "image/png"
    if image_bytes and image_bytes[:3] == b"\xff\xd8\xff":
        _img_mime = "image/jpeg"

    def _build_contents(prompt: str) -> list | str:
        """Return multimodal [image, text] list when image available, else plain string."""
        if image_bytes:
            return [
                genai_types.Part.from_bytes(data=image_bytes, mime_type=_img_mime),
                prompt,
            ]
        return prompt

    def _call(prompt: str, temperature: float, attempt_label: str, use_image: bool = False) -> str | None:
        """Make one Gemini call. Falls back to _FALLBACK_MODEL on quota errors."""
        nonlocal model_name
        contents = _build_contents(prompt) if use_image else prompt
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=genai_types.GenerateContentConfig(
                    temperature=temperature,
                    max_output_tokens=8192,
                    thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                ),
            )
            elapsed = round(time.time() - t0, 2)
            logger.info(f"[Gemini] {attempt_label} response in {elapsed}s | {len(resp.text)} chars | model: {model_name}")
            _dbg["attempts"].append({"label": attempt_label, "elapsed_s": elapsed, "raw_response": resp.text, "model": model_name})
            return resp.text
        except Exception as e:
            err_str = str(e)
            # 503 (overloaded) — wait 8 s and retry once on the same model before fallback
            if "503" in err_str or "UNAVAILABLE" in err_str:
                logger.warning(f"[Gemini] {attempt_label} 503 overload on {model_name} — waiting 8 s then retrying")
                time.sleep(8)
                try:
                    resp = client.models.generate_content(
                        model=model_name,
                        contents=contents,
                        config=genai_types.GenerateContentConfig(
                            temperature=temperature,
                            max_output_tokens=8192,
                            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                        ),
                    )
                    elapsed = round(time.time() - t0, 2)
                    logger.info(f"[Gemini] {attempt_label} 503-retry OK in {elapsed}s | {len(resp.text)} chars | model: {model_name}")
                    _dbg["attempts"].append({"label": f"{attempt_label} (503-retry)", "elapsed_s": elapsed, "raw_response": resp.text, "model": model_name})
                    return resp.text
                except Exception as e503:
                    logger.warning(f"[Gemini] {attempt_label} 503-retry failed: {e503} — switching to {_FALLBACK_MODEL}")
                    if model_name != _FALLBACK_MODEL:
                        model_name = _FALLBACK_MODEL
                        try:
                            resp = client.models.generate_content(
                                model=model_name,
                                contents=contents,
                                config=genai_types.GenerateContentConfig(
                                    temperature=temperature,
                                    max_output_tokens=8192,
                                    thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                                ),
                            )
                            elapsed = round(time.time() - t0, 2)
                            logger.info(f"[Gemini] {attempt_label} fallback response in {elapsed}s | {len(resp.text)} chars | model: {model_name}")
                            _dbg["attempts"].append({"label": f"{attempt_label} (fallback {model_name})", "elapsed_s": elapsed, "raw_response": resp.text, "model": model_name})
                            return resp.text
                        except Exception as e_fb:
                            logger.error(f"[Gemini] {attempt_label} fallback also failed: {e_fb}")
                            _dbg["attempts"].append({"label": f"{attempt_label} (fallback {model_name})", "error": str(e_fb)})
                    return None
            # 429 (quota exhausted) — switch to fallback model immediately
            if "429" in err_str and model_name != _FALLBACK_MODEL:
                logger.warning(f"[Gemini] {attempt_label} quota exceeded on {model_name} — retrying with {_FALLBACK_MODEL}")
                model_name = _FALLBACK_MODEL
                try:
                    resp = client.models.generate_content(
                        model=model_name,
                        contents=contents,
                        config=genai_types.GenerateContentConfig(
                            temperature=temperature,
                            max_output_tokens=8192,
                            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
                        ),
                    )
                    elapsed = round(time.time() - t0, 2)
                    logger.info(f"[Gemini] {attempt_label} fallback response in {elapsed}s | {len(resp.text)} chars | model: {model_name}")
                    _dbg["attempts"].append({"label": f"{attempt_label} (fallback {model_name})", "elapsed_s": elapsed, "raw_response": resp.text, "model": model_name})
                    return resp.text
                except Exception as e2:
                    logger.error(f"[Gemini] {attempt_label} fallback also failed: {e2}")
                    _dbg["attempts"].append({"label": f"{attempt_label} (fallback {model_name})", "error": str(e2)})
                    return None
            logger.error(f"[Gemini] {attempt_label} API call failed: {e}")
            _dbg["attempts"].append({"label": attempt_label, "error": err_str, "model": model_name})
            return None

    # ── Attempt 1: standard prompt (+ image when available for visual grounding) ──
    _has_image = bool(image_bytes)
    if _has_image:
        logger.info("[Gemini] Multimodal structuring: sending page image for visual cross-verification")
    raw = _call(full_prompt, temperature=0.1, attempt_label="Attempt 1", use_image=_has_image)
    if raw is None:
        _write_debug(_dbg, job_id)
        return _fail("Gemini API call failed on attempt 1")

    # Parse raw JSON — capture state BEFORE normalization for debugging
    raw_parsed, raw_col_order = _parse_json_raw(raw)
    _dbg["parsed_before_normalization"] = raw_parsed

    participants, col_order = _parse_json(raw)
    _dbg["parsed_after_normalization"] = participants

    # ── Attempt 2: retry if JSON was malformed ────────────────────────────────
    if participants is None:
        logger.warning("[Gemini] JSON parse failed — retrying with stricter prompt")
        retry_json_prompt = (
            _SYSTEM_PROMPT + "\n\n"
            "إجابتك السابقة لم تكن JSON صالحة. "
            'أعد الإجابة بصيغة JSON فقط — كائن يبدأ بـ { ويحتوي على column_order و participants، بدون أي نص آخر:\n\n'
            + user_msg
        )
        raw2 = _call(retry_json_prompt, temperature=0.0, attempt_label="Attempt 2 (JSON fix)")
        if raw2 is not None:
            participants, col_order = _parse_json(raw2)

    # ── Attempt 3: retry if array is empty (Gemini found nothing) ─────────────
    if participants is not None and len(participants) == 0:
        logger.warning("[Gemini] Empty result — retrying with explicit search prompt")
        retry_empty_prompt = (
            _SYSTEM_PROMPT + "\n\n"
            "تحذير: أعدت نتيجة فارغة في المحاولة السابقة، لكن النص أدناه يحتوي على بيانات مشاركين.\n"
            "ابحث بعناية عن كل شخص مُدرج في النص — قد تكون البيانات في جدول أو قائمة أو كتابة متفرقة.\n"
            "يجب أن تجد على الأقل مشاركًا واحدًا إذا كان النص يحتوي على أي اسم أو رقم هاتف:\n\n"
            + user_msg
        )
        raw3 = _call(retry_empty_prompt, temperature=0.2, attempt_label="Attempt 3 (empty retry)")
        if raw3 is not None:
            participants3, col_order3 = _parse_json(raw3)
            if participants3 is not None and len(participants3) > 0:
                participants = participants3
                col_order = col_order3
                logger.info(f"[Gemini] Empty retry succeeded | {len(participants)} participant(s)")
            else:
                logger.warning("[Gemini] Empty retry also returned 0 participants")

    # ── Final result ──────────────────────────────────────────────────────────
    if participants is not None and len(participants) > 0:
        final_participants, col_order = _remove_empty_columns(participants, col_order)

        # ── Column-count guard ────────────────────────────────────────────────
        # Gemini text-structuring sometimes omits whole columns whose values are
        # identical across rows (e.g. a distributor name repeated for everyone)
        # or masked (***). Compare the column count it returned against the count
        # implied by the pipe-structured OCR text and log loudly on a shortfall,
        # so the drop is visible in job debug even when the deterministic Azure
        # Layout path is unavailable. (Log-only — no auto-repair.)
        try:
            _pipe_counts = [ln.count("|") + 1 for ln in (full_text or "").splitlines() if ln.count("|") >= 2]
            if _pipe_counts:
                _pipe_counts.sort()
                _expected = _pipe_counts[len(_pipe_counts) // 2]   # median cells/row
                if len(col_order) < _expected - 1:
                    logger.warning(
                        f"[Gemini] Column-count guard: returned {len(col_order)} column(s) "
                        f"{col_order} but the OCR text implies ~{_expected}. A column was "
                        f"likely dropped (check for repeated/identical or masked columns)."
                    )
                    _dbg["column_count_warning"] = {"returned": len(col_order), "ocr_implied": _expected}
        except Exception:
            pass

        # Field-mapping repair: move obviously mis-mapped values to the correct
        # column (e.g. a phone number or date sitting in the name field gets
        # swapped into the phone/date column). Runs BEFORE validation so the
        # phone/date checks below see the now-correctly-placed values.
        final_participants = [_sanity_check_row(p) for p in final_participants]

        # Post-structuring validation: enforce phone rules, flag date/name issues,
        # and attach name suggestions (fuzzy match + family dict + past corrections)
        final_participants, validation_issues = _validate_and_fix_participants(
            final_participants, field_corrections=field_corrections
        )

        # Gemini-guided family name correction: pick best candidate from dataset
        # Disabled by default — reconcile_multi_ocr_names (Stage 4.6) handles name
        # correction via 3-source token voting with a single batched Gemini call.
        # Enable with GEMINI_NAME_CORRECTION_STAGE4=1 only for Vision-only mode.
        if os.getenv("GEMINI_NAME_CORRECTION_STAGE4", "0") == "1":
            final_participants = _correct_names_with_gemini(final_participants, _call)

        _dbg["validation_issues"] = validation_issues
        _dbg["final_participants"] = final_participants
        _dbg["column_order"] = col_order

        logger.info(f"[Gemini] Final: {len(final_participants)} participant(s) | Columns: {col_order}")
        _write_debug(_dbg, job_id)
        return {
            "success": True,
            "participants": final_participants,
            "column_order": col_order,
            "model": model_name,
            "error": None,
        }

    if participants is not None and len(participants) == 0:
        logger.warning("[Gemini] No participants found after all attempts")
        _dbg["final_participants"] = []
        _write_debug(_dbg, job_id)
        return {
            "success": True,
            "participants": [],
            "column_order": col_order or [],
            "model": model_name,
            "error": None,
        }

    logger.error(f"[Gemini] All attempts failed. Raw:\n{raw[:300]}")
    _write_debug(_dbg, job_id)
    return _fail(f"Could not parse JSON after 3 attempts. Raw: {raw[:300]}")


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _build_prompt(full_text: str, field_corrections: list) -> str:
    parts = []

    # Inject few-shot examples from past corrections (Layer 2)
    if field_corrections:
        parts.append("أمثلة من تصحيحات سابقة — تعلّم منها لتجنب نفس الأخطاء:")
        for c in field_corrections[:5]:  # max 5 examples
            orig = c.get("original_value", "")
            corr = c.get("corrected_value", "")
            fname = c.get("field_name", "")
            if orig and corr and fname:
                parts.append(f'  - القيمة "{orig}" تنتمي إلى حقل "{fname}" (وليس إلى حقل آخر)')
        parts.append("")

    parts.append("النص المستخرج من النموذج:")
    parts.append(full_text.strip())

    return "\n".join(parts)


def _write_debug(dbg: dict, job_id: str = None) -> None:
    """Write debug state to .tmp/{job_id}_gemini_debug.json for inspection."""
    import json
    from pathlib import Path
    from datetime import datetime
    tmp = Path(".tmp")
    tmp.mkdir(exist_ok=True)
    suffix = job_id or datetime.now().strftime("%Y%m%d_%H%M%S")
    path = tmp / f"{suffix}_gemini_debug.json"
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(dbg, f, ensure_ascii=False, indent=2, default=str)
        logger.info(f"[Gemini] Debug written → {path}")
    except Exception as e:
        logger.warning(f"[Gemini] Could not write debug file: {e}")


def _parse_json_raw(text: str) -> tuple:
    """Same as _parse_json but skips _normalize_participant — preserves raw Gemini output."""
    if not text:
        return None, []
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    text = text.rstrip("`").strip()
    obj_match = re.search(r"\{.*\}", text, re.DOTALL)
    if obj_match:
        try:
            data = json.loads(obj_match.group())
            if isinstance(data, dict) and "participants" in data:
                return data.get("participants", []), data.get("column_order", [])
        except json.JSONDecodeError:
            pass
    arr_match = re.search(r"\[.*\]", text, re.DOTALL)
    if arr_match:
        try:
            data = json.loads(arr_match.group())
            if isinstance(data, list):
                return data, []
        except json.JSONDecodeError:
            pass
    return None, []


def _parse_json(text: str) -> tuple:
    """
    Extract and parse JSON from Gemini response.
    Returns (participants, column_order) where either may be None/[] on failure.

    Handles two formats:
      1. New wrapper: {"column_order": [...], "participants": [...]}
      2. Legacy fallback: [{"col": "val", ...}, ...]
    """
    if not text:
        return None, []

    # Strip markdown fences if present
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    text = text.rstrip("`").strip()

    # ── Try wrapper object first ───────────────────────────────────────────────
    obj_match = re.search(r"\{.*\}", text, re.DOTALL)
    if obj_match:
        try:
            data = json.loads(obj_match.group())
            if isinstance(data, dict) and "participants" in data:
                raw_parts = data.get("participants", [])
                col_order = data.get("column_order", [])
                if isinstance(raw_parts, list):
                    normalized = [_normalize_participant(p) for p in raw_parts if isinstance(p, dict)]
                    if isinstance(col_order, list):
                        col_order = [str(c).strip() for c in col_order if str(c).strip()]
                    else:
                        col_order = []
                    return normalized, col_order
        except json.JSONDecodeError:
            pass

    # ── Fallback: raw array (no column_order) ─────────────────────────────────
    arr_match = re.search(r"\[.*\]", text, re.DOTALL)
    if arr_match:
        try:
            data = json.loads(arr_match.group())
            if isinstance(data, list):
                normalized = [_normalize_participant(p) for p in data if isinstance(p, dict)]
                return normalized, []
        except json.JSONDecodeError:
            pass

    return None, []


_PHONE_VALUE_RE = re.compile(r'^\d{9,11}$')   # 9–11 digits = looks like a phone
_DATE_VALUE_RE  = re.compile(r'\d{4}[/\-]\d{1,2}[/\-]\d{1,2}|\d{1,2}[/\-]\d{1,2}[/\-]\d{4}')


def _sanity_check_row(row: dict) -> dict:
    """
    Detect obviously mis-mapped values and attempt to swap them to the right field.
    Example: phone number value ending up in the name column.
    Logs a warning but never silently discards data.
    """
    # Find phone and name keys in this row
    phone_key = next((k for k in row if _PHONE_KEY.search(k)), None)
    name_key  = next((k for k in row if _NAME_KEY.search(k)), None)
    date_key  = next((k for k in row if _DATE_KEY.search(k)), None)

    corrections = {}

    # Phone number sitting in the name field
    if name_key and phone_key:
        name_val  = row.get(name_key) or ""
        phone_val = row.get(phone_key) or ""
        if _PHONE_VALUE_RE.match(name_val.replace(" ", "")) and not _PHONE_VALUE_RE.match(phone_val.replace(" ", "")):
            logger.warning(f"[Sanity] Phone value '{name_val}' found in name field '{name_key}' — swapping with '{phone_key}'")
            corrections[name_key]  = phone_val or None
            corrections[phone_key] = name_val

    # Date value sitting in the name field
    if name_key and date_key:
        name_val = row.get(name_key) or ""
        date_val = row.get(date_key) or ""
        if _DATE_VALUE_RE.search(name_val) and not _DATE_VALUE_RE.search(date_val):
            logger.warning(f"[Sanity] Date value '{name_val}' found in name field '{name_key}' — swapping with '{date_key}'")
            corrections[name_key] = date_val or None
            corrections[date_key] = name_val

    if corrections:
        return {**row, **corrections}
    return row


def _remove_cross_row_duplicates(participants: list) -> list:
    """
    Detect values that Gemini copied from one row into another row's empty field.

    Strategy: for fields that should be unique per person (phone, date of birth),
    track which value was first seen. If the exact same value appears again in a
    later row AND the original document likely had that cell empty (i.e. Gemini
    is repeating a value), null it out.

    We use a simple heuristic: if value X appears in row i for field F, and also
    in row j (j > i) for the same field F, row j's value is suspicious. We null
    it out and log a warning.

    Names are excluded — duplicate names can legitimately exist.
    """
    if len(participants) <= 1:
        return participants

    # Find all "unique-per-person" field keys (phone + date fields)
    all_keys: list = []
    seen_keys: set = set()
    for p in participants:
        for k in p.keys():
            if k not in seen_keys:
                seen_keys.add(k)
                all_keys.append(k)

    unique_fields = [k for k in all_keys if _PHONE_KEY.search(k) or _DATE_KEY.search(k)]
    if not unique_fields:
        return participants

    result = [dict(p) for p in participants]  # deep copy

    for field in unique_fields:
        seen_values: dict = {}  # value → first row index
        for row_idx, row in enumerate(result):
            val = row.get(field)
            if not val:
                continue
            if val in seen_values:
                # Same value appeared before → likely a Gemini cross-row copy
                logger.warning(
                    f"[Dedup] Row {row_idx}: field '{field}' value '{val}' "
                    f"is a duplicate of row {seen_values[val]} — nulling out"
                )
                result[row_idx][field] = None
            else:
                seen_values[val] = row_idx

    return result


def _remove_empty_columns(participants: list, col_order: list) -> tuple:
    """Remove columns where every row has a null/empty value. Returns (participants, col_order)."""
    if not participants:
        return participants, col_order

    # Collect all keys in first-appearance order
    all_keys: list = []
    seen: set = set()
    for p in participants:
        for k in p.keys():
            if k not in seen:
                seen.add(k)
                all_keys.append(k)

    # Keep only columns that have at least one non-null value
    kept = set(k for k in all_keys if any(p.get(k) for p in participants))
    removed = set(all_keys) - kept
    if removed:
        logger.info(f"[Gemini] Dropped empty columns: {removed}")

    # Filter col_order to only kept columns (preserve order)
    new_col_order = [c for c in col_order if c in kept]
    # Append any kept columns not in col_order (shouldn't happen, but safety)
    for k in all_keys:
        if k in kept and k not in new_col_order:
            new_col_order.append(k)

    return [{k: p.get(k) for k in new_col_order if k in kept} for p in participants], new_col_order


def _validate_and_fix_participants(
    participants: list,
    field_corrections: list = None,
) -> tuple:
    """
    Post-structuring validation, auto-correction, and name suggestion pass.

    Runs after Gemini output + _normalize_participant.  Catches issues that
    slipped through (OCR noise, Gemini hallucination, misalignment).

    Checks applied per participant:
    - Phone  : must be 10 digits, prefix 059 or 056. Auto-corrects 9-digit 59/56 numbers.
    - Date   : year must be 1940–2020 for birth dates.
    - Name   : flags if ≥6 digits found (likely phone/date in wrong field).
    - Name   : fuzzy-matches each token against 30 K-name dict + past corrections.
               Attaches _suggestions dict to participant rows (non-destructive).

    Returns:
        (corrected_participants, issues_list)

    issues_list entries: {row, field, issue, original, corrected}
    All issues are logged as warnings so they appear in the server output.
    """
    issues = []
    result = []

    for row_idx, participant in enumerate(participants):
        row = dict(participant)

        for key, val in participant.items():
            if not val:
                continue
            sval = str(val)

            # ── Phone validation ────────────────────────────────────────────
            if _PHONE_KEY.search(key):
                fixed = _fix_phone(sval)
                if fixed != sval:
                    issues.append({
                        "row": row_idx, "field": key,
                        "issue": "auto_corrected",
                        "original": sval, "corrected": fixed,
                    })
                    row[key] = fixed
                final_digits = _DIGITS_ONLY.sub("", row.get(key) or "")
                if not (len(final_digits) == 10 and final_digits[:3] in _VALID_PHONE_PREFIXES):
                    prefix = final_digits[:3] if len(final_digits) >= 3 else "?"
                    issues.append({
                        "row": row_idx, "field": key,
                        "issue": f"invalid_phone:len={len(final_digits)},prefix={prefix}",
                        "original": sval, "corrected": row.get(key),
                    })
                    if not final_digits:
                        row[key] = None
                    else:
                        logger.warning(
                            f"[Phone] Non-standard format flagged for review: "
                            f"'{sval}' → '{row.get(key)}' (len={len(final_digits)}, prefix={prefix})"
                        )

            # ── Date validation ─────────────────────────────────────────────
            elif _DATE_KEY.search(key):
                year_m = re.search(r'\b(1[89]\d{2}|20[012]\d)\b', sval)
                if not year_m:
                    issues.append({
                        "row": row_idx, "field": key,
                        "issue": "no_valid_year_in_date",
                        "original": sval, "corrected": sval,
                    })
                else:
                    year = int(year_m.group())
                    if not (1940 <= year <= 2020):
                        issues.append({
                            "row": row_idx, "field": key,
                            "issue": f"suspect_birth_year:{year}",
                            "original": sval, "corrected": sval,
                        })

            # ── Name validation + suggestions ───────────────────────────────
            elif _NAME_KEY.search(key):
                digit_count = sum(c.isdigit() for c in sval)
                if digit_count >= 6:
                    issues.append({
                        "row": row_idx, "field": key,
                        "issue": f"name_field_contains_{digit_count}_digits_possible_misalignment",
                        "original": sval, "corrected": sval,
                    })
                else:
                    suggestion = _build_name_suggestions(sval, field_corrections)
                    if suggestion:
                        row.setdefault("_suggestions", {})[key] = suggestion
                        # Auto-apply when confidence is high enough and not needs_review:
                        #   - past user corrections (source="correction") → always apply
                        #   - static dict match confidence ≥ 0.82 → apply (e.g. مهمد→محمد)
                        _auto = (
                            suggestion.get("source") == "correction"
                            or (
                                not suggestion.get("needs_review")
                                and suggestion.get("confidence", 0) >= 0.82
                            )
                        )
                        if _auto and suggestion["suggested"] != sval:
                            row[key] = suggestion["suggested"]
                            logger.info(
                                f"[Names] Row {row_idx} | {key}: AUTO-APPLIED "
                                f"'{sval}' → '{suggestion['suggested']}' "
                                f"(conf={suggestion['confidence']}, src={suggestion['source']})"
                            )
                        else:
                            logger.info(
                                f"[Names] Row {row_idx} | {key}: suggestion "
                                f"'{sval}' → '{suggestion['suggested']}' "
                                f"(conf={suggestion['confidence']}, src={suggestion['source']})"
                            )

        result.append(row)

    if issues:
        for iss in issues:
            orig = iss.get('original', '')
            corr = iss.get('corrected', orig)
            logger.warning(
                f"[Validate] Row {iss['row']} | {iss['field']}: "
                f"{iss['issue']} | '{orig}'"
                + (f" → '{corr}'" if corr != orig else "")
            )
        logger.warning(f"[Validate] {len(issues)} issue(s) across {len(participants)} participant(s)")
    else:
        logger.info(f"[Validate] All {len(participants)} participant(s) passed validation ✓")

    return result, issues


def _normalize_participant(p: dict) -> dict:
    """
    Normalize one participant row:
    1. Strip whitespace from keys + normalize Arabic alef variants in keys
    2. Convert Arabic-Indic digits → Western digits
    3. Auto-correct phone numbers (remove spaces/dashes, enforce 059/056 prefix)
    4. Auto-correct dates (clean separators, validate year range)
    """
    result = {}
    for key, val in p.items():
        clean_key = str(key).strip()
        # Normalize alef variants in column keys (أ/إ/آ → ا) for consistent field detection.
        # Example: "الأسم" (Vision misread) → "الاسم" (canonical form).
        # Applied to keys only — values are preserved as-is.
        clean_key = clean_key.translate(_AR_KEY_NORMALIZE)
        if not clean_key:
            continue
        if not val or str(val).strip() in ("null", "None", ""):
            result[clean_key] = None
            continue

        # Step 1 & 2: strip + digit normalization
        normalized = str(val).strip().translate(_DIGIT_TABLE)

        # Step 3: phone-specific cleanup
        if _PHONE_KEY.search(clean_key):
            normalized = _fix_phone(normalized)
        # Step 4: date-specific cleanup
        elif _DATE_KEY.search(clean_key):
            normalized = _fix_date(normalized)

        result[clean_key] = normalized
    return result


def _fix_phone(val: str) -> str:
    """
    Normalize phone number to Palestinian format: exactly 10 digits, prefix 059 or 056.

    Safe auto-corrections applied:
    - Strip spaces, dashes, dots, parentheses
    - 9 digits starting with 59 → prepend 0 → 059xxxxxxx
    - 9 digits starting with 56 → prepend 0 → 056xxxxxxx

    Logs a warning when result doesn't match the expected 059/056 10-digit format.
    Returns best-effort cleaned string even when invalid (never silently drops data).
    """
    cleaned = _DIGITS_ONLY.sub("", val)
    if not cleaned:
        return val

    # Auto-correct missing leading zero (common OCR error)
    if len(cleaned) == 9 and cleaned[:2] in ('59', '56'):
        cleaned = '0' + cleaned

    # Valid Palestinian mobile: exactly 10 digits, starts with 059 or 056
    if len(cleaned) == 10 and cleaned[:3] in _VALID_PHONE_PREFIXES:
        return cleaned

    # Log the deviation — keep data visible rather than silently dropping it
    if len(cleaned) != 10:
        logger.warning(f"[Phone] Incorrect length ({len(cleaned)} digits, expected 10): '{cleaned}'")
    elif cleaned[:3] not in _VALID_PHONE_PREFIXES:
        logger.warning(f"[Phone] Invalid prefix '{cleaned[:3]}' (expected 059 or 056): '{cleaned}'")

    return cleaned if len(cleaned) >= 7 else val


def _fix_date(val: str) -> str:
    """
    Normalize a date value:
    - Strip ONLY Latin letters (A-Za-z) — OCR noise like "K" in "198K4".
      Arabic characters are NEVER stripped (month names, Arabic text in date cells).
    - Standardize separators (- . space) → /
    - Reformat to YYYY/M/D when year is at the end (D/M/YYYY → YYYY/M/D).
      Uses month≤12 heuristic to correctly identify which part is month vs day.
    - Falls back to the cleaned (separator-normalized) value on any ambiguity.
    """
    stripped = val.strip()

    # Strip ONLY Latin letters (e.g. "K", "L") — OCR noise.
    # Arabic characters (month names, etc.) are preserved.
    latin = re.findall(r'[A-Za-z]', stripped)
    if latin:
        logger.warning(
            f"[Date] Latin letter(s) in date field (OCR noise): {latin!r} in '{stripped}' — stripping"
        )
        stripped = re.sub(r'[A-Za-z]', '', stripped).strip()

    # Replace dashes, dots, spaces used as date separators with /
    normalized = re.sub(r'[\-\.\s]+', '/', stripped)
    normalized = re.sub(r'/+', '/', normalized).strip('/')

    # Reorder to YYYY/M/D when a 4-digit year is at the END (D/M/YYYY convention)
    # Arabic handwriting forms use D/M/YYYY — e.g. 15/5/2005 → 2005/5/15
    parts = normalized.split('/')
    if len(parts) == 3:
        year_idx = next(
            (i for i, p in enumerate(parts) if re.match(r'^(19\d{2}|20[012]\d)$', p.strip())),
            None
        )
        if year_idx == 2:
            # Year is last — assume D/M/YYYY Arabic convention
            a, b, year = parts[0].strip(), parts[1].strip(), parts[2].strip()
            a_int = int(a) if a.isdigit() else 0
            b_int = int(b) if b.isdigit() else 0
            if a_int > 12 and b_int <= 12:
                # a is definitely day (>12), b is month
                normalized = f"{year}/{b}/{a}"
            elif b_int > 12 and a_int <= 12:
                # b is definitely day (>12), a is month
                normalized = f"{year}/{a}/{b}"
            else:
                # Both ≤12 — assume Arabic D/M/YYYY: first=day, second=month
                normalized = f"{year}/{b}/{a}"

    # Sanity check — if we lost the year, fall back
    if not re.search(r'(19\d{2}|20[012]\d)', normalized):
        if re.search(r'(19\d{2}|20[012]\d)', stripped):
            return stripped
        return val

    return normalized


def _fail(error: str) -> dict:
    logger.error(f"[Gemini] {error}")
    return {"success": False, "participants": [], "column_order": [], "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"), "error": error}


