#!/usr/bin/env tsx
// One-time OAuth authorization for the YouTube upload script (card da367d95).
// Turns a Desktop-app OAuth client into a long-lived refresh token via the
// loopback flow and writes it 0600 to the channel dir. Run once, with Dominik
// at the browser:
//
//   tsx scripts/youtube-oauth-authorize.ts \
//     --client store/youtube-oauth-client.json \
//     --out agents/big-ben/.claude/channels/youtube
//
// Mirrors scripts/google-oauth-authorize.ts but requests ONLY the youtube.upload
// scope. No secret is ever printed; only the consent URL (carries no secret) is.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  parseClientJson,
  buildAuthUrl,
  exchangeCodeForTokens,
  awaitLoopbackCode,
  generateState,
} from '../src/mcp/google-authorize.js'
import { YOUTUBE_UPLOAD_SCOPE } from '../src/mcp/youtube-upload.js'

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const CLIENT_PATH = resolve(arg('--client', 'store/youtube-oauth-client.json'))
const OUT_DIR = resolve(arg('--out', 'agents/big-ben/.claude/channels/youtube'))
const PORT = Number(arg('--port', '4118'))
const REDIRECT_URI = `http://localhost:${PORT}/`

async function main(): Promise<void> {
  const client = parseClientJson(await readFile(CLIENT_PATH, 'utf-8'))
  // SEC-042: nonce into the consent URL, checked on the redirect; the shared
  // receiver binds loopback only.
  const state = generateState()
  const authUrl = buildAuthUrl(client.clientId, REDIRECT_URI, [YOUTUBE_UPLOAD_SCOPE], state)

  console.error('\nOpen this URL in your browser and approve the YouTube upload')
  console.error('permission. "Google hasn\'t verified this app" is expected ->')
  console.error('Advanced -> Go to ... (unsafe).\n')
  console.error(authUrl)
  console.error(`\nScope requested: ${YOUTUBE_UPLOAD_SCOPE}\n`)

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
  console.error('[youtube-oauth-authorize] failed:', err.message ?? err)
  process.exit(1)
})
