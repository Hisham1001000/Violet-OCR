# -*- coding: utf-8 -*-
"""
What table shapes survive the extractor. No API calls, no credits.

Every real form so far has arrived a slightly different shape, and each new one
found a bug that a customer met first: six columns eaten by a dedup, a tall
header that swallowed row one, two blank headers that collided into one key and
lost a column each. This feeds shapes through the REAL extraction functions so
the next one is met here instead.

The invariant under all of it is that nothing disappears quietly:

    every column Azure reports comes back with a usable, unique name
    every row holding data becomes a participant
    a value ends up under the column it was written in

A shape the extractor cannot handle is fine, as long as it says so. A shape it
handles by dropping half the sheet is not.

Run: python test_table_shapes.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

from execution.extract_azure_layout import (
    _effective_headers, _header_paths, _header_row_count, _HDR_SEP,
    layout_to_participants,
)

_fail = []


def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        got  {got!r}\n        want {want!r}")
        _fail.append(name)


class Cell:
    """Stands in for an Azure DocumentTableCell."""
    def __init__(self, r, c, content, kind=None, row_span=1, column_span=1):
        self.row_index, self.column_index = r, c
        self.content, self.kind = content, kind
        self.row_span, self.column_span = row_span, column_span


def table(headers, rows, *, page=1, header_rows=1, polys=True):
    """A normalised table dict, the shape extract_azure_layout hands onward."""
    ncols = len(headers)
    cps = []
    if polys:
        for r in range(len(rows) + header_rows):
            for c in range(ncols):
                x, y = c * 100, r * 40
                cps.append({"row": r, "col": c, "page": page,
                            "polygon": [x, y, x + 90, y, x + 90, y + 30, x, y + 30]})
    return {"row_count": len(rows) + header_rows, "column_count": ncols,
            "headers": list(headers), "header_row_count": header_rows,
            "rows": [list(r) for r in rows], "page_number": page,
            "cell_polygons": cps}


def run(tables, page_dims=None):
    return layout_to_participants({"success": True, "tables": tables,
                                   "page_dims": page_dims or {}})


def no_column_lost(order, people, label):
    """column_order and the stored keys must describe the same table."""
    keys = set()
    for p in people:
        keys |= set(p.keys())
    missing = [c for c in order if c not in keys]
    check(f"{label}: no column dropped between order and rows", missing, [])
    check(f"{label}: names are unique", len(set(order)), len(order))


print("\n1. the smallest tables a customer might send")
o, p = run([table(["الاسم"], [["احمد سالم"]])])
check("one column, one row -> the value", [x["الاسم"] for x in p], ["احمد سالم"])
no_column_lost(o, p, "1x1")

o, p = run([table(["الاسم", "الجنس"], [["احمد", "ذكر"]])])
check("two columns, one row", len(p), 1)
no_column_lost(o, p, "2x1")

o, p = run([table(["الاسم"], [["احمد"], ["ريم"], ["سالم"]])])
check("one column, three rows", len(p), 3)

print("\n2. a wide sheet")
wide_h = [f"عمود{i}" for i in range(30)]
o, p = run([table(wide_h, [[f"v{i}" for i in range(30)] for _ in range(5)])])
check("30 columns all survive", len(o), 30)
check("and all 5 rows", len(p), 5)
no_column_lost(o, p, "30 wide")

print("\n3. headers the OCR could not read")
# Two blank headers used to collide on the key "" and lose a column each.
# 54 documents in the corpus were losing data this way.
o, p = run([table(["الاسم", "", "الجنس", ""], [["احمد", "أ", "ذكر", "ب"]])])
check("blank headers get distinct names", len(set(o)), 4)
no_column_lost(o, p, "blank headers")
check("the value under the first blank is kept",
      [v for k, v in p[0].items() if v == "أ"], ["أ"])
check("and the second is not overwritten by it",
      [v for k, v in p[0].items() if v == "ب"], ["ب"])

# Two columns genuinely sharing a name -- signature columns often do.
o, p = run([table(["التوقيع", "الاسم", "التوقيع"], [["س1", "احمد", "س2"]])])
check("repeated real names are disambiguated", len(set(o)), 3)
no_column_lost(o, p, "repeated names")
check("both signatures survive",
      sorted(v for v in p[0].values() if v in ("س1", "س2")), ["س1", "س2"])

print("\n4. two-tier headers")
cells = [
    Cell(0, 0, "الاسم", kind="columnHeader", row_span=2),
    Cell(0, 1, "خط السير", kind="columnHeader", column_span=2),
    Cell(1, 1, "من", kind="columnHeader"), Cell(1, 2, "إلى", kind="columnHeader"),
    Cell(2, 0, "احمد"), Cell(2, 1, "غزة"), Cell(2, 2, "رفح"),
]
check("two header rows detected", _header_row_count(cells, 3), 2)
paths = _header_paths(cells, 2, 3)
check("the parent reaches both children",
      [_HDR_SEP.join(x) for x in paths],
      ["الاسم", "خط السير - من", "خط السير - إلى"])

print("\n5. more than one page")
t1 = table(["الاسم", "الجنس"], [["احمد", "ذكر"]], page=1)
t2 = table(["الاسم", "الجنس"], [["ريم", "أنثى"]], page=2)
o, p = run([t1, t2])
check("both pages merge", len(p), 2)
check("in page order", [x["الاسم"] for x in p], ["احمد", "ريم"])

# A second page whose header row was misread. Matching on TEXT lost the page;
# matching on column count keeps it.
t2b = table(["الاسـم", "الجنـس"], [["ريم", "أنثى"]], page=2)
o, p = run([t1, t2b])
check("a page with a misread header is still merged", len(p), 2)

# A genuinely different table on page 2 must NOT be merged into the first.
t2c = table(["س", "ص", "ع", "ف"], [["1", "2", "3", "4"]], page=2)
o, p = run([t1, t2c])
check("a different-shaped page is excluded", len(p), 1)

print("\n6. rows that are not participants")
o, p = run([table(["#", "الاسم"], [["1", "احمد"], ["", ""], ["2", "ريم"]])])
check("a blank row is dropped", len(p), 2)
o, p = run([table(["#", "الاسم"], [["1", "احمد"], ["2", ""], ["3", "ريم"]])])
check("a row with only a row-number is dropped", len(p), 2)

print("\n7. nothing to read")
o, p = run([])
check("no tables -> empty, not a crash", (o, p), ([], []))
o, p = run([table(["الاسم"], [])])
check("a header with no data rows", p, [])

print("\n" + ("ALL PASS" if not _fail else f"{len(_fail)} FAILED: {_fail}"))
sys.exit(1 if _fail else 0)
