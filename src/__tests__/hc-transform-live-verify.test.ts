import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  extractCanonicalNodeCode,
  sha256Hex,
  compareTransformDrift,
} from '../web/zepp/hc-transform-live-verify.js'

// WELL-027 WS5-a: the deployed n8n "Transform to Canonical Schema" node must stay
// byte-identical to the version-controlled HC_TRANSFORM_NODE_JS. These are the pure,
// I/O-free assertions the live-verify script builds on. The script fetches the live
// workflow over the n8n API and reads the repo string; here we prove the drift logic.

function wf(nodes: unknown[]): unknown {
  return { id: 'H4G6ga4FzfV6YDQ2', name: 'zepp-hc-ingest-transform', nodes }
}

describe('extractCanonicalNodeCode', () => {
  it('returns the jsCode of the node whose name contains "canonical" (case-insensitive)', () => {
    const code = extractCanonicalNodeCode(
      wf([
        { name: 'Webhook', parameters: {} },
        { name: 'Transform to Canonical Schema', parameters: { jsCode: 'return [];' } },
      ]),
    )
    expect(code).toBe('return [];')
  })

  it('matches regardless of the casing of the node name', () => {
    const code = extractCanonicalNodeCode(
      wf([{ name: 'TRANSFORM TO CANONICAL', parameters: { jsCode: 'x' } }]),
    )
    expect(code).toBe('x')
  })

  it('ignores a canonical-named node that has no jsCode and finds the real code node', () => {
    const code = extractCanonicalNodeCode(
      wf([
        { name: 'Canonical note', parameters: { value: 'not code' } },
        { name: 'Map to Canonical', parameters: { jsCode: 'real' } },
      ]),
    )
    expect(code).toBe('real')
  })

  it('throws when no canonical code node is present', () => {
    expect(() => extractCanonicalNodeCode(wf([{ name: 'Webhook', parameters: {} }]))).toThrow(
      /canonical/i,
    )
  })

  it('throws on a malformed workflow (no nodes array)', () => {
    expect(() => extractCanonicalNodeCode({ id: 'x' })).toThrow(/nodes/i)
    expect(() => extractCanonicalNodeCode(null)).toThrow()
  })
})

describe('sha256Hex', () => {
  it('is deterministic and matches node:crypto', () => {
    const s = 'const x = 1;'
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
  })

  it('is byte-sensitive (a trailing space changes the digest)', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('a '))
  })
})

describe('compareTransformDrift', () => {
  const repo = 'const _in = $input.first().json;\nreturn out;\n'

  it('reports inSync when the live node code equals the repo string', () => {
    const r = compareTransformDrift(
      wf([{ name: 'Transform to Canonical Schema', parameters: { jsCode: repo } }]),
      repo,
    )
    expect(r.inSync).toBe(true)
    expect(r.liveSha).toBe(r.repoSha)
    expect(r.liveLength).toBe(repo.length)
    expect(r.repoLength).toBe(repo.length)
  })

  it('reports drift when the live node code diverges by a single byte', () => {
    const drifted = repo + ' '
    const r = compareTransformDrift(
      wf([{ name: 'Transform to Canonical Schema', parameters: { jsCode: drifted } }]),
      repo,
    )
    expect(r.inSync).toBe(false)
    expect(r.liveSha).not.toBe(r.repoSha)
    expect(r.liveSha).toBe(sha256Hex(drifted))
    expect(r.repoSha).toBe(sha256Hex(repo))
    expect(r.liveLength).toBe(drifted.length)
  })

  it('propagates the extract error when the live workflow has no canonical node', () => {
    expect(() => compareTransformDrift(wf([{ name: 'x', parameters: {} }]), repo)).toThrow(
      /canonical/i,
    )
  })
})
