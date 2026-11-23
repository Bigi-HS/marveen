// Card 930bba69 AC-P2a: reply-hook observe-phase tests.
//
// reply-hook.ts is a pure dry-run observer: it computes what sanitizeCardIds
// WOULD substitute on a Boss-facing reply payload but NEVER modifies the output.
// Behaviour is gated by OPS151_REPLY_HOOK env flag (default OFF).
//
// AC-P2a-1: flag ON  -> 1 JSONL WARN per call, ops151.reply-hook prefix
// AC-P2a-2: flag OFF -> pure passthrough, zero WARN lines, bit-identical output

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CardCodeResolver } from '../web/routes/notify-sanitize.js'

// ----- logger mock --------------------------------------------------------
// vi.mock must be hoisted; actual spy captured in warnSpy below.
// Path is relative to THIS file (src/__tests__/), resolving to src/logger.ts --
// same absolute module that reply-hook.ts imports with '../../logger.js'.
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { logger } from '../logger.js'
import { observeReplyPayload } from '../web/routes/reply-hook.js'

const warnSpy = vi.mocked(logger.warn)

// Fixture resolver:
//   930bba69 -> known card with code ENG-042   (fixture a)
//   feedcafe -> known card with NO code          (fixture b)
//   deadbeef -> unknown (non-card hex / git SHA) (fixture c)
const resolve: CardCodeResolver = (id) => {
  if (id === '930bba69') return { code: 'ENG-042' }
  if (id === 'feedcafe') return { code: null }
  return null
}

function setFlag(val: string | undefined): void {
  if (val === undefined) {
    delete process.env.OPS151_REPLY_HOOK
  } else {
    process.env.OPS151_REPLY_HOOK = val
  }
}

beforeEach(() => {
  warnSpy.mockClear()
})

afterEach(() => {
  delete process.env.OPS151_REPLY_HOOK
})

// --------------------------------------------------------------------------
// FLAG OFF (default) -- AC-P2a-2
// --------------------------------------------------------------------------
describe('observeReplyPayload -- flag OFF (default)', () => {
  it('AC-P2a-2: returns text bit-identical (no env var set)', () => {
    const text = 'Card 930bba69 ready'
    expect(observeReplyPayload(text, resolve)).toBe(text)
  })

  it('AC-P2a-2: returns text bit-identical (flag explicitly "0")', () => {
    setFlag('0')
    const text = 'Card 930bba69 ready'
    expect(observeReplyPayload(text, resolve)).toBe(text)
  })

  it('AC-P2a-2: emits ZERO warn log lines when flag is off', () => {
    const text = 'Card 930bba69 ready'
    observeReplyPayload(text, resolve)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('AC-P2a-2: no log even when text has multiple known card-ids', () => {
    observeReplyPayload('930bba69 / feedcafe / deadbeef', resolve)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('fixture (c) OFF: non-card hex returns unchanged, no warn', () => {
    const text = 'Fixed in deadbeef on develop'
    expect(observeReplyPayload(text, resolve)).toBe(text)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------------------
// FLAG ON -- AC-P2a-1
// --------------------------------------------------------------------------
describe('observeReplyPayload -- flag ON (OPS151_REPLY_HOOK=1)', () => {
  beforeEach(() => setFlag('1'))

  it('AC-P2a-1: fixture (a) known-card-id -> emits exactly one WARN log', () => {
    observeReplyPayload('Card 930bba69 is ready', resolve)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('AC-P2a-1: WARN log has ops151.reply-hook type prefix', () => {
    observeReplyPayload('Card 930bba69', resolve)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(obj).toMatchObject({ type: 'ops151.reply-hook' })
  })

  it('fixture (a): known card-id noted as substitution candidate with ENG-NNN code', () => {
    observeReplyPayload('Card 930bba69 is ready', resolve)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    // candidates must include the token and its would-be replacement
    expect(obj).toMatchObject({
      candidate_count: 1,
    })
    const candidates = obj.candidates as Array<{ token: string; would_become: string }>
    expect(candidates).toHaveLength(1)
    expect(candidates[0].token.toLowerCase()).toBe('930bba69')
    expect(candidates[0].would_become).toBe('ENG-042')
  })

  it('fixture (b): known-id null-code -> would_become is placeholder, NEVER raw hex', () => {
    observeReplyPayload('See feedcafe for detail', resolve)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    const candidates = obj.candidates as Array<{ token: string; would_become: string }>
    expect(candidates).toHaveLength(1)
    expect(candidates[0].token.toLowerCase()).toBe('feedcafe')
    // must not log the raw id as the replacement; must use placeholder
    expect(candidates[0].would_become).not.toBe('feedcafe')
    expect(candidates[0].would_become).not.toMatch(/^[0-9a-f]{8}$/)
    expect(candidates[0].would_become).toBeTruthy()
  })

  it('fixture (c): git-SHA / non-card hex -> NOT noted, candidate_count=0', () => {
    observeReplyPayload('Fixed in deadbeef on develop', resolve)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect((obj.candidates as unknown[]).length).toBe(0)
    expect(obj.candidate_count).toBe(0)
  })

  it('output is bit-identical to input even when candidates found (observe only)', () => {
    const text = 'Card 930bba69 is ready'
    const out = observeReplyPayload(text, resolve)
    expect(out).toBe(text)
  })

  it('logs exactly one WARN per call regardless of candidate count', () => {
    observeReplyPayload('930bba69 / feedcafe / deadbeef', resolve)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    // 2 known cards (930bba69 + feedcafe); deadbeef not noted
    expect(obj.candidate_count).toBe(2)
  })

  it('no-candidate call: still logs one WARN (flag on = always observe)', () => {
    observeReplyPayload('no hex here', resolve)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [obj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(obj.candidate_count).toBe(0)
  })

  it('parse_mode does not affect output (always passthrough)', () => {
    const text = 'Card 930bba69 ready'
    expect(observeReplyPayload(text, resolve, 'MarkdownV2')).toBe(text)
    expect(observeReplyPayload(text, resolve, 'HTML')).toBe(text)
  })
})
