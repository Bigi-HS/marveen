import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentCategories } from '../web/routes/agent-categories.js'

let dir: string
let cfg: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentcat-'))
  cfg = join(dir, 'agent-categories.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadAgentCategories', () => {
  it('parses a valid category map', () => {
    writeFileSync(cfg, JSON.stringify({ QA: ['thor', 'gauge'], Engineering: ['dave'] }))
    expect(loadAgentCategories(cfg)).toEqual({ QA: ['thor', 'gauge'], Engineering: ['dave'] })
  })

  it('returns {} for a missing file (degrade to empty tree, not 500)', () => {
    expect(loadAgentCategories(join(dir, 'nope.json'))).toEqual({})
  })

  it('returns {} for invalid JSON', () => {
    writeFileSync(cfg, '{ not json')
    expect(loadAgentCategories(cfg)).toEqual({})
  })

  it('returns {} when the top level is not an object', () => {
    writeFileSync(cfg, JSON.stringify(['a', 'b']))
    expect(loadAgentCategories(cfg)).toEqual({})
    writeFileSync(cfg, JSON.stringify('string'))
    expect(loadAgentCategories(cfg)).toEqual({})
  })

  it('drops non-array category values and non-string members', () => {
    writeFileSync(cfg, JSON.stringify({
      QA: ['thor', 42, 'gauge', '', null],
      Bad: 'notarray',
      Empty: [],
    }))
    expect(loadAgentCategories(cfg)).toEqual({ QA: ['thor', 'gauge'], Empty: [] })
  })

  it('skips blank category names', () => {
    writeFileSync(cfg, JSON.stringify({ '': ['x'], '  ': ['y'], Real: ['z'] }))
    expect(loadAgentCategories(cfg)).toEqual({ Real: ['z'] })
  })
})
