import { describe, expect, it } from "vitest";
import type { ExecutionStatus, Job } from "../src/contracts.js";
import { desiredReaction, INTERRUPTED_RESULT_TEXT, renderJobStatus } from "../src/jobs/status-view.js";

function job(executionStatus: ExecutionStatus, overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    feishuMessageId: "message",
    topicId: "topic",
    referencedMessageId: null,
    requesterOpenId: "user",
    inputText: null,
    resultText: null,
    progress: null,
    executionMode: "sandboxed",
    executionStatus,
    statusVersion: 1,
    errorKind: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("job status projection", () => {
  it("renders every execution state from persisted facts", () => {
    expect(renderJobStatus(job("preparing"))).toBe("正在接收任务内容…");
    expect(renderJobStatus(job("queued"), { queueWaitReason: "topic" })).toBe("排队中，等待本话题前序任务完成。");
    expect(renderJobStatus(job("queued"), { queueWaitReason: "capacity" })).toBe("排队中，等待可用执行名额。");
    expect(renderJobStatus(job("running", { startedAt: "2026-09-02T00:00:00.000Z" }), {
      now: Date.parse("2026-09-02T00:06:00.000Z"),
    })).toBe("执行中，已运行 6 分钟。");
    expect(renderJobStatus(job("cancel_requested"))).toBe("正在取消…");
    expect(renderJobStatus(job("succeeded"))).toBe("已完成。");
    expect(renderJobStatus(job("succeeded"), { finalReplyState: "abandoned" })).toBe("已完成，但结果发送失败。");
    expect(renderJobStatus(job("failed", { resultText: "真实且安全的失败" }))).toBe("执行失败，详情见最终回复。");
    expect(renderJobStatus(job("cancelled"))).toBe("已取消。已发生的外部操作不会自动回滚。");
    expect(renderJobStatus(job("interrupted"))).toBe(INTERRUPTED_RESULT_TEXT);
  });

  it("shows failure details in status only when the final reply is abandoned", () => {
    expect(
      renderJobStatus(job("failed", { resultText: "真实且安全的失败" }), { finalReplyState: "abandoned" }),
    ).toBe("执行失败，最终回复发送失败：真实且安全的失败");
  });

  it("maps active and terminal states to the desired reaction", () => {
    for (const status of ["preparing", "queued", "running", "cancel_requested"] as const) {
      expect(desiredReaction(job(status))).toBe("Typing");
    }
    expect(desiredReaction(job("succeeded"))).toBe("DONE");
    expect(desiredReaction(job("failed"))).toBe("CrossMark");
    expect(desiredReaction(job("cancelled"))).toBe("CrossMark");
    expect(desiredReaction(job("interrupted"))).toBe("Alarm");
  });
});
