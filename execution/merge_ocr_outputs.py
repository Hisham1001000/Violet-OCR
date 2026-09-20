"""
execution/merge_ocr_outputs.py

Token-level merger for Azure + Gemini OCR outputs.

Problem: Azure and Gemini have *complementary* errors —
  Azure : high visual fidelity (reads what it sees), but may drop characters,
          swap dots, or hallucinate entire tokens for hard handwriting.
  Gemini: high linguistic validity (produces real Arabic words), but may skip
          a token, shift subsequent tokens left, or invent a plausible-sounding
          name that was never in the image.

Strategy (applied per name cell):
  1. Sequence-align the two token lists (DP, gap-aware).
     Finds anchor tokens where both engines agree, and identifies gaps where
     one engine dropped a token the other kept.
  2. Per-aligned-pair decision:
     a. Small confusion-distance  → Gemini made a plausible OCR correction → accept Gemini
     b. Moderate distance         → character-level merge: keep Gemini char only where
                                    the substitution is in the Arabic confusion table
     c. Large distance            → compare dictionary scores; visual anchor (Azure) wins
                                    ties and hallucination cases
  3. Token recovery: Azure tokens absent from Gemini that are dict-validated are
     re-inserted (Gemini dropped a real name token).
  4. Hallucination firewall: Gemini tokens with no visual basis in Azure AND no
     dictionary support are silently dropped.

For non-name columns (phone, date, number) Azure is used directly — digit
precision is more reliable from Azure.

Called at Stage 3.4 in process_document.py when both OCR engines ran.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)


# ── Arabic character confusion matrix ─────────────────────────────────────────
# Keyed by (char_a, char_b) — order does not matter (_sub_cost checks both).
# Value = substitution cost [0.0 = identical, 1.0 = completely unrelated].
# Low cost  → common OCR confusion → Gemini may have correctly fixed it.
# High cost → visually unrelated  → Gemini likely hallucinated.

_C: dict[tuple[str, str], float] = {
    # Alef variants (hamza position, madda) — very common confusion
    ("ا", "أ"): 0.05, ("ا", "إ"): 0.05, ("ا", "آ"): 0.05, ("ا", "ٱ"): 0.05,
    ("أ", "إ"): 0.08, ("أ", "آ"): 0.08, ("إ", "آ"): 0.08,
    # Dot count — ba/ta/tha same base stroke
    ("ب", "ت"): 0.15, ("ب", "ث"): 0.25, ("ت", "ث"): 0.15,
    ("ب", "ن"): 0.30,  # final/isolated form similarity
    # Interior dot — ha/ja/kha identical bowl
    ("ح", "ج"): 0.10, ("ح", "خ"): 0.10, ("ج", "خ"): 0.10,
    # Right-tail dot — ra/za
    ("ر", "ز"): 0.10,
    # Dal/dhal
    ("د", "ذ"): 0.10,
    # Sin/shin — wave + dot cluster
    ("س", "ش"): 0.15,
    # Sad/dad — tail extension
    ("ص", "ض"): 0.15,
    # Emphatic ta/dha
    ("ط", "ظ"): 0.10,
    # Ain/ghain — interior dot
    ("ع", "غ"): 0.10,
    # Fa/qa — dot count
    ("ف", "ق"): 0.20,
    # Ha/ta-marbuta — final stroke
    ("ه", "ة"): 0.08,
    # Ya variants — dots below / absent
    ("ي", "ى"): 0.05, ("ي", "ئ"): 0.15, ("ى", "ئ"): 0.15,
    # Waw / waw-with-hamza
    ("و", "ؤ"): 0.08,
    # Arabic kaf vs Persian kaf (Unicode U+0643 vs U+06A9)
    ("ك", "ک"): 0.05,
    # Alef-lam splits in family names (المصري → ا + ل confusion)
    ("ل", "ا"): 0.25,
    # Nun/ya can look alike in fast handwriting
    ("ن", "ي"): 0.30,
    # Mim/fa — occasional confusion
    ("م", "ف"): 0.45,
    # Qaf/kaf
    ("ق", "ك"): 0.35,
}

# Harakat (diacritics) pattern — stripped for comparison
_HARAKAT = re.compile(r"[\u064B-\u065F\u0670]")
# Normalise all alef variants to bare alef for comparison only
_ALEF_MAP = str.maketrans("أإآٱ", "اااا")


def _norm(s: str) -> str:
    """Strip diacritics and normalise alef variants (comparison only)."""
    return _HARAKAT.sub("", s).translate(_ALEF_MAP).strip()


def _sub_cost(c1: str, c2: str) -> float:
    """Substitution cost between two Arabic characters."""
    if c1 == c2:
        return 0.0
    for pair in ((c1, c2), (c2, c1)):
        if pair in _C:
            return _C[pair]
    # Both Arabic but not in confusion table → likely unrelated
    if "\u0600" <= c1 <= "\u06FF" and "\u0600" <= c2 <= "\u06FF":
        return 0.75
    return 1.0


# ── Character-level edit distance with confusion costs ─────────────────────────

def _char_edit_dist(s1: str, s2: str) -> float:
    """
    Edit distance with confusion-matrix substitution costs.
    Gap cost = 0.5  (Azure often drops chars; partial penalty preferred over 1.0).
    Both strings are normalised before comparison.
    """
    a, b = _norm(s1), _norm(s2)
    n, m = len(a), len(b)
    if n == 0:
        return m * 0.5
    if m == 0:
        return n * 0.5

    prev = [j * 0.5 for j in range(m + 1)]
    for i in range(1, n + 1):
        curr = [i * 0.5] + [0.0] * m
        for j in range(1, m + 1):
            curr[j] = min(
                prev[j]     + 0.5,                        # delete (gap in b)
                curr[j - 1] + 0.5,                        # insert (gap in a)
                prev[j - 1] + _sub_cost(a[i - 1], b[j - 1]),  # substitute
            )
        prev = curr
    return prev[m]


def _token_sim(t1: str, t2: str) -> float:
    """Normalised similarity score: 0.0 = identical, 1.0 = completely different."""
    if not t1 and not t2:
        return 0.0
    d = _char_edit_dist(t1, t2)
    return d / max(len(_norm(t1)), len(_norm(t2)), 1)


# ── Token sequence alignment ───────────────────────────────────────────────────

def _align_sequences(
    a_toks: list[str],
    g_toks: list[str],
) -> list[tuple[str | None, str | None]]:
    """
    Global DP sequence alignment of two token lists.

    GAP_COST = 0.55 — slightly less than "unrelated Arabic" similarity (0.75),
    so the aligner prefers leaving a token unmatched over forcing a bad match.

    Returns [(azure_tok_or_None, gemini_tok_or_None), ...]
    None on either side means the other engine had a gap at that position.
    """
    GAP = 0.55
    n, m = len(a_toks), len(g_toks)

    # DP cost matrix + back-pointer matrix
    dp   = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[""] * (m + 1) for _ in range(n + 1)]

    for i in range(1, n + 1):
        dp[i][0]   = i * GAP
        back[i][0] = "up"
    for j in range(1, m + 1):
        dp[0][j]   = j * GAP
        back[0][j] = "left"

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            diag = dp[i - 1][j - 1] + _token_sim(a_toks[i - 1], g_toks[j - 1])
            up   = dp[i - 1][j]     + GAP   # gap in Gemini (Azure has extra tok)
            left = dp[i][j - 1]     + GAP   # gap in Azure  (Gemini has extra tok)
            best = min(diag, up, left)
            dp[i][j] = best
            back[i][j] = "diag" if best == diag else ("up" if best == up else "left")

    # Traceback
    result: list[tuple[str | None, str | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i == 0:
            result.append((None, g_toks[j - 1])); j -= 1
        elif j == 0:
            result.append((a_toks[i - 1], None)); i -= 1
        elif back[i][j] == "diag":
            result.append((a_toks[i - 1], g_toks[j - 1])); i -= 1; j -= 1
        elif back[i][j] == "up":
            result.append((a_toks[i - 1], None)); i -= 1
        else:
            result.append((None, g_toks[j - 1])); j -= 1

    return list(reversed(result))


# ── Character-level merge ──────────────────────────────────────────────────────

def _char_merge(azure_tok: str, gemini_tok: str) -> str:
    """
    Character-level merge for moderately different tokens.

    Azure is the visual anchor. Gemini's character at each position is accepted
    only when the substitution cost from Azure's character is in the confusion
    table (cost < 0.5).  Otherwise Azure's character is kept.

    Gemini-only characters (insertions with no Azure basis) are dropped.
    Azure-only characters (deletions) are kept — Azure's visual evidence wins.
    """
    a = _norm(azure_tok)
    g = _norm(gemini_tok)
    n, m = len(a), len(g)
    if n == 0:
        return gemini_tok
    if m == 0:
        return azure_tok

    # Build DP matrix with explicit choice tracking
    MATCH, DEL, INS = 0, 1, 2
    dp     = [[0.0] * (m + 1) for _ in range(n + 1)]
    choice = [[MATCH] * (m + 1) for _ in range(n + 1)]

    for i in range(n + 1):
        dp[i][0] = i * 0.5
        choice[i][0] = DEL
    for j in range(m + 1):
        dp[0][j] = j * 0.5
        choice[0][j] = INS

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            costs = [
                dp[i - 1][j - 1] + _sub_cost(a[i - 1], g[j - 1]),  # MATCH/SUB
                dp[i - 1][j]     + 0.5,                              # DEL (Azure gap)
                dp[i][j - 1]     + 0.5,                              # INS (Gemini gap)
            ]
            best_idx  = int(min(range(3), key=lambda k: costs[k]))
            dp[i][j]     = costs[best_idx]
            choice[i][j] = best_idx

    # Traceback: build merged string
    merged: list[str] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i == 0:
            j -= 1   # Gemini-only char — no Azure basis → drop
            continue
        if j == 0:
            merged.append(a[i - 1])   # Azure-only char → keep (visual anchor)
            i -= 1
            continue
        c = choice[i][j]
        if c == MATCH:
            cost = _sub_cost(a[i - 1], g[j - 1])
            # Accept Gemini's char only if the confusion cost is low
            merged.append(g[j - 1] if cost < 0.5 else a[i - 1])
            i -= 1; j -= 1
        elif c == DEL:
            merged.append(a[i - 1])   # Keep Azure char
            i -= 1
        else:
            j -= 1   # Skip Gemini char — not supported by Azure's visual evidence

    return "".join(reversed(merged)) or azure_tok


# ── Dictionary nearness ────────────────────────────────────────────────────────

def _dict_near(token: str, name_set: set[str], name_list: list[str]) -> float:
    """
    Nearness to the name dictionary: 0.0 = no match, 1.0 = exact.
    Fast path: exact check.  Fallback: difflib top-1 fuzzy match.
    """
    t = _norm(token)
    if not t:
        return 0.0
    if t in name_set:
        return 1.0
    import difflib
    close = difflib.get_close_matches(t, name_list, n=1, cutoff=0.65)
    if close:
        return 1.0 - _token_sim(t, close[0])
    return 0.0


# ── Per-aligned-pair decision ─────────────────────────────────────────────────

def _decide_pair(
    a_tok: str | None,
    g_tok: str | None,
    name_set: set[str],
    name_list: list[str],
) -> tuple[str, str]:
    """
    Decide the best token for one aligned pair.
    Returns (token, source) where source ∈ {azure, gemini, merged, azure_recovered, dropped}.
    """
    if not a_tok and not g_tok:
        return "", "empty"

    # ── One side is a gap ────────────────────────────────────────────────────
    if a_tok is None:
        # Azure has no token here — Gemini added one.
        # Accept only if dictionary-validated (otherwise likely hallucination).
        score = _dict_near(g_tok, name_set, name_list)
        return (g_tok, "gemini") if score >= 0.60 else ("", "dropped")

    if g_tok is None:
        # Gemini dropped a token Azure has.
        # Recover if it is dictionary-validated.
        score = _dict_near(a_tok, name_set, name_list)
        return (a_tok, "azure_recovered") if score >= 0.50 else (a_tok, "azure")

    # ── Both have a token ───────────────────────────────────────────────────
    sim = _token_sim(a_tok, g_tok)

    if sim < 0.30:
        # Very similar — Gemini made confusion-table-type corrections → accept Gemini
        return g_tok, "gemini"

    if sim < 0.65:
        # Moderate difference — character-level merge preserves Azure's visual anchor
        merged = _char_merge(a_tok, g_tok)
        return merged, "merged"

    # Large difference — Gemini likely hallucinated something different
    g_score = _dict_near(g_tok, name_set, name_list)
    a_score = _dict_near(a_tok, name_set, name_list)

    if g_score >= 0.70 and g_score > a_score + 0.15:
        # Gemini is clearly more dict-valid — but still require SOME visual overlap
        # to guard against "real Arabic word that is completely wrong"
        if sim < 0.85:
            return g_tok, "gemini"
        # sim ≥ 0.85: completely different shapes → visual anchor wins
        return a_tok, "azure"

    if a_score >= 0.60 and a_score > g_score + 0.15:
        return a_tok, "azure"

    # Tie or both weak → visual anchor principle: prefer Azure
    return a_tok, "azure"


# ── Name cell merger ───────────────────────────────────────────────────────────

def _merge_name_cell(
    azure_cell:  str,
    gemini_cell: str,
    name_set:    set[str],
    name_list:   list[str],
    family_set:  set[str],
    family_list: list[str],
) -> str:
    """
    Merge a 4-part Arabic name cell from Azure and Gemini readings.

    Algorithm:
      1. Tokenise both readings.
      2. Global DP token-sequence alignment (finds gaps / shifted tokens).
      3. For each aligned pair, decide using _decide_pair() with the appropriate
         dictionary (family names for the last token, given names for the rest).
      4. Drop empty results; join surviving tokens.

    Example (from discussion):
      Real:   "هدى سامي محمد المصري"
      Azure:  "دى سامي محمد سعادة الله"   ← dropped ه, hallucinated family name
      Gemini: "هدى محمد حسين المصرى"     ← dropped سامي, shifted, wrong token 3

      Alignment finds:
        (دى, هدى)           → sim small, Gemini wins → هدى
        (سامي, [gap])      → dict-validated Azure recovery → سامي
        (محمد, محمد)        → both agree → محمد
        (سعادة الله, المصرى) → Gemini near family-name dict → المصرى
                                 (then downstream dict normalization → المصري)
      Result: "هدى سامي محمد المصرى"
    """
    a_toks = azure_cell.split()
    g_toks = gemini_cell.split()

    if not a_toks:
        return gemini_cell
    if not g_toks:
        return azure_cell

    alignment = _align_sequences(a_toks, g_toks)
    result_toks: list[str] = []

    for idx, (a_tok, g_tok) in enumerate(alignment):
        # Use family names dictionary for the last token position
        is_last = (idx == len(alignment) - 1)
        cur_set  = family_set  if is_last else name_set
        cur_list = family_list if is_last else name_list

        tok, src = _decide_pair(a_tok, g_tok, cur_set, cur_list)
        if tok:
            result_toks.append(tok)
            logger.debug(
                "[MergeOCR] name pos=%d | azure=%r gemini=%r → %r (%s)",
                idx, a_tok, g_tok, tok, src,
            )

    return " ".join(result_toks) if result_toks else (azure_cell or gemini_cell)


# ── Column type detection ──────────────────────────────────────────────────────

_PHONE_H  = re.compile(r"هاتف|جوال|موبايل|تواصل|تلفون|phone|اتصال", re.I)
_DATE_H   = re.compile(r"تاريخ|ميلاد|ولاد|date|dob", re.I)
_NAME_H   = re.compile(r"اسم|name|المشارك|المستفيد|رباعي|ثلاثي", re.I)
_NUM_H    = re.compile(r"^#$|رقم.{0,8}تسلسل|عدد|كمية|مبلغ", re.I)


def _col_type(header: str) -> str:
    h = (header or "").strip()
    if _PHONE_H.search(h):  return "phone"
    if _DATE_H.search(h):   return "date"
    if _NUM_H.search(h):    return "number"
    if _NAME_H.search(h):   return "name"
    return "text"


# ── Cell-level dispatcher ──────────────────────────────────────────────────────

def _merge_cell(
    azure_val:   str,
    gemini_val:  str,
    col_type:    str,
    name_set:    set[str],
    name_list:   list[str],
    family_set:  set[str],
    family_list: list[str],
) -> str:
    a = (azure_val  or "").strip()
    g = (gemini_val or "").strip()

    if not a and not g:
        return ""
    if not a:
        return g
    if not g:
        return a

    if col_type == "phone":
        # Azure wins for digit strings; validate Palestinian phone format
        a_d = re.sub(r"\D", "", a)
        g_d = re.sub(r"\D", "", g)
        a_ok = len(a_d) == 10 and a_d[:3] in ("059", "056")
        g_ok = len(g_d) == 10 and g_d[:3] in ("059", "056")
        if g_ok and not a_ok:
            return g_d
        if a_ok:
            return a_d
        return g_d if len(g_d) > len(a_d) else a_d

    if col_type in ("date", "number"):
        return a  # Azure wins for structured numbers

    if col_type == "name":
        return _merge_name_cell(a, g, name_set, name_list, family_set, family_list)

    # text / unknown — Gemini preferred unless very different
    return g if _token_sim(a, g) < 0.70 else a


# ── Main entry point ───────────────────────────────────────────────────────────

# Module-level cache so name dicts are loaded only once per process
_name_list_cache:   list[str] | None = None
_family_list_cache: list[str] | None = None


def _get_name_lists() -> tuple[list[str], list[str]]:
    global _name_list_cache, _family_list_cache
    if _name_list_cache is None or _family_list_cache is None:
        from execution.extract_gemini import (
            _load_male_names_dict, _load_female_names_dict, _load_family_names_dict,
        )
        _, male_list   = _load_male_names_dict()
        _, female_list = _load_female_names_dict()
        # Combine male + female as the general given-name lookup
        _name_list_cache   = sorted(set(male_list) | set(female_list))
        _, _family_list_cache = _load_family_names_dict()
    return _name_list_cache, _family_list_cache


def merge_ocr_outputs(azure_text: str, gemini_text: str) -> str:
    """
    Merge Azure and Gemini pipe-separated OCR table outputs.

    For each row/cell:
      • Name cells   → token-sequence alignment + confusion-matrix character merge
      • Phone cells  → Azure (digit precision) with format validation
      • Date/number  → Azure directly
      • Text cells   → Gemini preferred unless visually inconsistent with Azure

    Returns merged pipe-separated text suitable for Gemini structuring (Stage 4).

    Returns empty string if both inputs lack table structure (caller should fall
    back to normal winner-selection logic).
    """
    if not azure_text or not gemini_text:
        return ""

    name_list, family_list = _get_name_lists()
    name_set   = {_norm(n) for n in name_list}
    family_set = {_norm(n) for n in family_list}
    norm_names   = [_norm(n) for n in name_list]
    norm_families = [_norm(n) for n in family_list]

    def _parse(text: str) -> list[list[str]]:
        rows = []
        for line in text.splitlines():
            s = line.strip()
            if "|" in s:
                rows.append([c.strip() for c in s.split("|")])
        return rows

    a_rows = _parse(azure_text)
    g_rows = _parse(gemini_text)

    if not a_rows or not g_rows:
        return ""

    # Detect column types from the header row (prefer whichever has more cols)
    header_row = g_rows[0] if len(g_rows[0]) >= len(a_rows[0]) else a_rows[0]
    col_types  = [_col_type(h) for h in header_row]

    merged_lines: list[str] = []
    cells_azure = cells_gemini = cells_merged = 0
    n_rows = max(len(a_rows), len(g_rows))

    for row_idx in range(n_rows):
        a_row = a_rows[row_idx] if row_idx < len(a_rows) else []
        g_row = g_rows[row_idx] if row_idx < len(g_rows) else []

        # Header row → always Gemini (better Arabic column names)
        if row_idx == 0:
            merged_lines.append(" | ".join(g_row or a_row))
            continue

        # Markdown separator rows (|---|---|) → skip
        if re.match(r"^[-|:\s]+$", "".join(g_row or a_row)):
            continue

        n_cols = max(len(a_row), len(g_row), len(col_types))
        merged_row: list[str] = []

        for col_idx in range(n_cols):
            a_val  = a_row[col_idx]  if col_idx < len(a_row)  else ""
            g_val  = g_row[col_idx]  if col_idx < len(g_row)  else ""
            ctype  = col_types[col_idx] if col_idx < len(col_types) else "text"

            result = _merge_cell(
                a_val, g_val, ctype,
                name_set, norm_names,
                family_set, norm_families,
            )
            merged_row.append(result)

            if a_val != g_val:
                if result == a_val:   cells_azure  += 1
                elif result == g_val: cells_gemini += 1
                else:                 cells_merged += 1

        merged_lines.append(" | ".join(merged_row))

    logger.info(
        "[MergeOCR] rows=%d | azure_wins=%d gemini_wins=%d char_merged=%d",
        n_rows, cells_azure, cells_gemini, cells_merged,
    )
    return "\n".join(merged_lines)
