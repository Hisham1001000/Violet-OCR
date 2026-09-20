"""Probe the live Supabase project the way an attacker with the browser key would.

NEXT_PUBLIC_SUPABASE_ANON_KEY ships inside every page of violetocr.com, so the
only honest test of "is the database locked down" is to use that key from
outside the app and see what comes back. This script makes raw HTTPS calls
against /rest/v1/ rather than going through the SDK, so what it proves is
exactly what a stranger can do.

    python scripts/verify_security.py

Prints CLOSED / STILL OPEN per check and exits non-zero if anything is open.
Two checks must attempt a write to be meaningful; both clean up after
themselves with the service key and say so in the output.

Reads credentials from frontend/.env.local (falling back to .env). Contains no
secrets itself and is safe to commit.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROBE_MARKER = "__violet_security_probe__"


def load_env() -> None:
    for name in ("frontend/.env.local", ".env"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def request(method: str, url: str, key: str, body: dict | None = None,
            extra_headers: dict | None = None) -> tuple[int, str]:
    """Return (status, body). Never raises for HTTP errors - the status is the result."""
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    headers.update(extra_headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # network, DNS, timeout
        return 0, f"{type(e).__name__}: {e}"


class Report:
    def __init__(self) -> None:
        self.open_count = 0
        self.rows: list[tuple[str, bool, str]] = []

    def record(self, name: str, is_open: bool, detail: str) -> None:
        self.rows.append((name, is_open, detail))
        if is_open:
            self.open_count += 1
        state = "STILL OPEN" if is_open else "CLOSED"
        print(f"  [{state:^10}] {name}\n               {detail}")


def main() -> int:
    load_env()
    url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    anon = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""
    service = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""

    if not url or not anon:
        print("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY", file=sys.stderr)
        return 2

    print(f"Probing {url} with the public anon key\n")
    r = Report()

    # 1 - extracted_names (019). A view without security_invoker runs as its
    #     owner and ignores RLS, exposing every user's names and document URLs.
    status, body = request(
        "GET", f"{url}/rest/v1/extracted_names?select=final_value,document_name&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("extracted_names readable by anon",
             bool(rows),
             f"HTTP {status} | {len(rows) if rows is not None else 0} rows"
             + ("" if rows else f" | {body[:110]}"))

    # 2 - upsert_ocr_corrections (011). Writes the global correction table the
    #     pipeline applies to everyone's future documents.
    status, body = request(
        "POST", f"{url}/rest/v1/rpc/upsert_ocr_corrections", anon,
        {"pairs": [{"original_text": PROBE_MARKER, "corrected_text": PROBE_MARKER}]})
    poisoned = status in (200, 201, 204)
    r.record("upsert_ocr_corrections callable by anon", poisoned,
             f"HTTP {status} | {body[:110]}")
    if poisoned and service:
        st, _ = request("DELETE",
                        f"{url}/rest/v1/ocr_corrections?original_text=eq.{PROBE_MARKER}", service)
        print(f"               cleaned up probe row (HTTP {st})")

    # 3 - training_file_stats (028): cross-user training metadata.
    status, body = request("POST", f"{url}/rest/v1/rpc/training_file_stats", anon, {})
    r.record("training_file_stats callable by anon",
             status in (200, 201), f"HTTP {status} | {body[:110]}")

    # 4 - increment_pages_used (003): lets anyone inflate another account's usage.
    #     Scored on whether the function RAN, not on whether it succeeded: a
    #     foreign-key error (23503) means anon reached the function body, which
    #     is exactly the hole. Only "not found" or "permission denied" is closed.
    status, body = request(
        "POST", f"{url}/rest/v1/rpc/increment_pages_used", anon,
        {"p_user_id": "00000000-0000-0000-0000-000000000000", "p_pages": 0})
    denied = status in (401, 403) or "PGRST202" in body or "42501" in body or "42883" in body
    r.record("increment_pages_used callable by anon", not denied,
             f"HTTP {status} | " + ("reached the function body" if not denied else body[:110]))

    # 5 - field_corrections: every cell every customer has ever corrected.
    #     Note: RLS with no SELECT policy returns an EMPTY ARRAY, not an error.
    #     Empty counts as closed, but the two cases are printed differently.
    status, body = request(
        "GET", f"{url}/rest/v1/field_corrections?select=original_value,corrected_value&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("field_corrections readable by anon", bool(rows),
             f"HTTP {status} | "
             + (f"{len(rows)} rows returned" if rows
                else ("empty array (RLS denies, no error)" if rows == [] else body[:110])))

    # 6 - ocr_corrections: the correction rules themselves.
    status, body = request("GET", f"{url}/rest/v1/ocr_corrections?select=original_text&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("ocr_corrections readable by anon", bool(rows),
             f"HTTP {status} | " + (f"{len(rows)} rows" if rows else body[:110]))

    # 7 - name_candidates: the name-dictionary staging table.
    status, body = request("GET", f"{url}/rest/v1/name_candidates?select=name&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("name_candidates readable by anon", bool(rows),
             f"HTTP {status} | " + (f"{len(rows)} rows" if rows else body[:110]))

    # 8 - training_dataset (024): crops of customer documents.
    status, body = request("GET", f"{url}/rest/v1/training_dataset?select=id&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("training_dataset readable by anon", bool(rows),
             f"HTTP {status} | " + (f"{len(rows)} rows" if rows else body[:110]))

    # 9 - regression for 033: extracted content must stay unreadable.
    status, body = request(
        "GET", f"{url}/rest/v1/document_jobs?select=structured_data&limit=1", anon)
    rows = json.loads(body) if status == 200 and body.strip().startswith("[") else None
    r.record("document_jobs.structured_data readable by anon (033 regression)",
             bool(rows), f"HTTP {status} | " + (f"{len(rows)} rows" if rows else body[:110]))

    # 10 - regression for 039: money columns must stay unwritable.
    status, body = request(
        "PATCH",
        f"{url}/rest/v1/user_profiles?user_id=eq.00000000-0000-0000-0000-000000000000",
        anon, {"balance_cents": 999999})
    r.record("user_profiles.balance_cents writable by anon (039 regression)",
             status in (200, 204), f"HTTP {status} | {body[:110]}")

    # 11 - storage: can a stranger list the documents bucket?
    status, body = request("POST", f"{url}/storage/v1/object/list/documents", anon,
                           {"prefix": "", "limit": 1})
    listed = status == 200 and body.strip().startswith("[") and body.strip() != "[]"
    r.record("documents bucket listable by anon", listed, f"HTTP {status} | {body[:110]}")

    # 12 - storage posture, read-only, service key: are the buckets private?
    if service:
        status, body = request("GET", f"{url}/storage/v1/bucket", service)
        try:
            buckets = json.loads(body)
            public = [b["id"] for b in buckets if b.get("public")]
        except Exception:
            public = []
            buckets = []
        r.record("any storage bucket marked public", bool(public),
                 f"HTTP {status} | "
                 + (f"public: {', '.join(public)}" if public
                    else f"all {len(buckets)} buckets private"))

    # 13 - the Modal pipeline endpoint must refuse an unsigned request.
    # VERIFY_MODAL_URL wins, because MODAL_PROCESS_DOCUMENT_URL in a local .env
    # usually points at 127.0.0.1:8001. Probing that proves nothing about the
    # endpoint that is actually exposed to the internet, and a SKIPPED line is
    # easy to read past as if it were a pass.
    modal = (os.environ.get("VERIFY_MODAL_URL")
             or os.environ.get("MODAL_PROCESS_DOCUMENT_URL") or "").strip()
    is_local = any(h in modal for h in ("localhost", "127.0.0.1", "0.0.0.0"))
    if not modal:
        print("  [ SKIPPED  ] Modal pipeline check - set VERIFY_MODAL_URL to the "
              "deployed process-document URL")
    elif is_local:
        print(f"  [ SKIPPED  ] Modal pipeline check - {modal} is a local address, "
              "which says nothing about production. Set VERIFY_MODAL_URL.")
    else:
        status, body = request("POST", modal, "", {"job_id": "00000000-0000-0000-0000-000000000000"})
        if status == 0:
            # Offline - report it rather than letting "no connection"
            # masquerade as "endpoint is secure".
            print(f"  [ SKIPPED  ] Modal pipeline check - {modal} unreachable: {body[:60]}")
        else:
            # Anything other than 401 is a finding: a 400 means it read the body
            # before checking the token, a 202 means it queued the work.
            r.record("Modal pipeline accepts unsigned requests",
                     status != 401, f"HTTP {status} | {body[:110]}")

    # ASCII only: this runs in a cp1256 console on the owner's machine, where a
    # box-drawing character raises UnicodeEncodeError and hides the result.
    print("\n" + "-" * 72)
    if r.open_count:
        print(f"{r.open_count} of {len(r.rows)} checks STILL OPEN")
        return 1
    print(f"all {len(r.rows)} checks CLOSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
