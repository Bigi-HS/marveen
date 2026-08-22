import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindServer, describeBinding } from '../web-bind.js'

// Card SEC/a805f9f0: src/web.ts had TWO listen() sites -- the normal one passed
// WEB_HOST, the port-reclaim one (inside the EADDRINUSE handler) did not. A
// host-less listen() binds to :: (every interface), so a port collision silently
// promoted the dashboard from loopback-only to publicly reachable, with no log
// line to say so. bindServer() is the single bind path both sites go through.

const SRC_DIR = join(fileURLToPath(new URL('../', import.meta.url)))

function listen(server: http.Server, ...args: [number] | [number, string]): Promise<void> {
  return new Promise(resolve => (server.listen as (...a: unknown[]) => unknown)(...args, resolve))
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

describe('bindServer', () => {
  const open: http.Server[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map(close))
  })

  // The control that makes the rest of this file meaningful: if node ever changed
  // its host-less default, the bug this card describes would not exist and this
  // test should be the one that says so, loudly.
  it('CONTROL: a host-less listen() binds to every interface, a host-scoped one does not', async () => {
    const wide = http.createServer(); open.push(wide)
    await listen(wide, 0)
    expect(describeBinding(wide)?.address).toBe('::')

    const narrow = http.createServer(); open.push(narrow)
    await listen(narrow, 0, '127.0.0.1')
    expect(describeBinding(narrow)?.address).toBe('127.0.0.1')
  })

  it('binds to the given host, not to every interface', async () => {
    const server = http.createServer(); open.push(server)
    await new Promise<void>(resolve => bindServer(server, 0, '127.0.0.1', () => resolve()))

    const bound = describeBinding(server)
    expect(bound).not.toBeNull()
    expect(bound?.address).toBe('127.0.0.1')
    expect(bound?.family).toBe('IPv4')
  })

  it('reports the binding it actually got, so the caller can log a measurement', async () => {
    const server = http.createServer(); open.push(server)
    await new Promise<void>(resolve => bindServer(server, 0, '127.0.0.1', () => resolve()))

    // The port is assigned by the kernel (0 = ephemeral): describeBinding must
    // read it back off the socket rather than echo the requested value.
    expect(describeBinding(server)?.port).toBeGreaterThan(0)
    expect(describeBinding(server)?.port).not.toBe(0)
  })

  it('returns null before the socket is listening', () => {
    const server = http.createServer(); open.push(server)
    expect(describeBinding(server)).toBeNull()
  })
})

// The structural half of this file moved to listen-host-guard.test.ts, which
// scans scripts/ as well. It was green here while two live host-less binds sat in
// scripts/ (DA-42 -> SEC/1d2a4fe0): a property of src/ read as a property of the
// defect class. Leaving the narrower duplicate would keep asserting the smaller
// claim next to the real one.
