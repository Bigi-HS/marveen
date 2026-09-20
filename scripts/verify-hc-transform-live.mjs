#!/usr/bin/env node
// WELL-027 WS5-a: post-deploy drift sentinel for the n8n "Transform to Canonical Schema"
// node. Asserts that the LIVE node body served by n8n is byte-identical to the
// version-controlled HC_TRANSFORM_NODE_JS (src/web/zepp/hc-transform-node.ts). Nothing else
// catches a divergence introduced by a manual UI edit, a half-applied deploy, or a stale
// sync -- every unit test exercises the repo string, not the deployed node.
//
// Run AFTER a deploy (companion to scripts/sync-hc-transform-node.mjs) or on a schedule:
//   npm run build && node scripts/verify-hc-transform-live.mjs
//
// Exit codes: 0 in sync; 1 DRIFT detected; 2 operational error (n8n unreachable, no API key,
// workflow/node not found). Only exit 1 means the deployed logic diverged from source.
//
// Optional: --alert pings marveen via the dashboard inter-agent bus on drift (best-effort,
// never changes the exit code).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'
import { HC_TRANSFORM_NODE_JS } from '../dist/web/zepp/hc-transform-node.js'
import { compareTransformDrift } from '../dist/web/zepp/hc-transform-live-verify.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const N8N_BASE = process.env.N8N_BASE || 'http://127.0.0.1:5678/api/v1'
const N8N_DB = process.env.N8N_DB || resolve(homedir(), '.n8n/.n8n/database.sqlite')
const LOCAL_WF = resolve(ROOT, 'store/n8n-workflows/zepp-hc-ingest-transform.json')
const ALERT = process.argv.includes('--alert')

function fail(code, msg) {
  console.error(`verify-hc-transform-live: ${msg}`)
  process.exit(code)
}

// Workflow id: prefer the deploy artifact (store JSON is what forge pushes), allow override.
function resolveWorkflowId() {
  if (process.env.N8N_WORKFLOW_ID) return process.env.N8N_WORKFLOW_ID
  try {
    const wf = JSON.parse(readFileSync(LOCAL_WF, 'utf8'))
    if (wf?.id) return wf.id
  } catch {
    /* fall through */
  }
  return null
}

function getApiKey() {
  if (process.env.N8N_API_KEY) return process.env.N8N_API_KEY
  try {
    const db = new Database(N8N_DB, { readonly: true, fileMustExist: true })
    const row = db
      .prepare("SELECT apiKey FROM user_api_keys WHERE label='forge-automation'")
      .get()
    db.close()
    return row?.apiKey || null
  } catch (e) {
    return null
  }
}

async function fetchWorkflow(id, apiKey) {
  const res = await fetch(`${N8N_BASE}/workflows/${id}`, {
    headers: { 'X-N8N-API-KEY': apiKey, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET /workflows/${id} -> HTTP ${res.status}`)
  return res.json()
}

async function alertDrift(result, id) {
  try {
    const token = readFileSync(resolve(ROOT, 'store/.dashboard-token'), 'utf8').trim()
    const content =
      `WELL-027 WS5-a DRIFT: a LIVE n8n "Transform to Canonical Schema" node (wf ${id}) ` +
      `elter a repo forrastol. live sha=${result.liveSha.slice(0, 12)} (${result.liveLength}b) vs ` +
      `repo sha=${result.repoSha.slice(0, 12)} (${result.repoLength}b). ` +
      `Ok: kezi UI-edit / fel-alkalmazott deploy / stale sync. Fix: npm run build && ` +
      `node scripts/sync-hc-transform-node.mjs -> forge re-deploy -> re-verify.`
    await fetch('http://localhost:3420/api/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'dave', to: 'marveen', content }),
    })
  } catch {
    /* best-effort; never mask the drift exit code */
  }
}

const id = resolveWorkflowId()
if (!id) fail(2, `could not resolve workflow id (no N8N_WORKFLOW_ID and ${LOCAL_WF} unreadable)`)

const apiKey = getApiKey()
if (!apiKey) fail(2, `no n8n API key (set N8N_API_KEY or forge-automation row in ${N8N_DB})`)

let workflow
try {
  workflow = await fetchWorkflow(id, apiKey)
} catch (e) {
  fail(2, `live fetch failed: ${e.message}`)
}

let result
try {
  result = compareTransformDrift(workflow, HC_TRANSFORM_NODE_JS)
} catch (e) {
  fail(2, `comparison failed: ${e.message}`)
}

if (result.inSync) {
  console.log(
    `in sync: live == repo (sha ${result.repoSha.slice(0, 12)}, ${result.repoLength} bytes, wf ${id})`,
  )
  process.exit(0)
}

console.error(
  `DRIFT: live sha=${result.liveSha} (${result.liveLength}b) != repo sha=${result.repoSha} (${result.repoLength}b) [wf ${id}]`,
)
if (ALERT) await alertDrift(result, id)
process.exit(1)
