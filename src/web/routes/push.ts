// Web Push endpoints
//
// POST /api/push/subscribe  -- store a PushSubscription from the browser
// POST /api/push/send       -- server-side dispatch to all stored subscriptions
//
// Auth:
//   subscribe: any authenticated identity (non-empty agentId); fail-closed if
//              anonymous so unauthenticated callers cannot hijack subscriptions.
//   send:      admin:* scope required (operator / admin token only); a low-priv
//              agent token cannot trigger mass notifications.
//
// VAPID keys are read from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
// All heavy-lifting (actual sendNotification) is injectable via __setPushSender
// so unit tests stay network-free.

// web-push@4 is a native ESM package that exposes ONLY named exports (no
// default). A default import boots-crashes under Node's ESM loader
// ("does not provide an export named 'default'"), even though tsc stays green
// via @types/web-push@3 + esModuleInterop. Use a namespace import. See
// src/__tests__/push-web-push-esm-import.test.ts (incident 2026-11-12).
import * as webpush from 'web-push'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { readEnvValue } from '../../env.js'
import { getNoaDb } from '../../noa-db.js'
import { logger } from '../../logger.js'
import { hasScope, ADMIN_SCOPE } from '../agent-token-registry.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// ---------------------------------------------------------------------------
// DB seam (injectable for tests; production uses noa.db)
// ---------------------------------------------------------------------------

interface PushDb {
  upsertSubscription(sub: PushSubscription): void
  getAllSubscriptions(): PushSubscription[]
  deleteSubscription(endpoint: string): void
}

let _dbSeam: PushDb | null = null

export function __setDbSeam(db: PushDb | null): void {
  _dbSeam = db
}

function getPushDb(): PushDb {
  if (_dbSeam) return _dbSeam
  return new SqlitePushDb()
}

class SqlitePushDb implements PushDb {
  private db = getNoaDb()

  upsertSubscription(sub: PushSubscription): void {
    this.db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth)
  }

  getAllSubscriptions(): PushSubscription[] {
    const rows = this.db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as Array<{
      endpoint: string
      p256dh: string
      auth: string
    }>
    return rows.map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }))
  }

  deleteSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }
}

// ---------------------------------------------------------------------------
// Push sender seam (injectable for tests)
// ---------------------------------------------------------------------------

type PushSender = (sub: PushSubscription, payload: string) => Promise<void>

let _pushSender: PushSender | null = null

export function __setPushSender(fn: PushSender | null): void {
  _pushSender = fn
}

function buildVapidSender(): PushSender {
  const pub = readEnvValue('VAPID_PUBLIC_KEY')
  const priv = readEnvValue('VAPID_PRIVATE_KEY')
  const subject = readEnvValue('VAPID_SUBJECT') ?? 'mailto:admin@localhost'
  if (pub && priv) {
    webpush.setVapidDetails(subject, pub, priv)
  }
  return async (sub, payload) => {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
    )
  }
}

let _vapidSender: PushSender | null = null

function getSender(): PushSender {
  if (_pushSender) return _pushSender
  if (!_vapidSender) _vapidSender = buildVapidSender()
  return _vapidSender
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Push notification settings (Phase 2C, card 2f8257b2)
// ---------------------------------------------------------------------------

export const PUSH_CATEGORIES = ['workout', 'todo', 'fleet', 'journal'] as const
export type PushCategory = (typeof PUSH_CATEGORIES)[number]
export type PushSettings = Record<PushCategory, boolean>

interface PushSettingsDb {
  getSettings(): PushSettings
  setCategory(category: string, enabled: boolean): void
}

let _settingsDbSeam: PushSettingsDb | null = null

export function __setSettingsDbSeam(db: PushSettingsDb | null): void {
  _settingsDbSeam = db
}

class SqlitePushSettingsDb implements PushSettingsDb {
  private db = getNoaDb()

  getSettings(): PushSettings {
    const rows = this.db.prepare(
      'SELECT category, enabled FROM push_notification_settings',
    ).all() as Array<{ category: string; enabled: number }>
    const result: PushSettings = { workout: true, todo: true, fleet: true, journal: true }
    for (const row of rows) {
      if (PUSH_CATEGORIES.includes(row.category as PushCategory)) {
        result[row.category as PushCategory] = row.enabled !== 0
      }
    }
    return result
  }

  setCategory(category: string, enabled: boolean): void {
    this.db.prepare(
      `INSERT INTO push_notification_settings (category, enabled, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(category) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run(category, enabled ? 1 : 0)
  }
}

function getSettingsDb(): PushSettingsDb {
  if (_settingsDbSeam) return _settingsDbSeam
  return new SqlitePushSettingsDb()
}

// ---------------------------------------------------------------------------
// Schema migration (called at server boot)
// ---------------------------------------------------------------------------

export function applyPushMigrations(db = getNoaDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh   TEXT NOT NULL,
      auth     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_notification_settings (
      category   TEXT PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandlePush(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/push/')) return false

  if (path === '/api/push/subscribe' && method === 'POST') {
    // Fail-closed: require an authenticated identity. The main auth gate
    // already 401s unauthenticated /api/* requests, but we guard explicitly
    // here so the security intent is local and not silently removed if the
    // path ever moves to the public-api list.
    if (!identity?.agentId) {
      json(res, { error: 'authentication required' }, 403)
      return true
    }
    return handleSubscribe(req, res)
  }

  if (path === '/api/push/send' && method === 'POST') {
    // Admin scope required: triggering notifications to all subscribed devices
    // is a privileged operation (open spammer risk). Operator and admin:*
    // tokens pass; low-priv agent tokens do not.
    if (!hasScope(identity?.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'admin scope required to send push notifications' }, 403)
      return true
    }
    return handleSend(req, res)
  }

  if (path === '/api/push/settings' && method === 'GET') {
    if (!identity?.agentId) {
      json(res, { error: 'authentication required' }, 403)
      return true
    }
    json(res, getSettingsDb().getSettings())
    return true
  }

  if (path === '/api/push/settings' && method === 'PUT') {
    if (!identity?.agentId) {
      json(res, { error: 'authentication required' }, 403)
      return true
    }
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 4096 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    const sdb = getSettingsDb()
    for (const cat of PUSH_CATEGORIES) {
      if (typeof data[cat] === 'boolean') {
        sdb.setCategory(cat, data[cat] as boolean)
      }
    }
    json(res, sdb.getSettings())
    return true
  }

  return false
}

async function handleSubscribe(
  req: RouteContext['req'],
  res: RouteContext['res'],
): Promise<true> {
  const raw = await readBody(req, { maxBytes: 8 * 1024 })
  let parsed: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  try {
    parsed = JSON.parse(raw.toString())
  } catch {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }

  if (!parsed.endpoint || typeof parsed.endpoint !== 'string' || !isValidHttpsUrl(parsed.endpoint)) {
    json(res, { error: 'endpoint must be a valid https URL' }, 400)
    return true
  }
  if (!parsed.keys?.p256dh || typeof parsed.keys.p256dh !== 'string') {
    json(res, { error: 'keys.p256dh is required' }, 400)
    return true
  }
  if (!parsed.keys?.auth || typeof parsed.keys.auth !== 'string') {
    json(res, { error: 'keys.auth is required' }, 400)
    return true
  }

  const sub: PushSubscription = {
    endpoint: parsed.endpoint,
    keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth },
  }

  try {
    getPushDb().upsertSubscription(sub)
    json(res, { ok: true }, 201)
  } catch (err) {
    logger.error({ err }, 'push/subscribe: db error')
    json(res, { error: 'internal error' }, 500)
  }
  return true
}

async function handleSend(
  req: RouteContext['req'],
  res: RouteContext['res'],
): Promise<true> {
  const raw = await readBody(req)
  let parsed: { title?: unknown; body?: unknown; url?: unknown }
  try {
    parsed = JSON.parse(raw.toString())
  } catch {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }

  if (!parsed.title || typeof parsed.title !== 'string') {
    json(res, { error: 'title is required' }, 400)
    return true
  }

  const subs = getPushDb().getAllSubscriptions()
  const sender = getSender()
  const payload = JSON.stringify({
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    url: typeof parsed.url === 'string' ? parsed.url : '/',
  })

  let sent = 0
  let failed = 0
  await Promise.all(subs.map(async sub => {
    try {
      await sender(sub, payload)
      sent++
    } catch (err) {
      failed++
      logger.warn({ err, endpoint: sub.endpoint }, 'push/send: delivery failed')
    }
  }))

  json(res, { ok: true, sent, failed })
  return true
}
