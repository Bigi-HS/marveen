import { join } from 'node:path'

// Side-effect-free home for the server boot-timestamp path so both the web
// server (writer) and delivery-ack-cli (reader) share one source of truth
// without web.ts importing the CLI module (whose top-level main() would run).
// Uses the runtime root (MARVEEN_ROOT override for tests, cwd otherwise) to
// match delivery-ack-cli's existing path resolution.
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()

export const SERVER_BOOT_AT_PATH = join(PROJECT_ROOT, 'store', '.fleet-supervisor', 'server-boot-at.txt')
