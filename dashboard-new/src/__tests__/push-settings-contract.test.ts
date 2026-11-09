// Contract test: savePushSettings must use PUT to match the backend route (push.ts method==='PUT').
// A POST would fall through the router unhandled. Thor caught this in #935 review.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { savePushSettings } from '@/lib/api-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('savePushSettings HTTP contract', () => {
  it('uses PUT, not POST, to /api/push/settings', async () => {
    const payload = { workout: true, todo: true, fleet: true, journal: true }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    })
    vi.stubGlobal('fetch', mockFetch)

    await savePushSettings({ workout: false })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/push/settings',
      expect.objectContaining({ method: 'PUT' }),
    )
  })
})
