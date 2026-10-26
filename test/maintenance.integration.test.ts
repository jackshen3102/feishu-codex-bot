import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { HealthReporter, healthStatusPath, readHealthStatus } from "../src/health.js";
import { removeTemp, tempConfig } from "./helpers.js";

function seed(store: Store, messageId: string) {
  return store.acceptJob({
    messageId,
    chatId: "target-chat",
    requesterOpenId: "user-1",
    allowNewTopic: true,
    existingTopicInput: "private input that must not enter health status",
    newTopicInput: "private input that must not enter health status",
  }).job!;
}

function finishAndSettle(store: Store, jobId: number): void {
  expect(store.claimRunnableJobs(1).map((item) => item.id)).toContain(jobId);
  expect(store.completeExecution(jobId, { status: "succeeded", reply: "private result" }, null).kind).toBe("completed");
  let delivery = store.claimDueDelivery();
  while (delivery) {
    expect(store.completeDelivery(delivery.id, delivery.desiredVersion)).toBe(true);
    delivery = store.claimDueDelivery();
  }
}

describe("bounded operational state", () => {
  it("prunes only settled terminal jobs while preserving routing and inbound idempotency", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const settled = seed(store, "settled-message");
      finishAndSettle(store, settled.id);
      store.database.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", settled.id);

      const pending = seed(store, "pending-message");
      expect(store.claimRunnableJobs(1).map((item) => item.id)).toContain(pending.id);
      expect(store.completeExecution(pending.id, { status: "succeeded", reply: "pending result" }, null).kind).toBe("completed");
      store.database.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", pending.id);

      expect(store.pruneTerminalJobs("2021-01-01T00:00:00.000Z")).toBe(1);
      expect(store.getJob(settled.id)).toBeNull();
      expect(store.getJob(pending.id)).not.toBeNull();
      expect(store.findBoundTopic("target-chat", "settled-message")?.id).toBe(settled.topicId);
      expect(store.acceptJob({
        messageId: "settled-message",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        allowNewTopic: true,
        existingTopicInput: "duplicate",
        newTopicInput: "duplicate",
      })).toMatchObject({ accepted: false, duplicate: true });
      expect(store.count("message_bindings")).toBeGreaterThanOrEqual(2);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("writes a strict content-free health snapshot and detects stale or unsafe files", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const statusPath = healthStatusPath(config.STATE_DB_PATH);
    try {
      seed(store, "secret-message-id");
      const reporter = new HealthReporter(store, statusPath);
      reporter.markIngress("2026-09-03T00:00:00.000Z");
      await reporter.publish("running");
      const status = await readHealthStatus(statusPath);
      expect(status).toMatchObject({
        version: 1,
        service: { state: "running", lastIngressAt: "2026-09-03T00:00:00.000Z" },
        schemaVersion: 13,
        backend: "codex",
        lastExecution: null,
        jobs: { queued: 1 },
      });
      expect(status.databaseBytes).toBeGreaterThan(0);
      expect((await fs.stat(statusPath)).mode & 0o077).toBe(0);
      const serialized = await fs.readFile(statusPath, "utf8");
      expect(serialized).not.toContain("secret-message-id");
      expect(serialized).not.toContain("private input");
      expect(serialized).not.toContain(config.FEISHU_APP_SECRET);
      expect((await readHealthStatus(statusPath, Date.parse(status.sampledAt) + 100_000)).sampleStatus).toBe("stale");

      const symlink = path.join(root, "health-link.json");
      await fs.symlink(statusPath, symlink);
      await expect(readHealthStatus(symlink)).rejects.toThrow(/unsafe/);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("exposes the latest execution failure across reporter restarts and replaces it after success", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const statusPath = healthStatusPath(config.STATE_DB_PATH);
    try {
      const failed = seed(store, "auth-failure");
      store.claimRunnableJobs(1);
      store.completeExecution(failed.id, { status: "failed", reply: "private result" }, "AgentAuthenticationError");
      await new HealthReporter(store, statusPath).publish("running");
      expect((await readHealthStatus(statusPath)).lastExecution).toEqual({
        jobId: failed.id,
        status: "failed",
        errorKind: "AgentAuthenticationError",
        finishedAt: store.getJob(failed.id)!.finishedAt,
      });
      expect(await fs.readFile(statusPath, "utf8")).not.toContain("private result");

      const reporter = new HealthReporter(store, statusPath);
      await reporter.publish("running");
      expect((await readHealthStatus(statusPath)).lastExecution?.errorKind).toBe("AgentAuthenticationError");
      const recovered = seed(store, "recovered");
      finishAndSettle(store, recovered.id);
      await reporter.publish();
      expect((await readHealthStatus(statusPath)).lastExecution).toMatchObject({
        jobId: recovered.id,
        status: "succeeded",
        errorKind: null,
      });

      const legacy = JSON.parse(await fs.readFile(statusPath, "utf8"));
      delete legacy.lastExecution;
      await fs.writeFile(statusPath, JSON.stringify(legacy));
      expect((await readHealthStatus(statusPath)).lastExecution).toBeUndefined();
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});
