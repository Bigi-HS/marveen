import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZeppCloudCreds } from '../web/zepp/creds-reader.js'

const dir = mkdtempSync(join(tmpdir(), 'zepp-creds-'))
const paths: string[] = []
function credsFile(obj: object): string {
  const p = join(dir, `c-${paths.length}.json`)
  writeFileSync(p, JSON.stringify(obj))
  paths.push(p)
  return p
}

afterEach(() => {
  for (const p of paths.splice(0)) rmSync(p, { force: true })
})

describe('readZeppCloudCreds', () => {
  it('reads the captured shape (app_token/user_id/host)', () => {
    const p = credsFile({ app_token: 'TOK', user_id: '7054735479', host: 'api-mifit-de2.zepp.com', region_host: 'de2' })
    expect(readZeppCloudCreds(p)).toEqual({
      appToken: 'TOK',
      userId: '7054735479',
      host: 'api-mifit-de2.zepp.com',
    })
  })

  it('accepts the documented guide shape (apptoken/userid/region) and maps region->host', () => {
    const p = credsFile({ apptoken: 'TOK', userid: '7054735479', region: 'de2' })
    expect(readZeppCloudCreds(p)).toEqual({
      appToken: 'TOK',
      userId: '7054735479',
      host: 'api-mifit-de2.zepp.com',
    })
  })

  it('throws a clear error when the token is missing', () => {
    const p = credsFile({ user_id: '7054735479', host: 'api-mifit-de2.zepp.com' })
    expect(() => readZeppCloudCreds(p)).toThrow(/apptoken/i)
  })

  it('throws when the user id is missing', () => {
    const p = credsFile({ app_token: 'TOK', host: 'api-mifit-de2.zepp.com' })
    expect(() => readZeppCloudCreds(p)).toThrow(/user/i)
  })

  it('throws a not-found error for a missing file', () => {
    expect(() => readZeppCloudCreds(join(dir, 'nope.json'))).toThrow(/not found/i)
  })
})
