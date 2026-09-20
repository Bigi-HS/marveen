// WELL-027 AC-3: cross-path parity. Path B (hc-transform-node.ts, the n8n Code node) and Path A
// (routes/health-ingest.ts) are a SEQUENTIAL pipeline -- B turns a raw Health Connect webhook
// payload into a snake_case ingest body, A ingests that body into a ZeppDailySnapshot. Each path
// has its OWN synthetic test with its OWN assumed shape; if the two assumed shapes drift, both
// stay green while the LIVE pipeline silently drops fields on a key mismatch
// ("two-synthetic-greens-share-the-assumed-shape" blindspot).
//
// This test closes the blindspot: ONE real-shape raw payload -> the REAL HC_TRANSFORM_NODE_JS
// (run verbatim via `new Function`, exactly as n8n runs it) -> the REAL makeHealthIngestHandler
// -> assert that every field the payload carried survives to the snapshot (no silent drop), with
// the wire divergences named and justified (hc-ingest-wire.ts).

import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import { HC_TRANSFORM_NODE_JS } from '../web/zepp/hc-transform-node.js'
import { makeHealthIngestHandler, type HealthIngestDeps } from '../web/routes/health-ingest.js'
import { WIRE_VITALS } from '../web/zepp/hc-ingest-wire.js'

// --- Path B harness: run the deployed n8n node body verbatim (same as zepp-transform-own-day) --
interface WireSnapshot {
  date: string
  synced_at: string
  vitals?: Record<string, number>
  sleep?: Array<{ total_min: number; start?: string; end?: string; stages?: Record<string, number> }>
  workouts?: Array<{ type: string; start?: string; duration_min?: number; distance_m?: number }>
  activity?: { steps?: number; active_kcal?: number; distance_m?: number }
}
function runTransform(body: unknown): Array<{ json: WireSnapshot }> {
  const fn = new Function('$input', HC_TRANSFORM_NODE_JS) as (
    $input: { first: () => { json: unknown } },
  ) => Array<{ json: WireSnapshot }>
  return fn({ first: () => ({ json: body }) })
}

// --- Path A harness: drive the real ingest handler and capture the written snapshot ------------
const VALID_TOKEN = 'test-secret-abc'
function makeReq(body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  readable.method = 'POST'
  readable.headers = { 'content-type': 'application/json', 'x-ingest-token': VALID_TOKEN }
  return readable
}
function makeRes(): ServerResponse {
  return {
    writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn(),
  } as unknown as ServerResponse
}
async function ingest(body: unknown): Promise<ZeppDailySnapshot | null> {
  let captured: ZeppDailySnapshot | null = null
  const deps: HealthIngestDeps = {
    readIngestToken: () => VALID_TOKEN,
    readSnapshot: () => null,
    writeSnapshot: (s: ZeppDailySnapshot) => { captured = s },
    nowIso: () => '2026-08-23T20:00:00.000Z',
  }
  await makeHealthIngestHandler(deps)(makeReq(body), makeRes())
  return captured
}

// --- ONE real-shape raw Health Connect payload (shape mirrors store/zepp/backfill-sliced,
//     values realistic + messy: multi-bucket HR/SpO2, a numeric exercise type code, a
//     total_calories the transform is known to drop). All records fall on 2026-08-23 (Budapest,
//     CEST +2) so the transform emits exactly one day. -----------------------------------------
const RAW_HC_PAYLOAD = {
  timestamp: '2026-08-23T18:00:00Z',
  app_version: '1.9.14',
  steps: [
    { count: 8000, start_time: '2026-08-23T06:00:00Z', end_time: '2026-08-23T12:00:00Z' },
    { count: 4790, start_time: '2026-08-23T12:00:00Z', end_time: '2026-08-23T18:00:00Z' },
  ],
  sleep: [
    {
      session_end_time: '2026-08-23T04:30:00Z',
      duration_seconds: 25200,
      stages: [
        { stage: '5', start_time: '2026-08-22T22:00:00Z', end_time: '2026-08-22T23:30:00Z', duration_seconds: 5400 },
        { stage: '4', start_time: '2026-08-22T23:30:00Z', end_time: '2026-08-23T03:00:00Z', duration_seconds: 12600 },
        { stage: '6', start_time: '2026-08-23T03:00:00Z', end_time: '2026-08-23T04:30:00Z', duration_seconds: 5400 },
      ],
    },
  ],
  heart_rate: [
    { time: '2026-08-23T08:00:00Z', avg: 75, min: 55, max: 150 },
    { time: '2026-08-23T14:00:00Z', avg: 80, min: 60, max: 160 },
  ],
  heart_rate_variability: [{ time: '2026-08-23T04:00:00Z', avg: 42 }],
  distance: [{ meters: 9200, start_time: '2026-08-23T06:00:00Z', end_time: '2026-08-23T18:00:00Z' }],
  active_calories: [{ calories: 620, start_time: '2026-08-23T06:00:00Z', end_time: '2026-08-23T18:00:00Z' }],
  total_calories: [{ calories: 2400, start_time: '2026-08-23T06:00:00Z', end_time: '2026-08-23T18:00:00Z' }],
  oxygen_saturation: [
    { time: '2026-08-23T08:00:00Z', avg: 97 },
    { time: '2026-08-23T14:00:00Z', avg: 96 },
  ],
  respiratory_rate: [{ time: '2026-08-23T04:00:00Z', avg: 15 }],
  resting_heart_rate: [{ bpm: 52, time: '2026-08-23T04:20:00Z' }],
  exercise: [
    { type: '0', start_time: '2026-08-23T09:00:00Z', end_time: '2026-08-23T09:30:00Z', duration_seconds: 1800, distance_meters: 4200 },
  ],
}

describe('WELL-027 AC-3: B->A cross-path parity on a real-shape payload', () => {
  it('the transform emits exactly one day and the ingest accepts it', async () => {
    const out = runTransform(RAW_HC_PAYLOAD)
    expect(out).toHaveLength(1)
    expect(out[0].json.date).toBe('2026-08-23')
    const snap = await ingest(out[0].json)
    expect(snap).not.toBeNull()
    expect(snap!.date).toBe('2026-08-23')
    expect(snap!.status).toBe('ok')
  })

  it('every wire field B emits survives to the A snapshot (no silent drop)', async () => {
    const wire = runTransform(RAW_HC_PAYLOAD)[0].json
    const snap = (await ingest(wire))!

    // metadata
    expect(snap.sourceSyncedAt).toBe(RAW_HC_PAYLOAD.timestamp)

    // steps (B: activity.steps sum -> A: top-level steps)
    expect(wire.activity!.steps).toBe(12790)
    expect(snap.steps).toBe(12790)

    // activity distance + active kcal (snake_case -> camelCase, values preserved)
    expect(snap.activity!.distanceM).toBe(wire.activity!.distance_m)
    expect(snap.activity!.activeKcal).toBe(wire.activity!.active_kcal)
    expect(snap.activity!.distanceM).toBe(9200)
    expect(snap.activity!.activeKcal).toBe(620)

    // vitals: each key B emits maps to a populated ZeppVitals field
    expect(snap.vitals!.restingHr).toBe(52)
    expect(snap.vitals!.hrv).toBe(42)
    expect(snap.vitals!.breathingRate).toBe(15)
    expect(snap.vitals!.hrMin).toBe(55) // Math.min across buckets
    expect(snap.vitals!.hrMax).toBe(160) // Math.max across buckets
    expect(snap.vitals!.hrAvg).toBeGreaterThan(30) // mean across buckets, bounded
    expect(snap.vitals!.hrAvg).toBeLessThan(230)
    expect(snap.vitals!.spo2).toBeGreaterThan(0) // median across buckets, bounded
    expect(snap.vitals!.spo2).toBeLessThanOrEqual(100)

    // sleep block survives with a usable duration + timestamps
    expect(snap.sleep).toBeDefined()
    expect(snap.sleep!.durationMin).toBeGreaterThan(0)
    expect(snap.sleep!.startAt).toBeTruthy()
    expect(snap.sleep!.endAt).toBeTruthy()

    // workout: numeric HC type code resolved (name + preserved code), distance + duration survive
    expect(snap.workouts).toHaveLength(1)
    const w = snap.workouts![0]
    expect(w.typeCode).toBe('0') // raw numeric code preserved
    expect(typeof w.type).toBe('string') // resolved to a name (never the bare code)
    expect(w.distanceM).toBe(4200)
    // duration crosses the wire as whole minutes and A re-expands *60 (named rounding seam)
    expect(w.durationSec).toBe(1800)
  })

  it('names the justified cross-path differences (not silent drops)', async () => {
    const wire = runTransform(RAW_HC_PAYLOAD)[0].json
    const snap = (await ingest(wire))!

    // caloriesTotal: B emits no total_kcal (raw total_calories dropped in the transform).
    expect((wire.activity as Record<string, unknown>).total_kcal).toBeUndefined()
    expect(snap.caloriesTotal).toBeUndefined()

    // skinTemp: B never emits skin_temp_c.
    expect(wire.vitals!.skin_temp_c).toBeUndefined()
    expect(snap.vitals!.skinTemp).toBeUndefined()

    // workout avgHr + calories: B forwards neither avg_hr_bpm nor the heart_rate buckets A would
    // derive avgHr from, and emits no per-workout kcal -> both absent after a B->A flow.
    expect(snap.workouts![0].avgHr).toBeUndefined()
    expect(snap.workouts![0].calories).toBeUndefined()

    // server-side finalize fields A computes (present because the handler runs the finalize
    // chain) -- these are A-only, B never emits them, and that is correct.
    expect(snap.pulledAt).toBeTruthy()
    expect(snap.status).toBe('ok')
    expect(snap.activity!.distanceSource).toBe('measured') // set by applyDistanceEstimate
    expect(snap.reliability).toBeDefined() // set by applyReliabilityTiers
  })

  it('the duration minute-rounding seam is real and bounded (named)', async () => {
    // A payload whose exercise is 30.5 minutes: B rounds to 31 min, A re-expands to 1860s, so
    // the sub-minute precision is lost. This is the documented rounding seam, asserted so a
    // future change to either side is caught, not silently altered.
    const payload = {
      ...RAW_HC_PAYLOAD,
      exercise: [
        { type: '0', start_time: '2026-08-23T09:00:00Z', end_time: '2026-08-23T09:30:30Z', duration_seconds: 1830, distance_meters: 4200 },
      ],
    }
    const wire = runTransform(payload)[0].json
    expect(wire.workouts![0].duration_min).toBe(31) // Math.round(1830/60)
    const snap = (await ingest(wire))!
    expect(snap.workouts![0].durationSec).toBe(1860) // 31 * 60, not the original 1830
  })
})

describe('WELL-027 AC-3 drift-guard: B output keys stay anchored to what A reads', () => {
  it('every vitals key B emits is a known wire key A maps (no unmapped/renamed vitals)', () => {
    const wire = runTransform(RAW_HC_PAYLOAD)[0].json
    const knownVitalsKeys = new Set(Object.values(WIRE_VITALS))
    // If B renames or adds a vitals key A does not read, it lands here and fails loudly instead
    // of silently dropping on the live pipeline.
    for (const key of Object.keys(wire.vitals ?? {})) {
      expect(knownVitalsKeys.has(key)).toBe(true)
    }
    // And the anchored keys A actually reads are the ones B emits for the fields it carries.
    expect(Object.keys(wire.vitals ?? {})).toContain(WIRE_VITALS.restingHr)
    expect(Object.keys(wire.vitals ?? {})).toContain(WIRE_VITALS.hrAvg)
    expect(Object.keys(wire.vitals ?? {})).toContain(WIRE_VITALS.hrMin)
    expect(Object.keys(wire.vitals ?? {})).toContain(WIRE_VITALS.hrMax)
  })

  it('activity + top-level wire keys B emits are the ones A reads', () => {
    const wire = runTransform(RAW_HC_PAYLOAD)[0].json
    expect(wire.activity).toHaveProperty('steps')
    expect(wire.activity).toHaveProperty('active_kcal')
    expect(wire.activity).toHaveProperty('distance_m')
    expect(wire).toHaveProperty('synced_at')
    expect(wire).toHaveProperty('date')
  })
})
