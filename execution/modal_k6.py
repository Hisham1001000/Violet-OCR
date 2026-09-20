# -*- coding: utf-8 -*-
"""
execution/modal_k6.py — run the k6 load test from a datacenter.

    modal run execution/modal_k6.py
    modal run execution/modal_k6.py --vus 100 --hold 60s

Why this exists: running k6 from the office measures the office. On the first
local run the API answered 50 virtual users at 377ms p95 while pages timed out
at 40%, and with NO load at all the same 16 KB page took between 1.8s and 13.7s.
The link saturated at 2.2 Mbit/s, so everything above roughly 15 VUs was
queueing on this side and told us nothing about Vercel or Supabase.

Same k6 version as the local install and the same script, so the only thing
that changes between a local run and this one is the connection.

Costs: CPU-only, a couple of minutes, inside the Modal free allowance. The
egress it causes lands on Supabase (5 GB/month free) -- the script prints how
much it used, and a 50 VU run is well under 1%.
"""
from __future__ import annotations

import modal

K6_VERSION = "v2.2.0"

# Routes that start the real pipeline. Each POSTs to Modal and spends Azure,
# GPU and Gemini -- about $0.03 a call, plus a junk job and a stored file. At
# load-test volume that is real money and it pollutes the data the name
# vocabulary learns from. A script naming one of these does not get to run.
FORBIDDEN = (
    "/api/upload",
    "/reprocess",
    "/admin/training/recrop",
    "/admin/training/manual-upload",
    "/api/billing/checkout",
)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates")
    .run_commands(
        f"curl -fsSL https://github.com/grafana/k6/releases/download/{K6_VERSION}"
        f"/k6-{K6_VERSION}-linux-amd64.tar.gz -o /tmp/k6.tgz",
        "tar -xzf /tmp/k6.tgz -C /tmp",
        f"install -m 0755 /tmp/k6-{K6_VERSION}-linux-amd64/k6 /usr/local/bin/k6",
        "k6 version",
    )
    .add_local_dir("k6", remote_path="/k6")
)

app = modal.App("k6-load", image=image)


@app.function(timeout=1800, cpu=2.0, memory=2048)
def run_k6(script: str = "read_load.js", vus: int = 15,
           hold: str = "60s", base: str = "",
           mode: str = "", rate: int = 0, peak: int = 0) -> str:
    """Run one k6 script and hand back everything it printed."""
    import pathlib
    import subprocess

    path = pathlib.Path("/k6") / script
    if not path.exists():
        return f"no such script: {script}"

    # Read the script before running it, not as ceremony: a load test that
    # reaches a paid route is expensive in a way that is only obvious afterwards.
    body = path.read_text(encoding="utf-8")
    for route in FORBIDDEN:
        for line in body.splitlines():
            stripped = line.strip()
            if route in line and not stripped.startswith(("//", "*", "/*")):
                return (f"REFUSED: {script} references {route} outside a comment.\n"
                        f"That route starts the real pipeline and costs money per "
                        f"call. Remove it or load-test something else.")

    cmd = ["k6", "run", "--no-color", "-e", f"VUS={vus}", "-e", f"HOLD={hold}"]
    if base:
        cmd += ["-e", f"BASE={base}"]
    if mode:
        cmd += ["-e", f"MODE={mode}"]
    if rate:
        cmd += ["-e", f"RATE={rate}"]
    if peak:
        cmd += ["-e", f"PEAK={peak}"]
    cmd.append(str(path))

    p = subprocess.run(cmd, capture_output=True, text=True)
    out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
    # k6 exits non-zero when a threshold is crossed. That is a result, not a
    # failure to run, so it is reported rather than raised.
    return f"$ {' '.join(cmd)}\nexit code {p.returncode}\n\n{out}"


@app.local_entrypoint()
def main(script: str = "read_load.js", vus: int = 15,
         hold: str = "60s", base: str = "",
         mode: str = "", rate: int = 0, peak: int = 0):
    """
    Start the run, then wait for it in short hops.

    .remote() holds one connection open for the whole test, and on a link that
    drops it the run is finished and paid for while the client raises
    "ConnectionError: Deadline exceeded" and shows nothing. Spawning detaches
    the two: the test proceeds on Modal, and a dropped poll costs one retry
    instead of the result.
    """
    import time

    call = run_k6.spawn(script=script, vus=vus, hold=hold, base=base,
                        mode=mode, rate=rate, peak=peak)
    print(f"started: {call.object_id}")
    print("(safe to Ctrl+C -- the run continues, and "
          f"modal call-logs {call.object_id} shows it)")

    deadline = time.time() + 1800
    while time.time() < deadline:
        try:
            print(call.get(timeout=30))
            return
        except TimeoutError:
            continue          # still running
        except Exception as e:
            print(f"  poll failed ({type(e).__name__}), retrying")
            time.sleep(5)
    print("gave up waiting; the run may still be going")
