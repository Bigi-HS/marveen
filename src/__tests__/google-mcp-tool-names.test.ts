import { describe, it, expect } from 'vitest'
import {
  SERVER_KEY,
  TOOL_CALENDAR_TODAY,
  TOOL_GMAIL_SEND,
  namespacedToolName,
  GUARDED_GMAIL_SEND,
} from '../mcp/tool-names.js'

// Cross-pin: the guarded send-tool string the python guardrail registers MUST
// equal the name this server actually serves. If anyone renames the server key
// or the tool, this breaks and forces the guardrail to be updated in lockstep.
describe('Claudia Google MCP tool names', () => {
  it('server key is transform-free ([a-z_] only)', () => {
    expect(SERVER_KEY).toMatch(/^[a-z_]+$/)
  })

  it('namespaces tools as mcp__<server>__<tool>', () => {
    expect(namespacedToolName(TOOL_CALENDAR_TODAY)).toBe('mcp__claudia_google__calendar_today')
    expect(namespacedToolName(TOOL_GMAIL_SEND)).toBe('mcp__claudia_google__gmail_send')
  })

  it('pins the exact guarded gmail-send name (must match GUARDED_TOOLS in the python hook)', () => {
    expect(GUARDED_GMAIL_SEND).toBe('mcp__claudia_google__gmail_send')
  })
})
