// P0.5 raw-retention buffer (card 0b467f56).
// Bounded retention of raw HC push bodies for TC-1 / AT-1 Layer-2 test corpus.
// PII note: payloads contain health data; the buffer file lives in store/ (gitignored).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RawPushBuffer, BUFFER_CAP } from '../web/zepp/raw-push-buffer.js'

function makeTmpBuffer(cap?: number): { buf: RawPushBuffer; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'raw-push-buf-test-'))
  const buf = new RawPushBuffer(join(dir, 'test-buffer.jsonl'), cap)
  return { buf, dir }
}

describe('RawPushBuffer', () => {
  let dir: string
  let buf: RawPushBuffer

  beforeEach(() => {
    const t = makeTmpBuffer()
    buf = t.buf
    dir = t.dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // AC-1: every push-body is retained
  it('AC-1: retains a single push body', () => {
    buf.retain('{"date":"2026-08-27","activity":{"steps":10000}}')
    const all = buf.readAll()
    expect(all).toHaveLength(1)
    expect(all[0]).toBe('{"date":"2026-08-27","activity":{"steps":10000}}')
  })

  it('AC-1: retains multiple pushes in arrival order', () => {
    buf.retain('{"push":1}')
    buf.retain('{"push":2}')
    buf.retain('{"push":3}')
    const all = buf.readAll()
    expect(all).toHaveLength(3)
    expect(all[0]).toBe('{"push":1}')
    expect(all[2]).toBe('{"push":3}')
  })

  it('AC-1: readAll on an empty buffer returns an empty array', () => {
    expect(buf.readAll()).toEqual([])
  })

  // AC-2: retention cap enforced (oldest dropped, newest kept)
  it('AC-2: rotation drops the oldest entry when cap is exceeded', () => {
    const cap = 3
    const { buf: b, dir: d } = makeTmpBuffer(cap)
    b.retain('{"push":1}')
    b.retain('{"push":2}')
    b.retain('{"push":3}')
    b.retain('{"push":4}') // overflow -> push 1 dropped
    const all = b.readAll()
    expect(all).toHaveLength(cap)
    expect(all[0]).toBe('{"push":2}')
    expect(all[cap - 1]).toBe('{"push":4}')
    rmSync(d, { recursive: true, force: true })
  })

  it('AC-2: buffer never grows beyond cap', () => {
    const cap = 5
    const { buf: b, dir: d } = makeTmpBuffer(cap)
    for (let i = 0; i < 20; i++) b.retain(`{"push":${i}}`)
    expect(b.readAll()).toHaveLength(cap)
    rmSync(d, { recursive: true, force: true })
  })

  it('AC-2: BUFFER_CAP constant is between 30 and 50 (bounded per spec)', () => {
    expect(BUFFER_CAP).toBeGreaterThanOrEqual(30)
    expect(BUFFER_CAP).toBeLessThanOrEqual(50)
  })

  // AC-3: a retained payload is readable and passable to ingest-handler in a test
  it('AC-3: retained payload round-trips through readAll and is parseable JSON', () => {
    const payload = JSON.stringify({
      date: '2026-08-27',
      vitals: { resting_hr_bpm: 52 },
      activity: { steps: 12000, distance_m: 9500 },
    })
    buf.retain(payload)
    const [retrieved] = buf.readAll()
    const parsed = JSON.parse(retrieved)
    expect(parsed.date).toBe('2026-08-27')
    expect(parsed.activity.steps).toBe(12000)
  })

  it('AC-3: payloads with embedded newlines or quotes survive the JSONL round-trip', () => {
    const tricky = '{"msg":"hello\\nworld","q":"it\\"s ok"}'
    buf.retain(tricky)
    const [retrieved] = buf.readAll()
    expect(retrieved).toBe(tricky)
  })
})
