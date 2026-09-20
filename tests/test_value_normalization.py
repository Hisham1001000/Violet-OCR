# -*- coding: utf-8 -*-
"""
Offline tests for gender value normalisation. No API calls, no credits.

The patterns live inside process_document.run_pipeline, which cannot be imported
without the pipeline's environment, so the block is lifted out of the source and
executed here. That means the test exercises the REAL patterns rather than a
copy that can drift.

Run: python test_value_normalization.py
"""
import io
import re
import sys
from pathlib import Path

# Repo root, resolved from this file rather than the current directory, so the
# test runs the same from anywhere: `python tests/x.py` or `cd tests && python x.py`.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

sys.stdout.reconfigure(encoding="utf-8")

src = io.open(_ROOT / "execution/process_document.py", encoding="utf-8").read()
block = src[src.index("_GENDER_COL_PAT"):src.index("_all_cols = gemini_col_order")]
ns = {"_re": re}
exec("\n".join(l[16:] if l.startswith(" " * 16) else l.strip()
               for l in block.splitlines()), ns)
_norm_val = ns["_norm_val"]
MALE, FEMALE = ns["_MALE_VAL_PAT"], ns["_FEMALE_VAL_PAT"]


def classify(v):
    n = _norm_val(v)
    if MALE.match(n):
        return "ذكر"
    if FEMALE.match(n):
        return "أنثى"
    return None


_fail = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        got  {got!r}\n        want {want!r}")
        _fail.append(name)


print("\n1. the clean values")
check("ذكر", classify("ذكر"), "ذكر")
check("أنثى", classify("أنثى"), "أنثى")
check("M", classify("M"), "ذكر")
check("F", classify("F"), "أنثى")

print("\n2. hamza spellings no longer have to be enumerated")
# "انتى" was listed and "أنتى" was not -- the same word, 233 unmatched cells.
for v in ["انثى", "أنثى", "انثي", "أنثي"]:
    check(f"{v} -> أنثى", classify(v), "أنثى")
for v in ["انتى", "أنتى", "انتي", "أنتي"]:
    check(f"{v} -> أنثى", classify(v), "أنثى")

print("\n3. the ways أنثى comes back misread")
# ث read as ت / ش / ن / ه, or the tail dropped. Every one of these carries
# female first names in the corpus by a clear margin.
for v in ["أنش", "انش", "انشى", "أننى", "انى", "أنى", "أثنى", "أنه", "أنت"]:
    check(f"{v} -> أنثى", classify(v), "أنثى")

print("\n4. أنت is female, not male")
# It used to sit in the male pattern as انت[اه]?. Across the corpus, rows whose
# gender cell reads أنت carry female first names 11 to 4. Folding the hamza
# without moving it would have sent those rows to ذكر.
check("أنت", classify("أنت"), "أنثى")
check("انت", classify("انت"), "أنثى")

print("\n5. junk is left alone rather than guessed at")
# التى and لحم are NOT junk -- they are misreadings of أنثى and نعم, and are
# recognised in their own columns further down.
for v in ["5", "53", "55", "50", "Si", "", "podéis!", "قم"]:
    check(f"{v!r} unclassified", classify(v), None)

print("")
print("6. numerals fold to ASCII whatever script they were written in")
from execution.digit_repair import _digits, _accept

check("arabic-indic digits fold", _digits("٠٥٩٧"), "0597")
check("persian digits fold", _digits("۰۵۹۷"), "0597")
check("a number mixing both folds", _digits("٠٥٩866688"), "059866688")
check("western digits are unchanged", _digits("0591112223"), "0591112223")

# The identity guard compares the cell's own text against what QL4 flagged.
# QL4 folds before reporting and _digits did not, so an Arabic-Indic cell never
# matched itself and the repair was refused -- on exactly the cells Azure reads
# worst.
azure_cell = "٠٥٩١١١٢٢٢٣"
check("the guard matches a cell against its own folded value",
      _digits(azure_cell), _digits("0591112223"))

# _PHONE_RE wants a literal ASCII 059, so a correct Arabic-Indic reading was
# rejected before it could be written back.
check("an arabic-indic phone is accepted",
      _accept("phone_format", azure_cell), True)
check("an arabic-indic id is accepted",
      _accept("id_format", "٤٠٦١١١٢٢٢"), True)
check("a short arabic-indic phone is still rejected",
      _accept("phone_format", "٠٥٩٧"), False)

print("")
print("7. fixed-choice columns take one of their answers, or nothing")
# A value outside the answer set is not an answer. These columns used to let OCR
# noise through untouched, so "8", "1" and "لحم" sat in a yes/no column looking
# like data. Nothing here picks BETWEEN the two valid answers -- an unrecognised
# value is blanked, never guessed into the more likely one.
YN_YES, YN_NO = ns["_YN_YES_PAT"], ns["_YN_NO_PAT"]
YES, NO = ns["_YES_VAL_PAT"], ns["_NO_VAL_PAT"]

MARK = ns["_MARK_PAT"]

def choose(v, rules):
    """Mirror the pipeline: an allowed answer or a mark is kept, a recognised
    spelling is mapped, anything else is blanked."""
    raw = v.strip()
    if raw in [x for _, x in rules]:
        return raw
    if MARK.match(raw):
        return raw       # a mark is an answer, left exactly as written
    n = _norm_val(raw)
    for pat, val in rules:
        if pat.match(n):
            return val
    return None          # -> the pipeline writes None here

DISAB = [(YN_YES, "نعم"), (YN_NO, "لا")]
APPR  = [(YES, "موافق"), (NO, "غير موافق")]
GEND  = [(MALE, "ذكر"), (FEMALE, "أنثى")]

check("disability نعم", choose("نعم", DISAB), "نعم")
check("disability لا", choose("لا", DISAB), "لا")
check("disability كلا -> لا", choose("كلا", DISAB), "لا")
# A mark is an answer, and it is kept exactly as written. Not translated,
# because what it means depends on the question; not blanked, because the person
# did answer and erasing it would destroy the answer rather than tidy it.
for m in ["✓", "✔", "√", "X", "x", "×", "✗"]:
    check(f"disability mark {m!r} kept as is", choose(m, DISAB), m)
# Everything that is neither a word nor a mark still goes. These are the values
# actually seen in that column across the corpus.
# Misreadings of نعم, confirmed by the user against their own forms. Safe to
# list because these patterns only ever run on a yes/no column -- "لحم" there
# cannot be the word for meat.
for v in ["لحم", "نهم", "لهم"]:
    check(f"disability {v!r} -> نعم", choose(v, DISAB), "نعم")
for junk in ["1", "-", "8", "V", "11", "1)", "podéis!", "8 موافق"]:
    check(f"disability {junk!r} -> blank", choose(junk, DISAB), None)

check("approval موافق", choose("موافق", APPR), "موافق")
check("approval نعم -> موافق", choose("نعم", APPR), "موافق")
check("approval لا -> غير موافق", choose("لا", APPR), "غير موافق")
# A tick on a consent column is kept as the mark too -- see below.
for v in ["نهم", "لهم", "لحم"]:
    check(f"approval {v!r} -> موافق", choose(v, APPR), "موافق")
for junk in ["قم", "5", "2", "7", "1)"]:
    check(f"approval {junk!r} -> blank", choose(junk, APPR), None)

check("gender ذكر", choose("ذكر", GEND), "ذكر")
check("gender أنتى -> أنثى", choose("أنتى", GEND), "أنثى")
# أنثى misread as التى: ن->ل with the definite article, ث->ت.
check("gender التى -> أنثى", choose("التى", GEND), "أنثى")
check("gender التي -> أنثى", choose("التي", GEND), "أنثى")
for junk in ["5", "Si", "53", "50", "لحم"]:
    check(f"gender {junk!r} -> blank", choose(junk, GEND), None)

# Marks survive on every fixed-choice column, not just the yes/no one.
check("a mark is kept on a consent column too", choose("X", APPR), "X")
check("a tick likewise", choose("✓", APPR), "✓")
# But a mark with anything else attached is not a bare mark, so it still goes.
check("a mark with text attached is not an answer",
      choose("8 موافق", DISAB), None)

print("")
print("8. learned corrections cannot reopen a fixed-choice column")
# Stage 4 settles these columns; Stage 4.5 then applied a learned rule on top
# and undid it. 'آنثى' -> 'انثى' normalises to the same key as the canonical
# أنثى, so the correction fired and wrote the un-hamza'd form back. The table
# also held 'نعم' -> 'قم' AND 'قم' -> 'نعم', the same pair in both directions,
# which is how قم reached a finished disability column.
import re as _re8
_fc_src = src[src.index("_FIXED_CHOICE_PAT = _pcc_re.compile"):]
_fc_src = _fc_src[:_fc_src.index(chr(41) + chr(10)) + 1]
FIXED = _re8.compile("".join(_re8.findall(r"r'([^']*)'", _fc_src)), _re8.I)

for col in ["الجنس", "النوع الإجتماعي", "هل يعاني المشارك من أي اعاقة؟",
            "هل لديك أية إعاقة", "الموافقة على استخدام هذا التوثيق"]:
    check(f"{col[:22]!r} is protected", bool(FIXED.search(col)), True)

# Names are exactly where learning from a person's edits belongs.
for col in ["الاسم رباعي", "اسم الطفل", "الاسم الرباعي للمشارك",
            "المحافظة/ التجمع السكني", "تاريخ الميلاد"]:
    check(f"{col[:22]!r} still learns", bool(FIXED.search(col)), False)

print("\n" + ("ALL PASS" if not _fail else f"{len(_fail)} FAILED: {_fail}"))
sys.exit(1 if _fail else 0)
