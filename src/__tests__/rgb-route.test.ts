import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { isPublicApiPath } from '../web/public-paths.js'
import {
  tryHandleRgb,
  __setRgbExecFile,
  __resetRgbExecFile,
} from '../web/routes/rgb.js'

const RGB_SCRIPT = join(PROJECT_ROOT, 'scripts', 'rgb-lights.sh')

// Capturing stub for the injected execFile. Records every call so a test can
// assert BOTH that a safe request spawned with the validated argv AND that a
// rejected request never reached the spawn at all (the injection-direction).
interface ExecCall {
  file: string
  args: string[]
}
let calls: ExecCall[]
let execMode: 'ok' | 'crash'

function installStubExec() {
  calls = []
  execMode = 'ok'
  __setRgbExecFile(async (file: string, args: string[]) => {
    calls.push({ file, args })
    if (execMode === 'crash') throw new Error('rgb-lights.sh exited non-zero')
    return { stdout: '', stderr: '' }
  })
}

async function call(method: string, fullPath: string, body?: unknown, rawBody?: string) {
  const url = new URL('http://x' + fullPath)
  const payload =
    rawBody !== undefined ? [Buffer.from(rawBody)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
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
  const handled = await tryHandleRgb({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

beforeEach(() => installStubExec())
afterEach(() => __resetRgbExecFile())

describe('POST /api/rgb/lights -- happy path', () => {
  it('action "off" spawns the script with the validated argv', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'off' })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, action: 'off', color: null })
    expect(calls).toEqual([{ file: 'bash', args: [RGB_SCRIPT, 'off'] }])
  })

  it('action "on" with a valid color passes the color through as a separate argv element', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'on', color: '00FF99' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, action: 'on', color: '00FF99' })
    expect(calls).toEqual([{ file: 'bash', args: [RGB_SCRIPT, 'on', '00FF99'] }])
  })

  it('action "on" without a color omits the color arg (script applies its own default)', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'on' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, action: 'on', color: null })
    expect(calls).toEqual([{ file: 'bash', args: [RGB_SCRIPT, 'on'] }])
  })
})

describe('POST /api/rgb/lights -- validation (400, NO spawn)', () => {
  it('unknown action -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'blink' })
    expect(r.status).toBe(400)
    expect(r.body.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('missing action -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', { color: 'FF0000' })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('malformed color -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'on', color: 'FF00' })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('malformed JSON body -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', undefined, '{ not json')
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

// Injection-direction: assert on the DANGEROUS input, not just the safe one.
// execFile uses an argv array (no shell), so even a shell-metachar payload
// would be inert -- but the allowlist/regex must reject it BEFORE any spawn.
describe('POST /api/rgb/lights -- injection attempts are rejected pre-spawn', () => {
  it('action carrying a shell metachar payload -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'off; rm -rf ~' })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('color carrying a command-substitution payload -> 400 and never spawns', async () => {
    const r = await call('POST', '/api/rgb/lights', { action: 'on', color: '$(id)' })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('POST /api/rgb/lights -- spawn failure', () => {
  it('script failure -> 500 {ok:false,error}', async () => {
    execMode = 'crash'
    const r = await call('POST', '/api/rgb/lights', { action: 'off' })
    expect(r.status).toBe(500)
    expect(r.body.ok).toBe(false)
    expect(typeof r.body.error).toBe('string')
  })
})

describe('POST /api/rgb/lights -- routing + auth posture', () => {
  it('GET on the path is not claimed (falls through -> 404)', async () => {
    const r = await call('GET', '/api/rgb/lights')
    expect(r.handled).toBe(false)
  })

  it('an unrelated path is not claimed', async () => {
    const r = await call('POST', '/api/rgb/blinkenlights')
    expect(r.handled).toBe(false)
  })

  // The endpoint carries no in-handler auth by design: the central route-chain
  // gate (web.ts) 401s any non-public /api write before dispatch. Proving the
  // path is NOT in the public allowlist is what guarantees an unauthenticated
  // request is rejected with 401 upstream -- adding a second in-handler check
  // would diverge from the ack.ts pattern and double-gate.
  it('is gated: the path is not public for POST (central gate 401s unauth)', () => {
    expect(isPublicApiPath('/api/rgb/lights', 'POST')).toBe(false)
  })
})
