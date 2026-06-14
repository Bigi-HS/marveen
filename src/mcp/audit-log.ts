// SEC-AC4: every state-changing tool call appends one line to an append-only
// audit log at GOOGLE_CHANNEL_DIR/mcp-audit.log (0600, gitignored). Format:
//   ISO8601_UTC | tool_name | params_summary
//
// FAIL-LOUD on a missing audit surface: if the channel dir does not exist at
// startup the server MUST exit rather than run without an audit trail
// (irreversible ops must never fire un-audited). assertAuditDir() is called once
// at boot; appendAudit() is called by each write handler.
//
// PII boundary (SEC-AC2): params_summary MUST be metadata only (ids, label
// names, date ranges) -- NEVER email body / snippet / event description text.
// That contract lives at the call sites; this module just persists the string
// it is given.
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const AUDIT_LOG_BASENAME = 'mcp-audit.log'

// Throw if the audit directory is absent. Called at server startup so the
// process exits loudly instead of running without an audit trail.
export function assertAuditDir(channelDir: string): void {
  if (!channelDir || !existsSync(channelDir) || !statSync(channelDir).isDirectory()) {
    throw new Error(
      `FATAL: audit log dir missing at ${channelDir || '(unset GOOGLE_CHANNEL_DIR)'} ` +
        '-- refusing to run a write-capable Google MCP server without an audit trail',
    )
  }
}

// One audit line. `now` (epoch ms) is injected for deterministic tests.
export function formatAuditLine(now: number, toolName: string, paramsSummary: string): string {
  const ts = new Date(now).toISOString()
  // Keep the line single-row: collapse any CR/LF in the summary so one call is
  // always exactly one log line (no audit-line forging via embedded newlines).
  const safeSummary = paramsSummary.replace(/[\r\n]+/g, ' ')
  return `${ts} | ${toolName} | ${safeSummary}`
}

// Append one audit line (0600). The file is created on first write with mode
// 0600; the dir is asserted at startup so a missing dir here is an unexpected
// fault and propagates.
export function appendAudit(
  channelDir: string,
  now: number,
  toolName: string,
  paramsSummary: string,
): void {
  const path = join(channelDir, AUDIT_LOG_BASENAME)
  appendFileSync(path, formatAuditLine(now, toolName, paramsSummary) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  })
}
