import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
}

// instrumentCheck -- dual-arm calibration gate (W1/c2f7904b design contract)
//
// ARM-A (negative / FP-guard): probe must NOT fire on a confirmed-healthy agent.
//   Fire on healthy => instrument miscalibrated => VAK-RIASZTAS (FP risk).
// ARM-B (positive / blindness-guard): probe MUST fire on a known-bad fixture.
//   Miss on bad => instrument is blind => VAK-RIASZTAS (FN risk).
//
// Returns true only when both arms pass (instrument is calibrated and sighted).
export function instrumentCheck(
  probe: (agent: string) => boolean,
  healthyAgent: string,
  badFixture: string,
  log: Logger,
): boolean {
  if (probe(healthyAgent)) {
    log.warn({ healthyAgent }, 'instrument_check ARM-A FAIL: fires on healthy agent (VAK-RIASZTAS/FP)')
    return false
  }
  if (!probe(badFixture)) {
    log.warn({ badFixture }, 'instrument_check ARM-B FAIL: blind on known-bad fixture (VAK-RIASZTAS/FN)')
    return false
  }
  return true
}

// strikeGate -- 2-strike persistence with confirmed-latch
//
// First call: write strike file, return false.
// Second call within windowSeconds: confirmed, return true.
// Stale first strike (> windowSeconds): reset, return false.
// Confirmed-latch: suppresses re-confirmation for latchWindowSeconds to prevent
//   every-other-sweep flapping (mirrors the bash variant's CONFIRMED-LATCH note).
//
// Returns true = confirmed (2nd strike); false = first strike, stale, or latched.
export function strikeGate(
  agent: string,
  stateDir: string,
  windowSeconds = 600,
  latchWindowSeconds?: number,
): boolean {
  const latchWindow = latchWindowSeconds ?? windowSeconds
  const strikeFile = join(stateDir, `strike-${agent}`)
  const latchFile = join(stateDir, `strike-latch-${agent}`)
  const now = Math.floor(Date.now() / 1000)

  if (existsSync(latchFile)) {
    const latchTs = safeReadInt(latchFile)
    if (now - latchTs < latchWindow) {
      return false
    }
    rmSync(latchFile, { force: true })
  }

  if (!existsSync(strikeFile)) {
    writeFileSync(strikeFile, String(now))
    return false
  }

  const ts = safeReadInt(strikeFile)
  if (now - ts > windowSeconds) {
    writeFileSync(strikeFile, String(now))
    return false
  }

  rmSync(strikeFile, { force: true })
  writeFileSync(latchFile, String(now))
  return true
}

// strikeClear -- remove strike and latch files (call when agent observed healthy)
export function strikeClear(agent: string, stateDir: string): void {
  rmSync(join(stateDir, `strike-${agent}`), { force: true })
  rmSync(join(stateDir, `strike-latch-${agent}`), { force: true })
}

// effectDrainCheck -- corroboration gate
//
// Returns true if agent has received at least one inter-agent message delivered
// within the last intervalSeconds. Returns false if idle or DB unreachable.
// Fail-open on error: a DB error returns false so it does NOT falsely confirm drain.
export function effectDrainCheck(
  agent: string,
  dbPath: string,
  intervalSeconds = 300,
): boolean {
  if (!existsSync(dbPath)) return false
  try {
    const db = new Database(dbPath, { readonly: true })
    const since = Math.floor(Date.now() / 1000) - intervalSeconds
    const row = db.prepare(
      'SELECT COUNT(*) AS cnt FROM agent_messages WHERE to_agent = ? AND delivered_at > ?',
    ).get(agent, since) as { cnt: number } | undefined
    db.close()
    return (row?.cnt ?? 0) > 0
  } catch {
    return false
  }
}

function safeReadInt(filePath: string): number {
  try {
    const v = parseInt(readFileSync(filePath, 'utf8').trim(), 10)
    return isNaN(v) ? 0 : v
  } catch {
    return 0
  }
}
