// Google Drive read+write for the Claudia Google MCP server (ENG-048). Scope:
// the FULL `drive` scope (Boss decision 2026-08-01 TG4809 -- "mindenhez ertsen",
// Claudia sees + writes the whole Drive, not just drive.file). Three tools:
//   - driveListFiles   -> GET  /drive/v3/files            (list/search, read)
//   - driveDownloadFile-> GET  /drive/v3/files/{id}?alt=media  (download, read)
//   - driveUploadFile  -> POST /upload/drive/v3/files (new) OR
//                         PATCH /upload/drive/v3/files/{id} (overwrite, write)
//
// PRE-WRITE BACKUP (Boss requirement, 6-month retention). Order is load-bearing
// and mirrors the calendar deleteEvent undo-snapshot (F-AC7): before ANY
// mutating Drive op (overwrite-upload; and any future delete/move) we fetch the
// file's CURRENT bytes+name and write them to a LOCAL backup on the host
//   store/claudia-drive-backups/<UTC-ISO>__<fileId>__<original-name>
// BEFORE the destructive write. If the backup fails, the write is ABORTED: we
// never overwrite data we could not first snapshot (fail-safe). A NEW file
// (no prior version) has nothing to back up -> no backup, audit line only.
//
// The backup lives on the host disk (NOT on the Boss's Drive quota) and is
// purged after 6 months by scripts/claudia-drive-backup-purge.py.
//
// Egress: this module talks ONLY to *.googleapis.com (www + upload hosts).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Full read+write Drive scope (Boss decision -- broad, not drive.file).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
export const DRIVE_FILES_URL = `${DRIVE_BASE}/files`
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

// A fetch shape rich enough for Drive's mixed text/binary traffic: JSON for
// list/metadata, a binary body for multipart upload, and a binary response for
// download (arrayBuffer). Mirrors youtube-upload's UploadFetch. Node 20's global
// fetch satisfies this; tests inject a stub.
export type DriveFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
  arrayBuffer: () => Promise<ArrayBuffer>
}>

const realFetch = fetch as unknown as DriveFetch

export interface DriveFileMeta {
  id: string
  name: string
  mimeType?: string
  modifiedTime?: string
  size?: string
}

function throwHttp(label: string, status: number, text: string): never {
  throw new Error(`${label} failed: ${status} ${text.slice(0, 200)}`)
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` }
}

// --- LIST (read) ------------------------------------------------------------
function filesListUrl(params: { q?: string; pageSize?: number }): string {
  const url = new URL(DRIVE_FILES_URL)
  if (params.q) url.searchParams.set('q', params.q)
  url.searchParams.set('pageSize', String(params.pageSize ?? 100))
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size)')
  // Include everything the user can see (My Drive + shared drives).
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  return url.toString()
}

// List/search Drive files. Optional `q` is a Drive query string (e.g.
// "name contains 'report'" or "'<folderId>' in parents"). Read-only.
export async function driveListFiles(
  accessToken: string,
  params: { q?: string; pageSize?: number } = {},
  fetchFn: DriveFetch = realFetch,
): Promise<{ files: DriveFileMeta[] }> {
  const res = await fetchFn(filesListUrl(params), { method: 'GET', headers: authHeaders(accessToken) })
  if (!res.ok) throwHttp('drive list', res.status, await res.text().catch(() => ''))
  const j = (await res.json()) as { files?: DriveFileMeta[] }
  return { files: j.files ?? [] }
}

// --- file metadata (name) ---------------------------------------------------
// Fetch just the name (+id/mimeType) for a single file. Used by download naming
// and by the pre-write backup. 404 -> {error}.
export async function driveGetMeta(
  accessToken: string,
  fileId: string,
  fetchFn: DriveFetch = realFetch,
): Promise<DriveFileMeta | { error: string }> {
  const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`)
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size')
  url.searchParams.set('supportsAllDrives', 'true')
  const res = await fetchFn(url.toString(), { method: 'GET', headers: authHeaders(accessToken) })
  if (!res.ok) {
    if (res.status === 404) return { error: 'file not found' }
    throwHttp('drive get meta', res.status, await res.text().catch(() => ''))
  }
  return (await res.json()) as DriveFileMeta
}

// --- download (read) --------------------------------------------------------
// Fetch the raw bytes of a binary file (?alt=media). Google-native docs
// (Docs/Sheets/Slides) are not downloadable this way and 403; exporting those
// is out of scope for v1. Returns the bytes.
export async function driveDownloadBytes(
  accessToken: string,
  fileId: string,
  fetchFn: DriveFetch = realFetch,
): Promise<Uint8Array> {
  const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`)
  url.searchParams.set('alt', 'media')
  url.searchParams.set('supportsAllDrives', 'true')
  const res = await fetchFn(url.toString(), { method: 'GET', headers: authHeaders(accessToken) })
  if (!res.ok) throwHttp('drive download', res.status, await res.text().catch(() => ''))
  return new Uint8Array(await res.arrayBuffer())
}

// Download a file to a local path (0600). Returns the resolved dest path and the
// byte count. The dest dir is created if missing.
export async function driveDownloadFile(
  accessToken: string,
  fileId: string,
  destPath: string,
  fetchFn: DriveFetch = realFetch,
): Promise<{ id: string; path: string; bytes: number }> {
  const bytes = await driveDownloadBytes(accessToken, fileId, fetchFn)
  mkdirSync(dirOf(destPath), { recursive: true, mode: 0o700 })
  writeFileSync(destPath, bytes, { mode: 0o600 })
  return { id: fileId, path: destPath, bytes: bytes.length }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '.' : p.slice(0, i)
}

// --- PRE-WRITE BACKUP (Boss requirement) ------------------------------------
// Sanitize a Drive filename for use as a single local path segment: strip any
// path separators / NUL / CR-LF so an attacker-named file cannot escape the
// backup dir or forge a new path component.
export function sanitizeBackupName(name: string): string {
  return (name || 'unnamed').replace(/[\r\n]+/g, ' ').replace(/[/\\\0]/g, '_').slice(0, 200)
}

// The local backup filename for a file's current version:
//   <UTC-ISO>__<fileId>__<sanitized-original-name>
export function backupFileName(now: number, fileId: string, name: string): string {
  const ts = new Date(now).toISOString()
  return `${ts}__${sanitizeBackupName(fileId)}__${sanitizeBackupName(name)}`
}

// Snapshot a file's CURRENT version to the local backup dir BEFORE it is
// overwritten/deleted. Fetch order is load-bearing: meta -> bytes -> write. If
// ANY step fails (file gone, download error, disk write error) this THROWS so the
// caller aborts the destructive write (fail-safe -- never mutate what we could
// not back up first). Returns the written backup path.
export async function backupDriveFileVersion(
  accessToken: string,
  fileId: string,
  backupDir: string,
  now: number,
  fetchFn: DriveFetch = realFetch,
): Promise<string> {
  const meta = await driveGetMeta(accessToken, fileId, fetchFn)
  if ('error' in meta) {
    throw new Error(`drive backup: cannot snapshot ${fileId}: ${meta.error}`)
  }
  const bytes = await driveDownloadBytes(accessToken, fileId, fetchFn)
  const path = join(backupDir, backupFileName(now, fileId, meta.name))
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

// --- upload (write) ---------------------------------------------------------
// Build a multipart/related body (metadata JSON + media bytes) for the Drive
// upload endpoint. Returns the boundary + the assembled bytes.
export function buildMultipartBody(
  metadata: Record<string, unknown>,
  media: Uint8Array,
  contentType: string,
): { boundary: string; body: Uint8Array; contentType: string } {
  const boundary = `noa-drive-${Math.random().toString(36).slice(2)}-${media.length}`
  const enc = new TextEncoder()
  const head = enc.encode(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--`)
  const body = new Uint8Array(head.length + media.length + tail.length)
  body.set(head, 0)
  body.set(media, head.length)
  body.set(tail, head.length + media.length)
  return { boundary, body, contentType: `multipart/related; boundary=${boundary}` }
}

export interface UploadOpts {
  name?: string
  parents?: string[]
  mimeType?: string
  // Existing fileId -> OVERWRITE that file (media PATCH). Omitted -> new file.
  fileId?: string
}

// Upload media bytes. Two modes:
//   - opts.fileId set  -> OVERWRITE the existing file (multipart PATCH). The
//     caller (server handler) MUST have run backupDriveFileVersion first.
//   - opts.fileId unset-> create a NEW file (multipart POST). No prior version,
//     no backup.
// This module does NOT itself trigger the backup: the server handler owns the
// guard -> backup -> write ordering (see google-mcp-server.ts) so the ordering
// is auditable in one place and the pure fetch functions stay backup-free.
export async function driveUploadFile(
  accessToken: string,
  media: Uint8Array,
  opts: UploadOpts,
  fetchFn: DriveFetch = realFetch,
): Promise<DriveFileMeta> {
  const isOverwrite = typeof opts.fileId === 'string' && opts.fileId.length > 0
  const contentType = opts.mimeType ?? 'application/octet-stream'

  // Metadata part. On overwrite, `parents` cannot be set via a plain PATCH
  // (needs addParents/removeParents), so we only carry name/mimeType there.
  const metadata: Record<string, unknown> = {}
  if (opts.name) metadata.name = opts.name
  if (opts.mimeType) metadata.mimeType = opts.mimeType
  if (!isOverwrite && opts.parents && opts.parents.length > 0) metadata.parents = opts.parents

  const { body, contentType: multipartType } = buildMultipartBody(metadata, media, contentType)

  const url = new URL(isOverwrite ? `${DRIVE_UPLOAD_URL}/${encodeURIComponent(opts.fileId!)}` : DRIVE_UPLOAD_URL)
  url.searchParams.set('uploadType', 'multipart')
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,size')

  const res = await fetchFn(url.toString(), {
    method: isOverwrite ? 'PATCH' : 'POST',
    headers: { ...authHeaders(accessToken), 'Content-Type': multipartType },
    body,
  })
  if (!res.ok) throwHttp(isOverwrite ? 'drive overwrite' : 'drive upload', res.status, await res.text().catch(() => ''))
  return (await res.json()) as DriveFileMeta
}
