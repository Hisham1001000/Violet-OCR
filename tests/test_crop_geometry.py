# -*- coding: utf-8 -*-
"""
Offline tests for cell-crop geometry. No API calls, no credits.

The point of concern is that the LoRA adapters were trained on crops cut with
the unclamped padding, so the name path must keep producing exactly the boxes
it produced before. Clamping is opt-in and only numeric re-reads use it.

Run: python test_crop_geometry.py
"""
import sys
from pathlib import Path

# Repo root, resolved from this file rather than the current directory, so the
# test runs the same from anywhere: `python tests/test_crop_geometry.py` or `cd tests && python test_crop_geometry.py`.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from execution.crop_names import (_polygon_to_bbox_pixels, _PAD_PX_X,
                                  _PAD_PX_TOP, _PAD_PX_BOTTOM, _PAD_PCT)

DPI, US = 200, 1.0 / 200          # so polygon units == pixels
PW, PH = 1000 / 200, 800 / 200    # 1000 x 800 px page

def poly(x0, y0, x1, y1):
    return [x0, y0, x1, y0, x1, y1, x0, y1]

_fail = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        got  {got!r}\n        want {want!r}")
        _fail.append(name)

CELL = poly(100, 200, 145, 340)          # 45 wide, 140 tall

# Passing `neighbors` also switches the bounds to rounding outwards, so the
# expectations below use ceil/floor wherever a neighbour list is supplied.
import math
FULL_L = math.floor(100 - _PAD_PX_X    - 45*_PAD_PCT)
FULL_T = math.floor(200 - _PAD_PX_TOP  - 140*_PAD_PCT)
FULL_R = math.ceil(145 + _PAD_PX_X     + 45*_PAD_PCT)
FULL_B = math.ceil(340 + _PAD_PX_BOTTOM + 140*_PAD_PCT)

print("\n1. without neighbours the box is exactly what it always was")
base = _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US)
want = (int(100 - _PAD_PX_X - 45*_PAD_PCT), int(200 - _PAD_PX_TOP - 140*_PAD_PCT),
        int(145 + _PAD_PX_X + 45*_PAD_PCT), int(340 + _PAD_PX_BOTTOM + 140*_PAD_PCT))
check("unclamped box unchanged", base, want)
check("neighbors=None is the same as omitting it",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=None), base)
check("empty neighbour list changes nothing",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[]), base)

print("\n2. an adjacent cell clamps the padding to half the gap")
left_nb  = poly(55,  200, 99,  340)      # 1 px gap on the left
right_nb = poly(146, 200, 190, 340)      # 1 px gap on the right
got = _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[left_nb, right_nb])
check("left edge clamped",  got[0], math.floor(100 - 0.5))
check("right edge clamped", got[2], math.ceil(145 + 0.5))
check("top keeps full padding (nothing above)",  got[1], FULL_T)
check("bottom keeps full padding (nothing below)", got[3], FULL_B)
check("crop stops at the neighbour's boundary", got[0] >= 99, True)

print("\n3. guards")
check("the cell itself in the list is ignored",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[CELL]),
      (FULL_L, FULL_T, FULL_R, FULL_B))
overlapping = poly(90, 200, 102, 340)    # overlaps the cell -- negative gap
got = _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[overlapping])
check("overlapping neighbour clamps to zero, never negative",
      got[0], 100)
check("a clamped crop never cuts into the cell itself",
      got[0] <= 100 and _polygon_to_bbox_pixels(
          CELL, DPI, PW, PH, US, neighbors=[overlapping])[2] >= 145, True)
far = poly(0, 200, 40, 340)              # 60 px away -- further than the padding
check("a distant neighbour does not shrink anything",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[far])[0], FULL_L)
above = poly(100, 40, 145, 199)          # 1 px above
check("a cell above clamps the top, not the sides",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[above])[1],
      math.floor(200 - 0.5))
check("and leaves the left edge alone",
      _polygon_to_bbox_pixels(CELL, DPI, PW, PH, US, neighbors=[above])[0], FULL_L)

print("")
print("4. the EXIF orientation tag is applied when loading a photo")
# Azure applies the tag and reports its page in the DISPLAYED frame. Loading
# the raw bytes without it left the image and the polygon coordinates a quarter
# turn apart, and _orient_to_polygons cannot recover the direction: it scores by
# whether polygons FIT, and 90 and 270 fit a rotated page equally well. On the
# sheet that exposed this, every name crop landed on blank paper and the reader
# returned the same name for four different people.
import io as _io
from PIL import Image as _Image
from execution.crop_names import _render_pages

def _jpeg(size, orientation):
    im = _Image.new("RGB", size, "white")
    ex = im.getexif()
    if orientation is not None:
        ex[274] = orientation
    buf = _io.BytesIO()
    im.save(buf, format="JPEG", exif=ex)
    return buf.getvalue()

# orientation 8 = rotate a quarter turn; the loaded image must come back swapped
check("orientation 8 swaps the axes",
      _render_pages(_jpeg((40, 20), 8), "image/jpeg")[1].size, (20, 40))
check("orientation 6 swaps the axes",
      _render_pages(_jpeg((40, 20), 6), "image/jpeg")[1].size, (20, 40))
check("orientation 1 leaves it alone",
      _render_pages(_jpeg((40, 20), 1), "image/jpeg")[1].size, (40, 20))
check("no EXIF at all leaves it alone",
      _render_pages(_jpeg((40, 20), None), "image/jpeg")[1].size, (40, 20))
check("the loaded page is still RGB",
      _render_pages(_jpeg((40, 20), 8), "image/jpeg")[1].mode, "RGB")

print("")
print("5. the name-column fallback cannot pick a fixed-choice column")
# When no header says اسم, detect_name_fields falls back to scoring columns by
# content. On a sheet with no name column at all it picked الجنس, sent those
# crops to the NAME model, and every cell came back as أنس -- a person's name,
# read correctly, from a cell that never held one.
from execution.crop_names import _looks_high_cardinality, _FIXED_CHOICE_HEADER_RE

for col in ["الجنس", "النوع الإجتماعي", "هل يعاني المشارك من أي اعاقة؟",
            "الموافقة على استخدام هذا التوثيق"]:
    check(f"{col[:20]!r} excluded by header", bool(_FIXED_CHOICE_HEADER_RE.search(col)), True)
for col in ["الاسم رباعي", "اسم الطفل", "المحافظة"]:
    check(f"{col[:20]!r} not excluded", bool(_FIXED_CHOICE_HEADER_RE.search(col)), False)

# The general guard: a name column is nearly all distinct, a choice column is not.
names  = ["كفاح عرفات", "ريم ماجد", "عبدالرحمن محمد", "رهام زياد", "مني دياب", "امل شحاده"]
choice = ["أنثى", "ذكر", "أنثى", "أنثى", "ذكر", "أنثى", "أنثى"]
check("a column of names looks high-cardinality", _looks_high_cardinality(names), True)
check("a column of two answers does not", _looks_high_cardinality(choice), False)
check("too few values to judge -> allowed", _looks_high_cardinality(["أنثى", "ذكر"]), True)
check("empty list -> allowed", _looks_high_cardinality([]), True)
check("blanks are ignored when counting",
      _looks_high_cardinality(["أنثى", "", None, "أنثى", "أنثى", "أنثى"]), False)

print("\n" + ("ALL PASS" if not _fail else f"{len(_fail)} FAILED: {_fail}"))
sys.exit(1 if _fail else 0)
