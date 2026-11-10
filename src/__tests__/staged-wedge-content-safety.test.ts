/**
 * Tests for isSafeToAutoEnter (card 7e0b0cce).
 *
 * Risk: auto-Enter on unrecognized staged content submits wrong content to the
 * agent (Claudia 6h-wedge precedent 08-24). The safety gate prevents this by
 * checking that pane content looks like an injected task/heartbeat/inter-agent
 * message before we fire the recovery Enter.
 */

import { describe, it, expect } from 'vitest'
import { isSafeToAutoEnter } from '../web/staged-wedge-probe.js'

describe('isSafeToAutoEnter -- null / empty / short inputs', () => {
  it('returns true for null (no staged content)', () => {
    expect(isSafeToAutoEnter(null)).toBe(true)
  })

  it('returns true for empty string', () => {
    expect(isSafeToAutoEnter('')).toBe(true)
  })

  it('returns true for whitespace-only string', () => {
    expect(isSafeToAutoEnter('   \n\t  ')).toBe(true)
  })

  it('returns true for a short string under 40 chars (trimmed)', () => {
    expect(isSafeToAutoEnter('some short text')).toBe(true)
  })

  it('returns true for a string exactly 40 chars (boundary)', () => {
    expect(isSafeToAutoEnter('a'.repeat(40))).toBe(true)
  })

  it('returns false for a string of 41 chars without recognized prefix', () => {
    expect(isSafeToAutoEnter('a'.repeat(41))).toBe(false)
  })
})

describe('isSafeToAutoEnter -- recognized injection prefixes -> true', () => {
  it('recognizes [Uzenet prefix (inter-agent message)', () => {
    const content = '[Uzenet]: alma-agensnek: Keres az ellenőrző rendszer eredményt. Az aktuális feladat feldolgozása folyamatban van, kérlek erősítsd meg.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Task prefix (task injection)', () => {
    const content = '[Task abc123]: Process the following kanban card update and report back to the orchestrator with status.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Heartbeat prefix (scheduled heartbeat)', () => {
    const content = '[Heartbeat: hb-task-001]: This is a periodic heartbeat message to check the agent state and connectivity.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Scheduled prefix (scheduled task)', () => {
    const content = '[Scheduled task-444]: Run the daily log summary and push results to the memory tier cold storage.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Inter-agent prefix', () => {
    const content = '[Inter-agent from dave]: The build finished successfully. All tests pass. PR is ready for review.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('recognizes [Feladat prefix (Hungarian task injection)', () => {
    const content = '[Feladat 7e0b0cce]: Implementáld a tartalom-biztonsági kaput a staged-input wedge visszaállítóban.'
    expect(isSafeToAutoEnter(content)).toBe(true)
  })

  it('is case-insensitive for prefixes', () => {
    expect(isSafeToAutoEnter('[UZENET]: something long enough to exceed the forty character limit here')).toBe(true)
    expect(isSafeToAutoEnter('[HEARTBEAT: xyz]: something long enough to exceed the forty character limit here')).toBe(true)
    expect(isSafeToAutoEnter('[TASK id]: something long enough to exceed the forty character limit here')).toBe(true)
    expect(isSafeToAutoEnter('[FELADAT 123]: something long enough to exceed the forty character limit here')).toBe(true)
  })
})

describe('isSafeToAutoEnter -- unrecognized long content -> false (ABSTAIN)', () => {
  it('returns false for long unrecognized content (Claudia 6h-wedge precedent: mid-draft text)', () => {
    const content = 'Here is a long piece of content that the user was typing and never submitted to the agent, which should not be auto-submitted by the recovery path.'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false for a long code snippet staged in input', () => {
    const content = 'const result = await fetch("/api/kanban", { method: "POST", body: JSON.stringify({ title: "test card", status: "planned" }) })'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false when prefix-like text appears mid-string (not at start)', () => {
    const content = 'I have a question about [Heartbeat: xyz] behavior and why it triggers the recovery path in some edge cases.'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })

  it('returns false for long content starting with an unrecognized bracket tag', () => {
    const content = '[Unknown tag]: This should not be auto-submitted because it has an unrecognized bracket prefix.'
    expect(isSafeToAutoEnter(content)).toBe(false)
  })
})
