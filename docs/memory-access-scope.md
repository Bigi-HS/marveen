# Memory `access_scope` (PII governance)

Card 1dd349bd. Spec: `store/specs/memory-privacy-governance.md`.

Per-agent read-visibility for the shared `memories` table. A nullable
`access_scope TEXT` column scopes a memory to a single agent so PII written in
one agent's context (health, address, calendar, financial) does not
accidentally surface in another agent's recall.

## Semantics

`access_scope` is **read-visibility**, orthogonal to `agent_id` (authorship):

| `access_scope` | Visible to |
|---|---|
| `NULL` / `''` | unscoped -- follows the pre-existing own + `category='shared'` rules |
| `'<agent-id>'` | only that agent (overrides `category='shared'`) |

The visibility predicate (`applyScopeFilter` in `src/db.ts`):

```
visible(row, requester) = !row.access_scope || row.access_scope === requester
```

applied as a **subtractive** post-filter on top of each recall path's existing
`(agent_id = ? OR category = 'shared')` candidate selection. It only hides
scoped rows; it never widens visibility. A `null` requester is the
operator/admin context (the dashboard sees everything, including scoped rows).

## ⚠️ ADVISORY boundary -- not a hard security control

The `requester` identity is the caller-supplied `?agent=` query parameter. Under
the fleet's single shared Bearer token (`store/.dashboard-token`), that
parameter is **not cryptographically authenticated** -- the token authenticates
the operator (Dominik), not an individual agent. `access_scope` therefore
prevents **accidental** cross-agent PII recall; it is **not** adversarial
containment.

### Bypass vectors (documented, by design)

1. **Spoofable identity** -- any caller with the Bearer token can pass
   `?agent=<target>` and read as that agent.
2. **FS-direct read** -- `store/claudeclaw.db` is a plain SQLite file; any
   process with filesystem access can `SELECT * FROM memories` and ignore every
   API-layer filter.
3. **Curator bypass** -- agents on the server-side `CURATOR_AGENTS` allowlist
   (Applegate) read across all scopes for vault curation. This is a code
   constant, never a `?curator=true` query parameter.
4. **Hard fix** -- OS-user isolation (card 8dac7f1d) is the real boundary; this
   feature is hygiene only.

## Write-time behavior

- **PII auto-scope (PM-AC4)** -- on write, if `keywords`/`content` match the v1
  PII heuristic (`isPotentialPII`, accent-insensitive; health + address +
  calendar + financial + Hungarian national IDs), `access_scope` defaults to the
  author's `agent_id`. Pass `access_scope: null` explicitly to opt out (store
  public).
- **Scoped+shared rejected (PM-AC9)** -- a write combining `category='shared'`
  with a non-null `access_scope` (explicit or auto-scoped) is rejected with HTTP
  400 (`ScopedSharedError`): "shared with everyone but visible only to X" is
  contradictory.

## Retroactive scan (PM-AC7)

`npx tsx scripts/memory-pii-scan.ts` reports existing **unscoped** rows that match
the PII heuristic, for **manual** review. It writes nothing and applies no
scopes. Its output may contain PII keywords -- do not commit it.
