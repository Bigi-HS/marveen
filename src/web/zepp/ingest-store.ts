// Zepp daily snapshot file store (WELL-018).
// Stores one JSON file per day under a configurable root directory
// (production: store/zepp/, tests: a temp dir).
// Files are written 0600 so credentials derived from the snapshot never
// leak to other OS users even if the store directory is world-readable.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZeppDailySnapshot } from './contract.js'

const FILE_PREFIX = 'daily-'
const FILE_SUFFIX = '.json'

// Strict YYYY-MM-DD. A snapshot date is the only user-influenced part of the
// on-disk filename, so it must never contain path separators or `..` segments
// that could escape the store root (ENG-083). Any deviation is rejected.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(date: string): boolean {
  return typeof date === 'string' && DATE_RE.test(date)
}

function fileName(date: string): string {
  return `${FILE_PREFIX}${date}${FILE_SUFFIX}`
}

function parseDate(name: string): string | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null
  return name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length)
}

export class ZeppIngestStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  write(snapshot: ZeppDailySnapshot): void {
    if (!isValidDate(snapshot.date)) {
      throw new Error(`invalid snapshot date: ${JSON.stringify(snapshot.date)} (expected YYYY-MM-DD)`)
    }
    const path = join(this.root, fileName(snapshot.date))
    writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  }

  read(date: string): ZeppDailySnapshot | null {
    if (!isValidDate(date)) return null
    const path = join(this.root, fileName(date))
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ZeppDailySnapshot
    } catch {
      return null
    }
  }

  listDates(): string[] {
    try {
      return readdirSync(this.root)
        .map(parseDate)
        .filter((d): d is string => d !== null)
        .sort()
    } catch {
      return []
    }
  }

  latest(): ZeppDailySnapshot | null {
    const dates = this.listDates()
    if (dates.length === 0) return null
    return this.read(dates[dates.length - 1])
  }
}

// Default store pointing at store/zepp/ relative to MARVEEN_ROOT.
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
export const defaultZeppStore = new ZeppIngestStore(join(PROJECT_ROOT, 'store', 'zepp'))
