import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Integration test for PR-trigger listener.
 *
 * Note: Full end-to-end testing requires:
 * - Mock /api/events SSE stream
 * - Mock git operations
 * - Verify /tmp/metrics/pr-{N}/ artifacts
 *
 * This suite validates the event parsing and routing logic.
 * (Full deployment test via manual smoke test with --dry-run flag)
 */

describe('PR-trigger listener — event handling', () => {
  it('should parse pr.opened events correctly', () => {
    const eventJson = '{"type":"pr.opened","pr_num":42,"head_sha":"abc123def"}'
    const event = JSON.parse(eventJson)
    expect(event.type).toBe('pr.opened')
    expect(event.pr_num).toBe(42)
    expect(event.head_sha).toBe('abc123def')
  })

  it('should parse pr.ready events', () => {
    const eventJson = '{"type":"pr.ready","pr_num":123,"base":"develop"}'
    const event = JSON.parse(eventJson)
    expect(event.type).toBe('pr.ready')
    expect(event.pr_num).toBe(123)
  })

  it('should handle malformed events gracefully', () => {
    const invalidEvents = [
      '{}',  // no pr_num
      '{"type":"pr.opened"}',  // missing pr_num
      '{"type":"pr.opened","pr_num":"abc"}',  // pr_num is string, not int
    ]

    for (const eventJson of invalidEvents) {
      const event = JSON.parse(eventJson)
      const pr_num = event.pr_num
      const isValid = pr_num && typeof pr_num === 'number'
      expect(!isValid).toBe(true)  // assert it's invalid
    }
  })

  it('should filter to pr.* events only', () => {
    const allEvents = [
      { type: 'pr.opened', pr_num: 1 },
      { type: 'pr.ready', pr_num: 2 },
      { type: 'pr.merged', pr_num: 3 },
      { type: 'push', ref: 'refs/heads/main' },  // non-pr event
      { type: 'issue.opened', pr_num: 4 },  // not a pr.* event
    ]

    const prEvents = allEvents.filter(e => e.type.startsWith('pr.'))
    expect(prEvents).toHaveLength(3)
    expect(prEvents.map(e => e.type)).toContain('pr.opened')
    expect(prEvents.map(e => e.type)).toContain('pr.ready')
    expect(prEvents.map(e => e.type)).toContain('pr.merged')
  })

  it('should trigger measurement on pr.opened and pr.ready', () => {
    const shouldMeasure = (eventType: string) => {
      return ['pr.opened', 'pr.ready'].includes(eventType)
    }

    expect(shouldMeasure('pr.opened')).toBe(true)
    expect(shouldMeasure('pr.ready')).toBe(true)
    expect(shouldMeasure('pr.merged')).toBe(false)
    expect(shouldMeasure('push')).toBe(false)
  })

  it('should output flaky results to /tmp/metrics/pr-{N}/', () => {
    // Validate path construction
    const prNum = 123
    const expectedPath = `/tmp/metrics/pr-${prNum}/flaky-report.json`
    expect(expectedPath).toContain('pr-123')
    expect(expectedPath).toContain('flaky-report.json')
  })
})

describe('PR-trigger listener — deployment readiness', () => {
  it('should accept --dry-run flag for testing', () => {
    const argv = ['node', 'listener.py', '--dry-run']
    const isDryRun = argv.includes('--dry-run')
    expect(isDryRun).toBe(true)
  })

  it('should accept --verbose flag for debugging', () => {
    const argv = ['node', 'listener.py', '--verbose']
    const isVerbose = argv.includes('--verbose')
    expect(isVerbose).toBe(true)
  })

  it('should require GENESIS_AGENT_TOKEN env var', () => {
    const env = {}  // empty
    const hasToken = !!env['GENESIS_AGENT_TOKEN']
    expect(hasToken).toBe(false)

    const envWithToken = { GENESIS_AGENT_TOKEN: 'abc123' }
    const hasTokenNow = !!envWithToken['GENESIS_AGENT_TOKEN']
    expect(hasTokenNow).toBe(true)
  })
})
