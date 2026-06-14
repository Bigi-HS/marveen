// Single source of truth for the Claudia Google MCP server identity and its tool
// names. The ask-first guardrail (scripts/hooks/guardrail-ask-first.py) must
// register the EXACT namespaced name of the send tool; this module is the
// canonical definition that both the server and the cross-pin test read, so the
// guarded name and the served name cannot silently drift apart.

// The mcpServers key under which this server is wired into Claudia's .mcp.json.
// Deliberately spelled with only [a-z_] so Claude Code's tool namespacing applies
// NO character transform: the live tool name is exactly `mcp__<SERVER_KEY>__<tool>`.
// (A hyphenated key would be sanitized and the guarded string could drift.)
export const SERVER_KEY = 'claudia_google'

export const TOOL_CALENDAR_TODAY = 'calendar_today'
export const TOOL_GMAIL_SEND = 'gmail_send'

// How Claude Code namespaces an MCP tool: mcp__<server>__<tool>.
export function namespacedToolName(tool: string): string {
  return `mcp__${SERVER_KEY}__${tool}`
}

// The exact name the ask-first guardrail must guard. Kept in lockstep with
// GUARDED_TOOLS in scripts/hooks/guardrail-ask-first.py; the python test pins it
// and the deploy doc has a live `claude mcp`-roster verification step.
export const GUARDED_GMAIL_SEND = namespacedToolName(TOOL_GMAIL_SEND)
