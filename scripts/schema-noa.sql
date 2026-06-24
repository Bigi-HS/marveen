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
--     constraint (e.g. kanban_cards keeps the 'someday' status + parent FK that
--     the simplified spec DDL omits). Zero data loss is the binding constraint.

-- ============================================================================
-- Redesigned core tables
-- ============================================================================

-- memories: hot/warm/cold/shared knowledge store.
-- Removed vs claudeclaw.db: chat_id, sector, salience, auto_generated.
-- embedding: TEXT(JSON) -> BLOB (sqlite-vec little-endian float32).
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT    NOT NULL,
  category    TEXT    NOT NULL,          -- hot | warm | cold | shared | general
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
CREATE TABLE scheduled_tasks (
  id          TEXT    PRIMARY KEY,       -- task name (kebab-case)
  agent       TEXT    NOT NULL,          -- which agent runs this
  type        TEXT    NOT NULL,          -- task | heartbeat
  description TEXT,
  prompt      TEXT    NOT NULL,
  schedule    TEXT    NOT NULL,          -- cron expression
  next_run    INTEGER NOT NULL,
  last_run    INTEGER,
  last_result TEXT,
  status      TEXT    NOT NULL DEFAULT 'active',  -- active | paused | deleted
  created_at  INTEGER NOT NULL
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

CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done','someday')),
  assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  project TEXT, parent_id TEXT REFERENCES kanban_cards(id), due_date INTEGER,
  sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER, dispatched_at INTEGER
);

CREATE TABLE kanban_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- kanban_cards: board view + parent hierarchy
CREATE INDEX idx_kanban_status      ON kanban_cards(status, archived_at, sort_order);
CREATE INDEX idx_kanban_parent      ON kanban_cards(parent_id) WHERE parent_id IS NOT NULL;

-- scheduled_tasks: next-fire sweep
CREATE INDEX idx_tasks_next         ON scheduled_tasks(agent, status, next_run) WHERE status = 'active';

-- token_usage: dedup + agent/time aggregation
CREATE UNIQUE INDEX idx_token_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens);
CREATE INDEX idx_token_agent_ts     ON token_usage(agent, timestamp);

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
CREATE INDEX idx_idea_box_status             ON idea_box(status);
CREATE INDEX idx_idea_box_category           ON idea_box(category);
CREATE UNIQUE INDEX idx_pcr_agent_channel    ON pending_channel_requests(agent, channel_id) WHERE status = 'pending';
CREATE INDEX idx_pending_retries_first_attempt ON pending_task_retries(first_attempt);
CREATE INDEX idx_task_runs_ts                ON task_runs(ts);
CREATE INDEX idx_todo_owner                  ON todo_items(owner, created_at);
CREATE INDEX idx_tool_log_session            ON tool_call_log(session_id, created_at);
CREATE INDEX idx_tool_log_ts                 ON tool_call_log(created_at);
