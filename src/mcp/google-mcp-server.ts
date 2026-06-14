#!/usr/bin/env node
// Claudia Google MCP server (stdio). Wires two tools into Claudia's Claude Code
// session, each backed by its own minimal-scope OAuth token:
//   - calendar_today (scope calendar.events.readonly) -- read-only
//   - gmail_send     (scope gmail.send)               -- ask-first GUARDED
//
// This is a LOCAL stdio server (like the Telegram MCP), independent of the
// claude.ai account-connector AND the env OAuth token, so it is immune to
// connector-masking. Egress is restricted to *.googleapis.com (oauth2 / www /
// gmail) -- see the URL constants in the sibling modules. The refresh token is
// loaded from GOOGLE_CHANNEL_DIR/oauth-tokens.json (0600, gitignored), written
// once by scripts/google-oauth-authorize.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AccessTokenProvider, loadGoogleCreds } from './google-oauth.js'
import { listTodayEvents, type CalendarEvent } from './google-calendar.js'
import { buildRawMessage, sendEmail } from './gmail-send.js'
import { SERVER_KEY, TOOL_CALENDAR_TODAY, TOOL_GMAIL_SEND } from './tool-names.js'

// Where the OAuth creds + refresh token live. Passed explicitly via the .mcp.json
// `env` so the server binary stays path-agnostic.
const CHANNEL_DIR = process.env.GOOGLE_CHANNEL_DIR ?? ''

// Lazily build the token provider on first tool use, so the server can start
// (and advertise its tools) even before the token file exists; only the actual
// call fails, with a clear message.
let provider: AccessTokenProvider | null = null
async function getToken(): Promise<string> {
  if (!provider) {
    if (!CHANNEL_DIR) {
      throw new Error('GOOGLE_CHANNEL_DIR env is not set (point it at the channels/google dir)')
    }
    const creds = await loadGoogleCreds(CHANNEL_DIR)
    provider = new AccessTokenProvider(creds)
  }
  return provider.get()
}

function formatEvent(e: CalendarEvent): string {
  const when = e.allDay ? `${e.start} (all day)` : `${e.start} - ${e.end}`
  const loc = e.location ? ` @ ${e.location}` : ''
  return `- ${when}: ${e.summary}${loc}`
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_KEY, version: '1.0.0' })

  server.registerTool(
    TOOL_CALENDAR_TODAY,
    {
      description:
        "List today's Google Calendar events (Europe/Budapest, primary calendar). Read-only.",
      inputSchema: {},
    },
    async () => {
      const events = await listTodayEvents(await getToken(), Date.now())
      const text =
        events.length === 0 ? 'No events today.' : events.map(formatEvent).join('\n')
      return textResult(text)
    },
  )

  server.registerTool(
    TOOL_GMAIL_SEND,
    {
      description:
        'Send an email via Gmail (scope gmail.send). ASK-FIRST GUARDED: this is an ' +
        'irreversible external action and requires explicit human approval before it runs.',
      inputSchema: {
        to: z.string().describe('recipient email address'),
        subject: z.string().describe('email subject'),
        body: z.string().describe('plain-text email body'),
        cc: z.string().optional().describe('optional Cc address'),
      },
    },
    async ({ to, subject, body, cc }) => {
      const raw = buildRawMessage({ to, subject, body, cc })
      const id = await sendEmail(await getToken(), raw)
      return textResult(`Sent. Gmail message id: ${id}`)
    },
  )

  return server
}

async function main(): Promise<void> {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Run only when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  main().catch((err) => {
    // stderr only -- stdout is the MCP protocol channel.
    console.error('[claudia-google-mcp] fatal:', err)
    process.exit(1)
  })
}
