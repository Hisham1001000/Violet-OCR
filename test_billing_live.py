# -*- coding: utf-8 -*-
"""
Live billing test: the real database, the real local website, a throwaway account.

Costs nothing: no OCR, no Gemini, no GPU. It never touches a real account. It
creates billing-test-<time>@example.com, gives it test credit through the same
admin function the admin panel uses, and deletes the account and everything it
made at the end, including when a check fails.

What it proves, in order:
   1. a new account starts with $0.50
   2. customers cannot call the money functions or edit money columns directly
   3. prices: rows x 1.5 cents, rounded up per run
   4. every run is charged, the same document included
   5. not enough credit -> processed, held, nothing taken
   6. a held document is locked on the website and in Excel export
   7. "check again": nothing while short, one charge once topped up, never two
   8. the "charged" notice only fires for a charge that just happened
   9. /api/usage and /api/billing report the ledger faithfully
  10. upload / reprocess guards: no credit -> refused; same file still running
      -> no second run
  11. the pricing and billing pages show the new price

Needs: migrations 030-037 applied, the website running (npm run dev, :3000).
Run:   ALLOW_LIVE_BILLING_TEST=1 python test_billing_live.py
"""
import os as _os
import sys as _sys

# This writes to the REAL database named by SUPABASE_SERVICE_ROLE_KEY. It only
# ever touches a throwaway account it creates and deletes, but it is still
# production, so it refuses to start unless you ask for it deliberately.
if _os.getenv("ALLOW_LIVE_BILLING_TEST") != "1":
    _sys.exit(
        "Refusing to run: this test writes to the production database.\n"
        "Re-run with ALLOW_LIVE_BILLING_TEST=1 if that is what you intend."
    )

import base64
import hashlib
import json
import os
import sys
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8")
from dotenv import load_dotenv

load_dotenv(".env")
load_dotenv("frontend/.env.local")

SB   = (os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")).rstrip("/")
SVC  = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
ANON = os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_ANON_KEY")
WEB  = os.getenv("BILLING_TEST_WEB", "http://127.0.0.1:3000")
REF  = SB.split("//")[1].split(".")[0]
COOKIE = ""


def cost(rows: int) -> int:
    """Must equal settle_job (migration 037) and costOfRows in billing.ts."""
    return (rows * 3 + 1) // 2


_fail: list = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n          -> {detail}" if detail and not ok else ""))
    if not ok:
        _fail.append(name)


# ── HTTP plumbing ────────────────────────────────────────────────────────────

def http(method, url, body=None, headers=None, raw=None, timeout=45, retries=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = dict(headers or {})
    if data is not None and raw is None:
        h.setdefault("Content-Type", "application/json")
    # GET/PATCH/DELETE are retried: a dropped connection on a bad line must not
    # end the run, and they give the same result however many times they land.
    # A POST is sent ONCE unless the caller asks for retries -- re-sending a
    # charge that did go through would take the money twice and make the test
    # report a bug that is not there. Callers that cannot simply resend use
    # resilient() below, which checks whether the first attempt landed.
    tries = retries if retries is not None else (1 if method == "POST" else 3)
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
            code, txt = r.status, r.read().decode("utf-8", "replace")
            break
        except urllib.error.HTTPError as e:
            code, txt = e.code, e.read().decode("utf-8", "replace")
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
    try:
        js = json.loads(txt) if txt else None
    except ValueError:
        js = None
    return code, js, txt


NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError)


def resilient(send, landed):
    """Send something that must never be sent twice blindly.

    `send()` makes the request. If the connection dies before the reply arrives,
    `landed()` decides what happened: it returns the reply to use when the
    request took effect anyway, or None when nothing happened and it is safe to
    send again. Written for a connection that drops mid-request.
    """
    for attempt in range(3):
        try:
            return send()
        except NETWORK_ERRORS:
            done = landed()
            if done is not None:
                return done
            if attempt == 2:
                raise


def svc_headers(extra=None):
    h = {"apikey": SVC, "Authorization": "Bearer " + SVC}
    h.update(extra or {})
    return h


def rest(method, path, body=None, prefer=None, jwt=None):
    if jwt:
        h = {"apikey": ANON, "Authorization": "Bearer " + jwt}
        if prefer:
            h["Prefer"] = prefer
    else:
        h = svc_headers({"Prefer": prefer} if prefer else None)
    return http(method, f"{SB}/rest/v1/{path}", body, h)


def rpc(name, args, jwt=None, as_anon=False):
    if as_anon or jwt:
        # Called as a visitor or a customer, which must be refused -- and a
        # refused call changes nothing, so it is safe to send again.
        h = {"apikey": ANON, "Authorization": "Bearer " + (jwt or ANON)}
        return http("POST", f"{SB}/rest/v1/rpc/{name}", args, h, retries=3)
    return http("POST", f"{SB}/rest/v1/rpc/{name}", args, svc_headers())


def web(method, path, body=None, raw=None, ctype=None, retries=None):
    h = {"Cookie": COOKIE, "Origin": WEB}
    if ctype:
        h["Content-Type"] = ctype
    return http(method, WEB + path, body=body, headers=h, raw=raw, retries=retries)


def session_cookie(session: dict) -> str:
    """The cookie @supabase/ssr 0.5 reads: base64url JSON, chunked at 3180."""
    name = f"sb-{REF}-auth-token"
    value = "base64-" + base64.urlsafe_b64encode(json.dumps(session).encode()).decode().rstrip("=")
    if len(value) <= 3180:
        return f"{name}={value}"
    parts = [value[i:i + 3180] for i in range(0, len(value), 3180)]
    return "; ".join(f"{name}.{i}={p}" for i, p in enumerate(parts))


# ── Database helpers (service role) ──────────────────────────────────────────

def one(path):
    _, js, _ = rest("GET", path)
    return js[0] if isinstance(js, list) and js else None


def profile(uid):
    return one(f"user_profiles?select=balance_cents,rows_used_total,cents_spent_total&user_id=eq.{uid}")


def balance(uid):
    return (profile(uid) or {}).get("balance_cents")


def set_balance(uid, target):
    # Reads the balance again on each pass: when a dropped connection hides
    # whether add_balance landed, the next pass adds only what is still missing.
    for _ in range(3):
        diff = target - balance(uid)
        if not diff:
            return
        try:
            rpc("add_balance", {"p_user_id": uid, "p_amount_cents": diff,
                                "p_kind": "adjust", "p_note": "billing test"})
        except NETWORK_ERRORS:
            pass
    if balance(uid) != target:
        raise RuntimeError(f"could not set the test balance to {target} cents")


def charges(jid):
    _, js, _ = rest("GET", f"billing_transactions?select=amount_cents,created_at"
                           f"&job_id=eq.{jid}&kind=eq.charge&order=created_at.asc")
    return js or []


def job(jid):
    return one(f"document_jobs?select=status,row_count,cost_cents,payment_status,completed_at,structured_data&id=eq.{jid}")


def new_job(uid, status="processing", file_hash=None):
    url = f"billing-test/{uuid.uuid4().hex}.png"
    body = {"user_id": uid, "document_name": "billing test", "status": status,
            "document_url": url}
    if file_hash:
        body["file_hash"] = file_hash

    def landed():
        # The url is unique to this call, so finding it means the insert landed
        # and resending would leave two jobs where the test counts one.
        row = one(f"document_jobs?select=id&document_url=eq.{url}")
        return (201, [row], "") if row else None

    code, js, txt = resilient(
        lambda: rest("POST", "document_jobs", body, prefer="return=representation"), landed)
    if code not in (200, 201):
        raise RuntimeError(f"could not insert a test job: {code} {txt[:200]}")
    return js[0]["id"]


def patch_job(jid, fields):
    rest("PATCH", f"document_jobs?id=eq.{jid}", fields)


def settle(uid, jid, rows):
    """Charge one run, and never send it twice without checking: a second
    settle_job that did land would take the money again -- which is exactly what
    section 4 asserts happens once per run."""
    before = (len(charges(jid)), (job(jid) or {}).get("payment_status"))

    def landed():
        if (len(charges(jid)), (job(jid) or {}).get("payment_status")) == before:
            return None                      # nothing happened; safe to resend
        j = job(jid) or {}
        bal = balance(uid)
        return (200, {"status": j.get("payment_status"), "cost_cents": j.get("cost_cents"),
                      "balance_cents": bal,
                      "shortfall_cents": max(0, (j.get("cost_cents") or 0) - bal),
                      "recovered_after_drop": True}, "")

    _, js, txt = resilient(
        lambda: rpc("settle_job", {"p_job_id": jid, "p_user_id": uid, "p_rows": rows}), landed)
    if not isinstance(js, dict):
        raise RuntimeError(f"settle_job failed: {txt[:200]}")
    return js


def finish_like_pipeline(jid):
    """The pipeline flips to completed seconds after settle_job. Use the ledger's
    own timestamp so the local clock cannot skew the 'just charged' window."""
    ch = charges(jid)
    stamp = ch[-1]["created_at"] if ch else None
    patch_job(jid, {"status": "completed", "completed_at": stamp or "now()",
                    "structured_data": [{"الاسم": "اختبار الفوترة", "رقم الهاتف": "0599000000"}]})


def denied(code, js):
    return code in (401, 403, 404) or (isinstance(js, dict) and js.get("code") in ("42501", "PGRST202"))


# ── The test ─────────────────────────────────────────────────────────────────

def run(uid, email, password):
    global COOKIE
    # Signing in twice is harmless, so this one simply retries.
    code, sess, txt = http("POST", f"{SB}/auth/v1/token?grant_type=password",
                           {"email": email, "password": password}, {"apikey": ANON}, retries=3)
    if code != 200:
        raise RuntimeError(f"could not sign the test user in: {code} {txt[:200]}")
    jwt = sess["access_token"]
    COOKIE = session_cookie(sess)

    code, js, txt = web("GET", "/api/usage")
    if code != 200:
        raise RuntimeError(f"the website did not accept the test login (GET /api/usage -> {code} {txt[:150]}). Is npm run dev up?")

    print("\n1. New account")
    p = profile(uid)
    check("starts with $0.50 free credit", p and p["balance_cents"] == 50, f"profile={p}")
    _, g, _ = rest("GET", f"billing_transactions?select=kind,amount_cents&user_id=eq.{uid}")
    check("the free credit is on the statement", g == [{"kind": "grant", "amount_cents": 50}], f"ledger={g}")

    print("\n2. Customers cannot reach the money")
    probe_job = new_job(uid, status="completed")
    attempts = [
        ("settle_job",       {"p_job_id": probe_job, "p_user_id": uid, "p_rows": 0}),
        ("apply_job_charge", {"p_job_id": probe_job, "p_user_id": uid, "p_rows": 0, "p_cost": -100000}),
        ("add_balance",      {"p_user_id": uid, "p_amount_cents": 100000}),
    ]
    for name, args in attempts:
        for who, kw in (("a visitor", {"as_anon": True}), ("a signed-in customer", {"jwt": jwt})):
            code, js, txt = rpc(name, args, **kw)
            check(f"{who} cannot call {name}", denied(code, js), f"HTTP {code} {txt[:160]}")
    rest("PATCH", f"user_profiles?user_id=eq.{uid}", {"is_banned": True})      # as the service role
    for field, evil in (("balance_cents", 999999), ("is_admin", True), ("is_trainer", True),
                        ("is_banned", False), ("rows_used_total", 12345), ("cents_spent_total", 12345)):
        before = one(f"user_profiles?select={field}&user_id=eq.{uid}")
        code, _, txt = rest("PATCH", f"user_profiles?user_id=eq.{uid}", {field: evil}, jwt=jwt)
        after = one(f"user_profiles?select={field}&user_id=eq.{uid}")
        check(f"a customer cannot change their own {field}", after == before,
              f"{before} -> {after} (HTTP {code} {txt[:80]})")
    rest("PATCH", f"user_profiles?user_id=eq.{uid}", {"is_banned": False})

    held = new_job(uid, status="completed")
    patch_job(held, {"payment_status": "unpaid", "row_count": 14, "cost_cents": 21})
    for field, evil in (("payment_status", "paid"), ("cost_cents", 0), ("row_count", 0)):
        rest("PATCH", f"document_jobs?id=eq.{held}", {field: evil}, jwt=jwt)
    j = job(held)
    check("a customer cannot mark a held document paid, or change its cost or row count",
          j["payment_status"] == "unpaid" and j["cost_cents"] == 21 and j["row_count"] == 14, f"job={j}")
    code, js, txt = rest("POST", "document_jobs?select=id",
                         {"user_id": uid, "document_name": "sneaky", "status": "completed",
                          "document_url": "billing-test/sneaky.png", "payment_status": "paid", "cost_cents": 0},
                         prefer="return=representation", jwt=jwt)
    _, sneaky, _ = rest("GET", f"document_jobs?select=id&user_id=eq.{uid}&document_name=eq.sneaky&payment_status=eq.paid")
    check("a customer cannot create a document that is already paid", not sneaky, f"HTTP {code} {txt[:120]}")

    # ...while everything the website really does with a customer's login still works.
    code, js, txt = rest("POST", "document_jobs?select=id",
                         {"user_id": uid, "document_name": "billing test upload", "status": "pending",
                          "document_url": f"billing-test/{uuid.uuid4().hex}.png", "file_hash": uuid.uuid4().hex},
                         prefer="return=representation", jwt=jwt)
    mine = js[0]["id"] if code in (200, 201) and js else None
    check("a customer can still create a document (what upload does)", bool(mine), f"HTTP {code} {txt[:150]}")
    if mine:
        code, _, txt = rest("PATCH", f"document_jobs?id=eq.{mine}",
                            {"status": "failed", "error_message": "billing test", "completed_at": None}, jwt=jwt)
        j = job(mine)
        check("a customer can still move a document's status (what upload/reprocess do)",
              j["status"] == "failed", f"HTTP {code} {txt[:120]} job={j}")
        patch_job(mine, {"status": "completed"})
        code, js, txt = web("PATCH", f"/api/documents/{mine}",
                            body={"structured_data": [{"الاسم": "تعديل يدوي"}], "column_order": ["الاسم"]})
        j = job(mine)
        check("a customer can still save edits to their table", code == 200
              and j["structured_data"] == [{"الاسم": "تعديل يدوي"}], f"HTTP {code} {txt[:120]}")
    code, js, txt = rest("POST", "billing_transactions",
                         {"user_id": uid, "kind": "topup", "amount_cents": 100000, "balance_after": 100050}, jwt=jwt)
    check("a customer cannot write a top-up into the ledger", denied(code, js) or code == 400, f"HTTP {code} {txt[:120]}")
    check("balance untouched by all of the above", balance(uid) == 50, f"balance={balance(uid)}")

    print("\n3. Prices (1.5 cents a row, rounded up per run)")
    set_balance(uid, 1000)
    for rows in (0, 1, 14, 15, 20):
        jid = new_job(uid)
        before = profile(uid)
        r = settle(uid, jid, rows)
        after = profile(uid)
        ok = (r.get("status") == "paid" and r.get("cost_cents") == cost(rows)
              and after["balance_cents"] == before["balance_cents"] - cost(rows)
              and after["cents_spent_total"] == before["cents_spent_total"] + cost(rows)
              and len(charges(jid)) == (1 if cost(rows) else 0))
        check(f"{rows:>2} rows = {cost(rows)} cents, taken once, spend counter updated", ok,
              f"reply={r} before={before} after={after} charges={charges(jid)}")

    print("\n4. Every run is charged")
    jid = new_job(uid)
    b0 = balance(uid)
    settle(uid, jid, 14)
    patch_job(jid, {"status": "processing"})           # the same document, reprocessed
    settle(uid, jid, 14)
    check("processing the same document twice charges twice", len(charges(jid)) == 2 and balance(uid) == b0 - 42,
          f"charges={charges(jid)} balance {b0} -> {balance(uid)}")

    print("\n5. Not enough credit")
    set_balance(uid, 10)
    short = new_job(uid)
    r = settle(uid, short, 14)
    check("the run is held, not refused", r.get("status") == "unpaid" and r.get("shortfall_cents") == 11, f"reply={r}")
    check("nothing is taken", balance(uid) == 10 and charges(short) == [], f"balance={balance(uid)} charges={charges(short)}")
    finish_like_pipeline(short)

    print("\n6. A held document stays locked")
    code, js, txt = web("GET", f"/api/documents/{short}")
    check("the website withholds the rows", code == 200 and js.get("locked") is True and js.get("structured_data") is None
          and js.get("shortfall_cents") == 11, f"HTTP {code} {txt[:200]}")
    code, js, txt = web("POST", f"/api/documents/{short}/export", body={}, retries=3)
    if code == 405:
        code, js, txt = web("GET", f"/api/documents/{short}/export")
    check("Excel export is refused", code == 402, f"HTTP {code} {txt[:150]}")
    code, js, txt = rest("GET", f"document_jobs?select=structured_data&id=eq.{short}", jwt=jwt)
    check("the rows cannot be read straight from the database", denied(code, js), f"HTTP {code} {txt[:150]}")

    print("\n7. Check again")
    code, js, txt = web("POST", f"/api/documents/{short}/settle", retries=3)
    check("still short: stays held, nothing taken", code == 200 and js.get("paid") is False
          and balance(uid) == 10 and charges(short) == [], f"HTTP {code} {txt[:150]} balance={balance(uid)}")
    rpc("add_balance", {"p_user_id": uid, "p_amount_cents": 100, "p_kind": "topup", "p_note": "billing test"})
    code, js, txt = web("POST", f"/api/documents/{short}/settle", retries=3)
    check("topped up: unlocks at the quoted 21 cents", code == 200 and js.get("paid") is True and balance(uid) == 89,
          f"HTTP {code} {txt[:150]} balance={balance(uid)}")
    web("POST", f"/api/documents/{short}/settle", retries=3)
    check("pressing it again does not charge again", len(charges(short)) == 1 and balance(uid) == 89,
          f"charges={charges(short)} balance={balance(uid)}")
    code, js, txt = web("GET", f"/api/documents/{short}")
    check("the rows are back", code == 200 and not js.get("locked") and js.get("structured_data"), f"HTTP {code} {txt[:150]}")

    print("\n8. The 'charged' notice")
    fresh = new_job(uid)
    settle(uid, fresh, 14)
    finish_like_pipeline(fresh)
    code, js, txt = web("GET", f"/api/documents/{fresh}")
    check("a charge that just happened is announced", code == 200 and js.get("just_charged") is True
          and js.get("charged_at"), f"HTTP {code} just_charged={js and js.get('just_charged')}")
    stamp = datetime.fromisoformat(charges(fresh)[-1]["created_at"].replace("Z", "+00:00"))
    patch_job(fresh, {"completed_at": (stamp + timedelta(days=2)).isoformat()})   # reopened days later
    code, js, txt = web("GET", f"/api/documents/{fresh}")
    check("an old charge is not announced as new", code == 200 and js.get("just_charged") is False,
          f"HTTP {code} just_charged={js and js.get('just_charged')}")

    print("\n9. Balance and statement")
    p = profile(uid)
    code, js, txt = web("GET", "/api/usage")
    check("/api/usage matches the database", code == 200 and js["balance_cents"] == p["balance_cents"]
          and js["spent_cents"] == p["cents_spent_total"] and js["rows_affordable"] == (p["balance_cents"] * 2) // 3
          and js["can_upload"] is True, f"api={js} db={p}")
    _, ledger, _ = rest("GET", f"billing_transactions?select=id&user_id=eq.{uid}")
    set_balance(uid, 1)
    held2 = new_job(uid)
    settle(uid, held2, 14)
    code, js, txt = web("GET", "/api/billing")
    check("/api/billing lists the statement and the held document", code == 200
          and len(js.get("transactions", [])) >= len(ledger) and any(h["id"] == held2 for h in js.get("held", [])),
          f"HTTP {code} txns={len((js or {}).get('transactions', []))} held={(js or {}).get('held')}")

    print("\n10. Upload and reprocess guards")
    set_balance(uid, 0)
    code, js, txt = web("POST", f"/api/documents/{fresh}/reprocess", retries=3)
    check("no credit: reprocess refused", code == 402, f"HTTP {code} {txt[:120]}")
    fake = b"billing-test, not an image " + uuid.uuid4().bytes
    boundary = "violet" + uuid.uuid4().hex
    form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"billing-test.png\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + fake + f"\r\n--{boundary}--\r\n".encode()
    code, js, txt = web("POST", "/api/upload", raw=form,
                        ctype=f"multipart/form-data; boundary={boundary}", retries=3)
    check("no credit: upload refused", code == 402, f"HTTP {code} {txt[:120]}")
    set_balance(uid, 500)
    running = new_job(uid, status="processing", file_hash=hashlib.sha256(fake).hexdigest())
    _, before_jobs, _ = rest("GET", f"document_jobs?select=id&user_id=eq.{uid}")
    code, js, txt = web("POST", "/api/upload", raw=form,
                        ctype=f"multipart/form-data; boundary={boundary}", retries=3)
    _, after_jobs, _ = rest("GET", f"document_jobs?select=id,document_url&user_id=eq.{uid}")
    check("same file while it is still running: hands back that run, starts nothing",
          code == 200 and (js or {}).get("job_id") == running and len(after_jobs) == len(before_jobs)
          and job(running)["status"] == "processing", f"HTTP {code} {txt[:150]} jobs {len(before_jobs)} -> {len(after_jobs)}")
    code, js, txt = web("POST", f"/api/documents/{running}/reprocess", retries=3)
    check("reprocess of a document still running is refused", code == 400, f"HTTP {code} {txt[:120]}")
    check("none of the guards took money", balance(uid) == 500, f"balance={balance(uid)}")

    print("\n11. Price shown on the pages")
    code, _, html = web("GET", "/pricing")
    check("pricing page shows $0.015 a row and $0.50 free", code == 200 and "$0.015" in html and "$0.50" in html,
          f"HTTP {code} has $0.015={'$0.015' in html} has $0.50={'$0.50' in html}")
    check("pricing page no longer says reprocessing is free",
          "Reprocessing a document you paid for is free" not in html and "دفعت ثمنه مجان" not in html)
    code, _, html = web("GET", "/billing")
    check("billing page says 1.5 cents per row", code == 200 and ("1.5 cents" in html or "سنت ونصف" in html),
          f"HTTP {code}")


def cleanup(uid):
    _, jobs, _ = rest("GET", f"document_jobs?select=document_url&user_id=eq.{uid}")
    for j in jobs or []:
        path = j.get("document_url") or ""
        if path and not path.startswith("billing-test/"):          # only if a guard failed and a real upload happened
            http("DELETE", f"{SB}/storage/v1/object/documents/{path}", headers=svc_headers())
    for table in ("billing_transactions", "document_jobs", "user_profiles"):
        rest("DELETE", f"{table}?user_id=eq.{uid}")
    code, _, txt = http("DELETE", f"{SB}/auth/v1/admin/users/{uid}", headers=svc_headers())
    left = {t: (rest("GET", f"{t}?select=user_id&user_id=eq.{uid}")[1] or [])
            for t in ("billing_transactions", "document_jobs", "user_profiles")}
    gone = code in (200, 204) and not any(left.values())
    print(f"\nCleanup: test account {'deleted with everything it made' if gone else 'NOT fully deleted'}"
          + ("" if gone else f" (auth delete HTTP {code} {txt[:100]}, left={ {k: len(v) for k, v in left.items()} })"))
    return gone


def main():
    if not (SB and SVC and ANON):
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / anon key in .env or frontend/.env.local")
        return 2
    email = f"billing-test-{datetime.now():%Y%m%d%H%M%S}@example.com"
    password = "Bt-" + uuid.uuid4().hex
    def account_landed():
        # A second create would fail on the unique email, so look it up instead.
        _, found, _ = http("GET", f"{SB}/auth/v1/admin/users?filter={email}", headers=svc_headers())
        users = [x for x in ((found or {}).get("users") or []) if x.get("email") == email]
        return (200, users[0], "") if users else None

    code, u, txt = resilient(
        lambda: http("POST", f"{SB}/auth/v1/admin/users",
                     {"email": email, "password": password, "email_confirm": True}, svc_headers()),
        account_landed)
    if code not in (200, 201):
        print(f"Could not create the test account: HTTP {code} {txt[:200]}")
        return 2
    uid = u["id"]
    print(f"Test account {email}")
    crashed = None
    try:
        run(uid, email, password)
    except Exception as e:                      # still clean up, still report
        crashed = e
    finally:
        cleaned = cleanup(uid)
    if crashed:
        print(f"\nSTOPPED EARLY: {crashed}")
    verdict = ("ALL PASSED" if not _fail and not crashed
               else f"{len(_fail)} FAILED" if _fail
               else "NOT FINISHED - the checks after the stop did not run")
    print(f"\n{verdict}"
          + ("" if cleaned else "  (and cleanup incomplete)"))
    for f in _fail:
        print(f"  - {f}")
    return 0 if not _fail and not crashed and cleaned else 1


if __name__ == "__main__":
    sys.exit(main())
