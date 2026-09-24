import type { ExecutionStatus } from "../contracts.js";

const transitions: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  preparing: ["queued", "failed", "cancelled", "interrupted"],
  queued: ["running", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "interrupted"],
  cancel_requested: ["cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export const executionStatuses = Object.freeze(Object.keys(transitions) as ExecutionStatus[]);

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return transitions[status].length === 0;
}

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionExecution(from: ExecutionStatus, to: ExecutionStatus): ExecutionStatus | null {
  return canTransition(from, to) ? to : null;
}
