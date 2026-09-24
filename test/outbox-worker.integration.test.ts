import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { PermanentStatusMessageError } from "../src/feishu/messages.js";
import { FINAL_REPLY_CHUNK_BYTES } from "../src/jobs/final-reply.js";
import { deferred, FakeDelivery, primaryCardText, removeTemp, tempConfig, waitUntil } from "./helpers.js";

function seed(store: Store, messageId: string, parentId?: string) {
  return store.acceptJob({
    messageId,
    chatId: "target-chat",
    requesterOpenId: "user-1",
    parentId,
    allowNewTopic: !parentId,
    existingTopicInput: messageId,
    newTopicInput: messageId,
  }).job!;
}

function finish(store: Store, jobId: number, reply: string): void {
  const claimed = store.claimRunnableJobs(1);
  expect(claimed.map((job) => job.id)).toContain(jobId);
  expect(store.completeExecution(jobId, { status: "succeeded", reply }, null).kind).toBe("completed");
}

function worker(store: Store, delivery: FakeDelivery): OutboxWorker {
  return new OutboxWorker(store, delivery, {
    callTimeoutMs: 30,
    idlePollMs: 1,
    finalRetryDelaysMs: [1, 1, 1, 1],
    reactionRetryDelaysMs: [1, 1, 1, 1],
    statusRetryBaseMs: 1,
    statusRetryCapMs: 2,
  });
}

async function waitDelivered(store: Store, jobId: number, kind: "status" | "final_reply" | "reaction"): Promise<void> {
  await waitUntil(() => store.getDelivery(jobId, kind)?.state === "delivered");
}

describe("persistent delivery outbox", () => {
  it("retries status card creation, patch, and read-back failures without duplicating the card", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "status-retries");
      delivery.failAfterAcceptOnce = true;
      outbox.start();
      await waitUntil(() => store.getDelivery(job.id, "status")?.state === "delivered");
      const statusUuidAttempts = delivery.cardReplyAttempts.filter((attempt) => attempt.sourceMessageId === "status-retries");
      expect(statusUuidAttempts).toHaveLength(2);
      expect(new Set(statusUuidAttempts.map((attempt) => attempt.uuid)).size).toBe(1);
      expect(delivery.visibleCards.filter((card) => card.sourceMessageId === "status-retries")).toHaveLength(1);

      const originalUpdate = delivery.updateCard.bind(delivery);
      let failUpdate = true;
      delivery.updateCard = async (messageId, cardJson) => {
        if (failUpdate) {
          failUpdate = false;
          throw new Error("temporary update failure");
        }
        await originalUpdate(messageId, cardJson);
      };
      const originalRead = delivery.readCard.bind(delivery);
      let mismatchReadBack = true;
      delivery.readCard = async (messageId) => {
        const cardJson = await originalRead(messageId);
        if (!failUpdate && mismatchReadBack) {
          mismatchReadBack = false;
          return "stale projection";
        }
        return cardJson;
      };
      store.claimRunnableJobs(1);
      outbox.wake();
      await waitUntil(() => {
        const status = store.getDelivery(job.id, "status");
        return status?.state === "delivered" && status.deliveredVersion === status.desiredVersion;
      });
      expect(store.getDelivery(job.id, "status")?.attempts).toBe(2);
      expect(delivery.visibleCards.filter((card) => card.sourceMessageId === "status-retries")).toHaveLength(1);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("retries a final reply with one stable UUID after acknowledgement loss", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "ack-loss");
      outbox.start();
      await waitDelivered(store, job.id, "status");
      await waitDelivered(store, job.id, "reaction");
      finish(store, job.id, "durable final");
      delivery.failAfterAcceptOnce = true;
      outbox.wake();
      await waitDelivered(store, job.id, "final_reply");

      const attempts = delivery.replyAttempts.filter((attempt) => attempt.text === "durable final");
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((attempt) => attempt.uuid)).size).toBe(1);
      expect(delivery.visibleReplies.filter((reply) => reply.text === "durable final")).toHaveLength(1);
      expect(store.getJob(job.id)).toMatchObject({ executionStatus: "succeeded", resultText: null });
      expect(store.getDelivery(job.id, "final_reply")?.attempts).toBe(1);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("persists and delivers long final replies as ordered UTF-8-safe chunks", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "long-final");
      const reply = "第一段🙂\n" + "长期任务的原生最终输出。".repeat(6_000) + "\n最后一段";
      finish(store, job.id, reply);
      const persisted = store.listDeliveries(job.id).filter((item) => item.kind === "final_reply");
      expect(persisted.length).toBeGreaterThan(1);
      expect(persisted.map((item) => item.sequence)).toEqual(persisted.map((_item, index) => index));
      expect(persisted.map((item) => item.payloadText).join("")).toBe(reply);
      expect(persisted.every((item) => Buffer.byteLength(item.payloadText!, "utf8") <= FINAL_REPLY_CHUNK_BYTES)).toBe(true);
      expect(new Set(persisted.map((item) => item.stableUuid)).size).toBe(persisted.length);

      outbox.start();
      await waitUntil(() => store.getFinalReplyState(job.id) === "delivered");
      const visible = delivery.visibleReplies.filter((item) => item.sourceMessageId === job.feishuMessageId);
      expect(visible.map((item) => item.text).join("")).toBe(reply);
      expect(visible.map((item) => item.uuid)).toEqual(persisted.map((item) => item.stableUuid));
      expect(
        store.listDeliveries(job.id)
          .filter((item) => item.kind === "final_reply")
          .every((item) => item.payloadText === null),
      ).toBe(true);
      expect(store.getJob(job.id)?.resultText).toBeNull();
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("resumes a chunked final reply after the last durably completed sequence", async () => {
    const { config, root } = await tempConfig();
    let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    let outbox: OutboxWorker | null = null;
    try {
      const job = seed(store, "chunk-restart");
      const reply = "重启续传🙂".repeat(10_000);
      finish(store, job.id, reply);

      let claimed = store.claimDueDelivery();
      while (claimed && claimed.kind !== "final_reply") {
        expect(store.completeDelivery(claimed.id, claimed.desiredVersion)).toBe(true);
        claimed = store.claimDueDelivery();
      }
      expect(claimed).toMatchObject({ kind: "final_reply", sequence: 0 });
      const firstPayload = claimed!.payloadText!;
      const firstUuid = claimed!.stableUuid!;
      expect(store.completeDelivery(claimed!.id, claimed!.desiredVersion)).toBe(true);
      store.close();

      store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      expect(store.getDelivery(job.id, "final_reply")).toMatchObject({ state: "delivered", payloadText: null });
      outbox = worker(store, delivery);
      outbox.start();
      await waitUntil(() => store.getFinalReplyState(job.id) === "delivered");
      expect(delivery.visibleReplies.map((item) => item.text).join("")).toBe(reply.slice(firstPayload.length));
      expect(delivery.replyAttempts.some((item) => item.uuid === firstUuid)).toBe(false);
    } finally {
      if (outbox) await outbox.stop();
      if (store.database.open) store.close();
      await removeTemp(root);
    }
  });

  it("does not let an in-flight running projection overwrite the terminal projection", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    const updateStarted = deferred();
    const releaseUpdate = deferred();
    try {
      const job = seed(store, "stale-progress");
      outbox.start();
      await waitDelivered(store, job.id, "status");
      const originalUpdate = delivery.updateCard.bind(delivery);
      let blockRunning = true;
      delivery.updateCard = async (messageId, cardJson) => {
        if (blockRunning && primaryCardText(cardJson).startsWith("执行中")) {
          blockRunning = false;
          updateStarted.resolve();
          await releaseUpdate.promise;
        }
        await originalUpdate(messageId, cardJson);
      };

      store.claimRunnableJobs(1);
      outbox.wake();
      await updateStarted.promise;
      expect(store.completeExecution(job.id, { status: "succeeded", reply: "finished" }, null).kind).toBe("completed");
      outbox.wake();
      releaseUpdate.resolve();
      await waitUntil(() => {
        const status = store.getDelivery(job.id, "status");
        return status?.state === "delivered" && status.deliveredVersion === status.desiredVersion;
      });

      const statusMessageId = store.getDelivery(job.id, "status")!.messageId!;
      expect(primaryCardText(await delivery.readCard(statusMessageId))).toBe("已完成。");
      expect(delivery.cardUpdateAttempts.some((attempt) => primaryCardText(attempt.cardJson).startsWith("执行中"))).toBe(true);
      expect(primaryCardText(delivery.cardUpdateAttempts.at(-1)!.cardJson)).toBe("已完成。");
    } finally {
      releaseUpdate.resolve();
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("creates at most one stable terminal replacement for a permanently uneditable status card", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "replacement");
      outbox.start();
      await waitDelivered(store, job.id, "status");
      const oldStatusMessageId = store.getDelivery(job.id, "status")!.messageId;
      finish(store, job.id, "replacement result");
      delivery.updateCard = async () => {
        throw new PermanentStatusMessageError();
      };
      outbox.wake();
      await waitDelivered(store, job.id, "status");

      const status = store.getDelivery(job.id, "status")!;
      expect(status.replacementCount).toBe(1);
      expect(status.messageId).not.toBe(oldStatusMessageId);
      expect(delivery.visibleCards.filter((card) => primaryCardText(card.cardJson) === "已完成。")).toHaveLength(1);
      expect(store.findBoundJob("target-chat", status.messageId!)?.id).toBe(job.id);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("abandons a final reply after five attempts without changing execution or topic FIFO", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const first = seed(store, "first");
      const second = seed(store, "second", "first");
      outbox.start();
      await waitDelivered(store, first.id, "status");
      await waitDelivered(store, second.id, "status");
      finish(store, first.id, "first result");
      finish(store, second.id, "second result");
      const originalReply = delivery.reply.bind(delivery);
      delivery.reply = async (messageId, text, uuid) => {
        if (text === "first result") {
          delivery.replyAttempts.push({ sourceMessageId: messageId, text, uuid });
          throw new Error("permanent final failure");
        }
        return await originalReply(messageId, text, uuid);
      };
      outbox.wake();
      await waitUntil(() => store.getDelivery(second.id, "final_reply")?.state === "delivered");

      expect(store.getDelivery(first.id, "final_reply")).toMatchObject({ state: "abandoned", attempts: 5 });
      expect(store.getJob(first.id)).toMatchObject({ executionStatus: "succeeded", resultText: null });
      expect(store.getJob(second.id)?.executionStatus).toBe("succeeded");
      expect(delivery.replyAttempts.filter((attempt) => attempt.text === "first result")).toHaveLength(5);
      expect(delivery.replyAttempts.findIndex((attempt) => attempt.text === "second result")).toBeGreaterThan(
        delivery.replyAttempts.map((attempt) => attempt.text).lastIndexOf("first result"),
      );
      const statusId = store.getDelivery(first.id, "status")!.messageId!;
      expect(primaryCardText(await delivery.readCard(statusId))).toBe("已完成，但结果发送失败。");
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("reconciles outcome reactions after an acknowledgement is lost", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "reaction-loss");
      outbox.start();
      await waitDelivered(store, job.id, "reaction");
      finish(store, job.id, "done");
      const originalAdd = delivery.addReaction.bind(delivery);
      let loseDoneAck = true;
      delivery.addReaction = async (messageId, emojiType) => {
        const reactionId = await originalAdd(messageId, emojiType);
        if (emojiType === "DONE" && loseDoneAck) {
          loseDoneAck = false;
          throw new Error("reaction acknowledgement lost");
        }
        return reactionId;
      };
      outbox.wake();
      await waitUntil(() => {
        const reaction = store.getDelivery(job.id, "reaction");
        return reaction?.state === "delivered" && reaction.attempts === 1;
      });
      expect(delivery.reactions.get(job.feishuMessageId)).toEqual([
        expect.objectContaining({ emojiType: "DONE" }),
      ]);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("stops after the bounded in-flight call without waiting for future retries", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    delivery.replyCard = async () => await new Promise(() => undefined);
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "hanging");
      outbox.start();
      await waitUntil(() => store.getDelivery(job.id, "status")?.state === "delivering");
      const startedAt = Date.now();
      await outbox.stop();
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(store.getDelivery(job.id, "status")?.state).toBe("pending");
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });
});
