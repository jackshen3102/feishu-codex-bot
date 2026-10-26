import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { INTERRUPTED_RESULT_TEXT } from "../src/jobs/status-view.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { removeTemp, tempConfig } from "./helpers.js";

function legacyJobsSchema(version: number): string {
  const sessionColumn = version <= 2 ? "codex_thread_id" : "agent_session_id";
  return `
    CREATE TABLE topics (
      id TEXT PRIMARY KEY, ${sessionColumn} TEXT UNIQUE, workspace_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
    );
    ${version >= 3 ? "CREATE TABLE service_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);" : ""}
    CREATE TABLE message_bindings (
      message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')), created_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feishu_message_id TEXT NOT NULL UNIQUE,
      topic_id TEXT NOT NULL REFERENCES topics(id), referenced_message_id TEXT,
      input_text TEXT, output_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued','running','reply_pending','succeeded','failed','interrupted')),
      processing_reaction_id TEXT,
      reply_message_id TEXT
      ${version >= 2 ? ", reply_parent_id TEXT, reply_root_id TEXT" : ""}
      ${version >= 4 ? ", progress_sequence INTEGER NOT NULL DEFAULT 0" : ""}
      ${version >= 5 ? ", status_message_id TEXT" : ""}
      ${version >= 6 ? ", reply_attempts INTEGER NOT NULL DEFAULT 0" : ""},
      error_kind TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
  `;
}

function createLegacyFixture(databasePath: string, workspaceRoot: string, version: number): void {
  const database = new Database(databasePath);
  database.exec(legacyJobsSchema(version));
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?)").run(
    "topic",
    "session",
    path.join(workspaceRoot, "topic"),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  if (version >= 3) database.prepare("INSERT INTO service_metadata VALUES ('agent_backend', 'codex')").run();

  const columns = [
    "feishu_message_id",
    "topic_id",
    "input_text",
    "output_text",
    "status",
    "reply_message_id",
    ...(version >= 5 ? ["status_message_id"] : []),
    ...(version >= 6 ? ["reply_attempts"] : []),
    "error_kind",
    "created_at",
  ];
  const insert = database.prepare(`INSERT INTO jobs(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  const rows = [
    ["queued", "input", null, "queued", null, ...(version >= 5 ? [null] : []), ...(version >= 6 ? [0] : []), null],
    ["preparing", null, null, "queued", null, ...(version >= 5 ? ["status-preparing"] : []), ...(version >= 6 ? [0] : []), null],
    ["running", "input", null, "running", null, ...(version >= 5 ? [null] : []), ...(version >= 6 ? [0] : []), null],
    ["pending-success", null, "success result", "reply_pending", null, ...(version >= 5 ? ["status-success"] : []), ...(version >= 6 ? [2] : []), null],
    ["pending-interrupted", null, "interrupted result", "reply_pending", null, ...(version >= 5 ? [null] : []), ...(version >= 6 ? [0] : []), "interrupted"],
    ["pending-failed", null, "failure result", "reply_pending", null, ...(version >= 5 ? [null] : []), ...(version >= 6 ? [1] : []), "agent_failed"],
    ["terminal", null, null, "succeeded", "reply-terminal", ...(version >= 5 ? [null] : []), ...(version >= 6 ? [0] : []), null],
  ];
  for (const [messageId, input, output, status, replyId, ...tail] of rows) {
    insert.run(messageId, "topic", input, output, status, replyId, ...tail, "2026-01-01T00:00:00.000Z");
    database
      .prepare("INSERT INTO message_bindings VALUES (?, 'target-chat', 'topic', 'inbound', '2026-01-01T00:00:00.000Z')")
      .run(messageId);
  }
  if (version >= 5) {
    database
      .prepare("INSERT INTO message_bindings VALUES ('status-success', 'target-chat', 'topic', 'outbound', '2026-01-01T00:00:00.000Z')")
      .run();
  }
  database.pragma(`user_version = ${version}`);
  database.close();
}

async function createVersion7Fixture(databasePath: string, workspaceRoot: string): Promise<void> {
  const database = new Database(databasePath);
  const schema = await fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  database.exec(schema.split("CREATE TABLE IF NOT EXISTS oncall_topics")[0]!);
  database.exec("DROP TABLE ingress_controls; DROP TABLE private_topic_bindings;");
  database.exec("ALTER TABLE jobs DROP COLUMN execution_mode;");
  database.exec("ALTER TABLE jobs DROP COLUMN progress_json;");
  database.prepare("INSERT INTO topics VALUES (?, ?, ?, ?, ?)").run(
    "topic-v7",
    "session-v7",
    path.join(workspaceRoot, "topic-v7"),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  database.prepare("INSERT INTO service_metadata VALUES ('agent_backend', 'codex')").run();
  const job = database.prepare(
    `INSERT INTO jobs(
       feishu_message_id, topic_id, requester_open_id, input_text, result_text,
       execution_status, status_version, created_at, finished_at
     ) VALUES (?, ?, ?, NULL, NULL, 'succeeded', 1, ?, ?)`,
  ).run(
    "private-v7",
    "topic-v7",
    "user-1",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO message_bindings(message_id, chat_id, topic_id, job_id, direction, created_at)
     VALUES (?, 'private-chat', ?, ?, 'inbound', ?)`,
  ).run("private-v7", "topic-v7", Number(job.lastInsertRowid), "2026-01-01T00:00:00.000Z");
  database.pragma("user_version = 7");
  database.close();
}

async function createVersion8Fixture(databasePath: string, workspaceRoot: string): Promise<void> {
  const database = new Database(databasePath);
  const schema = await fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  database.exec(schema.split("CREATE TABLE IF NOT EXISTS oncall_topics")[0]!);
  database.exec("ALTER TABLE jobs DROP COLUMN execution_mode;");
  database.exec("ALTER TABLE jobs DROP COLUMN progress_json;");
  database.prepare("INSERT INTO topics VALUES (?, NULL, ?, ?, ?)").run(
    "topic-v8",
    path.join(workspaceRoot, "topic-v8"),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  database.prepare("INSERT INTO service_metadata VALUES ('agent_backend', 'codex')").run();
  database.prepare(
    `INSERT INTO jobs(feishu_message_id, topic_id, input_text, execution_status, status_version, created_at)
     VALUES ('job-v8', 'topic-v8', 'input', 'queued', 1, '2026-01-01T00:00:00.000Z')`,
  ).run();
  database.pragma("user_version = 8");
  database.close();
}

async function createVersion9Fixture(databasePath: string, workspaceRoot: string): Promise<void> {
  const database = new Database(databasePath);
  const schema = await fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  database.exec(schema.split("CREATE TABLE IF NOT EXISTS oncall_topics")[0]!);
  database.exec("ALTER TABLE jobs DROP COLUMN progress_json;");
  database.prepare("INSERT INTO topics VALUES (?, NULL, ?, ?, ?)").run(
    "topic-v9",
    path.join(workspaceRoot, "topic-v9"),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  database.prepare("INSERT INTO service_metadata VALUES ('agent_backend', 'codex')").run();
  database.prepare(
    `INSERT INTO jobs(feishu_message_id, topic_id, input_text, execution_mode, execution_status, status_version, created_at)
     VALUES ('job-v9', 'topic-v9', 'input', 'unrestricted', 'queued', 1, '2026-01-01T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO job_deliveries(
       job_id, kind, state, desired_version, delivered_version, attempts,
       next_attempt_at, stable_uuid, message_id, replacement_count, created_at, updated_at
     ) VALUES (1, 'status', 'delivered', 1, 1, 0, ?, 'legacy-status-uuid', 'legacy-text-message', 0, ?, ?)`,
  ).run(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  database.pragma("user_version = 9");
  database.close();
}

async function createVersion10Fixture(databasePath: string, workspaceRoot: string): Promise<void> {
  const database = new Database(databasePath);
  const schema = await fs.readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  database.exec(schema.split("CREATE TABLE IF NOT EXISTS oncall_topics")[0]!);
  database.exec(`
    DROP INDEX idx_job_deliveries_due;
    DROP INDEX idx_job_deliveries_lease;
    DROP INDEX idx_job_deliveries_topic_order;
    ALTER TABLE job_deliveries RENAME TO job_deliveries_v11;
    CREATE TABLE job_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL CHECK (kind IN ('status', 'final_reply', 'reaction')),
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
      UNIQUE(job_id, kind)
    );
    DROP TABLE job_deliveries_v11;
  `);
  const timestamp = "2026-01-01T00:00:00.000Z";
  database.prepare("INSERT INTO topics VALUES (?, NULL, ?, ?, ?)").run(
    "topic-v10",
    path.join(workspaceRoot, "topic-v10"),
    timestamp,
    timestamp,
  );
  database.prepare("INSERT INTO service_metadata VALUES ('agent_backend', 'codex')").run();
  database.prepare(
    `INSERT INTO jobs(
       feishu_message_id, topic_id, result_text, execution_status, status_version, created_at, finished_at
     ) VALUES ('job-v10', 'topic-v10', 'durable v10 result', 'succeeded', 2, ?, ?)`,
  ).run(timestamp, timestamp);
  database.prepare(
    `INSERT INTO job_deliveries(
       job_id, kind, state, desired_version, delivered_version, attempts,
       next_attempt_at, stable_uuid, replacement_count, created_at, updated_at
     ) VALUES (1, 'final_reply', 'pending', 2, 0, 1, ?, 'v10-final-uuid', 0, ?, ?)`,
  ).run(timestamp, timestamp, timestamp);
  database.pragma("user_version = 10");
  database.close();
}

function seed(store: Store, messageId: string, input: string | null = "input") {
  return store.acceptJob({
    messageId,
    chatId: "target-chat",
    requesterOpenId: "user-1",
    allowNewTopic: true,
    existingTopicInput: input,
    newTopicInput: input,
  }).job!;
}

describe("restart recovery and schema migration", () => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    it(`upgrades a version-${version} database to v13 without losing lifecycle facts`, async () => {
      const { config, root } = await tempConfig();
      createLegacyFixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT, version);
      const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      try {
        expect(store.database.pragma("user_version", { simple: true })).toBe(13);
        expect(store.getTopic("topic")?.agentSessionId).toBe("session");
        expect(store.getAllJobs().map((job) => job.executionStatus)).toEqual([
          "queued",
          "preparing",
          "running",
          "succeeded",
          "interrupted",
          "failed",
          "succeeded",
        ]);
        expect(store.getAllJobs().every((job) => job.requesterOpenId === null)).toBe(true);
        expect(store.getAllJobs().every((job) => job.executionMode === "sandboxed")).toBe(true);
        expect(store.getAllJobs().every((job) => job.progress === null)).toBe(true);
        expect(store.getJob(4)?.resultText).toBe("success result");
        expect(store.getDelivery(4, "final_reply")).toMatchObject({
          state: "pending",
          attempts: version >= 6 ? 2 : 0,
        });
        expect(store.getDelivery(7, "final_reply")).toMatchObject({ state: "delivered", messageId: "reply-terminal" });
        expect(store.findBoundJob("target-chat", "queued")?.id).toBe(1);
        if (version >= 5) {
          expect(store.findBoundJob("target-chat", "status-success")?.id).toBe(4);
          expect(store.getDelivery(4, "status")).toMatchObject({ messageId: null, replacementCount: 1 });
        }
        expect(store.database.pragma("foreign_key_check")).toEqual([]);
        expect(store.count("jobs")).toBe(7);
        expect(store.count("message_bindings")).toBe(version >= 5 ? 8 : 7);
      } finally {
        store.close();
        await removeTemp(root);
      }
    });
  }

  it("preserves message routing when upgrading a version-7 database", async () => {
    const { config, root } = await tempConfig();
    await createVersion7Fixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      expect(store.database.pragma("user_version", { simple: true })).toBe(13);
      expect(store.getTopic("topic-v7")?.agentSessionId).toBe("session-v7");
      expect(store.count("private_topic_bindings")).toBe(0);
      expect(store.count("ingress_controls")).toBe(0);
      expect(store.getJob(1)?.progress).toBeNull();
      expect(store.findBoundTopic(config.FEISHU_PRIVATE_CHAT_ID, "private-v7")?.id).toBe("topic-v7");
      expect(store.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("adds a conservative sandboxed execution mode when upgrading a version-8 database", async () => {
    const { config, root } = await tempConfig();
    await createVersion8Fixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      expect(store.database.pragma("user_version", { simple: true })).toBe(13);
      expect(store.getJob(1)?.executionMode).toBe("sandboxed");
      expect(store.getJob(1)?.progress).toBeNull();
      expect(store.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("adds bounded progress snapshots when upgrading a version-9 database", async () => {
    const { config, root } = await tempConfig();
    await createVersion9Fixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      expect(store.database.pragma("user_version", { simple: true })).toBe(13);
      expect(store.getJob(1)).toMatchObject({ executionMode: "unrestricted", progress: null });
      expect(store.getDelivery(1, "status")).toMatchObject({
        state: "delivered",
        messageId: null,
        replacementCount: 1,
      });
      expect(store.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("moves a pending version-10 final payload into the durable v11 outbox", async () => {
    const { config, root } = await tempConfig();
    await createVersion10Fixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      expect(store.database.pragma("user_version", { simple: true })).toBe(13);
      expect(store.getDelivery(1, "final_reply")).toMatchObject({
        sequence: 0,
        payloadText: "durable v10 result",
        state: "pending",
        attempts: 1,
        stableUuid: "v10-final-uuid",
      });
      expect(store.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("rolls back a failed migration and preserves its original user_version and rows", async () => {
    const { config, root } = await tempConfig();
    createLegacyFixture(config.STATE_DB_PATH, config.WORKSPACE_ROOT, 6);
    const database = new Database(config.STATE_DB_PATH);
    database.pragma("foreign_keys = OFF");
    database.prepare("UPDATE jobs SET topic_id = 'missing-topic' WHERE id = 1").run();
    database.close();
    try {
      expect(() => new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT)).toThrow();
      const preserved = new Database(config.STATE_DB_PATH);
      expect(preserved.pragma("user_version", { simple: true })).toBe(6);
      expect((preserved.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(7);
      expect(preserved.prepare("SELECT status FROM jobs WHERE id = 1").get()).toEqual({ status: "queued" });
      preserved.close();
    } finally {
      await removeTemp(root);
    }
  });

  it("turns uncertain executions into interrupted once and restores delivery leases", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const preparing = seed(store, "preparing", null);
      const running = seed(store, "running");
      const cancelling = seed(store, "cancelling");
      const queued = seed(store, "queued");
      store.claimRunnableJobs(2);
      expect(store.getJob(running.id)?.executionStatus).toBe("running");
      expect(store.getJob(cancelling.id)?.executionStatus).toBe("running");
      expect(store.requestCancellation(cancelling.id, "user-1").kind).toBe("abort_required");
      expect(store.claimDueDelivery()).not.toBeNull();

      const recovered = store.recoverUncertainExecutions();
      expect(recovered.map((item) => item.previousStatus).sort()).toEqual([
        "cancel_requested",
        "preparing",
        "running",
      ]);
      expect(store.getJob(preparing.id)?.executionStatus).toBe("interrupted");
      expect(store.getJob(queued.id)?.executionStatus).toBe("queued");
      expect(store.getJob(running.id)?.executionStatus).toBe("interrupted");
      expect(store.getJob(cancelling.id)?.executionStatus).toBe("interrupted");
      expect(store.getJob(running.id)?.resultText).toBe(INTERRUPTED_RESULT_TEXT);
      expect(store.getJob(cancelling.id)?.resultText).toBe(INTERRUPTED_RESULT_TEXT);
      expect(store.getJob(running.id)?.resultText).not.toContain("请回复重试");
      expect(store.listDeliveries().some((delivery) => delivery.state === "delivering")).toBe(false);
      expect(store.recoverUncertainExecutions()).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("preserves historical private message bindings after restart without reusing the old current topic", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const accept = (messageId: string, parentId?: string) => store.acceptJob({
      messageId,
      chatId: config.FEISHU_PRIVATE_CHAT_ID,
      requesterOpenId: "user-1",
      parentId,
      allowNewTopic: true,
      executionMode: "unrestricted",
      existingTopicInput: messageId,
      newTopicInput: messageId,
    });
    try {
      const first = accept("private-first");
      store.setAgentSessionId(first.topic!.id, "historical-session");
      accept("historical-second", "private-first");
      store.database.prepare("INSERT INTO private_topic_bindings VALUES (?, ?, ?, ?)").run(
        config.FEISHU_PRIVATE_CHAT_ID, "user-1", first.topic!.id, new Date().toISOString(),
      );
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      const next = accept("private-next");
      expect(next.topic!.id).not.toBe(first.topic!.id);
      expect(next.topic!.agentSessionId).toBeNull();
      for (const messageId of ["private-first", "historical-second"]) {
        const reply = accept(`reply-${messageId}`, messageId);
        expect(reply.topic!.id).toBe(first.topic!.id);
        expect(reply.topic!.agentSessionId).toBe("historical-session");
        expect(reply.job!.executionMode).toBe("unrestricted");
      }
      expect(accept("private-next").duplicate).toBe(true);
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(accept("next-reply", "private-next").topic!.id).toBe(next.topic!.id);
      expect(accept("another-independent").topic!.id).not.toBe(next.topic!.id);
    } finally {
      if (store.database.open) store.close();
      await removeTemp(root);
    }
  });

  it("cleans stale workspace data without deleting topic routing and recreates the same path", async () => {
    const { config, root } = await tempConfig({ WORKSPACE_RETENTION_DAYS: 7 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const job = seed(store, "old");
    const topic = store.getTopic(job.topicId)!;
    store.claimRunnableJobs(1);
    store.completeExecution(job.id, { status: "succeeded", reply: "done" }, null);
    await workspaces.ensure(topic.workspacePath);
    store.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", topic.id);
    const removed = await workspaces.cleanup(store, 7, Date.parse("2020-01-09T00:00:00.000Z"));
    expect(removed).toEqual([topic.id]);
    await expect(fs.stat(topic.workspacePath)).rejects.toThrow();
    expect(store.getTopic(topic.id)).not.toBeNull();
    expect(store.count("message_bindings")).toBe(1);
    await workspaces.ensure(topic.workspacePath);
    expect(await fs.stat(topic.workspacePath)).toBeTruthy();
    store.close();
    await removeTemp(root);
  });
});

describe("Oncall persistent recovery", () => {
  it("adds v12 Oncall tables to an existing v11 database without changing jobs, sessions or outbox", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const job = seed(store, "v11-running");
      store.setAgentSessionId(job.topicId, "v11-session");
      store.claimRunnableJobs(1);
      store.completeExecution(job.id, { status: "succeeded", reply: "undelivered result" }, null);
      const before = { jobs: store.getAllJobs(), deliveries: store.listDeliveries() };
      store.database.exec("DROP TABLE oncall_case_history; DROP TABLE oncall_cases; DROP TABLE oncall_messages; DROP TABLE oncall_topics;");
      store.database.pragma("user_version = 11");
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.database.pragma("user_version", { simple: true })).toBe(13);
      expect(store.getAllJobs()).toEqual(before.jobs);
      expect(store.listDeliveries()).toEqual(before.deliveries);
      expect(store.getTopic(job.topicId)?.agentSessionId).toBe("v11-session");
      for (const table of ["oncall_topics", "oncall_messages", "oncall_cases", "oncall_case_history"]) {
        expect(store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(store.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (store.database.open) store.close();
      await removeTemp(root);
    }
  });

  it("pauses an interrupted topic across restart while preserving its queue and letting other topics run", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const active = seed(store, "oncall-active");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'oncall-active', 'user-1')`).run(active.topicId);
      const queued = store.acceptJob({ messageId: "oncall-queued", chatId: "target-chat", parentId: "oncall-active",
        requesterOpenId: "user-2", allowNewTopic: false, existingTopicInput: "follow-up", newTopicInput: "follow-up" }).job!;
      const other = seed(store, "other-topic");
      expect(store.claimRunnableJobs(1)[0]?.id).toBe(active.id);
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.recoverUncertainExecutions().map((item) => item.job.id)).toEqual([active.id]);
      expect(store.database.prepare("SELECT paused, pause_reason FROM oncall_topics WHERE topic_id = ?").get(active.topicId))
        .toEqual({ paused: 1, pause_reason: "interrupted" });
      expect(store.claimRunnableJobs(5).map((job) => job.id)).toEqual([other.id]);
      expect(store.getJob(queued.id)?.executionStatus).toBe("queued");
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      store.recoverUncertainExecutions();
      expect(store.claimRunnableJobs(5)).toEqual([]);
      expect(store.getJob(queued.id)?.executionStatus).toBe("queued");
    } finally {
      if (store.database.open) store.close();
      await removeTemp(root);
    }
  });

  it("retains queued, running and paused workspaces even after their retention deadline", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    try {
      const jobs = [seed(store, "running-old"), seed(store, "queued-old"), seed(store, "paused-old")];
      store.claimRunnableJobs(1);
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id, paused)
        VALUES (?, 'infra', 'target-chat', 'paused-old', 'user-1', 1)`).run(jobs[2]!.topicId);
      for (const job of jobs) await workspaces.ensure(store.getTopic(job.topicId)!.workspacePath);
      store.database.prepare("UPDATE topics SET last_active_at = '2020-01-01T00:00:00.000Z'").run();
      expect(await workspaces.cleanup(store, 7, Date.parse("2026-01-01T00:00:00.000Z"))).toEqual([]);
      for (const job of jobs) expect((await fs.stat(store.getTopic(job.topicId)!.workspacePath)).isDirectory()).toBe(true);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});
