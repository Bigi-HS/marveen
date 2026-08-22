import { describe, it, expect } from 'vitest'
import { classifyMcpCall, parseMcpCallObservation, type McpCallObservation } from '../web/pipe-hang-detector.js'

const NOW = 1_700_000_000_000
const THRESH = 60_000 // 60s

describe('classifyMcpCall', () => {
  it("returns 'none' when the agent made no Telegram-MCP call", () => {
    const obs: McpCallObservation = { lastToolUse: null, resolvedIds: new Set() }
    expect(classifyMcpCall(obs, NOW, THRESH).state).toBe('none')
  })

  it("returns 'ok' when the latest call has a matching tool_result (resolved)", () => {
    const obs: McpCallObservation = { lastToolUse: { id: 't1', tsMs: NOW - 5 * 60_000 }, resolvedIds: new Set(['t1']) }
    // resolved long ago -> ok regardless of age
    expect(classifyMcpCall(obs, NOW, THRESH).state).toBe('ok')
  })

  it("returns 'ok' when the call is in-flight but YOUNGER than the threshold", () => {
    const obs: McpCallObservation = { lastToolUse: { id: 't1', tsMs: NOW - 10_000 }, resolvedIds: new Set() }
    expect(classifyMcpCall(obs, NOW, THRESH).state).toBe('ok')
  })

  it("returns 'hung' when an unresolved call is at/over the threshold", () => {
    const at = classifyMcpCall({ lastToolUse: { id: 't1', tsMs: NOW - THRESH }, resolvedIds: new Set() }, NOW, THRESH)
    expect(at.state).toBe('hung')
    expect(at.hungForMs).toBe(THRESH)
    expect(at.toolUseId).toBe('t1')
    const over = classifyMcpCall({ lastToolUse: { id: 't1', tsMs: NOW - 5 * 60_000 }, resolvedIds: new Set() }, NOW, THRESH)
    expect(over.state).toBe('hung')
  })

  it('judges only the LATEST call: an old resolved call does not mask a new hung one', () => {
    // lastToolUse is the newest (t2); t1 resolved is irrelevant.
    const obs: McpCallObservation = { lastToolUse: { id: 't2', tsMs: NOW - 2 * 60_000 }, resolvedIds: new Set(['t1']) }
    expect(classifyMcpCall(obs, NOW, THRESH).state).toBe('hung')
  })
})

describe('parseMcpCallObservation', () => {
  const tu = (id: string, name: string, ts: string) =>
    JSON.stringify({ timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
  const tr = (tid: string, ts: string) =>
    JSON.stringify({ timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'sent' }] } })

  it('records a Telegram-MCP tool_use and its resolving tool_result', () => {
    const jsonl = [
      tu('a1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:00:00Z'),
      tr('a1', '2026-06-07T16:00:02Z'),
    ].join('\n')
    const obs = parseMcpCallObservation(jsonl)
    expect(obs.lastToolUse?.id).toBe('a1')
    expect(obs.resolvedIds.has('a1')).toBe(true)
  })

  it('leaves an unresolved tool_use without a result (the hung signal)', () => {
    const jsonl = tu('a1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:00:00Z')
    const obs = parseMcpCallObservation(jsonl)
    expect(obs.lastToolUse?.id).toBe('a1')
    expect(obs.resolvedIds.has('a1')).toBe(false)
  })

  it('tracks the LATEST telegram tool_use across several calls', () => {
    const jsonl = [
      tu('a1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:00:00Z'),
      tr('a1', '2026-06-07T16:00:01Z'),
      tu('a2', 'mcp__plugin_telegram_telegram__react', '2026-06-07T16:05:00Z'),
    ].join('\n')
    const obs = parseMcpCallObservation(jsonl)
    expect(obs.lastToolUse?.id).toBe('a2')
    expect(obs.resolvedIds.has('a2')).toBe(false)
  })

  it('ignores non-telegram tool_use (e.g. Bash) entirely', () => {
    const jsonl = [
      tu('b1', 'Bash', '2026-06-07T16:00:00Z'),
      tu('t1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:01:00Z'),
    ].join('\n')
    const obs = parseMcpCallObservation(jsonl)
    expect(obs.lastToolUse?.id).toBe('t1')
  })

  it('tolerates malformed / non-JSON lines and non-array content', () => {
    const jsonl = [
      'not json',
      JSON.stringify({ message: { content: 'a string, not an array' } }),
      tu('t1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:00:00Z'),
    ].join('\n')
    const obs = parseMcpCallObservation(jsonl)
    expect(obs.lastToolUse?.id).toBe('t1')
  })

  it('parses the timestamp into ms for the hang age', () => {
    const obs = parseMcpCallObservation(tu('t1', 'mcp__plugin_telegram_telegram__reply', '2026-06-07T16:00:00Z'))
    expect(obs.lastToolUse?.tsMs).toBe(Date.parse('2026-06-07T16:00:00Z'))
  })
})
