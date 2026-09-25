// GET /api/agent-checkpoint/:agent/replay -- S3 crash-gated checkpoint replay
// + the DEDUP / COMBINED-BUDGET contract (the whole slice's correctness).
//
// The checkpoint is a SUPERSET of the S2 task-state. On a crash-resume its
// lastTurns OVERLAPS the ledger-replay window -- both carry the most-recent
// turns. They must NOT stack. When the checkpoint injection carries a
// recent-turns window it stamps a one-boot ledger-suppression marker that the
// ledger-replay hook consumes to skip its own window that boot; and the
// checkpoint's lastTurns block is char-capped so the COMBINED SessionStart
// continuity budget stays within ~5-6k.
//
// FLAG-GATED ON BOTH SIDES (S1 gate mirrored): the read path is active only when
// store/session-end-marker.enabled exists, so a deploy while the flag is OFF
// cannot false-resume a clean restart, and S1+S2+S3 co-activate on one flag-touch.

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgentCheckpoint } from '../web/routes/agent-checkpoint.js'
import {
  writeCheckpoint,
  clearCheckpoint,
  isLedgerSuppressed,
  consumeLedgerSuppressed,
  CHECKPOINT_LAST_TURNS_CHAR_CAP,
  applyCheckpointMigrations,
  type TurnPair,
} from '../web/agent-checkpoint.js'
import { stampCleanShutdown } from '../web/shutdown-marker.js'
import type { RouteContext } from '../web/routes/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const AGENT = 'vitest-cp-dedup-agent'
const MARKER_PATH = join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${AGENT}.shutdown`)
const SUPPRESS_PATH = join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${AGENT}.ledger-suppressed`)

// The route resolves via getNoaDb(); ensure the live default DB carries the
// table so writeCheckpoint's mirror + resolveCheckpoint fallback do not throw.
applyCheckpointMigrations()

// Inject an ISOLATED flag instead of the global store/session-end-marker.enabled
// file, so this file never races that global with the S2 route-test file under
// vitest's parallel workers. `flagOn` is flipped per test to arm/disarm the gate.
let flagOn = false
const DEPS = { flagEnabled: () => flagOn }
function armFlag(): void { flagOn = true }
function cleanup(): void {
  flagOn = false
  clearCheckpoint(AGENT)
  consumeLedgerSuppressed(AGENT)
  try { if (existsSync(MARKER_PATH)) unlinkSync(MARKER_PATH) } catch { /* */ }
  try { if (existsSync(SUPPRESS_PATH)) unlinkSync(SUPPRESS_PATH) } catch { /* */ }
}
afterEach(cleanup)

function makeReplayCtx(agent: string, source: string): { ctx: RouteContext; captured: { status: number; body: string } } {
  const captured = { status: 200, body: '' }
  const req = { method: 'GET', headers: {} } as unknown as IncomingMessage
  const res = {
    writeHead(status: number) { captured.status = status },
    end(data: string) { captured.body = data },
  } as unknown as ServerResponse
  const path = `/api/agent-checkpoint/${agent}/replay`
  const url = new URL(`http://localhost${path}?source=${encodeURIComponent(source)}`)
  const ctx: RouteContext = { req, res, path, method: 'GET', url, identity: null as never }
  return { ctx, captured }
}

function armCheckpoint(turns: TurnPair[] = [{ in: 'build S3', out: 'writing the module' }]): void {
  writeCheckpoint(AGENT, { focus: 'shipping S3', summary: 'checkpoint slice', nextAction: 'open the PR', lastTurns: turns }, Date.now())
}

describe('checkpoint /replay -- crash-gate (flag ON)', () => {
  it('crash (absent marker) + fresh checkpoint + startup -> non-null additionalContext', async () => {
    armFlag(); armCheckpoint()
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    expect(await tryHandleAgentCheckpoint(ctx, DEPS)).toBe(true)
    const parsed = JSON.parse(captured.body)
    expect(parsed.additionalContext).not.toBeNull()
    expect(parsed.additionalContext).toContain('open the PR')
  })

  it('clean marker + startup -> null (normal boot must not resume)', async () => {
    armFlag(); armCheckpoint()
    stampCleanShutdown(AGENT, Date.now())
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(JSON.parse(captured.body).additionalContext).toBeNull()
  })
})

describe('checkpoint /replay -- flag OFF => deploy-inert', () => {
  it('startup + absent marker + flag OFF -> null (no false-resume)', async () => {
    armCheckpoint()
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(JSON.parse(captured.body).additionalContext).toBeNull()
  })

  it('startup + flag OFF -> does NOT consume/touch the marker', async () => {
    armCheckpoint()
    stampCleanShutdown(AGENT, Date.now())
    expect(existsSync(MARKER_PATH)).toBe(true)
    const { ctx } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(existsSync(MARKER_PATH)).toBe(true)
  })

  it('startup + flag OFF -> does NOT stamp the ledger-suppression marker', async () => {
    armCheckpoint()
    const { ctx } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(isLedgerSuppressed(AGENT)).toBe(false)
  })
})

// -------------------------------------------------------------------------
// THE dedup / combined-budget contract
// -------------------------------------------------------------------------
describe('checkpoint /replay -- DEDUP + COMBINED-BUDGET (crash-resume)', () => {
  it('injects the recent-turns window ONCE and stamps the ledger suppression marker', async () => {
    armFlag()
    // A checkpoint carrying a recent-turns window (== the ledger overlap).
    armCheckpoint([
      { in: 'do the thing', out: 'starting' },
      { in: 'status?', out: 'halfway' },
    ])
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    const parsed = JSON.parse(captured.body)
    // (1) the recent-turns window is present exactly once in the checkpoint inject
    expect(parsed.additionalContext).toContain('LEGUTOBBI FORDULOK')
    expect((parsed.additionalContext.match(/LEGUTOBBI FORDULOK/g) || []).length).toBe(1)
    // (2) the suppression marker is stamped so the ledger hook skips its window
    expect(isLedgerSuppressed(AGENT)).toBe(true)
  })

  it('stays within the combined budget: the checkpoint lastTurns block is char-capped', async () => {
    armFlag()
    // A pathologically chatty recent window -- far over the cap.
    const huge: TurnPair[] = Array.from({ length: 6 }, (_, i) => ({ in: `q${i}`, out: 'Z'.repeat(4000) }))
    armCheckpoint(huge)
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    const inject = JSON.parse(captured.body).additionalContext as string
    // The whole injection stays within the combined ~5-6k envelope: the lastTurns
    // slice is capped at ~4k, the structured fields are short one-liners.
    expect(inject.length).toBeLessThanOrEqual(CHECKPOINT_LAST_TURNS_CHAR_CAP + 2000)
  })

  it('a checkpoint with NO lastTurns does NOT suppress the ledger window', async () => {
    armFlag()
    // Task-state-only checkpoint (no recent turns) -> the ledger window is the
    // only source of recent turns, so it must NOT be suppressed.
    writeCheckpoint(AGENT, { summary: 'no-turns', nextAction: 'go', lastTurns: [] }, Date.now())
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(JSON.parse(captured.body).additionalContext).not.toBeNull()
    expect(isLedgerSuppressed(AGENT)).toBe(false)
  })

  it('single-consume: after consume, a 2nd startup replay yields null (no re-inject)', async () => {
    armFlag(); armCheckpoint()
    // first crash-resume replay
    const first = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(first.ctx, DEPS)
    expect(JSON.parse(first.captured.body).additionalContext).not.toBeNull()
    // hook then consumes
    const consumeReq = { method: 'POST', headers: {} } as unknown as IncomingMessage
    const consumeRes = { writeHead() {}, end() {} } as unknown as ServerResponse
    const consumePath = `/api/agent-checkpoint/${AGENT}/consume`
    await tryHandleAgentCheckpoint({ req: consumeReq, res: consumeRes, path: consumePath, method: 'POST', url: new URL(`http://localhost${consumePath}`), identity: null as never }, DEPS)
    // second startup (marker absent again => crash), but the record is consumed
    const second = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentCheckpoint(second.ctx, DEPS)
    expect(JSON.parse(second.captured.body).additionalContext).toBeNull()
  })
})

describe('checkpoint /replay -- compact/resume unaffected by the crash-gate', () => {
  it('compact still replays regardless of a clean marker', async () => {
    armFlag(); armCheckpoint()
    stampCleanShutdown(AGENT, Date.now())
    const { ctx, captured } = makeReplayCtx(AGENT, 'compact')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(JSON.parse(captured.body).additionalContext).not.toBeNull()
  })

  it('compact does NOT consume the shutdown marker', async () => {
    armFlag(); armCheckpoint()
    stampCleanShutdown(AGENT, Date.now())
    const { ctx } = makeReplayCtx(AGENT, 'compact')
    await tryHandleAgentCheckpoint(ctx, DEPS)
    expect(existsSync(MARKER_PATH)).toBe(true)
  })
})
