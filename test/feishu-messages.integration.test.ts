import { Readable } from "node:stream";
import type { Client } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { cardStatusProjection, LarkFeishuDelivery, PermanentStatusMessageError } from "../src/feishu/messages.js";

function resourceClient(chunks: Buffer[]) {
  const get = vi.fn(async () => ({
    getReadableStream: () => Readable.from(chunks),
    headers: {},
  }));
  const client = { im: { v1: { messageResource: { get } } } } as unknown as Client;
  return { client, get };
}

describe("Feishu delivery adapter", () => {
  it("downloads a supported user image through the message resource API", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const { client, get } = resourceClient([png.subarray(0, 4), png.subarray(4)]);
    const delivery = new LarkFeishuDelivery(client);

    await expect(delivery.fetchImage("message-id", "image-key", 1024)).resolves.toEqual({
      data: png,
      extension: "png",
      mediaType: "image/png",
    });
    expect(get).toHaveBeenCalledWith({
      path: { message_id: "message-id", file_key: "image-key" },
      params: { type: "image" },
    });
  });

  it("rejects oversized or unsupported image resources", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oversized = new LarkFeishuDelivery(resourceClient([png]).client);
    await expect(oversized.fetchImage("message-id", "image-key", 7)).rejects.toThrow(/size limit/);

    const unsupported = new LarkFeishuDelivery(resourceClient([Buffer.from("not-an-image")]).client);
    await expect(unsupported.fetchImage("message-id", "image-key", 1024)).rejects.toThrow(/unsupported image/);
  });

  it("recognizes an image when reading a referenced message", async () => {
    const get = vi.fn(async () => ({
      code: 0,
      data: { items: [{ msg_type: "image", body: { content: JSON.stringify({ image_key: "image-key" }) } }] },
    }));
    const client = { im: { v1: { message: { get } } } } as unknown as Client;
    const delivery = new LarkFeishuDelivery(client);

    await expect(delivery.fetchReferencedMessage("message-id")).resolves.toEqual({
      type: "image",
      imageKey: "image-key",
    });
  });

  it("reconciles only reactions owned by the configured app", async () => {
    const create = vi.fn(async () => ({ code: 0, data: { reaction_id: "new-reaction" } }));
    const list = vi.fn(async () => ({
      code: 0,
      data: {
        items: [
          { reaction_id: "own", operator: { operator_id: "app-id", operator_type: "app" }, reaction_type: { emoji_type: "DONE" } },
          { reaction_id: "other", operator: { operator_id: "other-app", operator_type: "app" }, reaction_type: { emoji_type: "DONE" } },
          { reaction_id: "user", operator: { operator_id: "user", operator_type: "user" }, reaction_type: { emoji_type: "DONE" } },
        ],
        has_more: false,
        page_token: "",
      },
    }));
    const client = { im: { v1: { messageReaction: { create, list } } } } as unknown as Client;
    const delivery = new LarkFeishuDelivery(client, "app-id");
    await expect(delivery.listReactions("message-id")).resolves.toEqual([{ reactionId: "own", emojiType: "DONE" }]);
    await expect(delivery.addReaction("message-id", "Alarm")).resolves.toBe("new-reaction");
  });

  it("classifies a withdrawn status message as permanently uneditable", async () => {
    const patch = vi.fn(async () => ({ code: 230011, msg: "withdrawn" }));
    const client = { im: { v1: { message: { patch } } } } as unknown as Client;
    const delivery = new LarkFeishuDelivery(client);
    await expect(delivery.updateCard("message-id", "{}")).rejects.toBeInstanceOf(PermanentStatusMessageError);
  });

  it("creates, patches, and reads an interactive status card", async () => {
    const reply = vi.fn(async () => ({
      code: 0,
      data: { message_id: "card-message", parent_id: "source", root_id: "source" },
    }));
    const patch = vi.fn(async () => ({ code: 0 }));
    const get = vi.fn(async () => ({
      code: 0,
      data: { items: [{
        msg_type: "interactive",
        body: { content: '{"title":"执行中","elements":[[{"tag":"text","text":"执行中，已运行 2 分钟。"}]]}' },
      }] },
    }));
    const client = { im: { v1: { message: { reply, patch, get } } } } as unknown as Client;
    const delivery = new LarkFeishuDelivery(client);
    const cardJson = JSON.stringify({
      header: { title: { tag: "plain_text", content: "执行中" }, template: "blue" },
      elements: [{ tag: "markdown", content: "执行中，已运行 2 分钟。" }],
    });

    await expect(delivery.replyCard("source", cardJson, "stable-uuid")).resolves.toEqual({
      messageId: "card-message",
      parentId: "source",
      rootId: "source",
    });
    expect(reply).toHaveBeenCalledWith({
      path: { message_id: "source" },
      data: { msg_type: "interactive", content: cardJson, reply_in_thread: true, uuid: "stable-uuid" },
    });
    await delivery.updateCard("card-message", cardJson);
    expect(patch).toHaveBeenCalledWith({
      path: { message_id: "card-message" },
      data: { content: cardJson },
    });
    const readBack = await delivery.readCard("card-message");
    expect(cardStatusProjection(readBack)).toEqual(cardStatusProjection(cardJson));
  });
});

describe("Oncall evidence downloads", () => {
  it("downloads a log attachment as a file and enforces the configured byte limit", async () => {
    const content = Buffer.from("line one\nline two\n");
    const { client, get } = resourceClient([content.subarray(0, 4), content.subarray(4)]);
    const delivery = new LarkFeishuDelivery(client);
    expect(await delivery.fetchFile("log-message", "log-key", content.length)).toEqual(content);
    expect(get).toHaveBeenCalledWith({ path: { message_id: "log-message", file_key: "log-key" }, params: { type: "file" } });
    await expect(delivery.fetchFile("log-message", "log-key", content.length - 1)).rejects.toThrow(/size limit/);
  });

  it("reads ordered thread history while rejecting foreign, deleted and duplicated messages and reporting gaps", async () => {
    const item = (id: string, time: string) => ({ message_id: id, chat_id: "chat", root_id: "root",
      thread_id: "thread", create_time: time, sender: { id: "user", sender_type: "user" },
      msg_type: "text", body: { content: JSON.stringify({ text: id }) } });
    const get = vi.fn(async () => ({ code: 0, data: { items: [item("root", "1")] } }));
    const list = vi.fn(async () => ({ code: 0, data: { has_more: true, items: [
      item("third", "3"), item("second", "2"), item("root", "1"),
      { ...item("foreign", "4"), chat_id: "other-chat" },
      { ...item("deleted", "5"), deleted: true },
      { ...item("unrelated", "6"), root_id: "other-root", thread_id: "other-thread" },
    ] } }));
    const delivery = new LarkFeishuDelivery({ im: { v1: { message: { get, list } } } } as unknown as Client);
    const history = await delivery.fetchTopicHistory("chat", "root");
    expect(history.truncated).toBe(true);
    expect(history.events.map((event) => event.message.message_id)).toEqual(["root", "second", "third"]);
    expect(history.events.every((event) => event.sender.sender_id?.open_id === "user")).toBe(true);
    expect(list).toHaveBeenCalledWith({ params: { container_id_type: "thread", container_id: "thread", page_size: 50, sort_type: "ByCreateTimeDesc" } });
    await expect(delivery.fetchTopicHistory("another-chat", "root")).rejects.toThrow(/unavailable/);
  });
});
