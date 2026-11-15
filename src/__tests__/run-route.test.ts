import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { isPublicApiPath } from '../web/public-paths.js'
import {
  tryHandleRun,
  __setRunExecFile,
  __resetRunExecFile,
} from '../web/routes/run.js'

const HIBIKI_PUSH_SCRIPT = join(PROJECT_ROOT, 'scripts', 'hibiki-daily-push.py')

// Capturing stub for the injected execFile. Records every call so a test can
// assert BOTH that the script is spawned with the hardcoded argv AND that no
// caller-controlled input ever reaches the spawn (injection-direction).
interface ExecCall {
  file: string
  args: string[]
}
let calls: ExecCall[]
let execMode: 'ok' | 'crash'

function installStubExec() {
  calls = []
  execMode = 'ok'
  __setRunExecFile(async (file: string, args: string[]) => {
    calls.push({ file, args })
    if (execMode === 'crash') throw new Error('hibiki-daily-push.py exited non-zero')
    return { stdout: '', stderr: '' }
  })
}

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(payload) as never
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
  const handled = await tryHandleRun({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

beforeEach(() => installStubExec())
afterEach(() => __resetRunExecFile())

describe('POST /api/run/hibiki-daily-push -- happy path', () => {
  it('spawns python3 with the hardcoded script path and no extra args', async () => {
    const r = await call('POST', '/api/run/hibiki-daily-push')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(calls).toEqual([{ file: 'python3', args: [HIBIKI_PUSH_SCRIPT] }])
  })

  // Injection-direction: the argv must be constant regardless of what the
  // caller sends in the request body. No body-derived value may reach the spawn.
  it('argv is constant even when a body is sent (no injection surface)', async () => {
    const r = await call('POST', '/api/run/hibiki-daily-push', { script: 'evil.py', args: ['--drop-all'] })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    // The spawn args must be EXACTLY [HIBIKI_PUSH_SCRIPT] -- no body content leaks through.
    expect(calls).toEqual([{ file: 'python3', args: [HIBIKI_PUSH_SCRIPT] }])
  })
})

describe('POST /api/run/hibiki-daily-push -- spawn failure', () => {
  it('script exits non-zero -> 500 {ok:false,error}', async () => {
    execMode = 'crash'
    const r = await call('POST', '/api/run/hibiki-daily-push')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)
    expect(typeof r.body.error).toBe('string')
  })
})

describe('POST /api/run/hibiki-daily-push -- routing + auth posture', () => {
  it('GET on the path is not claimed (falls through -> 404)', async () => {
    const r = await call('GET', '/api/run/hibiki-daily-push')
    expect(r.handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('an unrelated /api/run/* path is not claimed', async () => {
    const r = await call('POST', '/api/run/something-else')
    expect(r.handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  // The endpoint carries no in-handler auth by design: the central route-chain
  // gate (web.ts) 401s any non-public /api write before dispatch. Proving the
  // path is NOT in the public allowlist guarantees unauthenticated requests are
  // rejected with 401 upstream -- mirroring the rgb.ts / ack.ts posture.
  it('is gated: the path is not public for POST (central gate 401s unauth)', () => {
    expect(isPublicApiPath('/api/run/hibiki-daily-push', 'POST')).toBe(false)
  })
})
