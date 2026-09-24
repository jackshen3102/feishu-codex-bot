import type { TurnRunner } from "../agent/runner.js";
import type { Store } from "../db/store.js";
import type { FeishuDelivery } from "../feishu/messages.js";
import { stableIngressReplyUuid } from "../jobs/delivery-ids.js";
import { bestEffort } from "../feishu/reactions.js";

export interface CancellationCommand {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  referencedMessageId?: string;
  text: string;
}

export class CancellationController {
  constructor(
    private readonly store: Store,
    private readonly runner: TurnRunner,
    private readonly delivery: FeishuDelivery,
    private readonly notifyStateChange: () => void = () => undefined,
  ) {}

  async handle(command: CancellationCommand): Promise<boolean> {
    if (command.text.trim() !== "取消") return false;
    if (!command.referencedMessageId) {
      await this.reply(command.messageId, "请回复要取消的任务消息，并发送“取消”。", "cancel-no-reference");
      return true;
    }
    const job = this.store.findBoundJob(command.chatId, command.referencedMessageId);
    if (!job) {
      await this.reply(
        command.messageId,
        "无法定位要取消的任务，请回复原始任务、状态消息或最终回复后重试。",
        "cancel-not-found",
      );
      return true;
    }

    const decision = this.store.requestCancellation(job.id, command.requesterOpenId);
    switch (decision.kind) {
      case "not_found":
        await this.reply(command.messageId, "无法定位要取消的任务。", "cancel-not-found");
        break;
      case "not_requester":
        await this.reply(command.messageId, "你只能取消自己发起的任务。", "cancel-forbidden");
        break;
      case "already_terminal":
        await this.reply(command.messageId, "任务已经结束，无法取消。", "cancel-terminal");
        break;
      case "already_requested":
        await this.reply(command.messageId, "任务正在取消，请稍候。", "cancel-pending");
        break;
      case "cancelled_before_run":
        this.notifyStateChange();
        await this.reply(command.messageId, "任务已取消。", "cancelled");
        break;
      case "abort_required":
        this.runner.abort(job.id);
        this.notifyStateChange();
        await this.reply(command.messageId, "正在取消任务。", "cancel-requested");
        break;
    }
    return true;
  }

  private async reply(messageId: string, text: string, kind: string): Promise<void> {
    await bestEffort(() => this.delivery.reply(messageId, text, stableIngressReplyUuid(messageId, kind)));
  }
}
