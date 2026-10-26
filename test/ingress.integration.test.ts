import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CancellationController } from "../src/control/cancellation.js";
import { Store } from "../src/db/store.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { FeishuIngress } from "../src/feishu/ingress.js";
import { OncallIngress } from "../src/oncall/ingress.js";
import { OncallStore } from "../src/oncall/store.js";
import type { OncallConfig } from "../src/oncall/workspace-config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { WorkspaceManager } from "../src/workspaces.js";
import { deferred, FakeDelivery, FakeRunner, messageEvent, primaryCardText, removeTemp, tempConfig, waitUntil } from "./helpers.js";

async function harness(overrides: Parameters<typeof tempConfig>[0] = {}) {
  const { config, root } = await tempConfig(overrides);
  const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
  const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
  await workspaces.initialize();
  const delivery = new FakeDelivery();
  const runner = new FakeRunner();
  const outbox = new OutboxWorker(store, delivery, { callTimeoutMs: 50, idlePollMs: 1 });
  const scheduler = new Scheduler(config, store, runner, workspaces, () => outbox.wake());
  const cancellation = new CancellationController(store, runner, delivery, () => {
    scheduler.wake();
    outbox.wake();
  });
  const ingress = new FeishuIngress(
    config,
    "bot-open-id",
    store,
    delivery,
    {
      executionReady: () => scheduler.wake(),
      deliveryReady: () => outbox.wake(),
    },
    workspaces,
    cancellation,
  );
  outbox.start();
  await scheduler.start();
  const waitForExecutionIdle = scheduler.waitForIdle.bind(scheduler);
  scheduler.waitForIdle = async () => {
    await waitForExecutionIdle();
    outbox.wake();
    await outbox.waitForIdle();
  };
  return { config, root, store, workspaces, delivery, runner, scheduler, outbox, ingress };
}

describe("Feishu ingress", () => {
  const pngImage = {
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    extension: "png" as const,
    mediaType: "image/png" as const,
  };

  it("rejects missing configuration by variable name without exposing values", () => {
    const environment = {
      FEISHU_APP_ID: "visible-app-id",
      FEISHU_CHAT_ID: "target-chat",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(environment)).toThrow(/FEISHU_APP_SECRET/);
    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("visible-app-id");
    }
  });

  it("rejects unsafe path overlap and invalid concurrency or timeout values", async () => {
    const { config, root } = await tempConfig();
    try {
      expect(() =>
        loadConfig({
          ...config,
          CODEX_HOME: path.join(config.WORKSPACE_ROOT, "codex-home"),
          STATE_DB_PATH: path.join(config.WORKSPACE_ROOT, "state.db"),
          MAX_CONCURRENT_TURNS: "0",
          TURN_TIMEOUT_MS: "59999",
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(/CODEX_HOME|WORKSPACE_ROOT|STATE_DB_PATH|MAX_CONCURRENT_TURNS|TURN_TIMEOUT_MS/);
    } finally {
      await removeTemp(root);
    }
  });

  it("ignores other chats, unconfigured p2p, unmentioned group chat, bot senders, and unbound group images", async () => {
    const h = await harness();
    try {
      const events = [
        messageEvent("other", "@_user_1 hi", { chat_id: "other-chat" }),
        messageEvent("p2p", "hi", { chat_id: "other-private-chat", chat_type: "p2p", mentions: [] }),
        messageEvent("plain", "hello", { mentions: [] }),
        messageEvent("bot", "@_user_1 hi", {}, { sender_type: "bot" }),
        messageEvent("image", "@_user_1 hi", { message_type: "image" }),
      ];
      for (const event of events) expect(await h.ingress.handle(event)).toBe("ignored");
      expect(h.store.count("jobs")).toBe(0);
      expect(h.delivery.timeline).toEqual([]);
      expect(h.runner.calls).toHaveLength(0);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("replies once to unsupported directed messages without creating a job", async () => {
    const h = await harness();
    try {
      const privateFile = messageEvent("private-file", "", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "not-logged" }),
        mentions: [],
      });
      expect(await h.ingress.handle(privateFile)).toBe("rejected");
      expect(await h.ingress.handle(privateFile)).toBe("rejected");
      expect(h.delivery.visibleReplies.filter((reply) => reply.sourceMessageId === "private-file")).toEqual([
        expect.objectContaining({ text: "暂不支持这种消息类型，请发送文字、图片，或图片加文字。" }),
      ]);

      expect(await h.ingress.handle(messageEvent("unrelated-file", "", {
        message_type: "file",
        content: JSON.stringify({ file_key: "not-logged" }),
        mentions: [],
      }))).toBe("ignored");
      expect(await h.ingress.handle(messageEvent("directed-file", "", {
        message_type: "file",
        content: JSON.stringify({ file_key: "not-logged" }),
      }))).toBe("rejected");
      expect(h.delivery.visibleReplies.find((reply) => reply.sourceMessageId === "directed-file")?.text).toBe(
        "暂不支持这种消息类型，请发送文字、图片，或图片加文字。",
      );
      expect(h.store.count("jobs")).toBe(0);
      expect(h.runner.calls).toHaveLength(0);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("accepts a private image, stores it inside the topic workspace, and sends its relative path to the agent", async () => {
    const h = await harness();
    h.delivery.fetchedImages.set("private-image", pngImage);
    try {
      const event = messageEvent("private-image", "", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "image-key" }),
        mentions: [],
      });
      expect(await h.ingress.handle(event)).toBe("accepted");
      await h.scheduler.waitForIdle();

      expect(h.runner.calls[0]!.job.executionMode).toBe("unrestricted");
      const input = JSON.parse(h.runner.calls[0]!.job.inputText!);
      expect(input).toMatchObject({
        text: "请查看并分析我发送的图片。",
        images: [
          {
            media_type: "image/png",
            source_message_id: "private-image",
          },
        ],
      });
      expect(input.images[0].path).toMatch(/^input-images\/[a-f0-9]{24}\.png$/);
      const imagePath = path.join(h.runner.calls[0]!.topic.workspacePath, input.images[0].path);
      expect(await fs.readFile(imagePath)).toEqual(pngImage.data);
      expect((await fs.stat(imagePath)).mode & 0o777).toBe(0o600);
      expect(h.delivery.imageRequests).toEqual([
        { messageId: "private-image", imageKey: "image-key", maxBytes: 5 * 1024 * 1024 },
      ]);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("accepts private rich text containing an image and text as one job", async () => {
    const h = await harness();
    h.delivery.fetchedImages.set("private-post", pngImage);
    try {
      const event = messageEvent("private-post", "", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [
            [{ tag: "img", image_key: "post-image-key" }],
            [{ tag: "text", text: "Please inspect this screenshot." }],
          ],
        }),
        mentions: [],
      });
      expect(await h.ingress.handle(event)).toBe("accepted");
      await h.scheduler.waitForIdle();

      const input = JSON.parse(h.runner.calls[0]!.job.inputText!);
      expect(input).toMatchObject({
        text: "Please inspect this screenshot.",
        images: [
          {
            media_type: "image/png",
            source_message_id: "private-post",
          },
        ],
      });
      expect(input.images[0].path).toMatch(/^input-images\/[a-f0-9]{24}\.png$/);
      expect(h.delivery.imageRequests).toEqual([
        { messageId: "private-post", imageKey: "post-image-key", maxBytes: 5 * 1024 * 1024 },
      ]);
      expect(h.store.count("jobs")).toBe(1);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("keeps an image job preparing until its file and prompt are ready", async () => {
    const h = await harness();
    const imageGate = deferred();
    const originalFetchImage = h.delivery.fetchImage.bind(h.delivery);
    h.delivery.fetchedImages.set("preparing-image", pngImage);
    h.delivery.fetchImage = async (...args) => {
      await imageGate.promise;
      return await originalFetchImage(...args);
    };
    try {
      const handling = h.ingress.handle(messageEvent("preparing-image", "", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "image-key" }),
        mentions: [],
      }));
      await waitUntil(() => h.store.getAllJobs()[0]?.executionStatus === "preparing");
      h.outbox.wake();
      await h.outbox.waitForIdle();
      expect(h.runner.calls).toHaveLength(0);
      expect(primaryCardText(h.delivery.visibleCards[0]!.cardJson)).toBe("正在接收任务内容…");

      imageGate.resolve();
      await expect(handling).resolves.toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(h.runner.calls).toHaveLength(1);
      expect(h.store.getAllJobs()[0]?.executionStatus).toBe("succeeded");
    } finally {
      imageGate.resolve();
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("accepts an image reply in an existing group topic without another mention", async () => {
    const h = await harness();
    try {
      await h.ingress.handle(messageEvent("group-root", "@_user_1 start"));
      await h.scheduler.waitForIdle();
      const topicId = h.store.getAllJobs()[0]!.topicId;
      h.delivery.fetchedImages.set("group-image", pngImage);

      const image = messageEvent("group-image", "", {
        message_type: "image",
        content: JSON.stringify({ image_key: "group-image-key" }),
        mentions: [],
        parent_id: "group-root",
      });
      expect(await h.ingress.handle(image)).toBe("accepted");
      await h.scheduler.waitForIdle();

      expect(h.store.getAllJobs()[1]!.topicId).toBe(topicId);
      expect(JSON.parse(h.runner.calls[1]!.job.inputText!)).toMatchObject({
        referenced_message_id: "group-root",
        images: [{ source_message_id: "group-image" }],
      });
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("accepts a text request that mentions the bot and references an unbound image", async () => {
    const h = await harness();
    h.delivery.referencedImages.set("referenced-image", "referenced-image-key");
    h.delivery.fetchedImages.set("referenced-image", pngImage);
    try {
      const event = messageEvent("inspect-image", "@_user_1 inspect this", { parent_id: "referenced-image" });
      expect(await h.ingress.handle(event)).toBe("accepted");
      await h.scheduler.waitForIdle();

      expect(JSON.parse(h.runner.calls[0]!.job.inputText!)).toMatchObject({
        text: "inspect this",
        referenced_message_id: "referenced-image",
        images: [{ source_message_id: "referenced-image", media_type: "image/png" }],
      });
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("fails a private image job that cannot be downloaded without running the agent", async () => {
    const h = await harness();
    try {
      const event = messageEvent("missing-image", "", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "missing-key" }),
        mentions: [],
      });
      expect(await h.ingress.handle(event)).toBe("rejected");
      h.outbox.wake();
      await h.outbox.waitForIdle();
      expect(h.store.count("jobs")).toBe(1);
      expect(h.store.getAllJobs()[0]!.executionStatus).toBe("failed");
      expect(h.runner.calls).toHaveLength(0);
      expect(h.delivery.visibleCards.some((card) => primaryCardText(card.cardJson).includes("最大 5 MiB"))).toBe(true);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("runs independent private threads concurrently and queues replies within each thread", async () => {
    const h = await harness({ MAX_CONCURRENT_TURNS: 2 });
    h.runner.block = true;
    const privateMessage = (id: string, parentId?: string) => messageEvent(id, id, {
      chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
      chat_type: "p2p",
      mentions: [],
      ...(parentId ? { parent_id: parentId } : {}),
    });
    try {
      await h.ingress.handle(privateMessage("a"));
      await waitUntil(() => h.runner.calls.length === 1);
      await h.ingress.handle(privateMessage("b"));
      await waitUntil(() => h.runner.calls.length === 2);
      const [a, b] = h.store.getAllJobs();
      expect(a!.topicId).not.toBe(b!.topicId);
      expect(h.runner.calls[0]!.topic.workspacePath).not.toBe(h.runner.calls[1]!.topic.workspacePath);
      expect(h.store.getTopic(a!.topicId)!.agentSessionId).not.toBe(h.store.getTopic(b!.topicId)!.agentSessionId);
      expect(h.runner.peakConcurrent).toBe(2);
      await h.outbox.waitForIdle();
      const cardA = h.delivery.visibleCards.find((card) => card.sourceMessageId === "a")!;
      await h.ingress.handle(privateMessage("a2", cardA.messageId));
      await h.ingress.handle(privateMessage("b2", "b"));
      expect(await h.ingress.handle(privateMessage("b"))).toBe("duplicate");
      await h.outbox.waitForIdle();
      expect(h.runner.calls).toHaveLength(2);
      expect(h.store.getAllJobs().map((job) => job.executionStatus)).toEqual(["running", "running", "queued", "queued"]);
      expect(h.store.getAllJobs().map((job) => job.topicId)).toEqual([a!.topicId, b!.topicId, a!.topicId, b!.topicId]);
      for (const id of ["a2", "b2"]) {
        expect(primaryCardText(h.delivery.visibleCards.find((card) => card.sourceMessageId === id)!.cardJson))
          .toBe("排队中，等待本话题前序任务完成。");
      }

      h.runner.gates[0]!.resolve();
      await waitUntil(() => h.runner.calls.length === 3);
      expect(h.runner.calls[2]!.job.feishuMessageId).toBe("a2");
      expect(h.runner.calls[2]!.topic.agentSessionId).toBe(h.store.getTopic(a!.topicId)!.agentSessionId);
      expect(h.store.getJob(b!.id)!.executionStatus).toBe("running");
      h.runner.gates[1]!.resolve();
      await waitUntil(() => h.runner.calls.length === 4);
      expect(h.runner.calls[3]!.job.feishuMessageId).toBe("b2");
      for (const gate of h.runner.gates) gate.resolve();
      await h.scheduler.waitForIdle();

      const finalA = h.delivery.visibleCards.find((card) => card.sourceMessageId === "a")!;
      h.runner.block = false;
      await h.ingress.handle(privateMessage("a3", finalA.messageId));
      await h.scheduler.waitForIdle();
      expect(h.runner.calls[4]!.topic.id).toBe(a!.topicId);
      expect(h.store.count("topics")).toBe(2);
    } finally {
      h.scheduler.stop();
      await h.scheduler.waitForIdle();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("explains independent private threads for the legacy new-conversation command", async () => {
    const h = await harness();
    try {
      const command = messageEvent("private-new-topic", "新会话", {
        chat_id: h.config.FEISHU_PRIVATE_CHAT_ID,
        chat_type: "p2p",
        mentions: [],
      });
      expect(await h.ingress.handle(command)).toBe("accepted");
      expect(await h.ingress.handle(command)).toBe("accepted");
      expect(h.delivery.visibleReplies.filter((reply) => reply.sourceMessageId === "private-new-topic")).toEqual([
        expect.objectContaining({ text: "请直接发送新的独立消息开始任务；继续已有任务请在原话题内回复。" }),
      ]);
      expect(h.store.count("jobs")).toBe(0);
      expect(h.store.count("topics")).toBe(0);
      expect(h.runner.calls).toHaveLength(0);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("creates a topic, strips only the bot mention, and binds inbound and outbound messages", async () => {
    const h = await harness();
    try {
      expect(await h.ingress.handle(messageEvent("m1", "@_user_1 hello @_user_2"))).toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(h.runner.calls).toHaveLength(1);
      expect(JSON.parse(h.runner.calls[0]!.job.inputText!)).toMatchObject({
        source: "feishu",
        message_id: "m1",
        sender_open_id: "user-1",
        text: "hello @_user_2",
      });
      expect(h.delivery.visibleCards.map((card) => primaryCardText(card.cardJson))).toContain("fixed final reply");
      expect(h.delivery.visibleReplies).toHaveLength(0);
      expect(h.delivery.done.has("m1")).toBe(true);
      expect(h.store.count("topics")).toBe(1);
      expect(h.store.count("message_bindings")).toBe(2);
      const job = h.store.getAllJobs()[0]!;
      expect(h.runner.calls[0]!.job.executionMode).toBe("sandboxed");
      expect(job.executionMode).toBe("sandboxed");
      expect(job.executionStatus).toBe("succeeded");
      expect(job.inputText).toBeNull();
      expect(job.resultText).toBeNull();
      expect(h.store.getDelivery(job.id, "status")?.messageId).toBe("reply-1");
      expect(h.store.getDelivery(job.id, "final_reply")?.messageId).toBe("reply-1");
      expect(await fs.stat(h.runner.calls[0]!.topic.workspacePath)).toBeTruthy();
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("shows capacity waits and updates each status message when execution starts", async () => {
    const h = await harness({ MAX_CONCURRENT_TURNS: 1 });
    h.runner.block = true;
    try {
      const privateOptions = { chat_id: h.config.FEISHU_PRIVATE_CHAT_ID, chat_type: "p2p", mentions: [] };
      await h.ingress.handle(messageEvent("queued-1", "first", privateOptions));
      await waitUntil(() => h.runner.calls.length === 1);
      await h.ingress.handle(messageEvent("queued-2", "second", privateOptions));
      await h.ingress.handle(messageEvent("queued-3", "third", privateOptions));
      h.outbox.wake();
      await h.outbox.waitForIdle();

      expect(primaryCardText(h.delivery.visibleCards.find((card) => card.sourceMessageId === "queued-1")!.cardJson)).toBe(
        "执行中，已运行 0 分钟。",
      );
      expect(primaryCardText(h.delivery.visibleCards.find((card) => card.sourceMessageId === "queued-2")!.cardJson)).toBe(
        "排队中，等待可用执行名额。",
      );
      expect(primaryCardText(h.delivery.visibleCards.find((card) => card.sourceMessageId === "queued-3")!.cardJson)).toBe(
        "排队中，等待可用执行名额。",
      );

      h.runner.gates[0]!.resolve();
      await waitUntil(() => h.runner.calls.length === 2);
      h.outbox.wake();
      await h.outbox.waitForIdle();
      expect(primaryCardText(h.delivery.visibleCards.find((card) => card.sourceMessageId === "queued-2")!.cardJson)).toBe(
        "执行中，已运行 0 分钟。",
      );
      h.runner.gates[1]!.resolve();
      await waitUntil(() => h.runner.calls.length === 3);
      h.runner.gates[2]!.resolve();
      await h.scheduler.waitForIdle();
    } finally {
      for (const gate of h.runner.gates) gate.resolve();
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("updates a topic wait to a capacity wait when its queued predecessor is cancelled", async () => {
    const h = await harness({ MAX_CONCURRENT_TURNS: 1 });
    h.runner.block = true;
    try {
      await h.ingress.handle(messageEvent("active", "@_user_1 active"));
      await waitUntil(() => h.runner.calls.length === 1);
      await h.ingress.handle(messageEvent("b1", "@_user_1 first"));
      await h.ingress.handle(messageEvent("b2", "second", { parent_id: "b1", mentions: [] }));
      await h.outbox.waitForIdle();
      const card = h.delivery.visibleCards.find((item) => item.sourceMessageId === "b2")!;
      expect(primaryCardText(card.cardJson)).toBe("排队中，等待本话题前序任务完成。");

      await h.ingress.handle(messageEvent("cancel-b1", "取消", { parent_id: "b1", mentions: [] }));
      await h.outbox.waitForIdle();
      expect(primaryCardText(card.cardJson)).toBe("排队中，等待可用执行名额。");
      expect(h.runner.calls).toHaveLength(1);
      h.runner.gates[0]!.resolve();
      await waitUntil(() => h.runner.calls.length === 2);
      await h.outbox.waitForIdle();
      expect(h.runner.calls[1]!.job.feishuMessageId).toBe("b2");
      expect(primaryCardText(card.cardJson)).toBe("执行中，已运行 0 分钟。");
      expect(h.delivery.visibleCards.filter((item) => item.sourceMessageId === "b2")).toHaveLength(1);
      h.runner.gates[1]!.resolve();
      await h.scheduler.waitForIdle();
    } finally {
      h.scheduler.stop();
      await h.scheduler.waitForIdle();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("routes the Feishu root before a conflicting parent binding", async () => {
    const h = await harness();
    try {
      await h.ingress.handle(messageEvent("a", "@_user_1 first"));
      await h.scheduler.waitForIdle();
      const topicA = h.store.getAllJobs()[0]!.topicId;
      const outboundA = h.delivery.visibleCards[0]!.messageId;

      await h.ingress.handle(messageEvent("b", "@_user_1 second"));
      await h.scheduler.waitForIdle();
      const topicB = h.store.getAllJobs()[1]!.topicId;
      expect(topicA).not.toBe(topicB);

      const reply = messageEvent("follow", "continue", {
        mentions: [],
        parent_id: outboundA,
        root_id: "b",
      });
      expect(await h.ingress.handle(reply)).toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(h.store.getAllJobs()[2]!.topicId).toBe(topicB);
      expect(h.store.count("topics")).toBe(2);
      expect(h.runner.calls[2]!.topic.agentSessionId).toBe(`thread-${topicB}`);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("keeps sibling replies under one unbound Feishu root in the same agent thread", async () => {
    const h = await harness();
    try {
      h.delivery.fetchedText.set("shared-root", "root context");
      const first = messageEvent("first-child", "@_user_1 inspect the MR", {
        parent_id: "shared-root",
        root_id: "shared-root",
      });
      expect(await h.ingress.handle(first)).toBe("accepted");
      await h.scheduler.waitForIdle();

      const firstJob = h.store.getAllJobs()[0]!;
      const sessionId = h.store.getTopic(firstJob.topicId)!.agentSessionId;
      const sibling = messageEvent("sibling-child", "continue", {
        mentions: [],
        parent_id: "shared-root",
        root_id: "shared-root",
      });
      expect(await h.ingress.handle(sibling)).toBe("accepted");
      await h.scheduler.waitForIdle();

      const secondJob = h.store.getAllJobs()[1]!;
      expect(secondJob.topicId).toBe(firstJob.topicId);
      expect(h.runner.calls[1]!.topic.agentSessionId).toBe(sessionId);
      expect(h.store.count("topics")).toBe(1);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("creates a new topic for an mentioned unbound reference and includes fetched text", async () => {
    const h = await harness();
    try {
      h.delivery.fetchedText.set("unbound", "unbound referenced text");
      const event = messageEvent("new", "@_user_1 investigate", { parent_id: "unbound" });
      expect(await h.ingress.handle(event)).toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(JSON.parse(h.runner.calls[0]!.job.inputText!)).toMatchObject({
        referenced_message_id: "unbound",
        referenced_text: "unbound referenced text",
      });
      expect(h.store.count("message_bindings")).toBe(3);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("rejects an unreadable unbound reference without creating a topic", async () => {
    const h = await harness();
    try {
      const event = messageEvent("unreadable", "@_user_1 investigate", { parent_id: "missing-reference" });
      expect(await h.ingress.handle(event)).toBe("rejected");
      expect(h.store.count("topics")).toBe(0);
      expect(h.store.count("jobs")).toBe(0);
      expect(h.delivery.visibleReplies).toHaveLength(1);
      expect(h.runner.calls).toHaveLength(0);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("deduplicates repeated events and safely rejects empty or oversized input", async () => {
    const h = await harness();
    try {
      const event = messageEvent("same", "@_user_1 once");
      const results = await Promise.all(Array.from({ length: 5 }, () => h.ingress.handle(event)));
      await h.scheduler.waitForIdle();
      expect(results.filter((result) => result === "accepted")).toHaveLength(1);
      expect(h.store.count("jobs")).toBe(1);
      expect(h.runner.calls).toHaveLength(1);
      expect(h.delivery.visibleCards.filter((card) => card.sourceMessageId === "same")).toHaveLength(1);
      expect(h.delivery.visibleReplies.filter((reply) => reply.sourceMessageId === "same")).toHaveLength(0);

      expect(await h.ingress.handle(messageEvent("empty", "@_user_1  "))).toBe("rejected");
      expect(await h.ingress.handle(messageEvent("large", `@_user_1 ${"字".repeat(90_000)}`))).toBe("rejected");
      expect(h.store.count("jobs")).toBe(1);
      expect(h.delivery.visibleReplies.some((reply) => reply.sourceMessageId === "empty")).toBe(true);
      expect(h.delivery.visibleReplies.some((reply) => reply.sourceMessageId === "large")).toBe(true);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("rejects configured credentials before creating a binding or job", async () => {
    const h = await harness();
    try {
      const event = messageEvent("protected", `@_user_1 inspect ${h.config.FEISHU_APP_SECRET}`);
      expect(await h.ingress.handle(event)).toBe("rejected");
      expect(h.store.count("jobs")).toBe(0);
      expect(h.store.count("message_bindings")).toBe(0);
      expect(JSON.stringify(h.delivery.visibleReplies)).not.toContain(h.config.FEISHU_APP_SECRET);
      expect(h.runner.calls).toHaveLength(0);
    } finally {
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });

  it("does not let a slow Typing reaction block execution or leave a stale reaction", async () => {
    const h = await harness();
    const reactionGate = deferred();
    const originalAddReaction = h.delivery.addReaction.bind(h.delivery);
    h.delivery.addReaction = async (messageId, emojiType) => {
      if (emojiType === "Typing") await reactionGate.promise;
      return originalAddReaction(messageId, emojiType);
    };
    try {
      await expect(h.ingress.handle(messageEvent("slow-reaction", "@_user_1 run now"))).resolves.toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(h.runner.calls).toHaveLength(1);
      expect(h.store.getAllJobs()[0]!.executionStatus).toBe("succeeded");
      reactionGate.resolve();
      h.outbox.wake();
      await waitUntil(() => h.delivery.done.has("slow-reaction"));
      expect(h.delivery.activeTyping.has("slow-reaction")).toBe(false);
    } finally {
      reactionGate.resolve();
      h.scheduler.stop();
      await h.outbox.stop();
      h.store.close();
      await removeTemp(h.root);
    }
  });
});

async function oncallHarness() {
  const { config, root } = await tempConfig({ MAX_CONCURRENT_TURNS: 5, TURN_TIMEOUT_MS: 0 });
  const oncall: OncallConfig = {
    workspaces: [{ id: "infra", knowledgePaths: [], repositories: [] }, { id: "other", knowledgePaths: [], repositories: [] }],
    groupBindings: [{ chatId: "target-chat", workspaceId: "infra" }],
    privateBinding: { chatId: "private-chat", ownerOpenId: "user-1", workspaceId: "infra" },
    maxAttachmentBytes: 1024, agentEnvironment: {},
  };
  const store = new Store(config.STATE_DB_PATH, config.WORKSPACE_ROOT);
  const topics = new OncallStore(store);
  const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT, path.resolve("workspace-template"));
  await workspaces.initialize();
  const delivery = new FakeDelivery();
  const runner = new FakeRunner();
  const scheduler = new Scheduler(config, store, runner, workspaces);
  const ingress = new OncallIngress(config, oncall, "bot-open-id", store, delivery,
    { executionReady: () => scheduler.wake(), deliveryReady: () => undefined }, workspaces, runner);
  const close = async () => {
    scheduler.stop();
    await scheduler.waitForIdle();
    store.close();
    await removeTemp(root);
  };
  return { config, root, oncall, store, topics, workspaces, delivery, runner, scheduler, ingress, close };
}

describe("Oncall topic ingress", () => {
  it("records ordinary cross-user context, runs only on mention and freezes each trigger boundary", async () => {
    const h = await oncallHarness();
    try {
      const root = messageEvent("root", "@_user_1 investigate");
      expect(await h.ingress.handle(root)).toBe("accepted");
      const first = h.store.getAllJobs()[0]!;
      expect(await h.ingress.handle(messageEvent("ordinary", "more logs", { root_id: "root", mentions: [] }, { sender_id: { open_id: "user-2" } }))).toBe("accepted");
      expect(h.store.getAllJobs()).toHaveLength(1);
      expect(first.inputText).not.toContain("more logs");
      expect(await h.ingress.handle(messageEvent("follow-up", "@_user_1 use those logs", { root_id: "root" }, { sender_id: { open_id: "user-2" } }))).toBe("accepted");
      const second = h.store.getAllJobs()[1]!;
      expect(second.topicId).toBe(first.topicId);
      expect(second.requesterOpenId).toBe("user-2");
      const prompt = JSON.parse(second.inputText!);
      expect(prompt.oncall.context.map((item: { messageId: string }) => item.messageId)).toEqual(["root", "ordinary", "follow-up"]);
      expect(prompt.oncall.context[1]).toMatchObject({ sender: "user-2", text: "more logs" });
      expect(await h.ingress.handle(root)).toBe("duplicate");
      expect(h.store.getAllJobs()).toHaveLength(2);
      expect(h.topics.context("target-chat", "root", Number.MAX_SAFE_INTEGER)).toHaveLength(3);
      expect(await h.ingress.handle(messageEvent("later", "not in queued input", { root_id: "root", mentions: [] }))).toBe("accepted");
      expect(h.store.getJob(second.id)?.inputText).not.toContain("not in queued input");
    } finally { await h.close(); }
  });

  it("uses the same topic model in owner private chats and groups while keeping new topics isolated", async () => {
    const h = await oncallHarness();
    const privateMessage = (id: string, rootId?: string) => messageEvent(id, "@_user_1 analyze", { chat_id: "private-chat", chat_type: "p2p", root_id: rootId });
    try {
      await h.ingress.handle(privateMessage("private-root"));
      await h.ingress.handle(privateMessage("private-reply", "private-root"));
      await h.ingress.handle(privateMessage("new-private-root"));
      await h.ingress.handle(messageEvent("group-root", "@_user_1 analyze"));
      const jobs = h.store.getAllJobs();
      expect(jobs[0]?.topicId).toBe(jobs[1]?.topicId);
      expect(new Set([jobs[0]?.topicId, jobs[2]?.topicId, jobs[3]?.topicId]).size).toBe(3);
      expect(jobs.every((job) => h.topics.topic(job.topicId)?.workspace_id === "infra")).toBe(true);
      expect(await h.ingress.handle(messageEvent("foreign-private-user", "@_user_1 analyze", { chat_id: "private-chat", chat_type: "p2p" }, { sender_id: { open_id: "user-2" } }))).toBe("ignored");
      expect(h.store.getAllJobs()).toHaveLength(4);
    } finally { await h.close(); }
  });

  it("reads a previously posted alert and history on first mention and keeps subsequent root replies in that topic", async () => {
    const h = await oncallHarness();
    try {
      const alert = messageEvent("alert", "SNAPSHOT_NOT_READY", { mentions: [], create_time: "1" });
      h.delivery.topicHistories.set("alert", { events: [alert, messageEvent("older-log", "log details", { root_id: "alert", mentions: [], create_time: "2" })], truncated: false });
      await h.ingress.handle(alert);
      await h.ingress.handle(messageEvent("first-trigger", "@_user_1 investigate", { root_id: "alert", parent_id: "alert", create_time: "3" }));
      const first = h.store.getAllJobs()[0]!;
      expect(JSON.parse(first.inputText!).oncall.context.map((item: { messageId: string }) => item.messageId)).toEqual(["alert", "older-log", "first-trigger"]);
      await h.ingress.handle(messageEvent("second-trigger", "@_user_1 continue analysis", { root_id: "alert", parent_id: "alert" }));
      expect(h.store.getAllJobs()).toHaveLength(2);
      expect(h.store.getAllJobs()[1]?.topicId).toBe(first.topicId);
      expect(h.delivery.historyRequests).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("downloads ordinary log and image attachments on the next trigger and retains rich-text links", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("assets-root", "@_user_1 investigate"));
      h.delivery.fetchedFiles.set("log", Buffer.from("actual log contents"));
      h.delivery.fetchedImages.set("image", { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), extension: "png", mediaType: "image/png" });
      await h.ingress.handle(messageEvent("log", "", { root_id: "assets-root", mentions: [], message_type: "file", content: JSON.stringify({ file_key: "log-key", file_name: "../../failure.log" }) }));
      await h.ingress.handle(messageEvent("image", "", { root_id: "assets-root", mentions: [], message_type: "image", content: JSON.stringify({ image_key: "image-key" }) }));
      expect(h.delivery.fileRequests).toEqual([]);
      await h.ingress.handle(messageEvent("assets-trigger", "", { root_id: "assets-root", message_type: "post", content: JSON.stringify({ en_us: { title: "inspect", content: [[{ tag: "a", text: "evidence", href: "https://example.test/evidence" }]] } }) }));
      const job = h.store.getAllJobs()[1]!;
      const prompt = JSON.parse(job.inputText!);
      const log = prompt.oncall.context.find((item: { messageId: string }) => item.messageId === "log");
      const image = prompt.oncall.context.find((item: { messageId: string }) => item.messageId === "image");
      expect(log.files[0]).toMatchObject({ source_message_id: "log", name: "../../failure.log" });
      expect(log.files[0].path).toMatch(/^input-files\/[a-f0-9]+\.log$/);
      const workspace = h.store.getTopic(job.topicId)!.workspacePath;
      expect(await fs.readFile(path.join(workspace, log.files[0].path), "utf8")).toBe("actual log contents");
      expect(image.images[0]).toMatchObject({ media_type: "image/png", source_message_id: "image" });
      expect(job.inputText).toContain("https://example.test/evidence");
      expect(job.inputText).not.toContain("actual log contents");
      await expect(fs.stat(path.join(workspace, ".git"))).rejects.toThrow();
    } finally { await h.close(); }
  });

  it("pauses the entire topic and resumes with a reconciliation turn before retained queued requests", async () => {
    const h = await oncallHarness();
    h.runner.block = true;
    try {
      await h.ingress.handle(messageEvent("pause-root", "@_user_1 inspect"));
      await h.scheduler.start();
      await waitUntil(() => h.runner.calls.length === 1);
      await h.ingress.handle(messageEvent("queued-one", "@_user_1 follow one", { root_id: "pause-root" }));
      await h.ingress.handle(messageEvent("queued-two", "@_user_1 follow two", { root_id: "pause-root" }));
      const topicId = h.runner.calls[0]!.topic.id;
      const stop = messageEvent("stop", "停止", { root_id: "pause-root", mentions: [] });
      expect(await h.ingress.handle(stop)).toBe("accepted");
      await h.scheduler.waitForIdle();
      expect(h.runner.calls).toHaveLength(1);
      expect(h.store.getAllJobs().map((job) => job.executionStatus)).toEqual(["cancelled", "queued", "queued"]);
      expect(h.topics.topic(topicId)?.paused).toBe(1);
      expect(await h.ingress.handle(stop)).toBe("duplicate");
      await h.ingress.handle(messageEvent("paused-request", "@_user_1 another request", { root_id: "pause-root" }));
      await h.scheduler.waitForIdle();
      expect(h.runner.calls).toHaveLength(1);
      const resume = messageEvent("resume", "继续", { root_id: "pause-root", mentions: [] });
      await h.ingress.handle(resume);
      await waitUntil(() => h.runner.calls.length === 2);
      expect(h.runner.calls[1]?.job.feishuMessageId).toBe("resume");
      expect(JSON.parse(h.runner.calls[1]!.job.inputText!).oncall.recovery.instruction).toContain("禁止重放");
      expect(await h.ingress.handle(resume)).toBe("duplicate");
      h.runner.block = false;
      h.runner.gates[1]!.resolve();
      await h.scheduler.waitForIdle();
      expect(h.runner.calls.map((call) => call.job.feishuMessageId)).toEqual(["pause-root", "resume", "queued-one", "queued-two", "paused-request"]);
      expect(h.runner.peakConcurrent).toBe(1);
      expect(h.topics.topic(topicId)?.paused).toBe(0);
      expect(h.store.getAllJobs()).toHaveLength(5);
    } finally { await h.close(); }
  });

  it("switches a new private topic workspace without changing defaults for later topics or groups", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("switch", "@_user_1 切换工作区 other", { chat_id: "private-chat", chat_type: "p2p" }));
      await h.ingress.handle(messageEvent("new-default", "@_user_1 investigate", { chat_id: "private-chat", chat_type: "p2p" }));
      await h.ingress.handle(messageEvent("group-default", "@_user_1 investigate"));
      expect(h.store.getAllJobs().map((job) => h.topics.topic(job.topicId)?.workspace_id)).toEqual(["other", "infra", "infra"]);
      expect(h.oncall.workspaces.map((workspace) => workspace.id)).toEqual(["infra", "other"]);
    } finally { await h.close(); }
  });
});

describe("Oncall evidence continuity", () => {
  it("offers a private case to a later group question in the same workspace with its verification state intact", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("private-evidence", "@_user_1 SNAPSHOT_NOT_READY", { chat_id: "private-chat", chat_type: "p2p" }));
      const [job] = h.store.claimRunnableJobs(1);
      h.store.completeExecution(job!.id, { status: "succeeded", reply: "investigation recorded", caseSummary: {
        summary: "SNAPSHOT_NOT_READY in prior execution",
        conclusions: [{ text: "May involve snapshot provisioning", verification: "unverified" }],
        evidence: ["message:private-evidence"],
      } }, null);
      await h.ingress.handle(messageEvent("group-evidence", "@_user_1 SNAPSHOT_NOT_READY again"));
      const prompt = JSON.parse(h.store.getAllJobs()[1]!.inputText!);
      expect(prompt.oncall.relatedCases).toMatchObject([{
        topicId: job!.topicId,
        conclusions: [{ text: "May involve snapshot provisioning", verification: "unverified" }],
        evidence: ["message:private-evidence"],
      }]);
    } finally { await h.close(); }
  });

  it("keeps unavailable attachment and historical evidence as explicit gaps without claiming they were read", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("missing-log", "", { root_id: "missing-alert", mentions: [], message_type: "file", content: JSON.stringify({ file_key: "missing-key", file_name: "failure.log" }) }));
      await h.ingress.handle(messageEvent("missing-trigger", "@_user_1 investigate", { root_id: "missing-alert", parent_id: "missing-alert" }));
      const prompt = JSON.parse(h.store.getAllJobs()[0]!.inputText!);
      expect(prompt.oncall.historyGaps).toEqual(["无法读取话题历史，当前输入可能不完整。"]);
      const log = prompt.oncall.context.find((item: { messageId: string }) => item.messageId === "missing-log");
      expect(log.files).toBeUndefined();
      expect(log.gaps).toHaveLength(1);
      expect(log.gaps[0]).toContain("请勿假设已读取");
      expect(h.store.getAllJobs()[0]?.executionStatus).toBe("queued");
    } finally { await h.close(); }
  });
});

describe("Oncall repeated triggers and retained evidence", () => {
  it("accepts a mention-only reply as a request to analyze existing topic evidence", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("mention-root", "@_user_1 initial evidence"));
      await h.ingress.handle(messageEvent("mention-log", "new log details", { root_id: "mention-root", mentions: [] }));
      expect(await h.ingress.handle(messageEvent("mention-only", "@_user_1", { root_id: "mention-root" }))).toBe("accepted");
      expect(h.store.getAllJobs()).toHaveLength(2);
      const prompt = JSON.parse(h.store.getAllJobs()[1]!.inputText!);
      expect(prompt.text).toContain("本话题");
      expect(prompt.oncall.context.map((item: { messageId: string }) => item.messageId)).toEqual(["mention-root", "mention-log", "mention-only"]);
      expect(prompt.oncall.context[1].text).toBe("new log details");
    } finally { await h.close(); }
  });

  it.each(["preparing", "queued", "running"] as const)("does not duplicate an existing %s recovery job when a fresh message says continue", async (status) => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("resume-root", "@_user_1 inspect"));
      const topicId = h.store.getAllJobs()[0]!.topicId;
      const [active] = h.store.claimRunnableJobs(1);
      h.store.interruptExecution(active!.id, "interrupted");
      await h.ingress.handle(messageEvent("resume-original", "继续", { root_id: "resume-root", mentions: [] }));
      const recoveryId = h.topics.topic(topicId)!.resume_job_id!;
      if (status === "running") {
        expect(h.store.claimRunnableJobs(1)[0]?.id).toBe(recoveryId);
      } else if (status === "preparing") {
        h.store.database.prepare("UPDATE jobs SET execution_status = 'preparing', input_text = NULL WHERE id = ?").run(recoveryId);
        h.store.database.prepare("UPDATE oncall_topics SET paused = 1 WHERE topic_id = ?").run(topicId);
      }
      expect(h.store.getJob(recoveryId)?.executionStatus).toBe(status);
      const before = h.store.getAllJobs().length;
      await h.ingress.handle(messageEvent(`another-continue-${status}`, "@_user_1 继续", { root_id: "resume-root" }));
      expect(h.store.getAllJobs()).toHaveLength(before);
      expect(h.topics.topic(topicId)?.resume_job_id).toBe(recoveryId);
      expect(h.delivery.visibleReplies.at(-1)?.text).toMatch(/恢复.*(排队|执行|准备)/);
    } finally { await h.close(); }
  });

  it("retains all received context in the artifact and shows only the most recent hundred messages in the prompt", async () => {
    const h = await oncallHarness();
    try {
      await h.ingress.handle(messageEvent("long-root", "@_user_1 earliest evidence"));
      for (let index = 0; index < 105; index += 1) {
        await h.ingress.handle(messageEvent(`long-${index}`, `log item ${index}`, { root_id: "long-root", mentions: [] }));
      }
      await h.ingress.handle(messageEvent("long-trigger", "@_user_1 review all evidence", { root_id: "long-root" }));
      const job = h.store.getAllJobs()[1]!;
      const prompt = JSON.parse(job.inputText!);
      expect(prompt.oncall.context).toHaveLength(100);
      expect(prompt.oncall.context[0].messageId).toBe("long-6");
      expect(prompt.oncall.context.at(-1).messageId).toBe("long-trigger");
      const content = JSON.parse(await fs.readFile(path.join(h.store.getTopic(job.topicId)!.workspacePath, prompt.oncall.contextFile), "utf8"));
      expect(content).toHaveLength(107);
      expect(content[0]).toMatchObject({ messageId: "long-root", text: "earliest evidence" });
      expect(content.at(-1).messageId).toBe("long-trigger");
      expect(prompt.oncall.historyGaps.join(" ")).toContain("100");
      expect(prompt.oncall.historyGaps.join(" ")).toContain("contextFile");
    } finally { await h.close(); }
  });

  it("keeps successful attachments distinct when retrying a previously failed attachment from the same message", async () => {
    const h = await oncallHarness();
    let missingAvailable = false;
    const downloads: string[] = [];
    h.delivery.fetchImage = async (_messageId, imageKey) => {
      downloads.push(imageKey);
      if (imageKey === "second-image" && !missingAvailable) throw new Error("temporarily unavailable");
      return { data: Buffer.from(imageKey), extension: "png", mediaType: "image/png" };
    };
    try {
      await h.ingress.handle(messageEvent("cache-root", "@_user_1 inspect"));
      await h.ingress.handle(messageEvent("multi-image", "", { root_id: "cache-root", mentions: [], message_type: "post",
        content: JSON.stringify({ en_us: { title: "screenshots", content: [[{ tag: "img", image_key: "first-image" }, { tag: "img", image_key: "second-image" }]] } }) }));
      await h.ingress.handle(messageEvent("cache-first-trigger", "@_user_1 use screenshots", { root_id: "cache-root" }));
      const firstJob = h.store.getAllJobs()[1]!;
      const firstContext = JSON.parse(firstJob.inputText!).oncall.context.find((item: { messageId: string }) => item.messageId === "multi-image");
      expect(firstContext.images).toHaveLength(1);
      expect(firstContext.gaps).toHaveLength(1);
      missingAvailable = true;
      await h.ingress.handle(messageEvent("cache-retry-trigger", "@_user_1 read missing screenshot", { root_id: "cache-root" }));
      const retryJob = h.store.getAllJobs()[2]!;
      const retryContext = JSON.parse(retryJob.inputText!).oncall.context.find((item: { messageId: string }) => item.messageId === "multi-image");
      expect(retryContext.images).toHaveLength(2);
      expect(new Set(retryContext.images.map((image: { path: string }) => image.path)).size).toBe(2);
      const workspace = h.store.getTopic(retryJob.topicId)!.workspacePath;
      const contents = await Promise.all(retryContext.images.map((image: { path: string }) => fs.readFile(path.join(workspace, image.path), "utf8")));
      expect(contents.sort()).toEqual(["first-image", "second-image"]);
      expect(downloads.filter((key) => key === "first-image")).toHaveLength(1);
      expect(downloads.filter((key) => key === "second-image")).toHaveLength(2);
    } finally { await h.close(); }
  });
});

describe("Oncall stop during slow input preparation", () => {
  it("stops and aborts an active topic before a later request finishes downloading its attachment", async () => {
    const h = await oncallHarness();
    const download = deferred();
    let downloading = false;
    let preparation: Promise<unknown> | undefined;
    let stopping: Promise<unknown> | undefined;
    h.delivery.fetchFile = async () => {
      downloading = true;
      await download.promise;
      return Buffer.from("delayed logs");
    };
    h.runner.block = true;
    try {
      await h.ingress.handle(messageEvent("slow-root", "@_user_1 investigate"));
      await h.scheduler.start();
      await waitUntil(() => h.runner.calls.length === 1);
      const active = h.runner.calls[0]!.job;
      await h.ingress.handle(messageEvent("slow-log", "", { root_id: "slow-root", mentions: [], message_type: "file", content: JSON.stringify({ file_key: "slow-key", file_name: "slow.log" }) }));
      preparation = h.ingress.handle(messageEvent("slow-followup", "@_user_1 also read the log", { root_id: "slow-root" }));
      await waitUntil(() => downloading);
      expect(h.store.getAllJobs()[1]?.executionStatus).toBe("preparing");
      let stopped = false;
      stopping = h.ingress.handle(messageEvent("slow-stop", "停止", { root_id: "slow-root", mentions: [] })).then((result) => {
        stopped = true;
        return result;
      });
      await waitUntil(() => stopped, 500);
      expect(h.topics.topic(active.topicId)?.paused).toBe(1);
      expect(h.runner.abortCalls).toEqual([active.id]);
      await h.scheduler.waitForIdle();
      expect(h.store.getAllJobs()[0]?.executionStatus).toBe("cancelled");
      expect(h.store.getAllJobs()[1]?.executionStatus).toBe("preparing");
      download.resolve();
      await preparation;
      await h.scheduler.waitForIdle();
      expect(h.store.getAllJobs()[1]?.executionStatus).toBe("queued");
      expect(h.topics.topic(active.topicId)?.paused).toBe(1);
      expect(h.runner.calls).toHaveLength(1);
    } finally {
      download.resolve();
      await Promise.allSettled([preparation, stopping]);
      await h.close();
    }
  });

  it("does not clear a newer stop when a pending recovery finishes preparing its downloaded input", async () => {
    const h = await oncallHarness();
    const download = deferred();
    let downloading = false;
    let preparation: Promise<unknown> | undefined;
    let stopping: Promise<unknown> | undefined;
    h.delivery.fetchFile = async () => {
      downloading = true;
      await download.promise;
      return Buffer.from("recovery evidence");
    };
    try {
      await h.ingress.handle(messageEvent("recovery-slow-root", "@_user_1 investigate"));
      const [active] = h.store.claimRunnableJobs(1);
      h.store.interruptExecution(active!.id, "interrupted");
      await h.ingress.handle(messageEvent("recovery-slow-log", "", { root_id: "recovery-slow-root", mentions: [], message_type: "file", content: JSON.stringify({ file_key: "recovery-key", file_name: "recovery.log" }) }));
      await h.scheduler.start();
      preparation = h.ingress.handle(messageEvent("recovery-slow-resume", "继续", { root_id: "recovery-slow-root", mentions: [] }));
      await waitUntil(() => downloading);
      const recovery = h.store.getAllJobs()[1]!;
      expect(recovery.executionStatus).toBe("preparing");
      expect(h.topics.topic(active!.topicId)?.resume_job_id).toBe(recovery.id);
      let stopped = false;
      stopping = h.ingress.handle(messageEvent("recovery-new-stop", "停止", { root_id: "recovery-slow-root", mentions: [] })).then((result) => {
        stopped = true;
        return result;
      });
      await waitUntil(() => stopped, 500);
      expect(h.topics.topic(active!.topicId)).toMatchObject({ paused: 1, pause_reason: "user_stopped", resume_job_id: null });
      download.resolve();
      await preparation;
      await h.scheduler.waitForIdle();
      expect(h.topics.topic(active!.topicId)).toMatchObject({ paused: 1, pause_reason: "user_stopped", resume_job_id: null });
      expect(h.store.getJob(recovery.id)?.executionStatus).toBe("queued");
      expect(h.runner.calls).toEqual([]);
      expect(h.store.claimRunnableJobs(5)).toEqual([]);
    } finally {
      download.resolve();
      await Promise.allSettled([preparation, stopping]);
      await h.close();
    }
  });
});
