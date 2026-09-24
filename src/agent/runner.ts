import type { AgentProgressUpdate, Job, Topic, TurnReply } from "../contracts.js";

export type AgentProgressReporter = (update: AgentProgressUpdate) => void;
export type AgentSessionReporter = (sessionId: string) => void;

export interface TurnRunner {
  run(
    job: Job,
    topic: Topic,
    reportProgress?: AgentProgressReporter,
    reportSession?: AgentSessionReporter,
  ): Promise<TurnReply>;
  abort(jobId: number): boolean;
  abortAll(): void;
}

export class TurnTimeoutError extends Error {
  constructor() {
    super("Agent turn timed out");
    this.name = "TurnTimeoutError";
  }
}

export class AgentAuthenticationError extends Error {
  constructor() {
    super("Agent authentication failed");
    this.name = "AgentAuthenticationError";
  }
}
