#!/usr/bin/env node
// Write the canonical HC_TRANSFORM_NODE_JS (src/web/zepp/hc-transform-node.ts, compiled to
// dist) into the n8n workflow JSON's "Transform to Canonical Schema" code node, so the
// deployed n8n node is byte-identical to the version-controlled + unit-tested source.
//
// The workflow JSON lives under gitignored store/ (runtime data); this script regenerates it
// from the tracked module. Run after `npm run build`, before forge deploys the workflow.
//   node scripts/sync-hc-transform-node.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { HC_TRANSFORM_NODE_JS } from '../dist/web/zepp/hc-transform-node.js'

const WF = 'store/n8n-workflows/zepp-hc-ingest-transform.json'
const wf = JSON.parse(readFileSync(WF, 'utf8'))
const node = wf.nodes.find(
  (n) => (n.name || '').toLowerCase().includes('canonical') && n.parameters?.jsCode !== undefined,
)
if (!node) {
  console.error('transform node with jsCode not found in', WF)
  process.exit(1)
}
const changed = node.parameters.jsCode !== HC_TRANSFORM_NODE_JS
node.parameters.jsCode = HC_TRANSFORM_NODE_JS
writeFileSync(WF, JSON.stringify(wf, null, 2) + '\n')
console.log(changed ? 'updated node jsCode from HC_TRANSFORM_NODE_JS' : 'node jsCode already in sync')
