import fs from "node:fs";
import type Database from "better-sqlite3";
import type { ExecutionStatus } from "../contracts.js";
import { isTerminalStatus } from "../jobs/state-machine.js";
import { stableFinalReplyUuid, stableStatusUuid } from "../jobs/delivery-ids.js";

const TARGET_VERSION = 11;

type LegacyRow = Record<string, unknown>;

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function legacyText(row: LegacyRow, column: string): string | null {
  return typeof row[column] === "string" ? row[column] : null;
}

function legacyNumber(row: LegacyRow, column: string): number {
  return typeof row[column] === "number" ? row[column] : 0;
}

function mapLegacyStatus(row: LegacyRow): ExecutionStatus {
  const status = legacyText(row, "status");
  if (status === "queued") return legacyText(row, "input_text") === null ? "preparing" : "queued";
  if (status === "running") return "running";
  if (status === "reply_pending") {
    const errorKind = legacyText(row, "error_kind");
    if (errorKind === null) return "succeeded";
    return errorKind === "interrupted" ? "interrupted" : "failed";
  }
  if (status === "succeeded" || status === "failed" || status === "interrupted") return status;
  throw new Error("Legacy database contains an unsupported job status");
}

function assertCleanMigrationTargets(database: Database.Database): void {
  for (const name of ["jobs_v6", "message_bindings_v6", "job_deliveries"]) {
    if (tableExists(database, name)) throw new Error(`Unexpected migration table: ${name}`);
  }
}

function validateV11(database: Database.Database): void {
  for (const name of [
    "topics",
    "service_metadata",
    "private_topic_bindings",
    "ingress_controls",
    "jobs",
    "message_bindings",
    "job_deliveries",
  ]) {
    if (!tableExists(database, name)) throw new Error(`Schema v11 is missing table: ${name}`);
  }
  const jobColumns = new Set(
    (database.pragma("table_info(jobs)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of ["requester_open_id", "result_text", "progress_json", "execution_mode", "execution_status", "status_version"]) {
    if (!jobColumns.has(name)) throw new Error(`Schema v11 is missing jobs column: ${name}`);
  }
  const bindingColumns = new Set(
    (database.pragma("table_info(message_bindings)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!bindingColumns.has("job_id")) throw new Error("Schema v11 is missing message_bindings.job_id");
  const privateBindingColumns = new Set(
    (database.pragma("table_info(private_topic_bindings)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of ["chat_id", "requester_open_id", "topic_id", "updated_at"]) {
    if (!privateBindingColumns.has(name)) throw new Error(`Schema v11 is missing private_topic_bindings column: ${name}`);
  }
  const controlColumns = new Set(
    (database.pragma("table_info(ingress_controls)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of ["message_id", "kind", "chat_id", "requester_open_id", "created_at"]) {
    if (!controlColumns.has(name)) throw new Error(`Schema v11 is missing ingress_controls column: ${name}`);
  }
  const deliveryColumns = new Set(
    (database.pragma("table_info(job_deliveries)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of ["sequence", "payload_text"]) {
    if (!deliveryColumns.has(name)) throw new Error(`Schema v11 is missing job_deliveries column: ${name}`);
  }
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) throw new Error("Schema v11 foreign-key validation failed");
}

function rebuildDeliveriesV11(database: Database.Database, schema: string): void {
  database.exec(`
    DROP INDEX IF EXISTS idx_job_deliveries_due;
    DROP INDEX IF EXISTS idx_job_deliveries_lease;
    DROP INDEX IF EXISTS idx_job_deliveries_topic_order;
    ALTER TABLE job_deliveries RENAME TO job_deliveries_v10;
  `);
  database.exec(schema);
  database.exec(`
    INSERT INTO job_deliveries(
      id, job_id, kind, sequence, payload_text, state, desired_version, delivered_version,
      attempts, next_attempt_at, stable_uuid, message_id, replacement_count,
      last_error_kind, lease_started_at, created_at, updated_at
    )
    SELECT
      legacy.id, legacy.job_id, legacy.kind, 0,
      CASE
        WHEN legacy.kind = 'final_reply' AND legacy.state NOT IN ('delivered', 'abandoned')
          THEN jobs.result_text
        ELSE NULL
      END,
      legacy.state, legacy.desired_version, legacy.delivered_version,
      legacy.attempts, legacy.next_attempt_at, legacy.stable_uuid, legacy.message_id,
      legacy.replacement_count, legacy.last_error_kind, legacy.lease_started_at,
      legacy.created_at, legacy.updated_at
    FROM job_deliveries_v10 legacy
    JOIN jobs ON jobs.id = legacy.job_id;
    DROP TABLE job_deliveries_v10;
  `);
}

function addExecutionMode(database: Database.Database): void {
  const columns = new Set(
    (database.pragma("table_info(jobs)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("execution_mode")) {
    database.exec(
      "ALTER TABLE jobs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'sandboxed' CHECK (execution_mode IN ('sandboxed', 'unrestricted'))",
    );
  }
}

function addProgressSnapshot(database: Database.Database): void {
  const columns = new Set(
    (database.pragma("table_info(jobs)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("progress_json")) database.exec("ALTER TABLE jobs ADD COLUMN progress_json TEXT");
}

function detachLegacyStatusMessages(database: Database.Database): void {
  const deliveries = database
    .prepare("SELECT id, job_id FROM job_deliveries WHERE kind = 'status' AND message_id IS NOT NULL")
    .all() as Array<{ id: number; job_id: number }>;
  const detach = database.prepare(
    `UPDATE job_deliveries
     SET message_id = NULL, stable_uuid = ?, replacement_count = 1
     WHERE id = ? AND kind = 'status'`,
  );
  for (const delivery of deliveries) detach.run(stableStatusUuid(delivery.job_id, 1), delivery.id);
}

function migrateLegacy(database: Database.Database, version: number, schema: string): void {
  assertCleanMigrationTargets(database);
  if (!tableExists(database, "topics") || !tableExists(database, "jobs") || !tableExists(database, "message_bindings")) {
    throw new Error("Legacy database is missing a required table");
  }

  const oldTopicCount = (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count;
  const oldJobs = database.prepare("SELECT * FROM jobs ORDER BY id").all() as LegacyRow[];
  const oldBindings = database.prepare("SELECT * FROM message_bindings ORDER BY message_id").all() as LegacyRow[];

  if (version <= 2) {
    database.exec("ALTER TABLE topics RENAME COLUMN codex_thread_id TO agent_session_id");
    database.exec("CREATE TABLE service_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO service_metadata(key, value) VALUES ('agent_backend', 'codex')").run();
  } else if (!tableExists(database, "service_metadata")) {
    throw new Error("Legacy database is missing service metadata");
  }

  database.exec(`
    DROP INDEX IF EXISTS idx_message_bindings_topic;
    DROP INDEX IF EXISTS idx_message_bindings_job;
    DROP INDEX IF EXISTS idx_jobs_claim;
    DROP INDEX IF EXISTS idx_topics_last_active;
    DROP INDEX IF EXISTS idx_job_deliveries_due;
    DROP INDEX IF EXISTS idx_job_deliveries_lease;
    DROP INDEX IF EXISTS idx_job_deliveries_topic_order;
    ALTER TABLE jobs RENAME TO jobs_v6;
    ALTER TABLE message_bindings RENAME TO message_bindings_v6;
  `);
  database.exec(schema);

  const jobsByMessage = new Map<string, number>();
  const jobsByStatusMessage = new Map<string, number>();
  const jobsByReplyMessage = new Map<string, number>();
  const mappedStatuses = new Map<number, ExecutionStatus>();
  const insertJob = database.prepare(`
    INSERT INTO jobs(
      id, feishu_message_id, topic_id, referenced_message_id, requester_open_id,
      input_text, result_text, execution_status, status_version, error_kind,
      created_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)
  `);

  for (const row of oldJobs) {
    const id = legacyNumber(row, "id");
    const messageId = legacyText(row, "feishu_message_id");
    const topicId = legacyText(row, "topic_id");
    const createdAt = legacyText(row, "created_at");
    if (!id || !messageId || !topicId || !createdAt) throw new Error("Legacy job contains invalid identity data");
    const status = mapLegacyStatus(row);
    insertJob.run(
      id,
      messageId,
      topicId,
      legacyText(row, "referenced_message_id"),
      legacyText(row, "input_text"),
      legacyText(row, "output_text"),
      status,
      legacyText(row, "error_kind"),
      createdAt,
      legacyText(row, "started_at"),
      legacyText(row, "finished_at"),
    );
    jobsByMessage.set(messageId, id);
    const statusMessageId = legacyText(row, "status_message_id");
    const replyMessageId = legacyText(row, "reply_message_id");
    if (statusMessageId) jobsByStatusMessage.set(statusMessageId, id);
    if (replyMessageId) jobsByReplyMessage.set(replyMessageId, id);
    mappedStatuses.set(id, status);
  }

  const insertBinding = database.prepare(`
    INSERT INTO message_bindings(message_id, chat_id, topic_id, job_id, direction, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of oldBindings) {
    const messageId = legacyText(row, "message_id");
    const chatId = legacyText(row, "chat_id");
    const topicId = legacyText(row, "topic_id");
    const direction = legacyText(row, "direction");
    const createdAt = legacyText(row, "created_at");
    if (!messageId || !chatId || !topicId || !createdAt || (direction !== "inbound" && direction !== "outbound")) {
      throw new Error("Legacy binding contains invalid identity data");
    }
    const jobId = jobsByMessage.get(messageId) ?? jobsByStatusMessage.get(messageId) ?? jobsByReplyMessage.get(messageId) ?? null;
    insertBinding.run(messageId, chatId, topicId, jobId, direction, createdAt);
  }

  const insertDelivery = database.prepare(`
    INSERT INTO job_deliveries(
      job_id, kind, state, desired_version, delivered_version, attempts,
      next_attempt_at, stable_uuid, message_id, replacement_count,
      last_error_kind, lease_started_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
  `);
  const migrationTime = new Date().toISOString();
  for (const row of oldJobs) {
    const id = legacyNumber(row, "id");
    const status = mappedStatuses.get(id);
    if (!status) throw new Error("Migrated job status is unavailable");
    insertDelivery.run(
      id,
      "status",
      "pending",
      0,
      0,
      migrationTime,
      stableStatusUuid(id),
      legacyText(row, "status_message_id"),
      migrationTime,
      migrationTime,
    );
    insertDelivery.run(id, "reaction", "pending", 0, 0, migrationTime, null, null, migrationTime, migrationTime);
    if (isTerminalStatus(status)) {
      const replyMessageId = legacyText(row, "reply_message_id");
      const resultText = legacyText(row, "output_text");
      const state = replyMessageId ? "delivered" : resultText ? "pending" : "abandoned";
      insertDelivery.run(
        id,
        "final_reply",
        state,
        state === "delivered" ? 1 : 0,
        legacyNumber(row, "reply_attempts"),
        migrationTime,
        stableFinalReplyUuid(id, status),
        replyMessageId,
        migrationTime,
        migrationTime,
      );
    }
  }
  database.exec(`
    UPDATE job_deliveries
    SET payload_text = (
      SELECT jobs.result_text FROM jobs WHERE jobs.id = job_deliveries.job_id
    )
    WHERE kind = 'final_reply' AND state NOT IN ('delivered', 'abandoned');
  `);
  detachLegacyStatusMessages(database);

  const newTopicCount = (database.prepare("SELECT COUNT(*) AS count FROM topics").get() as { count: number }).count;
  const newJobCount = (database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
  const newBindingCount = (database.prepare("SELECT COUNT(*) AS count FROM message_bindings").get() as { count: number }).count;
  if (newTopicCount !== oldTopicCount || newJobCount !== oldJobs.length || newBindingCount !== oldBindings.length) {
    throw new Error("Legacy migration row-count validation failed");
  }

  database.exec("DROP TABLE message_bindings_v6; DROP TABLE jobs_v6;");
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) throw new Error("Legacy migration foreign-key validation failed");
  database.pragma(`user_version = ${TARGET_VERSION}`);
}

export function migrate(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  const version = database.pragma("user_version", { simple: true }) as number;
  if (version > TARGET_VERSION) throw new Error(`Unsupported database schema version: ${version}`);
  if (version === TARGET_VERSION) {
    validateV11(database);
    return;
  }

  const schemaUrl = new URL("./schema.sql", import.meta.url);
  const schema = fs.readFileSync(schemaUrl, "utf8");
  if (version === 0) {
    const existing = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    if (existing.length > 0) throw new Error("Refusing to initialize an unversioned non-empty database");
    database.transaction(() => {
      database.exec(schema);
      validateV11(database);
      database.pragma(`user_version = ${TARGET_VERSION}`);
    })();
    return;
  }

  if (version === 7 || version === 8 || version === 9 || version === 10) {
    database.transaction(() => {
      addExecutionMode(database);
      addProgressSnapshot(database);
      detachLegacyStatusMessages(database);
      rebuildDeliveriesV11(database, schema);
      validateV11(database);
      database.pragma(`user_version = ${TARGET_VERSION}`);
    })();
    return;
  }

  database.transaction(() => migrateLegacy(database, version, schema))();
  validateV11(database);
}
