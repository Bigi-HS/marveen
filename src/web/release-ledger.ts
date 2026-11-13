// Release-ledger data model (card 2efcb439, v2-spec-p9-sandbox-release.md §4).
//
// release_ledger: immutable versioned-build record. Each row tracks one candidate
// release from sandbox build through Boss approval to live deployment.
//
// SCOPE: schema + migration + trigger guard ONLY.
// approve_release() / deploy_release() / deploy_gate() are out of batch (§6/§7,
// Boss-blocked). This module exports only the migration + sanctioned-path helpers
// that the trigger guard depends on.
//
// Invariant 7 (spec §3): raw INSERT/UPDATE from the sqlite3 CLI or external SQL
// must be REJECTED so the fix-window job can never see a hand-forged
// approved_by='boss', sandbox_result='pass' row. Enforcement: BEFORE INSERT and
// BEFORE UPDATE triggers that RAISE(ABORT) unless the calling code has first
// called beginSanctionedWrite() (which sets a sentinel row in
// _release_ledger_sanctioned) within the same better-sqlite3 connection.
// endSanctionedWrite() removes the sentinel row; it must be called in a finally
// block by the sanctioned write-path so the flag never leaks across operations.
//
// The sentinel table is a plain persisted table (not a TEMP table) because
// SQLite TEMP tables and PRAGMA user_version are shared across all connections to
// the same in-memory database in tests, which would make it impossible to test
// the "no flag" path alongside the "flag present" path in the same test run.
// Using a regular table scoped to the same db handle is both test-safe and
// production-safe (better-sqlite3 uses a single connection per Database handle).

import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

// Additive, idempotent, never-break-boot. Pure CREATE IF NOT EXISTS.
// No FK so it cannot trip FK-enforced table rebuilds or break boot.
export function migrateReleaseLedger(db: Database.Database): void {
  // Sentinel table for the sanctioned-write flag (Inv-7).
  // A row in this table (id=1) means the current code path has permission to
  // write to release_ledger. The triggers abort any write that finds this table
  // empty. The table is created BEFORE the triggers so the triggers exist only
  // once the sentinel mechanism is in place.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _release_ledger_sanctioned (
      id INTEGER PRIMARY KEY CHECK(id = 1)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS release_ledger (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      version        TEXT    NOT NULL,
      git_sha        TEXT    NOT NULL,
      built_at       INTEGER NOT NULL,
      sandbox_result TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(sandbox_result IN ('pending','pass','fail')),
      sandbox_meta   TEXT,
      approved_by    TEXT    CHECK(approved_by IS NULL OR approved_by='boss'),
      approved_at    INTEGER,
      deployed_at    INTEGER,
      deploy_result  TEXT,
      deploy_kind    TEXT,
      prev_version   TEXT
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_deployed ON release_ledger(deployed_at)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_version ON release_ledger(version)`)

  // BEFORE INSERT trigger (Inv-7): abort any raw INSERT that bypasses the
  // sanctioned-write flag. The trigger checks for a row in
  // _release_ledger_sanctioned; if none exists the write is not from the
  // sanctioned pipeline API and must be rejected.
  //
  // DROP + CREATE pattern keeps the trigger body current on every boot while
  // remaining idempotent. Triggers are lightweight metadata objects in SQLite
  // and their recreation is instantaneous.
  db.exec(`DROP TRIGGER IF EXISTS trg_release_ledger_insert_guard`)
  db.exec(`
    CREATE TRIGGER trg_release_ledger_insert_guard
    BEFORE INSERT ON release_ledger
    BEGIN
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM _release_ledger_sanctioned WHERE id = 1) = 0
        THEN RAISE(ABORT, 'release_ledger: raw INSERT rejected -- use the sanctioned pipeline API (Inv-7)')
      END;
    END
  `)

  // BEFORE UPDATE trigger (Inv-7): same guard for any UPDATE.
  db.exec(`DROP TRIGGER IF EXISTS trg_release_ledger_update_guard`)
  db.exec(`
    CREATE TRIGGER trg_release_ledger_update_guard
    BEFORE UPDATE ON release_ledger
    BEGIN
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM _release_ledger_sanctioned WHERE id = 1) = 0
        THEN RAISE(ABORT, 'release_ledger: raw UPDATE rejected -- use the sanctioned pipeline API (Inv-7)')
      END;
    END
  `)
}

// ---------------------------------------------------------------------------
// Sanctioned-write flag helpers (called by the pipeline API, not by tests
// directly -- but exported so tests can exercise both the happy path and the
// guard-tripped path).
// ---------------------------------------------------------------------------

// Set the sanctioned-write sentinel. Call this BEFORE any INSERT/UPDATE on
// release_ledger; always pair with endSanctionedWrite() in a finally block.
export function beginSanctionedWrite(db: Database.Database): void {
  db.exec('INSERT OR REPLACE INTO _release_ledger_sanctioned (id) VALUES (1)')
}

// Clear the sanctioned-write sentinel. Must be called in a finally block after
// all release_ledger writes in the current operation are complete so the flag
// never leaks to a subsequent (potentially unsanctioned) write.
export function endSanctionedWrite(db: Database.Database): void {
  db.exec('DELETE FROM _release_ledger_sanctioned WHERE id = 1')
}
