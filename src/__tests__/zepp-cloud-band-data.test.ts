import { describe, it, expect, vi } from 'vitest'
import {
  pullCloudSleep,
  parseBandDataDay,
  buildBandDataUrl,
  type CloudPullDeps,
} from '../web/zepp/cloud-band-data.js'
import { ZeppAuthError, ZeppEndpointError } from '../web/zepp/puller.js'

// Real 2026-09-09 night as it arrives from the de2 cloud band_data.json endpoint.
// The `summary` field is a JSON string whose `slp` object carries the same
// dp/lt/rem/dt fields as the local-DB DATE_DATA.SUMMARY -- net = dp+lt+rem = 464.
const SUMMARY_0909 = JSON.stringify({
  v: 6,
  slp: { st: 1788902400, ed: 1788939660, dp: 142, lt: 322, rem: 0, dt: 145, ss: 78 },
})

// band_data.json returns a day array; each element has a date and a stringified summary.
const BAND_DATA_0909 = {
  code: 1,
  message: 'success',
  data: [{ date_time: '2026-09-09', summary: SUMMARY_0909, source: 'watch', type: 0 }],
}

function makeDeps(fetchResponse: object, status = 200): CloudPullDeps {
  return {
    host: 'api-mifit-de2.zepp.com',
    appToken: 'test-apptoken',
    userId: '7054735479',
    fetch: vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => fetchResponse,
    } as Response)),
  }
}

describe('buildBandDataUrl', () => {
  it('targets band_data.json on the de2 host with a from/to window and userid', () => {
    const url = buildBandDataUrl('api-mifit-de2.zepp.com', '7054735479', '2026-09-09', '2026-09-09')
    expect(url).toContain('https://api-mifit-de2.zepp.com/v1/data/band_data.json')
    expect(url).toContain('query_type=summary')
    expect(url).toContain('from_date=2026-09-09')
    expect(url).toContain('to_date=2026-09-09')
    expect(url).toContain('userid=7054735479')
    expect(url).toContain('device_type=android_phone')
  })
})

describe('parseBandDataDay', () => {
  it('extracts net sleep (dp+lt+rem=464) from a band_data day summary', () => {
    const day = BAND_DATA_0909.data[0]
    const sleep = parseBandDataDay(day, '2026-09-09')
    expect(sleep).not.toBeNull()
    expect(sleep!.durationMin).toBe(464)
    expect(sleep!.stages).toEqual({ deep: 142, light: 322, rem: 0, awake: 145 })
    expect(sleep!.score).toBe(78)
  })

  it('decodes a base64-encoded summary (older band firmware)', () => {
    const b64 = Buffer.from(SUMMARY_0909, 'utf8').toString('base64')
    const day = { date_time: '2026-09-09', summary: b64 }
    const sleep = parseBandDataDay(day, '2026-09-09')
    expect(sleep).not.toBeNull()
    expect(sleep!.durationMin).toBe(464)
  })

  it('returns null for a day with no slp block', () => {
    const day = { date_time: '2026-09-09', summary: JSON.stringify({ v: 6, stp: { ttl: 5000 } }) }
    expect(parseBandDataDay(day, '2026-09-09')).toBeNull()
  })

  it('returns null for a malformed summary', () => {
    expect(parseBandDataDay({ date_time: '2026-09-09', summary: 'not-json' }, '2026-09-09')).toBeNull()
  })
})

describe('pullCloudSleep', () => {
  it('pulls and parses the accurate net sleep for the requested date', async () => {
    const deps = makeDeps(BAND_DATA_0909)
    const sleep = await pullCloudSleep('2026-09-09', deps)
    expect(sleep).not.toBeNull()
    expect(sleep!.durationMin).toBe(464)
  })

  it('sends the apptoken header (not Bearer) and hits the band_data endpoint', async () => {
    const deps = makeDeps(BAND_DATA_0909)
    await pullCloudSleep('2026-09-09', deps)
    const call = (deps.fetch as any).mock.calls[0]
    const url: string = call[0]
    const opts: RequestInit = call[1]
    expect(url).toContain('/v1/data/band_data.json')
    expect((opts.headers as Record<string, string>)['apptoken']).toBe('test-apptoken')
    expect((opts.headers as Record<string, string>)['appPlatform']).toBe('android_phone')
    expect((opts.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('picks the matching date out of a multi-day window response', async () => {
    const multi = {
      code: 1,
      data: [
        { date_time: '2026-09-08', summary: JSON.stringify({ slp: { dp: 100, lt: 100, rem: 0, dt: 10 } }) },
        { date_time: '2026-09-09', summary: SUMMARY_0909 },
      ],
    }
    const deps = makeDeps(multi)
    const sleep = await pullCloudSleep('2026-09-09', deps)
    expect(sleep!.durationMin).toBe(464)
  })

  it('returns null when the date is absent from the response', async () => {
    const deps = makeDeps({ code: 1, data: [] })
    expect(await pullCloudSleep('2026-09-09', deps)).toBeNull()
  })

  it('throws ZeppAuthError on 401 (expired/invalid apptoken -> surfaces for re-capture)', async () => {
    const deps = makeDeps({}, 401)
    await expect(pullCloudSleep('2026-09-09', deps)).rejects.toBeInstanceOf(ZeppAuthError)
  })

  it('throws ZeppEndpointError on 5xx (endpoint drift alert)', async () => {
    const deps = makeDeps({}, 503)
    await expect(pullCloudSleep('2026-09-09', deps)).rejects.toBeInstanceOf(ZeppEndpointError)
  })
})
