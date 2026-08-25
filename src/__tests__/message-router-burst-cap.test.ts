import { describe, it, expect } from 'vitest'
import { MAX_DELIVERIES_PER_TICK, SPAWN_BROADCAST_QUEUE_MAX, shouldSkipSpawnBroadcast } from '../web/message-router.js'

// Guards the delivery-cap and broadcast-depth-guard constants introduced in
// card fee86966. The supervisor kills the dashboard when the HTTP server stops
// responding; each sendPromptToSession call blocks the event loop for ~2s on a
// 4 kB message, so MAX_DELIVERIES_PER_TICK * 2s must stay well below the 8s
// supervisor health-check timeout.
describe('message-router burst cap', () => {
  it('MAX_DELIVERIES_PER_TICK is within safe bounds (cap * 2s < 8s supervisor timeout)', () => {
    expect(MAX_DELIVERIES_PER_TICK).toBeGreaterThanOrEqual(1)
    expect(MAX_DELIVERIES_PER_TICK).toBeLessThanOrEqual(3)
  })

  it('SPAWN_BROADCAST_QUEUE_MAX is positive and reasonable', () => {
    expect(SPAWN_BROADCAST_QUEUE_MAX).toBeGreaterThan(0)
    expect(SPAWN_BROADCAST_QUEUE_MAX).toBeLessThanOrEqual(20)
  })
})

describe('shouldSkipSpawnBroadcast', () => {
  it('does not skip when queue is empty', () => {
    expect(shouldSkipSpawnBroadcast(0)).toBe(false)
  })

  it('does not skip when queue is below threshold', () => {
    expect(shouldSkipSpawnBroadcast(SPAWN_BROADCAST_QUEUE_MAX - 1)).toBe(false)
  })

  it('skips when queue exactly equals threshold', () => {
    expect(shouldSkipSpawnBroadcast(SPAWN_BROADCAST_QUEUE_MAX)).toBe(true)
  })

  it('skips when queue exceeds threshold', () => {
    expect(shouldSkipSpawnBroadcast(SPAWN_BROADCAST_QUEUE_MAX + 10)).toBe(true)
  })
})
