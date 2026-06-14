# Claudia Google MCP server

A local stdio MCP server giving the Claudia agent two minimal-scope Google
capabilities, wired into her Claude Code session like the Telegram MCP. It runs
as a local process with its OWN OAuth refresh token, independent of the
claude.ai account-connector and of the env OAuth token, so it is immune to
connector-masking (card 5bd18a7e).

## Tools

| Tool (namespaced)                     | Scope                          | Effect    | Ask-first |
|---------------------------------------|--------------------------------|-----------|-----------|
| `mcp__claudia_google__calendar_today` | `calendar.events.readonly`     | read-only | no        |
| `mcp__claudia_google__gmail_send`     | `gmail.send`                   | sends mail| **YES**   |

- `calendar_today` lists today's events from the primary calendar in
  Europe/Budapest (DST-correct day bounds). No write.
- `gmail_send` sends an email (no inbox read). It is registered in the ask-first
  guardrail (`scripts/hooks/guardrail-ask-first.py` `GUARDED_TOOLS`): Claudia can
  never send without an explicit human approval routed through marveen (Genesis).

The exact guarded tool name is defined once in `tool-names.ts`
(`GUARDED_GMAIL_SEND`) and cross-pinned by `src/__tests__/google-mcp-tool-names.test.ts`
and `scripts/__tests__/guardrail-gmail-send.test.py`, so the served name and the
guarded name cannot drift.

## Security model (Chad review surface)

- **Scopes** are minimal and split: read-only calendar, send-only gmail. No
  `calendar` write, no `gmail.readonly`, no broad scope. (A future tutor-loop
  calendar write would be a separate scope + its own ask-first registration.)
- **Token storage**: the refresh token + client secret live ONLY at
  `agents/claudia/.claude/channels/google/oauth-tokens.json`, mode `0600`,
  gitignored (`.gitignore` `.claude/`). Never logged, never committed. The
  authorize script prints only the consent URL (no secret) to stderr.
- **Egress** is restricted to `*.googleapis.com`: `oauth2.googleapis.com` (token),
  `www.googleapis.com` (calendar), `gmail.googleapis.com` (send). Every outbound
  URL is a literal constant in the source (`OAUTH_TOKEN_URL`, `CALENDAR_EVENTS_URL`,
  `GMAIL_SEND_URL`); there is no dynamic host construction.
- **MCP stdout discipline**: the server writes only the protocol on stdout; all
  diagnostics go to stderr.

## One-time setup

1. **Google side (Dominik)** -- see `store/claudia-google-mcp-setup.md`: a
   dedicated Cloud project, Calendar + Gmail APIs enabled, OAuth consent screen
   External + himself as test user, a Desktop-app OAuth client. He hands over the
   client JSON at `store/claudia-oauth-client.json`.

2. **Authorize (Part B, Dave + Dominik)**:
   ```
   tsx scripts/google-oauth-authorize.ts \
     --client store/claudia-oauth-client.json \
     --out agents/claudia/.claude/channels/google
   ```
   Opens a consent URL; Dominik approves; the refresh token is written 0600.
   Then DELETE `store/claudia-oauth-client.json`.

## Deploy (Genesis-GO, after merge + build)

1. Build on the live repo: `npm run build` (emits `dist/mcp/google-mcp-server.js`).
2. Wire the server into Claudia's (gitignored) `agents/claudia/.mcp.json`:
   ```json
   {
     "mcpServers": {
       "claudia_google": {
         "command": "node",
         "args": ["/home/domin/marveen/dist/mcp/google-mcp-server.js"],
         "env": {
           "GOOGLE_CHANNEL_DIR": "/home/domin/marveen/agents/claudia/.claude/channels/google"
         }
       }
     }
   }
   ```
   The server key MUST be `claudia_google` (it determines the namespaced tool
   name the guardrail guards).
3. Restart Claudia so she picks up the MCP server.
4. **Verify the live tool name** before trusting the guard: in Claudia's session
   run `claude mcp list` (or inspect her tool roster) and confirm the send tool
   is exactly `mcp__claudia_google__gmail_send`. If the live namespacing differs,
   update `GUARDED_TOOLS` (and `tool-names.ts`) to match BEFORE relying on send.
5. Smoke: `calendar_today` returns today's events; a `gmail_send` attempt blocks
   on ask-first and routes an approval request to marveen.
