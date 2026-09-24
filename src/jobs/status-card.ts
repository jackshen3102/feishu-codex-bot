import type { AgentProgressItem, Job } from "../contracts.js";
import { renderJobStatus, type StatusViewContext } from "./status-view.js";

function cardHeader(status: Job["executionStatus"]): { title: string; template: string } {
  switch (status) {
    case "preparing": return { title: "正在接收任务", template: "yellow" };
    case "queued": return { title: "排队中", template: "yellow" };
    case "running": return { title: "执行中", template: "blue" };
    case "cancel_requested": return { title: "正在取消", template: "orange" };
    case "succeeded": return { title: "已完成", template: "green" };
    case "failed": return { title: "执行失败", template: "red" };
    case "cancelled": return { title: "已取消", template: "grey" };
    case "interrupted": return { title: "任务已中断", template: "orange" };
  }
}

function codeBlock(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "` ` `")}\n\`\`\``;
}

function itemLine(item: AgentProgressItem): string {
  return item.title;
}

function progressElements(job: Job): Array<Record<string, unknown>> {
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.executionStatus)) return [];
  const progress = job.progress;
  if (!progress || (progress.active.length === 0 && progress.recent.length === 0)) return [];
  const elements: Array<Record<string, unknown>> = [{ tag: "hr" }];
  const current = progress.active[0];
  if (current) {
    let content = `**当前步骤**\n${itemLine(current)}`;
    if (current.detail) content += `\n${codeBlock(current.detail)}`;
    elements.push({ tag: "markdown", content });
  }
  if (progress.recent.length > 0) {
    elements.push({
      tag: "markdown",
      content: `**最近进展**\n${progress.recent.map(itemLine).join("\n\n")}`,
    });
  }
  return elements;
}

export function renderJobStatusCard(job: Job, context: StatusViewContext = {}): string {
  const header = cardHeader(job.executionStatus);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: header.title },
      template: header.template,
    },
    elements: [
      { tag: "markdown", content: renderJobStatus(job, context) },
      ...progressElements(job),
    ],
  });
}
