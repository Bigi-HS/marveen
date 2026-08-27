// Bounded retention buffer for raw HC push bodies (card 0b467f56, P0.5).
//
// Purpose: accumulate a rolling corpus of real phone-sourced payloads so TC-1
// (property/metamorphic fuzzing) and AT-1 Layer-2 (ingest assertions on real data)
// can use captured payloads instead of synthetic fixtures. The buffer keeps the last
// BUFFER_CAP pushes in a JSONL file and rotates out older entries.
//
// PII note: payloads contain health data (sleep, vitals, steps). The default file
// lives in store/ (gitignored, not committed). Access to the file should be treated
// as equivalent access to health data -- keep it on the local host only.
// Chad security flag: any new read surface (e.g. HTTP endpoint exposing the buffer)
// must be bearer-token protected and scoped to the test/audit use case.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { logger } from '../../logger.js'

export const BUFFER_CAP = 50

export class RawPushBuffer {
  constructor(
    private readonly filePath: string,
    private readonly cap: number = BUFFER_CAP,
  ) {}

  /** Retain a raw push body string. Rotates oldest entries when the cap is exceeded. */
  retain(rawBody: string): void {
    const existing = this.readAll()
    const next = [...existing, rawBody]
    const capped = next.length > this.cap ? next.slice(next.length - this.cap) : next
    try {
      writeFileSync(this.filePath, capped.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      logger.warn({ err, filePath: this.filePath }, 'raw-push-buffer: failed to write retention file')
    }
  }

  /** Return all retained payloads in arrival order (oldest first). */
  readAll(): string[] {
    if (!existsSync(this.filePath)) return []
    try {
      const content = readFileSync(this.filePath, 'utf8').trim()
      if (!content) return []
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string)
    } catch (err) {
      logger.warn({ err, filePath: this.filePath }, 'raw-push-buffer: failed to read retention file')
      return []
    }
  }
}

// Production singleton -- written to store/ (gitignored).
// Tests should instantiate RawPushBuffer with a temp path directly.
export const defaultRawPushBuffer = new RawPushBuffer('store/raw-push-buffer.jsonl')
