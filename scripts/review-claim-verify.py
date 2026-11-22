#!/usr/bin/env python3
"""review-claim-verify -- Sub-agent review live-code claim verifier (card f725adcd).

Background
----------
Sub-agent (Workflow/Explore) review outputs often INFER from spec rather than
MEASURE: they emit claims like "this guard is missing from guardrail.py:42" or
"fix already applied at src/util.py:17" without checking the live repo.  Stale
or incorrect [CLAIM] markers silently mislead the gate decision.

This script scans a review-output text for explicit CLAIM markers and, for every
claim that references a file:line location, verifies that the asserted text (or
pattern) is actually present/absent at that location in the repo.  Unverifiable
claims are FLAGGED (fail-closed on ambiguity).

Claim marker syntax (embedded anywhere in the review text):
    [CLAIM file=<path> line=<n> present="<text>"]
    [CLAIM file=<path> line=<n> absent="<text>"]
    [CLAIM file=<path> line=<n> present_re="<regex>"]
    [CLAIM file=<path> line=<n> absent_re="<regex>"]

Fields:
    file     -- repo-relative path  (resolved against REPO_ROOT, never CWD)
    line     -- 1-based line number  (required; claims without it are UNVERIFIABLE)
    present  -- exact substring that must appear on that line
    absent   -- exact substring that must NOT appear on that line
    present_re / absent_re -- regex variants of present / absent

Claims without a file:line reference are reported as UNVERIFIABLE (fail-closed).
A claim with a file:line but no assertion text (no present/absent/…) is FLAGGED
as under-specified.

Verdict per claim:
    OK             -- assertion verified against live file
    FLAGGED        -- assertion contradicts live file, or file/line not found
    UNVERIFIABLE   -- no file:line, cannot check

Overall exit codes:
    0  -- all claims OK (or no claims found)
    1  -- at least one FLAGGED claim
    2  -- at least one UNVERIFIABLE claim (and no FLAGGED)

Design constraints (NON-NEGOTIABLE, same class as guardrail siblings):
    - CWD-INDEPENDENT: REPO_ROOT is anchored to __file__, never os.getcwd().
      A claim referencing a relative path is resolved against REPO_ROOT.
    - FAIL-CLOSED on ambiguity: if the file cannot be read, the line does not
      exist, or the assertion is under-specified -> FLAGGED, not silently OK.
    - PURE INNER LOGIC: parse_claims() and verify_claim() are importable and
      side-effect-free (no I/O other than reading the target file).

CLI usage:
    # review text on stdin
    cat review.txt | python3 scripts/review-claim-verify.py

    # review text from a file
    python3 scripts/review-claim-verify.py --file review.txt

    # machine-readable output
    python3 scripts/review-claim-verify.py --json --file review.txt

    # explicit repo root override (tests / CI)
    python3 scripts/review-claim-verify.py --repo-root /abs/path --file review.txt

Exit codes above; 3 = bad input / internal error (fail-closed).
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import NamedTuple

# CWD-INDEPENDENT anchor: always resolve relative to this script's grandparent
# (scripts/ lives one level under repo root).
_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parent

# Regex that matches [CLAIM ...] markers in review text.  The inner content is
# captured loosely; individual fields are extracted by _FIELD_RE below.
_CLAIM_RE = re.compile(
    r"\[CLAIM\s+([^\]]+)\]",
    re.IGNORECASE,
)

# Extracts key="value" or key=<unquoted_token> pairs from the claim body.
# Supports both double-quoted and unquoted values.
_FIELD_RE = re.compile(
    r"""(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s\]]+))""",
)


class Claim(NamedTuple):
    """A single parsed claim.  ``raw`` is the original marker text."""
    raw: str
    file: str | None        # repo-relative path, or None
    line: int | None        # 1-based, or None
    present: str | None     # exact substring that must be present
    absent: str | None      # exact substring that must be absent
    present_re: str | None  # regex that must match
    absent_re: str | None   # regex that must NOT match


class ClaimResult(NamedTuple):
    claim: Claim
    verdict: str            # OK | FLAGGED | UNVERIFIABLE
    reason: str


def parse_claims(text: str) -> list[Claim]:
    """Pure: extract all [CLAIM ...] markers from review text.

    Returns a (possibly empty) list.  Never raises; malformed markers are
    returned with file=None so they fall into UNVERIFIABLE.
    """
    results = []
    for m in _CLAIM_RE.finditer(text):
        body = m.group(1)
        raw = m.group(0)
        fields: dict[str, str] = {}
        for fm in _FIELD_RE.finditer(body):
            key = fm.group(1).lower()
            # group(2) = double-quoted value, group(3) = unquoted value
            value = fm.group(2) if fm.group(2) is not None else fm.group(3)
            # Unescape simple backslash sequences in quoted values
            if fm.group(2) is not None:
                value = value.replace('\\"', '"').replace("\\\\", "\\")
            fields[key] = value

        file_val = fields.get("file") or None
        line_val = fields.get("line")
        line_int: int | None = None
        if line_val is not None:
            try:
                line_int = int(line_val)
            except ValueError:
                line_int = None

        results.append(Claim(
            raw=raw,
            file=file_val,
            line=line_int,
            present=fields.get("present"),
            absent=fields.get("absent"),
            present_re=fields.get("present_re"),
            absent_re=fields.get("absent_re"),
        ))
    return results


def _read_line(abs_path: Path, lineno: int) -> str | None:
    """Read a single 1-based line from a file; return None if out of range or
    unreadable.  Any I/O error -> None (caller treats as FLAGGED, fail-closed).
    """
    try:
        with open(abs_path, encoding="utf-8", errors="replace") as f:
            for idx, raw_line in enumerate(f, start=1):
                if idx == lineno:
                    return raw_line.rstrip("\n")
    except OSError:
        return None
    return None   # lineno beyond EOF


def verify_claim(claim: Claim, repo_root: Path) -> ClaimResult:
    """Pure (except for file I/O): verify one claim against the live repo.

    Fail-closed: any ambiguity, missing file, or out-of-range line -> FLAGGED.
    Missing file:line -> UNVERIFIABLE.
    """
    if claim.file is None or claim.line is None:
        return ClaimResult(claim, "UNVERIFIABLE",
                           "No file:line reference -- cannot verify against live code")

    # Resolve path -- if already absolute, take as-is; otherwise anchor to repo.
    raw_path = Path(claim.file)
    abs_path = raw_path if raw_path.is_absolute() else repo_root / raw_path
    # Canonicalize (resolves .., symlinks) -- makes the check CWD-independent.
    try:
        abs_path = abs_path.resolve()
    except OSError:
        return ClaimResult(claim, "FLAGGED",
                           f"Cannot resolve path: {claim.file}")

    # Safety: reject paths outside the repo root (path traversal).
    try:
        abs_path.relative_to(repo_root.resolve())
    except ValueError:
        return ClaimResult(claim, "FLAGGED",
                           f"Path escapes repo root: {claim.file}")

    if not abs_path.exists():
        return ClaimResult(claim, "FLAGGED",
                           f"File not found: {abs_path}")

    actual_line = _read_line(abs_path, claim.line)
    if actual_line is None:
        return ClaimResult(claim, "FLAGGED",
                           f"Line {claim.line} does not exist in {claim.file} "
                           f"(file may be shorter)")

    # Check each assertion.  Fail-closed: if no assertion given -> FLAGGED
    # (under-specified claim cannot be validated -> we cannot call it OK).
    has_assertion = any([
        claim.present is not None, claim.absent is not None,
        claim.present_re is not None, claim.absent_re is not None,
    ])
    if not has_assertion:
        return ClaimResult(claim, "FLAGGED",
                           f"file:line present ({claim.file}:{claim.line}) but no "
                           f"assertion (present/absent/present_re/absent_re) -- "
                           f"under-specified, cannot verify")

    # Evaluate each assertion; first failure -> FLAGGED with explanation.
    if claim.present is not None:
        if claim.present not in actual_line:
            return ClaimResult(claim, "FLAGGED",
                               f"present={claim.present!r} not found on "
                               f"{claim.file}:{claim.line}; "
                               f"actual line: {actual_line!r}")

    if claim.absent is not None:
        if claim.absent in actual_line:
            return ClaimResult(claim, "FLAGGED",
                               f"absent={claim.absent!r} unexpectedly present on "
                               f"{claim.file}:{claim.line}; "
                               f"actual line: {actual_line!r}")

    if claim.present_re is not None:
        try:
            if not re.search(claim.present_re, actual_line):
                return ClaimResult(claim, "FLAGGED",
                                   f"present_re={claim.present_re!r} did not match "
                                   f"{claim.file}:{claim.line}; "
                                   f"actual line: {actual_line!r}")
        except re.error as exc:
            return ClaimResult(claim, "FLAGGED",
                               f"present_re={claim.present_re!r} is an invalid "
                               f"regex: {exc}")

    if claim.absent_re is not None:
        try:
            if re.search(claim.absent_re, actual_line):
                return ClaimResult(claim, "FLAGGED",
                                   f"absent_re={claim.absent_re!r} unexpectedly "
                                   f"matched {claim.file}:{claim.line}; "
                                   f"actual line: {actual_line!r}")
        except re.error as exc:
            return ClaimResult(claim, "FLAGGED",
                               f"absent_re={claim.absent_re!r} is an invalid "
                               f"regex: {exc}")

    return ClaimResult(claim, "OK",
                       f"Verified {claim.file}:{claim.line}")


def verify_all(claims: list[Claim], repo_root: Path) -> list[ClaimResult]:
    """Verify every claim; return results in input order."""
    return [verify_claim(c, repo_root) for c in claims]


def _overall_verdict(results: list[ClaimResult]) -> tuple[str, int]:
    """Derive (verdict_label, exit_code) from a list of results.

    Priority: FLAGGED > UNVERIFIABLE > OK.
    """
    has_flagged = any(r.verdict == "FLAGGED" for r in results)
    has_unverifiable = any(r.verdict == "UNVERIFIABLE" for r in results)
    if has_flagged:
        return ("FLAGGED", 1)
    if has_unverifiable:
        return ("UNVERIFIABLE", 2)
    return ("OK", 0)


def _format_human(results: list[ClaimResult]) -> str:
    lines = []
    for idx, r in enumerate(results, start=1):
        # Truncate raw for readability
        raw_short = r.claim.raw[:80] + ("..." if len(r.claim.raw) > 80 else "")
        lines.append(f"[{idx}] {r.verdict}: {r.reason}")
        lines.append(f"     claim: {raw_short}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Verify [CLAIM] markers in a review-output text against live repo"
    )
    ap.add_argument("--file", "-f", default=None,
                    help="Path to review text file (default: stdin)")
    ap.add_argument("--repo-root", default=None,
                    help="Repo root override (default: auto-detected from __file__)")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="Emit machine-readable JSON")
    args = ap.parse_args(argv)

    repo_root = Path(args.repo_root).resolve() if args.repo_root else REPO_ROOT

    # Read the review text
    try:
        if args.file:
            text = Path(args.file).read_text(encoding="utf-8", errors="replace")
        else:
            text = sys.stdin.read()
    except OSError as exc:
        sys.stderr.write(f"review-claim-verify: cannot read input: {exc}\n")
        sys.exit(3)

    claims = parse_claims(text)
    if not claims:
        if args.as_json:
            print(json.dumps({"verdict": "OK", "claims_found": 0, "results": []}))
        else:
            print("review-claim-verify: no [CLAIM] markers found -- nothing to verify")
        sys.exit(0)

    results = verify_all(claims, repo_root)
    overall, exit_code = _overall_verdict(results)

    if args.as_json:
        print(json.dumps({
            "verdict": overall,
            "claims_found": len(claims),
            "flagged": sum(1 for r in results if r.verdict == "FLAGGED"),
            "unverifiable": sum(1 for r in results if r.verdict == "UNVERIFIABLE"),
            "ok": sum(1 for r in results if r.verdict == "OK"),
            "results": [
                {
                    "verdict": r.verdict,
                    "reason": r.reason,
                    "claim_raw": r.claim.raw,
                    "file": r.claim.file,
                    "line": r.claim.line,
                }
                for r in results
            ],
        }, indent=2))
    else:
        print(f"review-claim-verify: {len(claims)} claim(s) found -- "
              f"overall verdict: {overall}")
        print(_format_human(results))

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
