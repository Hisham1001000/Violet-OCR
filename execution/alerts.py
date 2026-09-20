"""
execution/alerts.py — tell someone when the pipeline goes wrong.

process_document.py holds ~75 non-fatal exception handlers. Each one keeps a
document processing when a single stage misbehaves, which is right — losing a
customer's upload because the dictionary grower hiccuped would be worse. But
the failure then goes nowhere, and a whole day was spent finding loops that had
been quietly dead: the name-vocabulary grower raising TypeError on every
document, a corrections RPC returning 404 while the API answered success, crops
cut a row too low.

None of those threw anything a person would see. This closes that gap: every
FAILED stage the trace already records is reported once per job, in one
message. It does not replace the handlers, it makes them audible.

Silent by design when SLACK_WEBHOOK_URL is unset, and never raises -- an
alerting failure must not take down the thing it is watching.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_TIMEOUT = 8


def enabled() -> bool:
    return bool(os.getenv("SLACK_WEBHOOK_URL"))


def send(text: str) -> bool:
    """Post to Slack. Returns whether it went. Never raises."""
    url = os.getenv("SLACK_WEBHOOK_URL")
    if not url:
        return False
    try:
        import json
        import urllib.request

        req = urllib.request.Request(
            url, data=json.dumps({"text": text[:3500]}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=_TIMEOUT)
        return True
    except Exception as e:
        # Deliberately swallowed. An alerting outage must not become a pipeline
        # outage -- the logger still has it either way.
        logger.warning(f"[alerts] could not reach Slack: {e}")
        return False


def job_failed(job_id: str, reason: str, document: str = "") -> bool:
    """A document did not finish. The loudest thing that can happen."""
    return send(
        f":rotating_light: *Document failed*\n"
        f"`{job_id[:8]}` {document[:60]}\n"
        f"```{str(reason)[:600]}```")


def stages_failed(job_id: str, failures: list, document: str = "",
                  elapsed: float | None = None) -> bool:
    """
    One message per job listing the stages that failed.

    Called once at the end of a run rather than at each handler: a job with
    four broken stages should produce one notification a person will read, not
    four they will start ignoring.
    """
    if not failures:
        return False
    lines = [f":warning: *{len(failures)} stage(s) failed* — `{job_id[:8]}`"]
    if document:
        lines.append(f"_{document[:60]}_")
    for f in failures[:8]:
        stage  = str(f.get("stage", "?"))[:40]
        action = str(f.get("action") or f.get("details") or "")[:140]
        lines.append(f"• *{stage}* — {action}")
    if len(failures) > 8:
        lines.append(f"_…and {len(failures) - 8} more_")
    if elapsed:
        lines.append(f"_{elapsed:.0f}s_")
    lines.append("The document still completed — these stages were skipped.")
    return send("\n".join(lines))


def guard_tripped(job_id: str, what: str, count: int, detail: str = "") -> bool:
    """
    A safety check refused to act.

    Worth its own alert because a guard firing means data was NOT written that
    otherwise would have been -- the system protected itself, and that is
    exactly the moment a person should look.
    """
    return send(
        f":shield: *Guard tripped* — `{job_id[:8]}`\n"
        f"*{what}* refused {count} time(s)\n"
        + (f"```{detail[:400]}```" if detail else ""))
