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

// Structural guard: the behavioural tests above prove bindServer is correct, but
// nothing stops a future edit from adding a fresh raw `server.listen(port)` next
// to it -- which is exactly how this defect got in. This is red on the pre-fix
// tree (src/web.ts:405).
describe('no host-less listen() call site survives in src/', () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        out.push(...tsFiles(full))
      } else if (name.endsWith('.ts')) {
        out.push(full)
      }
    }
    return out
  }

  function splitTopLevel(args: string): string[] {
    const parts: string[] = []
    let depth = 0, current = ''
    for (const ch of args) {
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      if (ch === ',' && depth === 0) { parts.push(current); current = '' } else current += ch
    }
    if (current.trim()) parts.push(current)
    return parts.map(p => p.trim())
  }

  const isCallback = (arg: string) => /^(\(|function\b|async\b)/.test(arg)

  // Measured, not assumed: without this the guard reported 6 false positives on
  // the real tree -- doc comments in config.ts/process-lock.ts that merely name
  // server.listen() while explaining it. Prose is not a call site.
  const isComment = (line: string) => /^(\/\/|\/\*|\*)/.test(line.trim())

  it('every .listen( passes an explicit host argument', () => {
    const violations: string[] = []
    for (const file of tsFiles(SRC_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, i) => {
        if (isComment(line)) return
        const m = /\.listen\((.*)\)/.exec(line)
        if (!m) return
        const args = splitTopLevel(m[1])
        if (args.length < 2 || isCallback(args[1])) {
          violations.push(`${file.slice(SRC_DIR.length)}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })
})
