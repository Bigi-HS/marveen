// Analytics daily pull driver (card 54df4c8f, A-layer).
//
// Produces the status:ok / status:error envelope defined in Radar's data-side spec
// (section 4) and persists each per-source result via storage.upsertSnapshot.
//
// A-LAYER (this file): everything runs against an INJECTABLE client seam. With no
// client supplied, every source resolves to a safe {status:'error', reason:'auth'}
// (no token / not consented) -- NO live network call is ever made from here.
//
// B-LAYER SEAM (parked, out of scope): the `AnalyticsClient` interface below is the
// single plug point. When Boss OAuth consent lands, the B-layer implements a real
// client (reading the token pointer from src/analytics/tokens.ts, calling the YT
// Analytics + Twitch Helix HTTP endpoints) and passes it via PullOptions.client.
// NOTHING in this A-layer reads a credential or hits the network -- see makePull().
//
// Fail-soft (spec 1): each source is pulled independently inside its own try/catch.
// If YouTube throws, Twitch still runs and writes; the failure is recorded as a
// status:error row, it never aborts the whole pull.
//
// Idempotency (spec 1): the storage layer keys on (source, period_date); a repeated
// pull for the same day UPSERTS, never duplicates.

import {
  parseCtrResponse,
  parseRetentionResponse,
  parseTrafficResponse,
  parseWatchtimeResponse,
  parseSubscribersResponse,
  buildCtrRequest,
  buildRetentionRequest,
  buildTrafficRequest,
  buildWatchtimeRequest,
  buildSubscribersRequest,
  type YtCtrRow,
  type YtRetentionRow,
  type YtTrafficBucket,
  type YtWatchtimeRow,
  type YtSubscribersRow,
  type YtAnalyticsRequest,
} from './youtube.js'
import {
  parseFollowersResponse,
  parseSubscriptionsResponse,
  parseStreamResponse,
  parseVideosResponse,
  buildFollowersRequest,
  buildSubscriptionsRequest,
  buildStreamRequest,
  buildVideosRequest,
  type TwitchFollowersSummary,
  type TwitchSubsSummary,
  type TwitchStreamSummary,
  type TwitchVodSummary,
  type HelixRequest,
} from './twitch.js'
import {
  applyAnalyticsMigrations,
  upsertSnapshot,
  type AnalyticsSource,
  type AnalyticsSnapshotRow,
} from './storage.js'
import type Database from 'better-sqlite3'

// ── Envelope shape (spec section 4) ───────────────────────────────────────────

export interface PullPeriod {
  from: string // YYYY-MM-DD
  to: string   // YYYY-MM-DD
}

export interface YoutubeMetrics {
  watchtime: YtWatchtimeRow[]
  ctr: YtCtrRow[]
  retention: YtRetentionRow[]
  traffic: YtTrafficBucket[]
  subscribers: YtSubscribersRow[] // daily subscribersGained/Lost/net (spec 2)
}

export interface TwitchMetrics {
  followers: TwitchFollowersSummary
  subscriptions: TwitchSubsSummary
  stream: TwitchStreamSummary
  videos: TwitchVodSummary[]
}

export interface PullOk<M> {
  status: 'ok'
  source: AnalyticsSource
  pulled_at: number
  period: PullPeriod
  metrics: M
}

export interface PullError {
  status: 'error'
  source: AnalyticsSource
  pulled_at: number
  reason: 'auth' | 'quota' | 'network' | 'parse' | 'unknown'
  detail: string // safe message; MUST NOT contain a token
}

export type SourceResult<M> = PullOk<M> | PullError

export interface PullResult {
  youtube: SourceResult<YoutubeMetrics>
  twitch: SourceResult<TwitchMetrics>
}

// ── B-LAYER SEAM ──────────────────────────────────────────────────────────────
// The single injectable boundary. A-layer never constructs a live implementation.
// B-layer provides one that reads the OAuth token pointer + performs the HTTP call.
// Each method returns the RAW API JSON; the A-layer owns parsing (pure, testable).
export interface AnalyticsClient {
  // YouTube Analytics API -- raw resultTable JSON per request.
  youtube: {
    query(req: YtAnalyticsRequest): Promise<unknown>
  }
  // Twitch Helix -- raw JSON per endpoint request.
  twitch: {
    query(req: HelixRequest): Promise<unknown>
  }
}

export interface PullContext {
  channelId: string      // YouTube channel id
  broadcasterId: string  // Twitch broadcaster/user id
  userLogin: string      // Twitch user login
  period: PullPeriod
}

export interface PullOptions {
  // B-layer plugs a real client here. Omitted in the A-layer -> every source
  // resolves to status:error (auth / not-consented), no network is touched.
  client?: AnalyticsClient
  context: PullContext
  db?: Database.Database
  now?: () => number // injectable clock (epoch seconds); defaults to Date.now
}

// ── Token-leak hygiene ─────────────────────────────────────────────────────────
// Defensive scrub applied to any error detail before it is stored/logged, so a
// token that leaks into a thrown Error message (e.g. an HTTP client that echoes an
// Authorization header) can never reach the DB or the log. Redacts Bearer tokens,
// long opaque secrets, and access_token=... query fragments.
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(access_token|refresh_token|client_secret|token)=[^&\s"']+/gi,
  /\b[A-Za-z0-9._-]{40,}\b/g, // long opaque secret-shaped strings
]

export function redactSecrets(msg: string): string {
  let out = msg
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]')
  return out
}

function classifyReason(err: unknown): PullError['reason'] {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('auth') || msg.includes('401') || msg.includes('403') || msg.includes('consent')) return 'auth'
  if (msg.includes('quota') || msg.includes('429') || msg.includes('rate')) return 'quota'
  if (msg.includes('network') || msg.includes('econn') || msg.includes('timeout') || msg.includes('fetch')) return 'network'
  if (msg.includes('parse') || msg.includes('json') || msg.includes('column')) return 'parse'
  return 'unknown'
}

function toRow(res: SourceResult<unknown>): AnalyticsSnapshotRow {
  const base = {
    source: res.source,
    period_date: res.status === 'ok' ? res.period.to : new Date(res.pulled_at * 1000).toISOString().slice(0, 10),
    status: res.status,
    pulled_at: res.pulled_at,
  }
  if (res.status === 'ok') {
    return {
      ...base,
      period_from: res.period.from,
      period_to: res.period.to,
      metrics_json: JSON.stringify(res.metrics),
      reason: null,
      detail: null,
    }
  }
  return {
    ...base,
    period_from: null,
    period_to: null,
    metrics_json: null,
    reason: res.reason,
    detail: redactSecrets(res.detail),
  }
}

// ── Per-source pulls ────────────────────────────────────────────────────────────

async function pullYoutube(
  client: AnalyticsClient | undefined,
  ctx: PullContext,
  nowS: number
): Promise<SourceResult<YoutubeMetrics>> {
  if (!client) {
    // A-layer default: no token / not consented. No network touched.
    return { status: 'error', source: 'youtube', pulled_at: nowS, reason: 'auth', detail: 'No analytics client configured (OAuth consent pending)' }
  }
  try {
    const [watchRaw, ctrRaw, retentionRaw, trafficRaw, subsRaw] = await Promise.all([
      client.youtube.query(buildWatchtimeRequest({ channelId: ctx.channelId, startDate: ctx.period.from, endDate: ctx.period.to })),
      client.youtube.query(buildCtrRequest({ channelId: ctx.channelId, startDate: ctx.period.from, endDate: ctx.period.to })),
      client.youtube.query(buildRetentionRequest({ channelId: ctx.channelId, videoId: '', startDate: ctx.period.from, endDate: ctx.period.to })),
      client.youtube.query(buildTrafficRequest({ channelId: ctx.channelId, startDate: ctx.period.from, endDate: ctx.period.to })),
      client.youtube.query(buildSubscribersRequest({ channelId: ctx.channelId, startDate: ctx.period.from, endDate: ctx.period.to })),
    ])
    const metrics: YoutubeMetrics = {
      watchtime: parseWatchtimeResponse(watchRaw),
      ctr: parseCtrResponse(ctrRaw),
      retention: parseRetentionResponse(retentionRaw),
      traffic: parseTrafficResponse(trafficRaw),
      subscribers: parseSubscribersResponse(subsRaw),
    }
    return { status: 'ok', source: 'youtube', pulled_at: nowS, period: ctx.period, metrics }
  } catch (err) {
    return {
      status: 'error',
      source: 'youtube',
      pulled_at: nowS,
      reason: classifyReason(err),
      detail: redactSecrets(err instanceof Error ? err.message : String(err)),
    }
  }
}

async function pullTwitch(
  client: AnalyticsClient | undefined,
  ctx: PullContext,
  nowS: number
): Promise<SourceResult<TwitchMetrics>> {
  if (!client) {
    return { status: 'error', source: 'twitch', pulled_at: nowS, reason: 'auth', detail: 'No analytics client configured (OAuth consent pending)' }
  }
  try {
    const [followersRaw, subsRaw, streamRaw, videosRaw] = await Promise.all([
      client.twitch.query(buildFollowersRequest({ broadcasterId: ctx.broadcasterId })),
      client.twitch.query(buildSubscriptionsRequest({ broadcasterId: ctx.broadcasterId })),
      client.twitch.query(buildStreamRequest({ userLogin: ctx.userLogin })),
      client.twitch.query(buildVideosRequest({ userId: ctx.broadcasterId })),
    ])
    const metrics: TwitchMetrics = {
      followers: parseFollowersResponse(followersRaw),
      subscriptions: parseSubscriptionsResponse(subsRaw),
      stream: parseStreamResponse(streamRaw),
      videos: parseVideosResponse(videosRaw),
    }
    return { status: 'ok', source: 'twitch', pulled_at: nowS, period: ctx.period, metrics }
  } catch (err) {
    return {
      status: 'error',
      source: 'twitch',
      pulled_at: nowS,
      reason: classifyReason(err),
      detail: redactSecrets(err instanceof Error ? err.message : String(err)),
    }
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

/**
 * Pull YT + Twitch metrics for the given period and UPSERT each per-source
 * snapshot (idempotent on source + period.to). Fail-soft: a throw in one source
 * is captured as a status:error row and NEVER aborts the other source or the pull.
 * Returns both per-source envelopes for the caller to inspect/log.
 */
export async function runPull(opts: PullOptions): Promise<PullResult> {
  const nowS = opts.now ? opts.now() : Math.floor(Date.now() / 1000)
  const db = opts.db

  // Ensure the storage table exists (idempotent; safe for the scheduled fire).
  try { applyAnalyticsMigrations(db) } catch { /* boot migration already ran -- ok */ }

  // Pulled independently so one source's failure cannot abort the other.
  const [youtube, twitch] = await Promise.all([
    pullYoutube(opts.client, opts.context, nowS),
    pullTwitch(opts.client, opts.context, nowS),
  ])

  // Persist each per-source result independently (fail-soft on write too).
  for (const res of [youtube, twitch]) {
    try {
      upsertSnapshot(toRow(res), db)
    } catch {
      // A write failure for one source must not block the other's write.
    }
  }

  return { youtube, twitch }
}
