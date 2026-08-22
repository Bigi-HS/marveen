#!/usr/bin/env tsx
// One-time OAuth authorization for Claudia's Google MCP (Part B). Turns a
// Desktop-app OAuth client into a long-lived refresh token via the loopback
// flow, and writes it 0600 to the channel dir. Run once, with Dominik at the
// browser:
//
//   tsx scripts/google-oauth-authorize.ts \
//     --client store/claudia-oauth-client.json \
//     --out agents/claudia/.claude/channels/google
//
// Steps: read the client JSON -> print a consent URL -> Dominik opens it and
// approves (Calendar read + Gmail send) -> Google redirects to localhost where
// this script captures the code -> exchange for a refresh token -> persist 0600.
// No secret is ever printed; only the consent URL (which carries no secret) is.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  parseClientJson,
  buildAuthUrl,
  exchangeCodeForTokens,
  awaitLoopbackCode,
  generateState,
  SCOPES,
} from '../src/mcp/google-authorize.js'

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const CLIENT_PATH = resolve(arg('--client', 'store/claudia-oauth-client.json'))
const OUT_DIR = resolve(arg('--out', 'agents/claudia/.claude/channels/google'))
const PORT = Number(arg('--port', '4117'))
const REDIRECT_URI = `http://localhost:${PORT}/`

async function main(): Promise<void> {
  const client = parseClientJson(await readFile(CLIENT_PATH, 'utf-8'))
  // SEC-042: bind the nonce into the consent URL and require it back on the
  // redirect. The receiver (shared helper) listens on loopback only.
  const state = generateState()
  const authUrl = buildAuthUrl(client.clientId, REDIRECT_URI, SCOPES, state)

  console.error('\nOpen this URL in your browser and approve the two permissions')
  console.error('(Calendar read-only + Gmail send). "Google hasn\'t verified this app"')
  console.error('is expected -> Advanced -> Go to Claudia MCP (unsafe).\n')
  console.error(authUrl)
  console.error(`\nScopes requested: ${SCOPES.join('  ')}\n`)

  const code = await awaitLoopbackCode({
    port: PORT,
    redirectUri: REDIRECT_URI,
    expectedState: state,
  })
  const { refreshToken } = await exchangeCodeForTokens(client, code, REDIRECT_URI)

  await mkdir(OUT_DIR, { recursive: true })
  const outFile = join(OUT_DIR, 'oauth-tokens.json')
  await writeFile(
    outFile,
    JSON.stringify(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  await chmod(outFile, 0o600)

  console.error(`\nRefresh token stored 0600 at: ${outFile}`)
  console.error(`Now DELETE the open client file: ${CLIENT_PATH}`)
  console.error('(its secret is captured; do not leave it lying around).\n')
}

main().catch((err) => {
  console.error('[google-oauth-authorize] failed:', err.message ?? err)
  process.exit(1)
})
