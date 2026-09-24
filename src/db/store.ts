import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AgentBackend } from "../config.js";
import type {
  DeliveryKind,
  DeliveryState,
  ExecutionMode,
  ExecutionStatus,
  AgentProgressSnapshot,
  Job,
  JobDelivery,
  ReplyReceipt,
  Topic,
  TurnReply,
} from "../contracts.js";
import { stableFinalReplyUuid, stableStatusUuid } from "../jobs/delivery-ids.js";
import { splitFinalReply } from "../jobs/final-reply.js";
import { canTransition, isTerminalStatus } from "../jobs/state-machine.js";
import { CANCELLED_RESULT_TEXT, INTERRUPTED_RESULT_TEXT } from "../jobs/status-view.js";
import { migrate } from "./migrate.js";

interface TopicRow {
  id: string;
  agent_session_id: string | null;
  workspace_path: string;
  created_at: string;
  last_active_at: string;
}

interface JobRow {
  id: number;
  feishu_message_id: string;
  topic_id: string;
  referenced_message_id: string | null;
  requester_open_id: string | null;
  input_text: string | null;
  result_text: string | null;
  progress_json: string | null;
  execution_mode: ExecutionMode;
  execution_status: ExecutionStatus;
  status_version: number;
  error_kind: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface DeliveryRow {
  id: number;
  job_id: number;
  kind: DeliveryKind;
  sequence: number;
  payload_text: string | null;
  state: DeliveryState;
  desired_version: number;
  delivered_version: number;
  attempts: number;
  next_attempt_at: string;
  stable_uuid: string | null;
  message_id: string | null;
  replacement_count: number;
  last_error_kind: string | null;
  lease_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptJobInput {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  parentId?: string;
  rootId?: string;
  existingTopicInput: string | null;
  newTopicInput: string | null;
  allowNewTopic: boolean;
  executionMode?: ExecutionMode;
}

export type AcceptMessageInput = AcceptJobInput;

export interface AcceptedJob {
  accepted: boolean;
  duplicate: boolean;
  job?: Job;
  topic?: Topic;
  createdTopic?: boolean;
}

export type AcceptedMessage = AcceptedJob;

export type CancelDecision =
  | { kind: "cancelled_before_run"; job: Job }
  | { kind: "abort_required"; job: Job }
  | { kind: "already_requested"; job: Job }
  | { kind: "already_terminal"; job: Job }
  | { kind: "not_requester"; job: Job }
  | { kind: "not_found" };

export type CompletionDecision =
  | { kind: "completed"; job: Job }
  | { kind: "cancel_requested"; job: Job }
  | { kind: "already_terminal"; job: Job }
  | { kind: "conflict"; job: Job | null };

export interface RecoveredExecution {
  job: Job;
  previousStatus: "preparing" | "running" | "cancel_requested";
}

export interface DeliveryFailure {
  attempts: number;
  abandoned: boolean;
  jobId: number;
  kind: DeliveryKind;
}

export interface OperationalSnapshot {
  schemaVersion: number;
  backend: AgentBackend;
  lastExecution: {
    jobId: number;
    status: Extract<ExecutionStatus, "succeeded" | "failed" | "cancelled" | "interrupted">;
    errorKind: string | null;
    finishedAt: string;
  } | null;
  jobs: {
    preparing: number;
    queued: number;
    running: number;
    cancelRequested: number;
    oldestQueuedAt: string | null;
  };
  deliveries: {
    pending: number;
    delivering: number;
    abandoned: number;
    lastSuccessfulAt: string | null;
  };
  databaseBytes: number;
}

function now(): string {
  return new Date().toISOString();
}

function mapTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    agentSessionId: row.agent_session_id,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    feishuMessageId: row.feishu_message_id,
    topicId: row.topic_id,
    referencedMessageId: row.referenced_message_id,
    requesterOpenId: row.requester_open_id,
    inputText: row.input_text,
    resultText: row.result_text,
    progress: row.progress_json ? JSON.parse(row.progress_json) as AgentProgressSnapshot : null,
    executionMode: row.execution_mode,
    executionStatus: row.execution_status,
    statusVersion: row.status_version,
    errorKind: row.error_kind,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapDelivery(row: DeliveryRow): JobDelivery {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    sequence: row.sequence,
    payloadText: row.payload_text,
    state: row.state,
    desiredVersion: row.desired_version,
    deliveredVersion: row.delivered_version,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    stableUuid: row.stable_uuid,
    messageId: row.message_id,
    replacementCount: row.replacement_count,
    lastErrorKind: row.last_error_kind,
    leaseStartedAt: row.lease_started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Store {
  readonly database: Database.Database;
  private readonly workspaceRoot: string;
  private readonly databasePath: string;

  constructor(databasePath: string, workspaceRoot: string, backend: AgentBackend = "codex") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    try {
      if (fs.lstatSync(databasePath).isSymbolicLink()) throw new Error("STATE_DB_PATH cannot be a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.workspaceRoot = workspaceRoot;
    this.databasePath = databasePath;
    this.database = new Database(databasePath);
    fs.chmodSync(databasePath, 0o600);
    try {
      migrate(this.database);
      this.bindAgentBackend(backend);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  findBoundTopic(chatId: string, parentId?: string, rootId?: string): Topic | null {
    for (const messageId of [rootId, parentId]) {
      if (!messageId) continue;
      const row = this.database
        .prepare(
          `SELECT t.* FROM message_bindings b
           JOIN topics t ON t.id = b.topic_id
           WHERE b.message_id = ? AND b.chat_id = ?`,
        )
        .get(messageId, chatId) as TopicRow | undefined;
      if (row) return mapTopic(row);
    }
    return null;
  }

  findBoundJob(chatId: string, messageId: string): Job | null {
    const row = this.database
      .prepare(
        `SELECT j.* FROM message_bindings b
         JOIN jobs j ON j.id = b.job_id
         WHERE b.message_id = ? AND b.chat_id = ?`,
      )
      .get(messageId, chatId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  getBindingChatId(messageId: string): string | null {
    const row = this.database
      .prepare("SELECT chat_id FROM message_bindings WHERE message_id = ?")
      .get(messageId) as { chat_id: string } | undefined;
    return row?.chat_id ?? null;
  }

  acceptJob(input: AcceptJobInput): AcceptedJob {
    if (!input.requesterOpenId) throw new Error("New jobs require a requester identity");
    return this.database.transaction((): AcceptedJob => {
      const existing = this.database
        .prepare("SELECT * FROM jobs WHERE feishu_message_id = ?")
        .get(input.messageId) as JobRow | undefined;
      if (existing) {
        return {
          accepted: false,
          duplicate: true,
          job: mapJob(existing),
          topic: this.getTopic(existing.topic_id) ?? undefined,
        };
      }
      const duplicateBinding = this.database
        .prepare("SELECT topic_id FROM message_bindings WHERE message_id = ?")
        .get(input.messageId) as { topic_id: string } | undefined;
      if (duplicateBinding) {
        return {
          accepted: false,
          duplicate: true,
          topic: this.getTopic(duplicateBinding.topic_id) ?? undefined,
        };
      }

      let topic = this.findBoundTopic(input.chatId, input.parentId, input.rootId);
      let createdTopic = false;
      if (!topic) {
        if (!input.allowNewTopic) return { accepted: false, duplicate: false };
        const timestamp = now();
        const id = randomUUID();
        const workspacePath = path.join(this.workspaceRoot, id);
        this.database
          .prepare(
            `INSERT INTO topics(id, agent_session_id, workspace_path, created_at, last_active_at)
             VALUES (?, NULL, ?, ?, ?)`,
          )
          .run(id, workspacePath, timestamp, timestamp);
        topic = this.getTopic(id);
        createdTopic = true;
      }
      if (!topic) throw new Error("topic creation failed");

      const timestamp = now();
      const inputText = createdTopic ? input.newTopicInput : input.existingTopicInput;
      const executionStatus: ExecutionStatus = inputText === null ? "preparing" : "queued";
      const result = this.database
        .prepare(
          `INSERT INTO jobs(
             feishu_message_id, topic_id, referenced_message_id, requester_open_id,
             input_text, execution_mode, execution_status, status_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.messageId,
          topic.id,
          input.parentId ?? input.rootId ?? null,
          input.requesterOpenId,
          inputText,
          input.executionMode ?? "sandboxed",
          executionStatus,
          timestamp,
        );
      const jobId = Number(result.lastInsertRowid);
      this.database
        .prepare(
          `INSERT INTO message_bindings(message_id, chat_id, topic_id, job_id, direction, created_at)
           VALUES (?, ?, ?, ?, 'inbound', ?)`,
        )
        .run(input.messageId, input.chatId, topic.id, jobId, timestamp);
      const threadRootId = input.rootId ?? input.parentId;
      if (threadRootId && threadRootId !== input.messageId) {
        this.database
          .prepare(
            `INSERT INTO message_bindings(message_id, chat_id, topic_id, job_id, direction, created_at)
             VALUES (?, ?, ?, NULL, 'inbound', ?)
             ON CONFLICT(message_id) DO NOTHING`,
          )
          .run(threadRootId, input.chatId, topic.id, timestamp);
      }
      this.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?").run(timestamp, topic.id);
      this.mergeDelivery(jobId, "status", 1, stableStatusUuid(jobId), timestamp);
      this.mergeDelivery(jobId, "reaction", 1, null, timestamp);

      const job = this.getJob(jobId);
      if (!job) throw new Error("job insertion failed");
      return {
        accepted: true,
        duplicate: false,
        job,
        topic,
        createdTopic,
      };
    })();
  }

  acceptMessage(input: AcceptMessageInput): AcceptedMessage {
    return this.acceptJob(input);
  }

  getTopic(id: string): Topic | null {
    const row = this.database.prepare("SELECT * FROM topics WHERE id = ?").get(id) as TopicRow | undefined;
    return row ? mapTopic(row) : null;
  }

  getJob(id: number): Job | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  getAllJobs(): Job[] {
    return (this.database.prepare("SELECT * FROM jobs ORDER BY id").all() as JobRow[]).map(mapJob);
  }

  hasRunnableJobs(): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM jobs
           WHERE execution_status IN ('queued', 'running', 'cancel_requested')
           LIMIT 1`,
        )
        .get(),
    );
  }

  operationalSnapshot(): OperationalSnapshot {
    const lastExecution = this.database.prepare(
      `SELECT id, execution_status, error_kind, finished_at FROM jobs
       WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ).get() as {
      id: number;
      execution_status: NonNullable<OperationalSnapshot["lastExecution"]>["status"];
      error_kind: string | null;
      finished_at: string;
    } | undefined;
    const jobs = this.database
      .prepare(
        `SELECT
           SUM(execution_status = 'preparing') AS preparing,
           SUM(execution_status = 'queued') AS queued,
           SUM(execution_status = 'running') AS running,
           SUM(execution_status = 'cancel_requested') AS cancel_requested,
           MIN(CASE WHEN execution_status = 'queued' THEN created_at END) AS oldest_queued_at
         FROM jobs`,
      )
      .get() as {
        preparing: number | null;
        queued: number | null;
        running: number | null;
        cancel_requested: number | null;
        oldest_queued_at: string | null;
      };
    const deliveries = this.database
      .prepare(
        `SELECT
           SUM(state = 'pending') AS pending,
           SUM(state = 'delivering') AS delivering,
           SUM(state = 'abandoned') AS abandoned,
           MAX(CASE WHEN state = 'delivered' THEN updated_at END) AS last_successful_at
         FROM job_deliveries`,
      )
      .get() as {
        pending: number | null;
        delivering: number | null;
        abandoned: number | null;
        last_successful_at: string | null;
      };
    let databaseBytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        databaseBytes += fs.statSync(`${this.databasePath}${suffix}`).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      schemaVersion: this.database.pragma("user_version", { simple: true }) as number,
      backend: this.getAgentBackend(),
      lastExecution: lastExecution ? {
        jobId: lastExecution.id,
        status: lastExecution.execution_status,
        errorKind: lastExecution.error_kind,
        finishedAt: lastExecution.finished_at,
      } : null,
      jobs: {
        preparing: jobs.preparing ?? 0,
        queued: jobs.queued ?? 0,
        running: jobs.running ?? 0,
        cancelRequested: jobs.cancel_requested ?? 0,
        oldestQueuedAt: jobs.oldest_queued_at,
      },
      deliveries: {
        pending: deliveries.pending ?? 0,
        delivering: deliveries.delivering ?? 0,
        abandoned: deliveries.abandoned ?? 0,
        lastSuccessfulAt: deliveries.last_successful_at,
      },
      databaseBytes,
    };
  }

  pruneTerminalJobs(before: string, limit = 1_000): number {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("job prune limit is invalid");
    const removed = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT j.id FROM jobs j
           WHERE j.execution_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
             AND j.finished_at < ?
             AND EXISTS (
               SELECT 1 FROM job_deliveries final_delivery
               WHERE final_delivery.job_id = j.id AND final_delivery.kind = 'final_reply'
             )
             AND EXISTS (
               SELECT 1 FROM job_deliveries status_delivery
               WHERE status_delivery.job_id = j.id AND status_delivery.kind = 'status'
             )
             AND NOT EXISTS (
               SELECT 1 FROM job_deliveries d
               WHERE d.job_id = j.id AND d.state NOT IN ('delivered', 'abandoned')
             )
           ORDER BY j.finished_at, j.id
           LIMIT ?`,
        )
        .all(before, limit) as Array<{ id: number }>;
      if (rows.length === 0) return 0;
      const detach = this.database.prepare("UPDATE message_bindings SET job_id = NULL WHERE job_id = ?");
      const deleteDeliveries = this.database.prepare("DELETE FROM job_deliveries WHERE job_id = ?");
      const deleteJob = this.database.prepare("DELETE FROM jobs WHERE id = ?");
      for (const row of rows) {
        detach.run(row.id);
        deleteDeliveries.run(row.id);
        deleteJob.run(row.id);
      }
      return rows.length;
    })();
    if (removed > 0) {
      this.database.pragma("optimize");
      this.database.pragma("wal_checkpoint(PASSIVE)");
    }
    return removed;
  }

  getDelivery(jobId: number, kind: DeliveryKind): JobDelivery | null {
    const row = this.database
      .prepare("SELECT * FROM job_deliveries WHERE job_id = ? AND kind = ? ORDER BY sequence LIMIT 1")
      .get(jobId, kind) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  }

  getFinalReplyState(jobId: number): DeliveryState | null {
    const row = this.database
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(state = 'abandoned') AS abandoned,
           SUM(state = 'delivered') AS delivered,
           SUM(state = 'delivering') AS delivering
         FROM job_deliveries
         WHERE job_id = ? AND kind = 'final_reply'`,
      )
      .get(jobId) as { total: number; abandoned: number; delivered: number; delivering: number };
    if (row.total === 0) return null;
    if (row.abandoned > 0) return "abandoned";
    if (row.delivered === row.total) return "delivered";
    if (row.delivering > 0) return "delivering";
    return "pending";
  }

  getDeliveryById(id: number): JobDelivery | null {
    const row = this.database.prepare("SELECT * FROM job_deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  }

  listDeliveries(jobId?: number): JobDelivery[] {
    const rows = jobId === undefined
      ? (this.database.prepare("SELECT * FROM job_deliveries ORDER BY job_id, kind, sequence").all() as DeliveryRow[])
      : (this.database
          .prepare("SELECT * FROM job_deliveries WHERE job_id = ? ORDER BY kind, sequence")
          .all(jobId) as DeliveryRow[]);
    return rows.map(mapDelivery);
  }

  count(
    table: "topics" | "private_topic_bindings" | "ingress_controls" | "message_bindings" | "jobs" | "job_deliveries",
  ): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  getQueueWaitReason(jobId: number): "topic" | "capacity" | null {
    const job = this.getJob(jobId);
    if (!job || job.executionStatus !== "queued") return null;
    const blocker = this.database.prepare(
      `SELECT 1 FROM jobs WHERE topic_id = ? AND
       (execution_status IN ('running', 'cancel_requested')
        OR (execution_status = 'queued' AND id < ?)) LIMIT 1`,
    ).get(job.topicId, job.id);
    return blocker ? "topic" : "capacity";
  }

  markInputReady(jobId: number, prompt: string): Job {
    return this.database.transaction(() => {
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET input_text = ?, execution_status = 'queued', status_version = status_version + 1
           WHERE id = ? AND execution_status = 'preparing'`,
        )
        .run(prompt, jobId);
      if (result.changes !== 1) throw new Error("job input is not awaiting preparation");
      const job = this.requireJob(jobId);
      this.mergeStatusAndReaction(job, timestamp);
      this.dirtyQueuedTopic(job, timestamp);
      return job;
    })();
  }

  failInputPreparation(jobId: number, safeError: string, failureKind: string): Job {
    return this.database.transaction(() => {
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET input_text = NULL, result_text = ?, execution_status = 'failed', error_kind = ?,
               status_version = status_version + 1, finished_at = ?
           WHERE id = ? AND execution_status = 'preparing'`,
        )
        .run(safeError, failureKind, timestamp, jobId);
      if (result.changes !== 1) throw new Error("job input is not awaiting preparation");
      const job = this.requireJob(jobId);
      this.mergeTerminalDeliveries(job, timestamp);
      return job;
    })();
  }

  claimRunnableJobs(limit: number): Job[] {
    if (limit < 1) return [];
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT j.* FROM jobs j
           WHERE j.execution_status = 'queued'
             AND j.input_text IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM jobs active
               WHERE active.topic_id = j.topic_id
                 AND active.execution_status IN ('running', 'cancel_requested')
             )
             AND j.id = (
               SELECT MIN(first_job.id) FROM jobs first_job
               WHERE first_job.topic_id = j.topic_id AND first_job.execution_status = 'queued'
             )
           ORDER BY j.id
           LIMIT ?`,
        )
        .all(limit) as JobRow[];

      const claimed: Job[] = [];
      const timestamp = now();
      for (const row of rows) {
        const result = this.database
          .prepare(
            `UPDATE jobs
             SET execution_status = 'running', started_at = ?, status_version = status_version + 1
             WHERE id = ? AND execution_status = 'queued' AND input_text IS NOT NULL`,
          )
          .run(timestamp, row.id);
        if (result.changes !== 1) continue;
        const job = this.requireJob(row.id);
        this.mergeStatusAndReaction(job, timestamp);
        claimed.push(job);
      }
      return claimed;
    })();
  }

  claimJobs(limit: number): Job[] {
    return this.claimRunnableJobs(limit);
  }

  setAgentSessionId(topicId: string, sessionId: string): void {
    const current = this.getTopic(topicId);
    if (!current) throw new Error("topic not found");
    if (current.agentSessionId && current.agentSessionId !== sessionId) {
      throw new Error("topic already belongs to a different agent session");
    }
    this.database
      .prepare("UPDATE topics SET agent_session_id = ?, last_active_at = ? WHERE id = ?")
      .run(sessionId, now(), topicId);
  }

  getAgentBackend(): AgentBackend {
    const row = this.database
      .prepare("SELECT value FROM service_metadata WHERE key = 'agent_backend'")
      .get() as { value: string } | undefined;
    if (row?.value !== "codex") throw new Error("state database has no valid agent backend");
    return row.value;
  }

  completeExecution(jobId: number, result: TurnReply, failureKind: string | null): CompletionDecision {
    return this.database.transaction((): CompletionDecision => {
      const current = this.getJob(jobId);
      if (!current) return { kind: "conflict", job: null };
      if (current.executionStatus === "cancel_requested") return { kind: "cancel_requested", job: current };
      if (isTerminalStatus(current.executionStatus)) return { kind: "already_terminal", job: current };
      if (current.executionStatus !== "running") return { kind: "conflict", job: current };

      const target: ExecutionStatus = result.status === "succeeded" ? "succeeded" : "failed";
      if (!canTransition(current.executionStatus, target)) return { kind: "conflict", job: current };
      const timestamp = now();
      const update = this.database
        .prepare(
          `UPDATE jobs
           SET input_text = NULL, result_text = ?, execution_status = ?, error_kind = ?,
               status_version = status_version + 1, finished_at = ?
           WHERE id = ? AND execution_status = 'running'`,
        )
        .run(result.reply, target, failureKind, timestamp, jobId);
      if (update.changes !== 1) {
        const latest = this.getJob(jobId);
        if (latest?.executionStatus === "cancel_requested") return { kind: "cancel_requested", job: latest };
        if (latest && isTerminalStatus(latest.executionStatus)) return { kind: "already_terminal", job: latest };
        return { kind: "conflict", job: latest };
      }
      const job = this.requireJob(jobId);
      this.mergeTerminalDeliveries(job, timestamp);
      this.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?").run(timestamp, job.topicId);
      return { kind: "completed", job };
    })();
  }

  interruptExecution(jobId: number, safeError: string, failureKind = "interrupted"): CompletionDecision {
    return this.database.transaction((): CompletionDecision => {
      const current = this.getJob(jobId);
      if (!current) return { kind: "conflict", job: null };
      if (isTerminalStatus(current.executionStatus)) return { kind: "already_terminal", job: current };
      if (current.executionStatus === "cancel_requested") return { kind: "cancel_requested", job: current };
      if (current.executionStatus !== "running") return { kind: "conflict", job: current };
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET input_text = NULL, result_text = ?, execution_status = 'interrupted', error_kind = ?,
               status_version = status_version + 1, finished_at = ?
           WHERE id = ? AND execution_status = 'running'`,
        )
        .run(safeError, failureKind, timestamp, jobId);
      if (result.changes !== 1) return { kind: "conflict", job: this.getJob(jobId) };
      const job = this.requireJob(jobId);
      this.mergeTerminalDeliveries(job, timestamp);
      this.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?").run(timestamp, job.topicId);
      return { kind: "completed", job };
    })();
  }

  requestCancellation(jobId: number, requesterOpenId: string): CancelDecision {
    return this.database.transaction((): CancelDecision => {
      const current = this.getJob(jobId);
      if (!current) return { kind: "not_found" };
      if (!current.requesterOpenId || current.requesterOpenId !== requesterOpenId) {
        return { kind: "not_requester", job: current };
      }
      if (isTerminalStatus(current.executionStatus)) return { kind: "already_terminal", job: current };
      if (current.executionStatus === "cancel_requested") return { kind: "already_requested", job: current };

      const timestamp = now();
      if (current.executionStatus === "preparing" || current.executionStatus === "queued") {
        const previous = current.executionStatus;
        const result = this.database
          .prepare(
            `UPDATE jobs
             SET input_text = NULL, result_text = ?, execution_status = 'cancelled', error_kind = 'user_cancelled',
                 status_version = status_version + 1, finished_at = ?
             WHERE id = ? AND execution_status = ?`,
          )
          .run(CANCELLED_RESULT_TEXT, timestamp, jobId, previous);
        if (result.changes !== 1) return this.requestCancellation(jobId, requesterOpenId);
        const job = this.requireJob(jobId);
        this.mergeTerminalDeliveries(job, timestamp);
        return { kind: "cancelled_before_run", job };
      }

      if (current.executionStatus !== "running") return { kind: "already_terminal", job: current };
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET execution_status = 'cancel_requested', status_version = status_version + 1
           WHERE id = ? AND execution_status = 'running'`,
        )
        .run(jobId);
      if (result.changes !== 1) return this.requestCancellation(jobId, requesterOpenId);
      const job = this.requireJob(jobId);
      this.mergeStatusAndReaction(job, timestamp);
      return { kind: "abort_required", job };
    })();
  }

  confirmCancellation(jobId: number): CompletionDecision {
    return this.database.transaction((): CompletionDecision => {
      const current = this.getJob(jobId);
      if (!current) return { kind: "conflict", job: null };
      if (isTerminalStatus(current.executionStatus)) return { kind: "already_terminal", job: current };
      if (current.executionStatus !== "cancel_requested") return { kind: "conflict", job: current };
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE jobs
           SET input_text = NULL, result_text = ?, execution_status = 'cancelled', error_kind = 'user_cancelled',
               status_version = status_version + 1, finished_at = ?
           WHERE id = ? AND execution_status = 'cancel_requested'`,
        )
        .run(CANCELLED_RESULT_TEXT, timestamp, jobId);
      if (result.changes !== 1) return { kind: "conflict", job: this.getJob(jobId) };
      const job = this.requireJob(jobId);
      this.mergeTerminalDeliveries(job, timestamp);
      this.database.prepare("UPDATE topics SET last_active_at = ? WHERE id = ?").run(timestamp, job.topicId);
      return { kind: "completed", job };
    })();
  }

  markStatusDirty(jobId: number): boolean {
    return this.database.transaction(() => {
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE jobs SET status_version = status_version + 1
           WHERE id = ? AND execution_status = 'running'`,
        )
        .run(jobId);
      if (result.changes !== 1) return false;
      const job = this.requireJob(jobId);
      this.mergeDelivery(job.id, "status", job.statusVersion, stableStatusUuid(job.id), timestamp);
      return true;
    })();
  }

  updateProgress(jobId: number, progress: AgentProgressSnapshot): boolean {
    return this.database.transaction(() => {
      const timestamp = now();
      const progressJson = JSON.stringify(progress);
      const result = this.database
        .prepare(
          `UPDATE jobs SET progress_json = ?, status_version = status_version + 1
           WHERE id = ? AND execution_status = 'running' AND COALESCE(progress_json, '') <> ?`,
        )
        .run(progressJson, jobId, progressJson);
      if (result.changes !== 1) return false;
      const job = this.requireJob(jobId);
      this.mergeDelivery(job.id, "status", job.statusVersion, stableStatusUuid(job.id), timestamp);
      return true;
    })();
  }

  recoverUncertainExecutions(): RecoveredExecution[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT * FROM jobs
           WHERE execution_status IN ('preparing', 'running', 'cancel_requested')
           ORDER BY id`,
        )
        .all() as JobRow[];
      const timestamp = now();
      const recovered: RecoveredExecution[] = [];
      for (const row of rows) {
        const previousStatus = row.execution_status as RecoveredExecution["previousStatus"];
        const resultText = previousStatus === "preparing"
          ? "任务输入接收中断，请重新发送原请求。"
          : INTERRUPTED_RESULT_TEXT;
        const result = this.database
          .prepare(
            `UPDATE jobs
             SET input_text = NULL, result_text = ?, execution_status = 'interrupted', error_kind = ?,
                 status_version = status_version + 1, finished_at = ?
             WHERE id = ? AND execution_status = ?`,
          )
          .run(
            resultText,
            previousStatus === "preparing" ? "input_preparation_interrupted" : "interrupted",
            timestamp,
            row.id,
            previousStatus,
          );
        if (result.changes !== 1) throw new Error("recovery status conflict");
        const job = this.requireJob(row.id);
        this.mergeTerminalDeliveries(job, timestamp);
        recovered.push({ job, previousStatus });
      }
      this.database
        .prepare(
          `UPDATE job_deliveries
           SET state = 'pending', lease_started_at = NULL, next_attempt_at = ?, updated_at = ?
           WHERE state = 'delivering'`,
        )
        .run(timestamp, timestamp);
      return recovered;
    })();
  }

  recoverDeliveryLeases(): number {
    const timestamp = now();
    const result = this.database
      .prepare(
        `UPDATE job_deliveries
         SET state = 'pending', lease_started_at = NULL, next_attempt_at = ?, updated_at = ?
         WHERE state = 'delivering'`,
      )
      .run(timestamp, timestamp);
    return result.changes;
  }

  claimDueDelivery(referenceTime = now()): JobDelivery | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT d.* FROM job_deliveries d
           JOIN jobs j ON j.id = d.job_id
           WHERE d.state = 'pending' AND d.next_attempt_at <= ?
             AND (
               d.kind <> 'final_reply'
               OR NOT EXISTS (
                 SELECT 1 FROM job_deliveries earlier
                 JOIN jobs earlier_job ON earlier_job.id = earlier.job_id
                 WHERE earlier.kind = 'final_reply'
                   AND earlier_job.topic_id = j.topic_id
                   AND (
                     earlier_job.id < j.id
                     OR (earlier_job.id = j.id AND earlier.sequence < d.sequence)
                   )
                   AND earlier.state NOT IN ('delivered', 'abandoned')
               )
             )
           ORDER BY
             CASE d.kind WHEN 'status' THEN 0 WHEN 'reaction' THEN 1 ELSE 2 END,
             d.next_attempt_at, d.job_id, d.sequence
           LIMIT 1`,
        )
        .get(referenceTime) as DeliveryRow | undefined;
      if (!row) return null;
      const leaseStartedAt = now();
      const claimed = this.database
        .prepare(
          `UPDATE job_deliveries
           SET state = 'delivering', lease_started_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(leaseStartedAt, leaseStartedAt, row.id);
      return claimed.changes === 1 ? this.getDeliveryById(row.id) : null;
    })();
  }

  nextPendingDeliveryAt(): string | null {
    const row = this.database
      .prepare(
        `SELECT MIN(d.next_attempt_at) AS next_attempt_at
         FROM job_deliveries d
         JOIN jobs j ON j.id = d.job_id
         WHERE d.state = 'pending'
           AND (
             d.kind <> 'final_reply'
             OR NOT EXISTS (
               SELECT 1 FROM job_deliveries earlier
               JOIN jobs earlier_job ON earlier_job.id = earlier.job_id
               WHERE earlier.kind = 'final_reply'
                 AND earlier_job.topic_id = j.topic_id
                 AND (
                   earlier_job.id < j.id
                   OR (earlier_job.id = j.id AND earlier.sequence < d.sequence)
                 )
                 AND earlier.state NOT IN ('delivered', 'abandoned')
             )
           )`,
      )
      .get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
  }

  recordDeliveryMessage(deliveryId: number, chatId: string, receipt: ReplyReceipt): boolean {
    return this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM job_deliveries WHERE id = ? AND state = 'delivering'")
        .get(deliveryId) as DeliveryRow | undefined;
      if (!row) return false;
      const job = this.requireJob(row.job_id);
      const timestamp = now();
      this.database
        .prepare("UPDATE job_deliveries SET message_id = ?, updated_at = ? WHERE id = ? AND state = 'delivering'")
        .run(receipt.messageId, timestamp, deliveryId);
      this.database
        .prepare(
          `INSERT INTO message_bindings(message_id, chat_id, topic_id, job_id, direction, created_at)
           VALUES (?, ?, ?, ?, 'outbound', ?)
           ON CONFLICT(message_id) DO UPDATE SET
             chat_id = excluded.chat_id,
             topic_id = excluded.topic_id,
             job_id = excluded.job_id,
             direction = 'outbound'`,
        )
        .run(receipt.messageId, chatId, job.topicId, job.id, timestamp);
      return true;
    })();
  }

  completeDelivery(deliveryId: number, sentVersion: number): boolean {
    return this.database.transaction(() => {
      const delivery = this.getDeliveryById(deliveryId);
      if (!delivery || delivery.state !== "delivering") return false;
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE job_deliveries
           SET delivered_version = MAX(delivered_version, ?),
               state = CASE WHEN desired_version <= ? THEN 'delivered' ELSE 'pending' END,
               payload_text = CASE
                 WHEN kind = 'final_reply' AND desired_version <= ? THEN NULL
                 ELSE payload_text
               END,
               next_attempt_at = ?, last_error_kind = NULL, lease_started_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'delivering'`,
        )
        .run(sentVersion, sentVersion, sentVersion, timestamp, timestamp, deliveryId);
      if (result.changes !== 1) return false;
      this.maybeClearResultText(delivery.jobId);
      return true;
    })();
  }

  failDelivery(deliveryId: number, safeErrorKind: string, nextAttemptAt: string, maximumAttempts?: number): DeliveryFailure {
    return this.database.transaction(() => {
      const delivery = this.getDeliveryById(deliveryId);
      if (!delivery || delivery.state !== "delivering") throw new Error("delivery lease is unavailable");
      const attempts = delivery.attempts + 1;
      const abandoned = maximumAttempts !== undefined && attempts >= maximumAttempts;
      const timestamp = now();
      const result = this.database
        .prepare(
          `UPDATE job_deliveries
           SET attempts = ?, state = ?, next_attempt_at = ?, last_error_kind = ?,
               payload_text = CASE WHEN ? AND kind = 'final_reply' THEN NULL ELSE payload_text END,
               lease_started_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'delivering'`,
        )
        .run(
          attempts,
          abandoned ? "abandoned" : "pending",
          nextAttemptAt,
          safeErrorKind,
          abandoned ? 1 : 0,
          timestamp,
          deliveryId,
        );
      if (result.changes !== 1) throw new Error("delivery failure status conflict");
      if (abandoned && delivery.kind === "final_reply") this.dirtyTerminalStatus(delivery.jobId, timestamp);
      this.maybeClearResultText(delivery.jobId);
      return { attempts, abandoned, jobId: delivery.jobId, kind: delivery.kind };
    })();
  }

  handlePermanentStatusFailure(deliveryId: number, safeErrorKind: string): { replaced: boolean; abandoned: boolean } {
    return this.database.transaction(() => {
      const delivery = this.getDeliveryById(deliveryId);
      if (!delivery || delivery.kind !== "status" || delivery.state !== "delivering") {
        throw new Error("status delivery lease is unavailable");
      }
      const job = this.requireJob(delivery.jobId);
      const timestamp = now();
      const replace = isTerminalStatus(job.executionStatus) && delivery.replacementCount === 0;
      const result = this.database
        .prepare(
          `UPDATE job_deliveries
           SET attempts = attempts + 1, state = ?, next_attempt_at = ?, stable_uuid = ?,
               message_id = ?, replacement_count = ?, last_error_kind = ?,
               lease_started_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'delivering'`,
        )
        .run(
          replace ? "pending" : "abandoned",
          timestamp,
          replace ? stableStatusUuid(job.id, 1) : delivery.stableUuid,
          replace ? null : delivery.messageId,
          replace ? 1 : delivery.replacementCount,
          safeErrorKind,
          timestamp,
          deliveryId,
        );
      if (result.changes !== 1) throw new Error("status replacement conflict");
      this.maybeClearResultText(job.id);
      return { replaced: replace, abandoned: !replace };
    })();
  }

  staleTopics(before: string): Topic[] {
    return (
      this.database.prepare("SELECT * FROM topics WHERE last_active_at < ? ORDER BY last_active_at").all(before) as TopicRow[]
    ).map(mapTopic);
  }

  private requireJob(id: number): Job {
    const job = this.getJob(id);
    if (!job) throw new Error("job not found");
    return job;
  }

  private mergeDelivery(
    jobId: number,
    kind: DeliveryKind,
    desiredVersion: number,
    stableUuid: string | null,
    timestamp: string,
    sequence = 0,
    payloadText: string | null = null,
  ): void {
    this.database
      .prepare(
        `INSERT INTO job_deliveries(
           job_id, kind, sequence, payload_text, state, desired_version, delivered_version, attempts,
           next_attempt_at, stable_uuid, message_id, replacement_count,
           last_error_kind, lease_started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?, NULL, 0, NULL, NULL, ?, ?)
         ON CONFLICT(job_id, kind, sequence) DO UPDATE SET
           state = CASE
             WHEN job_deliveries.state = 'delivering' THEN 'delivering'
             WHEN excluded.desired_version > job_deliveries.delivered_version THEN 'pending'
             ELSE job_deliveries.state
           END,
           desired_version = MAX(job_deliveries.desired_version, excluded.desired_version),
           attempts = CASE
             WHEN excluded.desired_version > job_deliveries.desired_version THEN 0
             ELSE job_deliveries.attempts
           END,
           next_attempt_at = CASE
             WHEN job_deliveries.state = 'delivering' THEN job_deliveries.next_attempt_at
             ELSE excluded.next_attempt_at
           END,
           stable_uuid = COALESCE(job_deliveries.stable_uuid, excluded.stable_uuid),
           payload_text = COALESCE(job_deliveries.payload_text, excluded.payload_text),
           updated_at = excluded.updated_at`,
      )
      .run(jobId, kind, sequence, payloadText, desiredVersion, timestamp, stableUuid, timestamp, timestamp);
  }

  private mergeStatusAndReaction(job: Job, timestamp: string): void {
    this.mergeDelivery(job.id, "status", job.statusVersion, stableStatusUuid(job.id), timestamp);
    this.mergeDelivery(job.id, "reaction", job.statusVersion, null, timestamp);
  }

  private mergeTerminalDeliveries(job: Job, timestamp: string): void {
    if (!isTerminalStatus(job.executionStatus)) throw new Error("terminal delivery requested for active job");
    if (!job.resultText) throw new Error("terminal job has no final reply payload");
    this.mergeStatusAndReaction(job, timestamp);
    this.dirtyQueuedTopic(job, timestamp);
    for (const [sequence, payload] of splitFinalReply(job.resultText).entries()) {
      this.mergeDelivery(
        job.id,
        "final_reply",
        job.statusVersion,
        stableFinalReplyUuid(job.id, job.executionStatus, sequence),
        timestamp,
        sequence,
        payload,
      );
    }
  }

  private dirtyQueuedTopic(changedJob: Job, timestamp: string): void {
    const rows = this.database
      .prepare("SELECT id FROM jobs WHERE execution_status = 'queued' AND topic_id = ? AND id != ? ORDER BY id")
      .all(changedJob.topicId, changedJob.id) as Array<{ id: number }>;
    for (const row of rows) {
      this.database.prepare("UPDATE jobs SET status_version = status_version + 1 WHERE id = ?").run(row.id);
      const job = this.requireJob(row.id);
      this.mergeDelivery(job.id, "status", job.statusVersion, stableStatusUuid(job.id), timestamp);
    }
  }

  private dirtyTerminalStatus(jobId: number, timestamp: string): void {
    const result = this.database
      .prepare(
        `UPDATE jobs SET status_version = status_version + 1
         WHERE id = ? AND execution_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')`,
      )
      .run(jobId);
    if (result.changes !== 1) return;
    const job = this.requireJob(jobId);
    this.mergeDelivery(job.id, "status", job.statusVersion, stableStatusUuid(job.id), timestamp);
  }

  private maybeClearResultText(jobId: number): void {
    this.database
      .prepare(
        `UPDATE jobs SET result_text = NULL, progress_json = NULL
         WHERE id = ?
           AND execution_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')
           AND EXISTS (
             SELECT 1 FROM job_deliveries status_delivery
             WHERE status_delivery.job_id = jobs.id AND status_delivery.kind = 'status'
               AND status_delivery.state IN ('delivered', 'abandoned')
           )
           AND EXISTS (
             SELECT 1 FROM job_deliveries final_delivery
             WHERE final_delivery.job_id = jobs.id AND final_delivery.kind = 'final_reply'
           )
           AND NOT EXISTS (
             SELECT 1 FROM job_deliveries final_delivery
             WHERE final_delivery.job_id = jobs.id AND final_delivery.kind = 'final_reply'
               AND final_delivery.state NOT IN ('delivered', 'abandoned')
           )`,
      )
      .run(jobId);
  }

  private bindAgentBackend(backend: AgentBackend): void {
    this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT value FROM service_metadata WHERE key = 'agent_backend'")
        .get() as { value: string } | undefined;
      if (!row) {
        this.database.prepare("INSERT INTO service_metadata(key, value) VALUES ('agent_backend', ?)").run(backend);
        return;
      }
      if (row.value !== backend) throw new Error("State database belongs to a different agent backend");
    })();
  }
}
