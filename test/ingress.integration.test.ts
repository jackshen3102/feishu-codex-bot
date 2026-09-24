import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CancellationController } from "../src/control/cancellation.js";
import { Store } from "../src/db/store.js";
import { OutboxWorker } from "../src/delivery/outbox-worker.js";
import { FeishuIngress } from "../src/feishu/ingress.js";
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
      expect(h.delivery.visibleReplies.some((reply) => reply.text.includes("最大 5 MiB"))).toBe(true);
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

      const finalA = h.delivery.visibleReplies.find((reply) => reply.sourceMessageId === "a")!;
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
      expect(h.delivery.visibleReplies.map((reply) => reply.text)).toContain("fixed final reply");
      expect(h.delivery.done.has("m1")).toBe(true);
      expect(h.store.count("topics")).toBe(1);
      expect(h.store.count("message_bindings")).toBe(3);
      const job = h.store.getAllJobs()[0]!;
      expect(h.runner.calls[0]!.job.executionMode).toBe("sandboxed");
      expect(job.executionMode).toBe("sandboxed");
      expect(job.executionStatus).toBe("succeeded");
      expect(job.inputText).toBeNull();
      expect(job.resultText).toBeNull();
      expect(h.store.getDelivery(job.id, "status")?.messageId).toBe("reply-1");
      expect(h.store.getDelivery(job.id, "final_reply")?.messageId).toBe("reply-2");
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
      expect(h.store.count("message_bindings")).toBe(4);
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
      expect(h.delivery.visibleReplies.filter((reply) => reply.sourceMessageId === "same")).toHaveLength(1);

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
