import type { Job, JobDelivery } from "../contracts.js";
import type { Store } from "../db/store.js";
import type { DesiredReaction } from "../jobs/status-view.js";
import { renderJobStatusCard } from "../jobs/status-card.js";
import { splitFinalReply } from "../jobs/final-reply.js";
import { desiredReaction } from "../jobs/status-view.js";
import { errorKind, logger } from "../logging.js";
import {
  PermanentStatusMessageError,
  cardStatusProjection,
  type FeishuDelivery,
  type MessageReaction,
} from "../feishu/messages.js";

const FINAL_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const CALL_TIMEOUT_MS = 10_000;
const IDLE_POLL_MS = 1_000;
const STATUS_RETRY_CAP_MS = 15 * 60_000;

export interface OutboxWorkerOptions {
  callTimeoutMs?: number;
  idlePollMs?: number;
  finalRetryDelaysMs?: readonly number[];
  reactionRetryDelaysMs?: readonly number[];
  statusRetryBaseMs?: number;
  statusRetryCapMs?: number;
  now?: () => number;
}

export class OutboxWorker {
  private running = false;
  private pumping = false;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly delivery: FeishuDelivery,
    private readonly options: OutboxWorkerOptions = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.store.recoverDeliveryLeases();
    this.running = true;
    this.wake();
  }

  wake(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      void this.pump().catch((error) => {
        logger.error("outbox_pump_failed", { errorKind: errorKind(error) });
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pumping) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async waitForIdle(): Promise<void> {
    if (!this.pumping) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    try {
      while (this.running) {
        const delivery = this.store.claimDueDelivery(this.isoNow());
        if (!delivery) break;
        await this.process(delivery);
      }
    } finally {
      this.pumping = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      if (this.running) this.scheduleNextPump();
    }
  }

  private async process(claimed: JobDelivery): Promise<void> {
    const delivery = this.store.getDeliveryById(claimed.id);
    const job = delivery ? this.store.getJob(delivery.jobId) : null;
    if (!delivery || delivery.state !== "delivering" || !job) return;
    const sentVersion = delivery.desiredVersion;
    try {
      switch (delivery.kind) {
        case "status":
          await this.deliverStatus(job, delivery);
          break;
        case "final_reply":
          await this.deliverFinalReply(job, delivery);
          break;
        case "reaction":
          await this.reconcileReaction(job);
          break;
      }
      this.store.completeDelivery(delivery.id, sentVersion);
      logger.info("job_delivery_completed", {
        jobId: job.id,
        status: delivery.kind,
        sequence: delivery.sequence,
        version: sentVersion,
      });
    } catch (error) {
      if (delivery.kind === "status" && error instanceof PermanentStatusMessageError) {
        const result = this.store.handlePermanentStatusFailure(delivery.id, errorKind(error));
        logger.warn("job_status_delivery_permanent_failure", {
          jobId: job.id,
          attempt: delivery.attempts + 1,
          terminal: result.abandoned,
          errorKind: errorKind(error),
        });
        return;
      }
      const nextAttemptAt = this.nextAttemptAt(delivery);
      const maximumAttempts = delivery.kind === "status" ? undefined : this.retryDelays(delivery).length + 1;
      const result = this.store.failDelivery(delivery.id, errorKind(error), nextAttemptAt, maximumAttempts);
      logger.warn("job_delivery_failed", {
        jobId: job.id,
        attempt: result.attempts,
        terminal: result.abandoned,
        status: delivery.kind,
        sequence: delivery.sequence,
        version: sentVersion,
        errorKind: errorKind(error),
      });
    }
  }

  private async deliverStatus(job: Job, delivery: JobDelivery): Promise<void> {
    const finalReplyState = this.store.getFinalReplyState(job.id) ?? undefined;
    const firstReply = this.store.getDelivery(job.id, "final_reply");
    let finalReply: string | undefined;
    if (firstReply?.state === "delivered") {
      // A late status retry must never erase a result already delivered in this card.
      if (!delivery.messageId) return;
      if (firstReply.messageId === delivery.messageId) {
        if (finalReplyState !== "abandoned" || !job.resultText) return;
        finalReply = splitFinalReply(job.resultText)[0];
      }
    }
    const cardJson = renderJobStatusCard(job, {
      queueWaitReason: this.store.getQueueWaitReason(job.id) ?? undefined,
      finalReplyState,
      now: this.now(),
    }, finalReply);
    let messageId = delivery.messageId;
    if (!messageId) {
      if (!delivery.stableUuid) throw new Error("status delivery UUID is unavailable");
      const receipt = await this.withTimeout(
        this.delivery.replyCard(job.feishuMessageId, cardJson, delivery.stableUuid),
      );
      const chatId = this.store.getBindingChatId(job.feishuMessageId);
      if (!chatId) throw new Error("source message binding is unavailable");
      if (!this.store.recordDeliveryMessage(delivery.id, chatId, receipt)) {
        throw new Error("status delivery lease changed while creating message");
      }
      messageId = receipt.messageId;
    } else {
      await this.withTimeout(this.delivery.updateCard(messageId, cardJson));
    }
    this.assertRunning();
    const readBack = await this.withTimeout(this.delivery.readCard(messageId));
    if (JSON.stringify(cardStatusProjection(readBack)) !== JSON.stringify(cardStatusProjection(cardJson))) {
      throw new Error("status card read-back did not match the latest projection");
    }
  }

  private async deliverFinalReply(job: Job, delivery: JobDelivery): Promise<void> {
    if (!delivery.payloadText || !delivery.stableUuid) throw new Error("final reply payload is unavailable");
    const status = this.store.getDelivery(job.id, "status");
    const cardJson = renderJobStatusCard(job, {}, delivery.payloadText);
    // Keep overflow chunks as ordered replies. Check the serialized request, since
    // JSON escaping can make an otherwise small text exceed the card size limit.
    if (delivery.sequence === 0 && status?.messageId && status.state !== "abandoned" &&
        (!delivery.messageId || delivery.messageId === status.messageId) &&
        Buffer.byteLength(JSON.stringify({ content: cardJson }), "utf8") <= 30 * 1024) {
      try {
        await this.withTimeout(this.delivery.updateCard(status.messageId, cardJson));
        this.assertRunning();
        // The successful update response acknowledges delivery. Feishu's GET
        // returns a lossy rendered-text view, not the original Markdown; comparing
        // them would reject valid replies and later overwrite them with an error.
        const chatId = this.store.getBindingChatId(job.feishuMessageId);
        if (!chatId) throw new Error("source message binding is unavailable");
        if (!this.store.recordDeliveryMessage(delivery.id, chatId, { messageId: status.messageId })) {
          throw new Error("final reply lease changed while recording card receipt");
        }
        return;
      } catch (error) {
        // Only a definitively uneditable card permits a separate text reply.
        // Transient failures retry the same card through the durable outbox.
        if (!(error instanceof PermanentStatusMessageError)) throw error;
      }
    }
    const receipt = await this.withTimeout(
      this.delivery.reply(job.feishuMessageId, delivery.payloadText, delivery.stableUuid),
    );
    const chatId = this.store.getBindingChatId(job.feishuMessageId);
    if (!chatId) throw new Error("source message binding is unavailable");
    if (!this.store.recordDeliveryMessage(delivery.id, chatId, receipt)) {
      throw new Error("final reply lease changed while recording receipt");
    }
  }

  private async reconcileReaction(job: Job): Promise<void> {
    const expected = desiredReaction(job);
    const existing = await this.withTimeout(this.delivery.listReactions(job.feishuMessageId));
    this.assertRunning();
    let retained = false;
    for (const reaction of existing) {
      if (reaction.emojiType === expected && !retained) {
        retained = true;
        continue;
      }
      await this.withTimeout(this.delivery.removeReaction(job.feishuMessageId, reaction.reactionId));
      this.assertRunning();
    }
    if (!retained) await this.withTimeout(this.delivery.addReaction(job.feishuMessageId, expected));
  }

  private retryDelays(delivery: JobDelivery): readonly number[] {
    if (delivery.kind === "reaction") {
      return this.options.reactionRetryDelaysMs ?? this.options.finalRetryDelaysMs ?? FINAL_RETRY_DELAYS_MS;
    }
    return this.options.finalRetryDelaysMs ?? FINAL_RETRY_DELAYS_MS;
  }

  private nextAttemptAt(delivery: JobDelivery): string {
    let delay: number;
    if (delivery.kind === "status") {
      const base = this.options.statusRetryBaseMs ?? 1_000;
      const cap = this.options.statusRetryCapMs ?? STATUS_RETRY_CAP_MS;
      delay = Math.min(cap, base * 2 ** Math.min(delivery.attempts, 20));
    } else {
      const delays = this.retryDelays(delivery);
      delay = delays[Math.min(delivery.attempts, Math.max(0, delays.length - 1))] ?? 0;
    }
    return new Date(this.now() + delay).toISOString();
  }

  private scheduleNextPump(): void {
    const next = this.store.nextPendingDeliveryAt();
    if (!next) return;
    const minimum = this.options.idlePollMs ?? IDLE_POLL_MS;
    const delay = Math.max(minimum, Math.min(2_147_483_647, Date.parse(next) - this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, delay);
    this.timer.unref();
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Feishu delivery timed out")), this.options.callTimeoutMs ?? CALL_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private assertRunning(): void {
    if (!this.running) throw new Error("Outbox worker is stopping");
  }
}

export type { DesiredReaction, MessageReaction };
