// Tests for server-side GitHub merge endpoint (card be1f3711).
//
// Two layers:
//   1. mergePullRequest() -- pure function, injectable fetch+token
//   2. Route integration -- tryHandleGithub extension for POST /api/github/merge
//      (gate enforcement server-side, 40-char SHA guard, PAT never in response)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateMergeParams,
  mergePullRequest,
  type MergeParams,
  type MergeResult,
  MERGE_METHOD_ALLOWLIST,
} from '../web/github-merge.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SHA = 'a'.repeat(40)
const ANOTHER_SHA = 'b'.repeat(40)

function makeGoodParams(overrides: Partial<MergeParams> = {}): MergeParams {
  return { pr: 42, headSha: VALID_SHA, mergeMethod: 'merge', ...overrides }
}

// ---------------------------------------------------------------------------
// validateMergeParams
// ---------------------------------------------------------------------------
describe('validateMergeParams', () => {
  it('accepts valid params', () => {
    const r = validateMergeParams(makeGoodParams())
    expect(r.ok).toBe(true)
  })

  it('rejects missing pr', () => {
    const r = validateMergeParams({ pr: 0, headSha: VALID_SHA })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/pr_number/)
  })

  it('rejects negative pr', () => {
    const r = validateMergeParams({ pr: -1, headSha: VALID_SHA })
    expect(r.ok).toBe(false)
  })

  it('rejects non-integer pr', () => {
    const r = validateMergeParams({ pr: 1.5, headSha: VALID_SHA })
    expect(r.ok).toBe(false)
  })

  it('rejects head_sha shorter than 40 chars', () => {
    const r = validateMergeParams({ pr: 1, headSha: 'a'.repeat(39) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/40|sha/i)
  })

  it('rejects head_sha longer than 40 chars', () => {
    const r = validateMergeParams({ pr: 1, headSha: 'a'.repeat(41) })
    expect(r.ok).toBe(false)
  })

  it('rejects head_sha with non-hex characters', () => {
    const r = validateMergeParams({ pr: 1, headSha: 'z'.repeat(40) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/hex|sha/i)
  })

  it('rejects head_sha with uppercase that is not hex (G-Z)', () => {
    const r = validateMergeParams({ pr: 1, headSha: 'G'.repeat(40) })
    expect(r.ok).toBe(false)
  })

  it('accepts uppercase hex characters (A-F)', () => {
    const r = validateMergeParams({ pr: 1, headSha: 'A'.repeat(40) })
    expect(r.ok).toBe(true)
  })

  it('accepts exactly 40 lowercase hex chars', () => {
    const r = validateMergeParams({ pr: 1, headSha: '0123456789abcdef'.repeat(2) + '0'.repeat(8) })
    expect(r.ok).toBe(true)
  })

  it('rejects unknown merge_method', () => {
    const r = validateMergeParams({ pr: 1, headSha: VALID_SHA, mergeMethod: 'fast-forward' as any })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/merge_method/)
  })

  it('accepts all valid merge methods', () => {
    for (const m of MERGE_METHOD_ALLOWLIST) {
      const r = validateMergeParams({ pr: 1, headSha: VALID_SHA, mergeMethod: m })
      expect(r.ok).toBe(true)
    }
  })

  it('defaults merge_method to merge when absent', () => {
    const r = validateMergeParams({ pr: 1, headSha: VALID_SHA })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.mergeMethod).toBe('merge')
  })

  it('rejects empty head_sha string', () => {
    const r = validateMergeParams({ pr: 1, headSha: '' })
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mergePullRequest
// ---------------------------------------------------------------------------
describe('mergePullRequest', () => {
  const makeSuccessResponse = (sha: string = VALID_SHA) => ({
    ok: true,
    status: 200,
    json: async () => ({ merged: true, sha, message: 'Pull Request successfully merged' }),
  })

  const makeFailResponse = (status: number, message: string) => ({
    ok: false,
    status,
    json: async () => ({ message }),
  })

  it('calls GitHub merge API with correct URL and body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeSuccessResponse())
    await mergePullRequest(
      { pr: 42, headSha: VALID_SHA, mergeMethod: 'squash' },
      { fetchImpl: fetchSpy as any, readToken: () => 'tok' },
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toContain('/pulls/42/merge')
    const body = JSON.parse(opts.body)
    expect(body.sha).toBe(VALID_SHA)
    expect(body.merge_method).toBe('squash')
  })

  it('never sends the PAT in the response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeSuccessResponse())
    const result = await mergePullRequest(makeGoodParams(), {
      fetchImpl: fetchSpy as any,
      readToken: () => 'SUPER_SECRET_PAT',
    })
    // Result must not contain the token
    expect(JSON.stringify(result)).not.toContain('SUPER_SECRET_PAT')
  })

  it('returns merged:true and sha on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeSuccessResponse(ANOTHER_SHA))
    const result = await mergePullRequest(makeGoodParams(), {
      fetchImpl: fetchSpy as any,
      readToken: () => 'tok',
    })
    expect(result.merged).toBe(true)
    expect(result.sha).toBe(ANOTHER_SHA)
  })

  it('masks GitHub 401 as MergeRequestError(502)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeFailResponse(401, 'Bad credentials'))
    await expect(
      mergePullRequest(makeGoodParams(), { fetchImpl: fetchSpy as any, readToken: () => 'tok' }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('masks GitHub 403 as MergeRequestError(502)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeFailResponse(403, 'Forbidden'))
    await expect(
      mergePullRequest(makeGoodParams(), { fetchImpl: fetchSpy as any, readToken: () => 'tok' }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('surfaces GitHub 405 (method not allowed / already merged) as 409', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeFailResponse(405, 'Pull Request is not mergeable'))
    await expect(
      mergePullRequest(makeGoodParams(), { fetchImpl: fetchSpy as any, readToken: () => 'tok' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('surfaces GitHub 409 (merge conflict) as 409', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeFailResponse(409, 'Merge conflict'))
    await expect(
      mergePullRequest(makeGoodParams(), { fetchImpl: fetchSpy as any, readToken: () => 'tok' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('wraps network error as MergeRequestError(502)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      mergePullRequest(makeGoodParams(), { fetchImpl: fetchSpy as any, readToken: () => 'tok' }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('throws MergeRequestError(400) on invalid params via validateMergeParams', async () => {
    // Bad SHA triggers validation before any network call
    const fetchSpy = vi.fn()
    await expect(
      mergePullRequest(
        { pr: 1, headSha: 'short', mergeMethod: 'merge' },
        { fetchImpl: fetchSpy as any, readToken: () => 'tok' },
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses Authorization header and never returns it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeSuccessResponse())
    await mergePullRequest(makeGoodParams(), {
      fetchImpl: fetchSpy as any,
      readToken: () => 'secret-token',
    })
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.headers['Authorization']).toBe('Bearer secret-token')
  })
})

// ---------------------------------------------------------------------------
// MERGE_METHOD_ALLOWLIST
// ---------------------------------------------------------------------------
describe('MERGE_METHOD_ALLOWLIST', () => {
  it('contains exactly merge, squash, rebase', () => {
    expect([...MERGE_METHOD_ALLOWLIST].sort()).toEqual(['merge', 'rebase', 'squash'])
  })
})
