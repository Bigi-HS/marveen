/**
 * A-layer tests for the analytics daily pull (card 54df4c8f).
 * Covers: ok-shape, error-shape, idempotent upsert, fail-soft (one source errors
 * while the other writes), and a token-no-leak assertion on the error/log path.
 * Everything runs against fixtures + an in-memory DB -- NO live token, NO network.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  runPull,
  redactSecrets,
  type AnalyticsClient,
  type PullContext,
} from '../analytics/pull.js'
import {
  applyAnalyticsMigrations,
  getLatestSnapshot,
  listRecentSnapshots,
} from '../analytics/storage.js'

const FIX = join(process.cwd(), 'src/analytics/__fixtures__')
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'))
}

const CTX: PullContext = {
  channelId: 'UC_test',
  broadcasterId: '9998887',
  userLogin: 'dominik',
  period: { from: '2026-06-24', to: '2026-06-28' },
}

// A fully-mocked client that returns the committed fixtures -- the B-layer's real
// HTTP client is NOT constructed here; this is the A-layer injection seam.
function fixtureClient(): AnalyticsClient {
  return {
    youtube: {
      query: async (req) => {
        if (req.metrics.includes('impressionsClickThroughRate')) return fixture('yt-ctr.json')
        if (req.metrics.includes('audienceWatchRatio')) return fixture('yt-retention.json')
        if (req.metrics.includes('subscribersGained')) return fixture('yt-subscribers.json')
        if (req.dimensions === 'insightTrafficSourceType') return fixture('yt-traffic.json')
        return fixture('yt-watchtime.json')
      },
    },
    twitch: {
      query: async (req) => {
        if (req.endpoint.includes('followers')) return fixture('twitch-followers.json')
        if (req.endpoint.includes('subscriptions')) return fixture('twitch-subscriptions.json')
        if (req.endpoint.includes('streams')) return fixture('twitch-stream.json')
        return fixture('twitch-videos.json')
      },
    },
  }
}

let db: ReturnType<typeof Database>
const NOW = 1_782_000_000 // fixed epoch seconds

beforeEach(() => {
  db = new Database(':memory:')
  applyAnalyticsMigrations(db)
})

describe('runPull -- ok shape (fixtures)', () => {
  it('produces status:ok envelopes with typed metrics for both sources', async () => {
    const res = await runPull({ client: fixtureClient(), context: CTX, db, now: () => NOW })

    for (const src of [res.youtube, res.twitch]) {
      expect(src.status).toBe('ok')
      expect(src.source).toMatch(/^(youtube|twitch)$/)
      expect(src.pulled_at).toBe(NOW)
      if (src.status === 'ok') {
        expect(src.period).toEqual({ from: '2026-06-24', to: '2026-06-28' })
      }
    }

    // Metrics presence + type (spec section 4 shape test).
    if (res.youtube.status === 'ok') {
      const m = res.youtube.metrics
      expect(Array.isArray(m.watchtime)).toBe(true)
      expect(Array.isArray(m.ctr)).toBe(true)
      expect(Array.isArray(m.retention)).toBe(true)
      expect(Array.isArray(m.traffic)).toBe(true)
      expect(Array.isArray(m.subscribers)).toBe(true)
      expect(typeof m.ctr[0].impressions).toBe('number')
      expect(typeof m.ctr[0].ctr).toBe('number')
      // subscribers net = gained - lost (spec 2)
      expect(m.subscribers[0].net).toBe(m.subscribers[0].gained - m.subscribers[0].lost)
    }
    if (res.twitch.status === 'ok') {
      const m = res.twitch.metrics
      expect(typeof m.followers.total).toBe('number')
      expect(typeof m.subscriptions.total).toBe('number')
      expect(typeof m.stream.isLive).toBe('boolean')
      expect(Array.isArray(m.videos)).toBe(true)
      // B2: Tier-split sub-count parsed from the fixture data[] (8x'1000' + 1x'2000').
      expect(m.subscriptions.tier1).toBe(8)
      expect(m.subscriptions.tier2).toBe(1)
      expect(m.subscriptions.tier3).toBe(0)
      // B3: single /streams sample carries no peak.
      expect(m.stream.peakConcurrent).toBeNull()
      // B4: stream-minutes window sums ARCHIVE VODs only (2h30m15s + 1h15m00s). The
      // fixture also carries a 45m highlight (hl001) which must NOT count -- if it
      // leaked in, the total would be 270.25 and could false-green the Affiliate gate.
      expect(m.streamMinutesWindow).toBeCloseTo(150.25 + 75, 2)
    }
    // B5: per-video views + retention proxy parsed from the extended CTR columns.
    if (res.youtube.status === 'ok') {
      const first = res.youtube.metrics.ctr[0]
      expect(typeof first.views).toBe('number')
      expect(typeof first.avgViewPercentage).toBe('number')
    }
  })

  it('persists ok snapshots keyed on source + period.to', async () => {
    await runPull({ client: fixtureClient(), context: CTX, db, now: () => NOW })
    const yt = getLatestSnapshot('youtube', db)
    const tw = getLatestSnapshot('twitch', db)
    expect(yt?.status).toBe('ok')
    expect(yt?.period_date).toBe('2026-06-28')
    expect(tw?.status).toBe('ok')
    expect(yt?.metrics_json).toBeTruthy()
  })
})

describe('runPull -- error shape (no client / A-layer default)', () => {
  it('resolves both sources to status:error auth when no client is injected', async () => {
    const res = await runPull({ context: CTX, db, now: () => NOW })
    for (const src of [res.youtube, res.twitch]) {
      expect(src.status).toBe('error')
      if (src.status === 'error') {
        expect(src.reason).toBe('auth')
        expect(typeof src.detail).toBe('string')
        expect(src.pulled_at).toBe(NOW)
      }
    }
  })

  it('classifies a thrown client error and stores an error snapshot', async () => {
    const throwingClient: AnalyticsClient = {
      youtube: { query: async () => { throw new Error('HTTP 429 quota exceeded') } },
      twitch: { query: async () => { throw new Error('HTTP 429 quota exceeded') } },
    }
    const res = await runPull({ client: throwingClient, context: CTX, db, now: () => NOW })
    expect(res.youtube.status).toBe('error')
    if (res.youtube.status === 'error') expect(res.youtube.reason).toBe('quota')
    const stored = getLatestSnapshot('youtube', db)
    expect(stored?.status).toBe('error')
    expect(stored?.reason).toBe('quota')
  })
})

describe('runPull -- idempotent upsert (source + date)', () => {
  it('a repeated pull for the same day overwrites, never duplicates', async () => {
    await runPull({ client: fixtureClient(), context: CTX, db, now: () => NOW })
    await runPull({ client: fixtureClient(), context: CTX, db, now: () => NOW + 3600 })

    const ytRows = listRecentSnapshots('youtube', 28, db)
    const twRows = listRecentSnapshots('twitch', 28, db)
    // Same source+period.to -> exactly one row each after two pulls.
    expect(ytRows.filter(r => r.period_date === '2026-06-28')).toHaveLength(1)
    expect(twRows.filter(r => r.period_date === '2026-06-28')).toHaveLength(1)
    // The row reflects the LATER pull (pulled_at updated by the UPSERT).
    expect(getLatestSnapshot('youtube', db)?.pulled_at).toBe(NOW + 3600)
  })
})

describe('runPull -- fail-soft (one source errors, the other writes)', () => {
  it('YouTube throws but Twitch still succeeds and persists', async () => {
    const halfBroken: AnalyticsClient = {
      youtube: { query: async () => { throw new Error('network ECONNRESET') } },
      twitch: fixtureClient().twitch,
    }
    const res = await runPull({ client: halfBroken, context: CTX, db, now: () => NOW })

    expect(res.youtube.status).toBe('error')
    if (res.youtube.status === 'error') expect(res.youtube.reason).toBe('network')
    expect(res.twitch.status).toBe('ok')

    // Both sources wrote a row: YT an error snapshot, Twitch an ok snapshot.
    expect(getLatestSnapshot('youtube', db)?.status).toBe('error')
    expect(getLatestSnapshot('twitch', db)?.status).toBe('ok')
  })
})

describe('token-no-leak on the error/log path', () => {
  it('redactSecrets strips Bearer tokens and long opaque secrets', () => {
    const token = 'ya29.a0AfH6SMB' + 'x'.repeat(60)
    expect(redactSecrets(`Auth failed: Bearer ${token}`)).not.toContain(token)
    expect(redactSecrets(`?access_token=${token}&x=1`)).not.toContain(token)
    expect(redactSecrets(token)).toBe('[REDACTED]')
  })

  it('a token leaked in a thrown error never reaches the stored detail', async () => {
    const token = 'oauth2-live-' + 'a'.repeat(50)
    const leakyClient: AnalyticsClient = {
      youtube: { query: async () => { throw new Error(`401 unauthorized: Bearer ${token}`) } },
      twitch: { query: async () => { throw new Error(`401 unauthorized: Bearer ${token}`) } },
    }
    const res = await runPull({ client: leakyClient, context: CTX, db, now: () => NOW })

    if (res.youtube.status === 'error') expect(res.youtube.detail).not.toContain(token)
    const stored = getLatestSnapshot('youtube', db)
    expect(stored?.detail ?? '').not.toContain(token)
    expect(stored?.detail).toContain('[REDACTED]')
  })
})
