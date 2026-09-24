import { createHash } from "node:crypto";
import type { ExecutionStatus } from "../contracts.js";

const DELIVERY_NAMESPACE = "c79d978e-6917-56d2-9b15-c87cc30bc438";

function stableUuid(name: string): string {
  const namespace = Buffer.from(DELIVERY_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest().subarray(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stableFinalReplyUuid(jobId: number, outcome: ExecutionStatus, sequence = 0): string {
  const name = sequence === 0 ? `job:${jobId}:${outcome}` : `job:${jobId}:${outcome}:part:${sequence}`;
  return stableUuid(name);
}

export function stableStatusUuid(jobId: number, replacementCount = 0): string {
  return stableUuid(`job:${jobId}:status:${replacementCount}`);
}

export function stableIngressReplyUuid(messageId: string, replyKind: string): string {
  return stableUuid(`message:${messageId}:${replyKind}`);
}
