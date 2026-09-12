// CLI: pull accurate net sleep for a date from the Zepp de2 cloud.
//
//   npx tsx src/web/zepp/cloud-sleep-cli.ts [YYYY-MM-DD]
//
// Two auth modes, resolved in this order:
//   password mode (preferred, hands-off): {"email","password"} in store/zepp/.creds.json ->
//                  server-side login mints a FRESH app_token each run (no capture, no token-burn)
//   token mode (legacy fallback): the captured-apptoken shape in ~/.zepp-creds.json
// Then calls band_data.json with the apptoken header and prints ONLY safe fields as JSON:
// date, netSleepMin, stages, score, status. No credential or token value is ever printed,
// logged, or echoed. Default date is "yesterday" in Europe/Budapest (the night just completed).

import { readZeppCloudAuth, CLOUD_CREDS_PATH, DEFAULT_CREDS_PATH, type ZeppCloudAuth } from './creds-reader.js'
import { pullCloudSleep } from './cloud-band-data.js'
import { zeppCloudLogin } from './cloud-login.js'

function budapestYesterday(): string {
  const now = new Date()
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Budapest' }))
  local.setDate(local.getDate() - 1)
  return local.toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? budapestYesterday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(JSON.stringify({ status: 'bad_input', error: `date must be YYYY-MM-DD, got ${date}` }))
    process.exit(2)
  }

  // Prefer the hands-off password creds (store/zepp/.creds.json); fall back to the captured
  // apptoken file (~/.zepp-creds.json) only if the password file has no usable email+password.
  let auth: ZeppCloudAuth
  try {
    auth = readZeppCloudAuth(DEFAULT_CREDS_PATH)
  } catch {
    try {
      auth = readZeppCloudAuth(CLOUD_CREDS_PATH)
    } catch (err) {
      console.error(JSON.stringify({ status: 'no_creds', error: err instanceof Error ? err.message : String(err) }))
      process.exit(3)
    }
  }

  // Resolve an app_token: mint a fresh one via login (password mode) or use the captured one.
  let appToken: string
  let userId: string
  try {
    if (auth.mode === 'password') {
      const login = await zeppCloudLogin(auth.email, auth.password, { fetch: globalThis.fetch })
      appToken = login.appToken
      userId = login.userId
    } else {
      appToken = auth.appToken
      userId = auth.userId
    }
  } catch (err) {
    const type = (err as { type?: string }).type ?? 'auth_fail'
    console.error(JSON.stringify({ date, status: type, error: err instanceof Error ? err.message : String(err) }))
    process.exit(3)
  }

  try {
    const sleep = await pullCloudSleep(date, {
      host: auth.host,
      appToken,
      userId,
      fetch: globalThis.fetch,
    })
    if (!sleep) {
      console.log(JSON.stringify({ date, status: 'no_data', host: auth.host }))
      return
    }
    // Safe fields only -- no token, no raw response.
    console.log(
      JSON.stringify({
        date,
        status: 'ok',
        host: auth.host,
        auth: auth.mode,
        netSleepMin: sleep.durationMin,
        stages: sleep.stages,
        ...(sleep.score !== undefined ? { score: sleep.score } : {}),
        startAt: sleep.startAt,
        endAt: sleep.endAt,
      }),
    )
  } catch (err) {
    const type = (err as { type?: string }).type ?? 'endpoint_error'
    console.error(JSON.stringify({ date, status: type, error: err instanceof Error ? err.message : String(err) }))
    process.exit(4)
  }
}

void main()
