# -*- coding: utf-8 -*-
"""
Offline tests for two-tier table headers. No API calls, no credits.

Covers the split header "خط السير" over "من"/"إلى", and the row-offset that
keeps cell polygons pointing at the right participant once a table has two
header rows instead of one.

Run: python test_header_structure.py
"""
import sys
from pathlib import Path

# Repo root, resolved from this file rather than the current directory, so the
# test runs the same from anywhere: `python tests/test_header_structure.py` or `cd tests && python test_header_structure.py`.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from execution.extract_azure_layout import (
    _header_row_count, _header_paths, _HDR_SEP, _is_rtl_table,
    _azure_order_is_reading_order,
    _row_is_participant_data, _clean_cell_text, SELECTION_MARK,
    layout_to_cell_polygons, layout_to_participants,
)


class Cell:
    """Stands in for an Azure DocumentTableCell."""
    def __init__(self, r, c, content, kind=None, row_span=1, column_span=1):
        self.row_index    = r
        self.column_index = c
        self.content      = content
        self.kind         = kind
        self.row_span     = row_span
        self.column_span  = column_span


_fail = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        got  {got!r}\n        want {want!r}")
        _fail.append(name)


print("\n1. single-tier header behaves exactly as before")
cells = [Cell(0, i, h, kind="columnHeader") for i, h in enumerate(["#", "الاسم", "الجنس"])]
cells += [Cell(1, 0, "1"), Cell(1, 1, "احمد"), Cell(1, 2, "ذكر")]
check("one header row", _header_row_count(cells, 2), 1)
check("headers unchanged",
      [_HDR_SEP.join(p) if p else "" for p in _header_paths(cells, 1, 3)],
      ["#", "الاسم", "الجنس"])

print("\n2. split header: خط السير spans من / إلى")
cells = [
    Cell(0, 0, "الاسم رباعي", kind="columnHeader", row_span=2),
    Cell(0, 1, "خط السير",    kind="columnHeader", column_span=2),
    Cell(1, 1, "من",          kind="columnHeader"),
    Cell(1, 2, "إلى",         kind="columnHeader"),
    Cell(2, 0, "احمد"), Cell(2, 1, "غزة"), Cell(2, 2, "رفح"),
]
check("two header rows", _header_row_count(cells, 3), 2)
check("parent pushed onto both children",
      _header_paths(cells, 2, 3),
      [["الاسم رباعي"], ["خط السير", "من"], ["خط السير", "إلى"]])
check("row-spanning parent not duplicated",
      _header_paths(cells, 2, 3)[0], ["الاسم رباعي"])
check("flattened names",
      [_HDR_SEP.join(p) for p in _header_paths(cells, 2, 3)],
      ["الاسم رباعي", "خط السير - من", "خط السير - إلى"])

print("\n3. fallbacks and guards")
check("no kind tags -> assume one header row",
      _header_row_count([Cell(0, 0, "الاسم"), Cell(1, 0, "احمد")], 2), 1)
check("every row tagged header -> still keep a data row",
      _header_row_count([Cell(r, 0, "x", kind="columnHeader") for r in range(3)], 3), 2)
check("empty spanned column stays empty, not inherited",
      _header_paths([Cell(0, 0, "الاسم", kind="columnHeader")], 1, 2), [["الاسم"], []])

print("\n4. polygons stay aligned with a two-tier header")
# Grid rows 0-1 are headers, rows 2-3 are the two participants.
poly = lambda r, c: [c, r, c + 1, r, c + 1, r + 1, c, r + 1]
layout = {
    "success": True,
    "page_dims": {1: {"width": 8.5, "height": 11.0, "unit": "inch", "angle": 0}},
    "tables": [{
        "row_count": 4, "column_count": 2,
        "headers": ["الاسم رباعي", "خط السير - من"],
        "header_paths": [["الاسم رباعي"], ["خط السير", "من"]],
        "header_row_count": 2,
        "rows": [["احمد", "غزة"], ["سالم", "رفح"]],
        "page_number": 1,
        "cell_polygons": [
            {"row": r, "col": c, "polygon": poly(r, c), "page": 1, "handwritten": True}
            for r in range(4) for c in range(2)
        ],
    }],
}
out = layout_to_cell_polygons(layout)
by = {(p["participant_index"], p["col"]): p for p in out}
check("participant 0 col 0 reads grid row 2", by[(0, 0)]["polygon"], poly(2, 0))
check("participant 1 col 1 reads grid row 3", by[(1, 1)]["polygon"], poly(3, 1))
check("text follows the same row", by[(0, 0)]["text"], "احمد")
check("child keeps its composed name", by[(0, 1)]["field_name"], "خط السير - من")

print("")
print("5. RTL forms come back in reading order")
check("arabic headers detected RTL", _is_rtl_table(["الاسم", "الجنس"]), True)
check("latin headers stay LTR", _is_rtl_table(["Name", "Gender"]), False)
check("synthetic-only headers count as arabic", _is_rtl_table(["عمود 1", "عمود 2"]), True)

# Azure hands back physical left-to-right. On this Arabic form the paper reads
# "#", then the name, then gender -- right to left.
ar_layout = {
    "success": True, "page_dims": {},
    "tables": [{
        "row_count": 3, "column_count": 3,
        "headers": ["الجنس", "الاسم رباعي", "#"],
        "header_row_count": 1,
        "rows": [["ذكر", "احمد", "1"], ["أنثى", "سالم", "2"]],
        "page_number": 1,
        # Azure numbered these left to right (x rises with the index), so the
        # display order has to be flipped. Without polygons the code leaves the
        # order alone rather than guessing, so the geometry has to be here.
        "cell_polygons": [
            {"col": i, "row": 0,
             "polygon": [i*100, 500, i*100+80, 500, i*100+80, 600, i*100, 600]}
            for i in range(3)
        ],
    }],
}
order, people = layout_to_participants(ar_layout)
check("column_order reversed into reading order", order, ["#", "الاسم رباعي", "الجنس"])
check("values still land in the right column", people[0]["الاسم رباعي"], "احمد")
check("gender not swapped with name", people[0]["الجنس"], "ذكر")
check("second row intact", people[1]["الاسم رباعي"], "سالم")

lat_layout = {
    "success": True, "page_dims": {},
    "tables": [{
        "row_count": 3, "column_count": 2,
        "headers": ["Name", "Gender"], "header_row_count": 1,
        "rows": [["Ahmed", "M"], ["Salem", "F"]],
        "page_number": 1, "cell_polygons": [],
    }],
}
lat_order, lat_people = layout_to_participants(lat_layout)
check("latin form keeps its order", lat_order, ["Name", "Gender"])
check("latin values intact", lat_people[0]["Name"], "Ahmed")

print("")
print("6. reading order comes from the geometry, not from an assumed direction")
# Azure numbers columns by position in the PAGE frame, and a sideways photo
# rotates that frame -- so the numbering runs one way on an upright sheet and
# the other way on a rotated one. Both of these are real shapes taken from
# production documents.
def _tbl(names, axis, rising):
    """One cell per column, laid out along `axis`, index rising or falling."""
    cps = []
    for i, _ in enumerate(names):
        pos = (i if rising else len(names) - 1 - i) * 100 + 50
        lo, hi = pos - 40, pos + 40
        poly = ([lo, 500, hi, 500, hi, 600, lo, 600] if axis == "x"
                else [500, lo, 600, lo, 600, hi, 500, hi])
        cps.append({"col": i, "row": 0, "polygon": poly})
    return {"headers": list(names), "cell_polygons": cps}

AR = ["#", "الاسم الرباعي", "رقم الهوية", "رقم الجوال"]

# Upright sheet: "#" is col 0 and sits at the RIGHT, so x falls as the index
# rises -- Azure already numbered it right to left.
upright = _tbl(AR, "x", rising=False)
check("upright: azure order already reads correctly",
      _azure_order_is_reading_order(upright, {}), True)

# Sideways photo: columns advance along y and "#" ends up last, so the
# numbering runs backwards and the display order has to be flipped.
rotated = _tbl(list(reversed(AR)), "y", rising=True)
check("rotated: azure order runs backwards",
      _azure_order_is_reading_order(rotated, {}), False)

# Whichever way Azure numbered them, the customer sees the same first column.
def _display(t):
    h = t["headers"]
    return h if _azure_order_is_reading_order(t, {}) else list(reversed(h))
check("upright starts at #", _display(upright)[0], "#")
check("rotated starts at # too", _display(rotated)[0], "#")
check("and the name follows it in both",
      (_display(upright)[1], _display(rotated)[1]),
      ("الاسم الرباعي", "الاسم الرباعي"))

check("no polygons -> leave azure's order alone",
      _azure_order_is_reading_order({"headers": AR, "cell_polygons": []}, {}), True)
check("a single column is not reorderable",
      _azure_order_is_reading_order(_tbl(["#"], "x", rising=True), {}), True)

print("")
print("7. a tall header does not swallow the first participant")
# The registration sheet: one header row, but its cells span two rows because
# the labels are tall. Expanding row_span marked row 1 as a header, so every
# column came back as "label - <row 1 value>" and "#" became "# - 1", which
# stopped matching the row-number pattern and survived as a stray column.
tall = [
    Cell(0, 0, "#",           kind="columnHeader", row_span=2),
    Cell(0, 1, "الاسم رباعي",  kind="columnHeader", row_span=2),
    Cell(0, 2, "رقم الهوية",   kind="columnHeader", row_span=2),
    Cell(1, 0, "1"), Cell(1, 1, "اسم تجريبي أول ثاني"), Cell(1, 2, "111111111"),
    Cell(2, 0, "2"), Cell(2, 1, "اسم تجريبي ثالث رابع"),  Cell(2, 2, "222222222"),
]
check("tall header is still one row", _header_row_count(tall, 3), 1)
check("headers stay clean",
      [_HDR_SEP.join(p) if p else "" for p in _header_paths(tall, 1, 3)],
      ["#", "الاسم رباعي", "رقم الهوية"])
check("the row-number column is still just '#'",
      _header_paths(tall, 1, 3)[0], ["#"])

# The guard: even if Azure tags row 1 as a header, an ID number in it means it
# is somebody's data.
mistagged = [
    Cell(0, 0, "رقم الهوية", kind="columnHeader"),
    Cell(1, 0, "111111111",  kind="columnHeader"),
    Cell(2, 0, "222222222"),
]
check("a row holding an ID is data whatever the tag",
      _header_row_count(mistagged, 3), 1)

# A real second tier has short labels and no long digit runs, so it survives.
two_tier = [
    Cell(0, 0, "خط السير", kind="columnHeader", column_span=2),
    Cell(1, 0, "من", kind="columnHeader"), Cell(1, 1, "إلى", kind="columnHeader"),
    Cell(2, 0, "غزة"), Cell(2, 1, "رفح"),
]
check("a genuine two-tier header still counts as two",
      _header_row_count(two_tier, 3), 2)
# A date header is four digits, under the guard's threshold.
dated = [
    Cell(0, 0, "التاريخ", kind="columnHeader"),
    Cell(1, 0, "27/8/2026", kind="columnHeader"),
    Cell(2, 0, "حاضر"),
]
check("a date in the second tier is not mistaken for data",
      _header_row_count(dated, 3), 2)

print("")
print("8. a selection mark is recorded, not interpreted")
# Azure reports :selected: for anything reading as a tick or a cross, on any
# column. Rewriting it as the word for "agreed" turned a disability answer of
# "no" into "no agreed" -- the person's answer with the opposite appended.
# Azure reports THAT a mark is present, never which one. Any character chosen
# here would be invented -- and choosing a tick put one on a sheet where the
# person had drawn a cross.
check("a mark with no glyph leaves the cell empty",
      _clean_cell_text(":selected:"), "")
check("and the constant says so", SELECTION_MARK, "")
check("a mark next to an answer leaves the answer alone",
      _clean_cell_text("لا :selected:"), "لا")
check("and does not append a word to it",
      "موافق" in _clean_cell_text("لا :selected:"), False)
check("a cross keeps the cross", _clean_cell_text("X :selected:"), "X")
check("an unticked box is empty", _clean_cell_text(":unselected:"), "")
check("real text is untouched", _clean_cell_text("موافق"), "موافق")
nl = "word1" + chr(10) + "word2"
check("newlines still collapse", _clean_cell_text(nl), "word1 word2")
check("empty stays empty", _clean_cell_text(""), "")
check("None is handled", _clean_cell_text(None), "")

print("")
print("9. a table is a table at any size")
# The extractor required two rows and dropped anything smaller, so a sheet with
# one line of data came back empty for a file that plainly had a table in it.
check("a single row has no header row -- the row is the data",
      _header_row_count([Cell(0, 0, "احمد"), Cell(0, 1, "0591112223")], 1), 0)
check("two rows still take one header row",
      _header_row_count([Cell(0, 0, "الاسم", kind="columnHeader"),
                         Cell(1, 0, "احمد")], 2), 1)
check("a single row of tagged headers is still just data",
      _header_row_count([Cell(0, 0, "الاسم", kind="columnHeader")], 1), 0)

# One column, two rows: header plus one participant.
one_col = {
    "success": True, "page_dims": {},
    "tables": [{
        "row_count": 2, "column_count": 1,
        "headers": ["الاسم"], "header_row_count": 1,
        "rows": [["احمد سالم"]],
        "page_number": 1, "cell_polygons": [],
    }],
}
order, people = layout_to_participants(one_col)
check("a one-column table yields its column", order, ["الاسم"])
check("and its single row", [p["الاسم"] for p in people], ["احمد سالم"])

# One data row across two columns.
one_row = {
    "success": True, "page_dims": {},
    "tables": [{
        "row_count": 2, "column_count": 2,
        "headers": ["الاسم", "الجنس"], "header_row_count": 1,
        "rows": [["احمد سالم", "ذكر"]],
        "page_number": 1, "cell_polygons": [],
    }],
}
order2, people2 = layout_to_participants(one_row)
check("a single participant is kept", len(people2), 1)
check("with both columns", sorted(order2), sorted(["الاسم", "الجنس"]))

print("\n" + ("ALL PASS" if not _fail else f"{len(_fail)} FAILED: {_fail}"))
sys.exit(1 if _fail else 0)
