-- NoA A1 -- clean owned data-layer schema for store/noa.db
-- Card: f68461a6 (umbrella), block A1. Spec: store/spec-noa-a1-db-schema.md (v4, Thor PASS).
--
-- DDL ONLY. Connection pragmas (WAL, synchronous, foreign_keys, busy_timeout,
-- wal_autocheckpoint) are applied in the connection-init code (AC-5), NOT here.
--
-- Table provenance:
--   * REDESIGNED per spec (Telegram coupling + dead columns removed): memories,
--     agent_messages, sessions, scheduled_tasks.
--   * NEW: embedding_cache.
--   * UNCHANGED + CARRIED-OVER: reproduced VERBATIM from claudeclaw.db so the
--     migration is byte-faithful and preserves every CHECK / UNIQUE / FK
--     constraint (e.g. kanban_cards keeps the parked-lane status + parent FK that
--     the simplified spec DDL omits). Zero data loss is the binding constraint.
--   * RENAMED: the legacy 'someday' parked lane is now 'icebox' (card 65afc67e,
--     Boss wording); runtime applyKanbanMigrations() migrates live someday rows.

-- ============================================================================
-- Redesigned core tables
-- ============================================================================

-- memories: hot/warm/cold/shared knowledge store.
-- Removed vs claudeclaw.db: chat_id, sector, salience, auto_generated.
-- embedding: TEXT(JSON) -> BLOB (sqlite-vec little-endian float32).
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT    NOT NULL,
  category    TEXT    NOT NULL,          -- hot | warm | cold | shared
  content     TEXT    NOT NULL,
  keywords    TEXT,
  topic_key   TEXT,
  access_scope TEXT,                     -- null = no restriction
  embedding   BLOB,                      -- sqlite-vec FLOAT32 binary; NULL until embedded
  created_at  INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);

-- agent_messages: inter-agent delivery queue.
-- Changed: priority TEXT -> INTEGER (100=urgent, 75=high, 50=normal, 25=low).
CREATE TABLE agent_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent        TEXT    NOT NULL,
  to_agent          TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  status            TEXT    NOT NULL,    -- pending | delivered | failed | completed
  priority          INTEGER NOT NULL DEFAULT 50,
  in_reply_to       INTEGER,
  ack_expected      INTEGER NOT NULL DEFAULT 0,
  result            TEXT,
  created_at        INTEGER NOT NULL,
  delivered_at      INTEGER,
  completed_at      INTEGER,
  last_escalated_at INTEGER
);

-- sessions: active agent sessions (decoupled from Telegram).
-- Changed: chat_id PK -> (agent_id, session_id) composite PK.
CREATE TABLE sessions (
  agent_id      TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, session_id)
);

-- scheduled_tasks: cron-based task registry.
-- Changed: chat_id removed; agent + type + description added.
-- A4: B-block columns added (skip_if_busy/force_send/direct_send/layer2/target_session/card_id).
--     A4 sweep ignores them at runtime; B-block activates the behaviors.
CREATE TABLE scheduled_tasks (
  id             TEXT    PRIMARY KEY,       -- task name (kebab-case)
  agent          TEXT    NOT NULL,          -- which agent runs this
  type           TEXT    NOT NULL,          -- task | heartbeat
  description    TEXT,
  prompt         TEXT    NOT NULL,
  schedule       TEXT    NOT NULL,          -- cron expression
  next_run       INTEGER NOT NULL,
  last_run       INTEGER,
  last_result    TEXT,
  status         TEXT    NOT NULL DEFAULT 'active',  -- active | paused | deleted
  created_at     INTEGER NOT NULL,
  skip_if_busy   INTEGER NOT NULL DEFAULT 0,
  force_send     INTEGER NOT NULL DEFAULT 0,
  direct_send    INTEGER NOT NULL DEFAULT 0,
  layer2         INTEGER NOT NULL DEFAULT 0,
  target_session TEXT,
  card_id        TEXT
);

-- ============================================================================
-- New table (A1 addition)
-- ============================================================================

-- embedding_cache: dedup embedding computation by content hash.
CREATE TABLE embedding_cache (
  content_hash TEXT    PRIMARY KEY,      -- SHA-256 of content (hex)
  model        TEXT    NOT NULL,         -- embedding model name
  embedding    BLOB    NOT NULL,         -- sqlite-vec FLOAT32 binary
  created_at   INTEGER NOT NULL
);

-- ============================================================================
-- Unchanged core tables (verbatim from claudeclaw.db)
-- ============================================================================

-- A3: status CHECK removed -- validation is application-layer (board_columns cache, AC-1).
-- Custom columns added via AC-10 must be valid status targets without DDL changes.
CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  project TEXT, parent_id TEXT REFERENCES kanban_cards(id), due_date INTEGER,
  sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER, dispatched_at INTEGER,
  -- 1-10 fine-grained attention rank (1 = top, 10 = lowest active). NULL = parked
  -- (icebox lane), excluded from drain/heartbeat ordering. Card 65afc67e.
  priority_score INTEGER CHECK(priority_score IS NULL OR priority_score BETWEEN 1 AND 10),
  -- Card id this card depends on (its blocker), or NULL. Read-only dependency
  -- edge (card ac37d123): persisted + validated, no auto-unblock behaviour yet.
  depends_on TEXT REFERENCES kanban_cards(id),
  -- Human-facing taxonomy code `PREFIX-NNN` (e.g. ENG-042), assigned once at
  -- create from the canonical project prefix and IMMUTABLE thereafter -- a later
  -- project change never re-sequences it. NULL when the card has no project.
  -- Card cf0d1bfe S2.
  code TEXT,
  -- Epoch-seconds of last meaningful movement (status/assignee change, archive,
  -- dispatch). NULL = unmeasured (card predates this column or no movement yet).
  -- NEVER written by bulk migrations or sort_order updates (card 4326682b).
  last_moved INTEGER
);

-- Per-prefix monotonic counter backing the card `code` auto-sequence (card
-- cf0d1bfe S2). last_seq is the highest number handed out for a prefix; it only
-- ever increases, so a deleted card's number is never reused (the gap stays).
CREATE TABLE kanban_code_seq (
  prefix TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE kanban_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NOTE: card_id FK not enforced at DB level (SQLite cannot ALTER TABLE ADD
  -- FOREIGN KEY on the populated live table). Application layer validates card
  -- existence before insert. Accepted deviation (spec A1 v5, AC-8).
  card_id TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE token_usage (
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
  project TEXT,
  model TEXT,
  spawned_by TEXT
);

CREATE TABLE daily_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ============================================================================
-- Carried-over auxiliary tables (verbatim from claudeclaw.db; decoupled later)
-- ============================================================================

CREATE TABLE agent_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  scopes_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE agent_ack_registry (
  agent_id    TEXT    PRIMARY KEY,
  declared_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400
);

CREATE TABLE background_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
  tmux_session TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  output TEXT
);

CREATE TABLE conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, chat_id, direction, message_id)
);

CREATE TABLE gate_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  reviewer    TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  note        TEXT
);

CREATE TABLE gate_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  consumed    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);

CREATE TABLE gate_pr_authors (
  pr_number    INTEGER PRIMARY KEY,
  author_agent TEXT NOT NULL,
  recorded_at  INTEGER NOT NULL
);

CREATE TABLE gate_ci_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  tsc_ok      INTEGER,
  tests_pass  INTEGER,
  tests_fail  INTEGER,
  diff_files  INTEGER,
  insertions  INTEGER,
  deletions   INTEGER,
  recorded_by TEXT    NOT NULL,
  recorded_at INTEGER NOT NULL,
  note        TEXT
);

CREATE TABLE idea_box (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Egyéb',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
  source TEXT NOT NULL DEFAULT 'marveen',
  kanban_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  impact INTEGER,
  effort INTEGER
);

CREATE TABLE pending_channel_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  user_id TEXT,
  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied'))
);

CREATE TABLE pending_task_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  first_attempt INTEGER NOT NULL,
  last_attempt INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_reason TEXT,
  alert_sent_at INTEGER,
  UNIQUE(task_name, agent_name)
);

-- Stuck-next_run sentinel (CORE/57cf5022). One row per stuck EPISODE, not per
-- task: the row is deleted as soon as the task's next_run advances again, so a
-- task that wedges a second time alerts a second time. alert_sent_at is the cap.
CREATE TABLE IF NOT EXISTS stuck_task_alerts (
  task_id       TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  alert_sent_at INTEGER
);

CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE todo_items (
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

CREATE TABLE tool_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE token_usage_cursors (
  file_path TEXT PRIMARY KEY,
  last_line INTEGER NOT NULL DEFAULT 0,
  last_size INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- Analytics snapshots (card 54df4c8f, A-layer)
-- ============================================================================
-- Per-source daily YT/Twitch pull result. UNIQUE(source, period_date) powers the
-- idempotent UPSERT (a repeated pull for the same day overwrites, never duplicates).
-- Also created at runtime by applyAnalyticsMigrations() (CREATE IF NOT EXISTS) so a
-- live noa.db predating this feature gains the table on the next boot.
CREATE TABLE analytics_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT    NOT NULL,          -- youtube | twitch
  period_date  TEXT    NOT NULL,          -- YYYY-MM-DD (period.to); upsert key
  status       TEXT    NOT NULL,          -- ok | error
  pulled_at    INTEGER NOT NULL,          -- epoch seconds
  period_from  TEXT,                      -- YYYY-MM-DD (ok only)
  period_to    TEXT,                      -- YYYY-MM-DD (ok only)
  metrics_json TEXT,                      -- JSON parsed metrics (ok only)
  reason       TEXT,                      -- error category auth|quota|network|... (error only)
  detail       TEXT,                      -- safe message; NEVER a token (error only)
  UNIQUE(source, period_date)
);
CREATE INDEX idx_analytics_source_date ON analytics_snapshots(source, period_date);

-- ============================================================================
-- FTS5: trigram tokenizer over memories (substring search) -- AC-6
-- ============================================================================

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  keywords,
  content='memories',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES('delete', old.id, old.content, old.keywords);
END;

CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES('delete', old.id, old.content, old.keywords);
  INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
END;

-- ============================================================================
-- Indexes -- AC-4 access-pattern covering set + carried-over indexes
-- ============================================================================

-- memories: tier query + recency sort
CREATE INDEX idx_memories_agent_cat ON memories(agent_id, category);
CREATE INDEX idx_memories_created   ON memories(created_at);
CREATE INDEX idx_memories_accessed  ON memories(accessed_at);
CREATE INDEX idx_memories_topic     ON memories(agent_id, topic_key) WHERE topic_key IS NOT NULL;

-- agent_messages: delivery queue (recipient + status + priority sort)
CREATE INDEX idx_messages_queue     ON agent_messages(to_agent, status, priority DESC, id);
CREATE INDEX idx_agent_messages_status ON agent_messages(status, to_agent);

-- kanban_cards: board view + parent hierarchy
CREATE INDEX idx_kanban_status      ON kanban_cards(status, archived_at, sort_order);
CREATE INDEX idx_kanban_parent      ON kanban_cards(parent_id) WHERE parent_id IS NOT NULL;

-- scheduled_tasks: next-fire sweep
CREATE INDEX idx_tasks_next         ON scheduled_tasks(agent, status, next_run) WHERE status = 'active';
CREATE INDEX idx_tasks_status_next  ON scheduled_tasks(status, next_run);

-- token_usage: dedup + agent/time aggregation
-- NOTE: 3 redundant indexes (idx_token_usage_dedup/_agent_ts/_agent) that
-- accumulated on the live DB are dropped by scripts/cleanup-noa-indexes.py
-- (spec A1 v5, AC-3) and are intentionally NOT recreated here.
CREATE UNIQUE INDEX idx_token_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);
CREATE INDEX idx_token_agent_ts     ON token_usage(agent, timestamp);
CREATE INDEX idx_token_usage_ts     ON token_usage(timestamp);

-- daily_logs: date lookup
CREATE INDEX idx_daily_agent_date   ON daily_logs(agent_id, date);

-- kanban_comments: card lookup
CREATE INDEX idx_comments_card      ON kanban_comments(card_id);

-- Carried-over table indexes (preserve query performance from claudeclaw.db)
CREATE INDEX idx_agent_tokens_sha            ON agent_tokens(token_sha256);
CREATE INDEX idx_agent_tokens_agent          ON agent_tokens(agent_id);
CREATE INDEX idx_bg_tasks_agent              ON background_tasks(agent_id, status);
CREATE INDEX idx_convlog_agent               ON conversation_log(agent_id, created_at);
CREATE INDEX idx_gate_pr_sha                 ON gate_approvals(pr_number, head_sha);
CREATE INDEX idx_gate_reviewer               ON gate_approvals(pr_number, reviewer);
CREATE INDEX idx_gate_override_pr_sha        ON gate_overrides(pr_number, head_sha);
CREATE INDEX idx_gate_ci_pr_sha              ON gate_ci_runs(pr_number, head_sha);
CREATE INDEX idx_idea_box_status             ON idea_box(status);
CREATE INDEX idx_idea_box_category           ON idea_box(category);
CREATE UNIQUE INDEX idx_pcr_agent_channel    ON pending_channel_requests(agent, channel_id) WHERE status = 'pending';
CREATE INDEX idx_pending_retries_first_attempt ON pending_task_retries(first_attempt);
CREATE INDEX idx_task_runs_ts                ON task_runs(ts);
CREATE INDEX idx_todo_owner                  ON todo_items(owner, created_at);
CREATE INDEX idx_tool_log_session            ON tool_call_log(session_id, created_at);
CREATE INDEX idx_tool_log_ts                 ON tool_call_log(created_at);

-- ============================================================================
-- A3 DDL patch: configurable board columns (AC-9)
-- ============================================================================

CREATE TABLE IF NOT EXISTS board_columns (
  id          TEXT    PRIMARY KEY,
  label       TEXT    NOT NULL,
  sort_order  REAL    NOT NULL,
  is_terminal INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_columns_order ON board_columns(sort_order);

INSERT OR IGNORE INTO board_columns (id, label, sort_order, is_terminal, created_at, updated_at) VALUES
  ('planned',     'Tervezett',    1.0, 0, unixepoch(), unixepoch()),
  ('in_progress', 'Folyamatban',  2.0, 0, unixepoch(), unixepoch()),
  ('waiting',     'Varakozik',    3.0, 0, unixepoch(), unixepoch()),
  ('icebox',      'Jegelve',      4.0, 0, unixepoch(), unixepoch()),
  ('done',        'Kesz',         5.0, 1, unixepoch(), unixepoch());
