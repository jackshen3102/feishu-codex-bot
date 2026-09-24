import { describe, expect, it } from "vitest";
import type { Job } from "../src/contracts.js";
import { renderJobStatusCard } from "../src/jobs/status-card.js";

const runningJob: Job = {
  id: 1,
  feishuMessageId: "source-message",
  topicId: "topic",
  referencedMessageId: null,
  requesterOpenId: "user",
  inputText: null,
  resultText: null,
  progress: {
    active: [{
      id: "command",
      kind: "message",
      state: "running",
      title: "正在运行测试\n\n当前 2/4",
    }],
    recent: [{ id: "read", kind: "message", state: "completed", title: "**已读取项目配置**" }],
    completedCount: 1,
    failedCount: 0,
  },
  executionMode: "unrestricted",
  executionStatus: "running",
  statusVersion: 3,
  errorKind: null,
  createdAt: "2026-09-03T00:00:00.000Z",
  startedAt: "2026-09-03T00:00:00.000Z",
  finishedAt: null,
};

describe("job status card", () => {
  it("renders a bounded live viewport instead of the full job transcript", () => {
    const cardJson = renderJobStatusCard(runningJob, { now: Date.parse("2026-09-03T00:02:00.000Z") });
    const card = JSON.parse(cardJson) as any;
    expect(card.header.title.content).toBe("执行中");
    expect(card.header.template).toBe("blue");
    expect(cardJson).toContain("执行中，已运行 2 分钟。");
    expect(cardJson).toContain("正在运行测试");
    expect(cardJson).toContain("当前 2/4");
    expect(cardJson).toContain("读取项目配置");
    expect(cardJson).toContain("**已读取项目配置**");
    expect(cardJson).not.toContain("unrestricted");
    expect(cardJson).not.toContain("✓");
    expect(cardJson).not.toContain("→");
    expect(cardJson).not.toContain("✗");
  });

  it("collapses terminal state to a stable summary without execution history", () => {
    const cardJson = renderJobStatusCard({
      ...runningJob,
      executionStatus: "succeeded",
      finishedAt: "2026-09-03T01:00:00.000Z",
    });
    const card = JSON.parse(cardJson) as any;
    expect(card.header).toMatchObject({
      title: { tag: "plain_text", content: "已完成" },
      template: "green",
    });
    expect(cardJson).toContain("已完成。");
    expect(cardJson).not.toContain("正在运行测试");
    expect(cardJson).not.toContain("读取项目配置");
    expect(card.elements).toHaveLength(1);
  });
});
