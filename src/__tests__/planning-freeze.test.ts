import { describe, it, expect } from 'vitest'
import { parseKeepList, freezeBlocksWith, DEFAULT_KEEP } from '../web/planning-freeze.js'

// Server-side mirror of the shell planning-freeze gate
// (scripts/fleet-supervisor.sh freeze_blocks / freeze_keep_ids). These tests pin
// the SAME contract so the two layers cannot drift: the freeze leaked precisely
// because the server had NO such gate (lesson planning-freeze-server-respawn-leak).
//
// The suite targets the pure core (parseKeepList + freezeBlocksWith) because the
// fs wrappers (planningFreezeEnabled / freezeKeepIds / freezeBlocks) are thin glue
// over existsSync+readFileSync delegating to exactly these two functions.

describe('parseKeepList (mirrors shell freeze_keep_ids)', () => {
  it('null contents -> default keep-list (file absent)', () => {
    expect(parseKeepList(null)).toEqual(new Set(DEFAULT_KEEP))
  })

  it('empty string -> default keep-list', () => {
    expect(parseKeepList('')).toEqual(new Set(DEFAULT_KEEP))
  })

  it('only comments and blank lines -> default keep-list (never an empty block-everything set)', () => {
    expect(parseKeepList('# header\n\n   \n#claudia\n')).toEqual(new Set(DEFAULT_KEEP))
  })

  it('canonical live file -> exactly the listed ids', () => {
    const contents = '# Planning-freeze keep-list (Boss 2026-10-11).\nclaudia\nhibiki\n'
    expect(parseKeepList(contents)).toEqual(new Set(['claudia', 'hibiki']))
  })

  it('strips inline comments, blanks and surrounding whitespace', () => {
    expect(parseKeepList('# hdr\nclaudia\n\n  hibiki  \n#foo\n')).toEqual(new Set(['claudia', 'hibiki']))
  })

  it('takes only the first whitespace-delimited token per line', () => {
    expect(parseKeepList('dave extra tokens here\n  forge\t# trailing')).toEqual(new Set(['dave', 'forge']))
  })

  it('a custom keep-list is honored verbatim (NOT hardcoded to claudia/hibiki)', () => {
    // Non-vacuity: if the parser ignored the file and returned the default, this
    // would wrongly include claudia/hibiki and exclude forge.
    const parsed = parseKeepList('forge\n')
    expect(parsed).toEqual(new Set(['forge']))
    expect(parsed.has('claudia')).toBe(false)
  })
})

describe('freezeBlocksWith (mirrors shell freeze_blocks)', () => {
  const KEEP = new Set(['claudia', 'hibiki'])

  it('flag OFF -> never blocks, even for a non-keep agent (fail-safe = current behavior)', () => {
    expect(freezeBlocksWith(false, KEEP, 'avery')).toBe(false)
  })

  it('flag OFF -> never blocks, even with an empty keep-list', () => {
    expect(freezeBlocksWith(false, new Set(), 'avery')).toBe(false)
  })

  it('flag ON + agent NOT in keep-list -> BLOCK', () => {
    expect(freezeBlocksWith(true, KEEP, 'avery')).toBe(true)
    expect(freezeBlocksWith(true, KEEP, 'blackbeard')).toBe(true)
  })

  it('flag ON + agent IN keep-list -> allow', () => {
    expect(freezeBlocksWith(true, KEEP, 'claudia')).toBe(false)
    expect(freezeBlocksWith(true, KEEP, 'hibiki')).toBe(false)
  })

  it('flag ON + empty keep-list -> blocks everyone (keep membership genuinely gates)', () => {
    // Non-vacuity: proves the decision depends on the keep-set, not a constant.
    expect(freezeBlocksWith(true, new Set(), 'claudia')).toBe(true)
  })

  it('flag ON + custom keep-list -> allows the custom id, blocks the defaults', () => {
    const custom = new Set(['avery'])
    expect(freezeBlocksWith(true, custom, 'avery')).toBe(false)
    expect(freezeBlocksWith(true, custom, 'claudia')).toBe(true)
  })

  it('end-to-end via parseKeepList: frozen roster from the live file blocks a non-keep agent', () => {
    const keep = parseKeepList('claudia\nhibiki\n')
    expect(freezeBlocksWith(true, keep, 'roberts')).toBe(true)
    expect(freezeBlocksWith(true, keep, 'claudia')).toBe(false)
  })
})
