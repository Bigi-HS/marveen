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
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  parseClientJson,
  buildAuthUrl,
  exchangeCodeForTokens,
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

function awaitCode(): Promise<string> {
  return new Promise((resolveCode, rejectCode) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI)
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<html><body style="font-family:sans-serif"><h2>${
          code ? 'Authorized. You can close this tab.' : 'Authorization failed: ' + (err ?? 'no code')
        }</h2></body></html>`,
      )
      server.close()
      if (code) resolveCode(code)
      else rejectCode(new Error(`authorization failed: ${err ?? 'no code in redirect'}`))
    })
    server.on('error', rejectCode)
    server.listen(PORT)
    setTimeout(() => {
      server.close()
      rejectCode(new Error('timed out waiting for the browser redirect (5 min)'))
    }, 5 * 60 * 1000).unref()
  })
}

async function main(): Promise<void> {
  const client = parseClientJson(await readFile(CLIENT_PATH, 'utf-8'))
  const authUrl = buildAuthUrl(client.clientId, REDIRECT_URI, [YOUTUBE_UPLOAD_SCOPE])

  console.error('\nOpen this URL in your browser and approve the YouTube upload')
  console.error('permission. "Google hasn\'t verified this app" is expected ->')
  console.error('Advanced -> Go to ... (unsafe).\n')
  console.error(authUrl)
  console.error(`\nScope requested: ${YOUTUBE_UPLOAD_SCOPE}\n`)

  const code = await awaitCode()
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
