# Telegram MCP-pipe watchdog

Closes the "Genesis elnémulás": the orchestrator (`marveen-channels`) runs the
native Telegram plugin as a `bun` MCP stdio child. A long OS sleep **or a
dashboard-server restart** kills that child and it does **not** respawn, so the
`reply` tool vanishes and Genesis goes mute on Telegram until a human runs
`/mcp`. The in-process `channel-health-monitor` only recovers the dashboard's
**own** poller (and dies with the dashboard on a restart), so a separate
process is required.

## Components

| Piece | File | Role |
|-------|------|------|
| Decision core + cycle | `src/web/telegram-pipe-watchdog.ts` | Pure liveness/escalation logic + `runCycle()` IO |
| CLI driver | `src/web/telegram-pipe-watchdog-cli.ts` | One cycle per process, exits 0 |
| Standalone loop | `scripts/telegram-pipe-watchdog.sh` | 5-min cadence, survives dashboard restart |
| Drop-simulation | `scripts/telegram-pipe-drop-sim.sh` | Controlled, PID-scoped pipe kill for replay |
| Recovery log | `store/telegram-pipe-watchdog.log` | Timestamped drop/recovery/escalation events |
| Persisted state | `store/telegram-pipe-watchdog.state.json` | Consecutive-dead counter + alert flag across cycles |

## How it decides (liveness)

The authoritative signal is the Telegram **409 Conflict**: a `getUpdates` probe
issued by the watchdog returns `409` when the native poller holds the token's
`getUpdates` slot (**alive and actively polling**), and a clean `200` when the
slot is **free** (nobody is polling = dead pipe). Process presence (`bot.pid` +
`ps eww` env scan) is a secondary signal that catches a gone child before the
probe. A network error is **inconclusive** and never triggers action (fail-safe
on the live orchestrator).

- `dead` -> drive recovery via the tested `attemptChannelMcpReconnect` (`/mcp`
  menu navigation; reads the `Status:` header, only presses Reconnect/Enable,
  **never** Disable).
- 2 consecutive `dead` cycles (~10 min) -> **one** fallback alert via a direct
  Bot API `sendMessage` (never the dead pipe), then quiet until recovery
  (anti-spam).

## Test recipe (replay the drop -> recovery on demand)

Run on the **Buster sandbox** first (mandatory before any live use). Buster has
its own `@Buster_TestDummy_bot` pipe, so dropping it never touches the live
orchestrator.

```bash
cd /home/domin/marveen
npm run build                                   # build the CLI

# 1. Baseline: confirm the pipe is healthy (expect verdict=healthy)
node dist/web/telegram-pipe-watchdog-cli.js

# 2. Simulate the drop (kills ONLY the bun child by bot.pid)
scripts/telegram-pipe-drop-sim.sh --target buster

# 3. Run a cycle: expect verdict=dead + a recovery-attempt
node dist/web/telegram-pipe-watchdog-cli.js

# 4. Inspect the provable event log
cat store/telegram-pipe-watchdog.log
#   <ISO>  drop-detected     consecutiveDead=1 present=... status=...
#   <ISO>  recovery-attempt  attempt for marveen
#   <ISO>  recovery-attempt  result: ok: Activated Reconnect via /mcp (Up xN)
#   ... (after 2 dead cycles) escalated  fallback alert sent to chat <id>
#   <ISO>  recovered         after N dead cycle(s)
```

To exercise the **escalation** path, run step 3 twice without recovery; the
second dead cycle crosses the 2-cycle threshold and sends the single fallback
alert.

### Live replay (after deploy, with care)

```bash
scripts/telegram-pipe-drop-sim.sh --target main --confirm   # mutes Genesis until recovery
tail -f store/telegram-pipe-watchdog.log                     # watch auto-recovery
```

## Wiring (post-gate, post-deploy)

The loop is started like the other watchdogs (e.g. from the supervisor / boot
script), independent of the dashboard:

```bash
nohup scripts/telegram-pipe-watchdog.sh >/dev/null 2>&1 &
```

It needs `dist/web/telegram-pipe-watchdog-cli.js` (run `npm run build`) and the
main bot token at `~/.claude/channels/telegram/.env`. The escalation chat is
`WATCHDOG_ALERT_CHAT_ID` (defaults to the operator chat).
