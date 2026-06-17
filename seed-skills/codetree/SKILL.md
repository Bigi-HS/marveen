---
name: codetree
description: Navigate the marveen codebase without reading files. Query a pre-indexed code knowledge graph (symbols, exports, import edges) over a REST API instead of grep + Read. Use when you need to find where a symbol is defined, what a file exports, or which files import a module. Trigger when about to grep/Read source just to locate a symbol or map dependencies.
---

# Codetree -- pre-indexed code knowledge graph

A background index of the marveen TypeScript codebase (`src/**/*.ts` + `scripts/**/*.ts`,
tests excluded) parsed with the TypeScript compiler API and stored in `store/codetree.db`.
Answer "where is X / what does this file export / who imports this module" in ONE API call
with ZERO file reads. Saves context tokens versus grep + Read, especially on large files
(db.ts has 138 exports).

## When to use

- You need the file + line where a symbol is defined -> `symbol`.
- You need the full export surface of a file before editing or importing it -> `exports`.
- You need every file that imports a module (blast radius of a change) -> `importers`.
- Before you reach for `grep -rn "function foo"` + `Read` just to locate code.

Do NOT use it for: reading the actual implementation (Read the file once located), call
graphs / "who calls X" (Phase 2, not indexed), or type resolution.

## Auth + base

All endpoints are Bearer-protected, same token as every other dashboard API:

```bash
TOKEN=$(cat store/.dashboard-token)   # run from the repo root
BASE=http://localhost:3420
```

## ALWAYS check staleness first (CT-SEC1)

The index is rebuilt daily at 03:00 and on demand. A stale index can point you at the wrong
line. Before trusting results, check `/meta` -- if `stale` is true (indexed_at older than 24h),
WARN and rebuild:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/codetree/meta"
# { "indexed_at": "...", "files_count": 175, "symbols_count": 2081,
#   "imports_count": 944, "schema_version": "1", "stale": false }
```

If `stale: true`: tell the user "Warning: codetree index is more than 24h old; rebuilding"
and POST a rebuild (below). If `/meta` returns **503**, the index was never built -- rebuild once.

## Query patterns

### 1. Where is a symbol defined? (`symbol`)

Exact, case-sensitive match on the symbol name. Returns all matches (a name can collide across
files -- disambiguate by `file`).

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/codetree/symbol?name=saveAgentMemory"
# { "indexed_at": "...",
#   "results": [ { "name": "saveAgentMemory", "kind": "function",
#                  "file": "src/db.ts", "line": 1009, "exported": true } ] }
```

`results: []` (200) means no such symbol. Missing/empty `name` returns 400 (guards against
dumping all ~2000 symbols).

### 2. What does a file export? (`exports`)

Repo-relative path. Returns only exported symbols.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/codetree/exports?file=src/db.ts"
# { "indexed_at": "...", "file": "src/db.ts",
#   "exports": [ { "name": "saveAgentMemory", "kind": "function", "line": 1009 }, ... ] }
```

404 if the path was never indexed (check the path; remember tests + `*.d.ts` are excluded).

### 3. Who imports a module? (`importers`)

Both relative (`./db`) and repo-relative (`src/db.ts`) query forms resolve to the same edge.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/codetree/importers?module=src/db.ts"
# { "indexed_at": "...", "module": "src/db.ts",
#   "importers": [ { "from_file": "src/memory.ts", "imported_names": ["saveAgentMemory"] },
#                  { "from_file": "src/heartbeat.ts", "imported_names": null } ] }
```

`imported_names` is null for namespace / default / side-effect / `export *` imports. Package
modules work too: `?module=better-sqlite3` returns every file importing that package.

## On-demand rebuild

Full rebuild (drops + reparses everything in a child process; ~1s for 175 files). Returns the
summary; a second concurrent rebuild returns 409.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/codetree/rebuild"
# { "status": "ok", "files_indexed": 175, "symbols_indexed": 2081,
#   "imports_indexed": 944, "duration_ms": 637, "indexed_at": "...", "files_skipped": [] }
```

## Pitfalls

- Paths are repo-relative POSIX (`src/db.ts`, `scripts/tool.ts`); `scripts/` files carry the
  `scripts/` prefix so you can filter them out.
- `symbol` match is case-sensitive and exact -- no fuzzy/substring search.
- Phase 1 has no call graph ("who calls foo"), no type info, no incremental rebuild. A file
  added since the last rebuild is invisible until the next 03:00 cron or a manual rebuild.
- Importer matching falls back to basename, so two different files sharing a basename can
  appear for the same query -- disambiguate by `from_file`.

## Verification

- `GET /api/codetree/symbol?name=saveAgentMemory` returns a result in `src/db.ts`.
- `GET /api/codetree/meta` returns `stale: false` right after a rebuild.
