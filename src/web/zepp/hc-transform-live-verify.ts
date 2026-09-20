// WELL-027 WS5-a: pure drift-verification for the deployed n8n "Transform to Canonical
// Schema" code node. The node body is deployed FROM HC_TRANSFORM_NODE_JS
// (src/web/zepp/hc-transform-node.ts) via scripts/sync-hc-transform-node.mjs, but nothing
// currently catches a POST-deploy divergence: a manual edit in the n8n UI, a half-applied
// deploy, or a stale sync would let the live node drift from the version-controlled +
// unit-tested source while every unit test stays green (they exercise the repo string, not
// the live node).
//
// This module holds the I/O-free comparison logic so it is unit-testable. The live fetch
// (n8n API key from SQLite, GET /api/v1/workflows/<id>) lives in the companion script
// scripts/verify-hc-transform-live.mjs, which feeds the fetched workflow object here.

import { createHash } from 'node:crypto'

interface CodeNode {
  name?: unknown
  parameters?: { jsCode?: unknown }
}

/**
 * Find the "Transform to Canonical Schema" code node and return its jsCode. Mirrors the
 * node-selection logic in scripts/sync-hc-transform-node.mjs (name contains "canonical" AND
 * has a jsCode parameter) so verify and sync agree on which node is authoritative.
 */
export function extractCanonicalNodeCode(workflow: unknown): string {
  const nodes = (workflow as { nodes?: unknown } | null | undefined)?.nodes
  if (!Array.isArray(nodes)) {
    throw new Error('workflow has no nodes array')
  }
  const node = (nodes as CodeNode[]).find(
    (n) =>
      typeof n?.name === 'string' &&
      n.name.toLowerCase().includes('canonical') &&
      n.parameters?.jsCode !== undefined,
  )
  if (!node) {
    throw new Error('no canonical transform node with jsCode found in workflow')
  }
  return String(node.parameters!.jsCode)
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export interface DriftResult {
  inSync: boolean
  liveSha: string
  repoSha: string
  liveLength: number
  repoLength: number
}

/**
 * Compare the live n8n workflow's canonical-node code against the repo source of truth
 * (HC_TRANSFORM_NODE_JS). Byte-identical => inSync. Throws if the live workflow has no
 * canonical code node (a structural failure that must be surfaced, not silently "in sync").
 */
export function compareTransformDrift(liveWorkflow: unknown, repoCode: string): DriftResult {
  const liveCode = extractCanonicalNodeCode(liveWorkflow)
  const liveSha = sha256Hex(liveCode)
  const repoSha = sha256Hex(repoCode)
  return {
    inSync: liveSha === repoSha,
    liveSha,
    repoSha,
    liveLength: liveCode.length,
    repoLength: repoCode.length,
  }
}
