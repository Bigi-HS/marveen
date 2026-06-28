import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'

// This test proves that /api/connectors-hu/* routes are NOT handled by the server.
// Card 97411456: dead feature removal (connectors.hu integration was REJECTED).
// Chad SkillSpector HIGH finding: POST /api/connectors-hu/install ran `curl|sh` on the server.

describe('connectors-hu routes are removed', () => {
  it('tryHandleConnectorsHu module does not exist', async () => {
    // @ts-expect-error -- module intentionally removed (card 97411456)
    await expect(import('../web/routes/connectors-hu.js')).rejects.toThrow()
  })
})
