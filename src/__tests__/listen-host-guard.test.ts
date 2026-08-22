import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Card SEC/a805f9f0 shipped a guard asserting that no `.listen(` call site omits
// its host. It was scoped to src/ and it was green -- and it was green while two
// live siblings sat in scripts/, found afterwards by an adversarial reviewer
// (DA-42 -> card SEC/1d2a4fe0). The guard was not wrong, it was NARROW: I proved
// a property of one directory and read it as a property of the defect class.
//
// So the scope moves to where the class actually lives. The two known sites are
// listed by name below rather than suppressed silently: a bound that is not shown
// reads as "we covered everything".

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCAN_DIRS = ['src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git'])

// Live, carded, NOT fixed here. These bind an OAuth redirect receiver to every
// interface; the fix belongs with the missing state nonce on SEC/1d2a4fe0, under
// security review, not smuggled in through a lint change. This list is a RATCHET:
// fix one and this test goes red until you remove it from here, add a new one and
// it goes red immediately.
const KNOWN_UNFIXED = [
  'scripts/google-oauth-authorize.ts:54',
  'scripts/youtube-oauth-authorize.ts:50',
]

// MEASURED false positive: python's socket.listen(BACKLOG) takes a connection
// queue depth, not a host -- the host comes from the bind() above it
// (scripts/n8n-kanban-bridge.py:93 does exactly that). So a python listen() is
// only exempt when the file actually calls bind(); no bind, no exemption.
//
// The first version of this exemption keyed on the ARGUMENT SHAPE instead
// (BACKLOG|backlog|\d+), which read as harmless and was not: `listen(3420)` is
// the single most common form of the very defect this guard exists for, and a
// planted probe walked straight through the green suite. Measured, not reasoned:
// the mutation test below is what caught it.
const isPython = (file: string) => file.endsWith('.py')
const setsHostViaBind = (source: string) => /\.bind\(/.test(source)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|js|mjs|cjs|py)$/.test(name)) out.push(full)
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

const isComment = (line: string) => /^(\/\/|\/\*|\*|#)/.test(line.trim())
const isCallback = (arg: string) => /^(\(|function\b|async\b|lambda\b)/.test(arg)

function hostlessListenSites(): string[] {
  const sites: string[] = []
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const source = readFileSync(file, 'utf-8')
      if (isPython(file) && setsHostViaBind(source)) continue
      source.split('\n').forEach((line, i) => {
        if (isComment(line)) return
        const m = /\.listen\((.*)\)/.exec(line)
        if (!m) return
        const args = splitTopLevel(m[1])
        if (args.length < 2 || isCallback(args[1])) {
          sites.push(`${relative(ROOT, file)}:${i + 1}`)
        }
      })
    }
  }
  return sites.sort()
}

describe('no server binds without an explicit host', () => {
  it('finds exactly the known-unfixed sites, and no new ones', () => {
    const sites = hostlessListenSites()

    const unexpected = sites.filter(s => !KNOWN_UNFIXED.includes(s))
    expect(unexpected).toEqual([])

    // The other direction, so the list cannot rot into a rubber stamp: an entry
    // that no longer reproduces must be removed rather than left as decoration.
    const stale = KNOWN_UNFIXED.filter(s => !sites.includes(s))
    expect(stale).toEqual([])
  })

  it('CONTROL: the detector bites on a host-less listen and not on an anchored one', () => {
    // Same detector shape, run over synthetic lines, so a green run above cannot
    // mean "the regex stopped matching anything".
    const detect = (line: string) => {
      if (isComment(line)) return false
      const m = /\.listen\((.*)\)/.exec(line)
      if (!m) return false
      const args = splitTopLevel(m[1])
      return args.length < 2 || isCallback(args[1])
    }

    expect(detect('    server.listen(PORT)')).toBe(true)
    expect(detect('    server.listen(port, () => done())')).toBe(true)
    // The literal-port form. The first version of this guard exempted it as if it
    // were a socket backlog, which let a planted probe through a green suite.
    expect(detect('    server.listen(3420)')).toBe(true)
    expect(detect("    server.listen(port, WEB_HOST, () => {})")).toBe(false)
    expect(detect("    server.listen(0, '127.0.0.1')")).toBe(false)
  })

  it('CONTROL: a python socket listen is exempt only because bind() sets the host', () => {
    const socketFile = 'server.bind((LISTEN_HOST, LISTEN_PORT))\nserver.listen(BACKLOG)\n'
    expect(isPython('x.py') && setsHostViaBind(socketFile)).toBe(true)

    // Same call, no bind anywhere: the exemption must not apply.
    expect(isPython('x.py') && setsHostViaBind('server.listen(BACKLOG)\n')).toBe(false)
    // And the exemption is python-only -- it must never cover a TS bind site.
    expect(isPython('x.ts') && setsHostViaBind(socketFile)).toBe(false)
  })

  it('scans both directories, so a green result is not an empty result', () => {
    const counts = SCAN_DIRS.map(d => sourceFiles(join(ROOT, d)).length)
    counts.forEach(c => expect(c).toBeGreaterThan(10))
  })
})
