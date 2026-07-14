/**
 * Twitch Helix parser tests (fixture-based, no live token).
 * Pure parsers: input = raw Helix API JSON, output = typed structs.
 * Assert: ONLY fields the API actually gives -- no invented retention/CTR.
 */
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildFollowersRequest,
  parseFollowersResponse,
  buildSubscriptionsRequest,
  parseSubscriptionsResponse,
  buildStreamRequest,
  parseStreamResponse,
  buildVideosRequest,
  parseVideosResponse,
  type TwitchFollowersSummary,
  type TwitchSubsSummary,
  type TwitchStreamSummary,
  type TwitchVodSummary,
} from '../analytics/twitch.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, '../analytics/__fixtures__')

function loadFixture(name: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(join(FIXTURES, name))
}

// ── Request builders ─────────────────────────────────────────────────────────

describe('buildFollowersRequest', () => {
  it('targets correct Helix endpoint with broadcaster_id', () => {
    const r = buildFollowersRequest({ broadcasterId: '9998887' })
    expect(r.endpoint).toBe('/helix/channels/followers')
    expect(r.params.broadcaster_id).toBe('9998887')
  })
})

describe('buildSubscriptionsRequest', () => {
  it('targets correct Helix endpoint with broadcaster_id', () => {
    const r = buildSubscriptionsRequest({ broadcasterId: '9998887' })
    expect(r.endpoint).toBe('/helix/subscriptions')
    expect(r.params.broadcaster_id).toBe('9998887')
  })
})

describe('buildStreamRequest', () => {
  it('targets correct Helix endpoint with user_login', () => {
    const r = buildStreamRequest({ userLogin: 'dominik' })
    expect(r.endpoint).toBe('/helix/streams')
    expect(r.params.user_login).toBe('dominik')
  })
})

describe('buildVideosRequest', () => {
  it('targets correct Helix endpoint with user_id', () => {
    const r = buildVideosRequest({ userId: '9998887', first: 10 })
    expect(r.endpoint).toBe('/helix/videos')
    expect(r.params.user_id).toBe('9998887')
    expect(r.params.first).toBe(10)
  })

  it('uses default first=20 when not provided', () => {
    const r = buildVideosRequest({ userId: '9998887' })
    expect(r.params.first).toBe(20)
  })
})

// ── Response parsers (fixture-driven) ────────────────────────────────────────

describe('parseFollowersResponse', () => {
  it('parses followers fixture into summary with total', () => {
    const raw = loadFixture('twitch-followers.json')
    const summary = parseFollowersResponse(raw) as TwitchFollowersSummary
    expect(summary.total).toBe(14823)
  })

  it('exposes ONLY real follower fields (total) -- no invented CTR/retention', () => {
    const raw = loadFixture('twitch-followers.json')
    const summary = parseFollowersResponse(raw) as TwitchFollowersSummary
    expect('ctr' in summary).toBe(false)
    expect('retention' in summary).toBe(false)
    expect('impressions' in summary).toBe(false)
  })
})

describe('parseSubscriptionsResponse', () => {
  it('parses subscriptions fixture into total, points and tier split (B2)', () => {
    const raw = loadFixture('twitch-subscriptions.json')
    const summary = parseSubscriptionsResponse(raw) as TwitchSubsSummary
    expect(summary.total).toBe(9)
    expect(summary.points).toBe(10)
    // B2 (card 4c81a561): Tier-split from data[].tier (8x'1000' + 1x'2000').
    expect(summary.tier1).toBe(8)
    expect(summary.tier2).toBe(1)
    expect(summary.tier3).toBe(0)
  })

  it('exposes ONLY real subscription fields -- no invented retention/CTR', () => {
    const raw = loadFixture('twitch-subscriptions.json')
    const summary = parseSubscriptionsResponse(raw) as TwitchSubsSummary
    expect('ctr' in summary).toBe(false)
    expect('retention' in summary).toBe(false)
    expect('impressions' in summary).toBe(false)
  })
})

describe('parseStreamResponse', () => {
  it('parses live stream fixture with viewer_count', () => {
    const raw = loadFixture('twitch-stream.json')
    const summary = parseStreamResponse(raw) as TwitchStreamSummary
    expect(summary.isLive).toBe(true)
    expect(summary.viewerCount).toBe(247)
    expect(summary.title).toBe('Building stuff')
  })

  it('returns isLive=false when stream data is empty', () => {
    const summary = parseStreamResponse({ data: [], pagination: {} }) as TwitchStreamSummary
    expect(summary.isLive).toBe(false)
    expect(summary.viewerCount).toBeNull()
    expect(summary.title).toBeNull()
  })

  it('exposes ONLY real stream fields (concurrent viewers, title) -- no invented retention', () => {
    const raw = loadFixture('twitch-stream.json')
    const summary = parseStreamResponse(raw) as TwitchStreamSummary
    expect('retentionCurve' in summary).toBe(false)
    expect('ctr' in summary).toBe(false)
  })
})

describe('parseVideosResponse', () => {
  it('parses videos fixture into array with view_count per VOD', () => {
    const raw = loadFixture('twitch-videos.json')
    const vods = parseVideosResponse(raw) as TwitchVodSummary[]
    expect(vods).toHaveLength(3)
    expect(vods[0].id).toBe('vod001')
    expect(vods[0].viewCount).toBe(1834)
    expect(vods[0].title).toBe('VOD: Building stuff')
    expect(vods[1].id).toBe('vod002')
    expect(vods[1].viewCount).toBe(932)
  })

  it('carries the Helix video type (archive vs highlight) so B4 can filter it', () => {
    const raw = loadFixture('twitch-videos.json')
    const vods = parseVideosResponse(raw) as TwitchVodSummary[]
    expect(vods[0].videoType).toBe('archive')
    expect(vods[1].videoType).toBe('archive')
    // The highlight is parsed but tagged non-archive -> B4 sumStreamMinutes drops it.
    const hl = vods.find(v => v.id === 'hl001')
    expect(hl).toBeDefined()
    expect(hl!.videoType).toBe('highlight')
  })

  it('exposes ONLY real VOD fields -- no invented CTR/retention', () => {
    const raw = loadFixture('twitch-videos.json')
    const vods = parseVideosResponse(raw) as TwitchVodSummary[]
    for (const vod of vods) {
      expect('ctr' in vod).toBe(false)
      expect('retentionCurve' in vod).toBe(false)
      expect('impressions' in vod).toBe(false)
    }
  })
})
