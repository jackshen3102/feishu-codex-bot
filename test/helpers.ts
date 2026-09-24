import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProgressReporter, AgentSessionReporter, TurnRunner } from "../src/agent/runner.js";
import type { CodexAppConfig } from "../src/config.js";
import type { AgentProgressUpdate, FeishuMessageEvent, Job, ReplyReceipt, Topic, TurnReply } from "../src/contracts.js";
import type {
  DownloadedImage,
  FeishuDelivery,
  MessageReaction,
  ReferencedMessage,
} from "../src/feishu/messages.js";
import type { DesiredReaction } from "../src/jobs/status-view.js";

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function tempConfig(
  overrides: Partial<CodexAppConfig> = {},
): Promise<{ config: CodexAppConfig; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-bot-"));
  const config: CodexAppConfig = {
    AGENT_BACKEND: "codex",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret-test-value",
    FEISHU_CHAT_ID: "target-chat",
    FEISHU_PRIVATE_CHAT_ID: "private-chat",
    CODEX_HOME: path.join(root, "codex-home"),
    STATE_DB_PATH: path.join(root, "state.db"),
    WORKSPACE_ROOT: path.join(root, "workspaces"),
    MAX_CONCURRENT_TURNS: 4,
    TURN_TIMEOUT_MS: 60_000,
    WORKSPACE_RETENTION_DAYS: 7,
    JOB_RETENTION_DAYS: 90,
    ...overrides,
  };
  return { config, root };
}

export async function removeTemp(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

export function messageEvent(
  messageId: string,
  text: string,
  overrides: Partial<FeishuMessageEvent["message"]> = {},
  senderOverrides: Partial<FeishuMessageEvent["sender"]> = {},
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: "user-1" },
      sender_type: "user",
      ...senderOverrides,
    },
    message: {
      message_id: messageId,
      chat_id: "target-chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions: [{ key: "@_user_1", id: { open_id: "bot-open-id" }, name: "bot" }],
      ...overrides,
    },
  };
}

export class FakeDelivery implements FeishuDelivery {
  readonly timeline: string[] = [];
  readonly visibleReplies: Array<{ sourceMessageId: string; text: string; uuid: string; messageId: string }> = [];
  readonly visibleCards: Array<{ sourceMessageId: string; cardJson: string; uuid: string; messageId: string }> = [];
  readonly replyAttempts: Array<{ sourceMessageId: string; text: string; uuid: string }> = [];
  readonly cardReplyAttempts: Array<{ sourceMessageId: string; cardJson: string; uuid: string }> = [];
  readonly cardUpdateAttempts: Array<{ messageId: string; cardJson: string }> = [];
  readonly fetchedText = new Map<string, string>();
  readonly referencedImages = new Map<string, string>();
  readonly fetchedImages = new Map<string, DownloadedImage>();
  readonly imageRequests: Array<{ messageId: string; imageKey: string; maxBytes: number }> = [];
  readonly activeTyping = new Map<string, string>();
  readonly done = new Set<string>();
  readonly failed = new Set<string>();
  readonly interrupted = new Set<string>();
  readonly reactions = new Map<string, MessageReaction[]>();
  private readonly receipts = new Map<string, ReplyReceipt>();
  failAfterAcceptOnce = false;

  async addReaction(messageId: string, emojiType: DesiredReaction): Promise<string> {
    const current = this.reactions.get(messageId) ?? [];
    const id = `reaction-${messageId}-${current.length + 1}`;
    current.push({ reactionId: id, emojiType });
    this.reactions.set(messageId, current);
    if (emojiType === "Typing") this.activeTyping.set(messageId, id);
    if (emojiType === "DONE") this.done.add(messageId);
    if (emojiType === "CrossMark") this.failed.add(messageId);
    if (emojiType === "Alarm") this.interrupted.add(messageId);
    this.timeline.push(`reaction:${messageId}:${emojiType}`);
    return id;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const current = this.reactions.get(messageId) ?? [];
    const removed = current.find((item) => item.reactionId === reactionId);
    this.reactions.set(messageId, current.filter((item) => item.reactionId !== reactionId));
    if (this.activeTyping.get(messageId) === reactionId) this.activeTyping.delete(messageId);
    if (removed?.emojiType === "DONE") this.done.delete(messageId);
    if (removed?.emojiType === "CrossMark") this.failed.delete(messageId);
    if (removed?.emojiType === "Alarm") this.interrupted.delete(messageId);
    this.timeline.push(`remove:${messageId}`);
  }

  async listReactions(messageId: string): Promise<MessageReaction[]> {
    return [...(this.reactions.get(messageId) ?? [])];
  }

  async reply(messageId: string, text: string, uuid: string): Promise<ReplyReceipt> {
    this.replyAttempts.push({ sourceMessageId: messageId, text, uuid });
    const existing = this.receipts.get(uuid);
    if (existing) return existing;
    const receipt = { messageId: `reply-${this.receipts.size + 1}`, parentId: messageId, rootId: messageId };
    this.receipts.set(uuid, receipt);
    this.visibleReplies.push({ sourceMessageId: messageId, text, uuid, messageId: receipt.messageId });
    this.timeline.push(`reply:${messageId}`);
    if (this.failAfterAcceptOnce) {
      this.failAfterAcceptOnce = false;
      throw new Error("simulated acknowledgement loss");
    }
    return receipt;
  }

  async replyCard(messageId: string, cardJson: string, uuid: string): Promise<ReplyReceipt> {
    this.cardReplyAttempts.push({ sourceMessageId: messageId, cardJson, uuid });
    const existing = this.receipts.get(uuid);
    if (existing) return existing;
    const receipt = { messageId: `reply-${this.receipts.size + 1}`, parentId: messageId, rootId: messageId };
    this.receipts.set(uuid, receipt);
    this.visibleCards.push({ sourceMessageId: messageId, cardJson, uuid, messageId: receipt.messageId });
    this.timeline.push(`card:${messageId}`);
    if (this.failAfterAcceptOnce) {
      this.failAfterAcceptOnce = false;
      throw new Error("simulated acknowledgement loss");
    }
    return receipt;
  }

  async updateCard(messageId: string, cardJson: string): Promise<void> {
    this.cardUpdateAttempts.push({ messageId, cardJson });
    const card = this.visibleCards.find((item) => item.messageId === messageId);
    if (!card) throw new Error("card unavailable");
    card.cardJson = cardJson;
    this.timeline.push(`patch:${messageId}`);
  }

  async readCard(messageId: string): Promise<string> {
    const card = this.visibleCards.find((item) => item.messageId === messageId);
    if (!card) throw new Error("card unavailable");
    return card.cardJson;
  }

  async fetchReferencedMessage(messageId: string): Promise<ReferencedMessage> {
    const text = this.fetchedText.get(messageId);
    if (text !== undefined) return { type: "text", text };
    const imageKey = this.referencedImages.get(messageId);
    if (imageKey !== undefined) return { type: "image", imageKey };
    throw new Error("message unavailable");
  }

  async fetchImage(messageId: string, imageKey: string, maxBytes: number): Promise<DownloadedImage> {
    this.imageRequests.push({ messageId, imageKey, maxBytes });
    const image = this.fetchedImages.get(messageId);
    if (!image || image.data.length > maxBytes) throw new Error("image unavailable");
    return image;
  }
}

export class FakeRunner implements TurnRunner {
  readonly calls: Array<{ job: Job; topic: Topic }> = [];
  readonly gates: Deferred[] = [];
  readonly abortCalls: number[] = [];
  concurrent = 0;
  peakConcurrent = 0;
  block = false;
  failure: Error | null = null;
  result: TurnReply = { status: "succeeded", reply: "fixed final reply" };
  progressEvents: AgentProgressUpdate[] = [];
  private readonly activeGates = new Map<number, Deferred>();

  async run(
    job: Job,
    topic: Topic,
    reportProgress?: AgentProgressReporter,
    reportSession?: AgentSessionReporter,
  ): Promise<TurnReply> {
    this.calls.push({ job, topic });
    if (!topic.agentSessionId) reportSession?.(`thread-${topic.id}`);
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    try {
      for (const event of this.progressEvents) reportProgress?.(event);
      if (this.block) {
        const gate = deferred();
        this.gates.push(gate);
        this.activeGates.set(job.id, gate);
        await gate.promise;
      }
      if (this.failure) throw this.failure;
      return this.result;
    } finally {
      this.activeGates.delete(job.id);
      this.concurrent -= 1;
    }
  }

  abort(jobId: number): boolean {
    const gate = this.activeGates.get(jobId);
    if (!gate) return false;
    this.abortCalls.push(jobId);
    gate.resolve();
    return true;
  }

  abortAll(): void {
    for (const gate of this.gates) gate.resolve();
  }
}

export function primaryCardText(cardJson: string): string {
  const card = JSON.parse(cardJson) as { elements?: Array<{ tag?: string; content?: string }> };
  const element = card.elements?.find((item) => item.tag === "markdown");
  if (typeof element?.content !== "string") throw new Error("primary card text is unavailable");
  return element.content;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
