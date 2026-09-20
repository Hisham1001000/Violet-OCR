# -*- coding: utf-8 -*-
"""
execution/modal_make_hw_sheet.py — build a test form out of REAL handwriting.

    modal run execution/modal_make_hw_sheet.py --rows 12

A rendered font is the wrong test. The adapters were trained on handwriting, so
printed text is a domain they have never seen: they would score badly for a
reason that says nothing about how good they are, and Azure would read it
perfectly, so the run would flatter the structure half and libel the model.

This composes a NEW sheet from crops of real handwriting that already have a
human-verified label, drawn into a fresh table with printed headers -- which is
what a real form has anyway. So the sheet is genuinely new to the pipeline while
every cell's correct answer is already known, and a run can be scored exactly.

The crops come from execution/testset/frozen_test_400.csv, which is HELD OUT of
training. Composing from the training set instead would measure memory, not
reading, and would look wonderful.

Runs on Modal because that is where the crops live: they were archived to the
arabic-htr-crops volume when Supabase storage was cleared down from 1.80 GB.
"""
from __future__ import annotations

import modal

VOLUME = "arabic-htr-crops"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("pillow", "arabic-reshaper", "python-bidi")
    .apt_install("fonts-dejavu-core")
)

app = modal.App("hw-test-sheet", image=image)
crops = modal.Volume.from_name(VOLUME)


@app.function(volumes={"/crops": crops}, timeout=900)
def compose(items: list, scale: int = 2, wanted: int = 12) -> bytes:
    """
    items: [{"crop_path": str, "label": str}, ...]

    Returns the PNG. Any crop missing from the volume is skipped rather than
    faked -- a sheet with a blank where handwriting should be would be scored
    against a label nobody wrote.

    The context image cropped to context_box is preferred over crop_path.
    crop_path carries the generous padding the cropper applies, which on a tight
    form pulls in the row above and below: the first sheet built this way had
    cells holding two names and the original form's row numbers, and no score
    from it would have meant anything. context_box is the name's own rectangle,
    so a cell holds one name and the label describes all of it.
    """
    import io
    import os
    from PIL import Image, ImageDraw, ImageFont
    import arabic_reshaper
    from bidi.algorithm import get_display

    def tighten(im):
        """
        Cut a crop down to the one row it is about.

        Both stored paths keep the cropper's padding, so a cell arrives holding
        the rows above and below and their row numbers -- context_box turned out
        to describe where the padded crop sits inside a wider context, not where
        the name sits inside the crop. A cell holding three names cannot be
        scored against a label describing one.

        The crop is centred on its own row, so the ruled lines nearest the
        middle are that row's boundaries. Finding them needs no OCR: a ruled
        line is a horizontal run of dark pixels across most of the width, which
        handwriting never is.
        """
        g = im.convert("L")
        w, h = g.size
        if h < 24:
            return im
        px = g.load()
        step = max(1, w // 160)
        cols = list(range(0, w, step))
        prof = []
        for y in range(h):
            dark = sum(1 for x in cols if px[x, y] < 120)
            prof.append(dark / len(cols))
        rules = [y for y, v in enumerate(prof) if v > 0.45]
        cy = h // 2
        above = [y for y in rules if y < cy - h * 0.08]
        below = [y for y in rules if y > cy + h * 0.08]
        top = max(above) if above else 0
        bot = min(below) if below else h
        if bot - top < max(16, h * 0.25):
            return im, False               # no clear pair of rules
        pad = max(1, (bot - top) // 12)
        return im.crop((0, max(0, top + 1), w, min(h, bot + pad))), True

    def shape(t):
        if not any("؀" <= c <= "ۿ" for c in str(t)):
            return str(t)
        return get_display(arabic_reshaper.reshape(str(t)))

    loaded = []
    for it in items:
        im = None
        box = it.get("context_box") or {}
        ctx = it.get("context_path")
        if ctx and box:
            p = os.path.join("/crops", ctx)
            if os.path.exists(p):
                try:
                    full = Image.open(p).convert("RGB")
                    x, y = int(box.get("x", 0)), int(box.get("y", 0))
                    w, h = int(box.get("w", 0)), int(box.get("h", 0))
                    if w > 4 and h > 4:
                        # A little air so descenders survive, far less than the
                        # cropper's own padding.
                        m = max(2, h // 10)
                        im = full.crop((max(0, x - m), max(0, y - m),
                                        min(full.width, x + w + m),
                                        min(full.height, y + h + m)))
                except Exception:
                    im = None
        if im is None:
            p = os.path.join("/crops", it["crop_path"])
            if not os.path.exists(p):
                continue
            try:
                im = Image.open(p).convert("RGB")
            except Exception:
                continue
        cut, ok = tighten(im)
        # Only cells proved to be a single row go on the sheet. A crop the line
        # finder could not resolve still holds its neighbours, and scoring one
        # name's label against a cell containing three would read as a model
        # failure when it is a cropping artifact. Extra candidates are requested
        # so dropping these still fills the sheet.
        if ok:
            loaded.append((cut, it["label"]))
    if len(loaded) > wanted:
        loaded = loaded[:wanted]
    if not loaded:
        return b""

    # Row height follows the tallest crop, so no handwriting is squeezed. The
    # 43px floor below which a cell stops being readable was measured on real
    # uploads; these sit far above it.
    PAD, NUM_W = 26 * scale, 70 * scale
    name_w = max(im.width for im, _ in loaded) + 40 * scale
    row_h = max(im.height for im, _ in loaded) + 18 * scale
    head_h = 56 * scale
    W = NUM_W + name_w + PAD * 2
    H = head_h + row_h * len(loaded) + PAD * 2 + 40 * scale

    font_p = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    f_head = ImageFont.truetype(font_p, 20 * scale)
    f_num = ImageFont.truetype(font_p, 18 * scale)

    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    top = PAD + 30 * scale

    # Right to left: the row number sits on the right, as on the real sheets.
    name_x0, name_x1 = PAD, PAD + name_w
    num_x0, num_x1 = name_x1, name_x1 + NUM_W

    d.rectangle([name_x0, top, num_x1, top + head_h], fill="#1e293b")
    for x0, x1, label in ((name_x0, name_x1, "الاسم الرباعي"), (num_x0, num_x1, "#")):
        t = shape(label)
        bb = d.textbbox((0, 0), t, font=f_head)
        d.text((x0 + (x1 - x0 - bb[2]) / 2, top + (head_h - bb[3]) / 2 - 2 * scale),
               t, font=f_head, fill="white")

    y = top + head_h
    for i, (crop, _label) in enumerate(loaded):
        d.text((num_x0 + NUM_W / 2 - 6 * scale, y + row_h / 2 - 10 * scale),
               str(i + 1), font=f_num, fill="#0f172a")
        img.paste(crop, (name_x0 + int((name_w - crop.width) / 2),
                         y + int((row_h - crop.height) / 2)))
        y += row_h

    lw = max(1, scale)
    for x in (name_x0, name_x1, num_x1):
        d.line([(x, top), (x, y)], fill="#334155", width=lw)
    for r in range(len(loaded) + 1):
        yy = top + head_h + row_h * r
        d.line([(name_x0, yy), (num_x1, yy)], fill="#334155", width=lw)
    d.rectangle([name_x0, top, num_x1, y], outline="#0f172a", width=lw * 2)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.local_entrypoint()
def main(rows: int = 12, scale: int = 2, offset: int = 0):
    import csv
    import io as _io
    import json
    import os

    from dotenv import load_dotenv
    load_dotenv(dotenv_path=".env")
    from supabase import create_client

    ids = [r["id"] for r in csv.DictReader(
        _io.open("execution/testset/frozen_test_400.csv", encoding="utf-8"))]
    # Ask for extras: some crops cannot be resolved to a single row and are
    # dropped rather than shown with their neighbours attached.
    want = ids[offset:offset + rows * 4]

    sb = create_client(os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"),
                       os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    got = sb.table("training_dataset").select("id,crop_path,context_path,context_box,label") \
            .in_("id", want).execute().data
    order = {i: n for n, i in enumerate(want)}
    got.sort(key=lambda r: order.get(r["id"], 999))
    items = [{"crop_path": r["crop_path"], "context_path": r.get("context_path"),
               "context_box": r.get("context_box"), "label": r["label"]} for r in got]
    print(f"{len(items)} held-out candidates fetched for {rows} rows")

    # Spawn and poll rather than hold one connection for the whole call: this
    # link drops it often enough that the work finishes on Modal while the
    # client raises "Deadline exceeded" and shows nothing. It happened three
    # times building this file.
    import time
    call = compose.spawn(items, scale, rows)
    png = None
    deadline = time.time() + 900
    while time.time() < deadline:
        try:
            png = call.get(timeout=30)
            break
        except TimeoutError:
            continue
        except Exception as e:
            print(f"  poll failed ({type(e).__name__}), retrying")
            time.sleep(4)
    if png is None:
        print("gave up waiting; the compose may still be running")
        return
    if not png:
        print("no crops resolved in the volume")
        return

    os.makedirs(".tmp", exist_ok=True)
    out = os.path.join(".tmp", "hw_sheet.png")
    open(out, "wb").write(png)
    truth = os.path.join(".tmp", "hw_sheet_truth.json")
    json.dump({"column": "الاسم الرباعي",
               "rows": [{"row": n + 1, "label": r["label"], "id": r["id"]}
                        for n, r in enumerate(got)]},
              _io.open(truth, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{out}  ({len(png):,} bytes)")
    print(f"{truth}  {len(got)} verified labels")
