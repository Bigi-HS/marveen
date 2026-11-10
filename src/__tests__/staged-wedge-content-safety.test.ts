/**
 * Tests for isSafeToAutoEnter (card 7e0b0cce, hardened in cf84e0a6 + 44ae9e4c).
 *
 * Risk: auto-Enter on unrecognized staged content submits wrong content to the
 * agent (Claudia 6h-wedge precedent 08-24). The safety gate only proceeds when a
 * STAGED LINE in the pane begins with a recognized injection prefix.
 *
 * Contract (fail-closed + line-scoped):
 *  - null / empty / whitespace -> false (ABSTAIN, fail-closed; card 44ae9e4c)
 *  - short content with no recognized prefix -> false (the old <=40 pass is gone)
 *  - a recognized prefix on its own line (possibly mid-pane, behind TUI chrome)
 *    -> true (line-scoped match; card cf84e0a6)
 *  - a prefix appearing mid-line, or unrecognized content -> false
 */

import { describe, it, expect } from 'vitest'
import { isSafeToAutoEnter } from '../web/staged-wedge-probe.js'

describe('isSafeToAutoEnter -- fail-closed on null / empty / short', () => {
  it('returns false for null (fail-closed: unreadable pane, card 44ae9e4c flag-1)', () => {
    expect(isSafeToAutoEnter(null)).toBe(false)
  })

  it('returns false for empty string (fail-closed)', () => {
    expect(isSafeToAutoEnter('')).toBe(false)
  })

  it('returns false for whitespace-only string (fail-closed)', () => {
    expect(isSafeToAutoEnter('   \n\t  ')).toBe(false)
  })

  it('returns false for a short string with no recognized prefix (card 44ae9e4c flag-2)', () => {
    expect(isSafeToAutoEnter('some short text')).toBe(false)
  })

  it('returns false for a 40-char string with no recognized prefix', () => {
    expect(isSafeToAutoEnter('a'.repeat(40))).toBe(false)
  })

  it('returns false for a 41-char string without recognized prefix', () => {
    expect(isSafeToAutoEnter('a'.repeat(41))).toBe(false)
  })
})

describe('isSafeToAutoEnter -- recognized injection prefixes -> true', () => {
  it('recognizes [Uzenet prefix (inter-agent message)', () => {
    const content = '[Uzenet]: alma-agensnek: Keres az ellenőrző rendszer eredményt.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Task prefix (task injection)', () => {
    expect(isSafeToAutoEnter('[Task abc123]: Process the kanban card update.')).toBe(true)
  })

  it('recognizes [Heartbeat prefix (scheduled heartbeat)', () => {
    expect(isSafeToAutoEnter('[Heartbeat: hb-001]: periodic state check.')).toBe(true)
  })

  it('recognizes [Scheduled prefix (scheduled task)', () => {
    expect(isSafeToAutoEnter('[Scheduled task-444]: Run the daily log summary.')).toBe(true)
  })

  it('recognizes [Inter-agent prefix', () => {
    expect(isSafeToAutoEnter('[Inter-agent from dave]: The build finished.')).toBe(true)
  })

  it('recognizes [Feladat prefix (Hungarian task injection)', () => {
    expect(isSafeToAutoEnter('[Feladat 7e0b0cce]: Implementáld a kaput.')).toBe(true)
  })

  it('is case-insensitive for prefixes', () => {
    expect(isSafeToAutoEnter('[UZENET]: something')).toBe(true)
    expect(isSafeToAutoEnter('[HEARTBEAT: xyz]: something')).toBe(true)
    expect(isSafeToAutoEnter('[TASK id]: something')).toBe(true)
    expect(isSafeToAutoEnter('[FELADAT 123]: something')).toBe(true)
  })
})

describe('isSafeToAutoEnter -- line-scoped match on a real pane (card cf84e0a6)', () => {
  it('accepts a recognized prefix on its own line mid-pane (the regression this card fixes)', () => {
    // Real capture: TUI chrome + status lines precede the staged input box, so the
    // injected message is NOT at the pane start. startsWith on the whole pane would
    // over-abstain; the line-scoped scan still finds the staged line.
    const pane = [
      '  marveen-session  •  esc to interrupt',
      '────────────────────────────────────────',
      'Some earlier assistant output scrolled above.',
      '> [Uzenet]: dave-agensnek: kerlek erositsd meg az allapotot most.',
      '────────────────────────────────────────',
      '  context: 42%   •   tokens: 128k',
    ].join('\n')
    expect(isSafeToAutoEnter(pane)).toBe(true)
  })

  it('accepts a prefix line behind box-border chrome', () => {
    const pane = '│ [Task 9f2]: process the next kanban lane card and report back. │'
    expect(isSafeToAutoEnter(pane)).toBe(true)
  })

  it('accepts when the staged line is preceded by blank lines and a prompt marker', () => {
    const pane = '\n\n  >  [Heartbeat: hb-77]: periodic check\n'
    expect(isSafeToAutoEnter(pane)).toBe(true)
  })
})

describe('isSafeToAutoEnter -- unrecognized content -> false (ABSTAIN)', () => {
  it('returns false for long unrecognized content (mid-draft user text)', () => {
    const content = 'Here is a long piece of content that the user was typing and never submitted.'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false for a code snippet staged in input', () => {
    const content = 'const result = await fetch("/api/kanban", { method: "POST" })'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false when a prefix appears mid-line (not at the start of the line)', () => {
    const content = 'I have a question about [Heartbeat: xyz] behavior and why it triggers recovery.'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false when prefix-like text is embedded mid-pane inside a prose line', () => {
    const pane = [
      'The user wrote a long explanation here about the system design and then',
      'mentioned [Task foo] somewhere in the middle of a sentence, not as a staged line.',
    ].join('\n')
    expect(isSafeToAutoEnter(pane)).toBe(false)
  })

  it('returns false for content starting with an unrecognized bracket tag', () => {
    expect(isSafeToAutoEnter('[Unknown tag]: should not be auto-submitted.')).toBe(false)
  })
})
