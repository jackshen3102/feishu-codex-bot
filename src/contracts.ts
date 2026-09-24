export type ExecutionStatus =
  | "preparing"
  | "queued"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ExecutionMode = "sandboxed" | "unrestricted";

export type AgentProgressKind = "message";
export type AgentProgressState = "running" | "completed" | "failed";

export interface AgentProgressItem {
  id: string;
  kind: AgentProgressKind;
  state: AgentProgressState;
  title: string;
  detail?: string;
}

export interface AgentProgressSnapshot {
  active: AgentProgressItem[];
  recent: AgentProgressItem[];
  completedCount: number;
  failedCount: number;
}

export type AgentProgressUpdate = AgentProgressItem;

export type DeliveryKind = "status" | "final_reply" | "reaction";
export type DeliveryState = "pending" | "delivering" | "delivered" | "abandoned";

export interface Topic {
  id: string;
  agentSessionId: string | null;
  workspacePath: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface Job {
  id: number;
  feishuMessageId: string;
  topicId: string;
  referencedMessageId: string | null;
  requesterOpenId: string | null;
  inputText: string | null;
  resultText: string | null;
  progress: AgentProgressSnapshot | null;
  executionMode: ExecutionMode;
  executionStatus: ExecutionStatus;
  statusVersion: number;
  errorKind: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobDelivery {
  id: number;
  jobId: number;
  kind: DeliveryKind;
  sequence: number;
  payloadText: string | null;
  state: DeliveryState;
  desiredVersion: number;
  deliveredVersion: number;
  attempts: number;
  nextAttemptAt: string;
  stableUuid: string | null;
  messageId: string | null;
  replacementCount: number;
  lastErrorKind: string | null;
  leaseStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnReply {
  status: "succeeded" | "failed";
  reply: string;
}

export interface TrustedFeishuInput {
  source: "feishu";
  chat_id: string;
  message_id: string;
  sender_open_id: string;
  referenced_message_id?: string;
  referenced_text?: string;
  images?: Array<{
    path: string;
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    source_message_id: string;
  }>;
  text: string;
}

export interface FeishuMessageEvent {
  sender: {
    sender_id?: { open_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string };
      name: string;
    }>;
  };
}

export interface ReplyReceipt {
  messageId: string;
  parentId?: string;
  rootId?: string;
}
