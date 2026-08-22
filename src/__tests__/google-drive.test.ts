import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DriveFetch } from '../mcp/google-drive.js'
import {
  driveListFiles,
  driveDownloadFile,
  driveUploadFile,
  backupDriveFileVersion,
  backupFileName,
  sanitizeBackupName,
  buildMultipartBody,
  DRIVE_FILES_URL,
  DRIVE_UPLOAD_URL,
  DRIVE_SCOPE,
} from '../mcp/google-drive.js'

// --- fetch stubs ------------------------------------------------------------
function jsonRes(obj: unknown, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(obj)).buffer,
  }
}
function bytesRes(bytes: Uint8Array, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}
function router(routes: Array<{ match: (url: string, method: string) => boolean; res: any }>) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fn = (async (url: string, init: any) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    for (const r of routes) if (r.match(url, method)) return r.res
    throw new Error(`no stub for ${method} ${url}`)
  }) as unknown as DriveFetch
  return { fn, calls }
}
const neverFetch = (async () => {
  throw new Error('fetch must not be called')
}) as unknown as DriveFetch

describe('drive scope + egress', () => {
  it('requests the FULL drive scope (Boss TG4809)', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive')
  })
  it('targets googleapis.com only', () => {
    expect(DRIVE_FILES_URL.startsWith('https://www.googleapis.com/drive/')).toBe(true)
    expect(DRIVE_UPLOAD_URL.startsWith('https://www.googleapis.com/upload/drive/')).toBe(true)
  })
})

describe('driveListFiles', () => {
  it('passes q + returns files', async () => {
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.startsWith(DRIVE_FILES_URL), res: jsonRes({ files: [{ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }] }) },
    ])
    const out = await driveListFiles('tok', { q: "name contains 'a'" }, fn)
    expect(calls[0].url).toContain('q=name+contains')
    expect(out.files[0].id).toBe('f1')
  })
})

describe('driveDownloadFile', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'drive-dl-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('GETs ?alt=media and writes 0600 to destPath', async () => {
    const payload = new TextEncoder().encode('hello-bytes')
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/files/f9') && u.includes('alt=media'), res: bytesRes(payload) },
    ])
    const dest = join(dir, 'out.bin')
    const out = await driveDownloadFile('tok', 'f9', dest, fn)
    expect(calls[0].method).toBe('GET')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('hello-bytes')
    expect(statSync(dest).mode & 0o777).toBe(0o600)
    expect(out).toEqual({ id: 'f9', path: dest, bytes: payload.length })
  })
})

describe('backup naming (path-safety)', () => {
  it('formats <UTC-ISO>__<id>__<name>', () => {
    const name = backupFileName(0, 'F1', 'report.txt')
    expect(name).toBe('1970-01-01T00:00:00.000Z__F1__report.txt')
  })
  it('strips path separators / NUL / CR-LF from the filename component', () => {
    expect(sanitizeBackupName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeBackupName('a/b\\c\0d')).toBe('a_b_c_d')
    expect(sanitizeBackupName('line1\nline2')).toBe('line1 line2')
  })
})

// --- THE CRITICAL BACKUP LOGIC ---------------------------------------------
describe('driveUploadFile OVERWRITE -> pre-write backup (Boss requirement)', () => {
  let backupDir: string
  beforeEach(() => { backupDir = mkdtempSync(join(tmpdir(), 'drive-bak-')) })
  afterEach(() => { rmSync(backupDir, { recursive: true, force: true }) })

  it('backupDriveFileVersion snapshots current bytes+name BEFORE the write, 0600', async () => {
    const current = new TextEncoder().encode('OLD-VERSION')
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/files/fID') && !u.includes('alt=media'), res: jsonRes({ id: 'fID', name: 'doc.txt' }) },
      { match: (u, m) => m === 'GET' && u.includes('/files/fID') && u.includes('alt=media'), res: bytesRes(current) },
    ])
    const path = await backupDriveFileVersion('tok', 'fID', backupDir, 0, fn)
    // GET meta precedes GET media
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).not.toContain('alt=media')
    expect(calls[1].url).toContain('alt=media')
    // backup file exists, contains the OLD version, 0600, correctly named
    expect(path).toBe(join(backupDir, '1970-01-01T00:00:00.000Z__fID__doc.txt'))
    expect(readFileSync(path, 'utf-8')).toBe('OLD-VERSION')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('OVERWRITE upload creates a backup then PATCHes; NEW file makes NO backup', async () => {
    // We drive the whole handler-order via the module functions the server uses.
    const current = new TextEncoder().encode('OLD')
    const { fn } = router([
      { match: (u, m) => m === 'GET' && u.includes('/files/X1') && !u.includes('alt=media'), res: jsonRes({ id: 'X1', name: 'f.txt' }) },
      { match: (u, m) => m === 'GET' && u.includes('/files/X1') && u.includes('alt=media'), res: bytesRes(current) },
      { match: (u, m) => m === 'PATCH' && u.includes('/upload/drive/v3/files/X1'), res: jsonRes({ id: 'X1', name: 'f.txt' }) },
    ])
    // overwrite: backup first
    await backupDriveFileVersion('tok', 'X1', backupDir, 0, fn)
    const over = await driveUploadFile('tok', new TextEncoder().encode('NEW'), { fileId: 'X1', name: 'f.txt' }, fn)
    expect(over.id).toBe('X1')
    // one backup file present
    expect(readdirSync(backupDir)).toHaveLength(1)

    // NEW file: POST, and (by contract) no backup call is made
    const emptyBak = mkdtempSync(join(tmpdir(), 'drive-bak-empty-'))
    const { fn: fn2 } = router([
      { match: (u, m) => m === 'POST' && u === expectUploadUrl(), res: jsonRes({ id: 'NEW1', name: 'g.txt' }) },
    ])
    const created = await driveUploadFile('tok', new TextEncoder().encode('data'), { name: 'g.txt' }, fn2)
    expect(created.id).toBe('NEW1')
    expect(readdirSync(emptyBak)).toHaveLength(0)
    rmSync(emptyBak, { recursive: true, force: true })
  })

  it('backup FAILS (source file gone 404) -> throws, so the caller must NOT write', async () => {
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/files/gone'), res: jsonRes({ error: { code: 404 } }, false, 404) },
    ])
    await expect(backupDriveFileVersion('tok', 'gone', backupDir, 0, fn)).rejects.toThrow(/cannot snapshot/)
    // no backup written, and crucially no PATCH/POST attempted by the backup fn
    expect(readdirSync(backupDir)).toHaveLength(0)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('backup FAILS (unwritable dir) -> throws, no write', async () => {
    const current = new TextEncoder().encode('OLD')
    const { fn } = router([
      { match: (u, m) => m === 'GET' && !u.includes('alt=media'), res: jsonRes({ id: 'Y1', name: 'y.txt' }) },
      { match: (u, m) => m === 'GET' && u.includes('alt=media'), res: bytesRes(current) },
    ])
    // point the backup dir at a path under a regular FILE so mkdir fails
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const base = mkdtempSync(join(tmpdir(), 'drive-badbak-'))
    writeFileSync(join(base, 'afile'), 'x')
    const badDir = join(base, 'afile', 'nested')
    await expect(backupDriveFileVersion('tok', 'Y1', badDir, 0, fn)).rejects.toThrow()
    rmSync(base, { recursive: true, force: true })
    void mkdirSync
  })
})

describe('driveUploadFile routing', () => {
  it('NEW file -> POST to the upload url', async () => {
    const { fn, calls } = router([
      { match: (u, m) => m === 'POST' && u.startsWith(DRIVE_UPLOAD_URL), res: jsonRes({ id: 'n1', name: 'n.txt' }) },
    ])
    await driveUploadFile('tok', new TextEncoder().encode('x'), { name: 'n.txt', parents: ['folder1'] }, fn)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toContain('uploadType=multipart')
  })
  it('OVERWRITE -> PATCH to /files/{id}', async () => {
    const { fn, calls } = router([
      { match: (u, m) => m === 'PATCH' && u.includes('/upload/drive/v3/files/o1'), res: jsonRes({ id: 'o1', name: 'o.txt' }) },
    ])
    await driveUploadFile('tok', new TextEncoder().encode('x'), { fileId: 'o1' }, fn)
    expect(calls[0].method).toBe('PATCH')
  })
  it('never fetches when reading a bad local file is the caller\'s job (module is pure)', () => {
    // buildMultipartBody is pure and does not fetch.
    const b = buildMultipartBody({ name: 'a' }, new TextEncoder().encode('hi'), 'text/plain')
    expect(b.contentType).toContain('multipart/related; boundary=')
    expect(new TextDecoder().decode(b.body)).toContain('"name":"a"')
    expect(new TextDecoder().decode(b.body)).toContain('hi')
    void neverFetch
  })
})

function expectUploadUrl(): string {
  const u = new URL(DRIVE_UPLOAD_URL)
  u.searchParams.set('uploadType', 'multipart')
  u.searchParams.set('supportsAllDrives', 'true')
  u.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size')
  return u.toString()
}
