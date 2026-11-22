#!/usr/bin/env python3
"""
Vault curator verdict-creation script (card d4b69dde).

Option C (Hybrid): jaccard >= JACCARD_THRESHOLD -> APPROVE, else -> REJECT.
REJECT-default: conservative, fail-closed. Rationale: memories are semi-destructive
to merge (supersede/replace cold-tier entries); the 09-28 incident proved Jaccard
alone can generate cross-agent fabricated matches.

Usage:
    python3 scripts/vault-curator-verdict-creation.py [--dry-run]
    python3 scripts/vault-curator-verdict-creation.py --proposals-file PATH [--dry-run]

Scheduled task: nightly 02:30 (before the 03:00 applyer).
Gate: thor+chad (card d4b69dde).
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

JACCARD_THRESHOLD = 0.65
REJECT_BELOW = 0.3
TTL_DAYS = 90

REPO_ROOT = Path(__file__).parent.parent
DEFAULT_PROPOSALS = REPO_ROOT / "store" / "vault-lint-l2-proposals.json"
DEFAULT_BASE_URL = "http://localhost:3420"
DEFAULT_TOKEN_FILE = REPO_ROOT / "store" / ".dashboard-token"


def classify_candidate(candidate: dict) -> dict:
    """
    Classify a single dedup candidate using jaccard threshold (Option C logic).
    Returns a dict ready for post_verdict.
    """
    agent_id = candidate["agent_id"]
    entry_a = candidate["entry_a"]
    entry_b = candidate["entry_b"]
    jaccard = float(candidate["jaccard"])
    a_id = entry_a["id"]
    b_id = entry_b["id"]

    proposal_id = f"{agent_id}:{a_id}:{b_id}:{jaccard:.4f}"

    if jaccard >= JACCARD_THRESHOLD:
        verdict = "APPROVE"
        curator_notes = (
            f"jaccard={jaccard:.4f}>={JACCARD_THRESHOLD} auto-approve; "
            f"Option-C hybrid gate passed"
        )
    else:
        verdict = "REJECT"
        curator_notes = (
            f"low-confidence jaccard={jaccard:.4f}<{JACCARD_THRESHOLD}; "
            f"manual review needed"
        )

    return {
        "proposal_id": proposal_id,
        "agent_id": agent_id,
        "entry_a_id": a_id,
        "entry_b_id": b_id,
        "jaccard": jaccard,
        "verdict": verdict,
        "curator_notes": curator_notes,
        "ttl_days": TTL_DAYS,
    }


def post_verdict(
    verdict: dict,
    base_url: str,
    token: str,
    dry_run: bool = False,
) -> dict:
    """POST a single verdict to /api/curator/verdicts. dry_run skips the HTTP call."""
    if dry_run:
        return {"dry_run": True, "verdict": verdict["verdict"], "proposal_id": verdict["proposal_id"]}

    url = f"{base_url}/api/curator/verdicts"
    payload = json.dumps(verdict).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def run_pipeline(
    proposals_data: dict,
    base_url: str,
    token: str,
    dry_run: bool = False,
) -> dict:
    """
    Process all dedup_candidates from proposals_data.
    Returns summary: {total, approved, rejected, errors}.
    """
    candidates = proposals_data.get("dedup_candidates", [])
    total = len(candidates)
    approved = rejected = errors = 0

    for candidate in candidates:
        classified = classify_candidate(candidate)
        try:
            post_verdict(classified, base_url=base_url, token=token, dry_run=dry_run)
            if classified["verdict"] == "APPROVE":
                approved += 1
            else:
                rejected += 1
        except Exception as exc:
            errors += 1
            print(f"ERROR posting verdict for {classified['proposal_id']}: {exc}", file=sys.stderr)

    return {"total": total, "approved": approved, "rejected": rejected, "errors": errors}


def _read_token(token_file: Path) -> str:
    return token_file.read_text().strip()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Vault curator verdict-creation (Option C)")
    parser.add_argument("--dry-run", action="store_true", help="Classify but do not POST")
    parser.add_argument(
        "--proposals-file", default=str(DEFAULT_PROPOSALS),
        help=f"Path to proposals JSON (default: {DEFAULT_PROPOSALS})"
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--token-file", default=str(DEFAULT_TOKEN_FILE))
    args = parser.parse_args()

    proposals_path = Path(args.proposals_file)
    if not proposals_path.exists():
        print(f"ERROR: proposals file not found: {proposals_path}", file=sys.stderr)
        sys.exit(1)

    proposals_data = json.loads(proposals_path.read_text())
    token = _read_token(Path(args.token_file))

    dry_label = " [DRY RUN]" if args.dry_run else ""
    print(f"vault-curator-verdict-creation{dry_label}")
    print(f"proposals: {proposals_path}")
    n = len(proposals_data.get("dedup_candidates", []))
    print(f"candidates: {n}, threshold: {JACCARD_THRESHOLD}")

    summary = run_pipeline(
        proposals_data,
        base_url=args.base_url,
        token=token,
        dry_run=args.dry_run,
    )

    print(
        f"done: total={summary['total']} approved={summary['approved']} "
        f"rejected={summary['rejected']} errors={summary['errors']}"
    )
    if summary["errors"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
