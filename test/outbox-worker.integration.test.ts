import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { PermanentStatusMessageError } from "../src/feishu/messages.js";
import { FINAL_REPLY_CHUNK_BYTES } from "../src/jobs/final-reply.js";
import { OncallIngress } from "../src/oncall/ingress.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { deferred, FakeDelivery, FakeRunner, messageEvent, primaryCardText, removeTemp, tempConfig, waitUntil } from "./helpers.js";

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
  it.each([
    { outcome: "failed", inFlight: false },
    { outcome: "interrupted", inFlight: false },
    { outcome: "failed", inFlight: true },
    { outcome: "interrupted", inFlight: true },
  ] as const)("delivers paused queue cards after $outcome while inFlight=$inFlight", async ({ outcome, inFlight }) => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = new OutboxWorker(store, delivery, { callTimeoutMs: 5_000, idlePollMs: 1 });
    const queuedCardStarted = deferred();
    const releaseQueuedCard = deferred();
    const originalReplyCard = delivery.replyCard.bind(delivery);
    delivery.replyCard = async (messageId, cardJson, uuid) => {
      const receipt = await originalReplyCard(messageId, cardJson, uuid);
      if (messageId === "pause-queued" && inFlight) {
        queuedCardStarted.resolve();
        await releaseQueuedCard.promise;
      }
      return receipt;
    };
    try {
      const active = seed(store, "pause-active");
      const queued = seed(store, "pause-queued", "pause-active");
      store.database.prepare(`INSERT INTO oncall_topics(topic_id, workspace_id, chat_id, root_id, owner_open_id)
        VALUES (?, 'infra', 'target-chat', 'pause-active', 'user-1')`).run(active.topicId);
      expect(store.claimRunnableJobs(1).map((job) => job.id)).toEqual([active.id]);
      outbox.start();
      if (inFlight) await queuedCardStarted.promise;
      else await waitDelivered(store, queued.id, "status");
      const initial = store.getDelivery(queued.id, "status")!;
      expect(initial.state).toBe(inFlight ? "delivering" : "delivered");
      expect(primaryCardText(delivery.visibleCards.find((card) => card.sourceMessageId === queued.feishuMessageId)!.cardJson))
        .toBe("排队中，等待本话题前序任务完成。");

      if (outcome === "failed") store.completeExecution(active.id, { status: "failed", reply: "tool failed" }, "agent_failed");
      else store.interruptExecution(active.id, "interrupted");
      const dirty = store.getDelivery(queued.id, "status")!;
      expect(dirty.desiredVersion).toBeGreaterThan(initial.desiredVersion);
      expect(dirty.state).toBe(inFlight ? "delivering" : "pending");
      if (inFlight) expect(dirty.leaseStartedAt).toBe(initial.leaseStartedAt);
      expect(store.getJob(queued.id)?.executionStatus).toBe("queued");
      expect(store.claimRunnableJobs(5)).toEqual([]);

      releaseQueuedCard.resolve();
      outbox.wake();
      await waitDelivered(store, queued.id, "status");
      const final = store.getDelivery(queued.id, "status")!;
      expect(final.deliveredVersion).toBe(final.desiredVersion);
      expect(final.attempts).toBe(0);
      expect(primaryCardText(await delivery.readCard(final.messageId!))).toBe("本话题已暂停，等待明确“继续”。");
      expect(delivery.cardReplyAttempts.filter((attempt) => attempt.sourceMessageId === queued.feishuMessageId)).toHaveLength(1);
    } finally {
      releaseQueuedCard.resolve();
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it("preserves the initial Oncall status lease during input preparation, pause and resume", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = new OutboxWorker(store, delivery, { callTimeoutMs: 5_000, idlePollMs: 1 });
    const firstCardStarted = deferred();
    const releaseFirstCard = deferred();
    const originalReplyCard = delivery.replyCard.bind(delivery);
    delivery.replyCard = async (messageId, cardJson, uuid) => {
      const receipt = await originalReplyCard(messageId, cardJson, uuid);
      if (messageId === "oncall-status-race") {
        firstCardStarted.resolve();
        await releaseFirstCard.promise;
      }
      return receipt;
    };
    const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, new URL("../workspace-template", import.meta.url).pathname);
    const ingress = new OncallIngress(config, {
      workspaces: [{ id: "infra", knowledgePaths: [], repositories: [] }],
      groupBindings: [{ chatId: "target-chat", workspaceId: "infra" }],
      privateBinding: { chatId: "private-chat", ownerOpenId: "user-1", workspaceId: "infra" },
      maxAttachmentBytes: 20 * 1024 * 1024, agentEnvironment: {},
    }, "bot-open-id", store, delivery, {
      executionReady: () => undefined, deliveryReady: () => outbox.wake(),
    }, workspaces, new FakeRunner());
    try {
      outbox.start();
      const receiving = ingress.handle(messageEvent("oncall-status-race", "@_user_1 analyze"));
      await firstCardStarted.promise;
      const job = store.getAllJobs()[0]!;
      const lease = store.getDelivery(job.id, "status")!;
      expect(lease.state).toBe("delivering");
      expect(await receiving).toBe("accepted");
      expect(store.getDelivery(job.id, "status")).toMatchObject({
        state: "delivering", leaseStartedAt: lease.leaseStartedAt, attempts: 0,
      });
      await ingress.handle(messageEvent("oncall-stop-race", "停止", { root_id: "oncall-status-race", mentions: [] }));
      expect(store.getDelivery(job.id, "status")?.state).toBe("delivering");
      await ingress.handle(messageEvent("oncall-resume-race", "继续", { root_id: "oncall-status-race", mentions: [] }));
      expect(store.getDelivery(job.id, "status")).toMatchObject({
        state: "delivering", leaseStartedAt: lease.leaseStartedAt, attempts: 0,
      });
      releaseFirstCard.resolve();
      await waitDelivered(store, job.id, "status");
      const status = store.getDelivery(job.id, "status")!;
      expect(status.deliveredVersion).toBe(status.desiredVersion);
      expect(status.attempts).toBe(0);
      expect(delivery.cardReplyAttempts.filter((attempt) => attempt.sourceMessageId === job.feishuMessageId)).toHaveLength(1);
      expect(delivery.cardUpdateAttempts.some((attempt) => attempt.messageId === status.messageId)).toBe(true);
      expect(store.findBoundJob("target-chat", status.messageId!)?.id).toBe(job.id);
      expect(primaryCardText(await delivery.readCard(status.messageId!))).toBe("排队中，等待可用执行名额。");
    } finally {
      releaseFirstCard.resolve();
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

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

  it("retries the same final card after acknowledgement loss without sending a text reply", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "ack-loss");
      outbox.start();
      await waitDelivered(store, job.id, "status");
      await waitDelivered(store, job.id, "reaction");
      const originalMessageId = store.getDelivery(job.id, "status")!.messageId;
      finish(store, job.id, "durable final");
      const originalUpdate = delivery.updateCard.bind(delivery);
      let loseAck = true;
      delivery.updateCard = async (messageId, cardJson) => {
        await originalUpdate(messageId, cardJson);
        if (primaryCardText(cardJson) === "durable final" && loseAck) {
          loseAck = false;
          throw new Error("simulated acknowledgement loss");
        }
      };
      outbox.wake();
      await waitDelivered(store, job.id, "final_reply");

      const attempts = delivery.cardUpdateAttempts.filter((attempt) => primaryCardText(attempt.cardJson) === "durable final");
      expect(attempts).toHaveLength(2);
      expect(attempts.every((attempt) => attempt.messageId === originalMessageId)).toBe(true);
      expect(delivery.visibleReplies).toHaveLength(0);
      expect(delivery.visibleCards).toHaveLength(1);
      expect(primaryCardText(delivery.visibleCards[0]!.cardJson)).toBe("durable final");
      expect(store.getDelivery(job.id, "final_reply")?.messageId).toBe(originalMessageId);
      expect(store.getJob(job.id)).toMatchObject({ executionStatus: "succeeded", resultText: null });
      expect(store.getDelivery(job.id, "final_reply")?.attempts).toBe(1);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it.each(["formatted", "unavailable"] as const)("keeps an acknowledged final reply when read-back is %s", async (mode) => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    const reply = "结论\n\n使用 `Current` 泳道。\n\n检查已完成。";
    const readCard = delivery.readCard.bind(delivery);
    delivery.readCard = async (messageId) => {
      const card = await readCard(messageId);
      if (primaryCardText(card) !== reply) return card;
      if (mode === "unavailable") throw new Error("temporary read-back failure after accepted update");
      // Feishu returns rendered text, removing inline code markers and some blank lines.
      return JSON.stringify({ title: "已完成", elements: [[{
        tag: "text", text: reply.replace(/`/g, "").replace(/\n\n/g, "\n"),
      }]] });
    };
    try {
      const job = seed(store, "rendered-final");
      finish(store, job.id, reply);
      outbox.start();
      await waitUntil(() => ["delivered", "abandoned"].includes(store.getFinalReplyState(job.id) ?? ""));
      await outbox.waitForIdle();
      expect(store.getDelivery(job.id, "final_reply")).toMatchObject({ state: "delivered", attempts: 0 });
      expect(delivery.visibleCards).toHaveLength(1);
      expect(primaryCardText(delivery.visibleCards[0]!.cardJson)).toBe(reply);
      expect(delivery.visibleReplies).toHaveLength(0);
      expect(store.getDelivery(job.id, "final_reply")?.messageId).toBe(store.getDelivery(job.id, "status")?.messageId);
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it.each(["acknowledgement", "receipt", "completed"] as const)(
    "keeps one result card across restart after %s and a stale status retry", async (stage) => {
      const { config, root } = await tempConfig();
      let store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
      const delivery = new FakeDelivery();
      let outbox = new OutboxWorker(store, delivery, { finalRetryDelaysMs: [60_000], idlePollMs: 60_000 });
      try {
        const job = seed(store, "card-restart");
        outbox.start();
        await waitDelivered(store, job.id, "status");
        const messageId = store.getDelivery(job.id, "status")!.messageId!;
        const readCard = delivery.readCard.bind(delivery);
        const updateCard = delivery.updateCard.bind(delivery);
        delivery.updateCard = async (id, card) => {
          await updateCard(id, card);
          if (stage === "acknowledgement" && primaryCardText(card) === "persistent result") {
            throw new Error("simulated acknowledgement loss");
          }
        };
        const completeDelivery = store.completeDelivery.bind(store);
        store.completeDelivery = (id, version) => {
          if (stage === "receipt" && store.getDeliveryById(id)?.kind === "final_reply") {
            throw new Error("simulated interruption after receipt persistence");
          }
          return completeDelivery(id, version);
        };
        finish(store, job.id, "persistent result");
        outbox.wake();
        await waitUntil(() => {
          const final = store.getDelivery(job.id, "final_reply");
          return stage === "completed" ? final?.state === "delivered" : final?.attempts === 1;
        });
        expect(primaryCardText(await readCard(messageId))).toBe("persistent result");
        await outbox.stop();
        store.close();

        store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
        store.database.prepare("UPDATE job_deliveries SET state = 'pending' WHERE job_id = ? AND kind = 'status'").run(job.id);
        delivery.updateCard = updateCard;
        outbox = new OutboxWorker(store, delivery, { now: () => Date.now() + 120_000, idlePollMs: 1 });
        outbox.start();
        await waitDelivered(store, job.id, "final_reply");
        await waitDelivered(store, job.id, "status");
        await outbox.waitForIdle();
        expect(primaryCardText(await readCard(messageId))).toBe("persistent result");
        expect(delivery.visibleCards).toHaveLength(1);
        expect(delivery.visibleReplies).toHaveLength(0);
        expect(store.getJob(job.id)?.resultText).toBeNull();
        expect(store.findBoundJob("target-chat", messageId)?.id).toBe(job.id);
      } finally {
        await outbox.stop();
        if (store.database.open) store.close();
        await removeTemp(root);
      }
    },
  );

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
      const firstChunk = primaryCardText(delivery.visibleCards[0]!.cardJson);
      expect(firstChunk + visible.map((item) => item.text).join("")).toBe(reply);
      expect(visible.map((item) => item.uuid)).toEqual(persisted.slice(1).map((item) => item.stableUuid));
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

  it("preserves the result in the card when an overflow chunk cannot be delivered", async () => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "overflow-failure");
      const firstChunk = "a".repeat(FINAL_REPLY_CHUNK_BYTES);
      finish(store, job.id, firstChunk + "overflow");
      delivery.reply = async () => { throw new Error("overflow unavailable"); };
      outbox.start();
      await waitUntil(() => store.getFinalReplyState(job.id) === "abandoned" && store.getJob(job.id)?.resultText === null);
      expect(primaryCardText(delivery.visibleCards[0]!.cardJson)).toBe(firstChunk + "\n\n---\n已完成，但结果发送失败。");
      expect(delivery.visibleCards).toHaveLength(1);
      expect(store.getDelivery(job.id, "final_reply")?.state).toBe("delivered");
    } finally {
      await outbox.stop();
      store.close();
      await removeTemp(root);
    }
  });

  it.each(["uneditable", "oversize"] as const)("falls back to text for an %s result card", async (reason) => {
    const { config, root } = await tempConfig();
    const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
    const delivery = new FakeDelivery();
    const outbox = worker(store, delivery);
    try {
      const job = seed(store, "fallback");
      // Escaping quotes twice exceeds the card request limit despite fitting one text chunk.
      const reply = reason === "oversize" ? '"'.repeat(FINAL_REPLY_CHUNK_BYTES) : "fallback result";
      const updateCard = delivery.updateCard.bind(delivery);
      delivery.updateCard = async (messageId, cardJson) => {
        if (primaryCardText(cardJson) === reply) throw new PermanentStatusMessageError();
        return updateCard(messageId, cardJson);
      };
      finish(store, job.id, reply);
      outbox.start();
      await waitDelivered(store, job.id, "final_reply");
      expect(delivery.visibleReplies.map((item) => item.text)).toEqual([reply]);
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
      await waitDelivered(store, job.id, "final_reply");
      expect(primaryCardText(await delivery.readCard(statusMessageId))).toBe("finished");
      expect(delivery.cardUpdateAttempts.some((attempt) => primaryCardText(attempt.cardJson).startsWith("执行中"))).toBe(true);
      expect(primaryCardText(delivery.cardUpdateAttempts.at(-1)!.cardJson)).toBe("finished");
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
      const originalUpdate = delivery.updateCard.bind(delivery);
      delivery.updateCard = async (messageId, cardJson) => {
        if (primaryCardText(cardJson) === "first result") {
          delivery.cardUpdateAttempts.push({ messageId, cardJson });
          throw new Error("permanent final failure");
        }
        return await originalUpdate(messageId, cardJson);
      };
      outbox.wake();
      await waitUntil(() => store.getDelivery(second.id, "final_reply")?.state === "delivered");

      expect(store.getDelivery(first.id, "final_reply")).toMatchObject({ state: "abandoned", attempts: 5 });
      expect(store.getJob(first.id)).toMatchObject({ executionStatus: "succeeded", resultText: null });
      expect(store.getJob(second.id)?.executionStatus).toBe("succeeded");
      expect(delivery.cardUpdateAttempts.filter((attempt) => primaryCardText(attempt.cardJson) === "first result")).toHaveLength(5);
      expect(delivery.cardUpdateAttempts.findIndex((attempt) => primaryCardText(attempt.cardJson) === "second result")).toBeGreaterThan(
        delivery.cardUpdateAttempts.map((attempt) => primaryCardText(attempt.cardJson)).lastIndexOf("first result"),
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
