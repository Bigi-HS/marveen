import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from './usePolling'

// Mock the data layer so the hook's fetch behaviour is observable.
const apiGet = vi.fn<(path: string, signal?: AbortSignal) => Promise<unknown>>()
vi.mock('@/lib/api', () => ({ apiGet: (p: string, s?: AbortSignal) => apiGet(p, s) }))

beforeEach(() => {
  apiGet.mockReset()
  apiGet.mockResolvedValue([{ ok: true }])
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePolling refreshSignal (F1 SSE-driven refetch)', () => {
  it('fetches once on mount', async () => {
    renderHook(() => usePolling('/api/kanban', { intervalMs: 30000 }))
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/api/kanban', expect.anything())
  })

  it('refetches immediately when refreshSignal changes (no wait for interval)', async () => {
    let signal = 0
    const { rerender } = renderHook(() => usePolling('/api/kanban', { intervalMs: 30000, refreshSignal: signal }))
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)

    signal = 1
    rerender()
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('does not refetch when refreshSignal is unchanged across a rerender', async () => {
    const { rerender } = renderHook(() => usePolling('/api/kanban', { intervalMs: 30000, refreshSignal: 5 }))
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
    rerender()
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('still polls on the interval as a safety backstop', async () => {
    renderHook(() => usePolling('/api/kanban', { intervalMs: 30000 }))
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('legacy numeric second arg still sets the interval (back-compat)', async () => {
    renderHook(() => usePolling('/api/kanban', 30000))
    await act(async () => { await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(30000); await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
