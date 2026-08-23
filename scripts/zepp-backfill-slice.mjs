#!/usr/bin/env node
// Zepp Health Connect backfill slicer.
//
// The Local HTTP Server (GET http://<phone-ip>:8787/?days=N) returns ONE blob whose
// arrays span N days. Our ingest is single-day-per-POST (one body['date'], one
// snapshot), so a bulk POST would collapse N days into one mis-aggregated file and
// (post-#517) drop off-date workouts. This tool slices the raw blob into one
// POST-ready sub-payload per calendar day; the driver then POSTs each day through the
// existing n8n webhook -> transform -> ingest, producing N correct per-day daily files.
//
// Each array entry is bucketed by the Europe/Budapest local date of its own timestamp
// (sleep -> session_end_time; vitals buckets & resting_hr -> time; steps / calories /
// distance / exercise -> start_time). Each day's sub-payload gets timestamp = D-noon
// UTC so the transform dates it to D on BOTH branches: sleep-end for slept days, and
// the syncedAt fallback for no-sleep days (without this, a historical no-sleep day
// would fall back to "now" and collapse onto today).
//
// Usage: node scripts/zepp-backfill-slice.mjs <blob.json> <outdir>
//   -> writes <outdir>/day-YYYY-MM-DD.json for each day found, prints a summary.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Europe/Budapest local calendar date of a UTC ISO timestamp (CEST +2 Mar-Oct, CET +1
// otherwise -- DST approximation matching the n8n transform and the ingest own-day filter).
export function localDateBudapest(isoUtc) {
  if (!isoUtc) return undefined
  const d = new Date(isoUtc)
  if (Number.isNaN(d.getTime())) return undefined
  const mo = d.getUTCMonth() + 1
  const offH = (mo >= 3 && mo <= 10) ? 2 : 1
  return new Date(d.getTime() + offH * 3600_000).toISOString().slice(0, 10)
}

// First present timestamp field, in the transform's own date-priority order: a sleep
// session is dated by when it ended, everything else by when it started / was sampled.
const DATE_FIELDS = ['session_end_time', 'time', 'start_time', 'end_time']
function entryLocalDate(e) {
  if (!e || typeof e !== 'object') return undefined
  for (const f of DATE_FIELDS) {
    if (e[f]) {
      const d = localDateBudapest(e[f])
      if (d) return d
    }
  }
  return undefined
}

// Non-array top-level keys carried verbatim into every day's payload.
const PASSTHROUGH = ['app_version']

// Pure: raw blob -> { days: [{date, payload}], undated: {key: [entries]} }.
// `undated` collects entries whose timestamp could not be resolved -- surfaced, never
// silently dropped.
export function sliceByDay(blob) {
  const buckets = new Map() // date -> { key: [entries] }
  const undated = {}
  const arrayKeys = Object.keys(blob).filter((k) => Array.isArray(blob[k]))
  for (const k of arrayKeys) {
    for (const e of blob[k]) {
      const d = entryLocalDate(e)
      if (!d) {
        ;(undated[k] ||= []).push(e)
        continue
      }
      if (!buckets.has(d)) buckets.set(d, {})
      const day = buckets.get(d)
      ;(day[k] ||= []).push(e)
    }
  }
  const days = [...buckets.keys()].sort().map((d) => {
    const payload = { timestamp: `${d}T12:00:00Z` }
    for (const p of PASSTHROUGH) if (blob[p] !== undefined) payload[p] = blob[p]
    Object.assign(payload, buckets.get(d))
    return { date: d, payload }
  })
  return { days, undated }
}

function main(argv) {
  const [blobPath, outDir] = argv
  if (!blobPath || !outDir) {
    console.error('Usage: node scripts/zepp-backfill-slice.mjs <blob.json> <outdir>')
    process.exit(2)
  }
  const blob = JSON.parse(readFileSync(blobPath, 'utf8'))
  const { days, undated } = sliceByDay(blob)
  mkdirSync(outDir, { recursive: true })
  // Clear any stale day-*.json so a re-run does not leave orphans from a prior blob.
  for (const f of readdirSync(outDir)) {
    if (/^day-\d{4}-\d{2}-\d{2}\.json$/.test(f)) writeFileSync(join(outDir, f), '')
  }
  for (const { date, payload } of days) {
    writeFileSync(join(outDir, `day-${date}.json`), JSON.stringify(payload, null, 1))
  }
  const undatedKeys = Object.keys(undated)
  console.log(`sliced ${days.length} day(s): ${days.map((d) => d.date).join(', ') || '(none)'}`)
  if (undatedKeys.length) {
    const counts = undatedKeys.map((k) => `${k}:${undated[k].length}`).join(', ')
    console.log(`WARNING undated (no resolvable timestamp, NOT written): ${counts}`)
  }
  console.log(`wrote to ${outDir}/day-YYYY-MM-DD.json`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
}
