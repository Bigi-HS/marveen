#!/usr/bin/env python3
"""Vault-lint Layer 2: tier-migration + dedup proposals (Part A, read-only).

Card: 4cb02536. Spec: store/vault-lint-layer2-spec.md v1.2.

Reads store/noa.db (memories table; claudeclaw.db was the legacy location before
the W5-cutover -- ENG-024 retires it). Never modifies the DB or calls
any API endpoint. Writes two output files:
  store/vault-lint-l2-proposals.json -- structured proposal list
  store/vault-lint-l2-badge.json     -- shields.io endpoint badge

Usage:
  python3 scripts/vault-lint-layer2.py          # human-readable stdout
  python3 scripts/vault-lint-layer2.py --json   # JSON stdout
  VAULT_L2_HOT_STALE_DAYS=5 python3 scripts/vault-lint-layer2.py
"""

import json
import os
import re
import sqlite3
import sys
import time

# ---------------------------------------------------------------------------
# Configuration (env-overridable)
# ---------------------------------------------------------------------------
HOT_STALE_DAYS = int(os.environ.get("VAULT_L2_HOT_STALE_DAYS", "3"))
WARM_STALE_DAYS = int(os.environ.get("VAULT_L2_WARM_STALE_DAYS", "90"))
DEDUP_JACCARD_THRESHOLD = float(os.environ.get("VAULT_L2_DEDUP_JACCARD", "0.4"))

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(HERE, ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from db_resolve import resolve_default_db  # noqa: E402

# Live DB (card 57480c07): honor NOA_DB_PATH, fail open to the live store/noa.db
# rather than the frozen legacy claudeclaw.db (this lint reads the memories table).
DB_PATH = resolve_default_db(project_root=PROJECT_ROOT)
PROPOSALS_PATH = os.path.join(PROJECT_ROOT, "store", "vault-lint-l2-proposals.json")
BADGE_PATH = os.path.join(PROJECT_ROOT, "store", "vault-lint-l2-badge.json")

# ---------------------------------------------------------------------------
# Done-marker patterns (TM-2)
# Card 73ec620c: tightened from 7 to 5 patterns (live-vault FP rate 30% -> ~11%).
# Dropped: \bkész\b (too generic), \bclosed\b (sub-task/incident trigger).
# Dropped: bare \bDONE\b (matched "SCOPE done", "card X done" cross-refs).
# Added: DEPLOY DONE (unambiguous deployment-closure signal on live vault).
# ---------------------------------------------------------------------------
_DONE_PATTERNS = [
    r"\bMERGED\b",
    r"\bLEZARVA\b",
    r"PR #\d+ merged",
    r"status[: ]+done",
    r"DEPLOY DONE\b",
]
_DONE_RE = re.compile("|".join(_DONE_PATTERNS), re.IGNORECASE)


# ---------------------------------------------------------------------------
# Pure helpers (no I/O)
# ---------------------------------------------------------------------------

def matches_done_marker(content: str) -> bool:
    return bool(_DONE_RE.search(content or ""))


def is_stale(accessed_at_effective: int, now: int, stale_days: int) -> bool:
    return (now - accessed_at_effective) > stale_days * 86400


def parse_keywords(kw_str) -> frozenset:
    """Split comma-separated keywords into a frozenset of non-empty tokens."""
    if not kw_str:
        return frozenset()
    return frozenset(k.strip() for k in kw_str.split(",") if k.strip())


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


# ---------------------------------------------------------------------------
# DB reader
# ---------------------------------------------------------------------------

def load_memories(db_path: str) -> list:
    """Return all memory rows as dicts. Opens read-only (uri mode)."""
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, agent_id, category, content, keywords, created_at, accessed_at "
            "FROM memories"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Module 1: Tier-migration detector
# ---------------------------------------------------------------------------

def compute_tier_migrations(
    memories: list,
    now: int,
    hot_stale_days: int = HOT_STALE_DAYS,
    warm_stale_days: int = WARM_STALE_DAYS,
) -> list:
    """Return tier-migration proposals. Never writes to DB."""
    proposals = []
    for m in memories:
        cat = m.get("category", "")
        # Spec S2: shared and cold are excluded from all TM rules.
        if cat not in ("hot", "warm"):
            continue

        created_at = m.get("created_at")
        accessed_at = m.get("accessed_at")

        # M1: NULL accessed_at -> use created_at; both NULL -> skip.
        accessed_at_eff = accessed_at if accessed_at is not None else created_at
        if accessed_at_eff is None:
            print(
                f"[WARN] memory id={m['id']} has NULL created_at+accessed_at, skipping",
                file=sys.stderr,
            )
            continue

        content = m.get("content") or ""

        if cat == "hot":
            # M3: TM-2 takes priority over TM-1.
            if matches_done_marker(content):
                proposals.append(
                    {
                        "rule": "TM-2",
                        "from_category": "hot",
                        "to_category": "cold",
                        "id": m["id"],
                        "agent_id": m["agent_id"],
                        "reason": "done-marker",
                        "content_preview": content[:80],
                    }
                )
            elif is_stale(accessed_at_eff, now, hot_stale_days):
                age_days = (now - accessed_at_eff) / 86400
                proposals.append(
                    {
                        "rule": "TM-1",
                        "from_category": "hot",
                        "to_category": "warm",
                        "id": m["id"],
                        "agent_id": m["agent_id"],
                        "reason": f"{age_days:.1f}d untouched",
                        "content_preview": content[:80],
                    }
                )
        elif cat == "warm":
            # TM-3 only (S3: TM-2 is hot-only; warm + done-marker is TM-3 only).
            if is_stale(accessed_at_eff, now, warm_stale_days):
                age_days = (now - accessed_at_eff) / 86400
                proposals.append(
                    {
                        "rule": "TM-3",
                        "from_category": "warm",
                        "to_category": "cold",
                        "id": m["id"],
                        "agent_id": m["agent_id"],
                        "reason": f"{age_days:.1f}d untouched",
                        "content_preview": content[:80],
                    }
                )
    return proposals


# ---------------------------------------------------------------------------
# Module 2: Dedup detector
# ---------------------------------------------------------------------------

def _extract_identity_key(agent_id: str, content: str) -> str:
    """Extract identity key from entry for dedup comparison (Card b83cac15).

    Case 1: agent_id differs -> use agent_id (e.g., "marveen" vs "dave")
    Case 2: agent_id identical but content starts with "NAME:" -> use NAME
            (e.g., applegate stores executor memories; extract executor name:
             "blackbeard: ...", "morgan: ...", "roberts: ...")

    Returns: string identity key (e.g., "marveen", "blackbeard", "morgan").
    """
    # Case 2: executor-pattern in applegate memory (NAME: prefix)
    if content and ':' in content:
        first_word = content.split(':')[0].strip()
        # Heuristic: if first word looks like an agent name (lowercase, no spaces),
        # and it's one of known executors, use it.
        known_executors = {"blackbeard", "morgan", "roberts", "kidd", "rackham", "bonny", "avery", "hibiki", "claudia", "dave", "thor", "forge", "bond", "scout", "devil-advocate"}
        if first_word.lower() in known_executors:
            return first_word.lower()

    # Case 1: return agent_id as primary key
    return agent_id


def _identity_key_hard_veto(a_agent_id: str, b_agent_id: str, a_content: str, b_content: str) -> bool:
    """HARD non-merge veto: if identity keys differ, never merge (Card b83cac15).

    Prevents executor-pattern false positives where multiple agents share
    identical template structure but represent distinct roles/responsibilities.

    Uses both agent_id (for cross-agent pairs) and content-based identity
    (for executor-pattern in shared memory like applegate).

    Examples:
    - agent_id differs: marveen vs dave -> veto
    - applegate stores: "blackbeard: ..." vs "morgan: ..." -> extract names -> veto
    - same applegate, same executor: "blackbeard: ..." vs "blackbeard: ..." -> allow
    """
    a_key = _extract_identity_key(a_agent_id, a_content)
    b_key = _extract_identity_key(b_agent_id, b_content)
    return a_key != b_key


def compute_dedup_candidates(
    memories: list,
    jaccard_threshold: float = DEDUP_JACCARD_THRESHOLD,
) -> list:
    """Return dedup candidate pairs within same category. SUGGEST only.

    HARD non-merge guard (Card b83cac15): if agent_ids differ, exclude from
    candidates entirely (veto at threshold, regardless of Jaccard score).

    Grouping by category allows detection of cross-agent template duplicates
    (e.g., executor-pattern: blackbeard + morgan both with identical profile).
    """
    from collections import defaultdict

    groups: dict = defaultdict(list)
    for m in memories:
        kw = parse_keywords(m.get("keywords", ""))
        # M2: skip entries with empty keyword set (avoid false-positive Jaccard=1.0).
        if not kw:
            continue
        key = m["category"]  # Group by category only; identity guard filters cross-agent pairs.
        groups[key].append(
            {
                "id": m["id"],
                "agent_id": m["agent_id"],
                "keywords": kw,
                "keywords_str": m.get("keywords", ""),
                "content_preview": (m.get("content") or "")[:80],
                "content_full": m.get("content") or "",  # Full content for identity-key extraction
            }
        )

    candidates = []
    for entries in groups.values():
        n = len(entries)
        for i in range(n):
            for j in range(i + 1, n):
                a, b = entries[i], entries[j]

                # Card b83cac15: HARD non-merge veto if identity keys differ.
                if _identity_key_hard_veto(a["agent_id"], b["agent_id"], a["content_full"], b["content_full"]):
                    continue

                score = jaccard(a["keywords"], b["keywords"])
                if score >= jaccard_threshold:
                    candidates.append(
                        {
                            "agent_id": a["agent_id"],
                            "entry_a": {
                                "id": a["id"],
                                "keywords": a["keywords_str"],
                                "content_preview": a["content_preview"],
                            },
                            "entry_b": {
                                "id": b["id"],
                                "keywords": b["keywords_str"],
                                "content_preview": b["content_preview"],
                            },
                            "jaccard": round(score, 4),
                            "suggestion": (
                                "entry_a may be superseded by entry_b. "
                                "Consider migrating entry_a to cold with SUPERSEDED prefix. "
                                "Curator action required."
                            ),
                        }
                    )
    return candidates


# ---------------------------------------------------------------------------
# Module 3: Report + badge
# ---------------------------------------------------------------------------

def build_report(tier_proposals: list, dedup_candidates: list, now: int) -> dict:
    return {
        "timestamp": now,
        "verdict": "PROPOSALS",
        "tier_migration_proposals": tier_proposals,
        "dedup_candidates": dedup_candidates,
        "counts": {
            "tier_migration": len(tier_proposals),
            "dedup_candidates": len(dedup_candidates),
        },
    }


def make_badge(report: dict) -> dict:
    """shields.io endpoint badge (schemaVersion/label/message/color)."""
    c = report["counts"]
    tm = c["tier_migration"]
    dedup = c["dedup_candidates"]
    color = "brightgreen" if tm == 0 and dedup == 0 else "yellow"
    message = f"{tm} tm + {dedup} dedup"
    return {
        "schemaVersion": 1,
        "label": "vault-lint-l2",
        "message": message,
        "color": color,
        "counts": c,
        "timestamp": report["timestamp"],
    }


def print_human(report: dict) -> None:
    c = report["counts"]
    print(
        f"\nVAULT-LINT-L2: {c['tier_migration']} tier-migration proposals, "
        f"{c['dedup_candidates']} dedup candidates\n"
    )

    tms = report["tier_migration_proposals"]
    if tms:
        print("TIER-MIGRATION (proposals only -- apply via Part B when available):")
        for p in tms:
            preview = p["content_preview"].replace("\n", " ")
            print(
                f"  {p['rule']}  {p['from_category']}->{p['to_category']}"
                f"  id={p['id']} agent={p['agent_id']}"
                f"  {p['reason']} | {preview[:60]}..."
            )
    else:
        print("TIER-MIGRATION: none")

    print()
    dups = report["dedup_candidates"]
    if dups:
        print("DEDUP CANDIDATES (SUGGEST only -- curator action required):")
        for d in dups:
            print(
                f"  [{d['agent_id']}] id={d['entry_a']['id']} vs id={d['entry_b']['id']}"
                f" jaccard={d['jaccard']:.2f}"
                f" | {d['entry_a']['content_preview'][:40]} vs {d['entry_b']['content_preview'][:40]}"
            )
    else:
        print("DEDUP CANDIDATES: none")
    print()


def write_output(report: dict, proposals_path: str, badge_path: str) -> None:
    for path, data in ((proposals_path, report), (badge_path, make_badge(report))):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
        except OSError as e:
            print(f"[WARN] could not write {path}: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def run(
    db_path: str = DB_PATH,
    proposals_path: str = PROPOSALS_PATH,
    badge_path: str = BADGE_PATH,
    json_mode: bool = False,
    now: int = 0,
) -> dict:
    if now == 0:
        now = int(time.time())

    memories = load_memories(db_path)
    tier_proposals = compute_tier_migrations(memories, now)
    dedup_candidates = compute_dedup_candidates(memories)
    report = build_report(tier_proposals, dedup_candidates, now)
    write_output(report, proposals_path, badge_path)

    if json_mode:
        print(json.dumps(report, indent=2))
    else:
        print_human(report)

    return report


def main() -> None:
    args = sys.argv[1:]
    json_mode = "--json" in args
    run(json_mode=json_mode)


if __name__ == "__main__":
    main()
