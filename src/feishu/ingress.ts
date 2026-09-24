import { buildTrustedPrompt } from "../agent/prompt.js";
import { containsProtectedCredential, type AppConfig } from "../config.js";
import type { CancellationController } from "../control/cancellation.js";
import type { FeishuMessageEvent, TrustedFeishuInput } from "../contracts.js";
import type { Store } from "../db/store.js";
import { stableIngressReplyUuid } from "../jobs/delivery-ids.js";
import { errorKind, logger } from "../logging.js";
import type { WorkspaceManager } from "../workspaces.js";
import type { FeishuDelivery } from "./messages.js";
import { bestEffort } from "./reactions.js";

const MAX_INPUT_BYTES = 262_144;
const EMPTY_INPUT_REPLY = "消息内容为空，请补充文本后重试。";
const LARGE_INPUT_REPLY = "消息过长，请缩短后重试。";
const REFERENCE_FAILURE_REPLY = "无法读取引用消息，请直接粘贴文本后重试。";
const PROTECTED_INPUT_REPLY = "消息包含受保护内容，已拒绝处理。";
const IMAGE_INPUT_REPLY = "请查看并分析我发送的图片。";
const IMAGE_FAILURE_REPLY = "无法读取图片，请重新发送 PNG、JPEG、GIF 或 WebP 图片（最大 5 MiB）。";
const RICH_TEXT_FAILURE_REPLY = "无法读取富文本消息，请改为发送文字或图片后重试。";
const UNSUPPORTED_INPUT_REPLY = "暂不支持这种消息类型，请发送文字、图片，或图片加文字。";
const NEW_PRIVATE_TOPIC_COMMAND = "新会话";
const NEW_PRIVATE_TOPIC_REPLY = "请直接发送新的独立消息开始任务；继续已有任务请在原话题内回复。";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type IngressResult = "ignored" | "duplicate" | "accepted" | "rejected";

export interface IngressSignals {
  executionReady(): void;
  deliveryReady(): void;
}

export class FeishuIngress {
  constructor(
    private readonly config: AppConfig,
    private readonly botOpenId: string,
    private readonly store: Store,
    private readonly delivery: FeishuDelivery,
    private readonly signals: IngressSignals,
    private readonly workspaces: WorkspaceManager,
    private readonly cancellation: CancellationController,
  ) {}

  async handle(event: FeishuMessageEvent): Promise<IngressResult> {
    const { message, sender } = event;
    const requesterOpenId = sender.sender_id?.open_id;
    const isTargetGroup = message.chat_id === this.config.FEISHU_CHAT_ID && message.chat_type === "group";
    const isTargetPrivate = message.chat_id === this.config.FEISHU_PRIVATE_CHAT_ID && message.chat_type === "p2p";
    const isText = message.message_type === "text";
    const isImage = message.message_type === "image";
    const isPost = message.message_type === "post";
    if (
      (!isTargetGroup && !isTargetPrivate) ||
      sender.sender_type !== "user" ||
      !requesterOpenId
    ) {
      return "ignored";
    }

    const ownMention = message.mentions?.find((mention) => mention.id.open_id === this.botOpenId);
    const boundTopic = this.store.findBoundTopic(message.chat_id, message.parent_id, message.root_id);
    if (!isText && !isImage && !isPost) {
      if (isTargetPrivate || ownMention || boundTopic) {
        await this.reject(message.message_id, UNSUPPORTED_INPUT_REPLY, "unsupported-input");
        return "rejected";
      }
      return "ignored";
    }
    if (isTargetGroup && (isText || isPost ? !ownMention && !boundTopic : !boundTopic)) return "ignored";

    const referencedMessageId = message.parent_id ?? message.root_id;
    let text: string;
    let referencedText: string | undefined;
    let pendingImages: Array<{ sourceMessageId: string; imageKey: string }>;

    if (isText || isPost) {
      const post = isPost ? this.parsePost(message.content, message.mentions) : null;
      const rawText = isText ? this.parseText(message.content) : post?.text ?? null;
      if (isPost && !post) {
        await this.reject(message.message_id, RICH_TEXT_FAILURE_REPLY, "post-invalid");
        return "rejected";
      }
      if (rawText === null) return "ignored";
      pendingImages = (post?.imageKeys ?? []).map((imageKey) => ({
        sourceMessageId: message.message_id,
        imageKey,
      }));
      text = ownMention ? rawText.split(ownMention.key).join("").trim() : rawText.trim();
      if (text.length === 0 && pendingImages.length > 0) text = IMAGE_INPUT_REPLY;
      if (isTargetPrivate && isText && text === NEW_PRIVATE_TOPIC_COMMAND) {
        await this.reject(message.message_id, NEW_PRIVATE_TOPIC_REPLY, "new-private-topic");
        return "accepted";
      }
      if (
        await this.cancellation.handle({
          messageId: message.message_id,
          chatId: message.chat_id,
          requesterOpenId,
          referencedMessageId,
          text,
        })
      ) {
        this.signals.executionReady();
        this.signals.deliveryReady();
        return "accepted";
      }
      if (text.length === 0) {
        await this.reject(message.message_id, EMPTY_INPUT_REPLY, "empty");
        return "rejected";
      }
      if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
        await this.reject(message.message_id, LARGE_INPUT_REPLY, "too-large");
        return "rejected";
      }
      if (containsProtectedCredential(this.config, text)) {
        await this.reject(message.message_id, PROTECTED_INPUT_REPLY, "protected-content");
        return "rejected";
      }
    } else {
      const imageKey = this.parseImageKey(message.content);
      if (!imageKey) {
        await this.reject(message.message_id, IMAGE_FAILURE_REPLY, "image-invalid");
        return "rejected";
      }
      text = IMAGE_INPUT_REPLY;
      pendingImages = [{ sourceMessageId: message.message_id, imageKey }];
    }

    if (isText && !boundTopic && referencedMessageId) {
      let referenced;
      try {
        referenced = await this.delivery.fetchReferencedMessage(referencedMessageId);
      } catch {
        await this.reject(message.message_id, REFERENCE_FAILURE_REPLY, "reference-unreadable");
        return "rejected";
      }
      if (referenced.type === "text") {
        referencedText = referenced.text;
        if (containsProtectedCredential(this.config, referencedText)) {
          await this.reject(message.message_id, PROTECTED_INPUT_REPLY, "protected-content");
          return "rejected";
        }
      } else {
        pendingImages = [{ sourceMessageId: referencedMessageId, imageKey: referenced.imageKey }];
      }
    }

    const base: TrustedFeishuInput = {
      source: "feishu",
      chat_id: message.chat_id,
      message_id: message.message_id,
      sender_open_id: requesterOpenId,
      ...(referencedMessageId ? { referenced_message_id: referencedMessageId } : {}),
      text,
    };
    const accepted = this.store.acceptJob({
      messageId: message.message_id,
      chatId: message.chat_id,
      requesterOpenId,
      parentId: message.parent_id,
      rootId: message.root_id,
      allowNewTopic: isTargetPrivate || Boolean(ownMention),
      executionMode: isTargetPrivate ? "unrestricted" : "sandboxed",
      existingTopicInput: pendingImages.length > 0
        ? null
        : buildTrustedPrompt({ ...base, ...(referencedText ? { referenced_text: referencedText } : {}) }),
      newTopicInput: pendingImages.length > 0
        ? null
        : buildTrustedPrompt({ ...base, ...(referencedText ? { referenced_text: referencedText } : {}) }),
    });

    if (accepted.duplicate) return "duplicate";
    if (!accepted.accepted || !accepted.job || !accepted.topic) return "ignored";
    this.signals.deliveryReady();

    if (pendingImages.length > 0) {
      const writtenStorageIds: string[] = [];
      try {
        const images = [];
        for (const [index, pendingImage] of pendingImages.entries()) {
          const downloadedImage = await this.delivery.fetchImage(
            pendingImage.sourceMessageId,
            pendingImage.imageKey,
            MAX_IMAGE_BYTES,
          );
          const storageId = pendingImages.length === 1
            ? pendingImage.sourceMessageId
            : `${pendingImage.sourceMessageId}:${index}`;
          const imagePath = await this.workspaces.writeInputImage(
            accepted.topic.workspacePath,
            storageId,
            downloadedImage,
          );
          writtenStorageIds.push(storageId);
          images.push({
            path: imagePath,
            media_type: downloadedImage.mediaType,
            source_message_id: pendingImage.sourceMessageId,
          });
        }
        this.store.markInputReady(
          accepted.job.id,
          buildTrustedPrompt({
            ...base,
            ...(referencedText ? { referenced_text: referencedText } : {}),
            images,
          }),
        );
      } catch (error) {
        const current = this.store.getJob(accepted.job.id);
        if (writtenStorageIds.length > 0) {
          try {
            await this.workspaces.removeInputImages(accepted.topic.workspacePath, writtenStorageIds);
          } catch (cleanupError) {
            logger.error("job_input_cleanup_failed", {
              jobId: accepted.job.id,
              topicId: accepted.topic.id,
              errorKind: errorKind(cleanupError),
            });
          }
        }
        if (current?.executionStatus === "cancelled") {
          this.signals.deliveryReady();
          return "accepted";
        }
        logger.error("job_input_prepare_failed", {
          jobId: accepted.job.id,
          topicId: accepted.topic.id,
          errorKind: errorKind(error),
        });
        if (current?.executionStatus === "preparing") {
          this.store.failInputPreparation(accepted.job.id, IMAGE_FAILURE_REPLY, "image_input_failed");
        }
        this.signals.deliveryReady();
        return "rejected";
      }
    }

    const job = this.store.getJob(accepted.job.id);
    logger.info("job_queued", {
      messageId: message.message_id,
      topicId: accepted.topic.id,
      jobId: accepted.job.id,
      status: job?.executionStatus,
      version: job?.statusVersion,
    });
    this.signals.deliveryReady();
    this.signals.executionReady();
    return "accepted";
  }

  private parseText(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : null;
    } catch {
      return null;
    }
  }

  private parseImageKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as { image_key?: unknown };
      return typeof parsed.image_key === "string" && parsed.image_key ? parsed.image_key : null;
    } catch {
      return null;
    }
  }

  private parsePost(
    content: string,
    mentions: FeishuMessageEvent["message"]["mentions"],
  ): { text: string; imageKeys: string[] } | null {
    try {
      const parsed = record(JSON.parse(content));
      if (!parsed) return null;
      const body = record(parsed.zh_cn) ?? record(parsed.en_us) ?? record(parsed.ja_jp) ?? parsed;
      const title = typeof body.title === "string" ? body.title : "";
      if (!Array.isArray(body.content)) return title.trim() ? { text: title.trim(), imageKeys: [] } : null;

      const imageKeys: string[] = [];
      const lines: string[] = [];
      for (const paragraph of body.content) {
        if (!Array.isArray(paragraph)) continue;
        let line = "";
        for (const value of paragraph) {
          const element = record(value);
          if (!element) continue;
          if (element.tag === "img") {
            if (typeof element.image_key === "string" && element.image_key) imageKeys.push(element.image_key);
            continue;
          }
          if (element.tag === "at") {
            const userId = typeof element.user_id === "string" ? element.user_id : "";
            const mention = mentions?.find((item) => item.id.open_id === userId);
            if (mention) line += mention.key;
            else if (typeof element.user_name === "string" && element.user_name) line += `@${element.user_name}`;
            continue;
          }
          if (typeof element.text === "string") line += element.text;
        }
        lines.push(line);
      }
      const text = [title, ...lines].join("\n").trim();
      return text || imageKeys.length > 0 ? { text, imageKeys } : null;
    } catch {
      return null;
    }
  }

  private async reject(messageId: string, text: string, kind: string): Promise<void> {
    await bestEffort(() => this.delivery.reply(messageId, text, stableIngressReplyUuid(messageId, kind)));
  }
}
