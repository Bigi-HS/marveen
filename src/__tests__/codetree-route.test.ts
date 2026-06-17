import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import {
  initCodetreeDatabase,
  replaceIndexData,
  setIndexMeta,
} from '../web/codetree-db.js'
import { tryHandleCodetree, __setCodetreeRebuildRunner, __setImpactDepsBuilder } from '../web/routes/codetree.js'
import { realImpactDeps } from '../web/codetree-impact-io.js'
import type { ImpactDeps } from '../web/codetree-impact.js'
import type { RebuildSummary } from '../web/codetree-rebuild.js'

const TEST_DB = '/tmp/test-codetree-route.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleCodetree({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

function seedFresh() {
  replaceIndexData(
    [
      { name: 'saveAgentMemory', kind: 'function', file: 'src/db.ts', line: 826, exported: true },
      { name: 'internalHelper', kind: 'function', file: 'src/db.ts', line: 5, exported: false },
    ],
    [{ from_file: 'src/server.ts', to_module: './db.js', imported_names: ['saveAgentMemory'] }],
  )
  setIndexMeta({ indexed_at: Math.floor(Date.now() / 1000), files_count: 2, symbols_count: 2, imports_count: 1 })
}

beforeEach(() => {
  cleanDb()
  initCodetreeDatabase(TEST_DB)
  // reset to the real (spawn) runner default by injecting a no-op safe stub per test as needed
})
afterAll(() => cleanDb())

describe('GET /api/codetree/symbol (CT-AC1)', () => {
  it('returns 503 before any rebuild', async () => {
    expect((await call('GET', '/api/codetree/symbol?name=x')).status).toBe(503)
  })
  it('400 when name param is missing or empty', async () => {
    seedFresh()
    expect((await call('GET', '/api/codetree/symbol')).status).toBe(400)
    expect((await call('GET', '/api/codetree/symbol?name=')).status).toBe(400)
  })
  it('returns the matching symbol with an indexed_at envelope', async () => {
    seedFresh()
    const r = await call('GET', '/api/codetree/symbol?name=saveAgentMemory')
    expect(r.status).toBe(200)
    expect(r.body.indexed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(r.body.results).toHaveLength(1)
    expect(r.body.results[0]).toMatchObject({ file: 'src/db.ts', line: 826, exported: true })
  })
  it('returns 200 with empty results on no match', async () => {
    seedFresh()
    const r = await call('GET', '/api/codetree/symbol?name=nope')
    expect(r.status).toBe(200)
    expect(r.body.results).toEqual([])
  })
})

describe('GET /api/codetree/exports (CT-AC2)', () => {
  it('400 when file param missing', async () => {
    seedFresh()
    expect((await call('GET', '/api/codetree/exports')).status).toBe(400)
  })
  it('503 before any rebuild', async () => {
    expect((await call('GET', '/api/codetree/exports?file=src/db.ts')).status).toBe(503)
  })
  it('200 with only exported symbols', async () => {
    seedFresh()
    const r = await call('GET', '/api/codetree/exports?file=src/db.ts')
    expect(r.status).toBe(200)
    expect(r.body.file).toBe('src/db.ts')
    expect(r.body.exports.map((e: any) => e.name)).toEqual(['saveAgentMemory'])
  })
  it('404 when the file was never indexed', async () => {
    seedFresh()
    expect((await call('GET', '/api/codetree/exports?file=src/ghost.ts')).status).toBe(404)
  })
})

describe('GET /api/codetree/importers (CT-AC3)', () => {
  it('400 when module param missing', async () => {
    seedFresh()
    expect((await call('GET', '/api/codetree/importers')).status).toBe(400)
  })
  it('matches relative and repo-relative forms identically', async () => {
    seedFresh()
    const repo = await call('GET', '/api/codetree/importers?module=src/db.ts')
    const rel = await call('GET', '/api/codetree/importers?module=./db')
    expect(repo.status).toBe(200)
    expect(repo.body.importers.map((i: any) => i.from_file)).toContain('src/server.ts')
    expect(rel.body.importers).toEqual(repo.body.importers)
  })
})

describe('GET /api/codetree/meta (CT-AC4)', () => {
  it('503 before any rebuild', async () => {
    expect((await call('GET', '/api/codetree/meta')).status).toBe(503)
  })
  it('200 with stale=false right after a rebuild', async () => {
    seedFresh()
    const r = await call('GET', '/api/codetree/meta')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ files_count: 2, symbols_count: 2, imports_count: 1, stale: false })
  })
  it('stale=true when indexed_at is older than 24h (CT-SEC1)', async () => {
    replaceIndexData([], [])
    setIndexMeta({ indexed_at: Math.floor(Date.now() / 1000) - 25 * 3600, files_count: 1, symbols_count: 0, imports_count: 0 })
    const r = await call('GET', '/api/codetree/meta')
    expect(r.body.stale).toBe(true)
  })
})

describe('POST /api/codetree/rebuild (CT-AC5, CT-AC6)', () => {
  const fakeSummary: RebuildSummary = {
    files_indexed: 160, symbols_indexed: 1842, imports_indexed: 634,
    duration_ms: 4200, indexed_at: '2026-06-17T10:00:00.000Z', files_skipped: [],
  }

  it('returns 200 with the rebuild summary', async () => {
    __setCodetreeRebuildRunner(async () => fakeSummary)
    const r = await call('POST', '/api/codetree/rebuild')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'ok', files_indexed: 160, symbols_indexed: 1842 })
  })

  it('returns 500 when the rebuild runner throws', async () => {
    __setCodetreeRebuildRunner(async () => { throw new Error('boom') })
    const r = await call('POST', '/api/codetree/rebuild')
    expect(r.status).toBe(500)
  })

  it('a second concurrent rebuild returns 409', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    __setCodetreeRebuildRunner(async () => { await gate; return fakeSummary })

    const first = call('POST', '/api/codetree/rebuild')
    // allow the first call to acquire the lock before firing the second
    await new Promise((r) => setImmediate(r))
    const second = await call('POST', '/api/codetree/rebuild')
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/in progress/i)

    release()
    expect((await first).status).toBe(200)
  })

  it('the lock is released after a rebuild so a later rebuild succeeds', async () => {
    __setCodetreeRebuildRunner(async () => fakeSummary)
    expect((await call('POST', '/api/codetree/rebuild')).status).toBe(200)
    expect((await call('POST', '/api/codetree/rebuild')).status).toBe(200)
  })
})

describe('GET /api/codetree/impact', () => {
  function stubDeps(over: Partial<ImpactDeps> = {}): ImpactDeps {
    return {
      importersOf: (f) => (f === 'src/a.ts' ? ['src/b.ts'] : []),
      allSymbols: () => [{ name: 'fooBar', kind: 'function', file: 'src/a.ts', line: 1, exported: true }],
      specCorpus: () => [{ path: 'store/specs/x.md', text: 'foo bar fooBar' }],
      searchHotMemory: () => [],
      getCard: (id) => (id === 'good' ? { title: 'foo bar', description: '' } : null),
      getCardFiles: () => null,
      diffFiles: () => ['src/a.ts'],
      index: () => ({ indexed_at: 123, stale: false }),
      ...over,
    }
  }

  afterAll(() => __setImpactDepsBuilder(realImpactDeps))

  it('400 when neither diff nor card is given', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    expect((await call('GET', '/api/codetree/impact')).status).toBe(400)
  })

  it('400 when both diff and card are given', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    expect((await call('GET', '/api/codetree/impact?diff=x&card=good')).status).toBe(400)
  })

  it('400 on a malformed card id (no glob/traversal into the ref scan)', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    expect((await call('GET', '/api/codetree/impact?card=a*b')).status).toBe(400)
  })

  it('400 on a leading-dash diff ref (git argument injection guard)', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    // a `-`-prefixed ref would be parsed by git as an option (e.g. --output=<file>)
    expect((await call('GET', '/api/codetree/impact?diff=' + encodeURIComponent('--output=/tmp/x'))).status).toBe(400)
    expect((await call('GET', '/api/codetree/impact?diff=' + encodeURIComponent('-rf'))).status).toBe(400)
  })

  it('503 before the index is built', async () => {
    cleanDb()
    initCodetreeDatabase(TEST_DB)
    __setImpactDepsBuilder(() => stubDeps())
    expect((await call('GET', '/api/codetree/impact?diff=develop...HEAD')).status).toBe(503)
  })

  it('diff mode: 200 with seed files + transitive blast radius', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    const r = await call('GET', '/api/codetree/impact?diff=develop...HEAD')
    expect(r.status).toBe(200)
    expect(r.body.input.kind).toBe('diff')
    expect(r.body.seed_files).toEqual(['src/a.ts'])
    expect(r.body.affected).toContainEqual({ file: 'src/b.ts', depth: 1 })
  })

  it('card mode keyword resolution: symbols carry the also_in_spec flag', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    const r = await call('GET', '/api/codetree/impact?card=good')
    expect(r.status).toBe(200)
    expect(r.body.input.resolution).toBe('keyword')
    expect(r.body.symbols[0]).toMatchObject({ name: 'fooBar', also_in_spec: ['store/specs/x.md'] })
  })

  it('404 on an unknown card', async () => {
    seedFresh()
    __setImpactDepsBuilder(() => stubDeps())
    expect((await call('GET', '/api/codetree/impact?card=missing')).status).toBe(404)
  })
})
