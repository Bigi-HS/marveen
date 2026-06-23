import { describe, it, expect } from 'vitest'
import { extractRebuildSummary } from '../web/codetree-rebuild-spawn.js'
import type { RebuildSummary } from '../web/codetree-rebuild.js'

// Card ee546ed2: the rebuild worker shares its stdout between the data channel
// (the RebuildSummary JSON) and pino, which also writes there. The worker's
// rebuildIndex() logs "codetree index rebuilt" on stdout; pino-pretty flushes
// from a worker thread, so the log line lands AFTER the JSON and a naive
// JSON.parse(stdout) on the whole blob throws -> the daily rebuild 500s with
// "invalid output". extractRebuildSummary must pluck the summary out of a
// stdout polluted by surrounding log noise, in either pino mode.

const SUMMARY: RebuildSummary = {
  files_indexed: 204,
  symbols_indexed: 2415,
  imports_indexed: 1066,
  duration_ms: 1234,
  indexed_at: '2026-06-23T03:00:00.000Z',
  files_skipped: [],
}
const JSON_LINE = JSON.stringify(SUMMARY)

describe('extractRebuildSummary', () => {
  it('parses clean stdout that is exactly the summary JSON', () => {
    expect(extractRebuildSummary(JSON_LINE)).toEqual(SUMMARY)
  })

  it('tolerates a trailing newline', () => {
    expect(extractRebuildSummary(JSON_LINE + '\n')).toEqual(SUMMARY)
  })

  it('strips a pino-pretty log line appended AFTER the summary (the real bug)', () => {
    const stdout =
      JSON_LINE +
      '\nINFO [03:00:00.123] (12345): codetree index rebuilt\n' +
      '    files: 204\n    symbols: 2415\n'
    expect(extractRebuildSummary(stdout)).toEqual(SUMMARY)
  })

  it('strips a pino-pretty log line emitted BEFORE the summary', () => {
    const stdout = 'INFO [03:00:00.001] (12345): codetree index rebuilt\n' + JSON_LINE
    expect(extractRebuildSummary(stdout)).toEqual(SUMMARY)
  })

  it('is not fooled by a pino JSON log line (production NODE_ENV emits JSON to stdout)', () => {
    // In production pino has no pretty transport and writes its own JSON object
    // to stdout. That line is valid JSON but is NOT a RebuildSummary; a naive
    // "last valid JSON line" would wrongly pick it. The shape check rejects it.
    const pinoJson =
      '{"level":30,"time":1750000000000,"pid":12345,"msg":"codetree index rebuilt","files":204,"symbols":2415}'
    expect(extractRebuildSummary(JSON_LINE + '\n' + pinoJson)).toEqual(SUMMARY)
    expect(extractRebuildSummary(pinoJson + '\n' + JSON_LINE)).toEqual(SUMMARY)
  })

  it('throws a descriptive error when no summary line is present', () => {
    expect(() => extractRebuildSummary('INFO something happened\n')).toThrow(/no parseable summary/)
    expect(() => extractRebuildSummary('')).toThrow(/no parseable summary/)
  })

  it('throws (not silently returns a log line) when only a non-summary JSON object is present', () => {
    const pinoJson = '{"level":50,"msg":"boom"}'
    expect(() => extractRebuildSummary(pinoJson)).toThrow(/no parseable summary/)
  })
})
