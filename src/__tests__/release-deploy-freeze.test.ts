// Tests for the conservative deploy-path planning-freeze resolver (card 2efcb439,
// v2-spec-p9-sandbox-release.md §8 Inv-8, Thor MINOR-B). Slice 4b.
//
// The resolver fails toward SKIP (the opposite of the agent-respawn gate's
// fail-toward-ALLOW): an irreversible auto-deploy during a freeze is the dangerous
// outcome. It is CONSERVATIVE, not an OR -- the silence of either source must not
// become a silent bypass. STORE_DIR is mocked to a temp dir so the real flag-file
// read is exercised against a controlled filesystem.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { storeHolder } = vi.hoisted(() => ({ storeHolder: { dir: '' } }))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get STORE_DIR() {
      return storeHolder.dir
    },
  }
})

import { resolveDeployFreeze, readFreezeFileState } from '../web/release-deploy-freeze.js'

const FLAG = 'planning-freeze.enabled'
const setFlag = () => writeFileSync(join(storeHolder.dir, FLAG), '1')

beforeEach(() => {
  storeHolder.dir = mkdtempSync(join(tmpdir(), 'p9-freeze-'))
})
afterEach(() => {
  rmSync(storeHolder.dir, { recursive: true, force: true })
})

describe('resolveDeployFreeze - in-server path (no probe, flag file authoritative)', () => {
  it('flag file present -> SKIP (suppress the deploy)', async () => {
    setFlag()
    expect(await resolveDeployFreeze()).toBe(true)
  })

  it('flag file absent -> allow (the deploy proceeds)', async () => {
    expect(await resolveDeployFreeze()).toBe(false)
  })
})

describe('resolveDeployFreeze - cron path (server freeze-API probe, file fallback)', () => {
  it('API reachable + frozen -> SKIP (authoritative freeze)', async () => {
    expect(await resolveDeployFreeze(async () => ({ reachable: true, frozen: true }))).toBe(true)
  })

  it('API reachable + not-frozen + file absent -> allow (the positive-clear case)', async () => {
    expect(await resolveDeployFreeze(async () => ({ reachable: true, frozen: false }))).toBe(false)
  })

  it('API reachable + not-frozen + file PRESENT -> SKIP (a lingering flag is not ignored; NOT an OR)', async () => {
    setFlag()
    expect(await resolveDeployFreeze(async () => ({ reachable: true, frozen: false }))).toBe(true)
  })

  it('API unreachable + file absent -> SKIP (no authoritative confirmation; absence != automatic green)', async () => {
    expect(await resolveDeployFreeze(async () => ({ reachable: false, frozen: false }))).toBe(true)
  })

  it('API unreachable + file present -> SKIP', async () => {
    setFlag()
    expect(await resolveDeployFreeze(async () => ({ reachable: false, frozen: false }))).toBe(true)
  })

  it('a throwing probe is treated as unreachable -> conservative SKIP', async () => {
    expect(
      await resolveDeployFreeze(async () => {
        throw new Error('ECONNREFUSED')
      })
    ).toBe(true)
  })
})

describe('readFreezeFileState', () => {
  it('reports absent in a fresh store', () => {
    expect(readFreezeFileState()).toBe('absent')
  })

  it('reports present once the flag file is written', () => {
    setFlag()
    expect(readFreezeFileState()).toBe('present')
  })
})
