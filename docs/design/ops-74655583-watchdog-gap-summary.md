# OPS-74655583: Watchdog Gap Analysis Summary

## Problem Statement

The 08-23 incident had 5+ agents wedged due to gaps in watchdog coverage. Root cause: the watchdog system is explicitly enumerated, not auto-discovered. When a new agent is added, it requires manual watchdog configuration. **Current gap: 5 agents lack any watchdog.**

---

## Agent Coverage Snapshot (2026-09-29)

Total agents: **35**

### Watchdog Coverage Breakdown

**COVERED (30 agents):**

1. **Dedicated Watchdog (17 agents):**
   - bigben, buster, chad, claudia, dave, devil-advocate, forge, gyore, hibiki, percy, scout, bond, thor
   - blackbart (NO config file, but has dedicated watchdog)
   - claudia-local, marveen-local (via local-agent-watchdog.sh)
   - bellamy (via sleep-agent-watchdog.sh)

2. **Generic agent-watchdog.sh (13 agents):**
   - applegate, avery, blackbeard, bonny, gauge, kidd, morgan, quill, rackham, radar, roberts, vane
   - These are launched via daemon pgrep in agent-watchdog.sh

**UNCOVERED (5 agents):**
- gelim (NO config file, NO dedicated watchdog)
- gourmet (NO config file, NO dedicated watchdog)
- inkwell (NO config file, NO dedicated watchdog)
- kerrigan (NO config file, NO dedicated watchdog)
- servo-skull (NO config file, NO dedicated watchdog)

Plus marginal:
- heartbeat (HAS config file, but NOT in any watchdog launcher)

**Gap: 6 agents (17% uncovered)**

---

## Root Causes

### 1. No Central Agent Registry
There is no single source of truth declaring "here are the 35 agents, here is which watchdog covers each."
- Watchdog coverage is scattered across multiple scripts (agent-watchdog.sh, <name>-watchdog.sh, local-agent-watchdog.sh, sleep-agent-watchdog.sh)
- No automated verification that coverage == 100%
- New agents fall into gaps silently

### 2. No-Config Agents Not Auto-Discovered
5 agents (gelim, gourmet, inkwell, kerrigan, servo-skull) lack agent-config.json entirely.
- The generic watchdog can safely handle them (defaults to claude-sonnet-4-6)
- BUT: no watchdog launcher scans AGENTS_BASE_DIR to find all agents
- They must be manually added to a hardcoded list

### 3. Manual Watchdog Assignment
Adding a new agent requires:
1. Create `/home/domin/marveen/agents/<name>/`
2. Optionally create `/home/domin/marveen/agents/<name>/agent-config.json`
3. **MANUALLY create `/home/domin/marveen/scripts/<name>-watchdog.sh`**
   OR
   **MANUALLY add `<name>` to the hardcoded list in agent-watchdog.sh**
4. Test

Without enforcement, gaps persist until an incident.

### 4. Implicit Watchdog Coupling
The generic watchdog uses pgrep to find running agents:
```bash
pgrep -f "agent-watchdog.sh $agent"
```

If a watchdog isn't launched, the agent is invisible. No fallback mechanism exists to detect & alert on unwatched agents.

---

## What Needs to Be Built

### Core Changes (4 files)

1. **scripts/lib/agent-roster.sh** (NEW, ~120 LOC)
   - Library: agent discovery + watchdog assignment lookup
   - Functions:
     - `list_all_agents()` — all agent directories
     - `list_channel_agents()` — agents with channelProvider
     - `list_unwatched_agents()` — agents without channelProvider
     - `has_dedicated_watchdog(name)` — check if scripts/<name>-watchdog.sh exists
   - Idempotent, fail-safe, uses same listAgentNames() logic as agent-config.ts

2. **scripts/watchdog.sh** (NEW, ~100 LOC)
   - Meta-launcher: routes any agent to the right watchdog
   - Usage: `watchdog.sh <agent-name>`
   - Logic:
     ```
     if has channelProvider -> delegate to channel watchdog
     else if dedicated watchdog exists -> launch it
     else -> launch generic agent-watchdog.sh
     ```
   - Idempotent: calling 35 times (once per agent) = no duplicates

3. **scripts/watchdog-bootstrap.sh** (NEW, ~80 LOC)
   - Bootstrap runner: scans fleet, ensures all agents have watchdog
   - Called at boot + every 6h via cron
   - Logs all discovered agents + watchdog types
   - Safe to run repeatedly

4. **scripts/agent-watchdog.sh** (MODIFIED, +30 -20 LOC)
   - Source agent-roster.sh
   - Replace hardcoded agent list with dynamic discovery
   - Add pre-flight validation for no-config agents
   - Log warning if agent lacks agent-config.json (operator notice)

### Test Harness (c12-Buster)

**scripts/test-watchdog-effect-probe.sh** (~300 LOC)

5 effect tests:
1. **effect1_coverage:** All gap agents (gelim, gourmet, inkwell, kerrigan, servo-skull, heartbeat) have active watchdog
2. **effect2_no_config_fallback:** No-config agents use default model (claude-sonnet-4-6)
3. **effect3_stability:** 1h run, zero false crashes
4. **effect4_recovery:** Intentional kill -> relaunch within 60-120s
5. **effect5_regression:** Existing dedicated watchdogs unchanged

---

## Success Criteria

**Coverage:**
- All 35 agents have an active watchdog
- No agent dark >5m
- Zero gap agents (gelim, gourmet, inkwell, kerrigan, servo-skull, heartbeat all watched)

**Stability:**
- Crash-loop false-positive rate < 0.5%
- Recovery latency 60-120s (within COOLDOWN, above CRASH_LOOP_THRESHOLD)
- No regression on existing watchdog behavior

**Testing:**
- All 5 effect-probe tests PASS
- Code review: no breaking changes to existing watchdog scripts
- Integration: bootstrap.sh idempotent (call 2x = no duplicates)

---

## Blocking Dependencies

- **Card 5461433c:** GENESIS_AGENT_ID + per-agent token (dave-watchdog PR, prerequisite)

---

## Implementation Phases

### Phase 1: Agent Registry
- Create agent-roster.sh (discovery library)
- Refactor agent-watchdog.sh to use dynamic list
- ~2-3 days

### Phase 2: Meta-Launcher
- Create watchdog.sh (unified router)
- Create watchdog-bootstrap.sh (idempotent bootstrap)
- ~1-2 days

### Phase 3: Testing
- Build effect-probe harness (5 tests)
- Gate review + live fleet test (24h)
- ~3-4 days

### Phase 4: Deployment
- Merge to main
- Update cron/systemd triggers
- Monitor for 24h post-deploy
- ~1 day

**Total: 1-2 weeks**

---

## Key Design Decisions

1. **Roster Library (agent-roster.sh):** Reusable discovery logic, not mixed into individual watchdogs
2. **Unified Meta-Launcher (watchdog.sh):** One entry point for all agent types; easy to test
3. **Idempotent Bootstrap:** Safe to call repeatedly; detects already-running agents
4. **Minimal Breaking Changes:** Existing watchdogs untouched; new code is additive
5. **Fallback Defaults:** No-config agents default to claude-sonnet-4-6 (safe, matches agent-config.ts)

---

## Files to Deliver

1. `/home/domin/marveen/scripts/lib/agent-roster.sh`
2. `/home/domin/marveen/scripts/watchdog.sh`
3. `/home/domin/marveen/scripts/watchdog-bootstrap.sh`
4. `/home/domin/marveen/scripts/test-watchdog-effect-probe.sh`
5. Updated `/home/domin/marveen/scripts/agent-watchdog.sh`
6. Updated `/home/domin/marveen/scripts/watchdog-common.sh` (optional, add wd_validate_agent_dir)

---

## Acceptance Checklist

- [ ] agent-roster.sh implements all 4 discovery functions
- [ ] watchdog.sh correctly routes 35 agents to their watchdogs
- [ ] watchdog-bootstrap.sh produces audit log of all discovered agents
- [ ] agent-watchdog.sh uses dynamic discovery, not hardcoded list
- [ ] All 5 effect-probe tests PASS
- [ ] Coverage verification: all 35 agents have active watchdog
- [ ] Stability test: 1h run, < 0.5% false-positive crash rate
- [ ] Regression test: existing watchdogs unchanged
- [ ] Integration: bootstrap idempotent (call 2x = single set of watchdogs)
- [ ] Cron/systemd updated to call watchdog-bootstrap.sh
- [ ] 24h live fleet monitoring post-deploy: zero new incidents

