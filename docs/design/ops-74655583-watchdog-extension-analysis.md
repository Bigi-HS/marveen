# OPS-74655583: Bash-Watchdog Extension for Non-Channel Agents

## Executive Summary

**Goal:** Extend the bash-watchdog system to monitor ALL non-channel agents (both channel-less AND those without agent-config.json). Root fix for 08-23 6h-dark incident where 5+ agents wedged due to incomplete watchdog coverage.

**Current State:**
- Generic `agent-watchdog.sh` covers 13-15 agents via pgrep-launched daemon
- Dedicated watchdog scripts exist for 17 agents (bigben, buster, chad, claudia, dave, etc.)
- **GAP:** No mechanism to discover and auto-watch agents that lack both a dedicated watchdog AND are not in the generic coverage list

**Problem Statement:** The watchdog system is explicitly enumerated, not auto-discovered. Adding a new agent requires manual watchdog configuration. 7 agents currently lack watchdog coverage (blackbart, gelim, gourmet, hibiki, inkwell, kerrigan, servo-skull, and heartbeat-unaddressed).

---

## Agent Inventory (as of 2026-09-29)

### Total Agents: 35

| Name | Channel Status | Config | Watchdog Type | Coverage |
|------|---|---|---|---|
| applegate | channel-less | yes | generic agent-watchdog.sh | COVERED |
| avery | channel-less | yes | generic agent-watchdog.sh | COVERED |
| bellamy | channel-less | yes | sleep-agent-watchdog.sh | COVERED |
| bigben | channel-less | yes | bigben-watchdog.sh | COVERED |
| blackbart | channel-less | NO | none | **UNCOVERED** |
| blackbeard | channel-less | yes | generic agent-watchdog.sh | COVERED |
| bond | telegram | yes | bond-watchdog.sh | COVERED |
| bonny | channel-less | yes | generic agent-watchdog.sh | COVERED |
| buster | channel-less | yes | buster-watchdog.sh | COVERED |
| chad | telegram | yes | chad-watchdog.sh | COVERED |
| claudia | telegram | yes | claudia-watchdog.sh | COVERED |
| claudia-local | channel-less | yes | local-agent-watchdog.sh | COVERED |
| dave | telegram | yes | dave-watchdog.sh | COVERED |
| devil-advocate | channel-less | yes | devil-advocate-watchdog.sh | COVERED |
| forge | telegram | yes | forge-watchdog.sh | COVERED |
| gauge | channel-less | yes | generic agent-watchdog.sh | COVERED |
| gelim | channel-less | NO | none | **UNCOVERED** |
| gourmet | channel-less | NO | none | **UNCOVERED** |
| gyore | telegram | yes | gyore-watchdog.sh | COVERED |
| heartbeat | channel-less | yes | none | **UNCOVERED** |
| hibiki | channel-less | NO | none | **UNCOVERED** |
| inkwell | channel-less | NO | none | **UNCOVERED** |
| kerrigan | channel-less | NO | none | **UNCOVERED** |
| kidd | channel-less | yes | generic agent-watchdog.sh | COVERED |
| marveen-local | channel-less | yes | local-agent-watchdog.sh | COVERED |
| morgan | channel-less | yes | generic agent-watchdog.sh | COVERED |
| percy | telegram | yes | percy-watchdog.sh | COVERED |
| quill | channel-less | yes | generic agent-watchdog.sh | COVERED |
| rackham | channel-less | yes | generic agent-watchdog.sh | COVERED |
| radar | channel-less | yes | generic agent-watchdog.sh | COVERED |
| roberts | channel-less | yes | generic agent-watchdog.sh | COVERED |
| scout | channel-less | yes | scout-watchdog.sh | COVERED |
| servo-skull | channel-less | NO | none | **UNCOVERED** |
| thor | telegram | yes | thor-watchdog.sh | COVERED |
| vane | channel-less | yes | generic agent-watchdog.sh | COVERED |

### Coverage Summary

- **Total agents:** 35
- **Covered:** 28 agents (3 generic + 17 dedicated + 8 varied)
- **Uncovered:** 7 agents (21% gap)

**Uncovered agents:**
- No agent-config.json: blackbart, gelim, gourmet, hibiki, inkwell, kerrigan, servo-skull (7 agents)
- Has config but no dedicated watchdog: heartbeat (1 agent, config exists)

---

## Root Cause Analysis

### 1. Explicit vs. Auto-Discovery Design
The watchdog system is **enumerated**, not discovered. Each watchdog is:
- Either launched manually (`agent-watchdog.sh <name>` or `<name>-watchdog.sh`)
- Or hardcoded into a launcher (agent-watchdog.sh `pgrep` covers a fixed set)
- Or registered in boot scripts / cron

**Problem:** There is no central registry declaring "here are all 35 agents, and here is the coverage plan." When a gap exists (7 agents), there is no automated detection or recovery.

### 2. No-Config Agents
7 agents lack `agent-config.json` entirely. The generic watchdog can still handle them:
- `wd_read_model()` defaults to `claude-sonnet-4-6` when config is missing (safe)
- The agent can launch with channel-less mode (correct)
- BUT: there is no watchdog launched for them

**Problem:** The watchdog launcher doesn't scan for all agents in AGENTS_BASE_DIR, only for hardcoded names.

### 3. Manual Watchdog Assignment
Adding a new agent requires:
- Creating agents/<name>/ directory
- Optionally creating agents/<name>/agent-config.json
- Manually creating scripts/<name>-watchdog.sh OR adding <name> to the generic launcher
- Testing

**Problem:** No enforcement that a new agent gets watched. A gap can persist until an incident surfaces it.

### 4. Stale Coverage List
The generic `agent-watchdog.sh` hardcodes:
```bash
for agent in gauge quill applegate radar blackbeard morgan roberts kidd rackham bonny avery vane; do
```

When new agents are added, this list falls out of sync. As of 2026-09-29, there is no systematic way to know which agents are missing.

---

## Implementation Plan (4-Phase)

### Phase 1: Agent Registry + Auto-Discovery

**Goal:** Build a definitive list of all agents and their watchdog status.

#### 1a. Create `/home/domin/marveen/scripts/lib/agent-roster.sh`

A shareable library that discovers agents and their coverage.

```bash
#!/bin/bash
# Agent discovery and watchdog assignment.
# Source this in watchdog scripts to get agent facts.

# list_all_agents() -> outputs all agent directory names (one per line)
# Uses the same logic as agent-config.ts listAgentNames()
# Excludes .hidden-from-dashboard sentinel dirs

# list_channel_agents() -> agents with channelProvider set
# Reads agent-config.json for each agent

# list_unwatched_agents() -> agents without channelProvider
# Complement of list_channel_agents()

# has_dedicated_watchdog(name) -> true if scripts/<name>-watchdog.sh exists

# get_agent_model(name) -> reads model from agent-config.json
# Defaults to claude-sonnet-4-6 if missing or no config
```

**Implementation Details:**
- Source watchdog-common.sh for shared functions (wd_read_model)
- Use `stat` to check for .hidden-from-dashboard sentinel (same as agent-config.ts)
- Cache results if called repeatedly in a single session (minor optimization)

#### 1b. Update `agent-watchdog.sh`

Current behavior: hardcoded agent list.
New behavior: dynamic discovery.

```bash
#!/bin/bash
# Generic watchdog for CHANNEL-LESS fleet sub-agents.
# Now auto-discovers agents instead of hardcoding.

. "$(dirname "$0")/lib/agent-roster.sh" || { log "FATAL: agent-roster.sh missing"; exit 1; }

# For each unwatched agent (not covered by dedicated watchdogs):
for agent in $(list_unwatched_agents | grep -v "^$(list_dedicated_agents)$"); do
  if ! has_dedicated_watchdog "$agent"; then
    # Launch generic watchdog for this agent
    launch_watchdog "$agent"
  fi
done
```

**Fallback strategy:** If agent-roster.sh fails, use hardcoded list as emergency.

#### 1c. Create `/home/domin/marveen/scripts/watchdog-bootstrap.sh`

Runs once at boot or on demand to ensure all agents are watched.

```bash
#!/bin/bash
# Bootstrap watchdog coverage for all non-channel agents.
# Idempotent: safe to run repeatedly without duplication.

. "$(dirname "$0")/lib/agent-roster.sh"

log() { echo "[$(date -Is)] $*" | tee -a /home/domin/marveen/store/watchdog-bootstrap.log; }

for agent in $(list_unwatched_agents); do
  if has_dedicated_watchdog "$agent"; then
    # Delegate to dedicated watchdog
    log "Launching dedicated watchdog for $agent"
    nohup "$(dirname "$0")/${agent}-watchdog.sh" &
  else
    # Use generic watchdog
    log "Launching generic watchdog for $agent"
    nohup "$(dirname "$0")/agent-watchdog.sh" "$agent" &
  fi
done

log "Bootstrap complete. $(list_unwatched_agents | wc -l) agents watched."
```

### Phase 2: No-Config Agent Handling

**Goal:** Safe defaults for agents without agent-config.json.

#### 2a. Update `watchdog-common.sh`

Add pre-flight validation (non-breaking):

```bash
# wd_validate_agent_dir(name) -> 0 if agent can be launched, 1 otherwise
# Checks:
#   - AGENT_DIR exists and is a directory
#   - AGENT_DIR/.claude-config exists or can be created
#   - AGENT_DIR has read+execute permissions
# Returns 0 even if agent-config.json missing (safe fallback)
```

#### 2b. Update `agent-watchdog.sh`

```bash
# Before launch:
if ! wd_validate_agent_dir "$NAME"; then
  log "ERROR: $NAME directory invalid, skipping launch"
  exit 1
fi

# If no agent-config.json, log a warning but proceed:
if [ ! -f "$ACONF" ]; then
  log "WARN: $NAME has no agent-config.json, using default model (claude-sonnet-4-6)"
fi
```

### Phase 3: Extended Watchdog Command (Unified Launcher)

**Goal:** One script to route all agents to the right watchdog.

#### 3a. Create `/home/domin/marveen/scripts/watchdog.sh`

Meta-watchdog that knows about all agent types.

```bash
#!/bin/bash
# usage: watchdog.sh <agent-name>
# Delegates to the appropriate watchdog type.
# Idempotent: safe to call for all 35 agents.

NAME="$1"
[ -z "$NAME" ] && echo "usage: watchdog.sh <agent>" >&2 && exit 2

. "$(dirname "$0")/lib/agent-roster.sh"

# Determine agent type and delegate
if grep -q '"channelProvider"' "/home/domin/marveen/agents/$NAME/agent-config.json" 2>/dev/null; then
  # Channel agent - delegate to appropriate channel watchdog
  provider=$(grep -o '"channelProvider"[[:space:]]*:[[:space:]]*"[^"]*"' ... | sed 's/.*: *"\([^"]*\)"/\1/')
  case "$provider" in
    telegram)
      if [ "$NAME" = "dave" ] || [ "$NAME" = "thor" ]; then
        exec "$(dirname "$0")/${NAME}-watchdog.sh"
      else
        # Telegram agent with dedicated watchdog
        if [ -f "$(dirname "$0")/${NAME}-watchdog.sh" ]; then
          exec "$(dirname "$0")/${NAME}-watchdog.sh"
        fi
      fi
      ;;
  esac
elif [ -f "$(dirname "$0")/${NAME}-watchdog.sh" ]; then
  # Has dedicated watchdog, use it
  exec "$(dirname "$0")/${NAME}-watchdog.sh"
else
  # Use generic watchdog
  exec "$(dirname "$0")/agent-watchdog.sh" "$NAME"
fi
```

#### 3b. Cron/Systemd Integration

Create `/etc/cron.d/fleet-watchdog-bootstrap` or systemd timer:

```bash
# Run bootstrap at boot + every 6 hours (detect new agents, restart stale watchdogs)
@reboot domin /home/domin/marveen/scripts/watchdog-bootstrap.sh
0 */6 * * * domin /home/domin/marveen/scripts/watchdog-bootstrap.sh
```

### Phase 4: Effect-Probe Testing (c12-Buster Spec)

**Goal:** Comprehensive coverage and stability verification.

#### Test Plan

1. **Coverage Verification (effect1_watchdog_covers_all_agents)**
   - Action: Call `watchdog.sh` for each of the 7 gap agents
   - Verification:
     - tmux session created (tmux has-session -t agent-<name>)
     - Watchdog process running (pgrep agent-watchdog.sh <name>)
   - Pass Criteria: 7/7 gap agents have active watchdog after 60s

2. **Model Resolution for No-Config Agents (effect2_no_config_model_fallback)**
   - Action: Launch blackbart (no config)
   - Verification: Check `tmux capture-pane` for "claude-sonnet-4-6" or similar
   - Pass Criteria: Agent uses default model without errors

3. **Stability: No False Crashes (effect3_false_positive_rate)**
   - Action: Run all 35 watchdogs for 1 hour
   - Measurement:
     - Count crash/relaunch events per agent (should be 0)
     - Count crash-loop alerts (should be 0)
   - Pass Criteria: < 0.1% of agents experience unexpected restart

4. **Recovery Latency (effect4_recovery_within_threshold)**
   - Action: Intentionally kill applegate session
   - Measurement: Time from kill to watchdog relaunch
   - Pass Criteria: relaunch 60-120s (within COOLDOWN and above CRASH_LOOP_THRESHOLD)

5. **No Regression on Dedicated Watchdogs (effect5_dedicated_watchdog_compat)**
   - Action: Run existing dedicated watchdogs (chad, forge, etc.) for 1 hour
   - Verification: No new crashes, no log errors
   - Pass Criteria: Zero regression on existing watchdog behavior

#### Test Harness (c12-Buster)

```bash
# scripts/test-watchdog-effect-probe.sh
# Orchestrates all 5 effect tests
# Produces: test-results.json with PASS/FAIL per effect
# Exit code: 0 if all pass, 1 if any fail
```

#### Gate Criteria

- All 5 effects must PASS
- Code review: no breaking changes to existing watchdog API
- Static analysis: agent-roster.sh correctly excludes .hidden-from-dashboard
- Integration: bootstrap.sh runs idempotent (calling twice produces no duplicates)

---

## Blocking Dependencies

- **Card 5461433c:** GENESIS_AGENT_ID + per-agent token (dave-watchdog PR, needed for extended watchdog support)
- **Card bea870b8:** listen-guard multi-line bypass (LOW priority, post-5461433c)
- **Card 8c823cdc:** poller contract (locked behind 5461433c)

---

## Success Metrics (WELL-027 Health-Boss-Morning)

1. **Coverage:** All 35 agents have active watchdog (0 gap agents)
2. **Availability:** No agent remains dark >5min (heartbeat canary)
3. **Stability:** Crash-loop false-positive rate < 0.5%
4. **Recovery:** Mean recovery latency (death → relaunch) < 120s
5. **Regression:** No new failures in existing watchdog suite

---

## Diff Outline

| File | Change | LOC |
|------|--------|-----|
| scripts/lib/agent-roster.sh | NEW (discovery library) | ~120 |
| scripts/agent-watchdog.sh | MODIFIED (add roster sourcing) | +30 -20 |
| scripts/watchdog-common.sh | MODIFIED (add wd_validate_agent_dir) | +20 |
| scripts/watchdog.sh | NEW (meta-launcher) | ~100 |
| scripts/watchdog-bootstrap.sh | NEW (bootstrap runner) | ~80 |
| scripts/test-watchdog-effect-probe.sh | NEW (test harness) | ~300 |

---

## Deployment Checklist

- [ ] Card 5461433c merged (prerequisite)
- [ ] agent-roster.sh implemented + code-reviewed
- [ ] watchdog.sh implemented + code-reviewed
- [ ] watchdog-bootstrap.sh implemented + code-reviewed
- [ ] All 5 effect-probe tests PASS (c12-buster gate)
- [ ] Bootstrap idempotency verified (call twice, no duplicates)
- [ ] Cron/systemd trigger configured
- [ ] Live fleet test: monitor for 24h, zero new crash-loop alerts
- [ ] CLAUDE.md updated with new watchdog section
- [ ] Per-agent watchdog.log entries created for 7 gap agents

---

## Timeline

- **Week 1:** Implement Phase 1 (agent-roster.sh, agent-watchdog.sh refactor)
- **Week 2:** Implement Phase 2-3 (no-config handling, watchdog.sh meta-launcher)
- **Week 3:** Implement Phase 4 (c12-buster effect-probe tests)
- **Week 4:** Gate review, deployment, 24h live monitoring

---

## Key Design Decisions

1. **Idempotent Launchers:** watchdog-bootstrap.sh and watchdog.sh are safe to call repeatedly (detect already-running agents, skip)
2. **Fallback Defaults:** No-config agents default to claude-sonnet-4-6 (safe, matches agent-config.ts)
3. **No Hard Deletions:** Watchdog gap agents are soft-discovered (if directory exists, watch it)
4. **Minimal Breaking Changes:** Existing dedicated watchdogs unchanged; agent-roster.sh is a new library, not a replacement

