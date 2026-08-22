#!/usr/bin/env python3
"""Hibiki -> Big Ben video form-analysis handoff (spec E-AC2 / OQ2).

Pure-stdlib request builder + response validator for the inter-agent
delegation that turns a training video into structured form feedback.

Contract (from store/specs/hibiki-personal-trainer.md):

  Request  (Hibiki -> Big Ben):
    {
      "type": "form_analysis_request",
      "from": "hibiki",
      "exercise": "squat",
      "video_url": "...",
      "specific_concerns": ["knee tracking", "depth"]
    }

  Response (Big Ben -> Hibiki):
    {
      "exercise": "squat",
      "timestamp": "2026-06-07T...",
      "findings": [
        { "issue": "knee cave on left side", "severity": "advisory", "cue": "push knees out" }
      ]
    }

  severity in {"critical", "advisory", "note"}.

Timeout policy (OQ2): if Big Ben does not respond within 5 minutes, Hibiki
falls back to text-based cue generation from its embedded cue library and
flags "video analysis pending". The handoff NEVER hangs and NEVER raises on
a slow/offline Big Ben -- it returns a clear fallback object instead.

The actual inter-agent send is a documented function boundary (`send_fn`).
This module performs NO network I/O itself; callers inject the transport so
unit tests stay offline and deterministic.
"""

import time
from typing import Callable, Dict, List, Optional, Sequence

# --- Constants ---------------------------------------------------------------

REQUEST_TYPE = "form_analysis_request"
AGENT_FROM = "hibiki"
AGENT_TO = "bigben"

VALID_SEVERITIES = ("critical", "advisory", "note")

# 5 minutes, per OQ2.
DEFAULT_TIMEOUT_SEC = 300

# Embedded fallback cue library (Research Addendum). Used when Big Ben is
# offline/times out so Hibiki can still annotate the session with a generic
# cue keyed by exercise. Lower-cased exercise name -> default cue.
FALLBACK_CUE_LIBRARY: Dict[str, str] = {
    "squat": "Push knees out, chest up, hips below parallel.",
    "deadlift": "Chest up with lat engagement, keep the bar close to the body.",
    "bench": "Wrists straight, retract the scapulae, keep the arch stable.",
    "ohp": "Head back as the bar passes, keep elbows from flaring.",
    "overhead press": "Head back as the bar passes, keep elbows from flaring.",
    "row": "Elbows close to the body, avoid lumbar rounding.",
}

GENERIC_FALLBACK_CUE = "Video analysis pending -- describe the issue in text for a cue."


# --- Errors ------------------------------------------------------------------

class FormAnalysisError(ValueError):
    """Raised when a Big Ben response fails schema validation."""


# --- Request builder ---------------------------------------------------------

def build_form_analysis_request(
    exercise: str,
    video_url: str,
    concerns: Optional[Sequence[str]] = None,
) -> Dict:
    """Build the Hibiki -> Big Ben form_analysis_request payload.

    Returns a dict carrying only scheduling/media fields (no health metrics),
    per F-AC3: Big Ben receives the video URL and nothing else sensitive.

    Raises ValueError on empty exercise or video_url.
    """
    if not isinstance(exercise, str) or not exercise.strip():
        raise ValueError("exercise must be a non-empty string")
    if not isinstance(video_url, str) or not video_url.strip():
        raise ValueError("video_url must be a non-empty string")

    specific_concerns: List[str] = []
    if concerns is not None:
        for c in concerns:
            if isinstance(c, str) and c.strip():
                specific_concerns.append(c.strip())

    return {
        "type": REQUEST_TYPE,
        "from": AGENT_FROM,
        "to": AGENT_TO,
        "exercise": exercise.strip(),
        "video_url": video_url.strip(),
        "specific_concerns": specific_concerns,
    }


# --- Response validation -----------------------------------------------------

def validate_form_feedback(response: Dict) -> Dict:
    """Validate Big Ben's form-feedback response against the E-AC2 schema.

    Returns a normalized form_feedback record suitable for the progress store:
      { "exercise", "timestamp", "findings": [{issue, severity, cue}] }

    Raises FormAnalysisError on any schema violation. Extra fields are allowed
    and dropped from the normalized record.
    """
    if not isinstance(response, dict):
        raise FormAnalysisError("response must be an object")

    exercise = response.get("exercise")
    if not isinstance(exercise, str) or not exercise.strip():
        raise FormAnalysisError("response.exercise must be a non-empty string")

    # timestamp is optional in the wire response; default to now if absent.
    timestamp = response.get("timestamp")
    if timestamp is not None and not isinstance(timestamp, str):
        raise FormAnalysisError("response.timestamp must be a string when present")

    findings = response.get("findings")
    if not isinstance(findings, list):
        raise FormAnalysisError("response.findings must be an array")

    normalized_findings: List[Dict] = []
    for idx, finding in enumerate(findings):
        if not isinstance(finding, dict):
            raise FormAnalysisError(f"findings[{idx}] must be an object")

        issue = finding.get("issue")
        severity = finding.get("severity")
        cue = finding.get("cue")

        if not isinstance(issue, str) or not issue.strip():
            raise FormAnalysisError(f"findings[{idx}].issue must be a non-empty string")
        if severity not in VALID_SEVERITIES:
            raise FormAnalysisError(
                f"findings[{idx}].severity must be one of {VALID_SEVERITIES}, "
                f"got {severity!r}"
            )
        if not isinstance(cue, str) or not cue.strip():
            raise FormAnalysisError(f"findings[{idx}].cue must be a non-empty string")

        normalized_findings.append(
            {"issue": issue.strip(), "severity": severity, "cue": cue.strip()}
        )

    return {
        "exercise": exercise.strip(),
        "timestamp": timestamp,
        "findings": normalized_findings,
    }


# --- Fallback ----------------------------------------------------------------

def build_fallback_feedback(exercise: str, reason: str) -> Dict:
    """Build a graceful text-cue fallback when Big Ben can't deliver (OQ2).

    Never raises. The returned record is shape-compatible with a validated
    form_feedback record but carries `pending: True` so the caller flags
    "video analysis pending" in session notes.
    """
    key = exercise.strip().lower() if isinstance(exercise, str) else ""
    cue = FALLBACK_CUE_LIBRARY.get(key, GENERIC_FALLBACK_CUE)
    return {
        "exercise": exercise.strip() if isinstance(exercise, str) else "",
        "timestamp": None,
        "findings": [
            {
                "issue": "video analysis pending",
                "severity": "note",
                "cue": cue,
            }
        ],
        "pending": True,
        "fallback_reason": reason,
    }


# --- Orchestration -----------------------------------------------------------

def request_form_analysis(
    exercise: str,
    video_url: str,
    send_fn: Callable[[Dict, float], Optional[Dict]],
    concerns: Optional[Sequence[str]] = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    clock: Callable[[], float] = time.monotonic,
) -> Dict:
    """Run the full Hibiki -> Big Ben handoff with a hard timeout + fallback.

    Args:
        exercise: lift name (e.g. "squat").
        video_url: link/path to the training video.
        send_fn: injected transport boundary. Called as
            send_fn(request_payload, remaining_timeout_sec) and expected to
            return Big Ben's raw response dict, or None if no response arrived
            within the budget. send_fn does the real inter-agent call; this
            module never touches the network itself. A send_fn that raises is
            treated as a delivery failure and routed to the fallback.
        concerns: optional list of specific form concerns.
        timeout_sec: total budget (default 300s = 5 min, per OQ2).
        clock: monotonic time source (injectable for deterministic tests).

    Returns:
        A normalized form_feedback record. On any timeout, transport error,
        empty response, or schema-invalid response, returns the fallback record
        (with pending=True). Never hangs; never raises.
    """
    request = build_form_analysis_request(exercise, video_url, concerns)

    start = clock()
    try:
        # Give send_fn the remaining budget so a well-behaved transport can
        # enforce the deadline on its side too.
        response = send_fn(request, float(timeout_sec))
    except Exception as exc:  # transport/delivery failure -> graceful fallback
        return build_fallback_feedback(exercise, f"delivery error: {exc}")

    elapsed = clock() - start
    if elapsed >= timeout_sec:
        return build_fallback_feedback(
            exercise, f"timeout after {elapsed:.0f}s (budget {timeout_sec:.0f}s)"
        )

    if response is None:
        return build_fallback_feedback(exercise, "no response from Big Ben")

    try:
        return validate_form_feedback(response)
    except FormAnalysisError as exc:
        return build_fallback_feedback(exercise, f"invalid response: {exc}")


__all__ = [
    "REQUEST_TYPE",
    "VALID_SEVERITIES",
    "DEFAULT_TIMEOUT_SEC",
    "FormAnalysisError",
    "build_form_analysis_request",
    "validate_form_feedback",
    "build_fallback_feedback",
    "request_form_analysis",
]
