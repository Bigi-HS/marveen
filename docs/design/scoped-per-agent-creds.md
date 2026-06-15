# Scoped per-agent credentials (design-first)

**Card:** e7cf5444 — "Scoped per-agent credentials (design-first)"
**Status:** DESIGN ONLY. No implementation in this change.
**Author:** ephemeral eng sub-agent (Dave-class), reporting to marveen.
**Base:** develop @ b4f4b67.

> This is the **"keys, not prompts"** endgame: the step *after* `permissions.deny`.
> The goal is that an agent **physically lacks the key** to perform an action it is
> denied, so a prompt-rule violation or prompt injection cannot reach a real secret.
> This doc maps the current credential layout to real files, states the threat model,
> lays out per-agent scoping options with tradeoffs, recommends a phased approach, and
> defines acceptance criteria for the eventual build.

---

## 1. Problem

The fleet today defends external/irreversible actions in two soft tiers:

1. **`permissions.deny`** — Claude Code's native filesystem/Bash allow/deny lists, applied
   per agent via security profiles (`src/web/profiles.ts:5-17`, profile JSON in
   `templates/profiles/`).
2. **Ask-first PreToolUse hooks** — `scripts/hooks/guardrail-ask-first.py` gates a closed
   set of irreversible MCP tools behind a one-shot operator approval.

Both tiers are **policy at the prompt/permission layer**. Neither removes the underlying
secret from the agent's reach. Every agent runs as the same OS user (`domin`, verified:
`id -un` → `domin`), so every credential file owned by that user is physically readable by
every agent regardless of what its profile "denies".

The guardrail hook itself names this gap as out-of-scope and points here
(`scripts/hooks/guardrail-ask-first.py:30-33`):

> "A Bash-capable agent can still write arbitrary files at the OS layer — that bypass is the
> same class as the permissions.deny pattern bypass and is out of scope here; **the hard
> boundary for it is item 3 (per-agent scoped credentials).**"

This card *is* item 3. The deliverable of the eventual build is: an agent denied an action
cannot obtain the key that performs it, even via raw Bash, even if it ignores every prompt
rule.

---

## 2. Current state (with file references)

### 2.1 The secrets in scope

| Secret | What it grants | Lives at | Mode/owner | Who can read it today |
|---|---|---|---|---|
| **Dashboard bearer token** | Full `/api/*` access (memory, kanban, inter-agent send, agent lifecycle, token rotation) — effectively root over the fleet API | `store/.dashboard-token` | `-rw-------` `domin:domin` (verified) | Every agent (same OS user); 17 scripts read it |
| **Dashboard session secret** | Mint/forge any browser session cookie | `store/.dashboard-session-secret` | `-rw-------` `domin` | Every agent |
| **Telegram bot token(s)** | Send/recv as a specific bot identity | `~/.claude/channels/telegram/.env` (main); per-agent `agents/<name>/.claude/channels/telegram/.env` | `0600` `domin` | Every agent (same user) |
| **Git PAT** | Push to `github.com/Bigi-HS/marveen` (force-push, main-push capable) | `~/.git-credentials` (helper `store`) | `-rw-------` `domin` (verified) | Every agent — **and not denied in any profile** |
| **Fleet OAuth setup-token** | Authenticate as the shared Anthropic account (model access / billing) | `store/fleet-oauth.env` or `store/.claude-oauth-token` | `0600` `domin` | Every agent |
| **Anthropic API key** (own-team agents) | Per-agent model billing | agent `.env` / config | `0600` `domin` | Every agent |

### 2.2 How each secret is read

**Dashboard bearer token** — single shared secret, loaded once and checked by a constant-time
compare:
- Load/create: `src/web/dashboard-auth.ts:44-57` (`loadOrCreateDashboardToken`), env override
  `DASHBOARD_TOKEN` else `store/.dashboard-token`.
- Gate: `src/web/dashboard-auth.ts:95-103` (`checkBearerToken`, `timingSafeEqual`). The header
  comment is explicit: *"A single bearer token gates every /api/\* route"*
  (`src/web/dashboard-auth.ts:7-11`).
- Consumed fleet-wide via `Authorization: Bearer $(cat store/.dashboard-token)` — e.g.
  `scripts/fleet-supervisor.sh:538`, `scripts/watchdog.sh:15-16`,
  `scripts/memory/dream_engine.py:18`, and the scaffold that every new agent is handed
  (`src/web/agent-scaffold.ts:263-266`). 17 scripts reference the path.

  **Implication:** there is exactly one fleet API credential. It is root-equivalent (it can
  call agent lifecycle and even `rotateDashboardToken`), and every agent holds it. There is no
  notion of "scout may read kanban but not stop agents."

**Telegram bot tokens** — read from a provider `.env` by key:
- `src/channel-provider.ts:416-427` (`readChannelToken`) greps `TELEGRAM_BOT_TOKEN=`/`SLACK_BOT_TOKEN=`/`DISCORD_BOT_TOKEN=`.
- State dir resolution: `src/channel-provider.ts:408-414` (`channelStateDir`) →
  `<agentDir>/.claude/channels/telegram` or `~/.claude/channels/telegram`.
- At launch the supervisor **unsets** inherited bot tokens then re-exports only the target
  agent's state dir: `unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN`
  (`src/web/agent-process.ts:341`), then `export TELEGRAM_STATE_DIR=<agentChannelDir>`
  (`src/web/agent-process.ts:340,345-347`). This is the *one place in the repo that already
  practises scoping* — but only for the env var, not for filesystem read access.

**Git PAT** — `origin` is an HTTPS remote (`https://github.com/Bigi-HS/marveen.git`) with
`credential.helper=store` (verified), so the PAT sits plaintext in `~/.git-credentials`. Any
agent that can run `git push` or just `cat ~/.git-credentials` has it. The senior profile denies
`git push --force`, `git push origin main`, etc. (`templates/profiles/developer-senior.json`),
but **does not deny reading `~/.git-credentials`** — so the deny list is bypassable by reading
the raw key and pushing with a hand-rolled URL.

**Fleet OAuth token** — sourced at launch by `scripts/lib/fleet-oauth-env.sh` (strict-parsed,
shape-validated, exported as `CLAUDE_CODE_OAUTH_TOKEN`; `:38-70`). The file is 0600 but
same-user-readable.

### 2.3 The two existing soft tiers, and exactly where they leak

**Tier 1 — `permissions.deny` (profiles).** `templates/profiles/developer-senior.json` denies
e.g. `Read(${HOME}/.ssh/**)`, `Bash(sudo:*)`, `Bash(git push --force:*)`,
`Write(**/access.json)`. These are **pattern matches on the tool invocation**, evaluated by
Claude Code, and the senior/standard profiles run `permissionMode: "permissive"` →
`--dangerously-skip-permissions` is *kept* (`src/web/agent-process.ts:294`,
`src/web/profiles.ts:6-10`). Bypass classes:
  - Read a *non-denied* secret path (`~/.git-credentials`, `store/.dashboard-token`) — neither is
    in any deny list.
  - Reach a denied file by a path the pattern does not match (symlink, `$HOME` vs absolute,
    `cat` vs `Read`).
  - Run a Bash variant the glob did not enumerate.

**Tier 2 — ask-first hook.** `scripts/hooks/guardrail-ask-first.py` blocks a closed enum of
irreversible MCP tools (`GUARDED_TOOLS`, `:82-94`) until an approval marker appears in a dir the
agent's `Write` allow excludes (`:101-110`). It is fail-open by design (`:36-44`) and, by its own
admission, does not stop a Bash-capable agent from forging the marker file or just doing the
underlying action without the MCP tool (`:28-33`).

**Net:** policy is enforced where the agent is asked nicely; the keys themselves are in a shared
pile any agent can `cat`.

---

## 3. Threat model

**Asset:** the six secrets in §2.1. **Trust boundary we want:** each agent should hold only the
keys its role legitimately needs, scoped to the actions it is allowed.

**Primary adversary — the misbehaving insider agent.** An agent that *ignores prompt rules but is
still physically blocked.* Concretely:
- A **prompt-injected** agent: hostile text arrives via inter-agent message, a fetched web page,
  an email body, or a Telegram message, and steers the agent to exfiltrate or misuse a secret.
  The AIDefence guard (`src/aidefence-guard.ts:1-25`) filters inter-agent message bodies, but it
  is one channel, FLAG/BLOCK heuristic, and does not cover Bash/file reads.
- A **buggy or hallucinating** agent that does the wrong destructive thing (e.g. force-push,
  delete a calendar event, send mail) it was never meant to.
- A **compromised low-trust agent** (e.g. a `standard`-profile sandbox like Buster, or an
  ephemeral worktree agent) used as a pivot to the high-value keys.

**What we explicitly do NOT defend here:** a malicious *operator* (Dominik), or full host
compromise / root. Same-OS-user isolation is not a sandbox against the user themselves; it is a
blast-radius limiter between agents.

**STRIDE-flavoured concrete attacks the design must address:**
| # | Attack | Today's outcome | Desired outcome |
|---|---|---|---|
| T1 | Injected agent runs `cat ~/.git-credentials` and pushes to `main` | Succeeds (PAT shared, read not denied) | Agent has no push credential at all, or only a scoped, non-main, non-force token |
| T2 | Low-trust agent reads `store/.dashboard-token` and calls `POST /api/agents/<x>/stop` or `rotateDashboardToken` | Succeeds (one shared root token) | Token is per-agent + capability-scoped; lifecycle calls rejected for that agent |
| T3 | Injected content agent sends mail / deletes a calendar event via the underlying API, bypassing the ask-first MCP tool | Possible at OS layer | Agent never holds the Google credential; only a broker can act, and the broker re-checks ask-first |
| T4 | Agent A impersonates agent B on Telegram by reading B's bot `.env` | Succeeds (same user) | B's token not readable by A |
| T5 | Stolen single token = total fleet compromise; rotation logs everyone out / breaks all scripts | True today | Per-agent revocation; one revoke does not break the fleet |

**Key realisation:** the boundary between agents today is **prompt + permission profile, not the
filesystem**. Every secret is `0600 domin:domin`, which protects against *other Unix users* but
not against *other agents running as `domin`*. So "scoping" must change either (a) who the OS user
is, or (b) where the key lives (out of the agent's reach behind a broker), or (c) what the key can
do (scope the credential itself). Those are the three option families below.

---

## 4. Options (with tradeoffs)

The options are not mutually exclusive; the recommendation (§5) layers them. Each is rated on
**Strength** (does it physically block T1–T5), **Effort**, and **Blast radius on the running
fleet**.

### Option A — Separate, narrowly-scoped tokens per agent (same OS user)

Give each agent its own credential string, each scoped to the minimum capability:
- **Dashboard:** replace the single bearer with **per-agent API tokens** carrying a capability
  set (e.g. `kanban:read`, `kanban:write`, `memory:*`, `messages:send`, `agents:lifecycle`).
  `checkBearerToken` (`src/web/dashboard-auth.ts:95-103`) becomes "resolve token → agent +
  capabilities" and each route asserts a required capability. The token file moves from one shared
  `store/.dashboard-token` to per-agent files only that agent's launch env exports.
- **Git:** issue a **fine-grained GitHub PAT per agent** (or per role) scoped to the single repo,
  contents+PR write only, *no* `workflow`/admin, and rely on branch-protection on `develop`/`main`
  so even a write token cannot force-push protected branches. Stop using `credential.helper=store`
  (plaintext shared file); inject the token via `GIT_ASKPASS`/`GITHUB_TOKEN` into only the agents
  that push.
- **Telegram/Google:** each bot token already lives in a per-agent state dir; formalise that no
  agent's launch env or file-read reaches another's.

**Tradeoffs.**
+ Directly kills T2/T5 (scoped + per-agent revocation) and weakens T1 (scoped PAT can't touch
  `main`). Incremental: can ship dashboard scoping without touching OS layout.
+ Cheap rotation/revocation per agent; one leak ≠ fleet compromise.
− **Does NOT stop a Bash-capable same-user agent from reading another agent's token file.** Mode
  0600 same-user is not a boundary. So A alone reduces the *value* of each key but not the
  *reachability* of others' keys. Must be paired with B or C for the "physically lacks the key"
  property when agents share an OS user.
− Real engineering on the server: a capability model, token store, per-route assertions, and a
  migration of 17 scripts + the agent scaffold (`src/web/agent-scaffold.ts:263-266`).

### Option B — OS-user (or container) isolation per agent

Run each agent (or each trust tier) as a **distinct Unix user** (or in a per-agent
container/namespace). Then file mode `0600 agentX:agentX` is a real boundary: agent B literally
cannot `cat` agent A's `~/.git-credentials` or `~/.claude/channels/.../.env`.

**Tradeoffs.**
+ **Strongest** "physically lacks the key" guarantee for file-resident secrets: the OS enforces it,
  no prompt or hook needed. Kills T1–T4 at the read layer.
+ Composes well with A (scoped tokens *and* unreadable across agents).
− **Heavy** on this host: agents launch via `tmux new-session` as the current user
  (`src/web/agent-process.ts` launch path), share `~/.claude`, a symlinked transcript store
  (`:337`), the OAuth helper, and `store/`. Multi-user means per-user HOME, per-user Claude config,
  sudo-less `setuid`/`runuser` plumbing, and reworking every `store/`-relative path the fleet
  assumes. WSL adds friction (no systemd; `fleet-eng-context.md:42`).
− High blast radius / regression risk on a live fleet; must be staged on the Buster sandbox first
  (c12). Likely a *later* phase, possibly scoped to only the highest-value secret (git/Google).
− Containers add image/build/IPC overhead and complicate the shared SQLite (`store/claudeclaw.db`)
  and dashboard socket.

### Option C — Credential broker / proxy (agents hold no raw keys)

A small privileged **broker service** holds the raw secrets. Agents hold only a low-value
**identity token** and request *scoped actions*, never the key:
- **Git:** agents push to the broker (or the broker is the only `GIT_ASKPASS` provider); the broker
  enforces "agent X may open a PR to develop but never force-push main." The raw PAT lives only in
  the broker's address space.
- **Google/email:** agents call `broker.gmail_send(...)`; the broker re-runs the ask-first check
  and holds the OAuth creds. This finally closes T3 (the OS-layer bypass of the MCP guard) because
  the agent never has the Google credential to bypass *with*.
- **Dashboard:** the existing `/api/*` server *is already a broker shape* — agents act through it,
  not on the DB directly. Extending it with per-agent identity + capabilities (Option A applied to
  the dashboard) is the cheapest broker we already half-own.

**Tradeoffs.**
+ Best fit for the "keys, not prompts" framing: the key never enters the agent. Centralises
  audit/rate-limit/ask-first re-checks. Revocation = flip one identity in the broker.
+ Can be introduced *secret-by-secret* (start with git or Google) without an OS-layout change.
− New always-on privileged component = new attack surface and a new SPOF (if the broker is down,
  no agent can push/send). Must itself be hardened and minimally-scoped.
− Still needs Option B (or strict broker-only file perms) so an agent can't just read the broker's
  own secret store. On a single OS user the broker's secret file is same-user-readable unless the
  broker runs as a different user. So C's guarantee is only as strong as the isolation under it.
− Real protocol/impl work per secret type.

### Option summary

| Option | Strength (blocks T1–T5) | Effort | Live-fleet blast radius | Stands alone? |
|---|---|---|---|---|
| A — scoped per-agent tokens | Medium (scopes value, not cross-read) | Medium | Medium (server + 17 scripts) | No (needs B/C for read-isolation) |
| B — OS-user/container isolation | High (file reads truly blocked) | High | High (launch + HOME + paths) | Partially (file secrets only) |
| C — credential broker | High (key never reaches agent) | Medium–High per secret | Medium (new service) | No (needs B or broker-only perms) |

---

## 5. Recommendation — phased, value-first

Adopt a **layered** target (A capabilities + C broker for the highest-value keys, B isolation under
the broker where feasible), reached in phases ordered by *value of the key × ease of scoping*.

**Phase 0 — Inventory + invariant tests (no behaviour change).**
- Land a single source-of-truth doc/table of every secret, its file, its readers (this doc's §2.1
  is the seed), and a test asserting profile deny-lists actually cover the *secret files*
  (`~/.git-credentials`, `store/.dashboard-token` are currently NOT denied — fix that as a stopgap
  even though it's only the soft tier). Model on the existing
  `src/__tests__/profile-deny-invariants.test.ts`.
- Add `Read(${HOME}/.git-credentials)`, `Read(**/store/.dashboard-token)`,
  `Read(**/store/.claude-oauth-token)`, `Read(**/store/fleet-oauth.env)` to every non-marveen deny
  list as an immediate (still soft) hardening while the real fix lands.

**Phase 1 — Git PAT scoping (highest value, cleanest win).**
- Replace the shared `credential.helper=store` PAT with **fine-grained, per-role PATs** scoped to
  the one repo, contents+PR only, no admin/workflow. Enable GitHub **branch protection** on
  `develop` and `main` so even a leaked write token cannot force-push (defence in depth behind the
  existing `Bash(git push --force:*)` deny). Inject via env (`GITHUB_TOKEN`/`GIT_ASKPASS`) only into
  agents that push (Dave, Armorer, ephemerals); channel-less non-eng agents get none.
- This alone retires T1 to "open a normal PR, which the Thor+Dave gate already reviews."

**Phase 2 — Dashboard capability tokens (Option A applied to the broker we own).**
- Per-agent API tokens with a capability set; `checkBearerToken` → token-resolver + per-route
  capability assertion (`src/web/dashboard-auth.ts`). Lifecycle (`agents:*`) and `rotate-token`
  restricted to marveen/operator. Migrate the scaffold (`src/web/agent-scaffold.ts:263-266`) and
  scripts to read their own token path. Per-agent revocation. Retires T2.

**Phase 3 — Google/email broker (Option C for the irreversible-MCP class).**
- Move the Google OAuth creds behind the dashboard (or a sibling broker) so Claudia calls
  `broker.gmail_send`; the broker re-runs the ask-first check
  (`scripts/hooks/guardrail-ask-first.py` logic) server-side. Agents never hold the Google key, so
  the OS-layer bypass (T3) is closed at the source.

**Phase 4 — OS-user isolation for the residual high-value file secrets (Option B), staged on
Buster (c12) first.**
- Where a key must still live in a file an agent's process reaches, give that tier its own Unix
  user so 0600 becomes a real cross-agent boundary. Treat as a larger, separately-gated project;
  do not block Phases 1–3 on it.

**Why this order:** Phase 1 removes the worst single-key risk with mostly *config* (GitHub
fine-grained PAT + branch protection) and minimal code. Phases 2–3 leverage the broker we already
operate (the `/api/*` server) instead of building new isolation. Phase 4 (the heavy OS change) is
last and optional-per-secret, because A+C already deliver most of the "keys, not prompts" value at
a fraction of the disruption.

---

## 6. Acceptance criteria for the eventual build

Per phase, "done" means a *test or check that fails today and passes after*, plus a Thor+Dave+Chad
gate (security/credential PR → Chad mandatory, per `fleet-eng-context.md:19-20`).

**Cross-cutting**
- [ ] No raw secret string appears in any agent launch argv, log, or transcript (extends the
  existing discipline at `src/web/agent-process.ts:315-323`).
- [ ] An automated invariant test asserts every secret file in the §2.1 inventory is *either*
  unreadable by a given non-owner agent *or* not present in that agent's env (model:
  `src/__tests__/profile-deny-invariants.test.ts`).
- [ ] Rotation/revocation is **per-agent**: revoking agent X does not break agents Y/Z and does not
  log out the operator dashboard (today rotation is fleet-wide — `rotateDashboardToken`,
  `dashboard-auth.ts:87-93`).

**Phase 1 (git)**
- [ ] No agent can read a usable push credential for the repo except via its own injected,
  fine-grained token; `~/.git-credentials` no longer holds an admin/main-capable PAT.
- [ ] Branch protection on `develop` + `main` rejects force-push even with a valid write token
  (verified with a deliberately-attempted force-push in CI/sandbox).
- [ ] Channel-less non-eng agents have *no* git push credential at all.

**Phase 2 (dashboard)**
- [ ] A low-trust agent's token is rejected (HTTP 403) on `agents:*` lifecycle routes and
  `rotate-token`, accepted on its allowed routes — covered by route-level tests.
- [ ] The shared `store/.dashboard-token` is retired; each script/agent reads only its own token
  path; the scaffold hands a scoped token.

**Phase 3 (Google broker)**
- [ ] Claudia's agent process does not hold the Google OAuth credential (verified: not in env, not
  file-readable by it); mail/calendar mutations go only through the broker, which re-applies the
  ask-first gate server-side.

**Phase 4 (OS isolation, if pursued)**
- [ ] A second agent running as its own Unix user cannot `cat` the target secret (OS-enforced
  `EACCES`), proven on Buster before any live agent.

**Non-functional**
- [ ] Every change is sandbox-tested on Buster (c12) before touching a live agent, per
  `fleet-eng-context.md:26`.
- [ ] `npm run typecheck` + `npm test` green; security PR carries the pre-gate evidence bundle.

---

## 7. Risks / open questions

1. **Same-OS-user is the crux.** Options A and C only deliver "physically lacks the key" once the
   key is *not a same-user-readable file*. Decide early per secret: broker-held (C) vs OS-isolated
   (B). A-alone is a value-limiter, not a wall — set expectations accordingly.
2. **Fine-grained PAT lifecycle.** GitHub fine-grained PATs expire and are per-account; who owns
   issuance/rotation (Armorer?) and where do per-agent tokens live so they are *not* a new shared
   pile? Risk of recreating the `store`-helper problem under a new name.
3. **Broker as SPOF + new attack surface.** If git/Google must go through a broker, an outage blocks
   pushes/sends. Need health-checks, and the broker must itself be minimally-scoped and (ideally)
   run under its own user.
4. **17 scripts + the scaffold read the one dashboard token.** Phase 2 is a wide migration; a missed
   reader silently breaks (e.g. watchdogs at `scripts/watchdog.sh:15-16`,
   `scripts/fleet-supervisor.sh:538`). Need a grep-complete inventory and a back-compat window.
5. **Telegram per-agent tokens are already separate but same-user-readable.** Confirm whether bot
   impersonation (T4) is in-scope enough to justify B for channel `.env`s, or whether per-bot
   tokens + the existing `unset`-then-export launch discipline (`agent-process.ts:341`) is deemed
   sufficient for now.
6. **WSL / no-systemd constraints.** OS-user isolation and a broker daemon both want supervised
   long-lived processes; this host has no systemd (`fleet-eng-context.md:42`). The supervisor
   pattern must carry them, which is its own reliability surface.
7. **Operator-as-adversary is out of scope** — confirm that is acceptable for the threat model (it
   is the stated boundary in §3) so reviewers don't expect host-compromise resistance.
8. **Interaction with the ask-first hook.** Phase 3 moves the ask-first re-check server-side; ensure
   the hook (`guardrail-ask-first.py`) and the broker do not double-prompt or, worse, leave a gap
   where neither fires during the transition.
