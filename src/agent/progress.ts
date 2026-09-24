import type {
  AgentProgressItem,
  AgentProgressSnapshot,
  AgentProgressState,
  AgentProgressUpdate,
} from "../contracts.js";
import { parseTurnReply } from "./output.js";

const ACTIVE_ITEM_LIMIT = 3;
const RECENT_ITEM_LIMIT = 6;
const TITLE_BYTE_LIMIT = 1_000;
const DETAIL_BYTE_LIMIT = 1_000;
export const MAX_PROGRESS_SNAPSHOT_BYTES = 20 * 1024;

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      output += value[index];
      continue;
    }
    index += 2;
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) break;
      index += 1;
    }
  }
  return output;
}

function stripControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f)) output += character;
  }
  return output;
}

function tailUtf8(value: string, maxBytes: number): string {
  const input = Buffer.from(value, "utf8");
  if (input.length <= maxBytes) return value;
  let start = input.length - maxBytes;
  while (start < input.length && (input[start]! & 0xc0) === 0x80) start += 1;
  return `…${input.subarray(start).toString("utf8")}`;
}

function headUtf8(value: string, maxBytes: number): string {
  const input = Buffer.from(value, "utf8");
  if (input.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (input[end]! & 0xc0) === 0x80) end -= 1;
  return `${input.subarray(0, end).toString("utf8")}…`;
}

function cleanText(value: string): string {
  const withoutAnsi = stripAnsi(value).replace(/\r\n?/g, "\n");
  return stripControlCharacters(withoutAnsi).trim();
}

function normalizeUpdate(update: AgentProgressUpdate): AgentProgressUpdate | null {
  const titleInput = headUtf8(update.title, TITLE_BYTE_LIMIT * 4);
  const title = headUtf8(cleanText(titleInput), TITLE_BYTE_LIMIT);
  if (!title) return null;
  const detailInput = update.detail ? tailUtf8(update.detail, DETAIL_BYTE_LIMIT * 4) : "";
  const detail = detailInput ? tailUtf8(cleanText(detailInput), DETAIL_BYTE_LIMIT) : "";
  return {
    id: headUtf8(update.id, TITLE_BYTE_LIMIT),
    kind: update.kind,
    state: update.state,
    title,
    ...(detail ? { detail } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function itemState(eventType: string, item: Record<string, unknown>): AgentProgressState {
  if (eventType === "item.completed") {
    return item.status === "failed" || item.type === "error" ? "failed" : "completed";
  }
  if (item.status === "failed") return "failed";
  if (item.status === "completed") return "completed";
  return "running";
}

function isFinalReply(value: string): boolean {
  try {
    parseTurnReply(value);
    return true;
  } catch {
    return false;
  }
}

/** Keep only native user-facing agent messages; low-level execution telemetry is not progress UI. */
export function progressUpdateFromThreadEvent(event: unknown): AgentProgressUpdate | null {
  const source = object(event);
  if (!source || !["item.started", "item.updated", "item.completed"].includes(text(source.type))) return null;
  const item = object(source.item);
  if (!item) return null;
  const id = text(item.id);
  const type = text(item.type);
  if (!id || !type) return null;
  if (type !== "agent_message") return null;
  const message = text(item.text);
  if (!message || isFinalReply(message)) return null;
  return normalizeUpdate({ id, kind: "message", state: itemState(text(source.type), item), title: message });
}

/** Fixed-capacity live viewport. Completed history is summarized, never accumulated. */
export class ProgressWindow {
  private readonly active = new Map<string, AgentProgressItem>();
  private readonly recent: AgentProgressItem[] = [];
  private completedCount = 0;
  private failedCount = 0;

  apply(rawUpdate: AgentProgressUpdate): boolean {
    const update = normalizeUpdate(rawUpdate);
    if (!update) return false;
    if (update.state === "running") {
      const current = this.active.get(update.id);
      if (current && JSON.stringify(current) === JSON.stringify(update)) return false;
      this.active.delete(update.id);
      this.active.set(update.id, update);
      while (this.active.size > ACTIVE_ITEM_LIMIT) this.active.delete(this.active.keys().next().value!);
      return true;
    }

    const active = this.active.get(update.id);
    const recentIndex = this.recent.findIndex((item) => item.id === update.id);
    if (!active && recentIndex >= 0 && JSON.stringify(this.recent[recentIndex]) === JSON.stringify(update)) return false;
    this.active.delete(update.id);
    if (recentIndex >= 0) this.recent.splice(recentIndex, 1);
    else {
      this.completedCount += 1;
      if (update.state === "failed") this.failedCount += 1;
    }
    this.recent.unshift(update);
    this.recent.length = Math.min(this.recent.length, RECENT_ITEM_LIMIT);
    return true;
  }

  snapshot(): AgentProgressSnapshot {
    const snapshot = {
      active: [...this.active.values()].reverse(),
      recent: [...this.recent],
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_PROGRESS_SNAPSHOT_BYTES) {
      throw new Error("Agent progress snapshot exceeded its fixed capacity");
    }
    return snapshot;
  }
}
