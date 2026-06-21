// Tests for card ef8ae6b5 (A3): live sentinel rotation during runtime.
//
// Verifies that startDeliverySentinelMaintenance fires the maintenance function
// on a periodic interval and is cleanable via clearInterval.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startDeliverySentinelMaintenance,
  __resetMaintenanceState,
} from '../web/delivery-sentinel-maintenance.js'

beforeEach(() => {
  vi.useFakeTimers()
  __resetMaintenanceState()
})

afterEach(() => {
  vi.useRealTimers()
  __resetMaintenanceState()
})

describe('startDeliverySentinelMaintenance', () => {
  it('does not call maintenance before the first interval elapses', () => {
    const fn = vi.fn()
    startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
    vi.advanceTimersByTime(999)
    expect(fn).not.toHaveBeenCalled()
  })

  it('calls maintenance once after one interval', () => {
    const fn = vi.fn()
    startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('calls maintenance repeatedly on each interval tick', () => {
    const fn = vi.fn()
    startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('stops after clearInterval', () => {
    const fn = vi.fn()
    const handle = startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    clearInterval(handle)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1) // no more calls after clear
  })

  it('swallows errors from maintenance function (non-fatal)', () => {
    const fn = vi.fn(() => { throw new Error('boom') })
    expect(() => {
      startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
      vi.advanceTimersByTime(1000)
    }).not.toThrow()
  })

  it('continues running after a maintenance error on one tick', () => {
    let callCount = 0
    const fn = vi.fn(() => {
      callCount++
      if (callCount === 1) throw new Error('first-tick error')
    })
    startDeliverySentinelMaintenance({ _maintenanceFn: fn, intervalMs: 1000 })
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(3) // ran all 3 despite the first-tick error
  })

  it('defaults to 60-minute interval when intervalMs omitted', () => {
    const fn = vi.fn()
    startDeliverySentinelMaintenance({ _maintenanceFn: fn })
    vi.advanceTimersByTime(60 * 60 * 1000 - 1)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
