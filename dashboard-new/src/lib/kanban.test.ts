import { describe, it, expect } from 'vitest'
import { groupCardsByStatus, groupCardsByProject, cardAgeSeconds, isCardStale, formatAge, getStaleCards } from './kanban'
import type { KanbanCard } from '@/types/api'

function card(id: string, status: KanbanCard['status']): KanbanCard {
  return {
    id,
    title: id,
    description: null,
    status,
    assignee: null,
    priority: 'normal',
    project: null,
    code: null,
    parent_id: null,
    due_date: null,
    created_at: 0,
    updated_at: 0,
    dispatched_at: null,
    last_moved: null,
    priority_score: null,
  }
}

function pcard(id: string, project: string | null, status: KanbanCard['status'] = 'planned'): KanbanCard {
  return { ...card(id, status), project }
}

describe('groupCardsByStatus (AC-F0-7)', () => {
  it('buckets cards into the four columns', () => {
    const groups = groupCardsByStatus([
      card('a', 'planned'),
      card('b', 'in_progress'),
      card('c', 'waiting'),
      card('d', 'done'),
      card('e', 'planned'),
    ])
    expect(groups.planned.map((c) => c.id)).toEqual(['a', 'e'])
    expect(groups.in_progress.map((c) => c.id)).toEqual(['b'])
    expect(groups.waiting.map((c) => c.id)).toEqual(['c'])
    expect(groups.done.map((c) => c.id)).toEqual(['d'])
  })

  it('drops non-column statuses (someday) from the board', () => {
    const groups = groupCardsByStatus([card('s', 'someday'), card('p', 'planned')])
    expect(groups.planned.map((c) => c.id)).toEqual(['p'])
    const total = groups.planned.length + groups.in_progress.length + groups.waiting.length + groups.done.length
    expect(total).toBe(1)
  })

  it('always returns all four column keys, even when empty', () => {
    const groups = groupCardsByStatus([])
    expect(Object.keys(groups).sort()).toEqual(['done', 'in_progress', 'planned', 'waiting'])
  })
})

describe('groupCardsByProject (cf0d1bfe S3)', () => {
  it('buckets cards under their project, in canonical taxonomy order', () => {
    // Input order is deliberately scrambled; output must follow CARD_PROJECTS order
    // (DASH < OPS < ENG in the canonical list), not insertion order.
    const groups = groupCardsByProject([
      pcard('e1', 'ENG'),
      pcard('o1', 'OPS'),
      pcard('d1', 'DASH'),
      pcard('e2', 'ENG'),
    ])
    expect(groups.map((g) => g.project)).toEqual(['DASH', 'OPS', 'ENG'])
    expect(groups.find((g) => g.project === 'ENG')?.cards.map((c) => c.id)).toEqual(['e1', 'e2'])
  })

  it('omits canonical projects that have no cards', () => {
    const groups = groupCardsByProject([pcard('m1', 'MEM')])
    expect(groups.map((g) => g.project)).toEqual(['MEM'])
  })

  it('drops non-column statuses (someday) so both views show the same card set', () => {
    const groups = groupCardsByProject([pcard('s', 'ENG', 'someday'), pcard('p', 'ENG', 'planned')])
    const eng = groups.find((g) => g.project === 'ENG')
    expect(eng?.cards.map((c) => c.id)).toEqual(['p'])
  })

  it('collects null / non-canonical projects into a single trailing group', () => {
    const groups = groupCardsByProject([
      pcard('e1', 'ENG'),
      pcard('n1', null),
      pcard('x1', 'not-a-real-bucket'),
    ])
    // canonical first, uncategorized last
    expect(groups.map((g) => g.project)).toEqual(['ENG', null])
    expect(groups.find((g) => g.project === null)?.cards.map((c) => c.id)).toEqual(['n1', 'x1'])
  })

  it('returns an empty array for no cards', () => {
    expect(groupCardsByProject([])).toEqual([])
  })
})

describe('groupCardsByProject CONT-family folding (cf0d1bfe enum-widen)', () => {
  it('folds the CONT-family (DUB/DL/DISC/BIGI) into the single CONT lane', () => {
    const groups = groupCardsByProject([
      pcard('c1', 'CONT'),
      pcard('du1', 'DUB'),
      pcard('dl1', 'DL'),
      pcard('di1', 'DISC'),
      pcard('b1', 'BIGI'),
    ])
    // one visual lane, keyed CONT -- no separate DUB/DL/DISC/BIGI lanes
    expect(groups.map((g) => g.project)).toEqual(['CONT'])
    expect(groups[0].cards.map((c) => c.id)).toEqual(['c1', 'du1', 'dl1', 'di1', 'b1'])
  })

  it('produces a CONT lane even when only family members (no bare CONT) are present', () => {
    const groups = groupCardsByProject([pcard('du1', 'DUB'), pcard('b1', 'BIGI')])
    expect(groups.map((g) => g.project)).toEqual(['CONT'])
    expect(groups[0].cards.map((c) => c.id)).toEqual(['du1', 'b1'])
  })

  it('never emits a standalone DUB/DL/DISC/BIGI lane', () => {
    const groups = groupCardsByProject([pcard('du1', 'DUB'), pcard('e1', 'ENG')])
    // ENG precedes CONT in the canonical lane order
    expect(groups.map((g) => g.project)).toEqual(['ENG', 'CONT'])
    expect(groups.some((g) => ['DUB', 'DL', 'DISC', 'BIGI'].includes(g.project ?? ''))).toBe(false)
  })

  it('treats the new granular codes (AGENT/ASST) as canonical, not Egyeb', () => {
    const groups = groupCardsByProject([pcard('a1', 'AGENT'), pcard('as1', 'ASST')])
    const keys = groups.map((g) => g.project)
    expect(keys).toContain('AGENT')
    expect(keys).toContain('ASST')
    expect(keys).not.toContain(null)
  })

  it('still routes a genuinely non-canonical value to the Egyeb lane', () => {
    const groups = groupCardsByProject([pcard('e1', 'ENG'), pcard('pa1', 'PA')])
    // PA is retired from the frontend enum too -> uncategorized
    expect(groups.map((g) => g.project)).toEqual(['ENG', null])
    expect(groups.find((g) => g.project === null)?.cards.map((c) => c.id)).toEqual(['pa1'])
  })
})

// ---------------------------------------------------------------------------
// Aging + stale detection (card 31f24bad)
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000 // fixed epoch for deterministic tests

function ageCard(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    ...card('x', 'planned'),
    priority_score: 6, // normal: 3-day threshold
    updated_at: NOW - 4 * 86400, // 4 days ago
    last_moved: null,
    ...overrides,
  }
}

describe('cardAgeSeconds (card 31f24bad)', () => {
  it('uses last_moved when present', () => {
    const c = ageCard({ last_moved: NOW - 2 * 86400 })
    expect(cardAgeSeconds(c, NOW)).toBe(2 * 86400)
  })

  it('falls back to updated_at when last_moved is null', () => {
    const c = ageCard({ last_moved: null, updated_at: NOW - 5 * 86400 })
    expect(cardAgeSeconds(c, NOW)).toBe(5 * 86400)
  })

  it('returns null for bulk-stamp burst window with null last_moved', () => {
    const c = ageCard({ last_moved: null, updated_at: 1785334220 }) // inside burst window
    expect(cardAgeSeconds(c, NOW)).toBeNull()
  })

  it('returns a valid age when updated_at is outside the burst window', () => {
    const c = ageCard({ last_moved: null, updated_at: 1785334211 }) // one second before burst
    expect(cardAgeSeconds(c, NOW)).toBe(NOW - 1785334211)
  })
})

describe('isCardStale (card 31f24bad)', () => {
  it('returns true when last_moved exceeds the threshold', () => {
    const c = ageCard({ last_moved: NOW - 4 * 86400, priority_score: 6 }) // 4d > 3d threshold
    expect(isCardStale(c, NOW)).toBe(true)
  })

  it('returns false when last_moved is within the threshold', () => {
    const c = ageCard({ last_moved: NOW - 1 * 86400, priority_score: 6 })
    expect(isCardStale(c, NOW)).toBe(false)
  })

  it('returns false for done cards regardless of age', () => {
    const c = ageCard({ status: 'done', last_moved: NOW - 30 * 86400, priority_score: 1 })
    expect(isCardStale(c, NOW)).toBe(false)
  })

  it('returns false for icebox/someday cards', () => {
    const c = ageCard({ status: 'someday', last_moved: NOW - 30 * 86400, priority_score: 1 })
    expect(isCardStale(c, NOW)).toBe(false)
  })

  it('returns false when priority_score is null', () => {
    const c = ageCard({ priority_score: null, last_moved: NOW - 30 * 86400 })
    expect(isCardStale(c, NOW)).toBe(false)
  })

  it('returns unknown for bulk-stamp window with null last_moved', () => {
    const c = ageCard({ last_moved: null, updated_at: 1785334220, priority_score: 6 })
    expect(isCardStale(c, NOW)).toBe('unknown')
  })

  it('last_moved takes precedence over updated_at when both present', () => {
    // updated_at says stale, last_moved says fresh
    const c = ageCard({ last_moved: NOW - 1 * 86400, updated_at: NOW - 30 * 86400, priority_score: 6 })
    expect(isCardStale(c, NOW)).toBe(false)
  })
})

describe('formatAge (card 31f24bad)', () => {
  it('formats days', () => {
    expect(formatAge(2 * 86400)).toBe('2n')
    expect(formatAge(10 * 86400)).toBe('10n')
  })

  it('formats hours when under 1 day', () => {
    expect(formatAge(5 * 3600)).toBe('5ó')
  })

  it('formats minutes when under 1 hour', () => {
    expect(formatAge(30 * 60)).toBe('30p')
    expect(formatAge(0)).toBe('0p')
  })

  it('returns "-" for null (unmeasured)', () => {
    expect(formatAge(null)).toBe('-')
  })
})

describe('getStaleCards (card 31f24bad)', () => {
  it('returns stale active cards, sorted true-stale first then unknown', () => {
    const fresh = ageCard({ id: 'fresh', last_moved: NOW - 1 * 86400, priority_score: 6 })
    const stale = ageCard({ id: 'stale', last_moved: NOW - 4 * 86400, priority_score: 6 })
    const unk = ageCard({ id: 'unk', last_moved: null, updated_at: 1785334220, priority_score: 6 })
    const done = ageCard({ id: 'done', status: 'done', last_moved: NOW - 30 * 86400, priority_score: 1 })

    const result = getStaleCards([fresh, stale, unk, done], NOW)
    expect(result.map((c) => c.id)).toEqual(['stale', 'unk'])
  })

  it('returns empty array when no cards are stale', () => {
    const fresh = ageCard({ last_moved: NOW - 1 * 86400, priority_score: 6 })
    expect(getStaleCards([fresh], NOW)).toEqual([])
  })
})
