import type { Readable } from "node:stream";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { ReplyReceipt } from "../contracts.js";
import type { DesiredReaction } from "../jobs/status-view.js";
export { stableIngressReplyUuid } from "../jobs/delivery-ids.js";

const PERMANENT_MESSAGE_CODES = new Set([230004, 230006, 230011, 230031]);

export class PermanentStatusMessageError extends Error {
  constructor() {
    super("Status message can no longer be edited");
    this.name = "PermanentStatusMessageError";
  }
}

function assertApiResponse(
  response: { code?: number; msg?: string },
  operation: string,
  permanentMessageFailure = false,
): void {
  const code = response.code ?? 0;
  if (code === 0) return;
  if (permanentMessageFailure && PERMANENT_MESSAGE_CODES.has(code)) throw new PermanentStatusMessageError();
  throw new Error(`${operation} failed with application code ${code || "unknown"}`);
}

export interface DownloadedImage {
  data: Buffer;
  extension: "png" | "jpg" | "gif" | "webp";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export type ReferencedMessage =
  | { type: "text"; text: string }
  | { type: "image"; imageKey: string };

export interface MessageReaction {
  reactionId: string;
  emojiType: DesiredReaction;
}

function identifyImage(data: Buffer): Omit<DownloadedImage, "data"> {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mediaType: "image/png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { extension: "jpg", mediaType: "image/jpeg" };
  }
  const signature = data.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { extension: "gif", mediaType: "image/gif" };
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mediaType: "image/webp" };
  }
  throw new Error("unsupported image format");
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error("image exceeds size limit");
    }
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("image is empty");
  return Buffer.concat(chunks, total);
}

export interface FeishuDelivery {
  addReaction(messageId: string, emojiType: DesiredReaction): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  listReactions(messageId: string): Promise<MessageReaction[]>;
  reply(messageId: string, text: string, uuid: string): Promise<ReplyReceipt>;
  replyCard(messageId: string, cardJson: string, uuid: string): Promise<ReplyReceipt>;
  updateCard(messageId: string, cardJson: string): Promise<void>;
  readCard(messageId: string): Promise<string>;
  fetchReferencedMessage(messageId: string): Promise<ReferencedMessage>;
  fetchImage(messageId: string, imageKey: string, maxBytes: number): Promise<DownloadedImage>;
}

export class LarkFeishuDelivery implements FeishuDelivery {
  constructor(
    private readonly client: Client,
    private readonly appId?: string,
  ) {}

  async addReaction(messageId: string, emojiType: DesiredReaction): Promise<string> {
    const response = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    assertApiResponse(response, "add reaction");
    const reactionId = response.data?.reaction_id;
    if (!reactionId) throw new Error("add reaction returned no reaction_id");
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    assertApiResponse(response, "remove reaction");
  }

  async listReactions(messageId: string): Promise<MessageReaction[]> {
    const reactions: MessageReaction[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.client.im.v1.messageReaction.list({
        path: { message_id: messageId },
        params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      assertApiResponse(response, "list reactions");
      for (const item of response.data?.items ?? []) {
        const emojiType = item.reaction_type?.emoji_type;
        if (
          item.operator?.operator_type === "app" &&
          (!this.appId || item.operator.operator_id === this.appId) &&
          item.reaction_id &&
          (emojiType === "Typing" || emojiType === "DONE" || emojiType === "CrossMark" || emojiType === "Alarm")
        ) {
          reactions.push({ reactionId: item.reaction_id, emojiType });
        }
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return reactions;
  }

  async reply(messageId: string, text: string, uuid: string): Promise<ReplyReceipt> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
        reply_in_thread: true,
        uuid,
      },
    });
    assertApiResponse(response, "reply message");
    const replyMessageId = response.data?.message_id;
    if (!replyMessageId) throw new Error("reply returned no message_id");
    return { messageId: replyMessageId, parentId: response.data?.parent_id, rootId: response.data?.root_id };
  }

  async replyCard(messageId: string, cardJson: string, uuid: string): Promise<ReplyReceipt> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: cardJson,
        reply_in_thread: true,
        uuid,
      },
    });
    assertApiResponse(response, "reply card");
    const replyMessageId = response.data?.message_id;
    if (!replyMessageId) throw new Error("reply card returned no message_id");
    return { messageId: replyMessageId, parentId: response.data?.parent_id, rootId: response.data?.root_id };
  }

  async updateCard(messageId: string, cardJson: string): Promise<void> {
    const response = await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
    assertApiResponse(response, "update card", true);
  }

  async readCard(messageId: string): Promise<string> {
    const response = await this.client.im.v1.message.get({ path: { message_id: messageId } });
    assertApiResponse(response, "read card");
    const item = response.data?.items?.[0];
    if (item?.msg_type !== "interactive" || !item.body?.content) throw new Error("message card is unavailable");
    return item.body.content;
  }

  async fetchReferencedMessage(messageId: string): Promise<ReferencedMessage> {
    const response = await this.client.im.v1.message.get({ path: { message_id: messageId } });
    assertApiResponse(response, "fetch message");
    const item = response.data?.items?.[0];
    if (!item?.body?.content) throw new Error("referenced message is unavailable");
    const parsed = JSON.parse(item.body.content) as { text?: unknown; image_key?: unknown };
    if (item.msg_type === "text" && typeof parsed.text === "string") return { type: "text", text: parsed.text };
    if (item.msg_type === "image" && typeof parsed.image_key === "string" && parsed.image_key) {
      return { type: "image", imageKey: parsed.image_key };
    }
    throw new Error("referenced message is not supported input");
  }

  async fetchImage(messageId: string, imageKey: string, maxBytes: number): Promise<DownloadedImage> {
    const response = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    const data = await readLimited(response.getReadableStream(), maxBytes);
    return { data, ...identifyImage(data) };
  }
}

function firstText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return null;
}

export function cardStatusProjection(cardJson: string): { title: string; status: string } {
  const card = JSON.parse(cardJson) as Record<string, unknown>;
  const header = typeof card.header === "object" && card.header !== null
    ? card.header as Record<string, unknown>
    : null;
  const headerTitle = header && typeof header.title === "object" && header.title !== null
    ? header.title as Record<string, unknown>
    : null;
  const title = typeof card.title === "string"
    ? card.title
    : typeof headerTitle?.content === "string" ? headerTitle.content : null;
  const elements = Array.isArray(card.elements) ? card.elements : [];
  const status = firstText(elements[0]);
  if (title === null || status === null) throw new Error("status card projection is unavailable");
  return { title, status };
}
