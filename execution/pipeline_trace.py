"""
Pipeline Execution Trace
========================
Produces a human-readable step-by-step log of exactly what happened
to a document as it moved through the OCR pipeline.

Usage in process_document.py:
    from execution.pipeline_trace import PipelineTrace
    trace = PipelineTrace(job_id)
    trace.step("OCR", status="OK", model="gemini-2.5-flash", ...)
    trace.save(".tmp")   # writes execution_trace_{job_id}.txt

The trace is also returned as a string via trace.render() for API consumers.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path


_SEP   = "-" * 70
_DSEP  = "=" * 70
_CHECK = "[OK]"
_CROSS = "[FAIL]"
_WARN  = "[WARN]"
_SKIP  = "[SKIP]"
_INFO  = "[INFO]"


class PipelineTrace:
    """
    Accumulates structured step records throughout the pipeline and renders
    them as a clean, human-readable execution log.

    Every step is a dict with at minimum:
        stage   str   — stage identifier, e.g. "STAGE 3 | OCR"
        status  str   — "OK" | "SKIPPED" | "FAILED" | "DISABLED" | "WARNING"
        action  str   — one-sentence plain-English description
        details dict  — supplementary key/value pairs shown in the log
        issues  list  — list of issue strings (for validation steps)
    """

    def __init__(self, job_id: str, document_name: str = ""):
        self.job_id        = job_id
        self.document_name = document_name
        self.start_time    = time.time()
        self.started_at    = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._steps: list[dict] = []

    # ── Recording ──────────────────────────────────────────────────────────────

    def step(
        self,
        stage: str,
        status: str = "OK",
        action: str = "",
        model: str | None = None,
        decision: str | None = None,
        details: dict | None = None,
        issues: list[str] | None = None,
    ) -> None:
        """
        Record one pipeline step.

        Args:
            stage    : Short stage label, e.g. "STAGE 3 | OCR"
            status   : "OK" | "SKIPPED" | "FAILED" | "DISABLED" | "WARNING"
            action   : Plain-English sentence describing what happened
            model    : Model/engine name when an AI call was made
            decision : The key decision taken (e.g. "Winner: Gemini OCR")
            details  : Extra key/value info shown indented beneath the step
            issues   : List of issue strings (validation failures, anomalies)
        """
        self._steps.append({
            "stage":    stage,
            "elapsed":  round(time.time() - self.start_time, 1),
            "status":   status.upper(),
            "action":   action,
            "model":    model,
            "decision": decision,
            "details":  details or {},
            "issues":   issues or [],
        })

    # ── Rendering ─────────────────────────────────────────────────────────────

    def render(self, total_elapsed: float | None = None) -> str:
        lines: list[str] = []

        # ── Header ────────────────────────────────────────────────────────────
        lines.append(_DSEP)
        lines.append(" DOCUMENT PROCESSING TRACE")
        lines.append(f" Job    : {self.job_id}")
        if self.document_name:
            lines.append(f" File   : {self.document_name}")
        lines.append(f" Start  : {self.started_at}")
        if total_elapsed is not None:
            lines.append(f" Total  : {total_elapsed}s")
        lines.append(_DSEP)

        # ── Steps ─────────────────────────────────────────────────────────────
        for s in self._steps:
            lines.append("")
            icon = _status_icon(s["status"])
            lines.append(f"[{s['stage']}]  {icon} {s['status']}  (+{s['elapsed']}s)")

            if s["action"]:
                lines.append(f"  Action   : {s['action']}")
            if s["model"]:
                lines.append(f"  Model    : {s['model']}")
            if s["decision"]:
                lines.append(f"  Decision : {s['decision']}")

            for k, v in s["details"].items():
                # Multi-line values get indented continuation lines
                val_str = str(v)
                if "\n" in val_str:
                    lines.append(f"  {k:<10}: {val_str.splitlines()[0]}")
                    for continuation in val_str.splitlines()[1:]:
                        lines.append(f"  {' ':<10}  {continuation}")
                else:
                    lines.append(f"  {k:<10}: {val_str}")

            for issue in s["issues"]:
                lines.append(f"  {_WARN} {issue}")

            lines.append(_SEP)

        # ── Summary ───────────────────────────────────────────────────────────
        ok_count      = sum(1 for s in self._steps if s["status"] in ("OK", "WARNING"))
        fail_count    = sum(1 for s in self._steps if s["status"] == "FAILED")
        skip_count    = sum(1 for s in self._steps if s["status"] in ("SKIPPED", "DISABLED"))
        warning_steps = [s for s in self._steps if s["issues"]]

        all_issues = [issue for s in self._steps for issue in s["issues"]]

        lines.append("")
        lines.append(_DSEP)
        lines.append(" SUMMARY")
        lines.append(f"  Steps    : {ok_count} completed, {skip_count} skipped, {fail_count} failed")
        if all_issues:
            lines.append(f"  Issues   : {len(all_issues)} item(s) flagged for review")
            for s in warning_steps:
                for issue in s["issues"]:
                    lines.append(f"    {_WARN} [{s['stage']}] {issue}")
        else:
            lines.append(f"  Issues   : none -- all checks passed {_CHECK}")
        if total_elapsed is not None:
            lines.append(f"  Duration : {total_elapsed}s")
        lines.append(_DSEP)

        return "\n".join(lines)

    # ── Persistence ───────────────────────────────────────────────────────────

    def failures(self) -> list[dict]:
        """Every stage that failed. Used to alert once per job rather than
        burying the failure in a log nobody reads."""
        return [s for s in self._steps if s.get("status") == "FAILED"]

    def save(self, directory: str = ".tmp", total_elapsed: float | None = None) -> Path:
        """Render the trace and write it to {directory}/execution_trace_{job_id}.txt."""
        out_dir = Path(directory)
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"execution_trace_{self.job_id}.txt"
        path.write_text(self.render(total_elapsed), encoding="utf-8")
        return path


# ── Internal helpers ───────────────────────────────────────────────────────────

def _status_icon(status: str) -> str:
    return {
        "OK":       _CHECK,
        "WARNING":  _WARN,
        "FAILED":   _CROSS,
        "SKIPPED":  _SKIP,
        "DISABLED": _SKIP,
    }.get(status, _INFO)
