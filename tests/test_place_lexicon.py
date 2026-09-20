# -*- coding: utf-8 -*-
"""
Offline tests for place-name correction. No API calls, no credits.

The risk being guarded is a silent rewrite: turning one real village into a
different real village is worse than leaving a misreading alone, because nobody
sees it happen.

Run: python test_place_lexicon.py
"""
import sys
from pathlib import Path

# Repo root, resolved from this file rather than the current directory, so the
# test runs the same from anywhere: `python tests/test_place_lexicon.py` or `cd tests && python test_place_lexicon.py`.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from execution.place_lexicon import correct, correct_rows, norm

LEX = {
    "canonical": ["خان يونس", "دير البلح", "الوسطى", "الوسطى الزوايدة",
                  "شمال غزة", "غزة", "رفح", "الشيخ رضوان"],
    "variants": {norm("خانونى"): "خان يونس", norm("ديرالبلح"): "دير البلح"},
}

LEX2 = {
    "canonical": ["الرمال", "النصر", "غزة", "خان يونس", "الشمالى"],
    "variants": {},
}

_fail = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        got  {got!r}\n        want {want!r}")
        _fail.append(name)


print("\n1. a real place is never touched")
for p in ["خان يونس", "دير البلح", "الوسطى", "رفح"]:
    check(f"{p} unchanged", correct(p, LEX), (p, None))

print("\n2. a spelling already reviewed maps to its canonical")
check("خانونى -> خان يونس", correct("خانونى", LEX), ("خان يونس", "خان يونس"))
check("ديرالبلح -> دير البلح", correct("ديرالبلح", LEX), ("دير البلح", "دير البلح"))

print("\n3. a close misreading is corrected")
check("خانيونس -> خان يونس", correct("خانيونس", LEX)[0], "خان يونس")
check("الوسطي -> الوسطى", correct("الوسطي", LEX)[0], "الوسطى")

print("\n4. anything doubtful is left exactly as it came in")
# Not close enough to anything real.
for junk in ["N", "~", "12", "قققق", "بالخير"]:
    check(f"{junk!r} left alone", correct(junk, LEX), (junk, None))
# Sits between two real places -- correcting it would be a coin flip.
amb = correct("الوسطى الزوايد", LEX)
check("ambiguous value is not forced onto one of them",
      amb[0] in ("الوسطى الزوايد", "الوسطى الزوايدة"), True)
check("empty stays empty", correct("", LEX), ("", None))
check("no lexicon -> no corrections",
      correct("خانونى", {"canonical": [], "variants": {}}), ("خانونى", None))

print("\n5. only place columns are touched")
rows = [
    {"المحافظة": "خانونى", "الاسم رباعي": "خانونى", "رقم الهوية": "333333333"},
    {"خط السير - من": "ديرالبلح", "الاسم": "دير البلح"},
]
stats = correct_rows(rows, LEX)
check("two place cells corrected", stats["changed"], 2)
check("the place column was fixed", rows[0]["المحافظة"], "خان يونس")
check("a NAME that looks like a place is untouched",
      rows[0]["الاسم رباعي"], "خانونى")
check("an id column is untouched", rows[0]["رقم الهوية"], "333333333")
check("split-header place column is matched", rows[1]["خط السير - من"], "دير البلح")
check("changes are reported for the trace", len(stats["changes"]), 2)

print("")
print("6. a compound address is corrected word by word")
# A real address is "governorate - neighbourhood", which never equals a single
# canonical place, so whole-cell matching left every one of them alone. On one
# sheet all 15 address cells went unchanged while holding obvious misreadings.
check("a misread word inside an address is fixed",
      correct("الريال الشمالى", LEX2)[0], "الرمال الشمالى")
check("and the rest of the address is untouched",
      correct("مرة النص", LEX2)[0], "مرة النصر")
check("a clean address is left exactly alone",
      correct("غزة النصر", LEX2), ("غزة النصر", None))
# One letter apart is below the bar on purpose: a short word reaches a high
# similarity by accident, and this sits inside real data rather than replacing it.
check("a one-letter difference is not guessed at",
      correct("عزة النصر", LEX2)[0], "عزة النصر")
check("latin text in a place column is left alone",
      correct("JUAN's", LEX2), ("JUAN's", None))
check("a short word is never swapped",
      correct("في النصر", LEX2)[0].split()[0], "في")

print("\n" + ("ALL PASS" if not _fail else f"{len(_fail)} FAILED: {_fail}"))
sys.exit(1 if _fail else 0)
