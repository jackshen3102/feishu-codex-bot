import { describe, expect, it } from "vitest";
import { CancellationController } from "../src/control/cancellation.js";
import { Store } from "../src/db/store.js";
import { FakeDelivery, FakeRunner, removeTemp, tempConfig, waitUntil } from "./helpers.js";

function seed(store: Store, messageId: string, input: string | null = "input", requesterOpenId = "user-1") {
  return store.acceptJob({
    messageId,
    chatId: "target-chat",
    requesterOpenId,
    allowNewTopic: true,
    existingTopicInput: input,
    newTopicInput: input,
  });
}

describe("precise job cancellation", () => {
  it("cancels preparing and queued jobs without starting or aborting the runner", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const runner = new FakeRunner();
    const controller = new CancellationController(store, runner, delivery);
    try {
      const preparing = seed(store, "preparing", null).job!;
      const queued = seed(store, "queued").job!;
      expect(await controller.handle({
        messageId: "cancel-preparing",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "preparing",
        text: "取消",
      })).toBe(true);
      expect(await controller.handle({
        messageId: "cancel-queued",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "queued",
        text: "取消",
      })).toBe(true);
      expect(store.getJob(preparing.id)?.executionStatus).toBe("cancelled");
      expect(store.getJob(queued.id)?.executionStatus).toBe("cancelled");
      expect(runner.calls).toEqual([]);
      expect(runner.abortCalls).toEqual([]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("aborts only the explicitly referenced running job", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const runner = new FakeRunner();
    runner.block = true;
    const controller = new CancellationController(store, runner, delivery);
    try {
      const first = seed(store, "first");
      const second = seed(store, "second");
      const [firstJob, secondJob] = store.claimRunnableJobs(2);
      const firstRun = runner.run(firstJob!, first.topic!);
      const secondRun = runner.run(secondJob!, second.topic!);
      await waitUntil(() => runner.concurrent === 2);

      await controller.handle({
        messageId: "cancel-first",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "first",
        text: "取消",
      });
      expect(store.getJob(first.job!.id)?.executionStatus).toBe("cancel_requested");
      expect(store.getJob(second.job!.id)?.executionStatus).toBe("running");
      expect(runner.abortCalls).toEqual([first.job!.id]);
      await firstRun;
      store.confirmCancellation(first.job!.id);
      expect(store.getJob(first.job!.id)?.executionStatus).toBe("cancelled");
      expect(runner.concurrent).toBe(1);
      runner.gates[1]!.resolve();
      await secondRun;
    } finally {
      runner.abortAll();
      store.close();
      await removeTemp(root);
    }
  });

  it("rejects ambiguous, unauthorized, repeated, and terminal cancellation idempotently", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const runner = new FakeRunner();
    const controller = new CancellationController(store, runner, delivery);
    try {
      const running = seed(store, "running").job!;
      store.claimRunnableJobs(1);
      expect(await controller.handle({
        messageId: "no-reference",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        text: "取消",
      })).toBe(true);
      await controller.handle({
        messageId: "unauthorized",
        chatId: "target-chat",
        requesterOpenId: "user-2",
        referencedMessageId: "running",
        text: "取消",
      });
      expect(store.getJob(running.id)?.executionStatus).toBe("running");

      await controller.handle({
        messageId: "first-request",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "running",
        text: "取消",
      });
      await controller.handle({
        messageId: "second-request",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "running",
        text: "取消",
      });
      expect(store.getJob(running.id)?.executionStatus).toBe("cancel_requested");
      expect(runner.abortCalls).toEqual([]);
      store.confirmCancellation(running.id);
      await controller.handle({
        messageId: "terminal-request",
        chatId: "target-chat",
        requesterOpenId: "user-1",
        referencedMessageId: "running",
        text: "取消",
      });
      expect(store.getJob(running.id)?.executionStatus).toBe("cancelled");
      expect(delivery.visibleReplies.map((reply) => reply.text)).toEqual([
        "请回复要取消的任务消息，并发送“取消”。",
        "你只能取消自己发起的任务。",
        "正在取消任务。",
        "任务正在取消，请稍候。",
        "任务已经结束，无法取消。",
      ]);
    } finally {
      store.close();
      await removeTemp(root);
    }
  });

  it("allows only one terminal outcome when completion races cancellation", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    try {
      const completedFirst = seed(store, "completed-first").job!;
      store.claimRunnableJobs(1);
      expect(store.completeExecution(completedFirst.id, { status: "succeeded", reply: "done" }, null).kind).toBe("completed");
      expect(store.requestCancellation(completedFirst.id, "user-1").kind).toBe("already_terminal");
      expect(store.listDeliveries(completedFirst.id).filter((delivery) => delivery.kind === "final_reply")).toHaveLength(1);

      const cancelledFirst = seed(store, "cancelled-first").job!;
      store.claimRunnableJobs(1);
      expect(store.requestCancellation(cancelledFirst.id, "user-1").kind).toBe("abort_required");
      expect(store.completeExecution(cancelledFirst.id, { status: "succeeded", reply: "late" }, null).kind).toBe("cancel_requested");
      store.confirmCancellation(cancelledFirst.id);
      expect(store.getJob(cancelledFirst.id)?.executionStatus).toBe("cancelled");
      expect(store.completeExecution(cancelledFirst.id, { status: "succeeded", reply: "later" }, null).kind).toBe("already_terminal");
    } finally {
      store.close();
      await removeTemp(root);
    }
  });
});
