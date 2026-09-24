import type { DeliveryState, Job } from "../contracts.js";

export type DesiredReaction = "Typing" | "DONE" | "CrossMark" | "Alarm";

export interface StatusViewContext {
  queueWaitReason?: "topic" | "capacity";
  finalReplyState?: DeliveryState;
  now?: number;
}

const FALLBACK_FAILURE = "任务失败，请回复重试。";
export const CANCELLED_RESULT_TEXT = "已取消。已发生的外部操作不会自动回滚。";
export const INTERRUPTED_RESULT_TEXT = "任务已中断，可能已执行部分外部操作。请先检查外部状态，再决定是否发起新任务。";

export function renderJobStatus(job: Job, context: StatusViewContext = {}): string {
  switch (job.executionStatus) {
    case "preparing":
      return "正在接收任务内容…";
    case "queued":
      return context.queueWaitReason === "topic"
        ? "排队中，等待本话题前序任务完成。"
        : "排队中，等待可用执行名额。";
    case "running": {
      const startedAt = job.startedAt ? Date.parse(job.startedAt) : context.now ?? Date.now();
      const elapsed = Math.max(0, (context.now ?? Date.now()) - startedAt);
      return `执行中，已运行 ${Math.floor(elapsed / 60_000)} 分钟。`;
    }
    case "cancel_requested":
      return "正在取消…";
    case "succeeded":
      return context.finalReplyState === "abandoned" ? "已完成，但结果发送失败。" : "已完成。";
    case "failed":
      return context.finalReplyState === "abandoned"
        ? `执行失败，最终回复发送失败：${job.resultText ?? FALLBACK_FAILURE}`
        : "执行失败，详情见最终回复。";
    case "cancelled":
      return CANCELLED_RESULT_TEXT;
    case "interrupted":
      return INTERRUPTED_RESULT_TEXT;
  }
}

export function desiredReaction(job: Job): DesiredReaction {
  switch (job.executionStatus) {
    case "preparing":
    case "queued":
    case "running":
    case "cancel_requested":
      return "Typing";
    case "succeeded":
      return "DONE";
    case "failed":
    case "cancelled":
      return "CrossMark";
    case "interrupted":
      return "Alarm";
  }
}
