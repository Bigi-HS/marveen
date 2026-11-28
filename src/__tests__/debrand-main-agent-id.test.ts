// De-brand STAGE-2 (card 7684e3ac): routing-critical identity literals that used
// to be hardcoded 'marveen' must now resolve from the exported MAIN_AGENT_ID
// constant, so the orchestrator identity can be flipped via the MAIN_AGENT_ID
// env var without a code change.
//
// Two assertion styles are used:
//   1. VALUE tests -- import the actual const/function and assert it equals /
//      resolves to MAIN_AGENT_ID. These fail if the literal is reintroduced
//      AND would follow a real env-driven flip.
//   2. SOURCE-AUDIT tests -- read the .ts source and pin that it references
//      MAIN_AGENT_ID (and no raw 'marveen' routing literal remains). This is
//      the repo's established pattern for route-handler wiring that is awkward
//      to exercise end-to-end (see message-router-delivery-outcome.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { MAIN_AGENT_ID } from '../config.js'
import { OPERATOR_AGENT_ID } from '../web/agent-token-registry.js'
import { scopesForAgent } from '../web/agent-token-provision.js'
import { ADMIN_SCOPE } from '../web/agent-token-registry.js'
import { resolveRequestIdentity } from '../web/agent-identity-binding.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
function src(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8')
}

describe('de-brand STAGE-2: value-level identity resolution', () => {
  it('OPERATOR_AGENT_ID resolves to MAIN_AGENT_ID (agent-token-registry)', () => {
    expect(OPERATOR_AGENT_ID).toBe(MAIN_AGENT_ID)
  })

  it('scopesForAgent(MAIN_AGENT_ID) grants the admin sentinel (agent-token-provision)', () => {
    // The operator identity (whatever MAIN_AGENT_ID is) must map to ADMIN_SCOPE;
    // a hardcoded 'marveen' check would break the moment the id is flipped.
    expect(scopesForAgent(MAIN_AGENT_ID)).toEqual([ADMIN_SCOPE])
  })
})

describe('de-brand STAGE-2: agent-token-registry source audit', () => {
  const SRC = src('web', 'agent-token-registry.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/config\.js'/)
  })
  it('OPERATOR_AGENT_ID is assigned from MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/export const OPERATOR_AGENT_ID\s*=\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/OPERATOR_AGENT_ID\s*=\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: agent-token-provision source audit', () => {
  const SRC = src('web', 'agent-token-provision.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/config\.js'/)
  })
  it('scopesForAgent compares against MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/agentId\s*===\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/agentId\s*===\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: rate-limit-governor-cli source audit', () => {
  const SRC = src('web', 'rate-limit-governor-cli.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/config\.js'/)
  })
  it('NOTIFY_TO is assigned from MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/const NOTIFY_TO\s*=\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/NOTIFY_TO\s*=\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: routes/gate.ts source audit', () => {
  const SRC = src('web', 'routes', 'gate.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/\.\.\/config\.js'/)
  })
  it('both createAgentMessage alerts route to MAIN_AGENT_ID recipient', () => {
    // gate.ts has exactly two createAgentMessage(... , recipient, ...) calls
    // whose recipient was the hardcoded orchestrator id.
    const recips = SRC.match(/createAgentMessage\(\s*'gate',\s*MAIN_AGENT_ID,/g) ?? []
    expect(recips.length).toBe(2)
  })
  it('no raw marveen recipient literal remains in a createAgentMessage call', () => {
    expect(SRC).not.toMatch(/createAgentMessage\(\s*'gate',\s*'marveen',/)
  })
})

describe('de-brand STAGE-2: routes/ideas.ts source audit', () => {
  const SRC = src('web', 'routes', 'ideas.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/\.\.\/config\.js'/)
  })
  it('all three assignee defaults reference MAIN_AGENT_ID', () => {
    // two plain `assignee: MAIN_AGENT_ID` + one `assignee: st.assignee || MAIN_AGENT_ID`
    const plain = SRC.match(/assignee:\s*MAIN_AGENT_ID\b/g) ?? []
    const fallback = SRC.match(/assignee:\s*st\.assignee\s*\|\|\s*MAIN_AGENT_ID\b/g) ?? []
    expect(plain.length).toBe(2)
    expect(fallback.length).toBe(1)
  })
  it('no raw marveen assignee literal remains', () => {
    expect(SRC).not.toMatch(/assignee:\s*'marveen'/)
    expect(SRC).not.toMatch(/assignee:\s*st\.assignee\s*\|\|\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: routes/workout.ts source audit', () => {
  const SRC = src('web', 'routes', 'workout.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/\.\.\/config\.js'/)
  })
  it('fromAgent fallback references MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/const fromAgent\s*=\s*identity\?\.agentId\s*\?\?\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/identity\?\.agentId\s*\?\?\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: obsidian-ingest-cli.ts source audit', () => {
  const SRC = src('obsidian-ingest-cli.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\/config\.js'/)
  })
  it('default agentId references MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/agentId:\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/agentId:\s*'marveen'/)
  })
  it('the /api/memories query interpolates MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/\/api\/memories\?agent=\$\{MAIN_AGENT_ID\}/)
    expect(SRC).not.toMatch(/\/api\/memories\?agent=marveen/)
  })
})

describe('de-brand STAGE-2: agent-identity-binding operator identity', () => {
  it('a valid browser session resolves to MAIN_AGENT_ID (operator identity)', () => {
    // hasSession:true returns the operator identity early, without touching db.
    const r = resolveRequestIdentity({
      hasSession: true,
      bearer: '',
      db: null as unknown as import('better-sqlite3').Database,
      sharedToken: '',
      now: 0,
      isWrite: false,
    })
    expect(r.pass).toBe(true)
    if (!r.pass) throw new Error('expected operator session to pass')
    expect(r.identity.agentId).toBe(MAIN_AGENT_ID)
  })
  const SRC = src('web', 'agent-identity-binding.ts')
  it('operator identity references OPERATOR_AGENT_ID, not a raw marveen literal', () => {
    expect(SRC).toMatch(/agentId:\s*OPERATOR_AGENT_ID/)
    expect(SRC).not.toMatch(/identity:\s*\{\s*agentId:\s*'marveen'/)
  })
})

describe('de-brand STAGE-2: deploy-delta-cli.ts source audit', () => {
  const SRC = src('web', 'deploy-delta-cli.ts')
  it('imports MAIN_AGENT_ID from config', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*MAIN_AGENT_ID[^}]*\}\s*from\s*'\.\.\/config\.js'/)
  })
  it('the Genesis deploy notice routes to MAIN_AGENT_ID, not a literal', () => {
    expect(SRC).toMatch(/to:\s*MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/to:\s*'marveen'/)
  })
})
