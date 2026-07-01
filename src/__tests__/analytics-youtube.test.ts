/**
 * YouTube Analytics parser tests (fixture-based, no live token).
 * Pure parser functions: input = raw API JSON, output = typed structs.
 */
import { describe, it, expect } from 'vitest'
import { createReadStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCtrRequest,
  parseCtrResponse,
  buildRetentionRequest,
  parseRetentionResponse,
  buildTrafficRequest,
  parseTrafficResponse,
  buildWatchtimeRequest,
  parseWatchtimeResponse,
  type YtCtrRow,
  type YtRetentionRow,
  type YtTrafficBucket,
  type YtWatchtimeRow,
} from '../analytics/youtube.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../analytics/__fixtures__')

function loadFixture(name: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(join(FIXTURES, name))
}

// ── Request builders ─────────────────────────────────────────────────────────

describe('buildCtrRequest', () => {
  it('uses correct metrics and dimensions', () => {
    const r = buildCtrRequest({ channelId: 'UCxxx', startDate: '2026-06-01', endDate: '2026-06-28' })
    expect(r.metrics).toBe('impressions,impressionsClickThroughRate')
    expect(r.dimensions).toBe('video')
    expect(r.ids).toBe('channel==UCxxx')
    expect(r.startDate).toBe('2026-06-01')
    expect(r.endDate).toBe('2026-06-28')
  })
})

describe('buildRetentionRequest', () => {
  it('uses correct metrics, dimensions, and filter', () => {
    const r = buildRetentionRequest({ channelId: 'UCxxx', videoId: 'abc123', startDate: '2026-06-01', endDate: '2026-06-28' })
    expect(r.metrics).toBe('audienceWatchRatio,relativeRetentionPerformance')
    expect(r.dimensions).toBe('elapsedVideoTimeRatio')
    expect(r.filters).toBe('video==abc123')
    expect(r.ids).toBe('channel==UCxxx')
  })
})

describe('buildTrafficRequest', () => {
  it('uses correct metrics and dimensions', () => {
    const r = buildTrafficRequest({ channelId: 'UCxxx', startDate: '2026-06-01', endDate: '2026-06-28' })
    expect(r.metrics).toBe('views,estimatedMinutesWatched')
    expect(r.dimensions).toBe('insightTrafficSourceType')
    expect(r.ids).toBe('channel==UCxxx')
  })
})

describe('buildWatchtimeRequest', () => {
  it('uses correct metrics and dimensions', () => {
    const r = buildWatchtimeRequest({ channelId: 'UCxxx', startDate: '2026-06-01', endDate: '2026-06-28' })
    expect(r.metrics).toBe('estimatedMinutesWatched,averageViewDuration,views')
    expect(r.dimensions).toBe('day')
    expect(r.ids).toBe('channel==UCxxx')
  })
})

// ── Response parsers (fixture-driven) ────────────────────────────────────────

describe('parseCtrResponse', () => {
  it('parses CTR fixture into typed rows', () => {
    const raw = loadFixture('yt-ctr.json')
    const rows = parseCtrResponse(raw)
    expect(rows).toHaveLength(3)
    const first = rows[0] as YtCtrRow
    expect(first.videoId).toBe('abc123')
    expect(first.impressions).toBe(12000)
    expect(first.ctr).toBeCloseTo(0.0542, 4)
  })

  it('returns empty array for missing rows', () => {
    expect(parseCtrResponse({ kind: 'youtubeAnalytics#resultTable', columnHeaders: [], rows: [] })).toEqual([])
    expect(parseCtrResponse({ kind: 'youtubeAnalytics#resultTable', columnHeaders: [] })).toEqual([])
  })
})

describe('parseRetentionResponse', () => {
  it('parses retention fixture into typed rows', () => {
    const raw = loadFixture('yt-retention.json')
    const rows = parseRetentionResponse(raw)
    expect(rows).toHaveLength(6)
    const first = rows[0] as YtRetentionRow
    expect(first.elapsedRatio).toBe(0.0)
    expect(first.watchRatio).toBe(1.0)
    expect(first.relativePerformance).toBeCloseTo(1.12, 2)
  })

  it('tolerates null relativeRetentionPerformance (low-view video)', () => {
    const rawWithNull = {
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: [
        { name: 'elapsedVideoTimeRatio', dataType: 'FLOAT' },
        { name: 'audienceWatchRatio', dataType: 'FLOAT' },
        { name: 'relativeRetentionPerformance', dataType: 'FLOAT' },
      ],
      rows: [[0.0, 0.9, null], [0.5, 0.6, null]],
    }
    expect(() => parseRetentionResponse(rawWithNull)).not.toThrow()
    const rows = parseRetentionResponse(rawWithNull)
    expect(rows[0].relativePerformance).toBeNull()
    expect(rows[1].relativePerformance).toBeNull()
  })
})

describe('parseTrafficResponse', () => {
  it('parses traffic fixture into buckets with views and minutesWatched', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows as YtTrafficBucket[]) {
      expect(typeof row.sourceType).toBe('string')
      expect(typeof row.views).toBe('number')
      expect(typeof row.minutesWatched).toBe('number')
    }
  })

  it('maps SUBSCRIBER to browse bucket (real API enum for homepage/subscriptions feed)', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const browse = rows.find(r => r.sourceType === 'SUBSCRIBER')
    expect(browse).toBeDefined()
    expect(browse!.bucket).toBe('browse')
  })

  it('maps YT_CHANNEL to browse bucket', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const ch = rows.find(r => r.sourceType === 'YT_CHANNEL')
    expect(ch).toBeDefined()
    expect(ch!.bucket).toBe('browse')
  })

  it('maps YT_SEARCH to search bucket', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const search = rows.find(r => r.sourceType === 'YT_SEARCH')
    expect(search).toBeDefined()
    expect(search!.bucket).toBe('search')
  })

  it('maps RELATED_VIDEO to suggested bucket (real API enum, not SUGGESTED_VIDEOS UI label)', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const suggested = rows.find(r => r.sourceType === 'RELATED_VIDEO')
    expect(suggested).toBeDefined()
    expect(suggested!.bucket).toBe('suggested')
  })

  it('maps END_SCREEN to suggested bucket', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const es = rows.find(r => r.sourceType === 'END_SCREEN')
    expect(es).toBeDefined()
    expect(es!.bucket).toBe('suggested')
  })

  it('maps EXT_URL to external bucket', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const ext = rows.find(r => r.sourceType === 'EXT_URL')
    expect(ext).toBeDefined()
    expect(ext!.bucket).toBe('external')
  })

  it('maps unmapped sources to other bucket', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    const others = rows.filter(r => r.bucket === 'other')
    expect(others.length).toBeGreaterThanOrEqual(1)
    expect(others.some(r => r.sourceType === 'NO_LINK_OTHER')).toBe(true)
  })

  it('does NOT contain phantom UI labels BROWSE_FEATURES or SUGGESTED_VIDEOS in fixture', () => {
    const raw = loadFixture('yt-traffic.json')
    const rows = parseTrafficResponse(raw) as YtTrafficBucket[]
    expect(rows.every(r => r.sourceType !== 'BROWSE_FEATURES')).toBe(true)
    expect(rows.every(r => r.sourceType !== 'SUGGESTED_VIDEOS')).toBe(true)
  })
})

describe('parseWatchtimeResponse', () => {
  it('parses watchtime fixture into typed rows', () => {
    const raw = loadFixture('yt-watchtime.json')
    const rows = parseWatchtimeResponse(raw)
    expect(rows).toHaveLength(5)
    const first = rows[0] as YtWatchtimeRow
    expect(first.day).toBe('2026-06-24')
    expect(first.minutesWatched).toBe(3200)
    expect(first.avgViewDuration).toBe(482)
    expect(first.views).toBe(398)
  })
})
