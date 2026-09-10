// CLI: pull accurate net sleep for a date from the Zepp de2 cloud (token-mode).
//
//   npx tsx src/web/zepp/cloud-sleep-cli.ts [YYYY-MM-DD]
//
// Reads ~/.zepp-creds.json, calls band_data.json with the apptoken header, and prints
// ONLY safe fields as JSON: date, netSleepMin, stages, score, status. The apptoken value
// is never printed, logged, or echoed -- it lives only in the request header. Default date
// is "yesterday" in Europe/Budapest (the night that just completed).

import { readZeppCloudCreds, CLOUD_CREDS_PATH } from './creds-reader.js'
import { pullCloudSleep } from './cloud-band-data.js'

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

  let creds
  try {
    creds = readZeppCloudCreds(CLOUD_CREDS_PATH)
  } catch (err) {
    console.error(JSON.stringify({ status: 'no_creds', error: err instanceof Error ? err.message : String(err) }))
    process.exit(3)
  }

  try {
    const sleep = await pullCloudSleep(date, {
      host: creds.host,
      appToken: creds.appToken,
      userId: creds.userId,
      fetch: globalThis.fetch,
    })
    if (!sleep) {
      console.log(JSON.stringify({ date, status: 'no_data', host: creds.host }))
      return
    }
    // Safe fields only -- no token, no raw response.
    console.log(
      JSON.stringify({
        date,
        status: 'ok',
        host: creds.host,
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
