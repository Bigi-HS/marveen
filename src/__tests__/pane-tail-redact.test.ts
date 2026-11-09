// TDD: tests for redactTailLine -- SEC-113 (card ed4a714b)
// Verifies that sensitive patterns are stripped from pane output before
// it reaches any client. Must NOT over-redact normal operational text.

import { describe, it, expect } from 'vitest'
import { redactTailLine } from '../web/routes/agents.js'

describe('redactTailLine', () => {
  // --- should redact ---

  it('redacts Bearer tokens', () => {
    const line = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.xyz'
    expect(redactTailLine(line)).toContain('[REDACTED]')
    expect(redactTailLine(line)).not.toContain('eyJhbGciOi')
  })

  it('redacts standalone JWT (3 base64url segments)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(redactTailLine(jwt)).toContain('[REDACTED]')
    expect(redactTailLine(jwt)).not.toContain('eyJhbGci')
  })

  it('redacts /home/ filesystem paths', () => {
    const line = 'reading /home/domin/marveen/store/.dashboard-token'
    const out = redactTailLine(line)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('/home/domin')
  })

  it('redacts env-var assignments with long values', () => {
    const line = 'GENESIS_AGENT_TOKEN=abc123xyz456abc123xyz456abc123xyz456 running'
    const out = redactTailLine(line)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('abc123xyz456')
  })

  it('redacts APP_TOKEN_SECRET assignments', () => {
    const line = 'APP_TOKEN_SECRET=supersecretvaluethatislong12345678'
    const out = redactTailLine(line)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('supersecret')
  })

  it('redacts long hex strings (SHA/token-shaped)', () => {
    const line = 'token: a3f9e1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3'
    const out = redactTailLine(line)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('a3f9e1b2c4d5e6f7')
  })

  // --- must NOT over-redact ---

  it('passes through normal task-completion messages', () => {
    const line = 'Task completed: 3 files modified'
    expect(redactTailLine(line)).toBe(line)
  })

  it('passes through short tool call names', () => {
    const line = 'Read /api/kanban response'
    expect(redactTailLine(line)).toBe(line)
  })

  it('passes through "working on..." status text', () => {
    const line = 'Searching for recent GitHub repos...'
    expect(redactTailLine(line)).toBe(line)
  })

  it('passes through normal agent activity tail', () => {
    const line = '✓ vitest 42 tests passed'
    expect(redactTailLine(line)).toBe(line)
  })

  it('passes through short alphanumeric IDs (card IDs, commit hashes < 40 chars)', () => {
    // 8-char card id is not a secret
    const line = 'Processing card 60abcc64 status=in_progress'
    expect(redactTailLine(line)).toBe(line)
  })

  it('passes through PR numbers and short refs', () => {
    const line = 'PR #934 merged develop 92f3b97'
    expect(redactTailLine(line)).toBe(line)
  })
})
