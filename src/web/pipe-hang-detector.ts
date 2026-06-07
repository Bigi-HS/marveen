// Per-agent wedged-pipe HANG detector (card 31ab64fe Part 1).
//
// The gate spike (card 4525ff36) established that the real fleet-mute symptom is
// a WEDGED MCP socketpair: the agent's `claude` calls the Telegram `reply` tool,
// the request goes to a bun plugin child whose stdio is wedged, and the call
// HANGS -- it never returns a tool_result and never errors. Because there is no
// failure event, neither the dashboard's in-process channel-health-monitor
// (pane-✘ / poller-missing) nor the 409 conflict probe (Part 2) nor a
// PostToolUseFailure hook can see it. The ONLY observable signal is the agent's
// own transcript: an MCP tool_use with NO matching tool_result for a long time.
//
// This module reads that signal. A watchdog tick calls readAgentHangState(name)
// and, on a 'hung' verdict, drives /mcp recovery (attemptChannelMcpReconnect) --
// the same recovery the rest of the fleet uses. Pure functions are exported and
// unit-tested; the only IO is reading the agent's latest session transcript.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, readAgentClaudeConfigDir } from './agent-config.js'
import { projectsDirFor } from './active-model.js'

// Any Telegram MCP tool (reply / react / edit_message / download_attachment).
// A wedged socketpair hangs ALL of them, so match the provider prefix, not just
// `reply`. Kept provider-flexible (telegram) but anchored on the mcp__ namespace.
const TELEGRAM_MCP_TOOL_RX = /^mcp__.*telegram.*/i

export type HangState = 'ok' | 'hung' | 'none'

export interface McpCallObservation {
  // The most recent Telegram-MCP tool_use, or null if none in the transcript.
  lastToolUse: { id: string; tsMs: number } | null
  // tool_use ids that already have a matching tool_result (resolved calls).
  resolvedIds: Set<string>
}

export interface HangVerdict {
  state: HangState
  hungForMs: number
  toolUseId: string | null
}

// Pure verdict. 'hung' ONLY when the latest Telegram-MCP tool_use has no result
// AND has been outstanding for >= hangThresholdMs. A resolved call, or one still
// young (in-flight but under the threshold), is 'ok' -- the watchdog must not
// /mcp a call that simply has not returned yet. 'none' = the agent has made no
// Telegram-MCP call at all (nothing to judge).
export function classifyMcpCall(
  obs: McpCallObservation,
  nowMs: number,
  hangThresholdMs: number,
): HangVerdict {
  const tu = obs.lastToolUse
  if (!tu) return { state: 'none', hungForMs: 0, toolUseId: null }
  if (obs.resolvedIds.has(tu.id)) return { state: 'ok', hungForMs: 0, toolUseId: tu.id }
  const outstanding = nowMs - tu.tsMs
  if (outstanding >= hangThresholdMs) return { state: 'hung', hungForMs: outstanding, toolUseId: tu.id }
  return { state: 'ok', hungForMs: 0, toolUseId: tu.id }
}

function tsMsOf(entry: unknown): number {
  if (entry && typeof entry === 'object' && 'timestamp' in entry) {
    const t = (entry as { timestamp?: unknown }).timestamp
    if (typeof t === 'string') {
      const ms = Date.parse(t)
      if (!Number.isNaN(ms)) return ms
    }
  }
  return 0
}

// Pure parse of a transcript's JSONL content into an observation. Walks every
// line, records the latest Telegram-MCP tool_use (by transcript order) and the
// set of tool_use ids that have a tool_result. Exported for unit tests.
export function parseMcpCallObservation(jsonlContent: string): McpCallObservation {
  let lastToolUse: { id: string; tsMs: number } | null = null
  const resolvedIds = new Set<string>()
  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue
    let o: unknown
    try { o = JSON.parse(line) } catch { continue }
    if (!o || typeof o !== 'object') continue
    const message = (o as { message?: unknown }).message
    const content = message && typeof message === 'object'
      ? (message as { content?: unknown }).content
      : undefined
    if (!Array.isArray(content)) continue
    const ts = tsMsOf(o)
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const type = (c as { type?: unknown }).type
      if (type === 'tool_use') {
        const name = (c as { name?: unknown }).name
        const id = (c as { id?: unknown }).id
        if (typeof name === 'string' && typeof id === 'string' && TELEGRAM_MCP_TOOL_RX.test(name)) {
          lastToolUse = { id, tsMs: ts }
        }
      } else if (type === 'tool_result') {
        const tid = (c as { tool_use_id?: unknown }).tool_use_id
        if (typeof tid === 'string') resolvedIds.add(tid)
      }
    }
  }
  return { lastToolUse, resolvedIds }
}

function latestTranscriptPath(agentName: string): string | null {
  try {
    const dir = projectsDirFor(agentDir(agentName), readAgentClaudeConfigDir(agentName) ?? undefined)
    if (!existsSync(dir)) return null
    const jsonls = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return jsonls.length ? join(dir, jsonls[0].f) : null
  } catch {
    return null
  }
}

// IO: read the agent's latest session transcript and classify its newest
// Telegram-MCP call. Returns 'none' if the transcript is missing/unreadable
// (fail-safe: never report a hang we cannot substantiate).
export function readAgentHangState(
  agentName: string,
  nowMs: number,
  hangThresholdMs: number,
): HangVerdict {
  const path = latestTranscriptPath(agentName)
  if (!path) return { state: 'none', hungForMs: 0, toolUseId: null }
  let content: string
  try { content = readFileSync(path, 'utf-8') } catch { return { state: 'none', hungForMs: 0, toolUseId: null } }
  return classifyMcpCall(parseMcpCallObservation(content), nowMs, hangThresholdMs)
}
