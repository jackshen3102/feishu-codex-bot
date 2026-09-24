import { describe, expect, it } from "vitest";
import {
  MAX_PROGRESS_SNAPSHOT_BYTES,
  ProgressWindow,
  progressUpdateFromThreadEvent,
} from "../src/agent/progress.js";

describe("bounded agent progress window", () => {
  it("replaces repeated native message updates instead of appending an unbounded transcript", () => {
    const window = new ProgressWindow();
    for (let index = 0; index < 10_000; index += 1) {
      window.apply({
        id: "message-1",
        kind: "message",
        state: "running",
        title: `latest-${index}\n${"old output\n".repeat(2_000)}`,
      });
    }

    const snapshot = window.snapshot();
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0]).toMatchObject({ id: "message-1", kind: "message", state: "running" });
    expect(snapshot.active[0]!.title).toContain("latest-9999");
    expect(snapshot.active[0]!.title).not.toContain("latest-0\n");
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(MAX_PROGRESS_SNAPSHOT_BYTES);
  });

  it("keeps only a small recent window while retaining aggregate completion counts", () => {
    const window = new ProgressWindow();
    for (let index = 0; index < 1_000; index += 1) {
      window.apply({
        id: `tool-${index}`,
        kind: "message",
        state: index === 999 ? "failed" : "completed",
        title: `工具 ${index}`,
        detail: `\u001b[31m${"x".repeat(5_000)}\u001b[0m`,
      });
    }

    const snapshot = window.snapshot();
    expect(snapshot.active).toEqual([]);
    expect(snapshot.recent).toHaveLength(6);
    expect(snapshot.recent[0]).toMatchObject({ id: "tool-999", state: "failed" });
    expect(snapshot.completedCount).toBe(1_000);
    expect(snapshot.failedCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("\u001b");
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(MAX_PROGRESS_SNAPSHOT_BYTES);
  });

  it("keeps native user-facing messages and drops execution telemetry and final JSON", () => {
    expect(progressUpdateFromThreadEvent({
      type: "item.updated",
      item: { id: "reason", type: "reasoning", text: "检查依赖关系" },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.started",
      item: { id: "mcp", type: "mcp_tool_call", server: "docs", tool: "create", status: "in_progress" },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "files", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "command", type: "command_execution", command: "pnpm test", aggregated_output: "passed" },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "search", type: "web_search", query: "Feishu card patch" },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "message", type: "agent_message", text: "我已经完成资料收集，正在整理结论。" },
    })).toEqual({
      id: "message",
      kind: "message",
      state: "completed",
      title: "我已经完成资料收集，正在整理结论。",
    });
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "agent", type: "agent_message", text: '{"status":"succeeded","reply":"final reply"}' },
    })).toBeNull();
    expect(progressUpdateFromThreadEvent({
      type: "item.completed",
      item: { id: "error", type: "error", message: "Authorization: secret" },
    })).toBeNull();
  });
});
