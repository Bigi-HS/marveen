import { describe, it, expect } from 'vitest'
import { groupCardsByStatus, groupCardsByProject } from './kanban'
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

  it('treats the new granular codes (AGENT/ASST) as canonical, not Egyéb', () => {
    const groups = groupCardsByProject([pcard('a1', 'AGENT'), pcard('as1', 'ASST')])
    const keys = groups.map((g) => g.project)
    expect(keys).toContain('AGENT')
    expect(keys).toContain('ASST')
    expect(keys).not.toContain(null)
  })

  it('still routes a genuinely non-canonical value to the Egyéb lane', () => {
    const groups = groupCardsByProject([pcard('e1', 'ENG'), pcard('pa1', 'PA')])
    // PA is retired from the frontend enum too -> uncategorized
    expect(groups.map((g) => g.project)).toEqual(['ENG', null])
    expect(groups.find((g) => g.project === null)?.cards.map((c) => c.id)).toEqual(['pa1'])
  })
})
