// Boot-time side effect: load <project-root>/.env into process.env BEFORE any
// module that reads an env var at import time (config.ts, db.ts, noa-memory.ts).
//
// This MUST be the FIRST import in src/index.ts. ESM evaluates imported modules
// fully, in source order, so making this the first import guarantees .env is
// loaded before db.ts's getDb() / noa-memory.ts's NOA_DB_PATH read. (A plain
// `import { loadEnvFile } ...; loadEnvFile()` in index.ts would NOT work: ESM
// hoists all imports above statements, so the call would run after db.ts had
// already been evaluated.)
//
// The root is derived from this module's URL (one level above src/ in dev, or
// dist/ when built), NOT process.cwd() -- the supervisor execs without a stable
// CWD, and a cwd-relative path would reintroduce the same class of bug.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnvFile } from './load-env.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvFile(join(root, '.env'))
