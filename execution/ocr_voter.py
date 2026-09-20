"""
OCR Field-Level Majority Voter

Three OCR engines (Gemini, Azure, Vision) each read the document independently.
For each participant name field this module:

  1. Collects all three raw candidates
  2. Normalises Arabic text (diacritics, alef/hamza variants, extra whitespace)
  3. Votes:
       Unanimous  (all 3 normalise to same)  → use Gemini's exact form
       Majority   (any 2 agree)              → use the agreeing pair's preferred form
       All differ                            → pick by dict_score × 0.6 + confidence × 0.4
"""

from __future__ import annotations

import difflib
import logging
import re

logger = logging.getLogger(__name__)


# ── Arabic normalisation ──────────────────────────────────────────────────────

_DIACRITICS = re.compile(r"[\u064B-\u065F\u0670]")   # tanwin, shadda, kasra, etc.
_ALEF_VARS  = re.compile(r"[أإآٱ]")


def normalize_arabic(s: str) -> str:
    """Strip diacritics and normalise alef/hamza variants, collapse whitespace."""
    s = _DIACRITICS.sub("", s)
    s = _ALEF_VARS.sub("ا", s)
    return " ".join(s.split())


# ── Arabic name vocabulary ────────────────────────────────────────────────────
# Used as a tiebreaker when all three engines disagree.
# The dict_score function returns the fraction of name tokens found here.

ARABIC_NAMES_VOCAB: frozenset[str] = frozenset({
    # Common masculine first names
    "احمد", "محمد", "علي", "عمر", "حسن", "حسين", "خالد", "سعيد", "سعد",
    "يوسف", "عيسى", "موسى", "داود", "سليمان", "يحيى", "ناصر", "مروان",
    "طارق", "وليد", "حامد", "جمال", "كمال", "رشيد", "صالح", "ادريس",
    "بلال", "انس", "نواف", "فيصل", "عادل", "حمد", "راشد", "سلطان",
    "زياد", "كريم", "امين", "نضال", "باسم", "غازي", "ماجد", "نزار",
    "ياسر", "وائل", "عصام", "رامي", "سامي", "هاني", "هشام", "عمار",
    "محمود", "مصطفى", "ابراهيم", "اسماعيل", "يعقوب", "ادم",
    "نوح", "عزيز", "مجيد", "رشاد", "شاكر", "شريف", "حكيم", "لطيف",
    "منير", "بشير", "سمير", "زكريا", "صفوان", "سيف", "ثابت",
    "حمزة", "مالك", "ايوب", "صهيب", "حارث", "معاذ", "انس",
    "جابر", "عوض", "مبارك", "فرج", "مختار", "ربيع", "عابد",
    # Common feminine first names
    "فاطمة", "عائشة", "خديجة", "مريم", "زينب", "سارة", "نور", "ليلى",
    "هند", "امل", "رنا", "دنيا", "سلمى", "هدى", "لينا", "ريم", "رهف",
    "غدير", "شيماء", "نادية", "سناء", "وفاء", "هناء", "ايمان", "رانيا",
    "منى", "دعاء", "سماح", "رشا", "ميسم", "ميساء", "ميادة", "جنى",
    "رلى", "تالا", "يارا", "لجين", "بسمة", "ابتسام", "احلام", "انتصار",
    "حنان", "نجوى", "روان", "شهد", "الاء", "رغد", "ابرار", "بيان",
    "صفاء", "عبير", "هيفاء", "ريحانة", "نجاة", "سعدية", "مسرة",
    # Name particles and divine name components
    "عبد", "الله", "الرحمن", "الرحيم", "العزيز", "الكريم", "الحميد",
    "الجبار", "الوهاب", "القادر", "اللطيف", "المجيد", "الرشيد", "الحفيظ",
    "الغني", "الودود", "الماجد", "الواحد", "الصمد", "القوي", "المتين",
    "الحسين", "الحسن", "النبي", "الرسول", "النور", "الهادي",
    # Prefixes / particles
    "ابو", "ابي", "ال", "بن", "بنت", "ام", "اسم", "محمد",
    # Common family name tokens
    "الزهراني", "الغامدي", "الشهري", "الحربي", "العمري", "الشمري",
    "العتيبي", "القحطاني", "المطيري", "السبيعي", "الدوسري", "الرشيدي",
    "البلوي", "الرويلي", "الحجيلي", "الزبيدي", "الجهني", "العنزي",
    "الرشيد", "الخالدي", "الحمد", "المحمد", "العلي", "الحسن",
    "حجاوي", "المومني", "الزعبي", "الزيود", "البطاينة", "الطراونة",
    "الخطيب", "عودة", "حمدان", "سلامة", "عيسى", "موسى", "عواد",
    "مرقة", "قطناني", "حداد", "كيلاني", "نعسان", "برهوم", "ضيف",
})


def _load_full_vocab() -> frozenset[str]:
    """
    Build vocab from THREE sources, layered:
      1. Hardcoded ARABIC_NAMES_VOCAB baseline (always available)
      2. Local JSON dictionaries shipped with the deployment
      3. Promoted name_candidates from Supabase (the only learned source that
         survives Modal container recycles — local JSON writes are ephemeral)

    Cached at module level after first load.
    """
    import json
    from pathlib import Path
    _data = Path(__file__).parent / "data"
    merged: set[str] = set(ARABIC_NAMES_VOCAB)

    # ── Source 2: shipped JSON dictionaries ───────────────────────────────────
    # Vocabulary comes from OUR OWN approved training labels, not generic Arabic
    # name lists.  Measured on the frozen 400 held-out names (2026-08-24), the
    # generic lists covered 71.0% of the words trainers actually type while the
    # training-derived vocab covers 92.7% at a third of the size — and a smaller,
    # tighter vocab is what makes an unknown word a meaningful signal.
    # The old lists are kept in data/_archive/ and are no longer loaded.
    # Rebuild arabic_names_training.json with: python execution/build_name_vocab.py
    for fname in ("arabic_names_training.json", "arabic_names_learned.json"):
        p = _data / fname
        if p.exists():
            try:
                entries = json.loads(p.read_text(encoding="utf-8"))
                for e in entries:
                    # Normalise and split multi-word entries (e.g. "أبو حرب" → "ابو", "حرب")
                    for tok in normalize_arabic(str(e)).split():
                        if len(tok) >= 2:
                            merged.add(tok)
            except Exception:
                pass

    # ── Source 3: promoted name_candidates from Supabase ──────────────────────
    # This is the only source for names learned from user corrections that
    # survives container recycles — local JSON file writes from promote() do
    # not persist in serverless. Best-effort: skip silently if Supabase not
    # available (e.g. in unit tests).
    try:
        import os
        url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if url and key:
            from supabase import create_client
            sb = create_client(url, key)
            rows = (
                sb.table("name_candidates")
                .select("name")
                .eq("status", "accepted")
                .eq("promoted", True)
                .execute()
                .data
                or []
            )
            for r in rows:
                name = (r.get("name") or "").strip()
                if not name:
                    continue
                for tok in normalize_arabic(name).split():
                    if len(tok) >= 2:
                        merged.add(tok)
    except Exception:
        pass

    return frozenset(merged)


_FULL_VOCAB: frozenset[str] | None = None


def dict_score(name: str) -> float:
    """Fraction of normalised name tokens found in the full Arabic names vocab (0–1).

    Loads execution/data/arabic_names_{male,female}.json + arabic_family_names.json
    on first call, then caches the result. Falls back to the hardcoded
    ARABIC_NAMES_VOCAB if the files are missing.
    """
    global _FULL_VOCAB
    if _FULL_VOCAB is None:
        _FULL_VOCAB = _load_full_vocab()
    tokens = [t for t in normalize_arabic(name).split() if len(t) >= 2]
    if not tokens:
        return 0.0
    hits = sum(1 for t in tokens if t in _FULL_VOCAB)
    return hits / len(tokens)


# ── Vision name candidate extraction ─────────────────────────────────────────

def extract_vision_name_candidates(vision_text: str) -> list[str]:
    """
    Extract Arabic-dominant lines from Vision plain text as potential name strings.

    Filters out lines that contain digits/pipes (phone numbers, table separators,
    dates) and keeps only lines with ≥ 60 % Arabic characters and 1–8 words.
    """
    candidates: list[str] = []
    for line in (vision_text or "").splitlines():
        line = line.strip()
        if not line or len(line) < 2:
            continue
        no_space = line.replace(" ", "")
        if not no_space:
            continue
        ar_chars = sum(1 for c in no_space if "\u0600" <= c <= "\u06FF")
        if ar_chars / len(no_space) < 0.60:
            continue
        # Strip digits, separators, brackets — names don't have these
        clean = re.sub(r"[\d|/\\\-_()\[\]{}<>]", "", line).strip()
        clean = " ".join(clean.split())
        if clean and 1 <= len(clean.split()) <= 8:
            candidates.append(clean)
    return candidates


def extract_vision_names_sequential(vision_text: str, n_rows: int) -> list[str]:
    """
    Extract participant names from Vision plain text in document order.

    Arabic registration forms in Vision output typically contain:
      • Top section:   program headers, institution names, column headers
      • Middle:        partial data (first-name-only cells, consent marks, phone numbers)
      • Bottom:        full participant name rows  (name + date + gender on same line)

    Strategy:
      1. Clean each line: strip digits, dates, gender markers, punctuation
      2. Keep lines that are 2–7 Arabic words and ≥ 72 % Arabic characters
      3. Skip known header / approval patterns
      4. Take the LAST n_rows valid lines — participant names always follow headers

    Returns a list of exactly n_rows strings; positions with no Vision reading = "".
    """
    _SKIP = re.compile(
        r"برنامج|توقيع|اسم الشريك|اسم المؤسسة|التجمع|المحافظة"
        r"|تاريخ الميلاد|الفئة|إعاقة|هل لديك|استخدام|الموافقة على"
        r"|التوثيق|يرجى العلم|مركز البرامج|ساحات|رقم التواصل"
        r"|الإجتماعي|اجتماعي|النوع الإجتماعي",
        re.I,
    )
    _APPROVAL = re.compile(r"^(موا|فوا|جوا|زلر|مواع|مواجه|مواق)", re.I)
    _GENDER   = re.compile(
        r"\b(ذكر|انثى|أنثى|WT|CL|آتی|آنر|اول\s*انه|ذکر|انه)\b", re.I
    )

    candidates: list[str] = []
    for line in (vision_text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if _SKIP.search(line):
            continue
        if _APPROVAL.match(line):
            continue
        # Clean: strip digits, gender markers, punctuation
        clean = re.sub(r"\d", "", line)
        clean = _GENDER.sub("", clean)
        clean = re.sub(r"[/\-\.\(\)\[\]:،,]", " ", clean)
        clean = " ".join(clean.split())
        if not clean:
            continue
        no_space = clean.replace(" ", "")
        if not no_space:
            continue
        ar = sum(1 for c in no_space if "\u0600" <= c <= "\u06FF")
        if ar / len(no_space) < 0.72:
            continue
        words = clean.split()
        if not (2 <= len(words) <= 7):
            continue
        candidates.append(clean)

    if n_rows <= 0:
        return []

    # Participant rows are always the LAST n_rows valid lines
    tail = candidates[-n_rows:] if len(candidates) >= n_rows else candidates

    # Build result list; missing positions stay as ""
    result = [""] * n_rows
    offset = n_rows - len(tail)   # pad front when Vision extracted fewer rows
    for i, name in enumerate(tail):
        result[offset + i] = name
    return result


# ── Per-field vote ────────────────────────────────────────────────────────────

def vote_on_name(
    candidates: dict[str, str],
    confs: dict[str, float],
) -> tuple[str, str]:
    """
    Vote on the best name string among (up to) three OCR candidates.

    Args:
        candidates:  {"gemini": "...", "azure": "...", "vision": "..."}
        confs:       unused — kept for API compatibility

    Returns:
        (winner_text, method)

    Logic runs per token position (first name → second → third → family):
        • All 3 agree on token   → unanimous, use Gemini form
        • 2 agree on token       → majority wins that position
        • All 3 differ on token  → Vision wins that position
    The voted tokens are joined into the final name.
    """
    from collections import defaultdict

    # Drop None / empty
    valid = {k: v for k, v in candidates.items() if v and v.strip()}
    if not valid:
        return "", "empty"
    if len(valid) == 1:
        k, v = next(iter(valid.items()))
        return v, f"single_{k}"

    # ── Token-level split ──────────────────────────────────────────────────────
    # original form (for output) and normalised form (for comparison only)
    split_orig: dict[str, list[str]] = {k: v.split()                      for k, v in valid.items()}
    split_norm: dict[str, list[str]] = {k: [normalize_arabic(t) for t in tokens]
                                        for k, tokens in split_orig.items()}

    # Target length = longest candidate (shorter engines have no candidate for
    # later positions; those positions fall through to Vision / next priority)
    target_len = max(len(t) for t in split_orig.values())

    voted_tokens: list[str] = []
    methods: list[str]      = []

    for pos in range(target_len):
        # Collect orig / norm tokens at this position from each engine
        pos_orig: dict[str, str] = {}
        pos_norm: dict[str, str] = {}
        for k in valid:
            o_toks = split_orig[k]
            n_toks = split_norm[k]
            if pos < len(o_toks):
                pos_orig[k] = o_toks[pos]
                pos_norm[k] = n_toks[pos]

        if not pos_orig:
            continue

        if len(pos_orig) == 1:
            k, v = next(iter(pos_orig.items()))
            voted_tokens.append(v)
            methods.append(f"single_{k}")
            continue

        # Group engines by normalised token value
        norm_to_engines: dict[str, list[str]] = defaultdict(list)
        for k, norm_t in pos_norm.items():
            norm_to_engines[norm_t].append(k)

        if len(norm_to_engines) == 1:
            # ── All agree on this token ────────────────────────────────────
            winner_norm = next(iter(norm_to_engines))
            winning_engines = norm_to_engines[winner_norm]
            for preferred in ("gemini", "azure", "vision"):
                if preferred in winning_engines:
                    voted_tokens.append(pos_orig[preferred])
                    methods.append("unanimous")
                    break

        else:
            # Find the normalised token that the most engines agree on
            best_norm = max(norm_to_engines, key=lambda x: len(norm_to_engines[x]))
            best_engines = norm_to_engines[best_norm]

            if len(best_engines) >= 2:
                # ── Majority: 2+ engines agree on this token ───────────────
                for preferred in ("gemini", "azure", "vision"):
                    if preferred in best_engines:
                        voted_tokens.append(pos_orig[preferred])
                        methods.append(f"majority({'&'.join(sorted(best_engines))})")
                        break
            else:
                # ── All differ on this token → dictionary first, then Vision ──
                # User-requested rule: when no two engines agree, first ask the
                # name dictionary. If exactly one (or more) candidates is in the
                # vocab, prefer the dict-matching one(s). If none match the dict
                # (or several do — ambiguous), fall back to Vision priority.
                vocab = _load_full_vocab()
                dict_hits = {
                    k: pos_orig[k]
                    for k, n in pos_norm.items()
                    if n in vocab
                }
                if len(dict_hits) == 1:
                    # Exactly one candidate is in the dictionary — clear winner.
                    k, v = next(iter(dict_hits.items()))
                    voted_tokens.append(v)
                    methods.append(f"dict_{k}")
                else:
                    # No single dict winner (zero hits OR multiple hits) →
                    # fall back to Vision priority. Among multi-hit ties this
                    # picks Vision's reading if it was one of the dict matches.
                    pool = dict_hits if dict_hits else pos_orig
                    for preferred in ("vision", "azure", "gemini"):
                        if preferred in pool:
                            voted_tokens.append(pool[preferred])
                            methods.append(
                                f"{'dict_tie_' if dict_hits else 'priority_'}{preferred}"
                            )
                            break

    if not voted_tokens:
        return next(iter(valid.values())), "fallback"

    result = " ".join(voted_tokens)

    # Summarise method for logging
    if all(m == "unanimous" for m in methods):
        summary = "unanimous"
    elif any("majority" in m for m in methods):
        summary = "token_majority"
    elif any("priority" in m for m in methods):
        summary = "token_priority"
    else:
        summary = "token_vote"

    logger.debug(f"[Voter] token vote | {list(zip(range(len(methods)), methods))} → «{result}»")
    return result, summary


# ── Row-level voting entry point ──────────────────────────────────────────────

def vote_participants(
    structured_data: list[dict],
    name_cols: list[str],
    gemini_raw_names: dict[int, str],
    azure_raw_names: dict[int, str],
    vision_text: str,
    azure_conf: float = 0.0,
) -> tuple[list[dict], dict]:
    """
    Apply field-level majority voting to name columns in structured_data.

    Vision names are extracted SEQUENTIALLY (positional) from Vision's plain text,
    not by per-row similarity search.  This avoids misalignment when the reference
    engine has a wrong name — the old similarity approach would then find the wrong
    Vision candidate and could reuse the same candidate for multiple rows.

    Args:
        structured_data:   Final structured participants (list of field dicts).
        name_cols:         Column headers that contain participant names.
        gemini_raw_names:  Row-indexed names extracted from Gemini pipe-text.
        azure_raw_names:   Row-indexed names extracted from Azure grid_text.
        vision_text:       Raw Vision OCR plain text.
        azure_conf:        Average Azure read word confidence (0–1).  (kept for
                           compatibility; no longer used in all-disagree tiebreak)

    Returns:
        (updated_structured_data, stats_dict)
    """
    n_rows = len(structured_data)
    # Extract Vision names once, in document order, mapped 1-to-1 to row indices
    vision_seq: list[str] = extract_vision_names_sequential(vision_text, n_rows)
    confs = {"gemini": 0.0, "azure": azure_conf, "vision": 0.0}

    stats: dict[str, int] = {
        "unanimous": 0,
        "majority":  0,
        "priority":  0,
        "single":    0,
        "token":     0,    # token-level vote (token_majority / token_priority / dict_*)
        "unchanged": 0,
        "rejected":  0,    # voter winner failed alignment safety gate
        "empty":     0,
    }
    result: list[dict] = []

    def _row_aligned(winner: str, current: str) -> bool:
        """Safety gate: confirm the voted winner is talking about the SAME row
        as Azure Layout's current cell. Required because Vision/Azure-Read row
        indexing can be off by one (Vision compresses headers, Azure splits
        spanning cells), and token-by-token voting will then mash tokens from
        adjacent rows together. We require ≥50% of current's tokens to appear
        (after Arabic normalisation) in the winner — proves both are reading
        the same person. If `current` is empty we accept any winner."""
        cur_norm = normalize_arabic(current)
        win_norm = normalize_arabic(winner)
        if not cur_norm:
            return True
        cur_toks = {t for t in cur_norm.split() if len(t) >= 2}
        if not cur_toks:
            return True
        win_toks = set(win_norm.split())
        shared   = cur_toks & win_toks
        return len(shared) / len(cur_toks) >= 0.5

    for row_idx, participant in enumerate(structured_data):
        new_row = dict(participant)

        for name_col in name_cols:
            current = (participant.get(name_col) or "").strip()

            # Three independent OCR readings (all positional — no similarity search)
            gem_name = (gemini_raw_names.get(row_idx) or "").strip()
            az_name  = (azure_raw_names.get(row_idx) or "").strip()
            vis_name = (vision_seq[row_idx] if row_idx < len(vision_seq) else "").strip()

            candidates = {"gemini": gem_name, "azure": az_name, "vision": vis_name}
            winner, method = vote_on_name(candidates, confs)

            # If all candidates were empty, keep the current structured value
            if not winner:
                winner = current
                method = "empty"

            # Bucket stats — collapse token_*/dict_* into "token", priority_* into "priority"
            if method.startswith("token") or method.startswith("dict"):
                method_key = "token"
            elif method.startswith("priority"):
                method_key = "priority"
            elif method.startswith("majority"):
                method_key = "majority"
            elif method.startswith("single"):
                method_key = "single"
            else:
                method_key = method if method in stats else "unchanged"

            if winner and winner != current:
                # Alignment safety gate — reject voter wins that look like
                # they came from a misaligned row.
                if not _row_aligned(winner, current):
                    logger.info(
                        f"[Voter] row={row_idx} col={name_col!r} | REJECTED ({method}) | "
                        f"«{current}» ⇄ «{winner}» — alignment <50% token overlap"
                    )
                    stats["rejected"] += 1
                else:
                    new_row[name_col] = winner
                    logger.info(
                        f"[Voter] row={row_idx} col={name_col!r} | {method} | "
                        f"«{current}» → «{winner}» | "
                        f"gem=«{gem_name}» az=«{az_name}» vis=«{vis_name}»"
                    )
                    stats[method_key] = stats.get(method_key, 0) + 1
            else:
                stats["unchanged"] += 1

        result.append(new_row)

    logger.info(
        f"[Voter] Done | rows={len(result)} name_cols={name_cols} | "
        + " ".join(f"{k}={v}" for k, v in stats.items() if v > 0)
    )
    return result, stats
