import path from "node:path";
import type { Codex } from "@openai/codex-sdk";
import { CodexRunner } from "../src/codex/runner.js";
import { CaseStore } from "../src/oncall/case-store.js";
import { describe, expect, it, vi } from "vitest";
import { AgentAuthenticationError } from "../src/agent/runner.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { Store } from "../src/db/store.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { INTERRUPTED_RESULT_TEXT, renderJobStatus } from "../src/jobs/status-view.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { deferred, FakeDelivery, FakeRunner, primaryCardText, removeTemp, tempConfig, waitUntil } from "./helpers.js";

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
  it("shows structured Codex progress on the original card before completion, then replaces it with the final answer", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const delivery = new FakeDelivery();
    const outbox = new OutboxWorker(store, delivery, { idlePollMs: 1 });
    const continueWork = deferred();
    const finishTurn = deferred();
    const finalSeen = deferred();
    const codex = { startThread: () => ({ runStreamed: async () => ({ events: (async function* () {
      yield { type: "item.completed", item: { id: "progress", type: "agent_message", text: JSON.stringify({ status: "succeeded", reply: "已找到失败记录，正在核对原因", caseSummary: null }) } };
      yield { type: "item.started", item: { id: "tool", type: "command_execution", command: "private command" } };
      await continueWork.promise;
      yield { type: "item.completed", item: { id: "tool", type: "command_execution", aggregated_output: "private tool output" } };
      yield { type: "item.completed", item: { id: "final", type: "agent_message", text: JSON.stringify({ status: "succeeded", reply: "最终结论与证据", caseSummary: null }) } };
      finalSeen.resolve();
      await finishTurn.promise;
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    })() }) }) } as unknown as Codex;
    const runner = new CodexRunner({ timeoutMs: 0, codex, oncall: true });
    const scheduler = new Scheduler(config, store, runner, workspaces, () => outbox.wake());
    try {
      const accepted = enqueue(store, "structured-progress");
      outbox.start();
      await waitUntil(() => store.getDelivery(accepted.job!.id, "status")?.state === "delivered");
      const originalCard = delivery.visibleCards[0]!.messageId;
      await scheduler.start();
      await waitUntil(() => delivery.visibleCards[0]!.cardJson.includes("已找到失败记录"));
      expect(store.getJob(accepted.job!.id)?.executionStatus).toBe("running");
      expect(delivery.visibleCards[0]!.cardJson).not.toContain("caseSummary");
      expect(delivery.visibleCards[0]!.cardJson).not.toContain("private command");
      expect(delivery.visibleReplies).toHaveLength(0);
      continueWork.resolve();
      await finalSeen.promise;
      expect(store.getJob(accepted.job!.id)?.progress?.recent.map((item) => item.title)).toEqual(["已找到失败记录，正在核对原因"]);
      expect(delivery.visibleCards[0]!.cardJson).not.toContain("最终结论与证据");
      finishTurn.resolve();
      await scheduler.waitForIdle();
      await waitUntil(() => store.getDelivery(accepted.job!.id, "final_reply")?.state === "delivered");
      expect(delivery.visibleCards).toHaveLength(1);
      expect(delivery.visibleCards[0]!.messageId).toBe(originalCard);
      expect(primaryCardText(delivery.visibleCards[0]!.cardJson)).toBe("最终结论与证据");
      expect(delivery.visibleCards[0]!.cardJson).not.toContain("已找到失败记录");
      expect(delivery.visibleReplies).toHaveLength(0);
    } finally {
      continueWork.resolve();
      finishTurn.resolve();
      scheduler.stop();
      await scheduler.waitForIdle();
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

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

  it("limits six independent topics to five concurrent turns and then claims the sixth", async () => {
    const { config, root } = await tempConfig({ MAX_CONCURRENT_TURNS: 5 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    const scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      for (let index = 1; index <= 6; index += 1) enqueue(store, `topic-${index}`);
      await scheduler.start();
      await waitUntil(() => runner.calls.length === 5);
      expect(runner.peakConcurrent).toBe(5);
      expect(store.getAllJobs().filter((job) => job.executionStatus === "queued")).toHaveLength(1);
      runner.gates[0]!.resolve();
      await waitUntil(() => runner.calls.length === 6);
      expect(runner.peakConcurrent).toBe(5);
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

describe("Oncall execution and shared cases", () => {
  it("keeps a real Codex runner active past fifteen minutes when timeout is disabled", async () => {
    const { config, root } = await tempConfig({ TURN_TIMEOUT_MS: 0 });
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const codex = { startThread: () => ({ runStreamed: async (_input: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return { events: (async function* () {
        await gate.promise;
        yield { type: "item.completed", item: { id: "final", type: "agent_message", text: '{"status":"succeeded","reply":"finished"}' } };
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      })() };
    } }) } as unknown as Codex;
    const runner = new CodexRunner({ timeoutMs: config.TURN_TIMEOUT_MS, codex });
    try {
      const accepted = enqueue(store, "long-codex");
      const [job] = store.claimRunnableJobs(1);
      vi.useFakeTimers();
      const result = runner.run(job!, accepted.topic!);
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      expect(signal?.aborted).toBe(false);
      gate.resolve();
      expect(await result).toEqual({ status: "succeeded", reply: "finished" });
    } finally {
      gate.resolve();
      runner.abortAll();
      vi.useRealTimers();
      store.close();
      await removeTemp(root);
    }
  });

  it("shares verified and unverified case evidence by workspace and replaces corrected conclusions without duplicating history", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const cases = new CaseStore(store.database);
    try {
      const first = enqueue(store, "private-case");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'private-chat', 'private-case', 'user-1')`).run(first.topic!.id);
      const hypothesis = { summary: "SNAPSHOT_NOT_READY investigation", conclusions: [
        { text: "Snapshot unavailable in this execution", verification: "observed" as const },
        { text: "Possible environment issue", verification: "unverified" as const },
      ], evidence: ["message:private-case", "artifact:execution-log"] };
      store.claimRunnableJobs(1);
      expect(store.completeExecution(first.job!.id, { status: "succeeded", reply: "initial analysis", caseSummary: hypothesis }, null).kind).toBe("completed");
      expect(store.getDelivery(first.job!.id, "final_reply")?.state).toBe("pending");
      expect(cases.search("infra", "SNAPSHOT_NOT_READY")).toMatchObject([{ conclusions: hypothesis.conclusions }]);
      expect(cases.search("another-business", "SNAPSHOT_NOT_READY")).toEqual([]);
      const second = enqueue(store, "correction", "private-case");
      const correction = { summary: "SNAPSHOT_NOT_READY corrected finding", conclusions: [
        { text: "Snapshot provisioning failed in the recorded run", verification: "verified" as const },
      ], evidence: ["message:correction", "artifact:provisioning-log"] };
      store.claimRunnableJobs(1);
      store.completeExecution(second.job!.id, { status: "succeeded", reply: "corrected", caseSummary: correction }, null);
      expect(store.completeExecution(second.job!.id, { status: "succeeded", reply: "corrected", caseSummary: correction }, null).kind).toBe("already_terminal");
      expect(cases.search("infra", "SNAPSHOT_NOT_READY")).toMatchObject([{ conclusions: correction.conclusions, evidence: correction.evidence }]);
      expect(cases.search("infra", "SNAPSHOT_NOT_READY", first.topic!.id)).toEqual([]);
      expect(store.database.prepare("SELECT count(*) AS count FROM oncall_cases").get()).toEqual({ count: 1 });
      expect(store.database.prepare("SELECT count(*) AS count FROM oncall_case_history").get()).toEqual({ count: 2 });
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});

describe("Oncall shutdown and resume regression coverage", () => {
  it("keeps a gracefully interrupted topic paused after scheduler and database restart", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
    await workspaces.initialize();
    const runner = new FakeRunner();
    runner.block = true;
    let scheduler = new Scheduler(config, store, runner, workspaces);
    try {
      const first = enqueue(store, "shutdown-root");
      const queued = enqueue(store, "shutdown-follow-up", "shutdown-root");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'shutdown-root', 'user-1')`).run(first.topic!.id);
      await scheduler.start();
      await waitUntil(() => runner.calls.length === 1);
      scheduler.stop();
      await scheduler.waitForIdle();
      expect(store.getJob(first.job!.id)?.executionStatus).toBe("interrupted");
      expect(store.getJob(queued.job!.id)?.executionStatus).toBe("queued");
      store.close();
      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.recoverUncertainExecutions()).toEqual([]);
      expect(store.database.prepare("SELECT paused FROM oncall_topics WHERE topic_id = ?").get(first.topic!.id)).toEqual({ paused: 1 });
      const restartedRunner = new FakeRunner();
      scheduler = new Scheduler(config, store, restartedRunner, workspaces);
      await scheduler.start();
      await scheduler.waitForIdle();
      expect(restartedRunner.calls).toEqual([]);
      expect(store.getJob(queued.job!.id)?.executionStatus).toBe("queued");
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      if (store.database.open) store.close();
      await removeTemp(root);
    }
  });

  it("keeps a later completed queued correction after a newer resume job and ignores duplicate old case writes", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const cases = new CaseStore(store.database);
    try {
      const first = enqueue(store, "case-root");
      const correction = enqueue(store, "case-queued-correction", "case-root");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'case-root', 'user-1')`).run(first.topic!.id);
      store.claimRunnableJobs(1);
      store.interruptExecution(first.job!.id, "interrupted");
      const resumed = enqueue(store, "case-resume", "case-root");
      store.database.prepare("UPDATE oncall_topics SET paused = 0, resume_job_id = ? WHERE topic_id = ?")
        .run(resumed.job!.id, first.topic!.id);
      const resumeCase = { summary: "SNAPSHOT_NOT_READY recovery hypothesis", conclusions: [
        { text: "Possible environment issue", verification: "unverified" as const },
      ], evidence: ["message:case-resume"] };
      expect(store.claimRunnableJobs(1)[0]?.id).toBe(resumed.job!.id);
      store.completeExecution(resumed.job!.id, { status: "succeeded", reply: "recovery review", caseSummary: resumeCase }, null);
      expect(store.claimRunnableJobs(1)[0]?.id).toBe(correction.job!.id);
      const correctedCase = { summary: "SNAPSHOT_NOT_READY corrected after recovery", conclusions: [
        { text: "Provisioning failure verified by subsequent evidence", verification: "verified" as const },
      ], evidence: ["message:case-queued-correction"] };
      store.completeExecution(correction.job!.id, { status: "succeeded", reply: "corrected", caseSummary: correctedCase }, null);
      expect(cases.search("infra", "SNAPSHOT_NOT_READY")).toMatchObject([{ summary: correctedCase.summary, conclusions: correctedCase.conclusions }]);
      cases.save(first.topic!.id, resumed.job!.id, { ...resumeCase, summary: "duplicate old case must not replace current" });
      expect(cases.search("infra", "SNAPSHOT_NOT_READY")).toMatchObject([{ summary: correctedCase.summary, conclusions: correctedCase.conclusions }]);
      expect(store.database.prepare("SELECT count(*) AS count FROM oncall_case_history").get()).toEqual({ count: 2 });
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});

describe("Oncall failures preserve conclusions and publish pause state", () => {
  it("preserves a structured verified case when later turns return ordinary success or failure replies", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const cases = new CaseStore(store.database);
    try {
      const first = enqueue(store, "structured-root");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'structured-root', 'user-1')`).run(first.topic!.id);
      const original = { summary: "SNAPSHOT_NOT_READY verified case", conclusions: [
        { text: "Verified by original evidence", verification: "verified" as const },
      ], evidence: ["message:structured-root", "artifact:verified-log"] };
      store.claimRunnableJobs(1);
      store.completeExecution(first.job!.id, { status: "succeeded", reply: "analysis", caseSummary: original }, null);
      for (const status of ["succeeded", "failed"] as const) {
        const next = enqueue(store, `ordinary-${status}`, "structured-root");
        expect(store.claimRunnableJobs(1)[0]?.id).toBe(next.job!.id);
        store.completeExecution(next.job!.id, { status, reply: status === "succeeded" ? "Acknowledged" : "Tool login failed" }, status === "failed" ? "AgentAuthenticationError" : null);
        expect(cases.search("infra", "SNAPSHOT_NOT_READY")).toMatchObject([original]);
        expect(store.database.prepare("SELECT count(*) AS count FROM oncall_case_history").get()).toEqual({ count: 1 });
      }
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it.each(["failed", "interrupted"] as const)("publishes a durable paused status for queued requests after an active turn is %s", async (outcome) => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const active = enqueue(store, "pause-status-root");
      const queued = enqueue(store, "pause-status-queued", "pause-status-root");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'pause-status-root', 'user-1')`).run(active.topic!.id);
      store.claimRunnableJobs(1);
      const previousVersion = store.getJob(queued.job!.id)!.statusVersion;
      store.database.prepare("UPDATE job_deliveries SET state = 'delivered', delivered_version = desired_version WHERE job_id = ? AND kind = 'status'").run(queued.job!.id);
      if (outcome === "failed") store.completeExecution(active.job!.id, { status: "failed", reply: "tool error" }, "agent_failed");
      else store.interruptExecution(active.job!.id, "uncertain interruption");
      const changed = store.getJob(queued.job!.id)!;
      expect(changed.statusVersion).toBeGreaterThan(previousVersion);
      expect(changed.executionStatus).toBe("queued");
      expect(store.getDelivery(changed.id, "status")).toMatchObject({ state: "pending", desiredVersion: changed.statusVersion });
      expect(store.getQueueWaitReason(changed.id)).toBe("paused");
      expect(renderJobStatus(changed, { queueWaitReason: "paused" })).toContain("继续");
      expect(store.getJob(active.job!.id)?.resultText).toContain("继续");
      expect(store.getDelivery(active.job!.id, "final_reply")?.payloadText).toContain("继续");
      expect(store.claimRunnableJobs(5)).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});
