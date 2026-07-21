import { describe, it, expect } from 'vitest'
import config from '../../tailwind.config'

// Guards the point of this PR: the dashboard stays aligned to the approved v6 design
// fonts (store/dashboard-design-system.md) -- Inter for UI, JetBrains Mono for data --
// and never silently falls back to the system stack (the AI-slop "gave up" signal).
const fonts = (config.theme?.extend as { fontFamily?: Record<string, string[]> } | undefined)?.fontFamily

describe('approved-design font wiring', () => {
  it('sans is Inter-first (UI font), not the system stack', () => {
    expect(fonts?.sans?.[0]).toBe('Inter')
  })

  it('mono is JetBrains Mono-first (ids / timestamps / counts)', () => {
    expect(fonts?.mono?.[0]).toBe('JetBrains Mono')
  })

  it('keeps a graceful fallback chain after each primary face', () => {
    expect((fonts?.sans?.length ?? 0)).toBeGreaterThan(1)
    expect((fonts?.mono?.length ?? 0)).toBeGreaterThan(1)
  })
})
