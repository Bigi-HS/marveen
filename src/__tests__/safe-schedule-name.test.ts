import { describe, it, expect } from 'vitest'
import { safeScheduleName } from '../web/sanitize.js'

describe('safeScheduleName (schedule-route traversal guard)', () => {
  it('passes a normal schedule name through unchanged', () => {
    expect(safeScheduleName('reggeli-napindito')).toBe('reggeli-napindito')
  })

  it('decodes percent-encoding for a legitimate name', () => {
    expect(safeScheduleName('vmd%2Dreport')).toBe('vmd-report')
  })

  it('rejects a bare parent-dir traversal', () => {
    expect(safeScheduleName('..')).toBeNull()
  })

  it('rejects percent-encoded parent-dir traversal', () => {
    expect(safeScheduleName('%2e%2e')).toBeNull()
    expect(safeScheduleName('%2E%2E')).toBeNull()
  })

  it('rejects a slash / nested traversal by stripping separators, never escaping', () => {
    // '../../foo' sanitizes to 'foo' -- the separators and dots are stripped,
    // so it can only ever resolve to a sibling name, never the parent dir.
    expect(safeScheduleName('..%2f..%2ffoo')).toBe('foo')
    expect(safeScheduleName('%2e%2e%2f%2e%2e')).toBeNull()
  })

  it('rejects a name that sanitizes to empty', () => {
    expect(safeScheduleName('/')).toBeNull()
    expect(safeScheduleName('...')).toBeNull()
    expect(safeScheduleName('')).toBeNull()
  })

  it('rejects malformed percent-encoding instead of throwing', () => {
    expect(safeScheduleName('%')).toBeNull()
    expect(safeScheduleName('%zz')).toBeNull()
  })
})
