import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  setBranchProtection,
  validateBranchProtectionParams,
  BranchProtectionError,
  PROTECTED_BRANCHES,
} from '../web/github-branch-protection.js'

// POST /api/github/branch-protection -- server-side branch protection route.
//
// Security surface: a new outbound GitHub write (PUT /branches/{branch}/protection).
// Fail-closed: ONLY the two hardcoded branches (main, develop) may be targeted.
// A free-string branch param is NOT accepted -- this is NOT a general branch-
// protection-writer; it enforces a fixed security baseline on the two protected
// refs (force_pushes=false, deletions=false).
//
// Chad SEC pre-gate required; test suite mirrors the adversarial fixture discipline.

// ── validateBranchProtectionParams ──────────────────────────────────────────

describe('validateBranchProtectionParams', () => {
  it('accepts main', () => {
    const r = validateBranchProtectionParams({ branch: 'main' })
    expect(r.ok).toBe(true)
  })

  it('accepts develop', () => {
    const r = validateBranchProtectionParams({ branch: 'develop' })
    expect(r.ok).toBe(true)
  })

  it('rejects arbitrary branch (fail-closed, not a general writer)', () => {
    const r = validateBranchProtectionParams({ branch: 'feature/x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/allowlist/)
  })

  it('rejects missing branch', () => {
    const r = validateBranchProtectionParams({})
    expect(r.ok).toBe(false)
  })

  it('rejects blank branch', () => {
    const r = validateBranchProtectionParams({ branch: '  ' })
    expect(r.ok).toBe(false)
  })

  it('rejects null branch', () => {
    const r = validateBranchProtectionParams({ branch: null })
    expect(r.ok).toBe(false)
  })

  it('rejects path-traversal attempt', () => {
    const r = validateBranchProtectionParams({ branch: '../main' })
    expect(r.ok).toBe(false)
  })

  it('rejects injection attempt with special chars', () => {
    const r = validateBranchProtectionParams({ branch: 'main; rm -rf' })
    expect(r.ok).toBe(false)
  })

  it('PROTECTED_BRANCHES contains exactly main and develop', () => {
    expect(PROTECTED_BRANCHES).toEqual(['main', 'develop'])
  })
})

// ── setBranchProtection ──────────────────────────────────────────────────────

describe('setBranchProtection', () => {
  const mockFetch = vi.fn()
  const mockReadToken = vi.fn().mockReturnValue('tok')
  const deps = { fetchImpl: mockFetch as any, readToken: mockReadToken }

  beforeEach(() => vi.resetAllMocks())

  it('calls PUT /repos/.../branches/main/protection with correct body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://api.github.com/repos/Bigi-HS/marveen/branches/main/protection' }),
    })
    const result = await setBranchProtection('main', deps)
    expect(result.branch).toBe('main')
    expect(result.applied).toBe(true)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/branches/main/protection')
    const body = JSON.parse(init.body as string)
    // force_pushes=false and allow_deletions=false are the security baseline
    expect(body.allow_force_pushes).toBe(false)
    expect(body.allow_deletions).toBe(false)
    // required_status_checks required by GitHub branch protection API (can be null)
    expect('required_status_checks' in body).toBe(true)
  })

  it('calls PUT for develop too', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://api.github.com/repos/Bigi-HS/marveen/branches/develop/protection' }),
    })
    const result = await setBranchProtection('develop', deps)
    expect(result.branch).toBe('develop')
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/branches/develop/protection')
  })

  it('masks 401 as BranchProtectionError(502)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Bad creds' }) })
    const err = await setBranchProtection('main', deps).catch((e) => e)
    expect(err).toBeInstanceOf(BranchProtectionError)
    expect(err.status).toBe(502)
  })

  it('masks 403 as BranchProtectionError(502)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })
    await expect(setBranchProtection('main', deps)).rejects.toMatchObject({ status: 502 })
  })

  it('surfaces other GitHub status codes via BranchProtectionError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Validation Failed' }),
    })
    await expect(setBranchProtection('main', deps)).rejects.toMatchObject({ status: 422 })
  })

  it('wraps network failure as BranchProtectionError(502)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(setBranchProtection('main', deps)).rejects.toMatchObject({ status: 502 })
  })

  it('rejects non-allowlist branch before any network call', async () => {
    await expect(setBranchProtection('feature/x', deps)).rejects.toMatchObject({ status: 400 })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('token is never returned or logged (not in result)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    })
    const result = await setBranchProtection('main', deps)
    // result must not expose the token
    expect(JSON.stringify(result)).not.toContain('tok')
  })
})
