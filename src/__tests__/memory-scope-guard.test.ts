import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb, saveMemory, isPotentialPII } from '../noa-memory.js'

// Card MEM/8ad3a1c9 (Hibiki, measured on 14+8 shapes; NoA verified independently).
//
// The PII classifier matched every keyword as a BARE SUBSTRING, so any word merely
// containing the letters counted as health data. The headline case: the Hungarian
// word "listaja" (= its list) contains t-a-j, the three-letter national health id,
// so a shared memory containing it was rejected with a 400 -- and the 400 named a
// field (access_scope) the caller never sent, which sent the diagnosis the wrong
// way. On hot/warm/cold the same match instead attached a scope SILENTLY, and the
// response did not carry the field at all, so the caller could not see it.
//
// The filter must NOT be weakened: Hibiki is the health agent and the breadth is
// deliberate. What changes is only WHERE a keyword may match -- at a word start,
// suffixes still allowed, because Hungarian is agglutinative and "lakcimem",
// "tajszamom", "egeszsegadat" and "diagnozist" are all genuine hits that a naive
// \b...\b word-boundary rule would have thrown away.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

describe('PII classifier matches at a word start, not mid-word', () => {
  // MEASURED on 808k chars of Hungarian fleet engineering prose (445 kanban cards):
  // these are the host words the keywords were actually hiding in, with the hit
  // count from that corpus. Every one of them is a false positive by construction
  // -- card text is engineering prose, not personal data.
  const FALSE_POSITIVES: [string, string][] = [
    ['listaja', 'taj (14 hits)'],
    ['listajat', 'taj'],
    ['mintajara', 'taj (9 hits)'],
    ['reportaj', 'taj (4 hits)'],
    ['sajtaj', 'taj'],
    ['kartajanlas', 'taj'],
    ['specimen', 'cim (4 hits)'],
    ['gzip', 'zip (7 hits)'],
    ['unzip', 'zip (4 hits)'],
    ['gzippelt', 'zip'],
    ['hibanak', 'iban (2 hits)'],
    ['kibanyaszasa', 'iban'],
    ['elofizetesben', 'fizetes'],
    ['penzvisszafizetes', 'fizetes'],
  ]

  it.each(FALSE_POSITIVES)('%s is not PII (host of %s)', (word) => {
    expect(isPotentialPII(null, word)).toBe(false)
  })

  // The other direction, and it is the one that keeps this from being a weakening.
  // Hungarian glues suffixes onto the stem, so the guard has to keep matching them.
  const MUST_STILL_MATCH = [
    'taj',              // the bare identifier
    'tajszamom',        // "my TAJ number" -- agglutinated, still PII
    'lakcimem',         // "my home address"
    'iranyitoszamom',   // "my postcode"
    'szuletesnapom',    // "my birthday"
    'adoszamom',        // "my tax number"
    'egeszsegadat',     // health data
    'egeszsegugyi',
    'diagnozist',       // accusative of diagnosis
    'bankszamla',
    'orvos',
  ]

  it.each(MUST_STILL_MATCH)('%s is still PII', (word) => {
    expect(isPotentialPII(null, word)).toBe(true)
  })

  // Hibiki's counter-control: the pattern list is narrow and targeted on purpose.
  // If a fix ever slid the other way and started matching these, that is a bug too.
  const MUST_STAY_CLEAN = ['debug', 'felsorolas', 'medical', 'wellness', 'fitness', 'dexa', 'suly']

  it.each(MUST_STAY_CLEAN)('%s is not PII (counter-control)', (word) => {
    expect(isPotentialPII(null, word)).toBe(false)
  })

  it('matches on keywords as well as content, at a word start in both', () => {
    expect(isPotentialPII('taj', 'harmless body')).toBe(true)
    expect(isPotentialPII('listaja', 'harmless body')).toBe(false)
  })
})

describe('the applied access_scope is reported back, not left silent', () => {
  beforeEach(() => {
    getNoaDb().prepare('DELETE FROM memories').run()
  })

  it('returns the scope that was actually stored, for a PII hit', () => {
    const result = saveMemory('hibiki', 'a tajszamom kell a bejelentkezeshez', 'warm')
    expect(result.access_scope).toBe('hibiki')

    // Read the row back rather than trusting the returned value: the point of the
    // field is that it reports what was WRITTEN. A returned value computed a second
    // time in the caller would prove nothing about the row.
    const row = getNoaDb().prepare('SELECT access_scope FROM memories WHERE id = ?')
      .get(result.id) as { access_scope: string | null }
    expect(row.access_scope).toBe(result.access_scope)
  })

  it('returns null when nothing scoped the memory, and the row agrees', () => {
    const result = saveMemory('hibiki', 'a listaja rendben van', 'warm')
    expect(result.access_scope).toBeNull()

    const row = getNoaDb().prepare('SELECT access_scope FROM memories WHERE id = ?')
      .get(result.id) as { access_scope: string | null }
    expect(row.access_scope).toBeNull()
  })

  it('returns the explicit scope the caller asked for', () => {
    const result = saveMemory('dave', 'plain content', 'warm', undefined, 'dave')
    expect(result.access_scope).toBe('dave')
  })
})
