/**
 * Tests for GET+PUT /api/agents/:id/telegram-access (card 86e0c042 AC-2).
 * Tests the pure helper functions readTelegramAccessView and
 * applyTelegramAccessAction with real tmpdir I/O.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readTelegramAccessView,
  applyTelegramAccessAction,
} from '../web/routes/agents.js'

let dir: string
let accessPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-access-'))
  accessPath = join(dir, 'access.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.now()
const FUTURE = NOW + 60_000
const PAST = NOW - 60_000

function writeAccess(data: object) {
  writeFileSync(accessPath, JSON.stringify(data, null, 2))
}

describe('readTelegramAccessView', () => {
  it('returns empty pending+allowFrom when file missing', () => {
    const view = readTelegramAccessView(accessPath)
    expect(view.pending).toEqual({})
    expect(view.allowFrom).toEqual([])
  })

  it('returns pending and allowFrom from existing file', () => {
    writeAccess({
      dmPolicy: 'pairing',
      allowFrom: ['111', '222'],
      pending: {
        ABC123: { senderId: '333', chatId: '-100', createdAt: NOW, expiresAt: FUTURE },
      },
    })
    const view = readTelegramAccessView(accessPath)
    expect(view.allowFrom).toEqual(['111', '222'])
    expect(view.pending['ABC123'].senderId).toBe('333')
    expect(view.pending['ABC123'].expiresAt).toBe(FUTURE)
  })

  it('returns empty on corrupt JSON (fail-safe)', () => {
    writeFileSync(accessPath, 'not json')
    const view = readTelegramAccessView(accessPath)
    expect(view.pending).toEqual({})
    expect(view.allowFrom).toEqual([])
  })
})

describe('applyTelegramAccessAction — approve', () => {
  it('moves senderId to allowFrom and deletes pending entry', () => {
    writeAccess({
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: {
        XYZ: { senderId: '555', chatId: '-200', createdAt: NOW, expiresAt: FUTURE },
      },
    })
    const result = applyTelegramAccessAction(accessPath, 'approve', 'XYZ')
    expect(result).not.toBeNull()
    expect(result!.senderId).toBe('555')

    const saved = JSON.parse(readFileSync(accessPath, 'utf-8'))
    expect(saved.allowFrom).toContain('555')
    expect(saved.pending['XYZ']).toBeUndefined()
  })

  it('does NOT modify dmPolicy', () => {
    writeAccess({ dmPolicy: 'pairing', allowFrom: [], pending: { K1: { senderId: 'A', chatId: 'B', createdAt: NOW, expiresAt: FUTURE } } })
    applyTelegramAccessAction(accessPath, 'approve', 'K1')
    const saved = JSON.parse(readFileSync(accessPath, 'utf-8'))
    expect(saved.dmPolicy).toBe('pairing')
  })

  it('dedups allowFrom (does not double-add existing senderId)', () => {
    writeAccess({ allowFrom: ['999'], pending: { P1: { senderId: '999', chatId: 'x', createdAt: NOW, expiresAt: FUTURE } } })
    applyTelegramAccessAction(accessPath, 'approve', 'P1')
    const saved = JSON.parse(readFileSync(accessPath, 'utf-8'))
    expect(saved.allowFrom.filter((s: string) => s === '999').length).toBe(1)
  })

  it('writes approved marker file', () => {
    writeAccess({ allowFrom: [], pending: { M1: { senderId: 'user42', chatId: 'c', createdAt: NOW, expiresAt: FUTURE } } })
    applyTelegramAccessAction(accessPath, 'approve', 'M1')
    expect(existsSync(join(dir, 'approved', 'user42'))).toBe(true)
  })

  it('returns null for unknown code', () => {
    writeAccess({ allowFrom: [], pending: {} })
    expect(applyTelegramAccessAction(accessPath, 'approve', 'NOPE')).toBeNull()
  })

  it('returns null for expired code (chad LOW fix)', () => {
    writeAccess({ allowFrom: [], pending: { EXP: { senderId: 'x', chatId: 'y', createdAt: NOW, expiresAt: PAST } } })
    expect(applyTelegramAccessAction(accessPath, 'approve', 'EXP')).toBeNull()
  })
})

describe('applyTelegramAccessAction — deny', () => {
  it('deletes pending entry without touching allowFrom', () => {
    writeAccess({ allowFrom: ['existing'], pending: { D1: { senderId: 'bad', chatId: 'x', createdAt: NOW, expiresAt: FUTURE } } })
    const result = applyTelegramAccessAction(accessPath, 'deny', 'D1')
    expect(result!.senderId).toBe('bad')

    const saved = JSON.parse(readFileSync(accessPath, 'utf-8'))
    expect(saved.pending['D1']).toBeUndefined()
    expect(saved.allowFrom).toEqual(['existing'])
  })

  it('does NOT write approved marker on deny', () => {
    writeAccess({ allowFrom: [], pending: { D2: { senderId: 'gone', chatId: 'x', createdAt: NOW, expiresAt: FUTURE } } })
    applyTelegramAccessAction(accessPath, 'deny', 'D2')
    expect(existsSync(join(dir, 'approved', 'gone'))).toBe(false)
  })

  it('does NOT modify dmPolicy on deny', () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: [], pending: { D3: { senderId: 'z', chatId: 'x', createdAt: NOW, expiresAt: FUTURE } } })
    applyTelegramAccessAction(accessPath, 'deny', 'D3')
    const saved = JSON.parse(readFileSync(accessPath, 'utf-8'))
    expect(saved.dmPolicy).toBe('allowlist')
  })

  it('returns null for unknown code', () => {
    writeAccess({ allowFrom: [], pending: {} })
    expect(applyTelegramAccessAction(accessPath, 'deny', 'GHOST')).toBeNull()
  })
})

describe('route registration (source-text)', () => {
  it('GET /api/agents/:id/telegram-access is registered', () => {
    const src = readFileSync(new URL('../web/routes/agents.ts', import.meta.url).pathname, 'utf-8')
    expect(src).toContain('/telegram-access')
    expect(src).toContain("method === 'GET'")
  })

  it('PUT /api/agents/:id/telegram-access is registered', () => {
    const src = readFileSync(new URL('../web/routes/agents.ts', import.meta.url).pathname, 'utf-8')
    expect(src).toContain("method === 'PUT'")
    expect(src).toContain("action: 'approve'")
  })

  it('MAIN_AGENT_ID is blocked (AC-3)', () => {
    const src = readFileSync(new URL('../web/routes/agents.ts', import.meta.url).pathname, 'utf-8')
    expect(src).toContain('MAIN_AGENT_ID')
    expect(src).toContain('403')
  })

  it('exports readTelegramAccessView and applyTelegramAccessAction', () => {
    const src = readFileSync(new URL('../web/routes/agents.ts', import.meta.url).pathname, 'utf-8')
    expect(src).toContain('export function readTelegramAccessView')
    expect(src).toContain('export function applyTelegramAccessAction')
  })
})
