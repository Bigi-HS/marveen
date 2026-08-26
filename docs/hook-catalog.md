# Hook Catalog (ported from the RuFlo 27-hook idea)

Three concretely useful Claude Code `settings.json` hooks, ported selectively
from the RuFlo mining catalog item #6 (`store/ruflo-mining-catalog.md`). We did
NOT adopt all 27 -- only the ones that map to a real fleet gap, matching the
style of the existing `scripts/hooks/forge-*.py` hooks.

These are **ready-to-wire** scripts. They are NOT enabled by editing the live
`settings.json` here; copy the snippet below into the relevant agent's
`.claude-config/settings.json` (or the global one) to activate.

All three follow the existing hook contract:
- Read the hook payload as JSON from stdin.
- Resolve the install dir via three `dirname` levels (`scripts/hooks/<x>.py`).
- PreToolUse gates: exit `0` = allow, exit `2` = block (the JSON `reason` is shown
  to the agent). PostToolUse hooks are passive and always exit `0`.

**Status** (measured 2026-08-14, card ec0ebd56): `pii-injection-scan.py` is **NOT WIRED** in any agent's `settings.json`. `pre-deploy-gate.py` and `post-merge-metrics.py` status: verify with `grep -r hook` in `agents/*/. claude/settings.json`. Do not read this table as a coverage claim -- it is a script inventory only.

| Script | Event | Action | Wired? |
|---|---|---|---|
| `pii-injection-scan.py` | PreToolUse (Bash) | Blocks an inter-agent `curl .../api/messages` send carrying PII or prompt-injection text; logs to `store/aidefence.log` | **NO** -- not in any settings.json (as of 2026-08-14) |
| `pre-deploy-gate.py` | PreToolUse (Bash) | Blocks a dashboard restart/deploy unless a fresh `store/.typecheck-green` marker exists (< 30 min old) | verify |
| `post-merge-metrics.py` | PostToolUse (Bash) | Records merge size metrics (files/insertions/deletions) to `store/merge-metrics.log` after a `git merge` / `gh pr merge` | verify |

---

## 1. `pii-injection-scan.py` -- pre-send PII / injection scan

**Event:** `PreToolUse`, matcher `Bash`.
**Maps to:** RuFlo catalog #1 (AIDefence inter-agent guard), hook-shaped.

Inspects only Bash commands that POST to the inter-agent messages endpoint
(`curl ... /api/messages`). It extracts the JSON body (from `-d` / `--data`) and
scans it for:

- **PII:** email addresses, phone numbers, 13-16 digit card-like runs, and
  API-key / token-like strings (`sk-...`, `ghp_...`, 32+ hex).
- **Injection:** imperative override phrases typical of prompt injection
  ("ignore previous instructions", "you are now", "reveal the system prompt",
  "exfiltrate", "send the token", ...).

On a match it **blocks** (exit 2) and tells the agent which category tripped so
it can redact PII or strip the untrusted instruction before resending. Every
block is appended to `store/aidefence.log` for Chad's audit trail.

This is an agent-local early signal; the server-side filter on `POST /api/messages`
remains the authoritative layer.

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/pii-injection-scan.py" }
      ]
    }
  ]
}
```

---

## 2. `pre-deploy-gate.py` -- pre-deploy test-freshness gate

**Event:** `PreToolUse`, matcher `Bash`.
**Maps to:** RuFlo catalog #6 ("pre-deploy gate").

Complements `forge-deploy-guard.py` (which enforces the Genesis-GO marker). This
hook enforces a **separate** precondition: a live dashboard deploy must sit on a
recent GREEN typecheck. It blocks a restart/deploy command unless a fresh
`store/.typecheck-green` marker exists and is younger than 30 minutes.

- `forge-deploy-guard.py` answers "is this deploy authorized?" (Genesis-GO).
- `pre-deploy-gate.py` answers "does the code being deployed compile?" (green typecheck).

Both are `PreToolUse(Bash)` and match the same restart patterns
(`tmux send ... dist/index.js`, `node|bun run dist/index.js`, `dashboard.*restart`)
but assert non-overlapping preconditions, so they coexist cleanly.

**Marker contract** -- the deploying agent (or CI) writes the marker after a clean run:

```bash
npm run typecheck && touch store/.typecheck-green
```

The marker's mtime is the freshness signal; its contents are ignored.

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/pre-deploy-gate.py" }
      ]
    }
  ]
}
```

> To run both deploy gates together, add `pre-deploy-gate.py` as a second entry in
> the same `Bash` matcher's `hooks` array alongside `forge-deploy-guard.py`.

---

## 3. `post-merge-metrics.py` -- post-merge metrics capture

**Event:** `PostToolUse`, matcher `Bash`.
**Maps to:** RuFlo catalog #6 ("post-merge metrics"; Gauge-shaped pattern).

Passive (always exit 0). Detects a completed `git merge` or `gh pr merge` Bash
command and appends a one-line metric to `store/merge-metrics.log`: timestamp,
the merged ref (parsed from the command when possible), and the merge size from
`git diff --shortstat HEAD~1..HEAD` (files changed / insertions / deletions),
plus the cwd the merge happened in.

Lets Gauge / Forge trend merge cadence and change size without a server round-trip.
Best-effort: if the command was not actually a merge, or git can't be read, it
silently no-ops.

```json
"hooks": {
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/post-merge-metrics.py" }
      ]
    }
  ]
}
```

---

## Combined snippet (all three)

If one agent wants all three, merge them into a single `hooks` block (note the
two `PreToolUse(Bash)` hooks share one matcher entry):

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/pii-injection-scan.py" },
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/pre-deploy-gate.py" }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        { "type": "command", "command": "python3 /home/domin/marveen/scripts/hooks/post-merge-metrics.py" }
      ]
    }
  ]
}
```

## Notes
- Output files (`store/aidefence.log`, `store/merge-metrics.log`,
  `store/.typecheck-green`) are created on first use; no setup needed.
- No new dependencies -- pure Python 3 stdlib, consistent with the `forge-*.py`
  hooks (`jq` is not available on this host).
- These do not modify the live `settings.json`. Wiring is a deliberate per-agent
  opt-in step.
