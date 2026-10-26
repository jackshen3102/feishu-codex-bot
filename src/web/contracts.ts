import type { DeliveryState, ExecutionStatus, AgentProgressSnapshot } from "../contracts.js";

export class WebError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface FinalReply {
  state: DeliveryState | null;
  totalCount: number;
  deliveredCount: number;
  abandonedCount: number;
}
export interface JobSummary {
  id: number;
  executionStatus: ExecutionStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorKind: string | null;
  finalReply: FinalReply;
}
export interface TopicSummary {
  id: string;
  title: string;
  workspaceId: string;
  chatType: "group" | "private";
  chatId: string;
  ownerId: string;
  paused: boolean;
  pauseReason: string | null;
  queuedCount: number;
  currentJob: JobSummary | null;
  multipleActiveJobs: boolean;
  needsAttention: boolean;
  updatedAt: string;
}
export interface WebCase {
  topicId: string;
  sourceJobId: number;
  summary: string;
  conclusions: Array<{ text: string; verification?: string }>;
  evidence: string[];
  updatedAt: string;
  dataWarnings: string[];
}
export interface JobDetail {
  job: JobSummary;
  input: { text: string; attachments: Array<{ name: string; type: string }> } | null;
  resultText: string | null;
  progress: AgentProgressSnapshot | null;
  caseSummary: WebCase | null;
  dataWarnings: string[];
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ListQuery {
  workspaceId: string;
  q: string;
  filter: string;
  limit: number;
  cursor?: string;
}
