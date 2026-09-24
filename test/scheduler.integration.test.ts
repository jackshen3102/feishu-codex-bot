import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentAuthenticationError } from "../src/agent/runner.js";
import { Store } from "../src/db/store.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { INTERRUPTED_RESULT_TEXT } from "../src/jobs/status-view.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { FakeRunner, removeTemp, tempConfig, waitUntil } from "./helpers.js";

function enqueue(store: Store, messageId: string, parentId?: string) {
  return store.acceptJob({
    messageId,
    chatId: "target-chat",
    requesterOpenId: "user-1",
    parentId,
    allowNewTopic: !parentId,
    existingTopicInput: JSON.stringify({ text: messageId }),
    newTopicInput: JSON.stringify({ text: messageId }),
  });
}

describe("durable scheduler", () => {
  it("runs one turn per topic in persistent job ID order without steering", async () => {
    const { config, root } = await tempConfig({ MAX_CONCURRENT_TURNS: 4 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      enqueue(store, "one");
      await scheduler.start();
      await waitUntil(() => runner.calls.length === 1);
      enqueue(store, "two", "one");
      enqueue(store, "three", "one");
      scheduler.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runner.calls).toHaveLength(1);
      expect(store.getAllJobs().map((job) => job.executionStatus)).toEqual(["running", "queued", "queued"]);

      runner.gates[0]!.resolve();
      await waitUntil(() => runner.calls.length === 2);
      runner.gates[1]!.resolve();
      await waitUntil(() => runner.calls.length === 3);
      runner.gates[2]!.resolve();
      await scheduler.waitForIdle();
      expect(runner.calls.map((call) => call.job.feishuMessageId)).toEqual(["one", "two", "three"]);
      expect(runner.peakConcurrent).toBe(1);
    } finally {
      for (const gate of runner.gates) gate.resolve();
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("limits five independent topics to four concurrent turns and then claims the fifth", async () => {
    const { config, root } = await tempConfig({ MAX_CONCURRENT_TURNS: 4 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      for (let index = 1; index <= 5; index += 1) enqueue(store, `topic-${index}`);
      await scheduler.start();
      await waitUntil(() => runner.calls.length === 4);
      expect(runner.peakConcurrent).toBe(4);
      expect(store.getAllJobs().filter((job) => job.executionStatus === "queued")).toHaveLength(1);
      runner.gates[0]!.resolve();
      await waitUntil(() => runner.calls.length === 5);
      expect(runner.peakConcurrent).toBe(4);
      for (const gate of runner.gates) gate.resolve();
      await scheduler.waitForIdle();
      expect(store.getAllJobs().every((job) => job.executionStatus === "succeeded")).toBe(true);
    } finally {
      for (const gate of runner.gates) gate.resolve();
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("marks the status projection dirty for long-running work without calling Feishu", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    let notifications = 0;
    const scheduler = new Scheduler(config, store, runner, workspaces, () => {
      notifications += 1;
    }, { firstDelayMs: 20, intervalMs: 30 });
    try {
      const accepted = enqueue(store, "long-running");
      await scheduler.start();
      await waitUntil(() => (store.getJob(accepted.job!.id)?.statusVersion ?? 0) >= 3);
      const job = store.getJob(accepted.job!.id)!;
      expect(job.executionStatus).toBe("running");
      expect(store.getDelivery(job.id, "status")?.desiredVersion).toBe(job.statusVersion);
      expect(notifications).toBeGreaterThan(1);
      runner.gates[0]!.resolve();
      await scheduler.waitForIdle();
    } finally {
      for (const gate of runner.gates) gate.resolve();
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("coalesces a large event stream into two bounded durable progress snapshots", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.progressEvents = Array.from({ length: 1_000 }, (_, index) => ({
      id: `tool-${index}`,
      kind: "message" as const,
      state: "completed" as const,
      title: `完成工具 ${index}`,
      detail: "x".repeat(5_000),
    }));
    const scheduler = new Scheduler(config, store, runner, workspaces, undefined, {
      firstDelayMs: 60_000,
      intervalMs: 300_000,
      eventIntervalMs: 60_000,
    });
    try {
      const accepted = enqueue(store, "many-events");
      await scheduler.start();
      await scheduler.waitForIdle();
      const job = store.getJob(accepted.job!.id)!;
      expect(job.executionStatus).toBe("succeeded");
      expect(job.progress).toMatchObject({ completedCount: 1_000, failedCount: 0 });
      expect(job.progress?.active).toEqual([]);
      expect(job.progress?.recent).toHaveLength(6);
      expect(job.progress?.recent[0]?.id).toBe("tool-999");
      expect(job.statusVersion).toBe(5);
      expect(Buffer.byteLength(JSON.stringify(job.progress), "utf8")).toBeLessThan(20 * 1024);
    } finally {
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("drops progress containing configured credentials instead of inventing replacement content", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.progressEvents = [{
      id: "command",
      kind: "message",
      state: "running",
      title: "执行命令",
      detail: `Authorization: ${config.FEISHU_APP_SECRET}`,
    }];
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      const accepted = enqueue(store, "protected-progress");
      await scheduler.start();
      await scheduler.waitForIdle();
      const progress = store.getJob(accepted.job!.id)?.progress;
      expect(progress).toBeNull();
      expect(JSON.stringify(progress)).not.toContain(config.FEISHU_APP_SECRET);
    } finally {
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("commits agent failure and all terminal delivery intents atomically", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.result = { status: "failed", reply: "short failure" };
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      enqueue(store, "failure");
      await scheduler.start();
      await scheduler.waitForIdle();
      const job = store.getAllJobs()[0]!;
      expect(job).toMatchObject({
        executionStatus: "failed",
        inputText: null,
        resultText: "short failure",
        errorKind: "agent_failed",
      });
      expect(store.listDeliveries(job.id).map((delivery) => delivery.kind).sort()).toEqual([
        "final_reply",
        "reaction",
        "status",
      ]);
      expect(store.listDeliveries(job.id).every((delivery) => delivery.state === "pending")).toBe(true);
    } finally {
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("persists an actionable reply for expired agent credentials", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.failure = new AgentAuthenticationError();
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      enqueue(store, "expired-agent-auth");
      await scheduler.start();
      await scheduler.waitForIdle();
      expect(store.getAllJobs()[0]).toMatchObject({
        executionStatus: "failed",
        errorKind: "AgentAuthenticationError",
        resultText: "Agent 未登录或登录已失效，请联系管理员为 Bot 服务账号重新登录并通过调用检查后，再重试任务。",
      });
    } finally {
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("stops after active work settles while leaving queued work for restart", async () => {
    const { config, root } = await tempConfig({ MAX_CONCURRENT_TURNS: 2 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      enqueue(store, "active");
      enqueue(store, "queued", "active");
      await scheduler.start();
      await waitUntil(() => runner.calls.length === 1);
      scheduler.stop();
      await scheduler.waitForIdle();
      expect(store.getAllJobs().map((job) => job.executionStatus)).toEqual(["interrupted", "queued"]);
      expect(store.getAllJobs()[0]?.resultText).toBe(INTERRUPTED_RESULT_TEXT);
      expect(store.getAllJobs()[0]?.resultText).not.toContain("请回复重试");
    } finally {
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("does not expose runner secrets or configured credentials", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    const sensitivePath = path.join(root, "private", "file.ts");
    runner.failure = new Error(`UNIQUE-TEST-SECRET at ${sensitivePath}:42`);
    runner.failure.name = "UNIQUE-TEST-SECRET";
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      enqueue(store, "secret-failure");
      await scheduler.start();
      await scheduler.waitForIdle();
      expect(store.getAllJobs()[0]!.resultText).toBe("任务失败，请回复重试。");
      expect(logs.join("\n")).not.toContain("UNIQUE-TEST-SECRET");
      expect(logs.join("\n")).not.toContain(sensitivePath);

      const protectedRunner = new FakeRunner();
      protectedRunner.result = { status: "succeeded", reply: `unsafe ${config.FEISHU_APP_SECRET}` };
      const protectedScheduler = new Scheduler(config, store, protectedRunner, workspaces);
      enqueue(store, "protected-output");
      await protectedScheduler.start();
      await protectedScheduler.waitForIdle();
      expect(store.getAllJobs()[1]).toMatchObject({ executionStatus: "failed", resultText: "任务失败，请回复重试。" });
      expect(JSON.stringify(store.getAllJobs())).not.toContain(config.FEISHU_APP_SECRET);
      protectedScheduler.stop();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      scheduler.stop();
      store.close();
      await removeTemp(root);
    }
  });
});
