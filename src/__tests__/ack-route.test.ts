import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleAck } from '../web/routes/ack.js'
import { isAckCapableInRegistry, ACK_TTL_MIN, ACK_TTL_MAX } from '../web/ack-registry.js'
import { MAIN_AGENT_ID } from '../config.js'

const TEST_DB = '/tmp/test-ack-route.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleAck({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

describe('POST /api/agents/:id/ack-declare (AV2-AC4)', () => {
  it('declares a known agent and returns 200 with the expiry', async () => {
    const r = await call('POST', '/api/agents/dave/ack-declare', { ttl_seconds: 86400 })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.agent_id).toBe('dave')
    expect(r.body.expires_at).toBe(r.body.declared_at + 86400)
    expect(isAckCapableInRegistry(getDb(), 'dave', r.body.declared_at)).toBe(true)
  })

  it('defaults to the 24h ttl when the body is empty', async () => {
    const r = await call('POST', '/api/agents/dave/ack-declare')
    expect(r.status).toBe(200)
    expect(r.body.expires_at - r.body.declared_at).toBe(86400)
  })

  it('is idempotent: a second declare upserts, one row, refreshed (AV2-AC10)', async () => {
    await call('POST', '/api/agents/dave/ack-declare')
    const r2 = await call('POST', '/api/agents/dave/ack-declare')
    expect(r2.status).toBe(200)
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM agent_ack_registry WHERE agent_id = ?')
      .get('dave') as { c: number }
    expect(count.c).toBe(1)
  })
})

describe('ttl clamping via the endpoint (AV2-AC5)', () => {
  it('clamps ttl 0 up to the 1h floor', async () => {
    const r = await call('POST', '/api/agents/dave/ack-declare', { ttl_seconds: 0 })
    expect(r.body.expires_at - r.body.declared_at).toBe(ACK_TTL_MIN)
  })

  it('clamps an oversized ttl down to the 7d cap', async () => {
    const r = await call('POST', '/api/agents/dave/ack-declare', { ttl_seconds: 9_999_999 })
    expect(r.body.expires_at - r.body.declared_at).toBe(ACK_TTL_MAX)
  })
})

describe('rejections', () => {
  it('unknown agent -> 400, no row written (AV2-AC6)', async () => {
    const r = await call('POST', '/api/agents/nonexistent-zzz/ack-declare')
    expect(r.status).toBe(400)
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM agent_ack_registry WHERE agent_id = ?')
      .get('nonexistent-zzz') as { c: number }
    expect(count.c).toBe(0)
  })

  it('main agent -> 400, no registry row (it is hardcoded capable, AV2-AC9)', async () => {
    const r = await call('POST', `/api/agents/${MAIN_AGENT_ID}/ack-declare`)
    expect(r.status).toBe(400)
    const count = getDb()
      .prepare('SELECT COUNT(*) AS c FROM agent_ack_registry WHERE agent_id = ?')
      .get(MAIN_AGENT_ID) as { c: number }
    expect(count.c).toBe(0)
  })

  it('malformed JSON body -> 400', async () => {
    const url = new URL('http://x/api/agents/dave/ack-declare')
    const req = Readable.from([Buffer.from('{ not json')]) as never
    const captured: { status: number } = { status: 200 }
    const res = {
      writeHead(s: number) {
        captured.status = s
        return res
      },
      end() {},
    } as never
    const handled = await tryHandleAck({ req, res, method: 'POST', path: url.pathname, url } as never)
    expect(handled).toBe(true)
    expect(captured.status).toBe(400)
  })

  it('non-POST on the ack-declare path is not claimed (falls through)', async () => {
    const r = await call('GET', '/api/agents/dave/ack-declare')
    expect(r.handled).toBe(false)
  })

  it('an unrelated path is not claimed', async () => {
    const r = await call('POST', '/api/agents/dave/avatar')
    expect(r.handled).toBe(false)
  })
})
