"""Pure ranking + formatting logic for the SessionStart memory auto-inject.

Design owner: Applegate (memory curator). Implemented by Dave. Spec (card
`memory-sessionstart-autoinject`):

  RANKING  candidate set = warm (agent-own) + shared (cross-agent); hot/cold
           excluded. Score = salience (importance x weekly decay, maintained in
           db.ts -- no extra accessed_at half-life here). Order: salience DESC,
           accessed_at DESC (tie-break).
  SELECT   K=5, split 3 warm + 2 shared. If a tier pool is short, fill the gap
           from the other tier's leftovers (still salience-ordered).
  FORMAT   compact HU bullets `- [TIER] Title: <=80-char excerpt (keywords, age)`,
           bounded by a ~1500-token budget (oldest/lowest-ranked dropped first).

This module is PURE: no IO, no sqlite, no network -- so the ranking policy is
unit-testable in isolation and swappable without touching the hook.
"""

# ~4 chars/token (same heuristic the ledger replay uses); 1500 tokens.
CHAR_BUDGET = 1500 * 4
EXCERPT_LIMIT = 80
TIER_LABELS = {"warm": "WARM", "shared": "SHARED"}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _sort_key(m):
    # salience DESC, then accessed_at DESC as tie-breaker.
    return (-_num(m.get("salience")), -_num(m.get("accessed_at")))


def rank_memories(candidates, agent_id, k=5, split=(3, 2)):
    """Pick the top `k` memories for `agent_id` per the spec.

    `candidates` is an iterable of dict-like rows with at least: category,
    agent_id, salience, accessed_at. Only own-`warm` and any-`shared` are
    eligible; the caller's query already excludes hot/cold, but we re-filter
    defensively so the function is correct on any input. Returns a list (<= k)
    ordered warm-picks, then shared-picks, then any cross-tier fill -- each
    block salience-ordered.
    """
    n_warm, n_shared = split
    warm = sorted(
        (m for m in candidates
         if m.get("category") == "warm" and m.get("agent_id") == agent_id),
        key=_sort_key,
    )
    shared = sorted(
        (m for m in candidates if m.get("category") == "shared"),
        key=_sort_key,
    )
    picked = warm[:n_warm] + shared[:n_shared]
    if len(picked) < k:
        leftover = sorted(warm[n_warm:] + shared[n_shared:], key=_sort_key)
        picked += leftover[: k - len(picked)]
    return picked[:k]


def _age_label(created_at, now):
    secs = max(0, int(now) - int(_num(created_at)))
    days = secs // 86400
    if days >= 1:
        return f"{days}d old"
    hours = secs // 3600
    if hours >= 1:
        return f"{hours}h old"
    return f"{secs // 60}m old"


def _title(m):
    t = (m.get("topic_key") or "").strip()
    if t:
        return t
    words = (m.get("content") or "").strip().split()
    return " ".join(words[:6]) or "(cimtelen)"


def _excerpt(content, limit=EXCERPT_LIMIT):
    s = " ".join((content or "").split())
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def _line(m, now):
    tier = TIER_LABELS.get(m.get("category"), str(m.get("category", "?")).upper())
    kw = (m.get("keywords") or "").strip()
    age = _age_label(m.get("created_at"), now)
    meta = age if not kw else f"{kw}, {age}"
    return f"- [{tier}] {_title(m)}: {_excerpt(m.get('content'))} ({meta})"


def format_block(memories, now, char_budget=CHAR_BUDGET):
    """Render the ranked memories as a compact bullet block, bounded by
    `char_budget`. Lowest-ranked lines (the tail) are dropped first if the
    block would exceed the budget -- the 80-char excerpt cap keeps this from
    triggering in practice, but it is a hard backstop against a runaway memory.
    """
    lines = [_line(m, now) for m in memories]
    while len(lines) > 1 and sum(len(x) + 1 for x in lines) > char_budget:
        lines.pop()
    return "\n".join(lines)
