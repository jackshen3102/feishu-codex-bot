CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT UNIQUE,
  workspace_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS private_topic_bindings (
  chat_id TEXT NOT NULL,
  requester_open_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, requester_open_id)
);

CREATE TABLE IF NOT EXISTS ingress_controls (
  message_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  requester_open_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_message_id TEXT NOT NULL UNIQUE,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  referenced_message_id TEXT,
  requester_open_id TEXT,
  input_text TEXT,
  result_text TEXT,
  progress_json TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'sandboxed' CHECK (execution_mode IN ('sandboxed', 'unrestricted')),
  execution_status TEXT NOT NULL CHECK (execution_status IN (
    'preparing', 'queued', 'running', 'cancel_requested',
    'succeeded', 'failed', 'cancelled', 'interrupted'
  )),
  status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version >= 1),
  error_kind TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS message_bindings (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  job_id INTEGER REFERENCES jobs(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('status', 'final_reply', 'reaction')),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  payload_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'abandoned')),
  desired_version INTEGER NOT NULL CHECK (desired_version >= 1),
  delivered_version INTEGER NOT NULL DEFAULT 0 CHECK (delivered_version >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  stable_uuid TEXT,
  message_id TEXT,
  replacement_count INTEGER NOT NULL DEFAULT 0 CHECK (replacement_count >= 0),
  last_error_kind TEXT,
  lease_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, kind, sequence)
);

CREATE INDEX IF NOT EXISTS idx_message_bindings_topic
  ON message_bindings(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_bindings_job
  ON message_bindings(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs(execution_status, topic_id, id);
CREATE INDEX IF NOT EXISTS idx_topics_last_active
  ON topics(last_active_at);
CREATE INDEX IF NOT EXISTS idx_private_topic_bindings_topic
  ON private_topic_bindings(topic_id);
CREATE INDEX IF NOT EXISTS idx_ingress_controls_private_reset
  ON ingress_controls(chat_id, requester_open_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_job_deliveries_due
  ON job_deliveries(state, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_job_deliveries_lease
  ON job_deliveries(state, lease_started_at);
CREATE INDEX IF NOT EXISTS idx_job_deliveries_topic_order
  ON job_deliveries(kind, state, job_id, sequence);
