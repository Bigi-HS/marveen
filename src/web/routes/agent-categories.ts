import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// Category-tree config for the dashboard /agents view (kanban 78ba4672, AC2/AC8).
//
// The map is { "Category": ["agent_name", ...] }. It is read from disk on EVERY
// request (Option A) so editing seed-config/agent-categories.json takes effect on
// the next page load with NO server restart -- Option C (load-at-startup) is
// explicitly rejected by the spec for that reason.

export const AGENT_CATEGORIES_PATH = join(PROJECT_ROOT, 'seed-config', 'agent-categories.json')

export type AgentCategories = Record<string, string[]>

/**
 * Load + validate the category map from disk. Pure-ish (filesystem read only),
 * exported for tests. Returns an empty map on a missing/invalid file rather than
 * throwing, so the dashboard degrades to an empty tree instead of a 500. Only
 * keeps string keys mapping to arrays of strings; anything else is dropped.
 */
export function loadAgentCategories(path: string = AGENT_CATEGORIES_PATH): AgentCategories {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    logger.warn({ err, path }, 'agent-categories: config parse failed, serving empty map')
    return {}
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: AgentCategories = {}
  for (const [cat, members] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof cat !== 'string' || !cat.trim()) continue
    if (!Array.isArray(members)) continue
    const names = members.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    out[cat] = names
  }
  return out
}

export async function tryHandleAgentCategories(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/agent-categories') return false
  if (method !== 'GET') {
    json(res, { error: 'method not allowed' }, 405)
    return true
  }
  json(res, loadAgentCategories())
  return true
}
