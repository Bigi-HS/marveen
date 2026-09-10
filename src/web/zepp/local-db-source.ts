// Zepp accurate-sleep from the logged-in app's LOCAL database (emulator-mirror path).
//
// Token-free alternative to the cloud puller: the Zepp/Huami app (hmwatchmanager)
// authenticates via a federated Google/Amazon-MAP identity and stores NO replayable
// Huami apptoken, so the cloud API is gated. But the app persists the same sleep data
// locally in `origin_db_<device>` -> DATE_DATA.SUMMARY (a JSON string) -> `slp` object.
// Reading it needs no credentials, no HTTP, and does not trip the R5 adb-auth guard
// (sleep/health data is carve-out allowed).
//
// Accuracy: net asleep = deep+light+rem, EXCLUDING awake. This is the figure the app
// displays; Health Connect over-counts by the awake minutes. Verified 2026-09-09:
// dp142 + lt322 + rem0 = 464 min = 7h44m, matching Boss's phone to the minute (the
// in-bed/headline span 609 = net 464 + awake 145 is what HC would import).

import Database from 'better-sqlite3'
import type { ZeppSleep } from './contract.js'

/** The `slp` object stored in DATE_DATA.SUMMARY (the subset we consume). */
export interface ZeppSlp {
  /** deep-sleep minutes */
  dp?: number
  /** light-sleep minutes */
  lt?: number
  /** REM minutes (often 0/absent on band devices without REM tracking) */
  rem?: number
  /** awake minutes (excluded from net; this is HC's over-count) */
  dt?: number
  /** sleep start, unix epoch seconds */
  st?: number
  /** sleep end, unix epoch seconds */
  ed?: number
  /** sleep score 0-100 */
  ss?: number
}

/** Net asleep minutes = deep+light+rem, excluding awake (the app-displayed figure). */
export function netSleepMin(slp: ZeppSlp): number {
  return (slp.dp ?? 0) + (slp.lt ?? 0) + (slp.rem ?? 0)
}

/** Convert a DATE_DATA slp object to the source-agnostic ZeppSleep contract. */
export function slpToZeppSleep(slp: ZeppSlp, date: string): ZeppSleep {
  const stages = {
    deep: slp.dp ?? 0,
    light: slp.lt ?? 0,
    rem: slp.rem ?? 0,
    awake: slp.dt ?? 0,
  }
  return {
    // net asleep -- the accurate, phone-matching figure (NOT the in-bed span)
    durationMin: netSleepMin(slp),
    startAt: slp.st ? new Date(slp.st * 1000).toISOString() : `${date}T00:00:00Z`,
    endAt: slp.ed ? new Date(slp.ed * 1000).toISOString() : `${date}T08:00:00Z`,
    ...(slp.ss !== undefined ? { score: slp.ss } : {}),
    stages,
  }
}

/**
 * Parse a DATE_DATA.SUMMARY JSON string into ZeppSleep, or null when the row carries
 * no usable sleep (malformed JSON, no `slp`, or no measured asleep minutes).
 */
export function parseSummarySleep(summaryJson: string, date: string): ZeppSleep | null {
  let summary: unknown
  try {
    summary = JSON.parse(summaryJson)
  } catch {
    return null
  }
  const slp = (summary as { slp?: unknown } | null)?.slp
  if (!slp || typeof slp !== 'object') return null
  if (netSleepMin(slp as ZeppSlp) <= 0) return null
  return slpToZeppSleep(slp as ZeppSlp, date)
}

/** Injected row reader: returns the sleep-bearing SUMMARY string for a date, or null. */
export type DateDataReader = (date: string) => string | null

/**
 * Read accurate sleep for a local date from the app DB (token-free). The reader is
 * injected so the parse path is unit-testable without a real database.
 */
export function readLocalDbSleep(date: string, read: DateDataReader): ZeppSleep | null {
  const summary = read(date)
  if (!summary) return null
  return parseSummarySleep(summary, date)
}

/**
 * Production reader over a pulled `origin_db_<device>` sqlite file. Opens read-only and
 * returns, for a DATE, the first SUMMARY row that actually contains a `slp` object
 * (a date can carry non-sleep rows too). Imported lazily so unit tests that inject a
 * reader never need to open a database.
 */
export function makeDateDataReader(dbPath: string): DateDataReader {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const stmt = db.prepare('SELECT SUMMARY FROM DATE_DATA WHERE DATE = ?')
  return (date: string): string | null => {
    for (const row of stmt.all(date) as Array<{ SUMMARY: string | null }>) {
      if (row.SUMMARY && row.SUMMARY.includes('"slp"')) return row.SUMMARY
    }
    return null
  }
}
