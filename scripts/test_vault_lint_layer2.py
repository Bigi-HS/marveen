#!/usr/bin/env python3
"""Test suite for vault-lint-layer2 dedup identity-key guard (Card b83cac15).

Synthetic executor-pair + adversarial fixtures. No external DB; uses mocked
memories list to exercise compute_dedup_candidates().

Usage:
  python3 scripts/test_vault_lint_layer2.py         # human-readable output
  python3 scripts/test_vault_lint_layer2.py --verbose
"""

import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Load vault_lint_layer2 as a module (file is vault-lint-layer2.py)
import importlib.util
spec = importlib.util.spec_from_file_location("vault_lint_layer2", os.path.join(HERE, "vault-lint-layer2.py"))
vl2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vl2)


def make_memory(id_val, agent_id, category, keywords, content=None):
    """Convenience factory for test memory objects.

    Args:
        content: optional custom content (for Case 2 executor-name prefix tests).
                 Default: f"Test entry for {agent_id}"
    """
    if content is None:
        content = f"Test entry for {agent_id}"
    return {
        "id": id_val,
        "agent_id": agent_id,
        "category": category,
        "content": content,
        "keywords": keywords,
        "created_at": 1700000000,
        "accessed_at": 1700000000,
    }


# ============================================================================
# Test cases
# ============================================================================

def test_executor_pair_no_merge():
    """Executor-pair fixture: blackbeard + morgan, same keywords, different agent_id.

    Expected: 0 dedup-candidates (identity guard vetoes cross-agent pair).
    Card b83cac15 compliance: executor pattern must not trigger false-positive merges.
    """
    memories = [
        make_memory(
            1, "blackbeard", "warm",
            "executor, inter-agent, sonnet-only, noa-rewrite"
        ),
        make_memory(
            2, "morgan", "warm",
            "executor, inter-agent, sonnet-only, noa-rewrite"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Should be 0 because identity_key_hard_veto(blackbeard, morgan) = True
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for executor-pair (blackbeard vs morgan), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_executor_pair_no_merge PASS")


def test_same_agent_same_keywords_merge():
    """Same-agent fixture: marveen + marveen, same keywords.

    Expected: 1 dedup-candidate (no identity veto, jaccard >= threshold).
    Baseline: verifies that same agent duplicates ARE detected.
    """
    memories = [
        make_memory(
            3, "marveen", "warm",
            "kanban, task-tracking, priority-system"
        ),
        make_memory(
            4, "marveen", "warm",
            "kanban, priority-system, metrics"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Should be 1 because agent_id is same (no veto), jaccard ~= 0.5 >= 0.4
    assert len(candidates) == 1, (
        f"Expected 1 dedup-candidate for same-agent (marveen vs marveen), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_same_agent_same_keywords_merge PASS")


def test_opposing_profiles_no_merge():
    """Opposition fixture: marveen (orchestrator) + blackbeard (executor), different keywords.

    Expected: 0 dedup-candidates (identity guard vetoes cross-agent pair;
    also jaccard would be low anyway).
    """
    memories = [
        make_memory(
            5, "marveen", "warm",
            "kanban, orchestration, priority, gate"
        ),
        make_memory(
            6, "blackbeard", "warm",
            "executor, code, sonnet, inter-agent"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Should be 0: identity veto (marveen vs blackbeard)
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for opposing profiles (marveen vs blackbeard), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_opposing_profiles_no_merge PASS")


def test_cross_category_no_merge():
    """Cross-category fixture: same agent (marveen), different categories (warm vs cold).

    Expected: 0 dedup-candidates (grouping by category only; warm and cold are separate).
    Validates category-based grouping.
    """
    memories = [
        make_memory(
            7, "marveen", "warm",
            "kanban, task-tracking"
        ),
        make_memory(
            8, "marveen", "cold",
            "kanban, task-tracking"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Should be 0 because categories are different (no cross-category grouping)
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for cross-category (warm vs cold), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_cross_category_no_merge PASS")


def test_dev_executor_pool_no_merge():
    """Dev executor pool fixture: blackbeard, morgan, roberts (all same template, same category).

    Expected: 0 dedup-candidates total (all pairs vetoed by identity guard).
    Validates that multiple executors with identical profiles do not generate false-positive merges.
    """
    memories = [
        make_memory(1, "blackbeard", "warm", "executor, dev, sonnet, noa-rewrite"),
        make_memory(2, "morgan", "warm", "executor, dev, sonnet, noa-rewrite"),
        make_memory(3, "roberts", "warm", "executor, dev, sonnet, noa-rewrite"),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # All pairs: (blackbeard, morgan), (blackbeard, roberts), (morgan, roberts)
    # All vetoed by identity guard. Expected: 0.
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for dev executor pool (blackbeard, morgan, roberts), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_dev_executor_pool_no_merge PASS")


def test_qa_executor_pool_no_merge():
    """QA executor pool fixture: bonny, avery (same template, same category).

    Expected: 0 dedup-candidates (identity guard vetoes).
    """
    memories = [
        make_memory(10, "bonny", "warm", "executor, qa, sonnet, inter-agent"),
        make_memory(11, "avery", "warm", "executor, qa, sonnet, inter-agent"),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Should be 0 (identity veto on bonny vs avery)
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for QA executor pool (bonny vs avery), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_qa_executor_pool_no_merge PASS")


def test_low_jaccard_threshold():
    """Boundary test: very low Jaccard threshold (0.1) on executor pair.

    Expected: 0 dedup-candidates (identity guard vetoes regardless of threshold).
    Validates that guard is unconditional (not threshold-dependent).
    """
    memories = [
        make_memory(20, "blackbeard", "warm", "executor, dev"),
        make_memory(21, "morgan", "warm", "executor, dev, sonnet"),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.1)

    # Even at jaccard_threshold=0.1, identity veto applies.
    # Jaccard(executor,dev / executor,dev,sonnet) = 0.67 >> 0.1, but still vetoed.
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates even at low threshold (0.1), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_low_jaccard_threshold PASS")


def test_near_threshold_same_agent():
    """Edge case: same agent, Jaccard exactly at threshold.

    Expected: 1 dedup-candidate (jaccard == threshold, no veto).
    Boundary condition: threshold is inclusive (>=).
    """
    # Keywords chosen to yield jaccard ~= 0.4 exactly
    # kw1 = {a, b, c, d}; kw2 = {b, c, d, e, f}
    # Intersection = {b, c, d} = 3; Union = {a, b, c, d, e, f} = 6; Jaccard = 3/6 = 0.5
    memories = [
        make_memory(30, "dave", "warm", "a, b, c, d"),
        make_memory(31, "dave", "warm", "b, c, d, e, f"),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.5)

    # Jaccard = 0.5, threshold = 0.5 -> should match
    assert len(candidates) == 1, (
        f"Expected 1 dedup-candidate at exact threshold (0.5), "
        f"but got {len(candidates)}"
    )
    print("✓ test_near_threshold_same_agent PASS")


def test_empty_keywords_skipped():
    """Empty keywords: entries without keywords are skipped entirely.

    Expected: 0 dedup-candidates (entries with no keywords are excluded from grouping).
    """
    memories = [
        make_memory(40, "marveen", "warm", ""),  # Empty keywords
        make_memory(41, "marveen", "warm", "kanban, task"),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Entry 40 skipped, only 41 remains. No pairs. Expected: 0.
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates when one entry has empty keywords, "
        f"but got {len(candidates)}"
    )
    print("✓ test_empty_keywords_skipped PASS")


def test_applicate_executor_cross_identity_no_merge():
    """Case 2: applicate vault executor-name prefix (blackbeard: vs morgan:).

    Applicate stores executor profiles with "NAME: description" format.
    Both entries have agent_id=applicate but different executor names -> veto.

    Expected: 0 dedup-candidates (identity-key vetoes cross-executor pair).
    This is the real production case that motivated the guard.
    """
    memories = [
        make_memory(
            50, "applicate", "warm",
            "executor, dev, sonnet, noa-rewrite",
            content="blackbeard: új flotta-tag, programozó munkaágens (dev executor)"
        ),
        make_memory(
            51, "applicate", "warm",
            "executor, dev, sonnet, noa-rewrite",
            content="morgan: új flotta-tag, programozó munkaágens (dev executor)"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Both agent_id=applicate, but content prefix names differ (blackbeard vs morgan)
    # Identity-key guard extracts names and vetoes. Expected: 0.
    assert len(candidates) == 0, (
        f"Expected 0 dedup-candidates for applicate cross-executor (blackbeard vs morgan), "
        f"but got {len(candidates)}: {candidates}"
    )
    print("✓ test_applicate_executor_cross_identity_no_merge PASS")


def test_applicate_executor_same_identity_merge():
    """Case 2: applicate vault, same executor name (blackbeard: vs blackbeard:).

    Both entries agent_id=applicate and same executor name (extracted from content prefix).
    Keywords are same -> should be merge-candidate (no veto).

    Expected: 1 dedup-candidate (no veto; same identity).
    """
    memories = [
        make_memory(
            52, "applicate", "warm",
            "executor, dev, sonnet",
            content="blackbeard: új flotta-tag, programozó munkaágens"
        ),
        make_memory(
            53, "applicate", "warm",
            "executor, dev, sonnet",
            content="blackbeard: Updated profile, koordinátor eszköz"
        ),
    ]

    candidates = vl2.compute_dedup_candidates(memories, jaccard_threshold=0.4)

    # Both agent_id=applicate and extracted name is "blackbeard" in both
    # Identity matches, Jaccard is high -> should be candidate.
    # Jaccard({executor,dev,sonnet}) = 1.0 >= 0.4
    assert len(candidates) == 1, (
        f"Expected 1 dedup-candidate for applicate same-executor (blackbeard vs blackbeard), "
        f"but got {len(candidates)}"
    )
    print("✓ test_applicate_executor_same_identity_merge PASS")


# ============================================================================
# Main
# ============================================================================

def run_all_tests(verbose=False):
    """Run all tests and report results."""
    tests = [
        test_executor_pair_no_merge,
        test_same_agent_same_keywords_merge,
        test_opposing_profiles_no_merge,
        test_cross_category_no_merge,
        test_dev_executor_pool_no_merge,
        test_qa_executor_pool_no_merge,
        test_low_jaccard_threshold,
        test_near_threshold_same_agent,
        test_empty_keywords_skipped,
        test_applicate_executor_cross_identity_no_merge,  # Case 2: applicate vault
        test_applicate_executor_same_identity_merge,      # Case 2: applicate same executor
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"✗ {test.__name__} FAIL: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {test.__name__} ERROR: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    verbose = "--verbose" in sys.argv
    success = run_all_tests(verbose=verbose)
    sys.exit(0 if success else 1)
