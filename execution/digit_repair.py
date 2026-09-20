"""
execution/digit_repair.py — re-read the cells the pipeline knows are wrong.

Stage 4.7. Quality Layer 4 already detects malformed values: a phone that is
not ten digits starting 059/056, an ID that is not nine digits. Until now
nothing acted on that — the Gemini Judge at Stage 3.95 picks cells
by Azure's confidence, which is a different question, and it never looked at
the cells QL4 had flagged.

Measured on one sheet with the reviewer running gemini-3.7-flash: 8/10 IDs and
7/10 phones. Both phone misses were cells QL4 had flagged as nine digits.

Only flagged cells are sent, one at a time, and a reply is written back only if
it satisfies the validation the original value failed. A cell can therefore get
better or stay as it was, never worse. Whole-table LLM passes are deliberately
not used here — Stage 4a.1 is permanently bypassed because re-serialising a
table through a model reorders rows and corrupts alignment.

Off unless DIGIT_REPAIR_ENABLED=1.
"""
from __future__ import annotations

import io
import logging
import os
import re

logger = logging.getLogger(__name__)

# Set by _ask_gemini_once when the failure is one a retry cannot help. Kept
# thread-local: callers read several cells in parallel and must not see each
# other's verdict.
_state = __import__("threading").local()

# Issues worth spending a model call on. name_incomplete is excluded on
# purpose: names are the adapters' job, and they are better at it.
REPAIRABLE = {"phone_format", "id_format", "date_format"}

_PHONE_RE = re.compile(r"^(059|056)\d{7}$")
_ID_RE    = re.compile(r"^\d{9}$")

# One cell can hold both numeral systems. A handwritten Arabic-Indic ٥ is a
# small circle and reads as a Western 0; ٠ is a bare dot and reads as
# punctuation. That is how ٠٥٩٩111222 was transcribed as 099111222 -- a real
# ten-digit 059 number that arrived looking like a nine-digit invalid one, and
# how it was then mistaken for a number the person had simply written wrong.
_SCRIPT_NOTE = """The digits may be written in Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩), in Western numerals, or a MIX of the two in the same number -- ٠٥٩ followed by Western digits is common. Note that a handwritten ٥ (five) is drawn as a small circle and is easily mistaken for a Western 0, and ٠ (zero) is a single dot. Convert everything to Western digits. """

PROMPTS = {
    # Do NOT tell the reader what the answer should look like. The earlier
    # phone prompt promised "exactly 10 digits starting 059 or 056", and on a
    # cell where the person had genuinely written the 9-digit 099111222 the
    # model invented a 5 to make it fit. _accept() already enforces the format
    # afterwards, and it is the only thing that should: the reader's job is to
    # report what is on the paper, the validator's job is to judge it. A cell
    # the person filled in wrongly must come back wrong, so a human sees it.
    # The phone rule is absolute in Gaza -- every mobile is ten digits starting
    # 059 or 056 -- so the reader is told it. That is a deliberate reversal of
    # the rule used for every other field here, taken knowingly: a value that
    # breaks the rule cannot be dialled, so a format-valid reading is at worst
    # as useless and at best correct. The cost is that a wrong reading now
    # PASSES _accept() and replaces Azure's, instead of being rejected.
    #
    # UNREADABLE is what keeps that cost bounded. Without it the constraint
    # forces a guess on a cell that is struck through or genuinely illegible,
    # and the guess arrives looking exactly like a real number.
    "phone_format": ("This image is one cell from a handwritten form. It holds a "
                     "Palestinian mobile number: ten digits beginning 059 or 056. "
                     + _SCRIPT_NOTE +
                     "Read the number written in the middle of the cell, digit by "
                     "digit. Ignore any partial digits clipped at the very top or "
                     "bottom edge -- those belong to the neighbouring row. If the "
                     "number is struck through, or you cannot make out every digit, "
                     "reply exactly UNREADABLE rather than guessing. Otherwise reply "
                     "with only the digits."),
    "id_format":    ("This image is one cell from a handwritten form. "
                     + _SCRIPT_NOTE +
                     "Read the number written in the middle of the cell, digit by "
                     "digit, exactly as it appears. Ignore any partial digits clipped "
                     "at the very top or bottom edge -- those belong to the "
                     "neighbouring row. Do not correct, complete or reformat it. "
                     "Reply with only the digits."),
    "date_format":  ("This image is one cell from a handwritten form. It contains a date. "
                     "Reply with only the date as written."),
}


def enabled() -> bool:
    return os.getenv("DIGIT_REPAIR_ENABLED", "0") == "1"


def _digits(s) -> str:
    """
    The digits of a value, as ASCII, whatever script they were written in.

    str.isdigit() is true for Arabic-Indic characters, so this used to return
    them unchanged -- and the identity guard then compared Azure's ٠٥٩١١١٢٢٢٣
    against QL4's already-folded 0591112223, found them different, and refused
    to repair the cell. Cells written in Arabic-Indic are the ones Azure reads
    worst, so the guard was blocking precisely the repairs that were needed,
    and counting each one as a cell it had protected.
    """
    from execution.ocr_quality import _AR_NUM_TABLE   # single source of truth
    return "".join(ch for ch in str(s or "").translate(_AR_NUM_TABLE)
                   if ch.isdigit())


def _accept(issue: str, value: str) -> bool:
    """Only take a reply that satisfies the rule the original value broke."""
    # The reader is allowed to decline. Treating that as a failed match keeps
    # Azure's value, which is the right outcome for a cell nobody can read.
    if "UNREADABLE" in str(value or "").upper():
        return False
    d = _digits(value)
    if issue == "phone_format":
        return bool(_PHONE_RE.match(d))
    if issue == "id_format":
        return bool(_ID_RE.match(d))
    if issue == "date_format":
        # This used to be `len(value) >= 6`. It accepted anything six characters
        # long, and a thinking model told "this cell contains a date" will always
        # produce one: on a single attendance sheet it wrote back ربيع الأول,
        # "دی ۱۳۶۵", "مهر ۵۶" and "1 août" over real signatures. Now a reply has
        # to BE a date -- day/month/year in either order, with a four-digit
        # Gregorian year. A Hijri or Persian year, a month name, or a two-digit
        # year is rejected, and the cell keeps what Azure read.
        from execution.ocr_quality import _AR_NUM_TABLE
        s = str(value or "").translate(_AR_NUM_TABLE).strip()
        m = re.match(r"^(\d{1,4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,4})$", s)
        if not m:
            return False
        years = [int(g) for g in (m.group(1), m.group(3)) if len(g) == 4]
        return bool(years) and all(1900 <= y <= 2035 for y in years)
    return False


def _ask_gemini_once(png: bytes, issue: str, model: str):
    """
    Read one cell. Returns the text, or None if the ENGINE failed.

    The difference matters. This used to return "" for both a wrong answer and
    a dead API, and logged the reason at debug level -- so when the Gemini
    project was blocked for non-payment ("Lightning dunning decision is deny"),
    every call returned "", every repair was counted as "rejected", and the
    summary read "0 fixed, 5 rejected" exactly as though the model had merely
    been wrong. The stage was dead and still looked like it was running.
    """
    import base64, json, urllib.request

    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        logger.warning("[DigitRepair] GEMINI_API_KEY not set - engine unavailable")
        return None
    body = {
        "contents": [{"parts": [
            {"text": PROMPTS.get(issue, PROMPTS["phone_format"])},
            {"inline_data": {"mime_type": "image/png",
                             "data": base64.b64encode(png).decode()}}]}],
        # Greedy. Reading a number off a photograph has one right answer, and
        # sampling was giving a different one per run: across two passes over
        # the same 26 cells, id_10 came back 801112223 then 801112220 and
        # phone_11 0594445556 then 059445556, with nothing changed but the
        # temperature. That variance is indistinguishable from a real accuracy
        # difference, which made comparing two prompts meaningless.
        # No maxOutputTokens. Gemini 3 spends output budget on thinking before
        # it writes anything -- 142 to 258 thought tokens for a single cell --
        # so a cap sized for a 9-digit answer returns finishReason=MAX_TOKENS
        # and an empty string. Capping at 32 turned every read into "9" or "05".
        "generationConfig": {"temperature": 0, "candidateCount": 1},
    }
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={key}")
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            import json as _j
            d = _j.load(r)
        return d["candidates"][0]["content"]["parts"][0]["text"].strip().split("\n")[0]
    except Exception as e:
        detail = ""
        reader = getattr(e, "read", None)
        if callable(reader):
            try:
                detail = reader().decode()[:300]
            except Exception:
                pass
        code = getattr(e, "code", None)
        # A blocked project or a bad key answers the same way next time; a
        # dropped connection does not. Only the second kind is worth retrying.
        #
        # 429 is two different events. A rate limit clears in seconds and is
        # worth another go; a monthly SPEND CAP does not move until the month
        # turns, and retrying it three times a cell spends what is left of the
        # allowance on being refused faster.
        spend_cap = ("spend" in detail.lower()
                     or "exceeded its monthly" in detail.lower())
        _state.permanent = bool(spend_cap or code is not None and code != 429
                                and 400 <= code < 500)
        logger.warning(f"[DigitRepair] engine call failed: {e} {detail}")
        return None


def _ask_gemini(png: bytes, issue: str, model: str):
    """
    Read one cell, retrying the failures that are worth retrying.

    Returns the text, or None if the engine could not answer. A dropped
    connection is not the same event as a wrong reading, and giving up on the
    first one throws away a cell that would have read fine a moment later.
    """
    import time

    for attempt in range(3):
        _state.permanent = False
        out = _ask_gemini_once(png, issue, model)
        if out is not None or getattr(_state, "permanent", False):
            return out
        if attempt < 2:
            time.sleep(1.5 * (attempt + 1))
    return None


def repair_flagged_cells(structured_data: list, cell_polygons: list,
                         anomalies: list, doc_bytes: bytes,
                         content_type: str = "image/jpeg") -> dict:
    """
    Re-read every flagged cell and write back only replies that now validate.

    Returns {"attempted", "fixed", "rejected", "changes"}. Mutates
    structured_data in place. Never raises.
    """
    stats = {"attempted": 0, "fixed": 0, "rejected": 0, "declined": 0,
             "guard_blocked": 0, "engine_errors": 0, "changes": []}
    if not (enabled() and anomalies and cell_polygons and structured_data):
        return stats

    targets = [a for a in anomalies if a.get("issue") in REPAIRABLE]
    if not targets:
        return stats

    try:
        from execution.crop_names import (
            _DPI, _detect_polygon_unit, _exact_polygon_scale, _orient_to_polygons,
            _page_size_inches, _polygon_to_bbox_pixels, _render_pages,
            _upright_quarter_turn,
        )

        pages = _render_pages(doc_bytes, content_type)
        if not pages:
            return stats

        by_page: dict = {}
        size_by_page: dict = {}
        angle_by_page: dict = {}
        for cp in cell_polygons:
            pg = cp.get("page", 1)
            by_page.setdefault(pg, []).append(cp.get("polygon") or [])
            if pg not in size_by_page and cp.get("page_width"):
                size_by_page[pg] = (float(cp.get("page_width") or 0.0),
                                    float(cp.get("page_height") or 0.0))
            if pg not in angle_by_page and cp.get("page_angle") is not None:
                try:
                    angle_by_page[pg] = float(cp["page_angle"])
                except (TypeError, ValueError):
                    pass

        scale_by_page: dict = {}
        for pn, img in list(pages.items()):
            pw, ph = size_by_page.get(pn, (0.0, 0.0))
            sc = _exact_polygon_scale(img, pw, ph, _DPI)
            if sc is None:
                sc = _detect_polygon_unit(img, by_page.get(pn, []), _DPI)
            scale_by_page[pn] = sc
            oriented = _orient_to_polygons(img, by_page.get(pn, []), _DPI, unit_scale=sc)
            if oriented is not img:
                pages[pn] = oriented

        index = {(cp.get("participant_index"), cp.get("field_name")): cp
                 for cp in cell_polygons}
        model = os.getenv("GEMINI_MODEL", "gemini-3.7-flash")

        # Crop every flagged cell first (fast, local), then read them in parallel.
        work: list = []
        for a in targets:
            cp = index.get((a.get("row"), a.get("field")))
            if not cp or not cp.get("polygon"):
                continue

            # Prove the polygon belongs to the value being repaired.
            #
            # participant_index lines up with the structured_data index only as
            # long as the two row filters stay in step. They drifted once and a
            # repair cropped the row above: row 8's phone came back as row 7's
            # number, and it passed validation because validation proves the
            # FORMAT, not the SOURCE -- 0597778889 is ten digits starting 059.
            #
            # The cell carries its own text, so compare against that instead of
            # trusting the index. Cheap, and it fails closed.
            cell_digits  = _digits(cp.get("text"))
            found_digits = _digits(a.get("found"))
            if found_digits and cell_digits and cell_digits != found_digits:
                # Not a rejection -- nothing was asked. Counting it as one is
                # what made the summary read "5 rejected of 4 attempted".
                stats["guard_blocked"] += 1
                logger.warning(
                    f"[DigitRepair] row {a['row']} {a['field']}: cell holds "
                    f"{cell_digits!r} but QL4 flagged {found_digits!r} — "
                    f"refusing to repair a cell we cannot identify")
                continue
            pn  = cp.get("page", 1)
            img = pages.get(pn)
            if img is None:
                continue

            w_in, h_in = _page_size_inches(img, _DPI)
            # Pass the page's other cells so the padding stops at half the gap
            # to whichever one is adjacent. Without this, 52% of a numeric crop
            # on the rotated sheet was the row next door, and the reader
            # answered with that row's number.
            box = _polygon_to_bbox_pixels(cp["polygon"], _DPI, w_in, h_in,
                                          unit_scale=scale_by_page.get(pn, 1.0),
                                          neighbors=by_page.get(pn))
            if box is None:
                continue
            crop = img.crop(box)
            # Stand the crop upright, exactly as the name path does
            # (lora_names.py). Without this a photograph taken sideways --
            # page_angle 89.5 on the sheet that prompted this -- was handed to
            # the reader as digits rotated a quarter turn. It was never going to
            # read those, and the miss looked like a bad model rather than a
            # crop that nobody had turned the right way up.
            ccw = _upright_quarter_turn(angle_by_page.get(pn, 0.0))
            if ccw in (90, 180, 270):
                crop = crop.rotate(ccw, expand=True)

            buf = io.BytesIO()
            crop.save(buf, format="PNG")

            stats["attempted"] += 1
            work.append((a, buf.getvalue()))

        # -- Ask Gemini, several cells at once --------------------------------
        # This used to be one cell at a time. Each Gemini 3 call takes ~9.5s
        # from here, so a sheet with 65 flagged cells spent 616s of a 13-minute
        # run waiting in a queue of one -- while the Gemini Judge, on the same key, reads
        # eight at a time. The cells are independent: each request carries one
        # crop and its own prompt, the retry verdict is thread-local (_state),
        # and every write below targets a different cell. So only the network
        # wait is spread across threads; the cropping above and the writes
        # below stay on this thread, in the original order.
        def _read(item):
            a, png = item
            # Ask again when the reader DECLINES. Measured on one crop, five
            # times, at temperature 0: the same bytes came back 0599111222
            # three times and UNREADABLE twice. Thinking models are not
            # deterministic even greedily, so a single attempt throws away two
            # readings in five that the model is perfectly able to produce.
            #
            # Only a decline is retried. A wrong ANSWER is never re-asked --
            # that would be fishing for one that happens to validate, which is
            # the behaviour the format prompt already had to be talked out of.
            declined = 0
            reply = _ask_gemini(png, a["issue"], model)
            for _ in range(2):
                if reply is None or "UNREADABLE" not in str(reply).upper():
                    break
                declined += 1
                reply = _ask_gemini(png, a["issue"], model)
            return reply, declined

        import concurrent.futures
        workers = max(1, int(os.getenv("DIGIT_REPAIR_WORKERS", "4")))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            replies = list(ex.map(_read, work))      # map() keeps input order

        for (a, _png), (reply, declined) in zip(work, replies):
            stats["declined"] = stats.get("declined", 0) + declined
            if reply is None:
                stats["engine_errors"] += 1
                continue
            if not reply or not _accept(a["issue"], reply):
                stats["rejected"] += 1
                logger.info(f"[DigitRepair] row {a['row']} {a['field']}: "
                            f"rejected {reply!r} (still fails {a['issue']})")
                continue

            value = _digits(reply) if a["issue"] != "date_format" else reply.strip()
            row = a.get("row")
            if isinstance(row, int) and 0 <= row < len(structured_data):
                before = structured_data[row].get(a["field"])
                structured_data[row][a["field"]] = value
                stats["fixed"] += 1
                stats["changes"].append({"row": row, "field": a["field"],
                                         "before": before, "after": value})
                logger.info(f"[DigitRepair] row {row} {a['field']}: {before!r} -> {value!r}")

    except Exception as e:
        logger.warning(f"[DigitRepair] failed (non-fatal): {e}")
        stats["error"] = str(e)

    # Every call failing is an outage, not a run of bad answers. Say so where
    # someone will see it -- this is precisely the failure that stayed hidden.
    if stats["attempted"] and stats["engine_errors"] == stats["attempted"]:
        msg = (f"digit repair engine answered nothing on "
               f"{stats['attempted']} cell(s) - numbers are NOT being corrected")
        logger.error(f"[DigitRepair] {msg}")
        try:
            from execution import alerts
            alerts.send(":rotating_light: *Digit repair is down* - " + msg)
        except Exception:
            pass
    return stats
