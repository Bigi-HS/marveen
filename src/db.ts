import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, openSync, closeSync } from 'node:fs'
import { STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

// Lock the DB file and its sidecars (WAL, SHM, rollback journal) down to
// owner-only. better-sqlite3 opens the main file with the process umask
// (typically 0o644), which leaves a TOCTOU window where any other local
// process -- malicious npm postinstall, rogue shell script, unrelated
// tool running under the operator's UID -- can open() it for read BEFORE
// we narrow the mode. The narrowed chmod would not revoke an already-
// opened fd. Defense in depth:
//   (1) Pre-create the main DB file via openSync('wx', 0o600) so better-
//       sqlite3 inherits the tight mode on fresh installs and the race
//       window is closed entirely.
//   (2) After Database() + PRAGMA wal, chmod the sidecars (WAL/SHM/
//       journal) -- they were created during the pragma call at umask.
//       This path also fixes older installs whose files sit at 0o644.
// Exported for tests: lets db.test.ts verify the 0o644 -> 0o600 narrowing on a
// throwaway temp file without touching the live vault (store/claudeclaw.db).
export function tightenDbPermissions(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const path of sidecars) {
    if (!existsSync(path)) continue
    try { chmodSync(path, 0o600) } catch (err) {
      logger.warn({ err, path }, 'Failed to tighten DB file permissions')
    }
  }
}

// Migration: widen the kanban_cards status CHECK to include 'someday' (the
// "Valamikor" / far-future column). Older installs created the table with the
// narrower CHECK(status IN ('planned','in_progress','waiting','done')) and
// CREATE TABLE IF NOT EXISTS is a no-op on the next boot, so inserting or moving
// a card to 'someday' hits a CHECK-constraint failure. SQLite can't ALTER a
// CHECK in place, so rebuild the table whenever its schema lacks 'someday'.
//
// kanban_cards has a self-referential FK (parent_id REFERENCES kanban_cards(id)),
// and better-sqlite3 enables foreign_keys by DEFAULT. A CREATE/INSERT/DROP/RENAME
// rebuild under FK enforcement throws "FOREIGN KEY constraint failed" on the swap,
// which is exactly why this migration silently failed in production and the
// 'someday' column never accepted a card. Per SQLite's official 12-step table-
// rebuild procedure, foreign_keys MUST be toggled OUTSIDE the transaction (the
// pragma is a no-op inside one), and integrity re-verified with foreign_key_check
// before COMMIT. We restore the prior FK state in finally. Idempotent on fresh
// (already-widened) DBs via the hasSomeday guard, and rowid is carried explicitly
// so each card's display number (seq = rowid) survives rebuilds with rowid gaps.
export function migrateKanbanCardsSomeday(db: Database.Database): void {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE name='kanban_cards'").get() as { sql: string } | undefined
  const hasSomeday = !!current?.sql?.match(/CHECK\s*\(\s*status\s+IN\s*\([^)]*'someday'[^)]*\)\s*\)/i)
  if (!current?.sql || hasSomeday) return

  const prevForeignKeys = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    const rebuild = db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS kanban_cards_new')
      db.exec(`
        CREATE TABLE kanban_cards_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done','someday')),
          assignee TEXT,
          priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          project TEXT,
          parent_id TEXT REFERENCES kanban_cards(id),
          due_date INTEGER,
          sort_order REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          dispatched_at INTEGER
        );
        INSERT INTO kanban_cards_new (rowid, id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at, archived_at, dispatched_at)
          SELECT rowid, id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at, archived_at, dispatched_at FROM kanban_cards;
        DROP TABLE kanban_cards;
        ALTER TABLE kanban_cards_new RENAME TO kanban_cards;
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at)')
      // Re-verify referential integrity BEFORE commit. With enforcement off
      // during the swap an orphaned parent_id would otherwise slip through;
      // a non-empty result aborts the transaction and rolls the rebuild back.
      const violations = db.pragma('foreign_key_check') as unknown[]
      if (violations.length > 0) {
        throw new Error('foreign_key_check failed during kanban_cards someday rebuild: ' + JSON.stringify(violations))
      }
    })
    rebuild()
  } finally {
    db.pragma(`foreign_keys = ${prevForeignKeys ? 'ON' : 'OFF'}`)
  }
}

// dbPathOverride is for tests: pass ':memory:' (or a temp path) to open an
// isolated database instead of the real store/claudeclaw.db. The file-precreate
// (openSync 'wx') and tightenDbPermissions steps are SKIPPED for an override --
// they only make sense for a real on-disk store file, and ':memory:' has no path
// to chmod. This keeps tests idempotent and stops them polluting the prod DB.
export function initDatabase(dbPathOverride?: string): void {
  const useOverride = dbPathOverride !== undefined
  if (!useOverride) mkdirSync(STORE_DIR, { recursive: true })
  // Idempotent re-init: close a previous handle before opening a new one
  // so repeated calls (tests, hot-reload, recovery paths) do not leak
  // the old better-sqlite3 fd.
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  const dbPath = useOverride ? dbPathOverride! : join(STORE_DIR, DB_FILENAME)
  // Step 1: close the TOCTOU window on fresh installs. openSync with 'wx'
  // + 0o600 creates the file ONLY if it doesn't exist and sets the strict
  // mode atomically. better-sqlite3 then opens the existing file rather
  // than creating one at the default umask. Skipped for a test override.
  if (!useOverride && !existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, 'wx', 0o600))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EEXIST: a concurrent startup won the race and created it. The
      // tightenDbPermissions call below will correct its mode.
      if (code !== 'EEXIST') {
        logger.warn({ err, dbPath }, 'Pre-create of DB file failed, continuing; mode will be tightened post-open')
      }
    }
  }
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // ~16 agents + dashboard + watchdogs write concurrently; auto-retry on lock
  // instead of throwing "database is locked", and relax fsync (safe under WAL).
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  if (!useOverride) tightenDbPermissions(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Migráció: message_count oszlop hozzáadása meglévő DB-hez
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0')
  } catch {
    // már létezik, rendben
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    )
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)`)

  // --- Kanban ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done','someday')),
      assignee TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      project TEXT,
      due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `)
  // Migration: add project column to kanban_cards for installs created
  // before #89 (whose CREATE TABLE IF NOT EXISTS ran without `project`
  // and is a no-op on the next boot). Without this, createKanbanCard
  // and updateKanbanCard fail with `table kanban_cards has no column
  // named project` and no card can be saved.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN project TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN parent_id TEXT REFERENCES kanban_cards(id)')
  } catch {
    // column already exists
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id)')
  // Migration: add dispatched_at to kanban_cards (kanban -> agent dispatch
  // once-only guard). Older installs created the table without it.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN dispatched_at INTEGER')
  } catch {
    // column already exists
  }
  // Widen the kanban_cards status CHECK to admit 'someday'. Extracted to a
  // dedicated, unit-tested function (migrateKanbanCardsSomeday) because the
  // in-place version silently failed under better-sqlite3's default FK
  // enforcement. Kept defensive: a migration failure logs but never bricks boot.
  try {
    migrateKanbanCardsSomeday(db)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(msg)) {
      console.error('[db] kanban_cards someday migration failed:', msg)
    }
  }
  // Migration: add agent_id, category, auto_generated columns to memories
  try {
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'marveen'")
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('user_pref','project','feedback','learning','shared','general'))")
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE memories ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0')
  } catch {
    // column already exists
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)

  // --- Conversation-continuity ledger (deterministic; P0 2026-06-02) ---
  // A durable ROLLING TRANSCRIPT of every channel turn -- inbound user messages
  // AND outbound replies -- per agent_id + chat_id. On a respawn (a fresh
  // --channels session with no memory of the live conversation) the SessionStart
  // replay hook injects the last ~20 turns of context PLUS highlights the open
  // question (the most recent inbound with no later outbound), so the fresh
  // session continues exactly where the connection dropped -- ZERO agent
  // discretion. Generic across all three channel agents (marveen/dia/erno-ba);
  // agent_id is derived from the session cwd so each session only sees its own
  // chat. Written by the settings.json hooks (UserPromptSubmit capture +
  // PostToolUse outbound). UNIQUE(...) makes inbound capture idempotent; outbound
  // rows carry message_id=NULL so they are never deduped against each other.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      message_id TEXT,
      text TEXT,
      ts TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(agent_id, chat_id, direction, message_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)`)

  // Migration: hot/warm/cold/shared tier system with an enforced CHECK.
  // Rebuilds the table whenever its current schema doesn't include the
  // canonical CHECK -- covers both the legacy ('user_pref'...) and the
  // post-refactor-no-check states, and is idempotent on fresh DBs.
  try {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get() as { sql: string } | undefined
    const hasCanonicalCheck = !!current?.sql?.match(/CHECK\s*\(\s*category\s+IN\s*\(\s*'hot'\s*,\s*'warm'\s*,\s*'cold'\s*,\s*'shared'\s*\)\s*\)/i)
    if (current?.sql && !hasCanonicalCheck) {
      // Preserve keywords if the column exists; older DBs rebuilt this table
      // before the keywords ADD COLUMN ran, so NULL out in that case.
      const cols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]
      const keywordsExpr = cols.some(c => c.name === 'keywords') ? 'keywords' : 'NULL'
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          topic_key TEXT,
          content TEXT NOT NULL,
          sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
          salience REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'marveen',
          category TEXT NOT NULL DEFAULT 'warm' CHECK(category IN ('hot','warm','cold','shared')),
          auto_generated INTEGER NOT NULL DEFAULT 0,
          keywords TEXT
        );
        INSERT INTO memories_new SELECT id, chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id,
          CASE category
            WHEN 'hot' THEN 'hot'
            WHEN 'warm' THEN 'warm'
            WHEN 'cold' THEN 'cold'
            WHEN 'shared' THEN 'shared'
            WHEN 'user_pref' THEN 'warm'
            WHEN 'project' THEN 'warm'
            WHEN 'general' THEN 'warm'
            WHEN 'feedback' THEN 'cold'
            WHEN 'learning' THEN 'cold'
            ELSE 'warm'
          END,
          auto_generated,
          ${keywordsExpr}
        FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `)
      // Recreate FTS and triggers for new schema (now includes keywords)
      db.exec(`DROP TABLE IF EXISTS memories_fts`)
      db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords, content='memories', content_rowid='id')`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ai`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ad`)
      db.exec(`DROP TRIGGER IF EXISTS memories_au`)
      db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); END`)
      db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)
    }
  } catch (err) {
    // Previously this silently swallowed every error which masked the
    // CHECK-constraint drop that Bug #2 described. Log loudly instead so
    // a broken migration is obvious in the dashboard log.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(msg)) {
      console.error('[db] memories migration failed:', msg)
    }
  }

  // If the table already has the new schema but no keywords column (edge case)
  try {
    db.exec('ALTER TABLE memories ADD COLUMN keywords TEXT')
  } catch {
    // column already exists
  }

  // Migration: embedding column for vector search
  try {
    db.exec('ALTER TABLE memories ADD COLUMN embedding TEXT')
  } catch {
    // column already exists
  }

  // Daily logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(agent_id, date)`)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id)`)

  // --- Agent Messages ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
      result TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER,
      ack_expected INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      in_reply_to INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_agent)`)
  // Migration: add ack_expected to agent_messages (delivery ACK protocol, card
  // 1a99b7e2). Older installs created the table without it. Opt-in per message;
  // default 0 so nothing is tracked until a sender sets it (no cry-wolf).
  try {
    db.exec('ALTER TABLE agent_messages ADD COLUMN ack_expected INTEGER NOT NULL DEFAULT 0')
  } catch {
    // column already exists
  }
  // Migration: add priority to agent_messages (priority-based abandonment, card
  // 28d2179f). Default 'normal' keeps the legacy 60-min escalation for every
  // pre-existing row; only 'urgent'/'high' messages escalate sooner. The CHECK
  // references only its own column, so SQLite permits it in ADD COLUMN.
  try {
    db.exec("ALTER TABLE agent_messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'))")
  } catch {
    // column already exists
  }
  // Migration: add in_reply_to to agent_messages (ACK auto-correlation enabler,
  // card d4fe794f). Nullable, no default -> a plain message stays unthreaded
  // (NULL); only a reply carries the parent message id. Additive + fail-open so
  // pre-existing rows and senders that never set it keep working. The router /
  // ACK protocol (card 1a99b7e2) consumes it to auto-correlate a reply without
  // an explicit mark-done.
  try {
    db.exec('ALTER TABLE agent_messages ADD COLUMN in_reply_to INTEGER')
  } catch {
    // column already exists
  }

  // --- Pending Channel Requests (Slack channel opt-in workflow) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_channel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_agent_channel ON pending_channel_requests(agent, channel_id) WHERE status = 'pending'`)
  try { db.exec('ALTER TABLE pending_channel_requests ADD COLUMN resolved_at INTEGER') } catch { /* already exists */ }

  // --- Task Run History ---
  // Log every scheduled-task firing so the dashboard overview's "tasksToday"
  // survives dashboard restarts. Replaces the old store/task-run-history.json
  // which had a plain read-modify-write race under concurrent/restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(ts)`)

  // --- Pending Scheduled Task Retries ---
  // Busy-skipped scheduled tasks used to live in an in-memory Map. On a
  // dashboard restart (or crash), the queue was lost -- even though the
  // operator had asked for the task to run, it silently disappeared.
  // This table persists each busy-retry across restarts so nothing is
  // dropped. When a row crosses the alert threshold, the alerting layer
  // stamps alert_sent_at before each Telegram send and clears it on
  // delivery failure, yielding at-least-once delivery with no double-
  // alerting on concurrent ticks. The scheduler itself never abandons:
  // it keeps retrying until the session frees up or the operator
  // cancels from the UI.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_task_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      first_attempt INTEGER NOT NULL,
      last_attempt INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_reason TEXT,
      alert_sent_at INTEGER,
      UNIQUE(task_name, agent_name)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_retries_first_attempt ON pending_task_retries(first_attempt)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
      tmux_session TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent ON background_tasks(agent_id, status)`)

  // --- Token Usage Monitoring ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      content_preview TEXT,
      tool_name TEXT,
      task_title TEXT,
      project TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(timestamp)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts ON token_usage(agent, timestamp)`)
  // Deduplicate existing rows before creating unique index
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  } catch {
    db.exec(`
      DELETE FROM token_usage WHERE id NOT IN (
        SELECT MIN(id) FROM token_usage
        GROUP BY agent, session_id, timestamp, input_tokens, output_tokens
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_cursors (
      file_path TEXT PRIMARY KEY,
      last_line INTEGER NOT NULL DEFAULT 0,
      last_size INTEGER NOT NULL DEFAULT 0
    )
  `)

  // --- Idea Box ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_box (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Egyéb',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
      source TEXT NOT NULL DEFAULT 'marveen',
      kanban_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_status ON idea_box(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_category ON idea_box(category)`)

  // --- Tool Call Log (auto-recorder) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_summary TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_call_log(session_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_ts ON tool_call_log(created_at)`)

  // --- To-Do widget (todo_items) ---
  // A focused daily-execution surface, separate from the kanban backlog. Two
  // owner-scoped lists (Claudia general/learning, Hibiki fitness). ALL CHECK
  // enums are set in this initial CREATE — widening a CHECK after the table
  // exists silently fails under better-sqlite3's default FK enforcement, so
  // kind='progress' (learning items) is included from the start (DM-AC1/AC3).
  // The owner enum carries 'bond' from the start for fresh installs; existing
  // DBs are widened by migrateTodoOwnerBond below (card 2f7cd951).
  // Timestamps are epoch-SECONDS, always server-stamped (DM-AC2).
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_items (
      id            TEXT PRIMARY KEY,
      owner         TEXT NOT NULL CHECK(owner IN ('claudia','hibiki','bond')),
      section       TEXT CHECK(section IN ('general','learning','fitness')),
      kind          TEXT CHECK(kind IN ('task','habit','metric','progress')),
      title         TEXT NOT NULL,
      detail        TEXT,
      done          INTEGER NOT NULL DEFAULT 0,
      status        TEXT,
      target_val    REAL,
      actual_val    REAL,
      sort_order    REAL,
      last_progress_at INTEGER,
      progress_note TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      done_at       INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_owner ON todo_items(owner, created_at)`)

  // Widen the owner CHECK on existing DBs to admit 'bond' (card 2f7cd951). The
  // CREATE above no-ops on an already-existing table, so a live DB keeps the
  // narrow CHECK and owner='bond' writes would 400 forever; a table rebuild is
  // required. Dedicated, unit-tested function for the same reason as the kanban
  // someday migration. Defensive: a failure logs but never bricks boot.
  try {
    migrateTodoOwnerBond(db)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[db] todo_items bond-owner migration failed:', msg)
  }

  // One-shot migration from the old JSON file (which had a read-modify-write
  // race). Import rows if they exist, then rename the file so we don't keep
  // re-importing. Wrapped in a transaction so a crash mid-import is safe.
  migrateTaskRunsFromJson()
}

// Widen todo_items.owner CHECK to include 'bond' via a table rebuild (card
// 2f7cd951). Modelled on migrateKanbanCardsSomeday: idempotent (skips if the
// CHECK already admits bond, or the table doesn't exist yet), atomic, with
// foreign_keys toggled OFF *outside* the transaction (the pragma is a no-op
// inside one). todo_items has no FK today, but we follow the canonical SQLite
// recipe and assert row-count parity before COMMIT so a partial copy aborts.
export function migrateTodoOwnerBond(db: Database.Database): void {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE name='todo_items'").get() as { sql: string } | undefined
  if (!current?.sql) return // fresh install — CREATE already carries 'bond'
  const hasBond = !!current.sql.match(/CHECK\s*\(\s*owner\s+IN\s*\([^)]*'bond'[^)]*\)\s*\)/i)
  if (hasBond) return

  const prevForeignKeys = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    const rebuild = db.transaction(() => {
      const before = (db.prepare('SELECT COUNT(*) AS c FROM todo_items').get() as { c: number }).c
      db.exec('DROP TABLE IF EXISTS todo_items_new')
      db.exec(`
        CREATE TABLE todo_items_new (
          id            TEXT PRIMARY KEY,
          owner         TEXT NOT NULL CHECK(owner IN ('claudia','hibiki','bond')),
          section       TEXT CHECK(section IN ('general','learning','fitness')),
          kind          TEXT CHECK(kind IN ('task','habit','metric','progress')),
          title         TEXT NOT NULL,
          detail        TEXT,
          done          INTEGER NOT NULL DEFAULT 0,
          status        TEXT,
          target_val    REAL,
          actual_val    REAL,
          sort_order    REAL,
          last_progress_at INTEGER,
          progress_note TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          done_at       INTEGER
        );
        INSERT INTO todo_items_new (rowid, id, owner, section, kind, title, detail, done, status,
          target_val, actual_val, sort_order, last_progress_at, progress_note, created_at, updated_at, done_at)
          SELECT rowid, id, owner, section, kind, title, detail, done, status,
          target_val, actual_val, sort_order, last_progress_at, progress_note, created_at, updated_at, done_at FROM todo_items;
        DROP TABLE todo_items;
        ALTER TABLE todo_items_new RENAME TO todo_items;
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_todo_owner ON todo_items(owner, created_at)')
      const after = (db.prepare('SELECT COUNT(*) AS c FROM todo_items').get() as { c: number }).c
      if (after !== before) {
        throw new Error(`todo_items bond rebuild row-count mismatch: ${before} -> ${after}`)
      }
    })
    rebuild()
  } finally {
    db.pragma(`foreign_keys = ${prevForeignKeys ? 'ON' : 'OFF'}`)
  }
}

function migrateTaskRunsFromJson(): void {
  const legacyPath = join(STORE_DIR, 'task-run-history.json')
  if (!existsSync(legacyPath)) return
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM task_runs').get() as { c: number }).c
  if (existingCount > 0) {
    // Already migrated in a previous run. Rename the file out of the way if
    // still present so the migration doesn't keep re-running with zero effect.
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
    return
  }
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const insert = db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)')
    const tx = db.transaction((rows: unknown[]) => {
      for (const e of rows) {
        if (!e || typeof e !== 'object') continue
        const { name, agent, ts } = e as { name?: unknown; agent?: unknown; ts?: unknown }
        if (typeof name !== 'string' || typeof agent !== 'string' || typeof ts !== 'number') continue
        insert.run(name, agent, ts)
      }
    })
    tx(arr)
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
  } catch { /* corrupt file, skip */ }
}

export function getDb(): Database.Database {
  return db
}

// --- Munkamenetek ---

export function getSession(chatId: string): { sessionId: string; messageCount: number } | undefined {
  const row = db
    .prepare('SELECT session_id, message_count FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; message_count: number } | undefined
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export function setSession(chatId: string, sessionId: string, messageCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

export function incrementSessionCount(chatId: string): number {
  db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ?').run(chatId)
  const row = db.prepare('SELECT message_count FROM sessions WHERE chat_id = ?').get(chatId) as { message_count: number } | undefined
  return row?.message_count ?? 0
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Memória ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  agent_id: string
  category: string  // 'hot' | 'warm' | 'cold' | 'shared'
  auto_generated: number
  keywords: string | null
  embedding: string | null
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
}

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

export function searchMemories(query: string, chatId: string, limit = 3): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE f.content MATCH ? AND m.chat_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(terms, chatId, limit) as Memory[]
  } catch {
    return []
  }
}

export function recentMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

export function decayMemories(): void {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 86400
  // Gentler decay: 0.5% per day, only for memories older than 1 week
  // Never delete -- salience just goes lower but memories persist
  db.prepare('UPDATE memories SET salience = MAX(salience * 0.995, 0.01) WHERE created_at < ?').run(oneWeekAgo)
}

export function getMemoriesForChat(chatId: string, limit = 10): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,  // hot, warm, cold, shared
  keywords?: string,
  autoGenerated: boolean = false
): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?)'
  ).run(ALLOWED_CHAT_ID, null, content, 'semantic', now, now, agentId, category, autoGenerated ? 1 : 0, keywords ?? null)
  const id = Number(info.lastInsertRowid)

  // Fire-and-forget: generate embedding asynchronously
  generateEmbedding(content + (keywords ? ' ' + keywords : '')).then(emb => {
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
    }
  }).catch(() => {})

  return { id }
}

export function getAgentMemories(agentId: string, limit: number = 20): Memory[] {
  return db.prepare(
    "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY accessed_at DESC LIMIT ?"
  ).all(agentId, limit) as Memory[]
}

export function searchAgentMemories(agentId: string, query: string, limit: number = 10): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    return db.prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')
       ORDER BY rank LIMIT ?`
    ).all(terms, agentId, limit) as Memory[]
  } catch {
    return db.prepare(
      "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?"
    ).all(agentId, `%${query}%`, `%${query}%`, limit) as Memory[]
  }
}

export function getMemoryStats(): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as {c:number}).c
  const withEmbedding = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL').get() as {c:number}).c
  const agentRows = db.prepare('SELECT agent_id, COUNT(*) as c FROM memories GROUP BY agent_id').all() as {agent_id:string, c:number}[]
  const tierRows = db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as {category:string, c:number}[]
  const byAgent: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const r of agentRows) byAgent[r.agent_id] = r.c
  for (const r of tierRows) byTier[r.category] = r.c
  return { total, byAgent, byTier, withEmbedding }
}

export function updateMemory(id: number, content: string, category?: string, agentId?: string, keywords?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['content = ?', 'accessed_at = ?']
  const params: unknown[] = [content, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  return db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

// --- Daily logs ---

export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().split('T')[0]
  db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)').run(agentId, today, content, now)
}

export function getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[] {
  return db.prepare('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC').all(agentId, date) as { id: number; content: string; created_at: number }[]
}

export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (db.prepare('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?').all(agentId, limit) as { date: string }[]).map(r => r.date)
}

// --- Session Recall ---

export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: Memory[]
  dateRange: { from: string; to: string }
}

function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Budapest',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function recallByDateRange(from: string, to: string, agentId?: string): RecallResult {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  const memSql = agentId
    ? "SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared') ORDER BY created_at ASC"
    : 'SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
  const memParams = agentId ? [fromTs, toTs, agentId] : [fromTs, toTs]
  const memories = db.prepare(memSql).all(...memParams) as Memory[]

  return { logs, memories, dateRange: { from, to } }
}

export function recallSearch(query: string, agentId?: string, limit = 50): RecallResult {
  const terms = buildFtsMatchExpression(query)
  let memories: Memory[] = []
  const escaped = escapeLike(query)
  if (terms) {
    try {
      const sql = agentId
        ? `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') ORDER BY m.created_at DESC LIMIT ?`
        : `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`
      memories = agentId
        ? db.prepare(sql).all(terms, agentId, limit) as Memory[]
        : db.prepare(sql).all(terms, limit) as Memory[]
    } catch {
      const sql = agentId
        ? "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, limit) as Memory[]
        : db.prepare(sql).all(pat, pat, limit) as Memory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}

// --- Background tasks ---

export interface BackgroundTask {
  id: string
  agent_id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'timeout'
  tmux_session: string | null
  started_at: number
  finished_at: number | null
  output: string | null
}

export function createBackgroundTaskAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): BackgroundTask | null {
  const now = Math.floor(Date.now() / 1000)
  const result = db.transaction(() => {
    const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
    if (running >= maxConcurrent) return null
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, agentId, prompt, 'running', tmuxSession, now)
    return { id, agent_id: agentId, prompt, status: 'running' as const, tmux_session: tmuxSession, started_at: now, finished_at: null, output: null }
  })()
  return result
}

export function getRunningBackgroundTasks(): BackgroundTask[] {
  return db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all() as BackgroundTask[]
}

export function finishBackgroundTask(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
    .run(status, now, output, id)
}

export function getBackgroundTasks(agentId?: string, includeFinished = false): BackgroundTask[] {
  if (agentId) {
    const sql = includeFinished
      ? 'SELECT * FROM background_tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50'
      : "SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC"
    return db.prepare(sql).all(agentId) as BackgroundTask[]
  }
  const sql = includeFinished
    ? 'SELECT * FROM background_tasks ORDER BY started_at DESC LIMIT 50'
    : "SELECT * FROM background_tasks WHERE status = 'running' ORDER BY started_at DESC"
  return db.prepare(sql).all() as BackgroundTask[]
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTask | undefined
}

export function countRunningBackgroundTasks(agentId: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
}

export function markOrphanedTasksFailed(): number {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
    .run(now)
  return info.changes
}

// --- Ütemezett feladatok ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  db.prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?")
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
  ).run(now, nextRun, result, id)
}

export function listTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
  )
}

export function resumeTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
  )
}

export function getTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function updateTask(id: string, prompt: string, schedule: string, nextRun: number): boolean {
  return db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?').run(prompt, schedule, nextRun, id).changes > 0
}

// --- Kanban ---

export interface KanbanCard {
  id: string
  // Stable running number derived from the SQLite rowid (insertion order, never
  // reused) -- a human-friendly "#N" shown next to the 8-char hex id.
  seq?: number
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'waiting' | 'done' | 'someday'
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  project: string | null
  parent_id: string | null
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

// Start of the current calendar day in the server's local TZ (Europe/Budapest).
// Done cards last touched before this are auto-archived, so the board's "Kész"
// column only shows what was completed today.
function startOfTodayEpoch(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

// ===== To-Do widget time helpers =====

// Server-side epoch-seconds stamp. The SINGLE source for every todo_items
// timestamp so INSERT/UPDATE call-sites can never disagree on units (PR #126
// lesson: a mixed ms/s column silently breaks the day-boundary comparison).
export function nowEpochS(): number {
  return Math.floor(Date.now() / 1000)
}

// The To-Do widget's daily-reset boundary: 03:00 wall-clock Europe/Budapest.
// 03:00 is deliberately OUTSIDE the DST-ambiguous 02:00-03:00 window, so the
// boundary instant is unambiguous on both transition nights.
const TODO_TZ = 'Europe/Budapest'
const TODO_DAY_OFFSET_HOURS = 3 // 03:00

// UTC offset (seconds, positive east of UTC) that `tz` has at a given instant,
// derived via Intl — never a hardcoded constant, so it tracks CET<->CEST.
function tzOffsetSeconds(tz: string, instant: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(instant)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value)
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asIfUtc - instant.getTime()) / 1000)
}

// Epoch-seconds of "03:00 wall-clock Budapest" on the given calendar date. The
// naive 03:00 instant is never in the DST gap, so the offset lookup is unambiguous.
function budapestBoundaryEpoch(year: number, month: number, day: number): number {
  const naiveUtcMs = Date.UTC(year, month - 1, day, TODO_DAY_OFFSET_HOURS, 0, 0)
  const offset = tzOffsetSeconds(TODO_TZ, new Date(naiveUtcMs))
  return Math.floor(naiveUtcMs / 1000) - offset
}

// dayBucket(epoch): epoch-seconds of the start of the "day" (the 03:00 Budapest
// boundary at or before the timestamp) containing the given instant. This is the
// ONLY definition of the today/carried boundary (DB-AC1). DST-aware (DB-AC3): the
// UTC instant of "03:00 Budapest" shifts by one hour across CET<->CEST, computed
// from Intl, NOT a fixed UTC offset. Idempotent: dayBucket(dayBucket(x))==dayBucket(x).
export function dayBucket(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000)
  // Budapest calendar date of the instant (date only, no hour ambiguity).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TODO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const [year, month, day] = fmt.format(d).split('-').map(Number)
  let boundary = budapestBoundaryEpoch(year, month, day)
  if (epochSeconds < boundary) {
    // Before today's 03:00 -> belongs to the previous calendar day's bucket.
    // Step the date back in pure UTC date arithmetic (no tz, so a "day" is never
    // stretched/shrunk by DST here).
    const prev = new Date(Date.UTC(year, month - 1, day))
    prev.setUTCDate(prev.getUTCDate() - 1)
    boundary = budapestBoundaryEpoch(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate())
  }
  return boundary
}

export function listKanbanCards(): KanbanCard[] {
  // Auto-archive done cards not touched since before today (local calendar day),
  // so the "Kész" column shows only today's completions; older done cards move
  // to the archive view (listArchivedKanbanCards).
  db.prepare(
    "UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?"
  ).run(Math.floor(Date.now() / 1000), startOfTodayEpoch())
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL ORDER BY sort_order ASC')
    .all() as KanbanCard[]
}

// Archived cards (auto-archived day-old completions + manually archived), newest
// archive first. Backs the kanban "Archívum" view.
export function listArchivedKanbanCards(): KanbanCard[] {
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all() as KanbanCard[]
}

export function listKanbanCardsSummary(): { status: string; title: string; assignee: string | null; priority: string; id: string }[] {
  return db
    .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
    .all() as any[]
}

export function getKanbanCard(id: string): KanbanCard | undefined {
  return db.prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

export function createKanbanCard(card: {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number
}): void {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'
  const maxRow = db.prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id, card.title, card.description ?? null, status,
    card.assignee ?? null, card.priority ?? 'normal',
    card.project ?? null, card.parent_id ?? null, card.due_date ?? null, sortOrder, now, now
  )
}

export function updateKanbanCard(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>): boolean {
  const card = getKanbanCard(id)
  if (!card) return false
  const now = Math.floor(Date.now() / 1000)
  const f = { ...card, ...fields, updated_at: now }
  return db.prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, due_date=?, sort_order=?, updated_at=?, archived_at=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.due_date, f.sort_order, f.updated_at, f.archived_at, id).changes > 0
}

export function getChildCards(parentId: string): KanbanCard[] {
  return db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all(parentId) as KanbanCard[]
}

export function moveKanbanCard(id: string, status: KanbanCard['status'], sortOrder: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
  ).run(status, sortOrder, now, id).changes > 0
}

// Stamp the once-only kanban -> agent dispatch guard. Returns false if the
// card id does not exist.
export function markKanbanCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, id).changes > 0
}

export function archiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id).changes > 0
}

export function listKanbanProjects(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map(r => r.project)
}

export function deleteKanbanCard(id: string): boolean {
  db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(id)
  return db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id).changes > 0
}

export function getKanbanComments(cardId: string): KanbanComment[] {
  return db.prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as KanbanComment[]
}

export function addKanbanComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

// ===== To-Do widget (todo_items) =====

export type TodoOwner = 'claudia' | 'hibiki' | 'bond'
export type TodoSection = 'general' | 'learning' | 'fitness'
export type TodoKind = 'task' | 'habit' | 'metric' | 'progress'

export interface TodoItem {
  id: string
  owner: TodoOwner
  section: TodoSection | null
  kind: TodoKind | null
  title: string
  detail: string | null
  done: number
  status: string | null
  target_val: number | null
  actual_val: number | null
  sort_order: number | null
  last_progress_at: number | null
  progress_note: string | null
  created_at: number
  updated_at: number
  done_at: number | null
}

// Fields an agent POST may set when creating/editing. Timestamps (created_at,
// updated_at, done_at) and `done` are server-controlled and never read from the
// request body (DM-AC2).
export interface TodoWriteFields {
  section?: TodoSection | null
  kind?: TodoKind | null
  title?: string
  detail?: string | null
  status?: string | null
  target_val?: number | null
  actual_val?: number | null
  sort_order?: number | null
  progress_note?: string | null
}

export function createTodoItem(item: TodoWriteFields & { id: string; owner: TodoOwner }): void {
  const now = nowEpochS()
  db.prepare(
    `INSERT INTO todo_items
       (id, owner, section, kind, title, detail, done, status, target_val, actual_val,
        sort_order, last_progress_at, progress_note, created_at, updated_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`
  ).run(
    item.id, item.owner, item.section ?? null, item.kind ?? 'task', item.title ?? '',
    item.detail ?? null, item.status ?? null, item.target_val ?? null, item.actual_val ?? null,
    item.sort_order ?? null, item.progress_note ?? null, now, now,
  )
}

export function getTodoItem(id: string): TodoItem | undefined {
  return db.prepare('SELECT * FROM todo_items WHERE id = ?').get(id) as TodoItem | undefined
}

// Active rows for an owner: everything EXCEPT items completed before today's
// bucket (TC-AC3 lazy archive — yesterday's done items just stop appearing; there
// is no archive column). Ordered for stable rendering.
export function listActiveTodos(owner: TodoOwner): TodoItem[] {
  const nowBucket = dayBucket(nowEpochS())
  return db.prepare(
    `SELECT * FROM todo_items
       WHERE owner = ? AND NOT (done = 1 AND done_at IS NOT NULL AND done_at < ?)
       ORDER BY sort_order IS NULL, sort_order ASC, created_at ASC`
  ).all(owner, nowBucket) as TodoItem[]
}

// Update agent-writable fields. Server stamps updated_at; ignores timestamp/done
// fields in the patch.
export function updateTodoItem(id: string, fields: TodoWriteFields): boolean {
  const cur = getTodoItem(id)
  if (!cur) return false
  const now = nowEpochS()
  const f = {
    section: fields.section ?? cur.section,
    kind: fields.kind ?? cur.kind,
    title: fields.title ?? cur.title,
    detail: fields.detail ?? cur.detail,
    status: fields.status ?? cur.status,
    target_val: fields.target_val ?? cur.target_val,
    actual_val: fields.actual_val ?? cur.actual_val,
    sort_order: fields.sort_order ?? cur.sort_order,
    progress_note: fields.progress_note ?? cur.progress_note,
  }
  return db.prepare(
    `UPDATE todo_items SET section=?, kind=?, title=?, detail=?, status=?, target_val=?,
       actual_val=?, sort_order=?, progress_note=?, updated_at=? WHERE id=?`
  ).run(f.section, f.kind, f.title, f.detail, f.status, f.target_val, f.actual_val,
    f.sort_order, f.progress_note, now, id).changes > 0
}

export function markTodoDone(id: string): boolean {
  const now = nowEpochS()
  return db.prepare(
    'UPDATE todo_items SET done=1, done_at=?, updated_at=? WHERE id=?'
  ).run(now, now, id).changes > 0
}

export function tickTodoProgress(id: string, progressNote: string | null): boolean {
  const now = nowEpochS()
  return db.prepare(
    'UPDATE todo_items SET last_progress_at=?, progress_note=?, updated_at=? WHERE id=?'
  ).run(now, progressNote, now, id).changes > 0
}

export function deleteTodoItem(id: string): boolean {
  return db.prepare('DELETE FROM todo_items WHERE id = ?').run(id).changes > 0
}

// Freshness sentinel (FS-AC1): seconds since the owner's most recent write, or
// null when the owner has no rows.
export function todoLastWriteAgoSeconds(owner: TodoOwner): number | null {
  const row = db.prepare(
    'SELECT MAX(updated_at) AS m FROM todo_items WHERE owner = ?'
  ).get(owner) as { m: number | null }
  if (row?.m == null) return null
  return nowEpochS() - row.m
}

// The N most recent dayBucket boundaries up to and including the current one,
// newest first. Steps bucket-by-bucket (NOT now - k*86400), so the 03:00 offset
// never drifts the window (FIT-AC5).
export function recentDayBuckets(count: number, now = nowEpochS()): number[] {
  const buckets: number[] = []
  let b = dayBucket(now)
  for (let i = 0; i < count; i++) {
    buckets.push(b)
    b = dayBucket(b - 1)
  }
  return buckets
}

// Derived 7-bucket training-adherence (FIT-AC5): count of the last 7 buckets in
// which Hibiki has at least one kind='habit' training item with status='done'.
// No stored streak column — computed from daily rows each read.
export function trainingAdherence(owner: TodoOwner, bucketCount = 7, now = nowEpochS()): { active: number; total: number } {
  const buckets = recentDayBuckets(bucketCount, now) // newest -> oldest
  const oldest = buckets[buckets.length - 1]
  const rows = db.prepare(
    `SELECT created_at FROM todo_items
       WHERE owner = ? AND kind = 'habit' AND status = 'done' AND created_at >= ?`
  ).all(owner, oldest) as Array<{ created_at: number }>
  const activeBuckets = new Set<number>()
  for (const r of rows) activeBuckets.add(dayBucket(r.created_at))
  let active = 0
  for (const b of buckets) if (activeBuckets.has(b)) active++
  return { active, total: bucketCount }
}

// --- Heartbeat helpers ---

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const urgent = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'")
    .all() as KanbanCard[]
  const in_progress = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'")
    .all() as KanbanCard[]
  const waiting = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'")
    .all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}

// --- Agent Messages ---

export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  result: string | null
  created_at: number
  delivered_at: number | null
  completed_at: number | null
  // 1 when the sender expects a receipt-ack (delegation / opt-in): the message
  // router records a pending-ack on successful inject so an undelivered/ignored
  // ACK-expected message is escalated. 0 (default) = best-effort, no tracking
  // (delivery ACK protocol, card 1a99b7e2).
  ack_expected: number
  // Escalation urgency for the delivery retry/abandonment policy (card 28d2179f).
  // Same enum as kanban_cards; 'normal' is the default and keeps the legacy 60-min
  // escalate-after. Higher urgency only shortens the ALERT timing, never the 6 h
  // hard-TTL -- see thresholdsForPriority in web/delivery-retry.ts.
  priority: 'low' | 'normal' | 'high' | 'urgent'
  // Sender-side parent: the id of the message this one replies to, or null for
  // an unthreaded message. Lets the router auto-correlate a reply to its ask
  // (ACK auto-correlation enabler, card d4fe794f). Additive + fail-open.
  in_reply_to: number | null
}

export function createAgentMessage(
  from: string,
  to: string,
  content: string,
  ackExpected = false,
  priority: AgentMessage['priority'] = 'normal',
  inReplyTo: number | null = null,
): AgentMessage {
  const now = Math.floor(Date.now() / 1000)
  const ack = ackExpected ? 1 : 0
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, ack_expected, priority, in_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(from, to, content, 'pending', now, ack, priority, inReplyTo)
  return {
    id: Number(info.lastInsertRowid),
    from_agent: from, to_agent: to, content, status: 'pending',
    result: null, created_at: now, delivered_at: null, completed_at: null,
    ack_expected: ack, priority, in_reply_to: inReplyTo,
  }
}

export function getPendingMessages(toAgent?: string): AgentMessage[] {
  if (toAgent) {
    return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ? ORDER BY created_at ASC")
      .all(toAgent) as AgentMessage[]
  }
  return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as AgentMessage[]
}

export function markMessageDelivered(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now, id).changes > 0
}

export function markMessageDone(id: number, result?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ? WHERE id = ?").run(result ?? null, now, id).changes > 0
}

export function markMessageFailed(id: number, error?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?").run(error ?? null, now, id).changes > 0
}

export function listAgentMessages(limit = 50): AgentMessage[] {
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) as AgentMessage[]
}

// System/automation participants that are not real conversation peers. They are
// excluded as THREAD rows in the dashboard sidebar (you don't chat with the
// heartbeat or the coordinator), but messages involving them still count toward
// the human/agent peer they are paired with (so a thread's count matches what
// getAgentConversation returns when you open it).
export const CHAT_SYSTEM_AGENTS = ['heartbeat', 'telegram-coordinator', 'channel-coordinator', 'system'] as const

const AGENT_MESSAGE_LIMIT_CAP = 200

// The actual last-N messages for ONE agent, filtered in SQL (NOT global-last-N
// then JS-filter -- that starved rarely-active agents' threads, dashboard bug
// 2026-06-03). `beforeId` pages older: pass the oldest id you already have to
// fetch the next-older batch (scroll-up pagination). Newest-first.
export function getAgentConversation(agent: string, limit = 50, beforeId?: number): AgentMessage[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return db.prepare(
      'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(agent, agent, beforeId, cap) as AgentMessage[]
  }
  return db.prepare(
    'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(agent, agent, cap) as AgentMessage[]
}

export interface AgentThread {
  agent: string
  count: number
  lastMessage: AgentMessage | null
}

// One row per distinct conversation peer (from_agent OR to_agent), excluding
// CHAT_SYSTEM_AGENTS, each with its total message count and its most-recent
// message. Drives the dashboard sidebar. Recency is computed per-peer (max
// created_at) so a rarely-active peer's last message is never hidden behind the
// global recency window (the bug the JS-filter path had). Sorted newest-first.
export function getAgentConversationThreads(): AgentThread[] {
  const parties = db.prepare(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages
      UNION
      SELECT to_agent AS agent FROM agent_messages
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE m.from_agent = p.agent OR m.to_agent = p.agent) AS count
    FROM parties p
  `).all() as { agent: string; count: number }[]

  const lastStmt = db.prepare(
    'SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  )

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (lastStmt.get(p.agent, p.agent) as AgentMessage | undefined) ?? null
    threads.push({ agent: p.agent, count: p.count, lastMessage })
  }
  threads.sort((a, b) => {
    const ca = a.lastMessage?.created_at ?? 0
    const cb = b.lastMessage?.created_at ?? 0
    if (cb !== ca) return cb - ca
    return (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) // tiebreak: newest id first
  })
  return threads
}

// --- Task Run History ---

export interface TaskRunEntry { name: string; agent: string; ts: number }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function appendTaskRun(name: string, agent: string): void {
  const now = Date.now()
  db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)').run(name, agent, now)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  db.prepare('DELETE FROM task_runs WHERE ts < ?').run(now - TASK_RUN_TTL_MS)
}

export function countTaskRunsBetween(fromTs: number, toTs?: number): number {
  if (toTs === undefined) {
    const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ?').get(fromTs) as { c: number }
    return row.c
  }
  const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ? AND ts < ?').get(fromTs, toTs) as { c: number }
  return row.c
}

export function getAgentMessage(id: number): AgentMessage | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined
}

export function getActiveScheduledTaskCount(): { count: number; nextRun: number | null } {
  const row = db
    .prepare("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")
    .get() as { count: number; next_run: number | null }
  return { count: row.count, nextRun: row.next_run }
}

// --- Pending scheduled-task retries ------------------------------------

export interface PendingTaskRetryRow {
  id: number
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
  alert_sent_at: number | null
}

/**
 * Insert a busy-skipped scheduled task into the retry queue if and only if
 * no row exists for the (task_name, agent_name) pair. Returns true on
 * insert, false if a row already existed. Used for the first "busy" hit
 * from the cron loop.
 */
export function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, now, now, reason).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `).run(now, reason, taskName, agentName).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): void {
  if (!updatePendingTaskRetry(taskName, agentName, now, reason)) {
    insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export function clearPendingTaskRetryAlert(taskName: string, agentName: string): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function listPendingTaskRetries(): PendingTaskRetryRow[] {
  return db
    .prepare('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
    .all() as PendingTaskRetryRow[]
}

export function getPendingTaskRetry(taskName: string, agentName: string): PendingTaskRetryRow | undefined {
  return db
    .prepare('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .get(taskName, agentName) as PendingTaskRetryRow | undefined
}

export function deletePendingTaskRetry(taskName: string, agentName: string): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function deletePendingTaskRetryById(id: number): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE id = ?')
    .run(id).changes > 0
}

export function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL')
    .run(ts, taskName, agentName).changes > 0
}

// --- Vector Search (Ollama + nomic-embed-text) ---

const EMBED_MODEL = 'nomic-embed-text'

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
    })
    const data = await resp.json() as { embedding?: number[] }
    return data.embedding || null
  } catch (err) {
    // Debug-level so it doesn't spam default INFO logs when Ollama isn't
    // running (the common case on most user machines). Enables "why does
    // hybrid search only return FTS results?" diagnostics without noise.
    logger.debug({ err, ollamaUrl: OLLAMA_URL }, 'Embedding generation failed (Ollama not running?)')
    return null
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function vectorSearch(agentId: string, queryEmbedding: number[], limit: number = 10): Memory[] {
  const rows = db.prepare(
    "SELECT * FROM memories WHERE embedding IS NOT NULL AND (agent_id = ? OR category = 'shared')"
  ).all(agentId) as Memory[]

  const scored = rows.map(m => {
    try {
      const emb = JSON.parse(m.embedding!) as number[]
      return { memory: m, score: cosineSimilarity(queryEmbedding, emb) }
    } catch {
      return { memory: m, score: 0 }
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.memory)
}

export async function hybridSearch(agentId: string, query: string, limit: number = 10): Promise<Memory[]> {
  const k = 60 // RRF constant

  // FTS5 results
  const ftsResults = searchAgentMemories(agentId, query, limit * 2)

  // Vector results
  const queryEmbedding = await generateEmbedding(query)
  const vecResults = queryEmbedding ? vectorSearch(agentId, queryEmbedding, limit * 2) : []

  // Reciprocal Rank Fusion
  const scores: Map<number, number> = new Map()
  const byId: Map<number, Memory> = new Map()

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  return ranked.slice(0, limit).map(([id]) => byId.get(id)!)
}

export interface BackfillResult {
  total: number // memories that started with a NULL embedding
  succeeded: number // newly embedded
  failed: number // attempted but got no vector back
  aborted: boolean // stopped early because the embedder looked unreachable
}

// Backfill embeddings for every memory that predates the auto-embed pipeline (or
// was created while Ollama was down) and so has a NULL embedding. New memories
// already get embedded fire-and-forget in saveAgentMemory; this catches the
// historical rows so hybrid (vector + FTS) search covers the whole vault.
//
// Sequential on purpose: one local Ollama, no value in hammering it in parallel
// (and the await already serialises, so the old fixed 100ms-per-row sleep just
// added ~11s for 113 rows -- dropped). If the embedder returns nothing 3 times
// in a row we ABORT rather than churn the whole backlog into doomed requests --
// that pattern means the daemon is down/unloaded, not that individual rows are
// bad. The `embed` dep is injectable so the control flow is unit-testable
// without a live Ollama.
export async function backfillEmbeddings(
  opts: {
    embed?: (text: string) => Promise<number[] | null>
    onProgress?: (done: number, total: number, succeeded: number) => void
  } = {},
): Promise<BackfillResult> {
  const embed = opts.embed ?? generateEmbedding
  const rows = db
    .prepare('SELECT id, content, keywords FROM memories WHERE embedding IS NULL')
    .all() as { id: number; content: string; keywords: string | null }[]
  const total = rows.length
  const update = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')

  let succeeded = 0
  let failed = 0
  let consecutiveFail = 0
  let aborted = false

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    let emb: number[] | null = null
    try {
      emb = await embed(text)
    } catch {
      emb = null
    }

    if (emb && emb.length > 0) {
      update.run(JSON.stringify(emb), row.id)
      succeeded++
      consecutiveFail = 0
    } else {
      failed++
      consecutiveFail++
      if (consecutiveFail >= 3) {
        logger.warn({ total, succeeded, failed }, 'backfillEmbeddings: 3 consecutive empty embeddings -- embedder unreachable, aborting')
        aborted = true
        break
      }
    }
    opts.onProgress?.(i + 1, total, succeeded)
  }

  return { total, succeeded, failed, aborted }
}

// --- Pending Channel Requests ---

export interface PendingChannelRequest {
  id: number
  agent: string
  channel_id: string
  channel_name: string | null
  user_id: string | null
  requested_at: number
  status: 'pending' | 'approved' | 'denied'
}

export function upsertChannelRequest(agent: string, channelId: string, userId?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  const existing = db.prepare(
    "SELECT id FROM pending_channel_requests WHERE agent = ? AND channel_id = ? AND (status = 'pending' OR (status = 'denied' AND COALESCE(resolved_at, requested_at) > ?))"
  ).get(agent, channelId, sevenDaysAgo)
  if (existing) return false
  db.prepare(
    'INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, channelId, userId ?? null, now, 'pending')
  return true
}

export function listPendingChannelRequests(agent: string): PendingChannelRequest[] {
  return db.prepare(
    "SELECT * FROM pending_channel_requests WHERE agent = ? AND status = 'pending' ORDER BY requested_at DESC"
  ).all(agent) as PendingChannelRequest[]
}

export function updateChannelRequestStatus(id: number, status: 'approved' | 'denied'): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE pending_channel_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?'
  ).run(status, now, id, 'pending').changes > 0
}

export function updateChannelRequestName(id: number, channelName: string): void {
  db.prepare('UPDATE pending_channel_requests SET channel_name = ? WHERE id = ?').run(channelName, id)
}

// --- Telegram History ---

export function saveTelegramMessage(
  chatId: string,
  messageId: string,
  direction: 'in' | 'out',
  text: string,
  userId?: string,
  ts?: number,
): void {
  const now = ts ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_history (chat_id, message_id, user_id, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(chatId, messageId, userId ?? null, direction, text, now)
}

export interface TelegramHistoryRow {
  id: number
  chat_id: string
  message_id: string
  user_id: string | null
  direction: 'in' | 'out'
  text: string
  ts: number
}

export function getTelegramHistory(chatId: string, limit: number = 50): TelegramHistoryRow[] {
  return db.prepare(
    'SELECT * FROM telegram_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(chatId, limit) as TelegramHistoryRow[]
}

// --- Idea Box ---

export interface IdeaBoxRow {
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  created_at: number
  updated_at: number
}

export function listIdeas(opts?: { status?: string; category?: string }): IdeaBoxRow[] {
  let q = 'SELECT * FROM idea_box WHERE 1=1'
  const params: string[] = []
  if (opts?.status) { q += ' AND status = ?'; params.push(opts.status) }
  if (opts?.category) { q += ' AND category = ?'; params.push(opts.category) }
  q += ' ORDER BY created_at DESC'
  return db.prepare(q).all(...params) as IdeaBoxRow[]
}

export function createIdea(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(idea.id, idea.title, idea.description ?? null, idea.category, idea.status, idea.source, idea.kanban_id ?? null, now, now)
}

export function updateIdea(id: string, patch: Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category) }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.kanban_id !== undefined) { sets.push('kanban_id = ?'); params.push(patch.kanban_id) }
  params.push(id)
  return db.prepare(`UPDATE idea_box SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteIdea(id: string): boolean {
  return db.prepare('DELETE FROM idea_box WHERE id = ?').run(id).changes > 0
}

export function listIdeaCategories(): string[] {
  return (db.prepare('SELECT DISTINCT category FROM idea_box ORDER BY category').all() as { category: string }[]).map(r => r.category)
}

// --- Tool Call Log ---

export function logToolCall(sessionId: string, toolName: string, inputSummary: string | null, success = true): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, toolName, inputSummary, success ? 1 : 0, now)
}

export interface ToolCallLogRow {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
}

export interface WorkflowCandidate {
  session_id: string
  tool_calls: ToolCallLogRow[]
  start_ts: number
  end_ts: number
  duration_minutes: number
}

export function getRecentToolCalls(sinceSecs: number): ToolCallLogRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSecs
  return db.prepare('SELECT * FROM tool_call_log WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff) as ToolCallLogRow[]
}

export function analyzeWorkflowCandidates(sinceSecs = 3600, minToolCalls = 5, gapSecs = 300): WorkflowCandidate[] {
  const calls = getRecentToolCalls(sinceSecs)
  if (calls.length === 0) return []

  // Group by session_id, then split by time gaps > gapSecs
  const bySession: Map<string, ToolCallLogRow[]> = new Map()
  for (const c of calls) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, [])
    bySession.get(c.session_id)!.push(c)
  }

  const candidates: WorkflowCandidate[] = []
  for (const [sessionId, sessionCalls] of bySession) {
    // Split into chunks by time gap
    const chunks: ToolCallLogRow[][] = []
    let current: ToolCallLogRow[] = [sessionCalls[0]]
    for (let i = 1; i < sessionCalls.length; i++) {
      if (sessionCalls[i].created_at - sessionCalls[i - 1].created_at > gapSecs) {
        chunks.push(current)
        current = []
      }
      current.push(sessionCalls[i])
    }
    chunks.push(current)

    for (const chunk of chunks) {
      if (chunk.length >= minToolCalls) {
        candidates.push({
          session_id: sessionId,
          tool_calls: chunk,
          start_ts: chunk[0].created_at,
          end_ts: chunk[chunk.length - 1].created_at,
          duration_minutes: Math.round((chunk[chunk.length - 1].created_at - chunk[0].created_at) / 60),
        })
      }
    }
  }

  return candidates
}

export function pruneToolCallLog(olderThanSecs = 86400): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs
  db.prepare('DELETE FROM tool_call_log WHERE created_at < ?').run(cutoff)
}

