import Database from 'better-sqlite3'
import { join } from 'path'
import { STORE_DIR, PROJECT_ROOT } from './config.js'
import { resolveNoaDbPath } from './db-path.js'

export { resolveNoaDbPath }

const NOA_DB_PATH = resolveNoaDbPath(process.env.NOA_DB_PATH, PROJECT_ROOT, join(STORE_DIR, 'noa.db'))

let _db: Database.Database | null = null

function openNoaDb(path: string): Database.Database {
  const db = new Database(path)
  const jm = (db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>)[0]?.journal_mode
  if (path !== ':memory:' && jm !== 'wal') {
    throw new Error(`journal_mode expected 'wal', got '${jm}'`)
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  return db
}

export function initNoaDb(path: string): void {
  if (_db) _db.close()
  _db = openNoaDb(path)
}

export function getNoaDb(): Database.Database {
  if (!_db) _db = openNoaDb(NOA_DB_PATH)
  return _db
}
